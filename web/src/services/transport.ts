/**
 * 传输层：真实 WebSocket 或 Mock 演示引擎，接口一致，上层无感。
 * mock 开关：URL 带 ?mock=1（纯前端调排版，不依赖任何后端）。
 */
import type { ClientMessage, ServerMessage } from '../types/protocol'
import { MockTransport } from './mock'

export interface Transport {
  onMessage(cb: (m: ServerMessage) => void): void
  send(msg: ClientMessage): void
  sendAudioChunk(idx: number, mime: string, data: ArrayBuffer): void
  close(): void
}

export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('mock')
}

/** 真实 WebSocket 传输（经 Vite 代理到 Docker gateway） */
export class WSTransport implements Transport {
  private ws: WebSocket
  private cb: ((m: ServerMessage) => void) | null = null

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws/meeting`)
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          this.cb?.(JSON.parse(ev.data) as ServerMessage)
        } catch {
          console.warn('[ws] 无法解析消息', ev.data)
        }
      }
    }
    // 二进制帧 = 音频分片（与后端约定：分片前先发 JSON 元信息帧）
  }

  onMessage(cb: (m: ServerMessage) => void): void {
    this.cb = cb
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendAudioChunk(_idx: number, _mime: string, _data: ArrayBuffer): void {
    // 会议通道不再上行音频：识别音频走独立 /ws/asr 通道，录音归档由后端
    // meeting.stop 时落盘。之前在此发二进制帧会导致 gateway receive_text()
    // 抛 KeyError 使会议连接崩溃（user.speech 全部静默丢失）——已移除。
  }

  close(): void {
    this.ws.close()
  }
}

let transport: Transport | null = null

export function getTransport(): Transport {
  if (!transport) {
    transport = isMockMode() ? new MockTransport() : new WSTransport()
  }
  return transport
}
