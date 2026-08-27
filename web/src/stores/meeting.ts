/**
 * 会议状态中枢：状态机 + 全部服务端事件的处理 + 标题/历史/自动保存。
 * 分工：左栏 = 用户录音的实时转写（Web Speech / 后续 FunASR）；
 *       右栏 = AI 生成内容（观点/打断/会后回复），两者互不混入。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  ClientMessage,
  MeetingState,
  RoleInfo,
  ServerMessage,
} from '../types/protocol'
import { DEFAULT_ROLES } from '../types/protocol'
import { getTransport, isMockMode } from '../services/transport'
import type { Transport } from '../services/transport'
import { audioEngine } from '../services/audio'
import { speechEngine } from '../services/speech'
import { ttsSpeaker } from '../services/tts'
import { speechErrorText } from '../services/speech'
import { VolcASR, getVolcConfig } from '../services/volcAsr'
import { loadHistory, upsertHistory, registerAudioUrl, uploadAudioBlob } from '../services/history'
import type { MeetingHistoryEntry } from '../services/history'

export interface TranscriptItem {
  id: string
  tsMs: number
  text: string
  speaker: string // 'user' = 说话人1（用户本人的录音转写）
  edited: boolean
}

export interface AgentEventCard {
  id: string
  role: string
  type: 'observe' | 'reply' | 'interrupt' | 'listen'
  text: string
  urgency?: 'low' | 'medium' | 'high'
  executed: boolean // 仅 interrupt 有意义；其他类型固定为 false
  tsMs: number
}

export interface PlaybackWindow {
  id: string
  role: string
  startMs: number
  endMs: number | null // null = 播放中
}

export interface MeetingConfig {
  interruptMode: 'noInterrupt' | 'allowInterrupt'
  aiListen: boolean
  ttsPlayback: boolean // 全局主开关（各角色还可单独开关）
}

let transport: Transport | null = null
let tickTimer: number | null = null

export const useMeetingStore = defineStore('meeting', () => {
  // ---------- 基础状态 ----------
  const state = ref<MeetingState>('idle')
  const view = ref<'live' | 'history'>('live')
  const meetingId = ref('')
  const meetingTitle = ref('')
  const startedAt = ref<number | null>(null) // Date.now()
  const elapsedMs = ref(0)
  const now = ref(Date.now())
  const mockMode = isMockMode()

  // 用户录音的实时转写（左栏记录板数据源；AI 内容不进这里）
  const transcripts = ref<TranscriptItem[]>([])
  // 正在识别中的临时文本（流式 interim）
  const interimText = ref('')
  // 浏览器语音识别是否可用（不可用时提示等待后端 ASR）
  const speechSupported = ref(speechEngine.supported())
  // 实时识别运行错误（用户可读文案；空 = 正常）
  const speechError = ref('')
  // 连接诊断日志（最近 8 条，页面可见，用于排查断连）
  const connLog = ref<string[]>([])
  // 实时识别引擎：火山豆包流式（云端，默认）/ 浏览器内置（降级）
  const asrEngine = ref<'volc' | 'browser'>(
    (localStorage.getItem('asr-engine') as 'volc' | 'browser' | null) ?? 'volc',
  )
  const volcAsr = new VolcASR()

  // AI 生成内容（右栏数据源）
  const agentEvents = ref<AgentEventCard[]>([])
  const roles = ref<RoleInfo[]>(DEFAULT_ROLES)
  const config = ref<MeetingConfig>({
    interruptMode: 'noInterrupt',
    aiListen: true,
    ttsPlayback: false,
  })

  // 打断警报（当前展示中的）
  const activeInterrupt = ref<AgentEventCard | null>(null)
  // TTS 播放窗口（回声防护可视化 + 时间轴标记）
  const playbackWindows = ref<PlaybackWindow[]>([])
  const ttsActiveRole = computed(() =>
    playbackWindows.value.some((w) => w.endMs === null)
      ? playbackWindows.value.find((w) => w.endMs === null)?.role
      : null,
  )

  const asrStatus = ref<'idle' | 'loading' | 'ready' | 'unloaded' | 'error'>('idle')
  const asrDetail = ref('')
  const archived = ref<{
    summary: string
    path: string
    transcriptFile: string
    combinedFile: string
  } | null>(null)
  const claudeSessionIds = ref<Record<string, string>>({})
  // 各角色实际使用的 Claude 模型名（meeting.started 下发）
  const claudeModels = ref<Record<string, string>>({})
  const connError = ref('')

  // 会议历史（本地持久化）
  const history = ref<MeetingHistoryEntry[]>([])
  // TTS 运行错误（语音合成/播放）
  const ttsError = ref('')
  const ttsCurrentRole = ref('')

  function ttsStart(windowId: string): void {
    playbackWindows.value.push({
      id: windowId,
      role: ttsCurrentRole.value,
      startMs: Date.now() - (startedAt.value ?? Date.now()),
      endMs: null,
    })
  }
  function ttsEnd(windowId: string): void {
    const w = playbackWindows.value.find((x) => x.id === windowId && x.endMs === null)
    if (w) w.endMs = Date.now() - (startedAt.value ?? Date.now())
  }
  function ttsStop(): void {
    ttsSpeaker.stop()
    playbackWindows.value.forEach((w) => {
      if (w.endMs === null) w.endMs = Date.now() - (startedAt.value ?? Date.now())
    })
  }

  /** 语音通道忙：正在播或队列里还有待播（打断提示条收起判断——语音还没轮到播时不收起） */
  function voiceBusy(): boolean {
    return !!ttsActiveRole.value || ttsSpeaker.hasQueuedVoice()
  }

  // 绑定 TTS 模块回调（本地合成播放，与协议事件共用 playbackWindows）
  ttsSpeaker.bind({
    onTtsStart: ttsStart,
    onTtsEnd: ttsEnd,
    onTtsError: (msg: string) => {
      ttsError.value = msg
    },
  })
  // 草稿自动保存时间（UI 显示"已自动保存 HH:MM:SS"）
  const savedAtMs = ref<number | null>(null)

  // ---------- 派生 ----------
  const elapsedText = computed(() => msToClock(elapsedMs.value))
  const startedAtText = computed(() =>
    startedAt.value ? new Date(startedAt.value).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--',
  )
  const roleById = computed(() => {
    const m = new Map<string, RoleInfo>()
    roles.value.forEach((r) => m.set(r.id, r))
    return m
  })

  // ---------- 实时转写（用户录音 -> 文字）----------
  // speechHandlers 供 start / resume 复用
  /** 用户录音的新识别结果 -> 左栏记录板（区分说话人）+ 上行给角色代理 */
  function addTranscript(text: string, speaker: string = 'user'): void {
    if (!text.trim()) return
    transport?.send({ type: 'user.speech', text: text.trim() })
    transcripts.value.push({
      id: `sr-${Date.now().toString(36)}`,
      tsMs: Date.now() - (startedAt.value ?? Date.now()),
      text: text.trim(),
      speaker,
      edited: false,
    })
  }

  // 浏览器内置识别引擎的回调
  const speechHandlers = {
    onFinal: (text: string) => {
      addTranscript(text, 'user')
      interimText.value = ''
    },
    onInterim: (text: string) => {
      interimText.value = text
    },
    onError: (code: string) => {
      speechError.value = speechErrorText(code)
    },
  }

  // 火山豆包流式识别引擎的回调
  const volcHandlers = {
    onFinal: (text: string, speakerId?: number) => {
      // 火山 enable_speaker_info 返回的 speaker_id 从 1 开始（如 "1"→S1 说话人一、S2 说话人二）
      const speaker = typeof speakerId === 'number' ? `S${speakerId}` : 'user'
      addTranscript(text, speaker)
      interimText.value = ''
    },
    onInterim: (text: string) => {
      interimText.value = text
    },
    onError: (msg: string) => {
      speechError.value = `火山 ASR：${msg}`
    },
    onDebug: (msg: string) => {
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      connLog.value.push(`${t} ${msg}`)
      if (connLog.value.length > 8) connLog.value.shift()
    },
  }

  function setAsrEngine(engine: 'volc' | 'browser'): void {
    asrEngine.value = engine
    localStorage.setItem('asr-engine', engine)
  }

  // ---------- 连接 ----------
  function init(): void {
    if (transport) return
    history.value = loadHistory()
    transport = getTransport()
    transport.onMessage(handleServerMessage)
    audioEngine.onChunk = (c) => {
      // 音频分片上行（mock 模式下引擎只在真实录音时产出分片）
      c.blob.arrayBuffer().then((buf) => {
        transport?.sendAudioChunk(c.idx, c.blob.type, buf)
      })
    }
  }

  // ---------- 会议控制 ----------
  async function start(): Promise<void> {
    try {
      connError.value = ''
      speechError.value = ''
      await audioEngine.start()
      // 实时转写引擎：火山豆包流式（云端）为默认；浏览器内置为降级选项
      if (asrEngine.value === 'volc') {
        const cfg = getVolcConfig()
        if (!cfg.ready) {
          speechError.value =
            '火山识别未配置：点右上角「设置 → 实时识别引擎」填写 API Key（保存后重新开始录音生效）'
        } else {
          const ok = volcAsr.start(volcHandlers)
          if (ok) {
            audioEngine.pcmConsumer = (pcm) => volcAsr.feed(pcm)
          } else {
            speechError.value = speechError.value || '火山 ASR 启动失败'
          }
        }
      } else {
        speechSupported.value = speechEngine.start(speechHandlers)
      }
      transport?.send({ type: 'meeting.start' })
    } catch (e) {
      connError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 暂停录音：冻结音频采集（不识别、不计时），火山 ASR 连接保持但收不到音频 */
  function pause(): void {
    if (state.value !== 'recording') return
    audioEngine.pause() // 挂起 AudioContext：PCM 停止供给 + MediaRecorder 暂停（录音分片自动跳过暂停段）
    ttsStop() // 暂停时也停掉 TTS（清空队列），避免念完
    state.value = 'paused'
  }

  /** 恢复录音：继续识别与计时 */
  function resume(): void {
    if (state.value !== 'paused') return
    audioEngine.resume()
    state.value = 'recording'
  }

  /** 结束会议：录音 + 识别 + 会话一次性全部停止（无中间态） */
  function stop(): void {
    speechEngine.stop()
    volcAsr.stop()
    ttsStop()
    audioEngine.pcmConsumer = undefined
    interimText.value = ''
    // 归档音频：拼接全部分片（暂停段已被 MediaRecorder 跳过），注册内存 + 上传后端持久化
    const merged = audioEngine.mergeChunks()
    const mid = meetingId.value || `local-${Date.now()}`
    if (merged) {
      registerAudioUrl(mid, merged)
      uploadAudioBlob(mid, merged)
    }
    audioEngine.stop()
    transport?.send({ type: 'meeting.stop' })
    // 录音结束 = 会议结束：AI 总开关与语音播放总开关自动关闭（开启由用户控制，关闭跟随录音）
    if (config.value.aiListen) {
      config.value.aiListen = false
      transport?.send({ type: 'config.update', patch: { aiListen: false } })
    }
    if (config.value.ttsPlayback) {
      config.value.ttsPlayback = false
      transport?.send({ type: 'config.update', patch: { ttsPlayback: false } })
    }
    // 状态立即切结束（服务端 archived 消息稍后到达补摘要）
    state.value = 'closed'
    if (mockMode) {
      applyState('closed')
    }
  }

  function sendUserText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    transport?.send({ type: 'user.text', text: trimmed })
    // 跨角色信息同步：输入框内容也实时进入所有角色上下文（后端 user.note 处理）
    transport?.send({ type: 'user.note', text: trimmed })
    // 乐观回显（服务端 echo 会去重：以 echo 为准覆盖最后一条同文本）
    transcripts.value.push({
      id: `local-${Date.now().toString(36)}`,
      tsMs: Date.now() - (startedAt.value ?? Date.now()),
      text: trimmed,
      speaker: 'user',
      edited: false,
    })
  }

  function editTranscript(id: string, text: string): void {
    const item = transcripts.value.find((t) => t.id === id)
    if (!item || item.text === text) return
    item.text = text
    item.edited = true
    transport?.send({ type: 'transcript.edit', itemId: id, text })
  }

  // ---------- 标题 / 视图 ----------
  function setMeetingTitle(title: string): void {
    const t = title.trim()
    if (!t || t === meetingTitle.value) return
    meetingTitle.value = t
    transport?.send({ type: 'meeting.rename', title: t })
  }

  function setView(v: 'live' | 'history'): void {
    view.value = v
  }

  // ---------- 配置 ----------
  function updateConfig(
    patch: Partial<MeetingConfig> & {
      roles?: {
        id: string
        enabled?: boolean
        thinkIntervalSec?: number
        ttsEnabled?: boolean
        priority?: number
        interruptEnabled?: boolean // 该角色「可打断/不打扰」开关（2026-08-27 起按角色独立）
      }[]
    },
  ): void {
    Object.assign(config.value, patch)
    // 乐观更新本地角色状态（服务端 roles.list 会再确认一次）
    if (patch.roles) {
      for (const pr of patch.roles) {
        const role = roles.value.find((r) => r.id === pr.id)
        if (!role) continue
        if (typeof pr.enabled === 'boolean') role.enabled = pr.enabled
        if (typeof pr.thinkIntervalSec === 'number') role.thinkIntervalSec = pr.thinkIntervalSec
        if (typeof pr.ttsEnabled === 'boolean') role.ttsEnabled = pr.ttsEnabled
        if (typeof pr.priority === 'number') role.priority = pr.priority
        if (typeof pr.interruptEnabled === 'boolean') role.interruptEnabled = pr.interruptEnabled
      }
    }
    const msg: ClientMessage = {
      type: 'config.update',
      patch: {
        interruptMode: patch.interruptMode,
        aiListen: patch.aiListen,
        ttsPlayback: patch.ttsPlayback,
        roles: patch.roles,
      },
    }
    transport?.send(msg)
  }

  // ---------- 角色管理 ----------
  function createRole(role: {
    id: string
    name: string
    voice: string
    color: string
    description: string
    prompt: string
    thinkIntervalSec?: number
    ttsEnabled?: boolean
    industryTag?: string
  }): void {
    transport?.send({ type: 'role.create', role } as ClientMessage)
  }

  function deleteRole(id: string): void {
    transport?.send({ type: 'role.delete', id } as ClientMessage)
  }

  function updateRolePrompt(id: string, prompt: string): void {
    transport?.send({ type: 'role.update_prompt', id, prompt } as ClientMessage)
  }

  /** 请求读取角色完整提示词（响应在 role.prompt 消息，经 rolePromptCache 通知） */
  function getRolePrompt(id: string): void {
    transport?.send({ type: 'role.get_prompt', id } as ClientMessage)
  }

  // 完整提示词缓存（管理页监听此值填充编辑框）
  const rolePromptCache = ref<Record<string, string>>({})

  function requestRolePresets(): void {
    transport?.send({ type: 'role.presets.list' } as ClientMessage)
  }

  function dismissInterrupt(): void {
    activeInterrupt.value = null
  }

  // ---------- 服务端事件分发 ----------
  function handleServerMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'roles.list':
        roles.value = m.roles
        break
      case 'role.prompt':
        rolePromptCache.value = { ...rolePromptCache.value, [m.id]: m.prompt }
        break
      case 'meeting.state':
        applyState(m.state)
        break
      case 'meeting.started':
        meetingId.value = m.meetingId
        startedAt.value = m.startedAt
        claudeSessionIds.value = m.claudeSessionIds
        applyState('recording')
        startTick()
        break
      case 'claude.models':
        // CLI init 事件回报的实际模型名（会议开始后约 5-8s 异步到达）
        claudeModels.value = m.models
        break
      case 'meeting.title':
        // AI 自动生成标题；用户已手动改过则不覆盖
        if (!titleTouched.value) meetingTitle.value = m.title
        break
      case 'transcript.delta':
        // 后端 ASR 转写结果（M2 接入 FunASR 后启用；当前 dev 阶段由前端 speech 引擎产生）
        transcripts.value.push({
          id: m.itemId,
          tsMs: m.tsMs,
          text: m.text,
          speaker: m.speaker ?? 'user',
          edited: false,
        })
        break
      case 'agent.observe':
        agentEvents.value.push({
          id: m.id,
          role: m.role,
          type: 'observe',
          text: m.text,
          executed: false,
          tsMs: m.tsMs,
        })
        break
      case 'agent.reply': {
        agentEvents.value.push({
          id: m.id,
          role: m.role,
          type: 'reply',
          text: m.text,
          executed: false,
          tsMs: m.tsMs,
        })
        // 可选：语音播放（全局开关 + 角色开关）；进播放队列依次播（2026-08-27 修复叠播）
        if (config.value.ttsPlayback) {
          const role = roleById.value.get(m.role)
          if (role?.ttsEnabled) {
            ttsCurrentRole.value = m.role
            ttsSpeaker.speak(m.text, role.voice)
          }
        }
        break
      }
      case 'agent.listen':
        // 「再听听」：角色本轮选择不开口——只记观点卡片，不语音播报
        agentEvents.value.push({
          id: m.id,
          role: m.role,
          type: 'listen',
          text: m.text,
          executed: false,
          tsMs: m.tsMs,
        })
        break
      case 'agent.interrupt':
        agentEvents.value.push({
          id: m.id,
          role: m.role,
          type: 'interrupt',
          text: m.text,
          urgency: m.urgency,
          executed: m.executed,
          tsMs: m.tsMs,
        })
        if (m.executed) {
          activeInterrupt.value = agentEvents.value.at(-1) ?? null
          // AI 插话必须以语音形式表达（用户要求）；ttsPlayback 开关控制是否出声
          const role = roleById.value.get(m.role)
          if (config.value.ttsPlayback && role?.ttsEnabled) {
            // 2026-08-27 语音队列（用户要求：不掐断不叠播）：打断语音插到队首，
            // 当前正在播的语音播完后立即播打断，再继续队列里的其他语音
            ttsCurrentRole.value = m.role
            ttsSpeaker.speakInterrupt(m.text, role.voice)
          }
        }
        break
      case 'tts.start':
        playbackWindows.value.push({
          id: m.windowId,
          role: m.role,
          startMs: Date.now() - (startedAt.value ?? Date.now()),
          endMs: null,
        })
        break
      case 'tts.end': {
        const w = playbackWindows.value.find((x) => x.id === m.windowId && x.endMs === null)
        if (w) w.endMs = Date.now() - (startedAt.value ?? Date.now())
        break
      }
      case 'asr.status':
        asrStatus.value = m.status
        asrDetail.value = m.detail ?? ''
        break
      case 'meeting.archived':
        archived.value = {
          summary: m.summary,
          path: m.path,
          transcriptFile: m.transcriptFile,
          combinedFile: m.combinedFile,
        }
        if (!meetingTitle.value) meetingTitle.value = m.summary
        persistToHistory()
        break
      case 'user.text.echo': {
        // 服务端确认：把乐观回显的本地条目替换为正式条目
        const localIdx = [...transcripts.value]
          .reverse()
          .findIndex((t) => t.id.startsWith('local-') && t.text === m.text)
        if (localIdx >= 0) {
          const realIdx = transcripts.value.length - 1 - localIdx
          transcripts.value.splice(realIdx, 1)
        }
        transcripts.value.push({
          id: `echo-${Date.now().toString(36)}`,
          tsMs: m.tsMs,
          text: m.text,
          speaker: 'user',
          edited: false,
        })
        break
      }
      case 'error':
        connError.value = m.detail
        break
    }
  }

  // ---------- 历史持久化 ----------
  const titleTouched = ref(false) // 用户手动改过标题后，AI 不再覆盖

  function persistToHistory(): void {
    if (!meetingId.value || !startedAt.value) return
    const entry: MeetingHistoryEntry = {
      id: meetingId.value,
      title: meetingTitle.value || archived.value?.summary || '未命名会议',
      dateMs: startedAt.value,
      durationMs: elapsedMs.value,
      state: state.value,
      model: Object.values(claudeModels.value)[0] || 'claude-cli', // meeting.started 下发的实际模型名
      participants: roles.value.filter((r) => r.enabled).map((r) => r.name),
      claudeSessionIds: { ...claudeSessionIds.value },
      summaryText: buildSummary(),
      transcripts: transcripts.value.map((t) => ({ tsMs: t.tsMs, speaker: t.speaker, text: t.text })),
      agentEvents: agentEvents.value.map((e) => ({
        tsMs: e.tsMs,
        role: e.role,
        type: e.type,
        text: e.text,
        executed: e.executed,
      })),
    }
    history.value = upsertHistory(entry)
  }

  function buildSummary(): string {
    return (
      transcripts.value
        .map((t) => t.text)
        .join(' ')
        .slice(0, 120) || '（无转写内容）'
    )
  }

  // 归档后内容继续变化（会后交流）-> 防抖刷新历史条目
  let historyTimer: number | null = null
  watch(
    () => [transcripts.value.length, meetingTitle.value] as const,
    () => {
      if (!archived.value || state.value !== 'recording') return
      if (historyTimer !== null) clearTimeout(historyTimer)
      historyTimer = window.setTimeout(() => {
        historyTimer = null
        persistToHistory()
      }, 3000)
    },
  )

  // ---------- 草稿自动保存（localStorage）----------
  let draftTimer: number | null = null
  watch(
    () => [transcripts.value.map((t) => `${t.id}:${t.text}`).join('|'), meetingTitle.value] as const,
    () => {
      if (!meetingId.value) return
      if (draftTimer !== null) clearTimeout(draftTimer)
      draftTimer = window.setTimeout(() => {
        draftTimer = null
        try {
          localStorage.setItem(
            `meeting-draft:${meetingId.value}`,
            JSON.stringify({
              title: meetingTitle.value,
              transcripts: transcripts.value,
              savedAt: Date.now(),
            }),
          )
          savedAtMs.value = Date.now()
        } catch {
          /* 存储满等异常静默 */
        }
      }, 800)
    },
  )

  // 用户改标题 -> 标记 touched（AI 自动标题不再覆盖）
  function renameByUser(title: string): void {
    titleTouched.value = true
    setMeetingTitle(title)
  }

  // ---------- 状态机辅助 ----------
  function applyState(s: MeetingState): void {
    state.value = s
    if (s === 'recording') startTick()
    if (s === 'closed') stopTick()
  }

  function startTick(): void {
    if (tickTimer !== null) return
    tickTimer = window.setInterval(() => {
      now.value = Date.now()
      if (startedAt.value !== null && state.value === 'recording') {
        elapsedMs.value = now.value - startedAt.value
      }
    }, 250)
  }

  function stopTick(): void {
    if (tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  // ---------- 工具 ----------
  function msToClock(ms: number): string {
    const s = Math.floor(ms / 1000)
    const hh = String(Math.floor(s / 3600)).padStart(2, '0')
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  }

  return {
    // state
    state,
    view,
    meetingId,
    meetingTitle,
    startedAt,
    startedAtText,
    elapsedMs,
    elapsedText,
    transcripts,
    interimText,
    speechSupported,
    speechError,
    connLog,
    asrEngine,
    setAsrEngine,
    ttsError,
    agentEvents,
    roles,
    config,
    activeInterrupt,
    playbackWindows,
    ttsActiveRole,
    asrStatus,
    asrDetail,
    archived,
    claudeSessionIds,
    claudeModels,
    connError,
    mockMode,
    history,
    savedAtMs,
    // getters
    roleById,
    // actions
    init,
    start,
    pause,
    resume,
    stop,
    sendUserText,
    editTranscript,
    updateConfig,
    dismissInterrupt,
    voiceBusy,
    setMeetingTitle,
    renameByUser,
    setView,
    persistToHistory,
    // role management
    createRole,
    deleteRole,
    updateRolePrompt,
    getRolePrompt,
    rolePromptCache,
    requestRolePresets,
  }
})
