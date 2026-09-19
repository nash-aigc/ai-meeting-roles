"""ASR WebSocket 中转代理。

浏览器（无法自定义 WS 握手头） --/ws/asr--> gateway（带鉴权头） --> 火山 wss://openspeech.bytedance.com

中转协议（浏览器 -> gateway 第一条文本帧）：
    {"type": "connect", "endpoint": "wss://...", "headers": {...}}
之后双向帧全部透明转发：
    浏览器二进制帧 -> 火山；火山二进制帧 -> 浏览器。
gateway 自身状态用文本帧回传：{"type":"connected"} / {"type":"error","detail":"..."}
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

import websockets
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import InvalidStatus
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gateway")

VOLC_HOST_ALLOWLIST = ("openspeech.bytedance.com",)

app = FastAPI(title="Meeting Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "service": "meeting-gateway"}


# ---------- 录音归档：上传 / 回放 ----------

RECORD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "Record")


@app.post("/api/meeting/{meeting_id}/audio")
async def upload_meeting_audio(meeting_id: str, request: Request) -> JSONResponse:
    """前端录音结束后上传合并音频（webm/m4a），存 Record/<meetingId>/recording.webm。
    同名覆盖（重复结束场景）。"""
    try:
        body = await request.body()
        if not body:
            return JSONResponse({"error": "empty body"}, status_code=400)
        folder = os.path.join(RECORD_DIR, meeting_id)
        os.makedirs(folder, exist_ok=True)
        ext = "webm"
        path = os.path.join(folder, f"recording.{ext}")
        with open(path, "wb") as f:
            f.write(body)
        log.info("audio archived: %s (%d KB)", path, len(body) // 1024)
        return {"ok": True, "path": f"Record/{meeting_id}/recording.{ext}"}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)[:200]}, status_code=500)


@app.get("/api/meeting/{meeting_id}/audio")
async def get_meeting_audio(meeting_id: str) -> Response:
    """历史回放：返回该会议归档的录音。"""
    # 防 path traversal：只允许合法 id 字符
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", meeting_id)
    for ext in ("webm", "m4a", "mp3", "ogg"):
        path = os.path.join(RECORD_DIR, safe_id, f"recording.{ext}")
        if os.path.exists(path):
            media = {
                "webm": "audio/webm",
                "m4a": "audio/mp4",
                "mp3": "audio/mpeg",
                "ogg": "audio/ogg",
            }[ext]
            with open(path, "rb") as f:
                return Response(content=f.read(), media_type=media)
    return JSONResponse({"error": "recording not found"}, status_code=404)


# ---------- Orca：打开 Claude Code 会话（历史详情「打开Claude」按钮） ----------

ORCA_BIN = shutil.which("orca") or "/usr/local/bin/orca"


@app.post("/api/claude/{session_id}/open")
async def open_claude_session(session_id: str) -> JSONResponse:
    """用 Orca 打开并 resume 指定 Claude Code 会话（终端新标签页）。
    流程复刻 Raycast orca-request.sh 的 session 定位逻辑：
      1. 校验 UUID  2. ~/.claude/projects 找 <id>.jsonl 读 cwd
      3. orca terminal create --command "cd <cwd> && claude --resume <id>"
    """
    sid = session_id.strip().lower()
    if not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", sid):
        return JSONResponse({"error": "无效的会话 ID"}, status_code=400)

    # 会议角色的 CLI 用隔离 CLAUDE_CONFIG_DIR（agents.CLAUDE_ISOLATED_HOME），
    # 会话 jsonl 落在那里的 projects/ 下；用户手动会话则在 ~/.claude/projects。两边都搜
    # （2026-08-27 修复：此前只搜 ~/.claude/projects，历史详情「打开Claude」必 404）。
    session_file = None
    claude_home = None
    for home in (os.path.expanduser("~/.claude"), CLAUDE_ISOLATED_HOME):
        projects_dir = os.path.join(home, "projects")
        if not os.path.isdir(projects_dir):
            continue
        for root, _dirs, files in os.walk(projects_dir):
            if f"{sid}.jsonl" in files:
                session_file = os.path.join(root, f"{sid}.jsonl")
                claude_home = home
                break
        if session_file:
            break
    if not session_file:
        return JSONResponse({"error": "未找到该会话的本地记录"}, status_code=404)

    cwd = ""
    try:
        with open(session_file, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"cwd"' in line:
                    m = re.search(r'"cwd"\s*:\s*"([^"]+)"', line)
                    if m:
                        cwd = m.group(1)
                        break
    except OSError:
        pass
    if not cwd or not os.path.isdir(cwd):
        return JSONResponse({"error": "会话原工作目录不可用"}, status_code=404)

    def _open_in_orca() -> tuple[bool, str]:
        try:
            # 拉起 Orca（幂等）
            subprocess.run([ORCA_BIN, "open"], capture_output=True, timeout=15)
            # 等待可达
            for _ in range(20):
                r = subprocess.run([ORCA_BIN, "status", "--json"], capture_output=True, timeout=10)
                if r.returncode == 0:
                    break
                time.sleep(0.3)
            else:
                return False, "Orca 不可达"
            # 会话在隔离 home 时，resume 必须指向同一 CLAUDE_CONFIG_DIR（否则 CLI 找不到会话）
            env_prefix = f"CLAUDE_CONFIG_DIR={CLAUDE_ISOLATED_HOME} " if claude_home == CLAUDE_ISOLATED_HOME else ""
            cmd = f'cd "{cwd}" && {env_prefix}claude --resume "{sid}"'
            r = subprocess.run(
                [ORCA_BIN, "terminal", "create",
                 "--worktree", f"path:{cwd}",
                 "--title", f"Meeting {sid[:8]}",
                 "--command", cmd, "--focus", "--json"],
                capture_output=True, timeout=20,
            )
            if r.returncode == 0:
                return True, "已在新标签页恢复会话"
            return False, r.stderr.decode(errors="replace")[:200] or "terminal create 失败"
        except FileNotFoundError:
            return False, "未安装 orca CLI"
        except Exception as e:  # noqa: BLE001
            return False, str(e)[:200]

    ok, detail = await asyncio.to_thread(_open_in_orca)
    log.info("orca open session %s: %s %s", sid[:8], ok, detail)
    if ok:
        return {"ok": True, "detail": detail, "cwd": cwd}
    return JSONResponse({"error": detail}, status_code=500)


# ---------- 配置加载：.env（真实密钥只存本地，.gitignore 排除；模板见 .env.example） ----------

def _load_dotenv() -> None:
    """极简 .env 解析（无需第三方依赖）：KEY=VALUE，# 注释，覆盖 os.environ。"""
    import io
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


