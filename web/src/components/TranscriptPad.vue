<script setup lang="ts">
/**
 * 实时记录板（左栏最底部）：
 * - 收起态：AI 自动生成的会议标题（可改）+ 最近 2 条转写预览 + 自动保存指示
 * - 展开态：浮层显示全部记录（按说话人标注），条目可编辑，自动保存 localStorage
 * 说话人：user = 说话人1（用户本人），AI 角色插话以角色名标注。
 */
import { computed, ref } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { msToStamp, roleColor } from '../composables/roleColor'

const store = useMeetingStore()

const expanded = ref(false)
const editingId = ref<string | null>(null)
const draftText = ref('')
const titleEditing = ref(false)
const titleDraft = ref('')

const recent = computed(() => store.transcripts.slice(-2))
const interim = computed(() => store.interimText)

const savedAtText = computed(() =>
  store.savedAtMs
    ? new Date(store.savedAtMs).toLocaleTimeString('zh-CN', { hour12: false })
    : '',
)

function speakerLabel(speaker: string): string {
  if (speaker === 'user') return '说话人1'
  return store.roleById.get(speaker)?.name ?? speaker
}

function speakerBadgeClass(speaker: string): string {
  if (speaker === 'user') return 'bg-zinc-700/60 text-zinc-300'
  const r = store.roleById.get(speaker)
  return r ? roleColor(r.color).badge : 'bg-zinc-700/60 text-zinc-300'
}

function startTitleEdit(): void {
  titleDraft.value = store.meetingTitle
  titleEditing.value = true
}

function commitTitle(): void {
  const t = titleDraft.value.trim()
  if (t) store.renameByUser(t)
  titleEditing.value = false
}

function startEdit(id: string, text: string): void {
  editingId.value = id
  draftText.value = text
}

function commitEdit(): void {
  if (editingId.value) {
    const t = draftText.value.trim()
    if (t) store.editTranscript(editingId.value, t)
  }
  editingId.value = null
}
</script>

