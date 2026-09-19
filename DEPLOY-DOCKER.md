# Docker 部署说明

> 2026-09-20 新增。本文件描述**如何把这套系统跑在容器里**，以及容器化时改了哪几处源码、为什么。
> 原有的「宿主机直跑」方式仍然可用，未受影响（见 `README.md`）。

## 一、三步跑起来

```bash
# 1) 生成 Claude 鉴权挂载文件（必须，只跑一次；改了宿主 ~/.claude 配置后重跑）
bash docker/prepare-claude-config.sh

# 2) 构建并启动
docker compose up -d --build

# 3) 打开
open http://127.0.0.1:8790
```

常用操作：

| 目的 | 命令 |
|---|---|
| 看日志 | `docker compose logs -f meeting` |
| 进容器 | `docker compose exec meeting bash` |
| 停止 | `docker compose down` |
| **改完 `.env` 后生效** | `docker compose up -d`（必须重建容器，见下） |
| 重新构建（改了源码） | `docker compose up -d --build` |

> ⚠️ **改动 `.env` 后光 `restart` 不够可靠**：`main.py` 在 **import 时**就把配置读进模块常量
> （`_load_dotenv()` + 模块级 `os.getenv`），所以要用 `up -d` 重建容器。

## 二、鉴权是怎么进容器的

角色大脑（Claude Code CLI 子进程）的鉴权链路：

```
宿主机 ~/.claude/settings.json 的 env 段
        │  docker/prepare-claude-config.sh 复制 + 改写主机名
        ▼
docker/claude-settings.json  ──(只读挂载)──▶  容器 /root/.claude/settings.json
        │  agents.py:_ensure_isolated_claude_home()
        ▼
容器 /root/.claude-home/settings.json（剥掉 ANTHROPIC_MODEL，强制 deepseek-v4-flash）
        │  CLI 以 CLAUDE_CONFIG_DIR 指向它
        ▼
角色子进程获得鉴权
```

**为什么必须改写主机名**：宿主机 `ANTHROPIC_BASE_URL` 指向 `localhost:3000`（new-api），
而容器内的 `localhost` 是容器自己。脚本把它改写为 `host.docker.internal:3000`
（由 compose 的 `extra_hosts` 提供解析）。

**密钥安全**：真实 token 只存在于 `docker/claude-settings.json` 一个文件里 ——
已 gitignore、权限 600、`.dockerignore` 排除（不进构建上下文、不进镜像层）。
TTS / 火山 ASR 的密钥则通过 compose 的 `env_file: .env` 注入进程环境，同样不烤进镜像。

> 备选接入方式：也可让本容器加入 new-api 所在的 docker 网络，把地址写成 `http://new-api:3000`。
> 当前用 `host.docker.internal` 是因为它不与 new-api 的网络名耦合。

## 三、容器化时改动的源码（4 处，全部向后兼容）

| 文件:行 | 改动 | 原因 |
|---|---|---|
| `server/gateway/agents.py:27` | `CLAUDE_BIN` 改为「环境变量 → `shutil.which("claude")` → `/usr/local/bin/claude`」 | 原先硬编码 `/Users/mjm/.local/bin/claude`，该路径早已不存在 → **本机直跑也起不来角色**，此改动顺带修好 |
| `server/gateway/agents.py:33` | `CLAUDE_ISOLATED_HOME` 可被环境变量覆盖（默认值不变） | 容器内指向挂载卷，使 onboarding 态跨重启保留、出问题可在宿主机排查 |
| `server/gateway/main.py:953` | 绑定地址改为 `GATEWAY_HOST`（默认仍是 `127.0.0.1`） | 容器内绑回环 → 端口映射访问不到；默认值不变故本机行为逐字不变 |
| `server/gateway/main.py:243` | `/api/asr/test-audio` 先检测 `say`，缺失则返回 **501 + 中文提示** | `say` 是 macOS 专有；原实现会落到 500 + 晦涩 stderr |

