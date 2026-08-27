/**
 * 火山引擎「豆包流式语音识别 2.0」客户端（官方 v3/sauc/bigmodel 二进制协议，已实测打通）。
 *
 * 实测确认（2026-08-26 Python 原型 100% 识别成功）：
 * - 端点: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel（双向流式）
 * - 鉴权（新版控制台）: header X-Api-Key=<API Key> + X-Api-Resource-Id
 *   （旧版: X-Api-App-Key=<AppID> + X-Api-Access-Key=<Token>）
 * - resource id: volc.seedasr.sauc.duration = 2.0 时长版（~1元/小时）
 * - 帧: [4B头][flags&1 ? 4B seq : 无][4B size][gzip payload]
 *   音频帧 flags=0x1 带正 seq；负包(最后一包) flags=0x2 且【不带 seq 字段】
 * - full request JSON: {user, audio{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1},
 *   request{model_name:'bigmodel', enable_punc, show_utterances, enable_itn}}
 * - 响应 type=9: {result:{text(全量累计), utterances[{text,definite}]}}
 *
 * ⚠ 浏览器 WebSocket 无法自定义握手 header → 必须经本机 gateway 中转
 *   （/ws/asr：gateway 用服务端 WS 库带鉴权头连火山，浏览器侧透明转发）。
 *   本文件实现「中转协议」，gateway 端见 server/gateway/asr_proxy.py（待建）。
 */

export interface VolcConfig {
  appid: string
  token: string
  resourceId: string
  endpoint: string
  ready: boolean
  /** true = 用户自定义了 Key；false = 使用内置默认 */
  hasCustomToken?: boolean
}

const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration' // 豆包流式 ASR 2.0 · 小时版
const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'

/**
 * 后端 .env 下发的默认凭据（开源安全设计 2026-08-27：密钥不进前端代码/仓库，
 * 由 gateway 从本地 .env 读取后经 /api/config/asr 提供；localStorage 优先）。
 */
let backendVolc = { token: '', appid: '' }

/** 从 gateway（.env）拉取豆包 ASR 默认配置；返回是否拉到 */
export async function loadVolcFromServer(): Promise<boolean> {
  try {
    const resp = await fetch('/api/config/asr')
    if (!resp.ok) return false
    const data = (await resp.json()) as { volc?: { token?: string; appid?: string } }
    backendVolc = {
      token: (data.volc?.token ?? '').trim(),
      appid: (data.volc?.appid ?? '').trim(),
    }
    return !!backendVolc.token
  } catch {
    return false
  }
}

export function getVolcConfig(): VolcConfig {
  let storedToken = (localStorage.getItem('volc-asr:token') ?? '').trim()
  let storedAppid = (localStorage.getItem('volc-asr:appid') ?? '').trim()
  // 自动纠错：token 栏是纯数字（明显是 App ID）时清掉错误值，回落内置默认
  const looksNumeric = (v: string) => /^\d{6,}$/.test(v)
  if (looksNumeric(storedToken)) {
    // 数字串不属于 API Key：移到 appid（若 appid 空）并清空 token
    if (!storedAppid) storedAppid = storedToken
    localStorage.removeItem('volc-asr:token')
    localStorage.setItem('volc-asr:appid', storedAppid)
    storedToken = ''
  }
  // 用户手动填过（localStorage 有值）则用用户的；否则用后端 .env 下发的默认
  const hasCustomToken = !!storedToken && storedToken !== backendVolc.token
  const token = storedToken || backendVolc.token
  const appid = storedAppid || backendVolc.appid
  const resourceId =
    (localStorage.getItem('volc-asr:resourceId') ?? '').trim() || DEFAULT_RESOURCE_ID
  const endpoint = (localStorage.getItem('volc-asr:endpoint') ?? '').trim() || DEFAULT_ENDPOINT
  return { appid, token, resourceId, endpoint, ready: !!token, hasCustomToken }
}

