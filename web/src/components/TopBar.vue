<script setup lang="ts">
/**
 * 简化顶栏：品牌标识 + 会议历史入口 + 设置入口。
 * AI 控制（持续监听/打断模式/TTS）已移至右侧 RoleBar。
 */
import { useMeetingStore } from '../stores/meeting'

const store = useMeetingStore()
</script>

<template>
  <header class="flex h-13 shrink-0 items-center gap-4 border-b border-zinc-800/80 bg-zinc-950/80 px-4 backdrop-blur">
    <!-- 品牌 -->
    <div class="flex items-center gap-2">
      <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-sky-600 text-xs font-bold text-white">
        M
      </div>
      <span class="text-sm font-semibold text-zinc-100">AI 会议监听助手</span>
    </div>

    <!-- 会议状态 -->
    <span v-if="store.state === 'recording'" class="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-400">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      录音中 · {{ store.elapsedText }}
    </span>
    <span v-else-if="store.state === 'closed'" class="text-[11px] text-zinc-500">
      已结束 · {{ store.elapsedText }}
    </span>
    <span v-else class="text-[11px] text-zinc-600">空闲</span>

    <!-- 会议历史 -->
    <button
      v-if="store.view === 'live'"
      class="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
      @click="store.setView('history')"
    >
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" stroke-linecap="round" />
      </svg>
      会议历史
      <span class="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">{{ store.history.length }}</span>
    </button>
    <button
      v-else
      class="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
      @click="store.setView('live')"
    >
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      返回
    </button>
  </header>
</template>