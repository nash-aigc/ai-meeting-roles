"""Claude 角色代理运行器：每角色一个长驻 stream-json 子进程。

- 增量注入：会议转写每 push_interval 秒 flush 进 stdin（连续对话，同一 session）
- 行为解析：输出按行匹配 OBSERVE:/INTERRUPT:/SUMMARY: 前缀（V1 文本标记协议，MCP 工具留作升级路径）
- 会话恢复：--session-id 固定，进程崩溃可 --resume 重建
- 模型经 NewAPI 网关（ANTHROPIC_BASE_URL），模型 deepseek-v4-flash
- 动态角色：支持创建/删除自定义角色，每个角色目录结构一致
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from typing import Dict, Optional, List

log = logging.getLogger("agents")

# CLI 路径：环境变量优先 → PATH 搜索 → 容器内默认位置。
# （原先硬编码 "/Users/mjm/.local/bin/claude"：换机/容器必挂，本机该路径也早已不存在）
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or "/usr/local/bin/claude"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # Meeting/
ROLES_DIR = os.path.join(BASE_DIR, "roles")

# 隔离配置目录：避免加载用户全部 hooks/MCP（启动慢+噪音），但必须写入鉴权 env
# 可用 CLAUDE_ISOLATED_HOME 覆盖（容器内指向挂载卷，使 onboarding 态跨重启保留）
CLAUDE_ISOLATED_HOME = os.environ.get("CLAUDE_ISOLATED_HOME", "/tmp/meeting-claude-home")

def _ensure_isolated_claude_home() -> None:
    """写最小 settings.json 到隔离目录：仅保留鉴权 env（AUTH_TOKEN/BASE_URL/模型映射），
    剥掉 ANTHROPIC_MODEL 覆盖（实测『无限】mimo-v2.5-pro』等会 unrecognized_model）。
    不写这个文件 = CLI 无凭据 = 'Not logged in · Please run /login'（今日 E16）。"""
    os.makedirs(CLAUDE_ISOLATED_HOME, exist_ok=True)
    settings_path = os.path.join(CLAUDE_ISOLATED_HOME, "settings.json")
    try:
        with open(os.path.expanduser("~/.claude/settings.json"), "r", encoding="utf-8") as f:
            user_env = (json.load(f).get("env") or {})
    except Exception:  # noqa: BLE001
        user_env = {}
    env = {k: v for k, v in user_env.items()
           if k not in ("ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")}
    # 显式设置模型为 NewAPI 支持的小写名称，避免大写/ANSI污染导致 unrecognized_model
    env["ANTHROPIC_MODEL"] = "deepseek-v4-flash"
    env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "deepseek-v4-flash"
    env["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"] = "deepseek-v4-flash"
    env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = "deepseek-v4-flash"
    env["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"] = "deepseek-v4-flash"
    payload = {"env": env, "includeCoAuthoredBy": False}
    try:
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:  # noqa: BLE001
        log.warning("write isolated settings failed: %s", e)

DEFAULT_THINK_INTERVAL = 10
DEFAULT_TTS_ENABLED = False

# 预定义角色定义（静态 + 动态目录读取合并）
STATIC_ROLE_DEFS = {
    "customer": {
        "name": "客户",
        "workdir": os.path.join(ROLES_DIR, "customer"),
        "default_think_interval_sec": DEFAULT_THINK_INTERVAL,
        "default_tts_enabled": DEFAULT_TTS_ENABLED,
    },
    "boss": {
        "name": "老板",
        "workdir": os.path.join(ROLES_DIR, "boss"),
        "default_think_interval_sec": DEFAULT_THINK_INTERVAL,
        "default_tts_enabled": DEFAULT_TTS_ENABLED,
    },
}

# 动态从 roles/ 目录读取所有角色
def scan_all_roles() -> Dict[str, Dict]:
    """扫描 roles/ 目录下所有子目录，合并静态定义。"""
    result = dict(STATIC_ROLE_DEFS)
    if not os.path.exists(ROLES_DIR):
        return result
    for entry in os.scandir(ROLES_DIR):
        if entry.is_dir():
            role_id = entry.name
            if role_id in result:
                continue  # 静态定义优先
            # 动态角色：CLAUDE.md 必须存在
            if os.path.exists(os.path.join(entry.path, "CLAUDE.md")):
                result[role_id] = {
                    "name": role_id.replace("_", " ").title(),
                    "workdir": entry.path,
                    "default_think_interval_sec": DEFAULT_THINK_INTERVAL,
                    "default_tts_enabled": DEFAULT_TTS_ENABLED,
                }
    return result

ROLE_DEFS = scan_all_roles()

def prompt_preview(role_id: str, max_chars: int = 1200) -> str:
    """读取角色提示词预览（供前端展示），失败则返回空串。"""
    try:
        wd = ROLE_DEFS[role_id]["workdir"]
        p = os.path.join(wd, "CLAUDE.md")
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
        raw = raw.strip()
        if len(raw) <= max_chars:
            return raw
        return raw[:max_chars].rstrip() + "\n…（已截断）"
    except Exception:
        return ""

def read_full_prompt(role_id: str) -> str:
    """读取角色完整提示词（供前端编辑）。"""
    try:
        wd = ROLE_DEFS[role_id]["workdir"]
        p = os.path.join(wd, "CLAUDE.md")
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""

def create_role_directory(role_id: str, name: str, prompt: str) -> bool:
    """创建一个新角色目录结构：roles/<role_id>/CLAUDE.md + .claude/settings.json。"""
    try:
        wd = os.path.join(ROLES_DIR, role_id)
        if os.path.exists(wd):
            return False
        os.makedirs(wd, exist_ok=True)
        # 创建 CLAUDE.md
        with open(os.path.join(wd, "CLAUDE.md"), "w", encoding="utf-8") as f:
            f.write(prompt.strip() + "\n")
        # 创建 .claude/settings.json（继承模板）
        claude_dir = os.path.join(wd, ".claude")
        os.makedirs(claude_dir, exist_ok=True)
        # 拷贝默认设置从第一个角色（boss）
        template_path = os.path.join(STATIC_ROLE_DEFS["boss"]["workdir"], ".claude", "settings.json")
        if os.path.exists(template_path):
            shutil.copy(template_path, os.path.join(claude_dir, "settings.json"))
        else:
            with open(os.path.join(claude_dir, "settings.json"), "w", encoding="utf-8") as f:
                f.write('{}\n')
        # 重新扫描
        global ROLE_DEFS
        ROLE_DEFS = scan_all_roles()
        return True
    except Exception as e:
        log.warning("create_role failed: %s", e)
        return False

def delete_role_directory(role_id: str) -> bool:
    """删除自定义角色目录（静态角色不能删除）。"""
    if role_id in STATIC_ROLE_DEFS:
        return False  # 不允许删除内置角色
    try:
        wd = os.path.join(ROLES_DIR, role_id)
        if os.path.exists(wd):
            shutil.rmtree(wd)
        global ROLE_DEFS
        ROLE_DEFS = scan_all_roles()
        return True
    except Exception as e:
        log.warning("delete_role failed: %s", e)
        return False

def update_role_prompt(role_id: str, prompt: str) -> bool:
    """更新角色提示词文件。"""
    if role_id not in ROLE_DEFS:
        return False
    try:
        wd = ROLE_DEFS[role_id]["workdir"]
        p = os.path.join(wd, "CLAUDE.md")
        with open(p, "w", encoding="utf-8") as f:
            f.write(prompt.strip() + "\n")
        return True
    except Exception as e:
        log.warning("update_role_prompt failed: %s", e)
        return False

# 内置预设分类（行业标签分组）
def get_builtin_presets() -> List[Dict]:
    """返回内置预设列表（按行业分组）。"""
    return [
        {
            "industryTag": "销售",
            "presets": [
                {
                    "id": "customer",
                    "name": "异议客户",
                    "description": "有顾虑的潜在客户，随时抛出异议，检验推销与应变能力",
                    "voice": "高晴",
                    "color": "sky",
                    "priority": 2,
                    "interruptAggressiveness": "high",
                    "thinkIntervalSec": DEFAULT_THINK_INTERVAL,
                    "ttsEnabled": False,
                },
                {
                    "id": "sales_manager",
                    "name": "销售经理",
                    "description": "销售团队管理者，评估话术，指出客户跟进问题",
                    "voice": "王新月",
                    "color": "emerald",
                    "priority": 3,
                    "interruptAggressiveness": "medium",
                    "thinkIntervalSec": DEFAULT_THINK_INTERVAL,
                    "ttsEnabled": False,
                },
            ],
        },
        {
            "industryTag": "管理",
            "presets": [
                {
                    "id": "boss",
                    "name": "老板",
                    "description": "管理层视角，直接犀利，复盘式提问，关注结果与风险",
                    "voice": "王新月",
                    "color": "amber",
                    "priority": 1,
                    "interruptAggressiveness": "medium",
                    "thinkIntervalSec": DEFAULT_THINK_INTERVAL,
                    "ttsEnabled": False,
                },
                {
                    "id": "project_manager",
                    "name": "项目经理",
                    "description": "项目执行视角，关注进度风险、资源分配、交付风险",
                    "voice": "王新月",
                    "color": "violet",
                    "priority": 2,
                    "interruptAggressiveness": "medium",
                    "thinkIntervalSec": DEFAULT_THINK_INTERVAL,
                    "ttsEnabled": False,
                },
            ],
        },
        {
            "industryTag": "产品",
            "presets": [
                {
                    "id": "product_manager",
                    "name": "产品经理",
                    "description": "产品需求评审视角，关注用户价值、需求逻辑、技术可行性",
                    "voice": "高晴",
                    "color": "rose",
                    "priority": 2,
                    "interruptAggressiveness": "medium",
                    "thinkIntervalSec": DEFAULT_THINK_INTERVAL,
                    "ttsEnabled": False,
                },
            ],
        },
    ]


class RoleAgent:
    """单个角色的长驻 Claude 进程。"""

    # 状态枚举（用于前端时间线显示）
    STATE_STARTING = "starting"          # 进程启动中
    STATE_SESSION_CREATED = "session"    # 会话ID已创建
    STATE_READY = "ready"                # CLI就绪，模型已加载
    STATE_TRANSCRIPT_SENT = "sent"       # 转写已发送
    STATE_RESPONSE_RECEIVED = "receiving" # 正在接收回复
    STATE_RESPONSE_DONE = "done"         # 回复生成完成

    def __init__(self, role_id: str, on_event, loop=None) -> None:
        self.role_id = role_id
        self.name = ROLE_DEFS[role_id]["name"]
        self.workdir = ROLE_DEFS[role_id]["workdir"]
        self.on_event = on_event  # async fn(role_id, kind, text)
        self.loop = loop  # 主事件循环引用（reader 线程用它安全调度）
        self.proc: subprocess.Popen | None = None
        self.session_id = str(uuid.uuid4())
        self.model_name = ""  # CLI init 事件回报的实际模型名（供前端显示）
        self.buffer: list[str] = []  # 转写增量缓冲
        self._buf_chars = 0
        self._reader_task: asyncio.Task | None = None
        self._alive = False
        self.enabled = True
        self.think_interval_sec = int(ROLE_DEFS[role_id].get("default_think_interval_sec", DEFAULT_THINK_INTERVAL))
        self.tts_enabled = bool(ROLE_DEFS[role_id].get("default_tts_enabled", DEFAULT_TTS_ENABLED))
        self.interrupt_enabled = False  # 该角色「可打断」开关（2026-08-27 起按角色独立，默认不打扰）
        self.priority = int(ROLE_DEFS[role_id].get("priority", 50))  # 发言优先级：小者先说（1 最高）
        self.last_flush_at = time.monotonic()
        # 运行状态（用于前端时间线）
        self.state = self.STATE_STARTING
        self.state_detail = ""  # 状态详情，如模型名、错误信息

    # ---------- 生命周期 ----------

    def set_state(self, state: str, detail: str = "") -> None:
        """更新角色运行状态，并通过 on_event 通知前端（state 类型）。"""
        self.state = state
        self.state_detail = detail
        try:
            if self.loop and self.loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    self.on_event(self.role_id, "STATE", json.dumps({"state": state, "detail": detail})),
                    self.loop
                )
        except Exception as e:  # noqa: BLE001
            log.debug("agent[%s] state notify failed: %s", self.role_id, e)

    async def start(self) -> None:
        # 继承宿主(gateway)环境 + 隔离 CLAUDE_CONFIG_DIR（避免加载用户全部 hooks/MCP）。
        # 关键：隔离目录必须先写入鉴权 settings.json（否则 CLI 未登录，见 _ensure_isolated_claude_home）
        _ensure_isolated_claude_home()
        env = os.environ.copy()
        for k in ("ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"):
            env.pop(k, None)
        env["CLAUDE_CONFIG_DIR"] = CLAUDE_ISOLATED_HOME
        self.set_state(self.STATE_STARTING, "正在启动 Claude 进程...")
        self.proc = subprocess.Popen(
            [
                CLAUDE_BIN, "-p",
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--verbose",  # stream-json 输出必需，缺失则 CLI 报错退出（见技能 E1）
                "--include-partial-messages",
                "--session-id", self.session_id,
                "--settings", os.path.join(self.workdir, ".claude/settings.json"),
                # 权限最小化：会议角色不需要工具
                "--allowedTools", "",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=open(f"/tmp/agent-{self.role_id}.err", "ab"),
            cwd=self.workdir,
            env=env,
        )
        self._alive = True
        self._pending_text = ""
        self.set_state(self.STATE_SESSION_CREATED, f"会话ID: {self.session_id[:8]}...")
        self._reader_task = asyncio.get_event_loop().run_in_executor(None, self._read_loop)
        log.info("agent[%s] started session=%s", self.role_id, self.session_id[:8])

    async def stop(self, graceful: bool = True) -> None:
        self._alive = False
        if graceful and self.proc and self.proc.poll() is None:
            try:
                self._inject("[会议结束] 请输出 SUMMARY。")
                await asyncio.sleep(2.5)  # 给摘要留时间（reader 仍在收）
            except Exception:  # noqa: BLE001
                pass
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        self.proc = None

    # ---------- 输入 ----------

    def push_transcript(self, text: str) -> None:
        if text.strip():
            t = text.strip()
            self.buffer.append(t)
            self._buf_chars += len(t)
            # 防止角色关闭太久导致上下文爆炸：最多保留约 4000 字符的增量窗口
            while self._buf_chars > 4000 and self.buffer:
                dropped = self.buffer.pop(0)
                self._buf_chars -= len(dropped)

    def flush(self) -> None:
        """把缓冲增量作为一条用户消息注入（无增量时跳过）。"""
        if not self.buffer or not self.proc or self.proc.poll() is not None:
            self.buffer.clear()
            self._buf_chars = 0
            return
        text = " ".join(self.buffer)
        self.buffer.clear()
        self._buf_chars = 0
        self._inject(f"[销售发言增量] {text}")
        self.set_state(self.STATE_TRANSCRIPT_SENT, f"已发送 {len(text)} 字转写")

    def _inject(self, text: str) -> None:
        if not self.proc or not self.proc.stdin:
            return
        msg = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        }
        try:
            self.proc.stdin.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
            log.info("agent[%s] injected %d chars", self.role_id, len(text))
        except Exception as e:  # noqa: BLE001
            log.warning("agent[%s] inject failed: %s", self.role_id, e)

    # ---------- 输出解析 ----------

    def _read_loop(self) -> None:
        """同步读 stdout JSONL（在线程池跑），解析 assistant 文本 -> 标记协议。"""
        try:
            assert self.proc and self.proc.stdout
            for raw in iter(self.proc.stdout.readline, b""):
                if not self._alive:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                ev_type = ev.get("type")

                # init 事件（CLI 2.x 可能不带 model 字段）
                if ev_type == "system" and ev.get("subtype") == "init":
                    if not self.model_name:
                        self.set_state(self.STATE_READY, "Claude CLI 就绪")
                    log.info("agent[%s] init received", self.role_id)

                if ev_type == "stream_event":
                    # --include-partial-messages 的增量帧：从 content_block_delta 实时提取文本，
                    # 按行结算（角色协议为逐行 OBSERVE:/INTERRUPT:）
                    ue = ev.get("event") or {}
                    # message_start 事件携带实际模型名
                    if ue.get("type") == "message_start":
                        msg = ue.get("message") or {}
                        model = str(msg.get("model") or "")
                        if model and model != self.model_name:
                            self.model_name = model
                            log.info("agent[%s] model=%s", self.role_id, self.model_name)
                            self.set_state(self.STATE_READY, f"模型就绪: {model}")
                    # message_stop 表示本轮回复完成
                    if ue.get("type") == "message_stop":
                        self.set_state(self.STATE_RESPONSE_DONE, "回复生成完成")
                    if ue.get("type") == "content_block_delta":
                        delta = (ue.get("delta") or {}).get("text", "")
                        if delta:
                            self._pending_text += delta
                            while "\n" in self._pending_text:
                                out, self._pending_text = self._pending_text.split("\n", 1)
                                if out.strip():
                                    self._handle_text(out.strip())
                    continue

                if ev_type == "assistant":
                    content = (ev.get("message") or {}).get("content") or []
                    for block in content:
                        if block.get("type") == "text":
                            self._handle_text(block.get("text", ""))
                    continue
        except Exception as e:  # noqa: BLE001
            log.debug("agent[%s] reader end: %s", self.role_id, e)

    _pending_text = ""

    def _handle_text(self, text: str) -> None:
        # 网关错误（429 等）会以 assistant 文本形式出现，不能当角色发言
        if text.startswith("API Error"):
            log.warning("agent[%s] gateway error: %s", self.role_id, text[:120])
            self.set_state("error", text[:100])
            return
        # 收到回复文本，更新状态
        if self.state not in (self.STATE_RESPONSE_RECEIVED, self.STATE_RESPONSE_DONE):
            self.set_state(self.STATE_RESPONSE_RECEIVED, "正在生成回复...")
        for ln in text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            m = re.match(r"^(OBSERVE|INTERRUPT|REPLY|SUMMARY|LISTEN)\s*[:：]\s*(.+)$", ln, re.I)
            if m:
                kind = m.group(1).upper()
                payload = m.group(2).strip()
            else:
                # 容错：无标记的短行按 observe 处理
                kind, payload = "OBSERVE", ln
            if kind == "INTERRUPT":
                # 打断内容按真人插话清洗（2026-08-27）：去掉混入的协议标记词
                # （OBSERVE/REPLAY 等），并截断到 80 字内，避免大段文字
                payload = re.sub(r"\b(OBSERVE|INTERRUPT|REPLY|SUMMARY|REPLAY|LISTEN)\b\s*[:：]?", " ", payload, flags=re.I)
                payload = " ".join(payload.split())
                if len(payload) > 80:
                    payload = payload[:80].rstrip() + "…"
                if not payload:
                    continue
            # 子线程中必须用主 loop 的 run_coroutine_threadsafe；
            # 在子线程调 asyncio.get_event_loop() 会拿到错误/已关闭的 loop 导致事件静默丢失
            try:
                if self.loop and self.loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self.on_event(self.role_id, kind, payload), self.loop
                    )
            except Exception as e:  # noqa: BLE001
                log.warning("agent[%s] dispatch failed: %s", self.role_id, e)


class AgentRunner:
    """一场会议的全部角色代理 + 定时 flush。"""

    def __init__(self) -> None:
        self.agents: dict[str, RoleAgent] = {}
        self._timer: asyncio.Task | None = None
        self.on_event = None  # async fn(role_id, kind, text)
        self.summary: dict[str, str] = {}
        self.interrupt_enabled = False
        self.ai_listen = True
        self.interrupt_hold_until = 0.0  # 真人打断保持期：期间暂停全部角色发言 flush

    async def start_meeting(self, role_ids: list[str], interval_sec: int, on_event) -> dict:
        self.on_event = on_event
        self.interrupt_enabled = False
        self.ai_listen = True
        self.summary = {}
        session_ids = {}
        loop = asyncio.get_running_loop()
        for rid in role_ids:
            agent = RoleAgent(rid, self._event, loop=loop)
            await agent.start()
            self.agents[rid] = agent
            session_ids[rid] = agent.session_id
        self._timer = asyncio.get_event_loop().create_task(self._loop(interval_sec))
        # 不在此等待模型名：CLI 冷启动约 7s 才发 init 事件，阻塞会拖慢 meeting.started。
        # 由调用方（main.py）异步推送 claude.models。
        return session_ids

    async def wait_models(self, timeout_sec: float = 30.0) -> dict[str, str]:
        """等待所有角色的 CLI init 事件回报模型名（冷启动约 5-8s）。"""
        for _ in range(int(timeout_sec * 10)):
            models = self.get_models()
            if self.agents and len(models) == len(self.agents):
                return models
            await asyncio.sleep(0.1)
        return self.get_models()

    def get_models(self) -> dict[str, str]:
        """各角色实际使用的 Claude 模型名（init 事件回报）。"""
        return {rid: a.model_name for rid, a in self.agents.items() if a.model_name}

    async def _event(self, role_id: str, kind: str, text: str) -> None:
        if kind == "SUMMARY":
            self.summary[role_id] = text
            return
        # 打断模式由前端 config 控制时，非执行态也照发（executed 字段由调用方决定）
        if self.on_event:
            await self.on_event(role_id, kind, text)

    async def _loop(self, interval_sec: int) -> None:
        try:
            while True:
                # interval_sec 仅作为“轮询步长”，实际是否 flush 由每角色 think_interval_sec 控制
                await asyncio.sleep(max(0.3, min(1.0, float(interval_sec))))
                if not self.ai_listen:
                    continue
                now = time.monotonic()
                if now < self.interrupt_hold_until:
                    continue  # 打断保持期：暂停所有角色发言，听打断说完再继续
                # 发言顺序：同一轮到期时按 priority 升序依次触发（小者先说），
                # 并给高优先级角色让出 1.5s 间隔——先说的发言更可能影响后说者的判断
                due = sorted(
                    [a for a in self.agents.values() if a.enabled
                     and (now - a.last_flush_at) >= max(1, int(a.think_interval_sec))],
                    key=lambda a: a.priority,
                )
                for agent in due:
                    if agent.buffer:
                        agent.flush()
                    agent.last_flush_at = now
                    if len(due) > 1:
                        await asyncio.sleep(1.5)
        except asyncio.CancelledError:
            pass

    def set_interrupt_mode(self, enabled: bool) -> None:
        self.interrupt_enabled = enabled

    def set_ai_listen(self, enabled: bool) -> None:
        self.ai_listen = enabled

    def hold_for_interrupt(self, role_id: str, text: str) -> None:
        """真人打断模拟（2026-08-27）：打断执行时——
        1) 立即把打断内容注入其他角色（他们"听见"了打断，后续生成纳入该上下文）；
        2) 按打断文本长度估算说话时长，期间 _loop 暂停全部角色发言 flush
           （模拟大家停下来听打断说完，再继续接收和回复）。"""
        agent = self.agents.get(role_id)
        if not agent:
            return
        note = text[:80]
        for rid, other in self.agents.items():
            if rid != role_id and other.enabled:
                try:
                    other._inject(f"[{agent.name}打断] {note}")
                except Exception:  # noqa: BLE001
                    pass
        # 语速约 4.2 字/秒（TTS speech_rate 1.2 折算）+ 停顿余量，clamp 3-15s
        self.interrupt_hold_until = time.monotonic() + max(3.0, min(15.0, len(text) / 4.2 + 1.5))
        log.info("interrupt hold %.1fs by %s", self.interrupt_hold_until - time.monotonic(), role_id)

    def update_role(self, role_id: str, enabled=None, think_interval_sec=None, tts_enabled=None, priority=None, interrupt_enabled=None) -> None:
        agent = self.agents.get(role_id)
        if not agent:
            return
        if enabled is not None:
            agent.enabled = bool(enabled)
        if think_interval_sec is not None:
            try:
                agent.think_interval_sec = max(2, min(60, int(think_interval_sec)))
            except Exception:
                pass
        if tts_enabled is not None:
            agent.tts_enabled = bool(tts_enabled)
        if interrupt_enabled is not None:
            agent.interrupt_enabled = bool(interrupt_enabled)
        if priority is not None:
            try:
                agent.priority = max(1, min(99, int(priority)))
            except Exception:
                pass

    def restart_agent(self, role_id: str) -> bool:
        """提示词被编辑后热重启该角色进程（下一轮思考即用新提示词）。
        保留 session_id 不变：CLI --session-id 续会话 + 新进程重读 CLAUDE.md。"""
        agent = self.agents.get(role_id)
        if not agent:
            return False
        try:
            async def _restart():
                await agent.stop()
                new_agent = RoleAgent(role_id, self._event, loop=asyncio.get_event_loop())
                new_agent.session_id = agent.session_id  # 续会话（保留对话记忆）
                new_agent.enabled = agent.enabled
                new_agent.think_interval_sec = agent.think_interval_sec
                new_agent.tts_enabled = agent.tts_enabled
                new_agent.priority = agent.priority
                await new_agent.start()
                self.agents[role_id] = new_agent
            asyncio.get_event_loop().create_task(_restart())
            return True
        except Exception as e:
            log.warning("restart_agent failed: %s", e)
            return False

    async def stop_meeting(self) -> dict:
        if self._timer:
            self._timer.cancel()
            self._timer = None
        for agent in self.agents.values():
            agent.flush()  # 最后的增量也注入
        for agent in self.agents.values():
            await agent.stop(graceful=True)
        result = dict(self.summary)
        self.agents.clear()
        return result
