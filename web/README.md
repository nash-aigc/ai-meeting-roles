# web — AI 会议监听助手前端

Vue 3 + TypeScript + Vite 7 + Pinia + Tailwind CSS v4。

## 开发（排版热更新，Docker 不用动）

```bash
cd web
pnpm install        # 或 npm install
pnpm dev            # http://localhost:5173
```

- **mock 模式**：`http://localhost:5173/?mock=1` —— 不需要任何后端，剧本驱动全部 UI 状态（转写流、角色观点、打断警报、TTS 播放窗口、会后交流）。**纯调排版用这个。**
- **联调模式**：直接开 `http://localhost:5173`，`/api` 与 `/ws` 自动代理到 Docker gateway（`127.0.0.1:8787`）。
- 修改任何 `.vue` / `.ts` 文件，浏览器 <1s 热更新，**无需重启任何服务**。

> 为什么 dev server 不进 Docker：macOS Docker 卷挂载不传播 inotify 文件变更事件，Vite HMR 在容器内不可靠；前端必须宿主机直跑（详见 `docs/02-架构设计.md` §10）。

## 生产构建

```bash
pnpm build    # 产出 dist/，由 gateway 容器静态托管
```

## 结构

```
src/
├── types/protocol.ts     # WebSocket 消息协议（与架构文档 §5 对齐，前后端共同遵守）
├── services/
│   ├── audio.ts          # 麦克风：5s 分片录制 + 波形数据（本地回放数据源）
│   ├── transport.ts      # WebSocket 传输（Vite 代理进 Docker）
│   └── mock.ts           # Mock 演示引擎（?mock=1）
├── stores/meeting.ts     # 会议状态机 + 全部服务端事件处理
├── composables/roleColor.ts  # 角色配色映射（Tailwind 类名需显式列出）
└── components/
    ├── TopBar.vue            # 顶栏：打断模式 / AI 监听 / TTS 开关
    ├── RecorderPanel.vue     # 左栏：波形 · 计时 · 录音控制
    ├── WaveformCanvas.vue    # 64 柱实时声波（rAF 直读，零响应式开销）
    ├── TimelinePlayer.vue    # 时间轴回放（分片 + AI 播放窗口标记）
    ├── TranscriptPanel.vue   # 转写稿（滚动 + 双击编辑）
    ├── AgentFeed.vue         # 角色观点卡片流
    ├── InterruptAlert.vue    # 红色警报条
    ├── PostTalkBar.vue       # 会后交流（文字/语音作答）
    └── SettingsModal.vue     # 角色与会话设置
```

## 协议变更流程

改 `src/types/protocol.ts` 必须同步：`docs/02-架构设计.md` §5 + 后端 gateway。
