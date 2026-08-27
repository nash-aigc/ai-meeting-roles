/**
 * TTS 语音播放：gateway /api/tts 合成（CosyVoice）-> WebAudio 增益播放。
 * 播放窗口上报给 store（回声过滤 + 时间轴红块 + 警报联动）。
 * AI 角色的口头表达一律走本模块（用户要求：AI 表达必须是语音形式）。
 *
 * 2026-08-27 v2 —— 全局播放队列（用户反馈：两段语音叠播体验差）：
 * - speakWithGain()：正常回复，追加队尾 FIFO，等前一条播完才播
 * - speakInterrupt()：打断语音，插队首（当前正在播的不掐断，播完后立即播打断）
 * - stopVoicePlayback()：清空队列 + 停止当前（barge-in / 暂停 / 结束）
 * - hasQueuedVoice()：队列状态查询（打断提示条收起判断，避免语音还没轮到播就被计时器收起）
 * 音色增益保留（王新月响度补偿对齐高晴）。
 */

import type { MeetingStoreLike } from './store-types'

/** 每音色增益（王新月响度偏小，1.6 倍对齐高晴；用户 2026-08-27 反馈可再调） */
export const VOICE_GAINS: Record<string, number> = {
  高晴: 1.0,
  王新月: 1.6,
}

let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

interface PlayHandlers {
  onStart?: (wid: string) => void
  onEnd?: (wid: string) => void
  onError?: (msg: string) => void
}

interface QueueItem {
  text: string
  voice: string
  handlers: PlayHandlers
}

const queue: QueueItem[] = []
let driverRunning = false
let generation = 0 // stop() 递增：让"合成中"的条目作废（防止停止后又冒出声音）

let curSrc: AudioBufferSourceNode | null = null
let curResolve: (() => void) | null = null
let curEnd: (() => void) | null = null

let windowSeq = 0
function nextWid(): string {
  return `tts-${Date.now()}-${++windowSeq}`
}

/** 停止当前播放（不清队列）：释放 driver 循环 + 触发 onEnd 关播放窗口 */
function stopCurrent(): void {
  if (!curSrc) return
  const src = curSrc
  curSrc = null
  src.onended = null
  try {
    src.stop()
  } catch {
    /* 已停止 */
  }
  const resolve = curResolve
  const end = curEnd
  curResolve = null
  curEnd = null
  resolve?.() // 释放 driver 的 await
  end?.() // onEnd 回调
}

/** 合成（fetch + decode） */
async function synth(text: string, voice: string): Promise<AudioBuffer> {
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 500), voice }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`TTS 合成失败(${resp.status}): ${detail.slice(0, 120)}`)
  }
  return getCtx().decodeAudioData(await resp.arrayBuffer())
}

/** 播放驱动：顺序消费队列，同一时间只有一条语音在播（不叠播） */
async function drive(): Promise<void> {
  if (driverRunning) return
  driverRunning = true
  try {
    while (queue.length) {
      const item = queue.shift()!
      const myGen = generation
      const wid = nextWid()
      let ended = false
      const finish = () => {
        if (ended) return
        ended = true
        curSrc = null
        curResolve = null
        curEnd = null
        item.handlers.onEnd?.(wid)
      }
      try {
        const buffer = await synth(item.text, item.voice)
        if (myGen !== generation) continue // stop() 已清队：本条作废
        const src = getCtx().createBufferSource()
        src.buffer = buffer
        const gain = getCtx().createGain()
        gain.gain.value = VOICE_GAINS[item.voice] ?? 1.0
        src.connect(gain)
        gain.connect(getCtx().destination)
        curSrc = src
        curEnd = finish
        item.handlers.onStart?.(wid)
        await new Promise<void>((resolve) => {
          curResolve = resolve
          src.onended = () => resolve()
          src.start()
        })
        finish()
      } catch (e) {
        finish() // 出错也清状态，别卡住 driver
        item.handlers.onError?.(`TTS 播放失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    driverRunning = false
  }
}

/** 排队播放（追加队尾，FIFO）：AI 正常回复语音；试听也走这里 */
export function speakWithGain(text: string, voice: string, handlers: PlayHandlers = {}): void {
  if (!text.trim()) return
  queue.push({ text, voice, handlers })
  void drive()
}

/** 插队播放（队首）：打断语音。当前正在播的语音播完后立即播打断，再继续队列其余 */
export function speakInterrupt(text: string, voice: string, handlers: PlayHandlers = {}): void {
  if (!text.trim()) return
  queue.unshift({ text, voice, handlers })
  void drive()
}

/** 队列里还有等待播放的语音（打断提示条收起判断用） */
export function hasQueuedVoice(): boolean {
  return queue.length > 0
}

/** 停止当前播放并清空队列（barge-in / 会议暂停/结束） */
export function stopVoicePlayback(): void {
  generation++
  queue.length = 0
  stopCurrent()
}

export function isVoicePlaying(): boolean {
  return !!curSrc
}

export class TtsSpeaker {
  private store: MeetingStoreLike | null = null

  bind(store: MeetingStoreLike): void {
    this.store = store
  }

  get playing(): boolean {
    return isVoicePlaying()
  }

  hasQueuedVoice(): boolean {
    return hasQueuedVoice()
  }

  /** 排队播放（队尾）：AI 正常回复语音 */
  speak(text: string, voice: string): void {
    const store = this.store
    speakWithGain(text, voice, {
      onStart: (wid) => store?.onTtsStart(wid),
      onEnd: (wid) => store?.onTtsEnd(wid),
      onError: (msg) => store?.onTtsError(msg),
    })
  }

  /** 插队播放（队首）：打断语音，当前语音播完后立即播 */
  speakInterrupt(text: string, voice: string): void {
    const store = this.store
    speakInterrupt(text, voice, {
      onStart: (wid) => store?.onTtsStart(wid),
      onEnd: (wid) => store?.onTtsEnd(wid),
      onError: (msg) => store?.onTtsError(msg),
    })
  }

  /** 立即停止播放并清空队列（barge-in / 会议暂停/结束） */
  stop(): void {
    stopVoicePlayback()
  }
}

export const ttsSpeaker = new TtsSpeaker()
