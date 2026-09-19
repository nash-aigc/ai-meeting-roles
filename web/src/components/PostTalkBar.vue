<script setup lang="ts">
/**
 * 会后交流底部提示条：录音结束后显示状态提示。
 */
import { useMeetingStore } from '../stores/meeting'

const store = useMeetingStore()
</script>

<template>
  <div
    v-if="store.state === 'closed'"
    class="flex shrink-0 items-center gap-3 border-t border-warm-subtle bg-warm-sidebar px-[14px] py-[10px]"
    style="min-height: 52px;"
  >
    <span class="flex items-center gap-1.5 text-[13px] text-warm-300">
      <span class="dot dot-accent"></span>
      录音已结束 · 会议已归档
    </span>
    <span class="ml-auto text-[12px] text-warm-500">
      可在「会议历史」中查看回放与转写
    </span>
  </div>
</template>