_load_dotenv()

# ---------- TTS：阿里云 CosyVoice 合成（MaaS 专属端点；参数全部来自 .env） ----------

TTS_KEY = os.getenv("TTS_KEY", "")
TTS_HTTP = os.getenv("TTS_HTTP", "")
TTS_WS = os.getenv("TTS_WS", "")
TTS_MODEL = os.getenv("TTS_MODEL", "cosyvoice-v3.5-plus")
TTS_SPEECH_RATE = float(os.getenv("TTS_SPEECH_RATE", "1.2"))
TTS_VOICES = {
    "王新月": os.getenv("TTS_VOICE_WANGXINYUE", ""),
    "高晴": os.getenv("TTS_VOICE_GAOQING", ""),
}
# ASR（豆包/火山）：完整配置下发前端导入（浏览器 localStorage 是前端唯一存储）
VOLC_ASR = {
    "token": os.getenv("VOLC_ASR_TOKEN", ""),
    "appid": os.getenv("VOLC_ASR_APPID", ""),
    "resourceId": os.getenv("VOLC_ASR_RESOURCE_ID", "volc.seedasr.sauc.duration"),
    "endpoint": os.getenv("VOLC_ASR_ENDPOINT", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"),
}


@app.get("/api/config/asr")
async def config_asr() -> JSONResponse:
    """前端「从 .env 导入」：返回 .env 里的豆包 ASR 配置（本机绑定，不进仓库）。
    TTS 密钥不下发前端——前端只调 /api/tts，由 gateway 持钥合成。"""
    return JSONResponse({
        "volc": VOLC_ASR,
        "ttsConfigured": bool(TTS_KEY and TTS_HTTP and TTS_WS),
    })


@app.get("/api/asr/test-audio")
async def asr_test_audio() -> JSONResponse:
    """生成一段测试语音（16kHz 16-bit PCM WAV），供前端 ASR 配置测试使用。
    使用 macOS `say` 命令合成「你好，这是一段语音识别配置测试」，转换为 16kHz WAV 后 base64 返回。
    TTS 不可用时的通用备选方案。"""
    import subprocess
    import tempfile
    import base64

    test_text = "你好，这是一段语音识别配置测试"

    # `say` 是 macOS 专有命令；Linux 容器内直接返回明确原因（原实现会落到 500 + 晦涩的 stderr）
    if not shutil.which("say"):
        return JSONResponse(
            {"ok": False, "error": "say 仅 macOS 可用；容器内请改用 /api/tts，或直接录音测试 ASR"},
            status_code=501,
        )

    try:
        # 1. 使用 macOS say 命令生成 AIFF
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f_aiff:
            aiff_path = f_aiff.name
        result = subprocess.run(
            ["say", "-o", aiff_path, test_text],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return JSONResponse({"ok": False, "error": f"say 命令失败: {result.stderr[:200]}"}, status_code=500)

        # 2. 用 ffmpeg 转 16kHz 单声道 16-bit WAV
        wav_path = aiff_path + ".wav"
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", aiff_path, "-ar", "16000", "-ac", "1",
             "-sample_fmt", "s16", wav_path],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return JSONResponse({"ok": False, "error": f"ffmpeg 转换失败: {result.stderr[:200]}"}, status_code=500)

        # 3. 读取 WAV（跳过 44 字节头，取 PCM 数据）
        with open(wav_path, "rb") as f:
            wav_data = f.read()
        pcm_data = wav_data[44:] if len(wav_data) > 44 else wav_data

        # 4. 清理临时文件
        try:
            os.unlink(aiff_path)
            os.unlink(wav_path)
        except Exception:
            pass

        return JSONResponse({
            "ok": True,
            "text": test_text,
            "sampleRate": 16000,
            "channels": 1,
            "bitsPerSample": 16,
            "pcmBase64": base64.b64encode(pcm_data).decode("ascii"),
        })
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"生成测试音频失败: {str(e)[:200]}"}, status_code=500)


