<script setup lang="ts">
/**
 * 顶栏：品牌标识 + 会议状态 + 会议历史 + 系统设置。
 */
import { useMeetingStore } from '../stores/meeting'
import SystemSettingsModal from './SystemSettingsModal.vue'

const store = useMeetingStore()
</script>

<template>
  <header class="flex shrink-0 items-center gap-4 border-b border-warm-subtle bg-warm-sidebar px-[18px]" style="height: var(--h-topbar);">
    <!-- 品牌 -->
    <div class="flex items-center gap-2.5">
      <div class="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-gradient-to-br from-[#3a6b5a] to-[#2a5a6b] text-[13px] font-bold text-[#e6e2d8]">
        M
      </div>
      <span class="text-[15px] font-semibold text-warm-100">AI 会议监听助手</span>
    </div>

    <!-- 会议状态 -->
    <span v-if="store.state === 'recording'" class="flex items-center gap-1.5 rounded-full px-[11px] py-[3px] text-[12px]" style="background: var(--success-soft); color: var(--success);">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full" style="background: var(--success);" />
      录音中 · {{ store.elapsedText }}
    </span>
    <span v-else-if="store.state === 'closed'" class="text-[12px] text-warm-500">
      已结束 · {{ store.elapsedText }}
    </span>
    <span v-else class="text-[12px] text-warm-600">空闲</span>

    <!-- 右侧按钮组 -->
    <div class="ml-auto flex items-center gap-2">
      <!-- 会议历史 -->
      <button
        v-if="store.view === 'live'"
        class="btn"
        @click="store.setView('history')"
      >
        <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" stroke-linecap="round" />
        </svg>
        会议历史
        <span class="tag">{{ store.history.length }}</span>
      </button>
      <button
        v-else
        class="btn"
        @click="store.setView('live')"
      >
        <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        返回
      </button>

      <!-- 系统设置 -->
      <button
        class="btn"
        @click="store.openSettings()"
      >
        <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        系统设置
      </button>
    </div>
  </header>

  <!-- 系统设置弹窗 -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0 scale-95"
    >
      <SystemSettingsModal
        v-if="store.settingsOpen"
        :initial-role-id="store.settingsInitialRoleId"
        @close="store.closeSettings"
      />
    </Transition>
  </Teleport>
</template>
