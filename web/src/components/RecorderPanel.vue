<script setup lang="ts">
/**
 * 录音工作台（左侧面板）：
 * - 顶部标题栏：会议标题（可编辑）+ 当前状态（录音状态/Claude 模型/会话 ID 参数）
 * - 录音控制：开始/暂停/继续 + 结束 + 计时
 * - 实时转写
 * 语音识别设置已移至「系统设置」弹窗。
 */
import { ref } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import TranscriptPanel from './TranscriptPanel.vue'

const store = useMeetingStore()
const paramsExpanded = ref(false)

// 会议标题编辑
const titleEditing = ref(false)
const titleDraft = ref('')

function startTitleEdit(): void {
  titleDraft.value = store.meetingTitle
  titleEditing.value = true
}

function commitTitle(): void {
  store.setMeetingTitle(titleDraft.value)
  titleEditing.value = false
}

function toggleRecording(): void {
  if (store.state === 'idle') {
    void store.start()
  } else if (store.state === 'recording') {
    store.pause()
  } else if (store.state === 'paused') {
    store.resume()
  }
}

function stopRecording(): void {
  if (store.state !== 'idle') store.stop()
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}
</script>

<template>
  <aside class="flex w-[380px] min-w-0 flex-col gap-[10px] border-r border-warm-subtle bg-warm-sidebar p-[14px]">
    <!-- ===== 顶部标题栏 ===== -->
    <div class="card overflow-hidden">
      <!-- 会议标题（可编辑） -->
      <div class="flex items-center gap-2.5 border-b border-warm-subtle px-[14px] py-[12px]" style="min-height: 48px;">
        <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-warm-500" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke-linecap="round" />
        </svg>
        <input
          v-if="titleEditing"
          v-model="titleDraft"
          class="input min-w-0 flex-1"
          placeholder="输入会议标题…"
          @keydown.enter.prevent="commitTitle"
          @keydown.esc="titleEditing = false"
          @blur="commitTitle"
        />
        <button
          v-else
          class="min-w-0 flex-1 truncate text-left text-[14px] font-medium text-warm-100 transition hover:text-accent-warm"
          title="点击编辑标题"
          @click="startTitleEdit"
        >
          {{ store.meetingTitle || '未命名会议（点击编辑）' }}
        </button>
      </div>

      <!-- 当前功能状态行 -->
      <div class="flex items-center gap-3 px-[14px] py-[9px] text-[12px]" style="min-height: 38px;">
        <span class="flex items-center gap-1.5 text-warm-300">
          <span class="dot" :class="store.state === 'recording' ? 'dot-success' : store.state === 'paused' ? 'dot-accent' : 'dot-muted'"></span>
          {{ store.state === 'idle' ? '待机' : store.state === 'recording' ? '录音中' : store.state === 'paused' ? '已暂停' : '已结束' }}
        </span>
        <span class="flex items-center gap-1.5 text-warm-500">
          <span class="dot dot-accent"></span>
          语音识别 {{ store.asrEngine === 'volc' ? '火山' : '浏览器' }}
        </span>
        <button
          class="ml-auto flex items-center gap-1 text-warm-500 transition hover:text-warm-300"
          @click="paramsExpanded = !paramsExpanded"
        >
          参数
          <svg
            viewBox="0 0 24 24"
            class="h-3 w-3 transition"
            :class="paramsExpanded ? 'rotate-180' : ''"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- 参数详情（折叠）：Claude 模型 / 会话 ID -->
      <div v-if="paramsExpanded" class="space-y-2 border-t border-warm-subtle px-[14px] py-[10px] text-[11px]">
        <!-- Claude 模型 -->
        <div>
          <span class="text-warm-500">Claude 模型</span>
          <div class="mt-1 space-y-1">
            <div v-for="(mdl, rid) in store.claudeModels" :key="rid" class="flex items-center gap-2">
              <span class="tag">{{ store.roleById.get(rid)?.name ?? rid }}</span>
              <span class="font-mono text-warm-300">{{ mdl }}</span>
            </div>
            <div v-if="!Object.keys(store.claudeModels).length" class="text-warm-600">会议开始后显示</div>
          </div>
        </div>
        <!-- Claude 会话 ID -->
        <div>
          <span class="text-warm-500">Claude 会话 ID</span>
          <div class="mt-1 space-y-1">
            <div v-for="(sid, rid) in store.claudeSessionIds" :key="rid" class="flex items-center gap-2">
              <span class="tag">{{ store.roleById.get(rid)?.name ?? rid }}</span>
              <span class="max-w-[200px] truncate font-mono text-warm-500" :title="String(sid)">{{ sid }}</span>
              <button
                class="shrink-0 text-warm-600 transition hover:text-warm-300"
                title="复制"
                @click="copyText(String(sid))"
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <div v-if="!Object.keys(store.claudeSessionIds).length" class="text-warm-600">会议开始后显示</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 录音控制（开始/暂停/继续 + 结束 + 计时）===== -->
    <div class="card flex items-center gap-[14px] p-[16px]" style="min-height: 84px;">
      <!-- 主按钮 -->
      <button
        class="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-full transition"
        :class="store.state === 'recording'
          ? 'bg-[#d4a85c] shadow-lg shadow-[#d4a85c]/30 hover:bg-[#ddb46a]'
          : 'bg-success-warm hover:brightness-110'"
        :style="store.state !== 'recording' ? 'box-shadow: 0 2px 14px rgba(122,171,122,.3);' : ''"
        :title="store.state === 'idle' ? '开始录音' : store.state === 'recording' ? '暂停录音' : '恢复录音'"
        @click="toggleRecording"
      >
        <svg v-if="store.state === 'recording'" viewBox="0 0 24 24" class="h-[22px] w-[22px] text-white" fill="currentColor">
          <rect x="7" y="5" width="4" height="14" rx="1" />
          <rect x="13" y="5" width="4" height="14" rx="1" />
        </svg>
        <svg v-else-if="store.state === 'paused'" viewBox="0 0 24 24" class="h-[22px] w-[22px] text-white" fill="currentColor">
          <path d="M8 5.14v13.72c0 .8.87 1.3 1.57.9l11.1-6.86a1.05 1.05 0 0 0 0-1.8L9.57 4.24A1.05 1.05 0 0 0 8 5.14z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="h-[22px] w-[22px] text-white" fill="currentColor">
          <path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z" />
          <path d="M6 14h12v1a6 6 0 0 1-12 0v-1z" />
        </svg>
      </button>

      <!-- 结束按钮 -->
      <button
        v-if="store.state === 'recording' || store.state === 'paused'"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition"
        style="background: var(--bg-tag); color: var(--text-secondary);"
        title="结束录音"
        @mouseenter="($event.target as HTMLElement).style.cssText = 'background: var(--danger-soft); color: var(--danger);'"
        @mouseleave="($event.target as HTMLElement).style.cssText = 'background: var(--bg-tag); color: var(--text-secondary);'"
        @click="stopRecording"
      >
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        </svg>
      </button>

      <div class="flex flex-col gap-0.5">
        <span class="font-mono text-[28px] font-bold leading-[1.1] tracking-wider" :class="store.state === 'recording' ? 'text-[#d4a85c]' : store.state === 'paused' ? 'text-warm-500' : 'text-warm-100'">
          {{ store.elapsedText }}
        </span>
        <span class="text-[12px] text-warm-500">
          {{ store.state === 'idle' ? '准备就绪' : store.state === 'recording' ? '正在录音·识别中' : store.state === 'paused' ? '已暂停·不识别' : '录音已结束' }}
        </span>
      </div>
    </div>

    <!-- ===== 实时转写（剩余空间）===== -->
    <div class="flex min-h-0 flex-1 flex-col">
      <TranscriptPanel />
    </div>
  </aside>
</template>