def _tts_synth(text: str, voice_name: str) -> bytes:
    """同步合成（在线程池里跑）：返回 mp3 字节。失败抛异常。"""
    import dashscope
    from dashscope.audio.tts_v2 import SpeechSynthesizer

    dashscope.api_key = TTS_KEY
    dashscope.base_http_api_url = TTS_HTTP
    dashscope.base_websocket_api_url = TTS_WS
    voice_id = TTS_VOICES.get(voice_name, TTS_VOICES["高晴"])
    clean = " ".join(text.split())
    syn = SpeechSynthesizer(model=TTS_MODEL, voice=voice_id, speech_rate=TTS_SPEECH_RATE)
    audio = syn.call(clean)
    if not audio:
        raise RuntimeError("合成返回空音频")
    return audio


@app.post("/api/tts")
async def tts(req: dict) -> Response:
    """合成一段语音并返回音频（audio/mpeg）。

    body: {"text": "要合成的话", "voice": "高晴|王新月"}
    """
    text = str(req.get("text") or "").strip()
    voice = str(req.get("voice") or "高晴").strip()
    if not text:
        return JSONResponse({"error": "text is empty"}, status_code=400)
    try:
        data = await asyncio.to_thread(_tts_synth, text[:500], voice)
        log.info("tts ok: voice=%s %dB", voice, len(data))
        return Response(content=data, media_type="audio/mpeg")
    except Exception as e:  # noqa: BLE001
        msg = str(e) or type(e).__name__
        log.warning("tts failed: %s", msg)
        return JSONResponse({"error": f"合成失败: {msg[:300]}"}, status_code=502)


