/**
 * 浏览器原生实时语音识别（Web Speech API，流式 interim + final）。
 * 定位：开发期 / 后端 ASR 未接入时的实时转写引擎。
 * 重要：Chrome/Chromium 的识别后端是 Google 语音服务，部分网络环境不可达；
 * Safari 用 Apple 服务。错误必须上报到 UI（不静默吞掉）。
 * 正式版由 gateway 的本地 FunASR 接管（transcript.delta 下发），届时停用本引擎。
 */

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string }) => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

export interface SpeechHandlers {
  onFinal: (text: string) => void
  onInterim: (text: string) => void
  /** 运行时错误（network / not-allowed / audio-capture 等），引擎已停止 */
  onError: (code: string) => void
}

/** 致命错误：停止重试并上报 */
const FATAL_ERRORS = new Set([
  'network',
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
])

export class SpeechEngine {
  private rec: SpeechRecognitionLike | null = null
  private handlers: SpeechHandlers | null = null
  private wantRunning = false

  supported(): boolean {
    if (typeof window === 'undefined') return false
    const w = window as unknown as Record<string, unknown>
    return !!w.SpeechRecognition || !!w.webkitSpeechRecognition
  }

  start(handlers: SpeechHandlers): boolean {
    if (!this.supported()) return false
    this.handlers = handlers
    this.wantRunning = true
    return this.spawn()
  }

  stop(): void {
    this.wantRunning = false
    this.handlers?.onInterim('')
    try {
      this.rec?.stop()
    } catch {
      /* 未启动 */
    }
    this.rec = null
  }

  private spawn(): boolean {
    const w = window as unknown as Record<string, new () => SpeechRecognitionLike>
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return false
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (ev) => {
      let final = ''
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        if (r.isFinal) final += r[0].transcript
        else interim += r[0].transcript
      }
      if (final) this.handlers?.onFinal(final.trim())
      this.handlers?.onInterim(interim)
    }
    rec.onend = () => {
      // Chrome 静默后会自动停，录音仍在进行则重启
      if (this.wantRunning) this.spawn()
    }
    rec.onerror = (ev) => {
      if (FATAL_ERRORS.has(ev.error)) {
        // 致命错误：停止重试，上报 UI（避免无限重启风暴）
        this.wantRunning = false
        this.handlers?.onError(ev.error)
      }
      // no-speech / aborted 属正常现象，忽略
    }
    try {
      rec.start()
    } catch {
      /* already started */
    }
    this.rec = rec
    return true
  }
}

export const speechEngine = new SpeechEngine()

/** 识别错误码 -> 用户可读说明 */
export function speechErrorText(code: string): string {
  switch (code) {
    case 'network':
      return '浏览器语音服务不可达（Chrome 的识别依赖 Google 服务，当前网络无法连接）。可换 Safari 试试，或等待后端本地 ASR。'
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风/语音识别权限被浏览器拒绝，请在地址栏权限设置中允许。'
    case 'audio-capture':
      return '未检测到可用的麦克风设备。'
    case 'language-not-supported':
      return '当前浏览器不支持中文识别。'
    default:
      return `语音识别出错（${code}）。`
  }
}
