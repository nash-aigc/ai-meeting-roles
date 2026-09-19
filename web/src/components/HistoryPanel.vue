<script setup lang="ts">
/**
 * 会议历史（右侧视图）：本地保存的会议列表。
 * 展开态：① Claude 会话 ID 完整显示 ② 录音回放（播放/暂停/快进快退/点击进度条跳转）
 * ③ 合并时间线默认只显示前 2 条，点「全览」看全部。
 */
import { ref, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { msToStamp, roleColor } from '../composables/roleColor'
import { resolveAudioUrl } from '../services/history'
import type { MeetingHistoryEntry, HistoryTranscriptItem, HistoryAgentEvent } from '../services/history'

const store = useMeetingStore()
const expandId = ref<string | null>(null)
const fullViewId = ref<string | null>(null)

// ---------- 录音回放 ----------
const audioRef = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const totalDuration = ref(0)
const SEEK_STEP = 10 // 快进/快退秒数

const expandedAudioUrl = ref<string | null>(null)
const openingSession = ref<string | null>(null)

/** 用 Orca 打开该 Claude 会话（gateway 调 orca terminal create + claude --resume） */
async function openClaudeSession(sessionId: string): Promise<void> {
  if (openingSession.value) return
  openingSession.value = sessionId
  try {
    const resp = await fetch(`/api/claude/${encodeURIComponent(sessionId)}/open`, { method: 'POST' })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
      alert(`打开失败：${data.error || resp.status}`)
    }
  } catch (err) {
    alert(`打开失败：${err}`)
  } finally {
    openingSession.value = null
  }
}

watch(expandId, async (id) => {
  playing.value = false
  currentTime.value = 0
  totalDuration.value = 0
  expandedAudioUrl.value = null
  if (id) {
    expandedAudioUrl.value = await resolveAudioUrl(id)
  }
})

function togglePlay(): void {
  const el = audioRef.value
  if (!el || !expandedAudioUrl.value) return
  if (el.paused) {
    void el.play()
  } else {
    el.pause()
  }
}

function seek(delta: number): void {
  const el = audioRef.value
  if (!el) return
  el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta))
}

function onSeekInput(e: Event): void {
  const el = audioRef.value
  const val = Number((e.target as HTMLInputElement).value)
  if (el && Number.isFinite(val)) el.currentTime = val
}

function onLoadedMetadata(): void {
  const el = audioRef.value
  if (el && Number.isFinite(el.duration)) totalDuration.value = el.duration
}

function onTimeUpdate(): void {
  const el = audioRef.value
  if (el) currentTime.value = el.currentTime
}

function onEnded(): void {
  playing.value = false
}

function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

// ---------- 展开与时间线 ----------
function toggleExpand(id: string): void {
  expandId.value = expandId.value === id ? null : id
  if (expandId.value === null) fullViewId.value = null
}

function toggleFullView(id: string): void {
  fullViewId.value = fullViewId.value === id ? null : id
}

function speakerLabel(speaker: string): string {
  if (speaker === 'user') return '说话人1'
  return store.roleById.get(speaker)?.name ?? speaker
}

function speakerBadgeClass(speaker: string): string {
  if (speaker === 'user') return 'tag'
  const r = store.roleById.get(speaker)
  return r ? roleColor(r.color).badge : 'tag'
}

function eventTypeLabel(type: string): string {
  switch (type) {
    case 'observe': return '观点'
    case 'reply': return '回复'
    case 'interrupt': return '插话'
    default: return type
  }
}

function eventTypeBadgeClass(type: string, executed: boolean): string {
  if (type === 'interrupt' && executed) return 'tag-danger'
  if (type === 'reply') return 'tag-info'
  return 'tag'
}

function roleName(id: string): string {
  return store.roleById.get(id)?.name ?? id
}

interface TimelineItem {
  tsMs: number
  type: 'transcript' | 'agent'
  data: HistoryTranscriptItem | HistoryAgentEvent
}

function getCombinedTimeline(entry: MeetingHistoryEntry): TimelineItem[] {
  const items: TimelineItem[] = []
  entry.transcripts.forEach(t => items.push({ tsMs: t.tsMs, type: 'transcript', data: t }))
  if (entry.agentEvents) {
    entry.agentEvents.forEach(e => items.push({ tsMs: e.tsMs, type: 'agent', data: e }))
  }
  items.sort((a, b) => a.tsMs - b.tsMs)
  return items
}

