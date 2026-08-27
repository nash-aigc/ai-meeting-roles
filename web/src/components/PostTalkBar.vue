<script setup lang="ts">
/**
 * 底栏：会议状态提示。会议只有开始/结束两态，结束后无持续交互。
 */
import { useMeetingStore } from '../stores/meeting'

const store = useMeetingStore()
</script>

<template>
  <footer class="flex h-14 shrink-0 items-center gap-3 border-t border-zinc-800/80 bg-zinc-950/80 px-4">
    <template v-if="store.state === 'recording'">
      <span class="flex items-center gap-2 text-xs text-zinc-500">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
        会议进行中 · 直接说话即可，AI 角色正在实时聆听
      </span>
      <span v-if="store.ttsError" class="text-[11px] text-amber-500/80">{{ store.ttsError }}</span>
    </template>

    <template v-else-if="store.state === 'closed'">
      <span class="text-xs text-zinc-600">
        会议已结束并归档 · 点击左栏「新建会议」重新开始
      </span>
    </template>

    <template v-else>
      <span class="text-xs text-zinc-600">
        点击左栏红色按钮开始会议 -- 转写、AI 角色、语音打断将实时呈现
      </span>
    </template>
  </footer>
</template>