<template>
  <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
    <!-- 识别引擎异常提示 + 诊断日志 -->
    <div
      v-if="store.speechError || store.connLog.length"
      class="mb-2 rounded-lg border px-2.5 py-2 text-[11px] leading-5"
      :class="store.speechError
        ? 'border-amber-600/50 bg-amber-950/40 text-amber-300'
        : 'border-zinc-700/60 bg-zinc-800/30 text-zinc-500'"
    >
      <div v-if="store.speechError">⚠ 实时转写不可用：{{ store.speechError }}</div>
      <div v-for="(l, i) in store.connLog" :key="i" class="font-mono text-[10px] opacity-70">{{ l }}</div>
    </div>

    <!-- 标题行 -->
    <div class="flex items-center gap-1.5">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M4 6h16M4 12h10M4 18h7" stroke-linecap="round" />
      </svg>
      <input
        v-if="titleEditing"
        v-model="titleDraft"
        class="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-medium text-zinc-100 outline-none ring-1 ring-sky-600/50"
        @keydown.enter.prevent="commitTitle"
        @keydown.esc="titleEditing = false"
        @blur="commitTitle"
        placeholder="会议标题"
      />
      <span
        v-else
        class="min-w-0 flex-1 cursor-text truncate text-xs font-medium text-zinc-300"
        :title="store.meetingTitle ? '双击修改标题' : ''"
        @dblclick="startTitleEdit"
      >
        {{ store.meetingTitle || 'AI 将根据内容自动生成标题…' }}
      </span>
      <button
        class="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
        :title="expanded ? '收起记录板' : '展开全部记录'"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起 ▴' : '展开全部 ▾' }}
      </button>
    </div>

    <!-- 最近 2 条预览 -->
    <div v-if="recent.length || interim" class="mt-2 space-y-1">
      <div v-for="item in recent" :key="item.id" class="flex items-start gap-1.5 text-[11px] leading-5">
        <span
          class="shrink-0 rounded px-1 py-0.5 text-[10px] leading-none"
          :class="speakerBadgeClass(item.speaker)"
        >
          {{ speakerLabel(item.speaker) }}
        </span>
        <span class="truncate text-zinc-400">{{ item.text }}</span>
      </div>
      <!-- 正在识别（流式 interim） -->
      <div v-if="interim" class="flex items-start gap-1.5 text-[11px] leading-5">
        <span class="shrink-0 rounded bg-zinc-700/40 px-1 py-0.5 text-[10px] leading-none text-zinc-400">
          说话人1
        </span>
        <span class="truncate italic text-zinc-500">{{ interim }}</span>
        <span class="shrink-0 animate-pulse text-[10px] text-sky-500">识别中</span>
      </div>
    </div>
    <div v-else class="mt-2 text-[11px] text-zinc-600">实时转写结果将显示在这里</div>

    <!-- 底部状态 -->
    <div class="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
      <span>共 {{ store.transcripts.length }} 条 · 按说话人标注</span>
      <span v-if="savedAtText" class="text-emerald-600/80">已自动保存 {{ savedAtText }}</span>
    </div>
  </div>

  <!-- 展开浮层：全部记录 + 编辑 -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="expanded"
        class="fixed bottom-16 left-4 z-40 flex max-h-[70vh] w-[480px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50"
      >
        <!-- 头 -->
        <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <span class="text-xs font-semibold text-zinc-200">会议记录</span>
          <input
            v-if="titleEditing"
            v-model="titleDraft"
            class="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 outline-none ring-1 ring-sky-600/50"
            @keydown.enter.prevent="commitTitle"
            @keydown.esc="titleEditing = false"
            @blur="commitTitle"
          />
          <span
            v-else
            class="min-w-0 flex-1 cursor-text truncate text-xs text-zinc-400"
            title="双击修改标题"
            @dblclick="startTitleEdit"
          >
            {{ store.meetingTitle || 'AI 将根据内容自动生成标题…' }}
          </span>
          <span v-if="savedAtText" class="shrink-0 text-[10px] text-emerald-600/80">
            已自动保存 {{ savedAtText }}
          </span>
          <button
            class="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            @click="expanded = false"
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 全部记录 -->
        <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
          <div v-if="!store.transcripts.length && !interim" class="flex h-32 items-center justify-center text-xs text-zinc-600">
            开始录音后，转写内容将实时出现在这里
          </div>

          <!-- 正在识别（流式 interim） -->
          <div v-if="interim" class="flex items-start gap-2 rounded-lg bg-zinc-800/30 px-2 py-1.5">
            <span class="shrink-0 rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] leading-4 text-zinc-400">
              说话人1
            </span>
            <p class="min-w-0 flex-1 text-xs leading-5 italic text-zinc-500">{{ interim }}</p>
            <span class="shrink-0 animate-pulse text-[10px] text-sky-500">识别中</span>
          </div>

          <div v-for="item in store.transcripts" :key="item.id" class="group">
            <!-- 编辑态 -->
            <div v-if="editingId === item.id" class="rounded-lg border border-sky-500/40 bg-sky-500/5 p-2">
              <textarea
                v-model="draftText"
                class="w-full resize-none bg-transparent text-xs leading-5 text-zinc-100 outline-none"
                rows="3"
                @keydown.enter.prevent="commitEdit"
                @keydown.esc="editingId = null"
              />
              <div class="flex justify-end gap-2 text-[10px]">
                <button class="text-zinc-500 hover:text-zinc-300" @click="editingId = null">取消</button>
                <button class="text-sky-400 hover:text-sky-300" @click="commitEdit">保存 (Enter)</button>
              </div>
            </div>

            <!-- 展示态 -->
            <div
              v-else
              class="flex items-start gap-2 rounded-lg px-2 py-1.5 transition hover:bg-zinc-800/40"
              @click="startEdit(item.id, item.text)"
            >
              <span class="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-zinc-600">
                {{ msToStamp(item.tsMs) }}
              </span>
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none"
                :class="speakerBadgeClass(item.speaker)"
              >
                {{ speakerLabel(item.speaker) }}
              </span>
              <p class="min-w-0 flex-1 text-xs leading-5 text-zinc-200">{{ item.text }}</p>
              <svg
                viewBox="0 0 24 24"
                class="mt-0.5 h-3 w-3 shrink-0 text-zinc-600 opacity-0 transition group-hover:opacity-100"
                fill="none" stroke="currentColor" stroke-width="2"
              >
                <path d="M15.5 5.5l3 3L8 19l-4 1 1-4L15.5 5.5z" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
        </div>

        <!-- 底部说明 -->
        <div class="border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-600">
          点击条目编辑 · 编辑与标题自动保存到本地 · 共 {{ store.transcripts.length }} 条
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
