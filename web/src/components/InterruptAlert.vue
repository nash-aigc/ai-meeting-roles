<script setup lang="ts">
/**
 * 打断提示条（2026-08-27 位置调整）：渲染在打断方对应角色列内、
 * 「AI 生成内容」总标题之下、该角色标题之上；样式保持红色渐变。
 * 10 秒无活动自动收起；语音播放中或队列里还有待播语音时不收起
 * （2026-08-27 修复：语音排队延迟时，提示条不再在语音还没轮到播就被收起——
 * 这就是"明明插话了却没看到红框"的主要原因）。
 */
import { onBeforeUnmount, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'

const store = useMeetingStore()

let dismissTimer: number | null = null

function scheduleDismiss(): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer)
  dismissTimer = window.setTimeout(() => {
    // 语音通道还忙（正在播或队列里还有待播，包括打断自己还在排队）→ 不收起，稍后再查
    if (store.voiceBusy()) {
      scheduleDismiss()
    } else {
      store.dismissInterrupt()
    }
  }, 10000)
}

watch(
  () => store.activeInterrupt?.id,
  (id) => {
    if (id) scheduleDismiss()
    else if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  },
)

onBeforeUnmount(() => {
  if (dismissTimer !== null) clearTimeout(dismissTimer)
})
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="-translate-y-2 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="-translate-y-2 opacity-0"
  >
    <div
      v-if="store.activeInterrupt"
      class="alert-pulse relative m-1 flex items-start gap-2 rounded-lg border border-red-500/70 bg-gradient-to-r from-red-950 via-red-900/80 to-red-950 px-2.5 py-2"
    >
      <!-- 图标 -->
      <div class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600/30">
        <svg viewBox="0 0 24 24" class="h-4 w-4 animate-pulse text-red-400" fill="currentColor">
          <path d="M12 2L1 21h22L12 2zm0 6l7.5 12h-15L12 8zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z" />
        </svg>
      </div>

      <!-- 内容 -->
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs font-bold text-red-300">
            {{ store.roleById.get(store.activeInterrupt.role)?.name ?? 'AI' }} 打断
          </span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
            :class="{
              'bg-red-600 text-white': store.activeInterrupt.urgency === 'high',
              'bg-red-500/40 text-red-200': store.activeInterrupt.urgency !== 'high',
            }"
          >
            {{ store.activeInterrupt.urgency === 'high' ? '紧急' : '插话' }}
          </span>
          <!-- 语音播放/排队指示 -->
          <span
            v-if="store.ttsActiveRole === store.activeInterrupt.role"
            class="flex items-end gap-0.5"
            title="语音播放中"
          >
            <span class="h-2 w-0.5 animate-pulse bg-red-400" style="animation-delay: 0ms" />
            <span class="h-3.5 w-0.5 animate-pulse bg-red-400" style="animation-delay: 150ms" />
            <span class="h-1.5 w-0.5 animate-pulse bg-red-400" style="animation-delay: 300ms" />
            <span class="ml-1 text-[10px] text-red-300">语音播放中</span>
          </span>
          <span v-else-if="store.voiceBusy()" class="text-[10px] text-red-300/70">
            排队等待语音…
          </span>
        </div>
        <p class="mt-1 text-xs leading-5 text-red-50">{{ store.activeInterrupt.text }}</p>
      </div>

      <!-- 关闭 -->
      <button
        class="shrink-0 rounded-lg p-1 text-red-300/70 transition hover:bg-red-500/20 hover:text-red-200"
        @click="store.dismissInterrupt()"
      >
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </Transition>
</template>
