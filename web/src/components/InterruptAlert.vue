<script setup lang="ts">
/**
 * 打断提示条：显示在 AgentFeed 对应角色列的顶部。
 * 当某个 AI 角色发起 interrupt 时，在该角色列显示醒目的提示。
 */
import { useMeetingStore } from '../stores/meeting'

const store = useMeetingStore()
</script>

<template>
  <div
    v-if="store.activeInterrupt"
    class="flex items-center gap-2 px-3 py-[8px] text-[12px]"
    style="background: var(--danger-soft); color: var(--danger); border-bottom: 1px solid var(--danger);"
  >
    <span class="h-2 w-2 animate-pulse rounded-full" style="background: var(--danger);" />
    <span class="font-medium">
      {{ store.activeInterrupt.executed ? '已插话打断' : '请求打断（等待执行）' }}
    </span>
    <span class="ml-auto truncate text-[11px] opacity-80">
      {{ store.activeInterrupt.text }}
    </span>
  </div>
</template>
