/**
 * 会议历史：localStorage 持久化（V1 前端本地版；后端就绪后切换 /api/meetings）。
 * 每场会议归档时 upsert；会后交流继续追加时自动刷新。
 */

export interface HistoryTranscriptItem {
  tsMs: number
  speaker: string
  text: string
}

export interface HistoryAgentEvent {
  tsMs: number
  role: string
  type: 'observe' | 'reply' | 'interrupt' | 'listen'
  text: string
  executed: boolean
}

export interface MeetingHistoryEntry {
  id: string // meetingId
  title: string
  dateMs: number
  durationMs: number
  state: string
  model: string
  participants: string[] // 角色名列表
  claudeSessionIds: Record<string, string>
  summaryText: string // 内容文字摘要（前几条拼接）
  transcripts: HistoryTranscriptItem[]
  agentEvents?: HistoryAgentEvent[] // AI 角色输出事件（V2 新增，向下兼容旧历史）
}

/**
 * 归档音频注册表（内存优先）：meetingId -> Blob URL。
 * 持久化音频存后端 Record/<meetingId>/recording.webm，经 /api/meeting/<id>/audio 回放。
 */
const audioRegistry = new Map<string, string>()

export function registerAudioUrl(meetingId: string, blob: Blob): string {
  const url = URL.createObjectURL(blob)
  audioRegistry.set(meetingId, url)
  return url
}

/** 上传归档音频到后端（会议结束时调用，fire-and-forget） */
export function uploadAudioBlob(meetingId: string, blob: Blob): void {
  void fetch(`/api/meeting/${encodeURIComponent(meetingId)}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  }).catch(() => {
    /* 上传失败不阻塞结束流程；历史回放时降级提示 */
  })
}

export function getAudioUrl(meetingId: string): string | null {
  return audioRegistry.get(meetingId) ?? null
}

/** 历史回放取音频：内存优先，否则后端归档文件（本页会话没录过的旧会议） */
export async function resolveAudioUrl(meetingId: string): Promise<string | null> {
  const mem = audioRegistry.get(meetingId)
  if (mem) return mem
  try {
    const resp = await fetch(`/api/meeting/${encodeURIComponent(meetingId)}/audio`, { method: 'HEAD' })
    if (resp.ok) return `/api/meeting/${encodeURIComponent(meetingId)}/audio`
  } catch {
    /* gateway 不在 */
  }
  return null
}

const KEY = 'meeting-history:v1'

export function loadHistory(): MeetingHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      const seeded = seedDemoHistory()
      localStorage.setItem(KEY, JSON.stringify(seeded))
      return seeded
    }
    return JSON.parse(raw) as MeetingHistoryEntry[]
  } catch {
    return []
  }
}

export function upsertHistory(entry: MeetingHistoryEntry): MeetingHistoryEntry[] {
  const list = loadHistory()
  const i = list.findIndex((e) => e.id === entry.id)
  if (i >= 0) list[i] = entry
  else list.unshift(entry)
  // 最多保留 50 场
  if (list.length > 50) list.length = 50
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

// ---------- 首次演示种子数据（让历史面板直接有内容可看）----------
function seedDemoHistory(): MeetingHistoryEntry[] {
  const mk = (
    id: string,
    title: string,
    iso: string,
    durationMs: number,
    summary: string,
    transcripts: HistoryTranscriptItem[],
  ): MeetingHistoryEntry => ({
    id,
    title,
    dateMs: new Date(iso).getTime(),
    durationMs,
    state: 'closed',
    model: 'deepseek-v4-flash',
    participants: ['客户', '老板'],
    claudeSessionIds: {
      customer: `cust-${id}-7f3a2b91`,
      boss: `boss-${id}-c48d1e06`,
    },
    summaryText: summary,
    transcripts,
  })

  return [
    mk(
      'seed-0825',
      '客户异议处理演练 · 价格篇',
      '2026-08-25T15:30:00',
      12 * 60 * 1000 + 34 * 1000,
      '用户向王总介绍智能会议系统，客户对价格与数据安全提出异议，老板在报价环节打断并提示先摸清预算…',
      [
        { tsMs: 0, speaker: 'user', text: '王总您好，今天想给您介绍一下我们的智能会议系统。' },
        { tsMs: 24000, speaker: 'customer', text: '等一下，三万八太贵了，隔壁那家才一万五。' },
        { tsMs: 48000, speaker: 'boss', text: '停一下，客户的预算你问清楚了吗？' },
      ],
    ),
    mk(
      'seed-0824',
      '季度销售复盘 · Q3 目标对齐',
      '2026-08-24T10:00:00',
      28 * 60 * 1000,
      '围绕 Q3 目标达成率复盘，老板指出商机转化率下滑主因是需求确认不充分，客户视角补充了竞品动态…',
      [
        { tsMs: 0, speaker: 'user', text: '这个季度整体完成了目标的百分之八十二。' },
        { tsMs: 52000, speaker: 'boss', text: '差距的百分之十八，主要丢在哪个环节？' },
      ],
    ),
    mk(
      'seed-0822',
      '产品功能介绍 · 新客户演示',
      '2026-08-22T16:20:00',
      8 * 60 * 1000 + 5 * 1000,
      '面向新客户的产品演示，重点展示了实时转写与 AI 插话打断能力，客户关心部署周期与试用政策…',
      [
        { tsMs: 0, speaker: 'user', text: '我们产品最大的优势是会议内容实时转写。' },
        { tsMs: 41000, speaker: 'customer', text: '担心的其实是部署周期，公司下个月就要用。' },
      ],
    ),
  ]
}