export function saveVolcConfig(patch: Partial<Omit<VolcConfig, 'ready'>>): void {
  if (patch.appid !== undefined) localStorage.setItem('volc-asr:appid', patch.appid.trim())
  if (patch.token !== undefined) localStorage.setItem('volc-asr:token', patch.token.trim())
  if (patch.resourceId !== undefined)
    localStorage.setItem('volc-asr:resourceId', patch.resourceId.trim())
  if (patch.endpoint !== undefined) localStorage.setItem('volc-asr:endpoint', patch.endpoint.trim())
}

export interface VolcAsrHandlers {
  onFinal: (text: string, speakerId?: number) => void
  onInterim: (text: string) => void
  onError: (msg: string) => void
  /** 诊断日志（不影响错误状态） */
  onDebug?: (msg: string) => void
}

interface Utterance {
  text: string
  definite: boolean
  speaker_id?: string | number // 说话人 ID（官方返回字符串，如 "1"、"2"；enable_speaker_info=true 时返回）
}

interface VolcResponse {
  code?: number
  message?: string
  error?: string
  result?: { text?: string; utterances?: Utterance[] }
}

/** 中转协议消息（浏览器 <-> gateway） */
type ProxyMessage =
  | { type: 'connected' }
  | { type: 'error'; detail: string }
  | { type: 'binary' } // 后续帧均为二进制透传

export class VolcASR {
  private ws: WebSocket | null = null
  private handlers: VolcAsrHandlers | null = null
  private definiteCount = 0
  private seqCounter = 1
  private manualStop = false

