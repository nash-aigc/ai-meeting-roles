<script setup lang="ts">
/**
 * 顶部全局控制栏（2026-08-27 精简）：
 * - AI 总开关 + 语音播放总开关：同一行，置于最左侧（用户要求保留在顶部）
 * - 角色管理按钮：靠右
 * 其余配置已下沉：角色开关/角色语音/可打断模式 → AgentFeed 各角色列头。
 */
import { ref } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import RoleManagerModal from './RoleManagerModal.vue'

const store = useMeetingStore()
const showManager = ref(false)

function openManager(): void {
  showManager.value = true
}

function closeManager(): void {
  showManager.value = false
}
</script>

<template>
  <div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
    <!-- 左侧：AI 总开关 + 语音播放总开关，同一行并列（2026-08-27 用户确认保留顶部） -->
    <div class="flex items-center gap-5">
      <label class="flex cursor-pointer items-center gap-2">
        <span class="text-xs text-zinc-500">AI 总开关</span>
        <button
          role="switch"
          :aria-checked="store.config.aiListen"
          class="relative h-5.5 w-10 rounded-full transition"
          :class="store.config.aiListen ? 'bg-emerald-600' : 'bg-zinc-700'"
          @click="store.updateConfig({ aiListen: !store.config.aiListen })"
        >
          <span
            class="absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all"
            :class="store.config.aiListen ? 'left-5' : 'left-0.5'"
          />
        </button>
      </label>

      <label class="flex cursor-pointer items-center gap-2">
        <span class="text-xs text-zinc-500">语音播放</span>
        <button
          role="switch"
          :aria-checked="store.config.ttsPlayback"
          class="relative h-5.5 w-10 rounded-full transition"
          :class="store.config.ttsPlayback ? 'bg-sky-600' : 'bg-zinc-700'"
          @click="store.updateConfig({ ttsPlayback: !store.config.ttsPlayback })"
        >
          <span
            class="absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all"
            :class="store.config.ttsPlayback ? 'left-5' : 'left-0.5'"
          />
        </button>
      </label>
    </div>

    <!-- 右侧：角色管理 -->
    <button
      class="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
      @click="openManager"
    >
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      角色管理
    </button>
  </div>

  <!-- 角色管理弹窗 -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0 scale-95"
    >
      <RoleManagerModal v-if="showManager" @close="closeManager" />
    </Transition>
  </Teleport>
</template>
