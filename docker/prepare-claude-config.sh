#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 生成容器用的 Claude 隔离配置（部署前必须先跑一次）
#
# 背景：server/gateway/agents.py 的 _ensure_isolated_claude_home() 会读
#       ~/.claude/settings.json 的 env 段来拿鉴权，再写进隔离目录给 CLI 用。
#       而宿主机里 ANTHROPIC_BASE_URL 指向 localhost:3000（new-api），
#       容器内的 localhost 是容器自己 → 必然连不上。
#
# 本脚本把那份配置复制一份，只把**指向本机的主机名**改写为 host.docker.internal，
# 产物 docker/claude-settings.json 含真实 token：
#   · 已写进 .gitignore     · 权限 600     · 绝不 COPY 进镜像（见 .dockerignore）
#
# 本脚本**只报告改写了哪个键，绝不回显任何值**。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$HOME/.claude/settings.json"
DST="$ROOT/docker/claude-settings.json"

[ -f "$SRC" ] || { echo "✗ 找不到宿主机配置：$SRC" >&2; exit 1; }

mkdir -p "$ROOT/docker/claude-home"

python3 - "$SRC" "$DST" <<'PY'
import json, sys, urllib.parse

src, dst = sys.argv[1], sys.argv[2]
try:
    env = (json.load(open(src, encoding="utf-8")).get("env") or {})
except Exception as e:
    sys.exit(f"✗ 解析 {src} 失败：{e}")

LOCAL = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}

def rewrite(u: str) -> str:
    """把指向本机的主机名换成本机能从容器访问到的地址。"""
    if not u:
        return u
    p = urllib.parse.urlsplit(u if "//" in u else "http://" + u)
    if p.hostname in LOCAL:
        host = "host.docker.internal" + (f":{p.port}" if p.port else "")
        return urllib.parse.urlunsplit((p.scheme, host, p.path, p.query, p.fragment))
    return u

before = env.get("ANTHROPIC_BASE_URL", "")
after = rewrite(before)
if before != after:
    env["ANTHROPIC_BASE_URL"] = after

# 与 agents.py 写到隔离目录的结构保持一致
with open(dst, "w", encoding="utf-8") as f:
    json.dump({"env": env, "includeCoAuthoredBy": False}, f, indent=2, ensure_ascii=False)
    f.write("\n")

# ⚠️ 以下只输出"有无/是否"，绝不输出键值
print(f"✓ 已写出 {dst}（{len(env)} 个 env 键）")
print(f"  ANTHROPIC_BASE_URL：{'已改写主机为 host.docker.internal' if before != after else '无需改写（本来就不是本机地址）'}")
print(f"  鉴权项 AUTH_TOKEN：{'就位' if env.get('ANTHROPIC_AUTH_TOKEN') else '⚠ 缺失 —— CLI 会报 Not logged in'}")
print(f"  鉴权项 BASE_URL  ：{'就位' if env.get('ANTHROPIC_BASE_URL') else '⚠ 缺失'}")
PY

chmod 600 "$DST"
echo "✓ 权限已设 600；docker/claude-home/ 已就绪"
echo
echo "下一步：docker compose up -d --build"