/** 默认只显示前 2 条；全览模式显示全部 */
function getVisibleTimeline(entry: MeetingHistoryEntry): TimelineItem[] {
  const all = getCombinedTimeline(entry)
  if (fullViewId.value === entry.id) return all
  return all.slice(0, 2)
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-warm-main p-[14px]">
    <!-- 头部 -->
    <div class="mb-[14px] flex items-center gap-3" style="min-height: 40px;">
      <button
        class="btn"
        @click="store.setView('live')"
      >
        <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        返回
      </button>
      <h2 class="text-[16px] font-semibold text-warm-100">会议历史</h2>
      <span class="text-[13px] text-warm-500">{{ store.history.length }} 场 · 本地保存</span>
    </div>

    <!-- 列表 -->
    <div class="min-h-0 flex-1 space-y-[10px] overflow-y-auto pr-1">
      <div v-if="!store.history.length" class="flex h-full items-center justify-center text-[13px] text-warm-600">
        还没有归档的会议
      </div>

      <div
        v-for="e in store.history"
        :key="e.id"
        class="card card-hover cursor-pointer p-[14px]"
        style="min-height: 96px;"
        @click="toggleExpand(e.id)"
      >
        <!-- 行 1：标题 + 重要参数 -->
        <div class="flex flex-wrap items-center gap-2.5">
          <span class="text-[15px] font-semibold text-warm-100">{{ e.title }}</span>
          <span class="text-[12px] text-warm-500">{{ fmtDate(e.dateMs) }}</span>
          <span class="text-[12px] text-warm-500">时长 {{ fmtDur(e.durationMs) }}</span>
          <span
            class="tag"
            :class="e.state === 'postTalk' ? 'tag-accent' : 'tag-success'"
          >
            {{ e.state === 'postTalk' ? '会后交流中' : '已结束' }}
          </span>
          <svg
            viewBox="0 0 24 24"
            class="ml-auto h-[14px] w-[14px] text-warm-600 transition"
            :class="{ 'rotate-90': expandId === e.id }"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <!-- 行 2：内容文字部分 -->
        <p class="mt-[6px] line-clamp-2 text-[13px] leading-6 text-warm-300">{{ e.summaryText }}</p>

        <!-- 行 3：参与者 / AI 模型 -->
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-warm-500">
          <span class="flex items-center gap-1.5">
            参与者
            <span
              v-for="p in e.participants"
              :key="p"
              class="tag"
            >{{ p }}</span>
          </span>
          <span>模型 <span class="text-warm-300">{{ e.model }}</span></span>
        </div>

        <!-- 展开态 -->
        <div v-if="expandId === e.id" class="mt-3 space-y-3 border-t border-warm-subtle pt-[10px]" @click.stop>
          <!-- ① Claude 会话 ID 完整显示 -->
          <div>
            <span class="text-[12px] font-medium text-warm-500">Claude Code 会话</span>
            <div class="mt-1 space-y-1">
              <div
                v-for="(sid, rid) in e.claudeSessionIds"
                :key="rid"
                class="flex items-center gap-2 text-[12px]"
              >
                <span class="tag">{{ roleName(rid) }}</span>
                <span class="font-mono text-warm-500">{{ sid }}</span>
                <button
                  class="text-warm-600 transition hover:text-warm-300"
                  title="复制会话 ID"
                  @click="copyText(String(sid))"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke-linecap="round" />
                  </svg>
                </button>
                <!-- 用 Orca 打开该会话 -->
                <button
                  class="btn" style="height: 24px; padding: 0 8px; font-size: 11px;"
                  :class="openingSession === String(sid) ? 'opacity-50 pointer-events-none' : ''"
                  :title="`用 Orca 打开 ${roleName(rid)} 的 Claude 会话`"
                  @click="openClaudeSession(String(sid))"
                >
                  <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13 3l-1.5 7H16l-5 11 1.5-8H8l5-10z" stroke-linejoin="round" />
                  </svg>
                  <span>{{ openingSession === String(sid) ? '打开中…' : '打开Claude' }}</span>
                </button>
              </div>
              <div v-if="!Object.keys(e.claudeSessionIds).length" class="text-[12px] text-warm-600">
                （本场无 Claude 会话）
              </div>
            </div>
          </div>

          <!-- ② 录音回放 -->
          <div>
            <span class="text-[12px] font-medium text-warm-500">录音回放</span>
            <div v-if="expandedAudioUrl" class="mt-1 rounded-lg bg-warm-input p-[10px]">
              <audio
                ref="audioRef"
                :src="expandedAudioUrl"
                preload="metadata"
                @loadedmetadata="onLoadedMetadata"
                @timeupdate="onTimeUpdate"
                @ended="onEnded"
                @play="playing = true"
                @pause="playing = false"
              />
              <div class="flex items-center gap-2">
                <!-- 快退 -->
                <button
                  class="flex h-7 w-7 items-center justify-center rounded-full text-warm-300 transition hover:bg-warm-tag hover:text-warm-100"
                  title="后退 10 秒"
                  @click="seek(-SEEK_STEP)"
                >
                  <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="currentColor">
                    <path d="M11 12l9-7v14l-9-7z" />
                    <rect x="2" y="5" width="2.5" height="14" rx="1" />
                  </svg>
                </button>
                <!-- 播放/暂停 -->
                <button
                  class="flex h-8 w-8 items-center justify-center rounded-full text-white transition"
                  style="background: var(--info);"
                  :title="playing ? '暂停' : '播放'"
                  @click="togglePlay"
                >
                  <svg v-if="playing" viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
                    <rect x="7" y="5" width="4" height="14" rx="1" />
                    <rect x="13" y="5" width="4" height="14" rx="1" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
                    <path d="M8 5.14v13.72c0 .8.87 1.3 1.57.9l11.1-6.86a1.05 1.05 0 0 0 0-1.8L9.57 4.24A1.05 1.05 0 0 0 8 5.14z" />
                  </svg>
                </button>
                <!-- 快进 -->
                <button
                  class="flex h-7 w-7 items-center justify-center rounded-full text-warm-300 transition hover:bg-warm-tag hover:text-warm-100"
                  title="前进 10 秒"
                  @click="seek(SEEK_STEP)"
                >
                  <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="currentColor">
                    <path d="M13 12L4 5v14l9-7z" />
                    <rect x="19.5" y="5" width="2.5" height="14" rx="1" />
                  </svg>
                </button>
                <!-- 时间 -->
                <span class="font-mono text-[12px] tabular-nums text-warm-300">
                  {{ fmtSec(currentTime) }} / {{ fmtSec(totalDuration) }}
                </span>
              </div>
              <!-- 进度条 -->
              <input
                type="range"
                min="0"
                :max="totalDuration || 0"
                step="0.1"
                :value="currentTime"
                class="mt-2 w-full"
                style="accent-color: var(--info);"
                @input="onSeekInput"
              />
            </div>
            <div v-else class="mt-1 rounded-lg bg-warm-input p-[10px] text-[12px] text-warm-600">
              （本场音频未归档：旧版本会议或录音时间过短无有效数据）
            </div>
          </div>

          <!-- ③ 合并时间线 -->
          <div>
            <div class="flex items-center justify-between">
              <span class="text-[12px] font-medium text-warm-500">对话时间线</span>
              <button
                v-if="getCombinedTimeline(e).length > 2"
                class="btn btn-primary" style="height: 26px; padding: 0 10px; font-size: 11px;"
                @click="toggleFullView(e.id)"
              >
                {{ fullViewId === e.id ? '收起' : '全览' }}
              </button>
            </div>
            <div class="mt-1 space-y-1.5">
              <template v-if="e.transcripts.length || e.agentEvents?.length">
                <div
                  v-for="(item, i) in getVisibleTimeline(e)"
                  :key="i"
                  class="flex items-start gap-2 text-[13px] leading-6"
                >
                  <span class="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-warm-600">
                    {{ msToStamp(item.tsMs) }}
                  </span>
                  <!-- 用户转写 -->
                  <template v-if="item.type === 'transcript'">
                    <span class="shrink-0 tag">
                      [{{ speakerLabel((item.data as HistoryTranscriptItem).speaker) }}]
                    </span>
                    <p class="text-warm-100">{{ (item.data as HistoryTranscriptItem).text }}</p>
                  </template>
                  <!-- AI 角色事件 -->
                  <template v-else>
                    <span
                      class="shrink-0 tag"
                      :class="speakerBadgeClass((item.data as HistoryAgentEvent).role)"
                    >
                      [{{ roleName((item.data as HistoryAgentEvent).role) }}]
                    </span>
                    <span
                      class="shrink-0 tag"
                      :class="eventTypeBadgeClass((item.data as HistoryAgentEvent).type, (item.data as HistoryAgentEvent).executed)"
                    >
                      {{ eventTypeLabel((item.data as HistoryAgentEvent).type) }}
                    </span>
                    <p class="text-warm-100">{{ (item.data as HistoryAgentEvent).text }}</p>
                  </template>
                </div>
                <!-- 折叠提示 -->
                <div
                  v-if="fullViewId !== e.id && getCombinedTimeline(e).length > 2"
                  class="pt-1 text-center text-[12px] text-warm-600"
                >
                  还有 {{ getCombinedTimeline(e).length - 2 }} 条，点「全览」查看
                </div>
              </template>
              <div v-else class="py-2 text-center text-[13px] text-warm-600">
                （无内容）
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
