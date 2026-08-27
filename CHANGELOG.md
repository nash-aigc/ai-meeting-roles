## v0.17.0

- **版本号**：v0.17.0
- **修改时间**：2026-08-27 18:50
- **添加的功能**：修复「开始录音后 AI 零反馈」致命 bug；默认思考间隔 60s→10s；老板角色改为质疑者人设；左侧顶部标题栏（会议标题可编辑 + Claude 模型/会话 ID 参数显示）；录音暂停/继续；历史详情录音回放
- **简要修改说明**：
  - **致命 bug（A18）**：前端 sendAudioChunk 每 5s 在会议 WS 发二进制音频帧 → gateway `receive_text()` 抛 `KeyError: 'text'` → 会议连接在录音开始 5s 内崩溃 → 所有 user.speech 静默丢失、AI 零反馈。修复双保险：①前端删除会议通道音频上行 ②主循环改 `ws.receive()` 跳过二进制帧
  - **A17**：Claude CLI "Not logged in"——隔离 `CLAUDE_CONFIG_DIR` 时未带鉴权。`agents.py _ensure_isolated_claude_home()` 启动前把用户 settings.json 的鉴权 env（剥 ANTHROPIC_MODEL）写入隔离目录
  - **A19**：claudeModels 空值——CLI 冷启动 5-8s 才发 init。改为 `meeting.started` 立即返回 + `claude.models` 消息异步推送
  - 默认间隔：后端 `DEFAULT_THINK_INTERVAL=10` + 前端 RoleManagerModal 默认值同步
  - `roles/boss/CLAUDE.md` 重写为质疑者人设（无论下属说什么都用质疑视角："凭什么？""证据呢？"）
  - 前端：MeetingState 增加 paused；RecorderPanel 顶部标题栏（标题编辑/状态行/参数折叠区）；RoleManagerModal 间隔默认 10s；协议类型清理（删除 audio.chunk 上行）
  - 端到端回归 PASS：说话→10s 间隔→boss 质疑式 INTERRUPT「口头说的算数吗？报价依据呢？」+ customer 插话 + 二轮对话继续触发
## v0.16.0