@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket) -> None:
    """浏览器 <-> 火山 ASR 双向透传代理（浏览器无法自定义 WS 握手头）。

    浏览器首帧发文本 connect:
        {"type":"connect","endpoint":"wss://...","headers":{...,"X-Api-Key":...},
         "altHeaders":{...(可选，旧版 AppID 双头鉴权备用)}}
    与火山连上后 gateway 回文本 {"type":"connected"}，
    之后全部帧（浏览器二进制 -> 火山；火山二进制/文本 -> 浏览器）透明转发。
    gateway 自身状态用文本帧回传 {"type":"error","detail":...}。
    """
    import traceback
    from urllib.parse import urlparse

    await ws.accept()
    try:
        # 1) 读 connect 帧
        raw = await ws.receive_text()
        try:
            m = json.loads(raw)
        except Exception:  # noqa: BLE001
            await ws.send_text(json.dumps({"type": "error", "detail": "connect 帧不是合法 JSON"}))
            return
        if m.get("type") != "connect":
            await ws.send_text(json.dumps({"type": "error", "detail": "首帧必须是 connect"}))
            return
        endpoint = str(m.get("endpoint") or "").strip()
        headers = m.get("headers") or {}
        alt_headers = m.get("altHeaders") or {}
        if isinstance(headers, dict):
            headers = {k: str(v) for k, v in headers.items() if v}
        if isinstance(alt_headers, dict):
            alt_headers = {k: str(v) for k, v in alt_headers.items() if v}

        # 2) 域名白名单 + 鉴权头存在性检查
        host = (urlparse(endpoint).hostname or "").lower()
        if host not in VOLC_HOST_ALLOWLIST:
            await ws.send_text(json.dumps({
                "type": "error", "detail": f"endpoint 域名不在白名单: {host}",
            }))
            return
        if "X-Api-Key" not in headers and "X-Api-Access-Key" not in headers:
            await ws.send_text(json.dumps({
                "type": "error", "detail": "connect 帧缺少 X-Api-Key 鉴权头",
            }))
            return

        # 3) 连火山；primary 头被拒且提供了 altHeaders（旧版 AppID 双头）时回落重试
        volc = None
        try:
            volc = await ws_connect(
                endpoint, additional_headers=headers,
                max_size=8 * 1024 * 1024, open_timeout=10,
            )
        except InvalidStatus as fist:
            if alt_headers:
                log.warning("asr connect rejected (%s), retrying with altHeaders", fist)
                await asyncio.sleep(0.3)
                volc = await ws_connect(
                    endpoint, additional_headers=alt_headers,
                    max_size=8 * 1024 * 1024, open_timeout=10,
                )
            else:
                raise
        await ws.send_text(json.dumps({"type": "connected"}))

        # 4) 双向透明转发
        async def browser_to_volc() -> None:
            try:
                while True:
                    raw_msg = await ws.receive()
                    if raw_msg.get("type") in ("websocket.disconnect", "websocket.close"):
                        break
                    data = raw_msg.get("bytes")
                    if data is None:
                        text = raw_msg.get("text")
                        if text is None:
                            continue
                        data = text.encode("utf-8")  # 浏览器误发文本帧也透传
                    assert volc is not None
                    await volc.send(data)
            except WebSocketDisconnect:
                pass
            except Exception as e:  # noqa: BLE001
                log.warning("b->v loop end: %s", e)

        async def volc_to_browser() -> None:
            try:
                assert volc is not None
                async for msg in volc:
                    if isinstance(msg, bytes):
                        await ws.send_bytes(msg)
                    elif isinstance(msg, str):
                        log.info("v->b text: %.2fKB", len(msg) / 1024)
                        await ws.send_text(msg)
            except WebSocketDisconnect:
                pass
            except Exception as e:  # noqa: BLE001
                log.warning("v->b loop end: %s", e)

        await asyncio.gather(browser_to_volc(), volc_to_browser())

    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("asr proxy error: %s\n%s", e, traceback.format_exc())
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "detail": f"ASR 代理失败: {(str(e) or type(e).__name__)[:200]}",
            }))
        except Exception:  # noqa: BLE001
            pass


# ---------- 会议主通道：录音状态 + 角色代理编排 ----------

from agents import AgentRunner, ROLE_DEFS, prompt_preview, read_full_prompt, CLAUDE_ISOLATED_HOME  # noqa: E402
from agents import create_role_directory, delete_role_directory, update_role_prompt, get_builtin_presets  # noqa: E402

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # Meeting/

# 模块级共享角色配置（跨 WebSocket 连接保持，避免刷新页面后配置重置）
ROLE_CFG: dict[str, dict] = {
    rid: {
        "enabled": False,
        "defaultEnabled": False,
        "thinkIntervalSec": int(ROLE_DEFS[rid].get("default_think_interval_sec", 10)),
        "ttsEnabled": bool(ROLE_DEFS[rid].get("default_tts_enabled", False)),
        "priority": int(ROLE_DEFS[rid].get("priority", 50)),
        "interruptEnabled": False,
    }
    for rid in ROLE_DEFS
}