  start(handlers: VolcAsrHandlers): boolean {
    const cfg = getVolcConfig()
    if (!cfg.ready) {
      handlers.onError('火山识别未配置：请在「设置 → 实时识别引擎」填写 API Key')
      return false
    }
    this.handlers = handlers
    this.manualStop = false
    this.definiteCount = 0
    this.seqCounter = 1
    this.proxyReady = false
    this.pendingPcm = [] // 重置攒批缓冲

    // 清理旧连接（HMR / 重复开始场景）
    if (this.ws) {
      try {
        this.ws.onclose = null
        this.ws.close(1000)
      } catch {
        /* ignore */
      }
      this.ws = null
    }

    // 经 gateway 中转（/ws 由 Vite dev / gateway 生产共同代理到 :8787）
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${location.host}/ws/asr`
    handlers.onDebug?.(`连接 ${wsUrl}`)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws


    ws.onopen = () => {
      // 第一条文本帧：告诉 gateway 目标与鉴权（密钥经此传递给本机 gateway，不出公网）
      ws.send(
        JSON.stringify({
          type: 'connect',
          endpoint: cfg.endpoint,
          headers: {
            'X-Api-Key': cfg.token,
            'X-Api-Resource-Id': cfg.resourceId,
            'X-Api-Request-Id': crypto.randomUUID(),
            'X-Api-Connect-Id': crypto.randomUUID(),
          },
          // 若用户同时填了 AppID（旧版控制台），改用旧版双头鉴权
          ...(cfg.appid
            ? { altHeaders: { 'X-Api-App-Key': cfg.appid, 'X-Api-Access-Key': cfg.token } }
            : {}),
        }),
      )
    }

    ws.onmessage = (ev) => {
      // 中转层控制帧
      if (typeof ev.data === 'string') {
        let m: ProxyMessage
        try {
          m = JSON.parse(ev.data) as ProxyMessage
        } catch {
          return
        }
        if (m.type === 'connected') {
          this.proxyReady = true
          handlers.onDebug?.('gateway→火山 已连上，发送首帧')
          this.sendFullRequest(ws)
        } else if (m.type === 'error') {
          handlers.onError(m.detail)
        }
        return
      }
      if (!this.proxyReady) return
      this.handleBinary(ev.data as ArrayBuffer)
    }

    ws.onclose = (ev) => {
      handlers.onDebug?.(
        `WS 关闭 code=${ev.code} wasClean=${ev.wasClean} manualStop=${this.manualStop}`,
      )
      if (!this.manualStop) {
        handlers.onError(
          `连接断开 (code=${ev.code}${ev.reason ? '，' + ev.reason : ''})` +
            '——请重试；持续失败请检查 gateway 是否运行',
        )
      }
    }

    return true
  }

  /** 首帧：full client request（JSON+gzip，seq=1） */
  private sendFullRequest(ws: WebSocket): void {
    const fullReq = {
      user: { uid: 'meeting-web' },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        show_utterances: true, // 必须开启，说话人分离结果依赖分句输出
        enable_itn: true,
        enable_speaker_info: true, // 说话人分离（官方参数名；返回 utterances[].speaker_id）
      },
    }
    void sendFrame(ws, 0x1, 0x1, encodeUtf8(JSON.stringify(fullReq)), this.seqCounter++)
  }

  /** proxyReady 门控：connect 握手 + full request 完成前不喂音频 */
  private proxyReady = false

  /**
   * 发包攒批缓冲：官方要求单包 100~200ms（双向流式 200ms 最优）。
   * 3200 样本 @16kHz = 200ms。过小的包会严重劣化服务端性能（实测延迟可达 17s）。
   */
  private pendingPcm: number[] = []
  private static FLUSH_SAMPLES = 3200 // 200ms @ 16kHz

  /** 供给 16k PCM；由 audio.pcmConsumer 调用（攒够 200ms 才真正发送一帧） */
  feed(pcm: Int16Array): void {
    this.send(pcm)
  }

  /** 发送串行链：gzip 是异步的，必须链式保序（并发压缩会导致帧乱序） */
  private sendChain: Promise<void> = Promise.resolve()

  /** 供给 16k PCM；攒够 200ms 一包（官方推荐值），避免小包劣化性能 */
  send(pcm: Int16Array): void {
    const ws = this.ws
    if (!ws) return
    // 攒批：小碎包合并成 200ms 大包再发
    for (let i = 0; i < pcm.length; i++) this.pendingPcm.push(pcm[i])
    if (this.pendingPcm.length < VolcASR.FLUSH_SAMPLES) return
    if (ws.readyState !== WebSocket.OPEN || !this.proxyReady) {
      this.pendingPcm = [] // 未就绪时丢弃，避免积压
      return
    }
    if (ws.bufferedAmount > 1024 * 1024) {
      this.pendingPcm = [] // 网络拥塞时丢弃，避免延迟累积
      return
    }
    const merged = Int16Array.from(this.pendingPcm)
    this.pendingPcm = []
    // 关键：Int16Array -> 字节视图（不能 set()！逐元素赋值会把 16bit 样本截断成 8bit，音频全毁）
    const seq = this.seqCounter++
    const bytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength)
    this.sendChain = this.sendChain
      .then(() => sendFrame(ws, 0x2, 0x1, bytes, seq, /* serialization */ 0x0))
      .catch(() => {
        /* 链不断 */
      })
  }

  /** 结束：先冲刷攒批缓冲（不足 200ms 的尾音），再发负包（flags=0x2，无 sequence 字段） */
  stop(): void {
    this.manualStop = true
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      // 冲刷尾音：剩余不足 200ms 的音频也发出去
      if (this.pendingPcm.length && this.proxyReady) {
        const merged = Int16Array.from(this.pendingPcm)
        this.pendingPcm = []
        const seq = this.seqCounter++
        const bytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength)
        this.sendChain = this.sendChain
          .then(() => sendFrame(ws, 0x2, 0x1, bytes, seq))
          .catch(() => {
            /* ignore */
          })
      }
      const end = () => sendFrame(ws, 0x2, 0x2, new Uint8Array(0))
      this.sendChain = this.sendChain.then(end).catch(end)
    }
    setTimeout(() => {
      try {
        ws?.close(1000)
      } catch {
        /* ignore */
      }
    }, 300) // 给最终结果留收尾窗口
    this.ws = null
    this.handlers?.onInterim('')
  }

  private handleBinary(data: ArrayBuffer): void {
    const buf = new Uint8Array(data)
    if (buf.length < 4) return
    const msgType = (buf[1] >> 4) & 0xf
    const flags = buf[1] & 0xf
    const serialization = (buf[2] >> 4) & 0xf
    const compression = buf[2] & 0xf
    let off = 4
    if (flags & 0x1) off += 4 // sequence
    if (msgType === 0xf) off += 4 // error code
    if (buf.length < off + 4) return
    const size = new DataView(buf.buffer, buf.byteOffset).getUint32(off, false)
    off += 4
    let payload = buf.subarray(off, off + size)

    if (serialization !== 0x1) return
    if (compression === 0x1) {
      void gunzipText(payload).then((text) => this.consumeJsonText(text, msgType, flags))
      return
    }
    this.consumeJsonText(new TextDecoder().decode(payload), msgType, flags)
  }

  private consumeJsonText(text: string, msgType: number, _flags: number): void {
    let d: VolcResponse
    try {
      d = JSON.parse(text) as VolcResponse
    } catch {
      return
    }

    if (msgType === 0xf) {
      this.handlers?.onError(d.error ?? d.message ?? '火山返回错误')
      return
    }
    if (typeof d.code === 'number' && d.code !== 0 && d.code !== 20000000) {
      this.handlers?.onError(`[${d.code}] ${d.message ?? '未知错误'}`)
      return
    }

    const result = d.result
    if (!result) return
    const utterances = result.utterances

    if (Array.isArray(utterances) && utterances.length) {
      // utterances 分句模式（show_utterances=true）：definite=true 为确认句
      const definite = utterances.filter((u) => u.definite)
      if (definite.length > this.definiteCount) {
        for (let i = this.definiteCount; i < definite.length; i++) {
          const t = (definite[i].text ?? '').trim()
          if (t) {
            // speaker_id 官方返回字符串（如 "1"）；解析为数字，从 1 开始编号
            const sid = definite[i].speaker_id
            const speakerNum = sid !== undefined && sid !== null ? Number(sid) : undefined
            this.handlers?.onFinal(
              t,
              Number.isFinite(speakerNum) && (speakerNum as number) > 0
                ? (speakerNum as number)
                : undefined,
            )
          }
        }
        this.definiteCount = definite.length
      }
      const last = utterances[utterances.length - 1]
      this.handlers?.onInterim(last.definite ? '' : (last.text ?? ''))
    } else if (typeof result.text === 'string') {
      // 全量 text 累计兜底
      this.handlers?.onInterim(result.text)
    }
  }
}

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** gzip 压缩一帧 payload（pipeThrough 标准写法，无死锁） */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(data.length)
  new Uint8Array(copy).set(data)
  const ab = await new Response(
    new Blob([copy]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  return new Uint8Array(ab)
}

/** 组帧并发送：head(4) [+seq(4)] +size(4)+gzip(payload) */
async function sendFrame(
  ws: WebSocket,
  msgType: number,
  flags: number,
  payloadRaw: Uint8Array,
  sequence?: number,
  serialization: number = 0x1,
): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return
  const compressed = await gzipBytes(payloadRaw)
  const head = new Uint8Array([
    (0x1 << 4) | 0x1,
    (msgType << 4) | flags,
    (serialization << 4) | 0x1,
    0x00,
  ])
  // 帧序：head(4) [+seq(4)] + size(4) + gzip(payload)
  const sizeBuf = new ArrayBuffer(4)
  new DataView(sizeBuf).setUint32(0, compressed.length, false)
  const seqBuf = new ArrayBuffer(4)
  if (flags & 0x1 && sequence !== undefined) {
    new DataView(seqBuf).setInt32(0, sequence, false)
  }
  const parts: ArrayBuffer[] = flags & 0x1 && sequence !== undefined
    ? [head.buffer as ArrayBuffer, seqBuf, sizeBuf, compressed.buffer as ArrayBuffer]
    : [head.buffer as ArrayBuffer, sizeBuf, compressed.buffer as ArrayBuffer]
  ws.send(new Blob(parts))
}

async function gunzipText(data: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(data.length)
  new Uint8Array(copy).set(data)
  const ab = await new Response(
    new Blob([copy]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer()
  return new TextDecoder().decode(ab)
}

export const VolcASRProxyPath = '/ws/asr'
