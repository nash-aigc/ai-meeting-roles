<script setup lang="ts">
/**
 * 转写稿：实时滚动 + 双击编辑（修正识别错误，编辑结果上行 transcript.edit）。
 * 新增：多说话人颜色区分 + 「全览」入口弹框展开所有对话（全局查看/复制/导出）。
 */
import { nextTick, ref, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { msToStamp, roleColor } from '../composables/roleColor'

const store = useMeetingStore()
const containerRef = ref<HTMLElement | null>(null)
const atBottom = ref(true)
const editingId = ref<string | null>(null)
const editText = ref('')
const fullscreenDialog = ref(false)
const fullText = ref('')

function onScroll(): void {
  const el = containerRef.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(
  () => store.transcripts.length,
  async () => {
    if (!atBottom.value) return
    await nextTick()
    const el = containerRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function scrollToBottom(): void {
  const el = containerRef.value
  if (el) el.scrollTop = el.scrollHeight
  atBottom.value = true
}

function startEdit(id: string, text: string): void {
  editingId.value = id
  editText.value = text
}

function commitEdit(): void {
  if (editingId.value) {
    store.editTranscript(editingId.value, editText.value.trim())
  }
  editingId.value = null
}

function exportFullText(): string {
  return store.transcripts
    .map((t) => {
      const speaker = t.speaker === 'user' ? '说话人1' : store.roleById.get(t.speaker)?.name || t.speaker
      return `[${msToStamp(t.tsMs)}] [${speaker}] ${t.text}`
    })
    .join('\n')
}

function openFullscreen(): void {
  fullText.value = exportFullText()
  fullscreenDialog.value = true
}

function downloadFulltext(): void {
  const blob = new Blob([fullText.value], { type: 'text/plain; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transcript_${new Date().toISOString().slice(0, 10)}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function copyAll(): void {
  void navigator.clipboard.writeText(fullText.value)
}

function speakerBadgeClass(speaker: string): string {
  if (speaker === 'user') {
    return 'bg-zinc-700 text-zinc-300'
  }
  const role = store.roleById.get(speaker)
  if (role) {
    return roleColor(role.color).badge
  }
  // 多说话人默认配色
  const colors = [
    'bg-sky-500/20 text-sky-300',
    'bg-amber-500/20 text-amber-300',
    'bg-emerald-500/20 text-emerald-300',
    'bg-violet-500/20 text-violet-300',
    'bg-rose-500/20 text-rose-300',
  ]
  // 说话人编号如 S1/S2/用户 -> 取第一个数字映射颜色
  const num = parseInt(speaker.replace(/\D/g, ''), 10)
  if (!Number.isNaN(num) && num - 1 < colors.length) {
    return colors[num - 1]
  }
  return 'bg-zinc-700 text-zinc-300'
}

function speakerLabel(speaker: string): string {
  if (speaker === 'user') return '用户'
  const role = store.roleById.get(speaker)
  if (role) return role.name
  // fallback: 说话人一/说话人二
  const num = parseInt(speaker.replace(/\D/g, ''), 10)
  if (!Number.isNaN(num)) {
    // 中文表示：说话人一、说话人二...
    const cn = ['零', '一', '二', '三', '四', '五'][num]
    return `说话人${cn}`
  }
  return speaker
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5">
      <span class="text-xs font-medium text-zinc-400">
        实时转写<span class="ml-2 text-zinc-600">{{ store.transcripts.length }} 条 · 双击可编辑</span>
      </span>
      <div class="flex items-center gap-2">
        <button
          v-if="!atBottom && store.transcripts.length"
          class="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-700"
          @click="scrollToBottom"
        >
          回到底部 ↓
        </button>
        <button
          v-if="store.transcripts.length"
          class="flex items-center gap-1 rounded-md bg-sky-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-sky-600"
          @click="openFullscreen"
        >
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" stroke-linecap="round" />
          </svg>
          全览
        </button>
      </div>
    </div>

    <!-- 内容 -->
    <div ref="containerRef" class="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2.5" @scroll="onScroll">
      <div v-if="!store.transcripts.length" class="flex h-full items-center justify-center text-xs text-zinc-600">
        开始录音后，转写内容将实时显示在这里
      </div>

      <div v-for="item in store.transcripts" :key="item.id" class="slide-in group">
        <!-- 编辑态 -->
        <div v-if="editingId === item.id" class="rounded-lg border border-sky-500/40 bg-sky-500/5 p-2">
          <textarea
            v-model="editText"
            class="w-full resize-none bg-transparent text-xs leading-4 text-zinc-100 outline-none"
            rows="3"
            @keydown.enter.prevent="commitEdit"
            @keydown.esc="editingId = null"
          />
          <div class="mt-1 flex justify-end gap-2 text-[11px]">
            <button class="text-zinc-500 hover:text-zinc-300" @click="editingId = null">取消</button>
            <button class="text-sky-400 hover:text-sky-300" @click="commitEdit">保存 (Enter)</button>
          </div>
        </div>

        <!-- 展示态 -->
        <div
          v-else
          class="flex flex-wrap gap-x-1.5 gap-y-0.5 rounded-lg px-2 py-1.5 transition hover:bg-zinc-800/40"
          :class="{ 'opacity-80': item.edited }"
          @dblclick="startEdit(item.id, item.text)"
        >
          <span class="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-zinc-600">
            {{ msToStamp(item.tsMs) }}
          </span>
          <span
            class="shrink-0 self-start rounded px-1.5 py-0.5 text-[10px] leading-4"
            :class="speakerBadgeClass(item.speaker)"
          >
            {{ speakerLabel(item.speaker) }}
          </span>
          <p class="flex-1 min-w-[60%] text-xs leading-4 text-zinc-200">{{ item.text }}</p>
          <span v-if="item.edited" class="ml-auto shrink-0 self-start rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
            已修正
          </span>
        </div>
      </div>
    </div>

    <!-- 全览对话框 -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-150 ease-out"
        enter-from-class="opacity-0"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <div
          v-if="fullscreenDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          @click.self="fullscreenDialog = false"
        >
          <div class="flex max-h-[90vh] w-[85vw] max-w-[1000px] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h3 class="text-sm font-semibold text-zinc-100">转写全览</h3>
              <div class="flex items-center gap-2">
                <button
                  class="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-700"
                  @click="copyAll"
                >
                  复制全部
                </button>
                <button
                  class="rounded-lg bg-emerald-600/80 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-600"
                  @click="downloadFulltext"
                >
                  下载文件
                </button>
                <button
                  class="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
                  @click="fullscreenDialog = false"
                >
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <textarea
                v-model="fullText"
                class="w-full h-full resize-none bg-zinc-950 px-4 py-3 text-xs leading-4 text-zinc-200 outline-none"
                rows="25"
              />
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
