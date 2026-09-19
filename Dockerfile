# ai-meeting-roles —— 容器化部署
#
# 设计要点：
#   1) 多阶段：node 阶段构建前端 → python 阶段做运行时，前端产物靠 COPY --from 搬过来
#   2) 运行时镜像必须自带 Node + Claude Code CLI：本项目的「角色大脑」是 CLI 子进程，
#      而宿主机的 macOS 二进制无法在 Linux 容器内运行，只能在镜像里装一份
#   3) 密钥一律不烤进镜像：TTS/ASR 走 compose 的 env_file；
#      Claude 鉴权走宿主机生成的挂载文件 /root/.claude/settings.json（见 docker/prepare-claude-config.sh）

# ─────────────────────────── 阶段 1：构建前端 ───────────────────────────
FROM node:22-bookworm AS web
WORKDIR /build
# 先只拷锁文件，让依赖层可缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# 注意：package.json 的 build = "vue-tsc -b && vite build"，类型检查不过会整条失败。
# 若遇类型错误，改成 `RUN npx vite build`（跳过类型检查，不影响运行时产物）。
RUN npm run build

# ─────────────────────────── 阶段 2：运行时 ───────────────────────────
FROM python:3.12-slim

# curl: NodeSource 源与排障用；gnupg/xz-utils: NodeSource 源需要；ca-certificates: HTTPS
#
# 注意：**没有装 ffmpeg**。ffmpeg 全仓库唯一的代码调用点在 /api/asr/test-audio 内部，
# 而那条路径要先过 macOS 专有的 `say`（容器内已在 main.py:243 提前返回 501），
# 永远走不到 ffmpeg —— 装了纯属白占上百 MB 与数分钟构建时间。
# 若将来把该端点改成走 /api/tts 合成（不再依赖 say），再把 ffmpeg 加回本行即可。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22：用官方 NodeSource 源（架构无关、版本确定，避免手写 arm64/amd64 不同的 tarball 路径）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI —— 角色大脑
RUN npm i -g @anthropic-ai/claude-code && claude --version

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/
COPY roles/  ./roles/

# gateway 的 DIST_DIR = <项目根>/web/dist（main.py 按 __file__ 三级上溯拼出），正好命中
COPY --from=web /build/dist ./web/dist/

# ⚠️ 刻意**不设** CLAUDE_BIN：npm 全局装的 CLI 落在 /usr/bin/claude（→ node_modules 里的 claude.exe），
#    而 agents.py 的兜底链是「环境变量 → shutil.which("claude") → /usr/local/bin/claude」。
#    一旦把 CLAUDE_BIN 写死成不存在的路径，就会**盖掉** which 的正确结果（本机踩过：
#    写 /usr/local/bin/claude 导致角色起不来）。需要覆盖时再显式设这一项。
ENV GATEWAY_HOST=0.0.0.0 \
    CLAUDE_ISOLATED_HOME=/root/.claude-home

EXPOSE 8790

CMD ["python3", "server/gateway/main.py"]
