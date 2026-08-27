/**
 * 本地音频引擎：麦克风采集 + 波形数据 + 5 秒分片录制（存档） + 16k PCM 流（ASR 供给）。
 * 波形 levels 为非响应式 Float32Array，供 WaveformCanvas 以 rAF 直读（零响应式开销）。
 */
export interface AudioChunk {
  idx: number
  blob: Blob
  tsAbs: number // 绝对时间戳（与 store.elapsed 对齐用）
  durationMs: number
}

const CHUNK_MS = 5000
const TARGET_RATE = 16000

/** 任意采样率 Float32 -> 16k 16bit PCM（线性抽取） */
function downsample16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === TARGET_RATE) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = floatTo16(input[i])
    return out
  }
  const ratio = inputRate / TARGET_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = floatTo16(input[Math.floor(i * ratio)])
  return out
}

function floatTo16(s: number): number {
  const v = Math.max(-1, Math.min(1, s))
  return v < 0 ? v * 0x8000 : v * 0x7fff
}

class AudioEngine {
  /** 波形能量 0-1，长度 64，录音循环中原地更新 */
  readonly levels = new Float32Array(64)

  /** 已录分片（回放数据源） */
  chunks: AudioChunk[] = []

  /** 分片就绪回调（由 connection 层注入，负责上行） */
  onChunk?: (c: AudioChunk) => void

  /** 16k PCM 消费者（火山 ASR 等实时识别引擎接入点） */
  pcmConsumer?: (pcm: Int16Array) => void

  private stream?: MediaStream
  private ctx?: AudioContext
  private analyser?: AnalyserNode
  private recorder?: MediaRecorder
  private processor?: ScriptProcessorNode
  private zeroGain?: GainNode
  private rafId = 0
  private mime = ''
  private freq = new Uint8Array(128)
  private chunkStartAbs = 0
  private chunkIdx = 0

  isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    )
  }

  async start(): Promise<void> {
    if (!this.isSupported()) throw new Error('当前浏览器不支持麦克风采集')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    // 波形 + PCM 分析链
    this.ctx = new AudioContext()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.6
    source.connect(this.analyser)

    // PCM 采集链：ScriptProcessor -> 零增益（不回放） -> destination
    // 使用更小的缓冲区 1024 减少延迟（4096 → 1024，延迟从 ~100ms → ~23ms 在 44.1kHz）
    this.processor = this.ctx.createScriptProcessor(1024, 1, 1)
    this.zeroGain = this.ctx.createGain()
    this.zeroGain.gain.value = 0
    source.connect(this.processor)
    this.processor.connect(this.zeroGain)
    this.zeroGain.connect(this.ctx.destination)
    this.processor.onaudioprocess = (e) => {
      if (this.ctx?.state !== 'running') return
      const input = e.inputBuffer.getChannelData(0)
      const pcm = downsample16k(input, this.ctx.sampleRate)
      if (pcm.length) this.pcmConsumer?.(pcm)
    }

    // 分片录制链（存档）
    this.mime = this.pickMime()
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mime || undefined,
    })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        const now = Date.now()
        const chunk: AudioChunk = {
          idx: this.chunkIdx++,
          blob: e.data,
          tsAbs: this.chunkStartAbs,
          durationMs: now - this.chunkStartAbs,
        }
        this.chunkStartAbs = now
        this.chunks.push(chunk)
        this.onChunk?.(chunk)
      }
    }
    this.chunkStartAbs = Date.now()
    this.recorder.start(CHUNK_MS) // 每 5s 触发一次 dataavailable
    this.startWaveLoop()
  }

  /** 拼接所有分片为单个 Blob（暂停段已被 MediaRecorder 自动跳过，天然拼接） */
  mergeChunks(): Blob | null {
    if (!this.chunks.length) return null
    const mime = this.chunks[0]?.blob.type || this.mime || 'audio/webm'
    return new Blob(this.chunks.map((c) => c.blob), { type: mime })
  }

  pause(): void {
    this.recorder?.pause()
    // 挂起 AudioContext：波形与 PCM 供给同时冻结（识别端收不到新音频）
    void this.ctx?.suspend()
    cancelAnimationFrame(this.rafId)
    this.levels.fill(0)
  }

  resume(): void {
    void this.ctx?.resume()
    this.recorder?.resume()
    this.chunkStartAbs = Date.now()
    this.startWaveLoop()
  }

  stop(): void {
    this.recorder?.stop()
    cancelAnimationFrame(this.rafId)
    this.levels.fill(0)
    if (this.processor) this.processor.onaudioprocess = null
    this.processor?.disconnect()
    this.zeroGain?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.stream = this.ctx = this.analyser = this.recorder = undefined
    this.processor = this.zeroGain = undefined
  }

  /** 总已录时长（ms，按分片累计） */
  get totalMs(): number {
    return this.chunks.reduce((s, c) => s + c.durationMs, 0)
  }

  private startWaveLoop(): void {
    const loop = () => {
      if (this.analyser) {
        this.analyser.getByteFrequencyData(this.freq)
        // 取前 64 个频点归一化；叠加指数衰减让波形有"回落"质感
        for (let i = 0; i < 64; i++) {
          const v = this.freq[i] / 255
          this.levels[i] = Math.max(v, this.levels[i] * 0.82)
        }
      }
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  private pickMime(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4', // Safari
    ]
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported?.(m)) return m
    }
    return ''
  }
}

export const audioEngine = new AudioEngine()