- **版本号**：v0.16.0
- **修改时间**：2026-08-26 22:20
- **添加的功能**：M3 角色代理端到端验证通过（不再独立指定模型，直接用本地 claude CLI 模型配置）
- **简要修改说明**：
  - 排障过程：上轮「无限】deepseek-v4-flash」注入报 `API Error: 400 model must be one of: deepseek-v4-flash-free, ...`（该模型名只在 CLI 交互式会话可用，网关转发时被上游拒绝），角色 agent 0 事件
  - 用户纠正：不独立配置任何模型，直接用本地 claude CLI 交互模式现有模型即可
  - 修复：`server/gateway/agents.py` 移除白名单式 env 重建 + `--model 无限】deepseek-v4-flash`；改为**继承宿主环境**（保留 NewAPI 网关/令牌/本地默认模型映射），仅剥掉 `ANTHROPIC_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 避免覆盖本地默认，隔离 `CLAUDE_CONFIG_DIR=/tmp/meeting-claude-home`
  - 实测：`/tmp/test_agents.py`（喂两句销售发言，等 20s）→ customer `OBSERVE` + boss `INTERRUPT` 各 1 个，PASS
  - 沉淀：技能 features/claude-agent.md E6/E9 更新（模型策略改为「不指定，继承宿主 CLI 配置」）
## v0.15.0

- **版本号**：v0.15.0
- **修改时间**：2026-08-26 21:52
- **添加的功能**：修复 gateway /ws/asr 中转代理（B11）+ 后续验证沉淀入技能
- **简要修改说明**：
  - 根因：上次替换 /api/tts 区块时用 index 切片误删了 `_proxy_asr` 函数，/ws/asr handler 运行时 NameError -> 浏览器 WS 1006，转发完全不可用（health 正常掩盖）
  - 修复：重建 `_proxy_asr` 完整实现（域名白名单 + X-Api-Key/altHeaders 鉴权 + 双向透明透传 + 帧日志 + 错误文本帧透传）
  - 实测：真实人声 PCM -> 火山返回「各位好，我是老高，今天给大家介绍一下我们公司的报价」识别通
  - 沉淀（防复发）：
    - features/gateway.md 增 B11 + 「验证方法」节（含直接可跑探测脚本）
    - features/asr-volcengine.md 增 E13 + 验证方法引用固化脚本
    - references/ERROR_INDEX.md 增 B11 索引；BUILD_STEPS.md 增「改完 gateway 的标准验收」
    - 新增 scripts/asr_probe.py（正弦波/真实人声双模式，回归必跑）
    - data/user_params.md 增探测脚本位置；SKILL.md 状态同步
## v0.14.0

- **版本号**：v0.14.0
- **修改时间**：2026-08-26 21:16
- **添加的功能**：**M3 角色代理全链路打通**——AI 角色真实"活"了
- **简要修改说明**：
  - 实测双角色同时响应，人设精准：
    - 客户：`INTERRUPT: 等一下，你这是干嘛的我还没听明白呢，张嘴就先报三万八？`
    - 老板：`INTERRUPT: 停一下。需求没挖一个字就报三万八，这是大忌。先问王总现在开会最大的痛点是什么。`
  - 本轮修复三连（M3 排障沉淀至技能 features/claude-agent.md E1-E8）：
    1. stream-json 必须 --verbose（缺失 CLI 静默退出）
    2. --include-partial-messages 下输出全是 stream_event 增量帧，需从 content_block_delta 提取文本按行结算（assistant 完整消息兜底保留）
    3. reader 子线程调 asyncio.get_event_loop() 拿错 loop 导致事件静默丢失——构造时捕获主 loop 引用，run_coroutine_threadsafe 调度
    4. gateway 继承宿主环境变量污染子进程（ANTHROPIC_MODEL=[1M] 后缀等）——环境白名单清除 ANTHROPIC_*/CLAUDE_* 再注入受控值

## v0.13.0

- **版本号**：v0.13.0
- **修改时间**：2026-08-26 20:30
- **添加的功能**：**M3 Claude 角色代理骨架上线**（真实多角色编排）
- **简要修改说明**：
  - `server/gateway/agents.py`：RoleAgent（每角色长驻 stream-json 子进程，session-id 固定可恢复）+ AgentRunner（编排/定时 flush/打断模式）
  - 角色定义 `roles/customer|boss/`：CLAUDE.md 六段式人设 + settings.json；输出文本标记协议 OBSERVE:/INTERRUPT:/SUMMARY:（正则解析）
  - `/ws/meeting` 接入真实编排：meeting.start 拉起角色进程、user.speech 上行转写增量、config.update 同步打断模式、stop 时收 SUMMARY 作归档摘要
  - 前端 addTranscript 同时上行 user.speech
  - 排障沉淀（技能 claude-agent.md E1-E5）：stream-json 必须 --verbose；session-id 冲突；CLAUDE_CONFIG_DIR 隔离；NewAPI 5h 配额 429 会以 assistant 文本形式出现（已加 API Error 过滤）；stderr 落盘 /tmp/agent-<role>.err
  - 当前卡点：NewAPI 配额 22:00 重置，重置后跑角色端到端验证

## v0.12.0

- **版本号**：v0.12.0
- **修改时间**：2026-08-26 20:15
- **添加的功能**：**TTS 语音链路端到端全通**（充值配额后验证）
- **简要修改说明**：
  - 端到端验证结果：gateway /api/tts 合成（高晴 4.3s/69KB、王新月 5.9s/93KB MP3，128kbps）✅；空文本 400 错误透传 ✅；未知音色回退高晴 ✅
  - 浏览器真实播放验证：ttsSpeaker.speak() 合成+播放，playing=true 持续至音频结束 ✅；无 JS 错误 ✅
  - mock 打断场景：可打断模式 22s 红色警报出现 + 警报条显示「语音播放中」✅
  - 王新月/高晴两个角色音色均验证；播放窗口自动登记（回声过滤+时间轴红块）
  - 注意：B10（dashscope SDK 线程时序）未复现，gateway 内 asyncio.to_thread 直调稳定

## v0.11.1

- **版本号**：v0.11.1
- **修改时间**：2026-08-26 20:02
- **添加的功能**：TTS 合成切换到 MaaS 专属端点（voice_chat.py 同款实测参数）
- **简要修改说明**：
  - 从 skill 的 voice_chat.py 找到完整可用参数：MaaS key / HTTP+WS 端点 / cosyvoice-v3.5-plus / 两个角色的完整 voice_id（高晴、王新月）
  - gateway /api/tts 重写为 dashscope SDK 直调（asyncio.to_thread 内设置全局 URL）；此前经 tts.py 公共端点报 418（音色-模型绑定问题）
  - SDK 调用已通到鉴权层，当前卡点明确：**MaaS 免费额度耗尽**（AllocationQuota.FreeTierOnly），等用户开启付费后即通
  - 参数与 3 个新坑（418/配额/SDK 线程时序）已沉淀技能 data/user_params.md 与 ERROR_INDEX B8-B10

## v0.11.0

- **版本号**：v0.11.0
- **修改时间**：2026-08-26 19:35
- **添加的功能**：
  - **状态机简化为两态**：idle -> recording -> closed。点击结束 = 录音/识别/AI 全部同步立即停止并归档，无暂停、无会后持续监听（用户需求修正）
  - **AI 语音表达链路**（用户要求 AI 表达必须用语音）：agent.interrupt 执行时 -> 按角色音色（高晴/王新月）调用 gateway `/api/tts`（CosyVoice cosyvoice-v3-flash 速度优先）-> 浏览器播放 + 播放窗口登记（回声过滤/时间轴红块）
- **简要修改说明**：
  - store：删 pause/resume/closeMeeting/postTalk；stop() 一键全停（ASR+录音+TTS）；ttsSpeaker 集成与 ttsError 透传
  - 组件：RecorderPanel 仅 开始/结束/新建 三按钮；PostTalkBar 简化为状态提示
  - gateway 新增 POST /api/tts（复用 cosyvoice-tts skill 脚本合成，密钥走 DASHSCOPE_API_KEY 环境变量，缺 key 返回 503 明确提示）
  - 验证：Playwright 假麦克风实测 开始->"会议进行中"->结束->"已结束"+新建按钮出现，无 JS 错误
  - **待用户提供 DASHSCOPE_API_KEY**（阿里云百炼）后 TTS 即通；key 填入技能 data/user_params.md

## v0.10.0

- **版本号**：v0.10.0
- **修改时间**：2026-08-26 19:10
- **添加的功能**：创建 `meeting_skills` 独立技能，项目知识全部沉淀到技能文件（不依赖对话）
- **简要修改说明**：
  - 技能位置：`/Users/mjm/Documents/SuperClaw/Skills/app/meeting_skills/`（SKILL.md + data/user_params.md + references/{GOALS,BUILD_STEPS,ERROR_INDEX} + features/ 8 个功能文件 + scripts/autocommit.sh）
  - 数据资产入库：git init + .gitignore（node_modules/dist/.env/音频/数据库排除）；autocommit.sh 测试通过（取 CHANGELOG 最新条目作提交信息，remote 配置后自动 push）
  - 修复 CHANGELOG 排序（v0.7-v0.9 曾被追加到文件末尾，已重排为严格倒序）
  - 规则：用户确认成功时执行 autocommit.sh；新错误解决后沉淀进 features/*.md 并更新 ERROR_INDEX
## v0.9.0

- **版本号**：v0.9.0
- **修改时间**：2026-08-26 19:00
- **添加的功能**：**浏览器端实时转写全链路打通**（真实前端代码 + Playwright 无头浏览器 + 真实人声验证通过）
- **简要修改说明**：
  - 排障全程共连环 7 个 bug，最后两个是关键：
    1. **PCM 截断**：`Uint8Array.set(Int16Array)` 逐元素赋值把 16bit 样本截成 8bit，音频全毁（火山 duration 正常但 VAD 判无语音，text 永远空）。修复：`new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)` 字节视图零拷贝
    2. **局部变量遮蔽**：`onmessage` 里检查的是局部 `proxyReady`（永远 false），所有火山响应帧被静默丢弃。修复：统一用实例属性 `this.proxyReady`
    3. 附带修复：gzip 发送加串行链保序（异步压缩并发会帧乱序）；`CompressionStream writer.write()` 无消费者时死锁（改用 pipeThrough 标准写法）
  - 验证：Playwright 无头浏览器加载真实 volcAsr.ts 模块，喂真实人声 PCM，流式输出 `今天 → 今天天气 → … → 今天天气怎么样？我们一起去公园散步吧` ✅
  - 排障方法论沉淀：gateway 帧级日志（b->v/v->b + 响应体）是定位利器；Python E2E 与浏览器 E2E 差异对比逐层缩小
## v0.8.5

- **版本号**：v0.8.5
- **修改时间**：2026-08-26 17:45
- **添加的功能**：断连问题诊断 instrumentation（页面可见的诊断日志）
- **简要修改说明**：
  - 排查进展：gateway 链路经 Python 模拟「前端同款帧序列」完全正常（connected → full request 响应 → 音频响应）；无头 Chrome 内直接 new WebSocket('/ws/asr') 也 113ms 收到 connected —— 服务端链路无问题
  - code=1000 是浏览器侧主动关闭（1000=normal close），但代码中仅 stop()/清理旧连接会主动关；用户未点结束却出现 → 需要定位前端实际执行路径
  - 新增诊断：volcAsr 关键生命周期（连接 URL / gateway→火山已连上发首帧 / WS 关闭 code+wasClean+manualStop）经 onDebug 回调进 store.connLog，记录板警告条下方显示最近 8 条
  - gateway 加帧级日志（b->v/v->b 字节数+帧头）
  - 下一步：用户刷新后再点开始，诊断日志会精确定位断连发生在哪一步

## v0.8.4

- **版本号**：v0.8.4
- **修改时间**：2026-08-26 17:28
- **添加的功能**：修复用户残留错误 Key 导致的断连；gateway 错误信息完整透传
- **简要修改说明**：
  - 用户浏览器 localStorage 里仍存着填反的旧值（token=数字），且 appid 栏为空 → 之前的交换条件（需同时是 UUID）不命中。自动纠错改为：token 是纯数字即清空回落内置默认，数字串移入 appid（若为空）
  - gateway：`async with volc_ws`（websockets 13 的 ClientConnection 只支持 async 上下文）；回退失败时把 RuntimeError 的完整中文提示透传给前端（此前只显示异常类名）
  - 回归验证：正确 key → connected ✅；错误 key + 回退 → 明确报错文案 ✅
  - 注意：**用户必须刷新页面**才能加载 v0.8.3+ 的前端纠错代码

## v0.8.3

- **版本号**：v0.8.3
- **修改时间**：2026-08-26 17:22
- **添加的功能**：火山 ASR 凭据**内置默认 + 用户可覆盖**
  - API Key / App ID 已内置为默认值，开箱即用，无需手动配置
  - 设置面板显示当前状态徽标（内置默认 / 自定义 Key），自定义后可一键「恢复默认」
  - 自动纠错：检测到两个栏位填反（token=纯数字、appid=UUID）时自动交换并回写
- **简要修改说明**：
  - `volcAsr.ts`：新增 `BUILTIN_VOLC` 常量；`getVolcConfig()` localStorage 为空时回落内置；填反自动交换
  - 设置面板：状态徽标区分「内置默认 / 自定义 Key」+ 恢复默认按钮 + 填反警告保留
  - 与内置值相同的填写会被清除出 localStorage（跟随内置，便于以后换 key）

## v0.8.2

- **版本号**：v0.8.2
- **修改时间**：2026-08-26 17:15
- **添加的功能**：修复「Invalid X-Api-Key」——用户实测报错的真正根因
- **简要修改说明**：
  - **根因确认**（gateway 日志 + 复现）：用户把 App ID（**********（已打码））填到了 API Key 栏。用 appid 当 key 请求火山，精确复现 `volc handshake failed: Invalid X-Api-Key`
  - gateway 增加鉴权自动回退：X-Api-Key 失败且带 altHeaders（App ID+旧版 Token）时，自动换旧版双头 + 1.0 resource id（volc.bigasr.sauc.duration）重试；仍失败则返回明确中文提示（提示检查两个栏位是否填反）
  - 设置面板：API Key 栏改为明文显示并标注 UUID 格式说明；增加「填反检测」——App ID 非纯数字 / API Key 是纯数字时显示琥珀色警告
  - 正确填法：**API Key = ********-****-****-****-************（已打码）（UUID），App ID = **********（已打码）（数字）或留空**

## v0.8.1

- **版本号**：v0.8.1
- **修改时间**：2026-08-26 17:05
- **添加的功能**：修复用户实测「火山 ASR 连接断开」问题
- **简要修改说明**：
  - 根因 1（gateway 崩溃）：`main.py` 改用 `websockets.asyncio.client.connect` 后，异常分支还引用旧的 `websockets.exceptions.InvalidStatus` → NameError，握手失败时 gateway 直接崩掉连接。已改为顶层 import `InvalidStatus` 并重启
  - 根因 2（前端残留旧错误）：HMR 多次热更后模块单例重建、旧 WebSocket 未清理；且 onclose 不透传 code/reason，用户只看到笼统的「连接断开」
  - 修复：gateway 异常分支修正并重启；前端 start() 先清理旧连接、onclose 透传 close code/reason、未配置提示文案更新；store 中 volcAsr.start 返回值校验
  - 验证：经 orca 反代(51839)→Vite→gateway→火山 完整路径 connect + full request 收到火山正常响应帧 ✅；E2E 音频识别 ✅

## v0.8.0

- **版本号**：v0.8.0
- **修改时间**：2026-08-26 16:55
- **添加的功能**：**ASR 中转网关（gateway）上线，端到端链路全通**
  - `server/gateway/main.py`：FastAPI + uvicorn 网关，`/ws/asr` WebSocket 中转代理
  - 中转协议：浏览器发 connect 帧（endpoint+鉴权头）→ gateway 带头连火山 → 双向帧透明转发；域名白名单 + X-Api-Key 强制校验
  - `/api/health` 健康检查；`/ws/meeting` 骨架占位（roles.list/meeting.started/archived 回应，供前端联调）；生产模式静态托管 web/dist
- **简要修改说明**：
  - 关键修复：websockets 13.x 顶层 `connect()` 是 legacy 版不认 `additional_headers`，改用 `websockets.asyncio.client.connect`
  - E2E 实测两路全通：直连 gateway(8787) ✅ 与 经 Vite 代理(5173→8787) ✅，流式逐字返回 ~0.2s 一包，最终识别「今天天气怎么样？我们一起去公园散步吧！」100% 正确
  - 启动命令：`cd server/gateway && /opt/anaconda3/bin/python3 main.py`（端口 8787，仅绑定本机）
  - 用户现在可在浏览器实测真实录音转写（设置面板填 API Key → 开始录音说话）

## v0.7.0

- **版本号**：v0.7.0
- **修改时间**：2026-08-26 16:45
- **添加的功能**：
  - **火山豆包流式 ASR 官方协议打通（Python 原型实测识别成功）**：「今天天气怎么样？我们一起去公园散步吧！」100% 正确识别，流式逐字返回
  - 前端 `volcAsr.ts` 按实测确认的协议完全重写（二进制帧编解码 + gzip + 中转模式设计）
- **简要修改说明**：
  - **排障过程**：用户报 code=1006 连接断开 → 系统性排查（curl 探测端点 / 抓官方 Android Demo 源码 / 从文档站 API 提取完整协议文档）
  - **实测确认的关键事实**（与此前假设的差异）：
    - 端点为 `/api/v3/sauc/bigmodel`（双向流式），不是 `/api/v3/sauc/bigasr`
    - 鉴权用 header `X-Api-Key`（新版控制台）+ `X-Api-Resource-Id`，不是 URL query
    - 用户 key 绑定的是 **2.0 时长版 `volc.seedasr.sauc.duration`**（1.0 的 bigasr 返回 not granted）
    - 二进制帧 = 4B头 + [flags&1 时 4B seq] + 4B size + gzip payload；**负包(最后一包) flags=0x2 且不带 seq 字段**（带 seq 会报 autoAssignedSequence mismatch）
    - 首帧 full request JSON: `{user, audio{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1}, request{model_name:'bigmodel',enable_punc,show_utterances,enable_itn}}`
    - 响应 type=9：`result.text` 为全量累计；`utterances[].definite=true` 为确认分句
  - **架构约束发现**：浏览器 WebSocket 无法自定义握手 header → 浏览器直连火山不可行，改为经本机 gateway `/ws/asr` 中转（gateway 用服务端 WS 库带鉴权头连火山）；前端 volcAsr.ts 已实现中转协议
  - 设置面板 cluster 字段改为 endpoint；类型检查全绿
  - **下一步**：写 server/gateway asr_proxy.py 中转层后即可端到端联调

## v0.6.0

- **版本号**：v0.6.0
- **修改时间**：2026-08-26 15:05
- **添加的功能**：
  - 用户录音的实时识别引擎切换为**火山引擎「豆包流式语音识别 2.0」**（云端，时长版计费 ~1 元/小时），替代本地 FunASR 方案
  - 设置面板新增「实时识别引擎」区块：引擎切换（火山 / 浏览器内置降级）+ App ID / API Key / Resource ID / Cluster 配置
- **简要修改说明**：
  - 新增 `web/src/services/volcAsr.ts`：Seed/BigAsr 协议 WebSocket 客户端（首帧 JSON 配置 + 二进制 PCM 帧 + 结束帧；utterances 分句 definite -> final，无 utterances 时全量 text diff 兜底）
  - `web/src/services/audio.ts` 新增 PCM 采集链：ScriptProcessor -> 16kHz/16bit 降采样 -> `pcmConsumer` 注入（零增益防回声）；暂停时 `AudioContext.suspend()` 冻结识别供给
  - 密钥存 localStorage（设置面板填写），不进代码库；后端 gateway 就绪后迁服务端 .env
  - 架构文档新增 §11 记录 ASR 方案变更；本地 FunASR 降级为会后整段重转写兜底
  - 待实测：火山协议参数（错误均已显示在 UI，实测报错按提示调整）

## v0.5.0

- **版本号**：v0.5.0
- **修改时间**：2026-08-26 14:52
- **添加的功能**：实时识别引擎错误**可见化**（浏览器识别失败不再静默）
- **简要修改说明**：
  - `speech.ts` 增加致命错误集合（network / not-allowed / audio-capture 等），触发后停止重试并上报，避免无限重启风暴
  - 新增 `speechErrorText()` 错误码 -> 中文说明
  - 记录板顶部琥珀警告条显示识别不可用原因；波形卡状态区显示识别引擎真实状态（识别中 / 聆听中 / 引擎异常 / 不支持）
  - 背景：Chrome 系浏览器 Web Speech API 依赖 Google 服务，当前网络不可达，导致"录音了但没有实时显示"

## v0.4.0

- **版本号**：v0.4.0
- **修改时间**：2026-08-26 14:40
- **添加的功能**：
  - **左右分工重构**：左栏 = 录音区（用户语音实时转写），右栏 = AI 生成内容（观点 / 打断 / 会后回复），数据严格分离
  - 接入浏览器 Web Speech API 流式实时转写（interim 灰色「识别中」行 + final 正式条目）
- **简要修改说明**：
  - 新增 `web/src/services/speech.ts`（连续识别 + 自动重启）
  - store 新增 `interimText`；AI 插话文字只进右栏 agentEvents，不再混入左栏转写
  - 移除右栏 TranscriptPanel 引用，AgentFeed 占满右栏；mock 不再推假剧本句子（用户真话由识别引擎真实产生），mock 只负责 AI 侧

## v0.3.0

- **版本号**：v0.3.0
- **修改时间**：2026-08-26 14:28
- **添加的功能**：
  - **实时记录板**（左栏最底部）：最近 2 条预览 + 「展开全部」浮层；条目可编辑；标题 AI 自动生成（约 12s）+ 双击修改；编辑与标题自动保存 localStorage；说话人标注（说话人1 / 角色名）
  - **会议历史**（右侧视图）：左栏入口按钮；每场 3 行卡片（① 标题+日期+时长+状态 ② 内容摘要 ③ 参与者+AI 模型+Claude 会话 ID）；点击展开完整记录；归档自动入库 + 会后追加防抖刷新；首次 3 条演示种子数据
- **简要修改说明**：
  - 新增组件 TranscriptPad.vue、HistoryPanel.vue；新增 services/history.ts（localStorage 持久化 `meeting-history:v1`，上限 50 场）
  - 协议新增 `meeting.title`（下行）/ `meeting.rename`（上行）；store 新增 view 视图切换、草稿防抖自动保存（800ms）

## v0.2.0

- **版本号**：v0.2.0
- **修改时间**：2026-08-26 14:15
- **添加的功能**：**前端骨架**（web/，Vue 3 + TS + Vite 7 + Pinia + Tailwind v4）与**前后端分离热更新开发工作流**
  - 左栏：64 �实时声波（rAF 直读零开销）· 计时 · 录音控制 · 时间轴回放（分片刻度 + AI 插话红色窗口标记 + 拖动定位）
  - 右栏：转写稿（滚动 + 双击编辑）· 角色观点卡片流 · 红色打断警报（脉冲 + TTS 播放指示 + 自动收起）
  - 顶栏：不打扰/可打断 · AI 持续监听 · 语音播放 · 推送周期开关；底栏会后交流（文字 + 语音作答）；设置模态（角色管理）
  - **mock 模式（?mock=1）**：零后端演示全部 UI 状态（剧本驱动观点/打断/警报/归档/会后回复）
- **简要修改说明**：
  - 关键依据：macOS Docker 卷挂载不传播 inotify，前端 Vite dev server 必须宿主机跑（HMR <1s，Docker 不动）；/api、/ws 代理到 gateway :8787
  - `types/protocol.ts` 定义完整 WS 消息协议（与架构文档 §5 对齐）；vue-tsc 类型检查与 build 全绿（gzip ~52KB）
  - 架构文档新增 §10 开发工作流与 M1 Max / 64GB 适配（全 ARM64 镜像，ASR 卸载放宽 30min）
  - pnpm 11 注意：allowBuilds 配置写 pnpm-workspace.yaml（esbuild: true）

## v0.1.0

- **版本号**：v0.1.0
- **修改时间**：2026-08-26 13:55
- **添加的功能**：产品需求文档（PRD）与整体架构设计
  - `docs/01-PRD-需求文档.md`：8 大功能模块（录音工作台 / 实时转写 / 多角色代理 / 持续监听反馈 / 打断机制 / 结束归档 / 浏览器交互 / Claude 端管理）+ 非功能需求 + 角色规格（客户-高晴 / 老板-王新月）+ 边界与待确认问题
  - `docs/02-架构设计.md`：三容器架构（gateway / agent-runner / asr）· Claude CLI stream-json 双向长驻进程方案（本机已验证 CLI 2.1.235）· NewAPI 网关接入 · 角色即 Claude Code 项目目录 · WS 协议 · 内存预算 · 里程碑 M1-M4
  - `.env.example`：密钥模板（真实密钥只进 .env）
- **简要修改说明**：立项。核心可行性已全部实测验证（CLI stream-json、CosyVoice 音色与打断、FunASR）；密钥不进代码库与文档