新增文件：`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`requirements.txt`、
`docker/prepare-claude-config.sh`。

## 四、容器里的已知功能差异与告警

| 功能 / 现象 | 容器内表现 | 说明 |
|---|---|---|
| `/api/asr/test-audio` | **501** | 依赖 macOS `say`。要测 ASR 请直接在界面上录音，或改用 `/api/tts` |
| 历史详情「打开Claude」按钮 | 提示「未安装 orca CLI」 | 该功能要调宿主机的 Orca 终端 CLI 开新标签页，容器里没有；**不影响开会主流程** |
| 会议录音 / 转写 / 角色发言 / TTS | **全部正常** | 麦克风与音频播放在浏览器端，gateway 只做转发与合成 |
| 会议记录 | 落宿主机 `./Record/` | bind mount，可在访达里直接查看 |

### 两条不会致故障、但会出现在日志里的告警（**不必处理**）

1. **每个角色子进程的 `/tmp/agent-*.err` 里都有一行**
   ```
   [claude-code:unrecognized_model] {"model":"deepseek-v4-flash","query_source":"sdk"}
   ```
   原因：`agents.py` 强制把模型名设成 `deepseek-v4-flash`（`agents.py:46-50`，为绕开网关的
   `unrecognized_model`），而 CLI 的模型目录里没有这个名字，于是它**按 200k 上下文估算**并提示一句。
   **这不是容器引入的**——宿主机直跑同样会出现（同一条代码路径）。
   若想让 CLI 知道真实窗口，可给它加 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，或按提示在模型名后加 `[1m]`。

2. **`scripts/e2e_agent_probe.py` 报 `TypeError: ... extra_headers`**
   该脚本用的是 websockets ≤13 的旧参数名，而本镜像装的是 17.1（≥14 改名为
   `additional_headers`）。**服务端本身用的是新 API，不受影响**；只是这个随仓库附带的
   开发脚本陈旧了。要跑它，先把 `extra_headers=` 改成 `additional_headers=`，
   并把里面写死的端口 `8787` 改成 `8790`。

## 五、网络暴露

默认只绑宿主机回环 `127.0.0.1:8790`。**本应用没有任何登录鉴权** —— 任何能访问到它的人
都能开会、并触发 Claude CLI 消耗你的网关额度。确需手机/局域网访问时，把
`docker-compose.yml` 的 `ports` 改成 `"8790:8790"`，并自行确认网络环境可信。

## 六、排障

```bash
# 容器起不来
docker compose logs --tail=100 meeting

# 角色不发言 / CLI 没被拉起 → 看角色子进程自己的 stderr
docker compose exec meeting sh -c 'cat /tmp/agent-*.err'

# 鉴权是否就位（只打印键名与主机名，不打印 token）
docker compose exec meeting python3 -c \
  "import json;d=json.load(open('/root/.claude-home/settings.json'));print(sorted(d['env']));print(d['env']['ANTHROPIC_BASE_URL'])"

# 宿主机 new-api 是否可达（容器视角）
docker compose exec meeting curl -s -o /dev/null -w '%{http_code}\n' http://host.docker.internal:3000
```

| 现象 | 可能原因 |
|---|---|
| 浏览器打不开 8790 | 容器没起 / 端口被占（`lsof -nP -iTCP:8790 -sTCP:LISTEN`） |
| 页面能开但角色不说话 | `CLAUDE_ISOLATED_HOME/settings.json` 缺鉴权，或 `host.docker.internal:3000` 不通 |
| 报 `Not logged in` | `prepare-claude-config.sh` 没跑，或宿主机 `~/.claude/settings.json` 的 `env` 里没有 `ANTHROPIC_AUTH_TOKEN` |
| 改了 `.env` 没生效 | 需要 `docker compose up -d` 重建容器 |

## 七、回滚到宿主机直跑

```bash
docker compose down
git checkout -- server/gateway/agents.py server/gateway/main.py   # 撤销 4 处补丁
```

新增的 Docker 文件可直接删除，不影响原有运行方式。