def _safe_filename(name: str, max_len: int = 48) -> str:
    """把标题/摘要变成可落盘的文件名（不含扩展名）。"""
    s = (name or "").strip() or "会议记录"
    s = re.sub(r"[\\/:*?\"<>|\n\r\t]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        s = "会议记录"
    return s[:max_len].rstrip()


def _export_meeting_texts(meeting_id: str, base_title: str, transcripts: list[dict], agent_events: list[dict]) -> tuple[str, str, str]:
    """导出两份文本：纯用户转写 / 用户+AI 综合版。返回 (folder_rel, transcript_file, combined_file)。"""
    folder_rel = f"Record/{meeting_id}"
    folder_abs = os.path.join(ROOT_DIR, folder_rel)
    os.makedirs(folder_abs, exist_ok=True)

    base = _safe_filename(base_title)
    transcript_file = f"{base}.用户.txt"
    combined_file = f"{base}.用户+AI.txt"

    def stamp(ts_ms: int) -> str:
        sec = max(0, int(ts_ms // 1000))
        mm = sec // 60
        ss = sec % 60
        hh = mm // 60
        mm = mm % 60
        return f"{hh:02d}:{mm:02d}:{ss:02d}"

    # 1) 纯用户
    lines_user: list[str] = []
    for t in transcripts:
        ts = stamp(int(t.get("tsMs", 0)))
        text = str(t.get("text", "")).strip()
        if text:
            lines_user.append(f"[{ts}] 说话人1：{text}")
    if not lines_user:
        lines_user = ["（无转写内容）"]
    with open(os.path.join(folder_abs, transcript_file), "w", encoding="utf-8") as f:
        f.write("\n".join(lines_user) + "\n")

    # 2) 综合版：按时间合并
    merged: list[dict] = []
    merged.extend([{"tsMs": t.get("tsMs", 0), "speaker": "user", "text": t.get("text", "")} for t in transcripts])
    for e in agent_events:
        merged.append({
            "tsMs": e.get("tsMs", 0),
            "speaker": e.get("role", ""),
            "text": e.get("text", ""),
            "kind": e.get("type", "observe"),
        })
    merged.sort(key=lambda x: int(x.get("tsMs", 0)))

    lines_all: list[str] = []
    for it in merged:
        ts = stamp(int(it.get("tsMs", 0)))
        speaker = "说话人1" if it.get("speaker") == "user" else str(it.get("speaker") or "AI")
        kind = str(it.get("kind") or "")
        prefix = ""
        if it.get("speaker") != "user":
            prefix = {"observe": "观点", "reply": "回复", "interrupt": "插话", "listen": "再听听"}.get(kind, "AI")
            prefix = f"{prefix}·"
        text = str(it.get("text", "")).strip()
        if text:
            lines_all.append(f"[{ts}] {prefix}{speaker}：{text}")
    if not lines_all:
        lines_all = ["（无内容）"]
    with open(os.path.join(folder_abs, combined_file), "w", encoding="utf-8") as f:
        f.write("\n".join(lines_all) + "\n")

    return folder_rel, transcript_file, combined_file


@app.websocket("/ws/meeting")
async def ws_meeting(ws: WebSocket) -> None:
    await ws.accept()
    runner: AgentRunner | None = None
    started_at = 0
    push_interval = 5  # 轮询步长（每角色真正的“思考间隔”由 role.thinkIntervalSec 控制）
    meeting_id = ""
    ai_listen = True
    role_cfg = ROLE_CFG  # 引用模块级共享配置，跨连接保持
    transcripts: list[dict] = []  # {tsMs, speaker:'user', text}
    agent_events: list[dict] = []  # {tsMs, role, type, text, executed?}

    async def send(obj: dict) -> None:
        try:
            await ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    # 配色/音色/优先级/侵略性映射（动态角色从名称推断，这里兜底默认值）
    _default_role_meta = {
        "customer": ("高晴", "sky", 2, "high", "有顾虑的潜在客户"),
        "boss": ("王新月", "amber", 1, "medium", "管理层视角"),
        "sales_manager": ("王新月", "emerald", 3, "medium", "销售团队管理者"),
        "project_manager": ("王新月", "violet", 2, "medium", "项目经理"),
        "product_manager": ("高晴", "rose", 2, "medium", "产品经理"),
    }

    async def send_roles() -> None:
        roles_data = []
        for rid in role_cfg.keys():
            # 尝试从预定义meta拿，否则默认值
            if rid in _default_role_meta:
                voice, color, priority, agg, desc = _default_role_meta[rid]
            else:
                voice = "高晴" if rid.endswith("_customer") else "王新月"
                color = "sky" if "customer" in rid else "amber"
                priority = 2
                agg = "medium"
                desc = ROLE_DEFS.get(rid, {}).get("name", rid)
            role_name = ROLE_DEFS.get(rid, {}).get("name", rid)
            roles_data.append({
                "id": rid,
                "name": role_name,
                "voice": voice,
                "color": color,
                "enabled": bool(role_cfg[rid]["enabled"]),
                "defaultEnabled": bool(role_cfg[rid].get("defaultEnabled", False)),
                "thinkIntervalSec": int(role_cfg[rid]["thinkIntervalSec"]),
                "ttsEnabled": bool(role_cfg[rid]["ttsEnabled"]),
                "interruptEnabled": bool(role_cfg[rid].get("interruptEnabled", False)),
                "promptPreview": prompt_preview(rid) if rid in ROLE_DEFS else "",
                # 发言优先级：用户可在角色管理页调整（1 最高，同轮到期小者先说）
                "priority": int(role_cfg[rid].get("priority", priority)),
                "interruptAggressiveness": agg,
                "description": desc,
            })
        await send({
            "type": "roles.list",
            "roles": roles_data,
        })

    async def on_agent_event(role_id: str, kind: str, text: str) -> None:
        """角色输出 -> 前端事件 + 广播给其他角色（角色间信息互通：每个角色的会话里
        都能看到其他角色的发言，用户在任意角色的 Claude 会话 resume 都有完整信息）。"""
        # STATE 类型：角色运行状态更新（时间线显示），不存入事件列表
        if kind == "STATE":
            try:
                state_data = json.loads(text)
                await send({
                    "type": "agent.state",
                    "role": role_id,
                    "state": state_data.get("state", ""),
                    "detail": state_data.get("detail", ""),
                })
            except Exception:
                pass
            return
        import time as _t
        ts = int(_t.time() * 1000) - started_at
        # 跨角色同步：把该角色的发言注入其他所有角色上下文（observe 不广播，避免噪音回环）
        if kind in ("REPLY", "INTERRUPT") and runner:
            label = {"boss": "老板", "customer": "客户"}.get(role_id, role_id)
            note = f"[{label}{'（打断）' if kind == 'INTERRUPT' else ''}] {text}"
            for rid, agent in runner.agents.items():
                if rid != role_id and agent.enabled:
                    agent.push_transcript(note)
        if kind == "INTERRUPT":
            # 打断开关按角色独立（2026-08-27）：该角色开了「可打断」才执行，否则降级为静默
            agent = runner.agents.get(role_id) if runner else None
            executed = bool(agent and agent.interrupt_enabled)
            agent_events.append({
                "tsMs": max(0, ts),
                "role": role_id,
                "type": "interrupt",
                "text": text,
                "executed": executed,
            })
            await send({
                "type": "agent.interrupt",
                "id": f"{role_id}-{ts}",
                "role": role_id,
                "text": text,
                "urgency": "medium",
                "executed": executed,
                "tsMs": max(0, ts),
            })
            if executed:
                # 真人打断模拟（2026-08-27）：其余角色立即"听见"打断并暂停发言，说完再继续
                runner.hold_for_interrupt(role_id, text)
        elif kind == "REPLY":
            agent_events.append({
                "tsMs": max(0, ts),
                "role": role_id,
                "type": "reply",
                "text": text,
            })
            await send({
                "type": "agent.reply",
                "id": f"{role_id}-{ts}",
                "role": role_id,
                "text": text,
                "tsMs": max(0, ts),
            })
        elif kind == "LISTEN":
            # 「再听听」（2026-08-27）：角色本轮选择不开口——真人沟通不是每轮都要说话。
            # 只记观点卡片，不语音播报
            agent_events.append({
                "tsMs": max(0, ts),
                "role": role_id,
                "type": "listen",
                "text": text,
            })
            await send({
                "type": "agent.listen",
                "id": f"{role_id}-{ts}",
                "role": role_id,
                "text": text,
                "tsMs": max(0, ts),
            })
        elif kind == "SUMMARY":
            # 由 stop 流程消费，不再转发
            pass
        else:
            agent_events.append({
                "tsMs": max(0, ts),
                "role": role_id,
                "type": "observe",
                "text": text,
            })
            await send({
                "type": "agent.observe",
                "id": f"{role_id}-{ts}",
                "role": role_id,
                "text": text,
                "sentiment": "neutral",
                "tsMs": max(0, ts),
            })

    try:
        # 初始角色列表
        await send_roles()
        while True:
            # 关键：用通用 receive()。前端 sendAudioChunk 会在同一连接上发二进制音频帧，
            # 用 receive_text() 遇到 binary 帧会抛 KeyError('text') 导致整个会议连接崩溃
            # （症状：开始录音后所有 user.speech 静默丢失，AI 无任何反馈）。
            raw_msg = await ws.receive()
            if raw_msg.get("type") in ("websocket.disconnect", "websocket.close"):
                break
            raw = raw_msg.get("text")
            if raw is None:
                continue  # 二进制音频帧：会议通道不消费，跳过
            try:
                m = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            t = m.get("type")

            if t == "meeting.start":
                import time as _t
                started_at = int(_t.time() * 1000)
                meeting_id = "gw-" + str(uuid.uuid4())[:8]
                transcripts.clear()
                agent_events.clear()
                patch = (m.get("patch") or {})
                # 打断开关已按角色独立；旧全局 interruptMode 兼容：可打断=全角色开启
                if patch.get("interruptMode") == "allowInterrupt":
                    for rc in role_cfg.values():
                        rc["interruptEnabled"] = True
                runner = AgentRunner()
                role_ids = [rid for rid in ROLE_DEFS]
                session_ids = await runner.start_meeting(role_ids, push_interval, on_agent_event)
                # 应用当前角色配置
                runner.set_ai_listen(ai_listen)
                for rid in role_ids:
                    cfg = role_cfg.get(rid) or {}
                    runner.update_role(
                        rid,
                        enabled=cfg.get("enabled"),
                        think_interval_sec=cfg.get("thinkIntervalSec"),
                        tts_enabled=cfg.get("ttsEnabled"),
                        interrupt_enabled=cfg.get("interruptEnabled"),
                    )
                await send({
                    "type": "meeting.started",
                    "meetingId": meeting_id,
                    "startedAt": started_at,
                    "claudeSessionIds": session_ids,
                })
                # 模型名异步推送：CLI 冷启动约 5-8s 才回报 init，不阻塞 meeting.started
                async def _push_models():
                    models = await runner.wait_models(30)
                    if models:
                        await send({"type": "claude.models", "models": models})
                asyncio.create_task(_push_models())
                await send({"type": "asr.status", "status": "ready"})

            elif t == "user.speech":
                # 用户转写增量 -> 角色缓冲
                import time as _t
                ts_ms = int(_t.time() * 1000) - started_at
                text = str(m.get("text", "") or "").strip()
                if text:
                    transcripts.append({
                        "tsMs": max(0, ts_ms),
                        "speaker": "user",
                        "text": text,
                    })
                if runner:
                    for agent in runner.agents.values():
                        if ai_listen and agent.enabled:
                            agent.push_transcript(text)

            elif t == "user.note":
                # 提示词输入框内容 -> 也进入角色上下文（跨角色信息同步）
                text = str(m.get("text", "") or "").strip()
                if text and runner and ai_listen:
                    for agent in runner.agents.values():
                        if agent.enabled:
                            agent.push_transcript(f"[用户补充提示] {text}")

            elif t == "config.update":
                patch = m.get("patch") or {}
                # 打断开关已按角色独立（roles[].interruptEnabled）；兼容旧前端全局字段：
                # 收到 interruptMode 时应用到所有角色
                if patch.get("interruptMode"):
                    allow = patch["interruptMode"] == "allowInterrupt"
                    for rc in role_cfg.values():
                        rc["interruptEnabled"] = allow
                    if runner:
                        for a_rid in list(runner.agents.keys()):
                            runner.update_role(a_rid, interrupt_enabled=allow)
                if patch.get("aiListen") is not None:
                    ai_listen = bool(patch.get("aiListen"))
                    if runner:
                        runner.set_ai_listen(ai_listen)
                # per-role: enabled / thinkIntervalSec / ttsEnabled
                roles_patch = patch.get("roles") or []
                if isinstance(roles_patch, list):
                    for rp in roles_patch:
                        rid = str(rp.get("id") or "")
                        if rid not in role_cfg:
                            continue
                        if rp.get("enabled") is not None:
                            role_cfg[rid]["enabled"] = bool(rp.get("enabled"))
                        if rp.get("defaultEnabled") is not None:
                            role_cfg[rid]["defaultEnabled"] = bool(rp.get("defaultEnabled"))
                            # 开启默认启动时，同时立即启用该角色
                            if role_cfg[rid]["defaultEnabled"]:
                                role_cfg[rid]["enabled"] = True
                        if rp.get("thinkIntervalSec") is not None:
                            try:
                                role_cfg[rid]["thinkIntervalSec"] = max(2, min(60, int(rp.get("thinkIntervalSec"))))
                            except Exception:
                                pass
                        if rp.get("ttsEnabled") is not None:
                            role_cfg[rid]["ttsEnabled"] = bool(rp.get("ttsEnabled"))
                        if rp.get("interruptEnabled") is not None:
                            role_cfg[rid]["interruptEnabled"] = bool(rp.get("interruptEnabled"))
                        if rp.get("priority") is not None:
                            try:
                                role_cfg[rid]["priority"] = max(1, min(99, int(rp.get("priority"))))
                            except Exception:
                                pass
                        if runner:
                            runner.update_role(
                                rid,
                                enabled=role_cfg[rid]["enabled"],
                                think_interval_sec=role_cfg[rid]["thinkIntervalSec"],
                                tts_enabled=role_cfg[rid]["ttsEnabled"],
                                priority=role_cfg[rid].get("priority"),
                                interrupt_enabled=role_cfg[rid].get("interruptEnabled"),
                            )
                    await send_roles()

            elif t == "role.create":
                role_data = m.get("role", {})
                rid = str(role_data.get("id", "")).strip()
                logging.info(f"role.create received: rid={rid}, in ROLE_DEFS={rid in ROLE_DEFS}, in role_cfg={rid in role_cfg}")
                if rid and rid not in ROLE_DEFS:
                    name = str(role_data.get("name", rid))
                    prompt = str(role_data.get("prompt", ""))
                    if prompt and create_role_directory(rid, name, prompt):
                        role_cfg[rid] = {
                            "enabled": False,
                            "defaultEnabled": False,
                            "thinkIntervalSec": int(role_data.get("thinkIntervalSec", 60)),
                            "ttsEnabled": bool(role_data.get("ttsEnabled", False)),
                            "priority": int(role_data.get("priority", 50)),
                            "interruptEnabled": False,
                        }
                        logging.info(f"role created: {rid}, role_cfg keys={list(role_cfg.keys())}, ROLE_DEFS keys={list(ROLE_DEFS.keys())}")
                        try:
                            await send_roles()
                            logging.info(f"send_roles succeeded after create")
                        except Exception as e:
                            logging.error(f"send_roles failed: {e}", exc_info=True)
                        await send({"type": "error", "detail": f"角色 {name} 创建成功"})
                    else:
                        await send({"type": "error", "detail": "创建失败，检查角色ID是否已存在"})
                else:
                    await send({"type": "error", "detail": "角色ID为空或已存在"})

            elif t == "role.delete":
                rid = str(m.get("id", "")).strip()
                if rid and rid not in ("customer", "boss"):
                    if delete_role_directory(rid):
                        role_cfg.pop(rid, None)
                        await send_roles()
                        await send({"type": "error", "detail": f"角色 {rid} 已删除"})
                    else:
                        await send({"type": "error", "detail": "删除失败"})
                else:
                    await send({"type": "error", "detail": "内置角色不能删除"})

            elif t == "role.update_prompt":
                rid = str(m.get("id", "")).strip()
                prompt = str(m.get("prompt", "")).strip()
                if rid in ROLE_DEFS and prompt:
                    if update_role_prompt(rid, prompt):
                        # 会议进行中：热重启该角色进程，新提示词立即生效（下一轮思考即用）
                        if runner:
                            runner.restart_agent(rid)
                        await send_roles()
                        await send({"type": "error", "detail": f"角色 {rid} 提示词已更新并即时生效"})
                    else:
                        await send({"type": "error", "detail": "提示词更新失败"})
                else:
                    await send({"type": "error", "detail": "角色不存在或提示词为空"})

            elif t == "role.presets.list":
                presets = get_builtin_presets()
                await send({"type": "role.presets", "presets": presets})

            elif t == "role.get_prompt":
                # 读取角色完整提示词（供管理页编辑框加载真实内容）
                rid = str(m.get("id", "")).strip()
                if rid in ROLE_DEFS:
                    await send({"type": "role.prompt", "id": rid, "prompt": read_full_prompt(rid)})
                else:
                    await send({"type": "error", "detail": f"角色不存在: {rid}"})

            elif t == "meeting.stop":
                if runner:
                    summaries = await runner.stop_meeting()
                    summary = summaries.get("customer") or summaries.get("boss") or "会议记录"
                    folder_rel, transcript_file, combined_file = _export_meeting_texts(
                        meeting_id,
                        summary,
                        transcripts,
                        agent_events,
                    )
                    await send({
                        "type": "meeting.archived",
                        "path": folder_rel,
                        "summary": summary[:40],
                        "transcriptFile": transcript_file,
                        "combinedFile": combined_file,
                    })
                    runner = None
                await send({"type": "meeting.state", "state": "closed"})

            elif t == "meeting.close":
                if runner:
                    await runner.stop_meeting()
                    runner = None
                await send({"type": "meeting.state", "state": "closed"})

    except WebSocketDisconnect:
        pass
    finally:
        if runner:
            try:
                await runner.stop_meeting()
            except Exception:  # noqa: BLE001
                pass


# ---------- 生产模式静态托管前端 dist ----------
DIST_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "web", "dist")
if os.path.isdir(DIST_DIR):

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(f"{DIST_DIR}/index.html")

    app.mount("/assets", StaticFiles(directory=f"{DIST_DIR}/assets"), name="assets")


def main() -> None:
    import uvicorn

    port = int(os.getenv("GATEWAY_PORT", "8790"))
    # 绑定地址：本机直跑默认只绑回环（本应用无鉴权，回环最安全）；
    # 容器内必须由 compose 传 GATEWAY_HOST=0.0.0.0，否则端口映射不可达。
    host = os.getenv("GATEWAY_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
