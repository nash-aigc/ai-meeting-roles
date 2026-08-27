/**
 * Mock 演示引擎：不依赖任何后端，用剧本驱动全部 UI 状态。
 * 用途：纯前端排版/交互迭代（?mock=1），以及后端未就绪时的联调兜底。
 */
import type { Transport } from './transport'
import type { ClientMessage, ServerMessage } from '../types/protocol'
import { DEFAULT_ROLES } from '../types/protocol'

// 注：用户语音的实时转写由前端 Web Speech API 真实产生（用户真说话真上屏），
// mock 只负责 AI 侧：观点流 / 打断 / 标题 / 归档 / 会后回复。

// ---- 角色静默观点（observe） ----
const OBSERVES: Record<string, string[]> = {
  customer: [
    '价格偏贵，需要和今年的预算重新对齐。',
    '对数据放在哪里有顾虑，安全性还没听到让人信服的答案。',
    '开始心动了，但还在和另一家对比。',
    '担心的其实是部署周期，公司下个月就要用。',
  ],
  boss: [
    '陈述偏产品功能，客户利益点讲得不够。',
    '还没摸清预算就报了价，节奏略急。',
    '优惠抛得太早，谈判空间被自己压缩了。',
    '试探成交的动作不错，继续保持。',
  ],
}

// ---- 角色打断台词（interrupt） ----
const INTERRUPTS: Record<string, string[]> = {
  customer: [
    '等一下，三万八太贵了，隔壁那家报一万五，你先解释一下差在哪。',
    '你先别说价格，我就问一句：我们的会议数据存在哪里，安全吗？',
  ],
  boss: [
    '停一下，客户的预算你问清楚了吗？没摸清预算就报价是大忌。',
    '记住：先问需求，再谈方案，最后才轮到价格。',
  ],
}

interface MockConfig {
  interruptMode: 'noInterrupt' | 'allowInterrupt'
  aiListen: boolean
}

export class MockTransport implements Transport {
  private cb: ((m: ServerMessage) => void) | null = null
  private intervals: number[] = []
  private timeouts: number[] = []
  private meetingId = ''
  private sessionIds: Record<string, string> = {}
  private config: MockConfig = { interruptMode: 'noInterrupt', aiListen: true }
  private startedAbs = 0

  onMessage(cb: (m: ServerMessage) => void): void {
    this.cb = cb
    // 连接即推送角色列表
    this.emit({ type: 'roles.list', roles: DEFAULT_ROLES })
  }

  send(msg: ClientMessage): void {
    switch (msg.type) {
      case 'meeting.start':
        this.startMeeting()
        break
      case 'meeting.stop':
        this.stopMeeting()
        break
      case 'user.text':
        this.replyToUser(msg.text)
        break
      case 'config.update':
        if (msg.patch.interruptMode)
          this.config.interruptMode = msg.patch.interruptMode
        if (msg.patch.aiListen !== undefined) this.config.aiListen = msg.patch.aiListen
        break
      default:
        break // audio.chunk / transcript.edit 在 mock 下忽略
    }
  }

  sendAudioChunk(): void {
    /* mock 不上行 */
  }

  close(): void {
    this.clearAllTimers()
  }

  // ---------- 内部 ----------

  private emit(m: ServerMessage): void {
    // 微任务派发，模拟网络节奏
    queueMicrotask(() => this.cb?.(m))
  }

  private setTimeout(fn: () => void, ms: number): void {
    this.timeouts.push(window.setTimeout(fn, ms))
  }

  private setInterval(fn: () => void, ms: number): void {
    this.intervals.push(window.setInterval(fn, ms))
  }

  private clearAllTimers(): void {
    this.intervals.forEach((t) => clearInterval(t))
    this.timeouts.forEach((t) => clearTimeout(t))
    this.intervals = []
    this.timeouts = []
  }

  private stopLoops(): void {
    this.intervals.forEach((t) => clearInterval(t))
    this.intervals = []
  }

  private startMeeting(): void {
    this.meetingId = `mock-${Date.now().toString(36)}`
    this.startedAbs = Date.now()
    this.sessionIds = Object.fromEntries(
      DEFAULT_ROLES.map((r) => [r.id, `${r.id}-${Math.random().toString(36).slice(2, 10)}`]),
    )
    this.emit({
      type: 'meeting.started',
      meetingId: this.meetingId,
      startedAt: this.startedAbs,
      claudeSessionIds: this.sessionIds,
    })

    // ASR 模型加载 -> 就绪（演示加载提示条）
    this.emit({ type: 'asr.status', status: 'loading' })
    this.setTimeout(() => this.emit({ type: 'asr.status', status: 'ready' }), 1600)

    // 会议开始 ~12s 后 AI 根据已有转写自动生成标题（用户改过则前端不覆盖）
    this.setTimeout(
      () => this.emit({ type: 'meeting.title', title: '智能会议系统客户演示 · 销售演练' }),
      12000,
    )

    // 角色观点：每 9s 轮流
    let roleTurn = 0
    this.setInterval(() => {
      if (!this.config.aiListen) return
      const role = DEFAULT_ROLES[roleTurn++ % DEFAULT_ROLES.length]
      const pool = OBSERVES[role.id]
      this.emit({
        type: 'agent.observe',
        id: `o-${Date.now().toString(36)}`,
        role: role.id,
        text: pool[Math.floor(Math.random() * pool.length)],
        sentiment: 'neutral',
        tsMs: Date.now() - this.startedAbs,
      })
    }, 9000)

    // 打断尝试：每 22s 一次（角色轮流），是否执行取决于模式
    let intTurn = 0
    this.setInterval(() => {
      if (!this.config.aiListen) return
      const role = DEFAULT_ROLES[intTurn++ % DEFAULT_ROLES.length]
      const pool = INTERRUPTS[role.id]
      const text = pool[Math.floor(Math.random() * pool.length)]
      const executed = this.config.interruptMode === 'allowInterrupt'
      this.emit({
        type: 'agent.interrupt',
        id: `i-${Date.now().toString(36)}`,
        role: role.id,
        text,
        urgency: role.id === 'boss' ? 'high' : 'medium',
        executed,
        tsMs: Date.now() - this.startedAbs,
      })
      if (executed) {
        // 模拟 TTS 播放窗口（回声过滤与 UI 联动的演示）
        const windowId = `w-${Date.now().toString(36)}`
        this.emit({ type: 'tts.start', role: role.id, windowId })
        this.setTimeout(() => this.emit({ type: 'tts.end', windowId }), 3500)
      }
    }, 22000)
  }

  private stopMeeting(): void {
    this.stopLoops()
    this.emit({
      type: 'meeting.archived',
      path: `Record/2026-08-26_${this.meetingId.slice(-8)}_客户异议处理演练.m4a`,
      summary: '客户异议处理演练',
      transcriptFile: '2026-08-26_客户异议处理演练.用户.txt',
      combinedFile: '2026-08-26_客户异议处理演练.用户+AI.txt',
    })
    this.emit({ type: 'meeting.state', state: 'closed' })
  }

  private replyToUser(text: string): void {
    this.setTimeout(() => {
      this.emit({ type: 'user.text.echo', text, tsMs: Date.now() - this.startedAbs })
      this.emit({
        type: 'agent.observe',
        id: `o-${Date.now().toString(36)}`,
        role: 'boss',
        text: `收到你的补充："${text.slice(0, 20)}…"。站在我的角度，这里的关键是把异议变成需求确认，你觉得呢？`,
        sentiment: 'neutral',
        tsMs: Date.now() - this.startedAbs,
      })
    }, 1200)
  }
}
