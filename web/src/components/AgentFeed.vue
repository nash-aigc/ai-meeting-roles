<script setup lang="ts">
/**
 * AI 角色观点流：每个启用角色一列，按角色数自适应分栏。
 * 每个角色列：
 * - 打断提示条（打断方一侧，「AI 生成内容」下方、角色标题上方）
 * - 角色列表头（2026-08-27 调整）：名称 + 该角色的独立控件——
 *   语音喇叭 / 可打断-不打扰 / 角色开关（全部放在该角色这一行的标题栏上，不放顶部）
 * - 事件卡片：listen 再听听 / observe 观点 / reply 回复 / interrupt 打断
 */
import { computed } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { msToStamp, roleColor } from '../composables/roleColor'
import InterruptAlert from './InterruptAlert.vue'
import type { RoleInfo } from '../types/protocol'

const store = useMeetingStore()

const activeRoles = computed(() => store.roles.filter(r => r.enabled))

function eventsOf(roleId: string) {
  return store.agentEvents.filter((e) => e.role === roleId).slice().reverse()
}

// ---- per-role 控件（2026-08-27：从顶部 RoleBar 移到各角色列头） ----
function toggleRoleEnabled(role: RoleInfo): void {
  store.updateConfig({ roles: [{ id: role.id, enabled: !role.enabled }] })
}
function toggleRoleTts(role: RoleInfo): void {
  store.updateConfig({ roles: [{ id: role.id, ttsEnabled: !role.ttsEnabled }] })
}
function toggleRoleInterrupt(role: RoleInfo): void {
  store.updateConfig({ roles: [{ id: role.id, interruptEnabled: !role.interruptEnabled }] })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
    <div class="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5">
      <span class="text-xs font-medium text-zinc-400">AI 生成内容</span>
      <span class="text-[11px] text-zinc-600">{{ activeRoles.length }} 个角色活跃 · 语音按队列依次播放</span>
    </div>

    <!-- 动态分栏 -->
    <div
      class="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2"
      :style="{
        gridTemplateColumns: activeRoles.length <= 4
          ? `repeat(${Math.max(1, activeRoles.length)}, 1fr)`
          : undefined,
      }"
    >
      <div
        v-for="role in activeRoles"
        :key="role.id"
        class="flex min-h-40 flex-col rounded-lg border border-zinc-800/70 bg-zinc-950/40"
      >
        <!-- 打断提示条：打断方一侧（「AI 生成内容」下方、该角色标题上方） -->
        <InterruptAlert v-if="store.activeInterrupt?.role === role.id" />

        <!-- 角色列头：名称 + 该角色独立控件（语音/可打断/开关，全在这一行） -->
        <div class="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/70 px-3 py-2">
          <span class="h-2.5 w-2.5 rounded-full" :class="roleColor(role.color).dot" />
          <span class="mr-1 text-sm font-semibold text-zinc-200">{{ role.name }}</span>
          <span
            v-if="store.ttsActiveRole === role.id"
            class="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400"
          >
            <span class="h-1 w-1 animate-pulse rounded-full bg-red-400" />说话中
          </span>

          <!-- 右侧控件组：语音喇叭 + 可打断/不打扰 + 角色开关 -->
          <div class="ml-auto flex items-center gap-1.5">
            <!-- 该角色语音开关 -->
            <button
              class="rounded p-1 transition"
              :class="role.ttsEnabled ? 'text-sky-400' : 'text-zinc-600 hover:text-zinc-400'"
              :title="role.ttsEnabled ? '语音播放：开（点按关闭）' : '语音播放：关（点按开启）'"
              @click="toggleRoleTts(role)"
            >
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z" stroke-linejoin="round" />
                <path v-if="role.ttsEnabled" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke-linecap="round" />
                <path v-else d="M22 9l-6 6M16 9l6 6" stroke-linecap="round" />
              </svg>
            </button>
            <!-- 可打断 / 不打扰（按角色独立，默认不打扰） -->
            <button
              class="rounded-full px-2 py-0.5 text-[10px] transition"
              :class="role.interruptEnabled
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'"
              :title="role.interruptEnabled ? '可打断：该角色可以插话打断（点按切换）' : '不打扰：该角色不会插话（点按切换）'"
              @click="toggleRoleInterrupt(role)"
            >
              {{ role.interruptEnabled ? '可打断' : '不打扰' }}
            </button>
            <!-- 角色开关 -->
            <button
              role="switch"
              :aria-checked="role.enabled"
              class="relative h-4 w-7 rounded-full transition"
              :class="role.enabled ? 'bg-emerald-600' : 'bg-zinc-700'"
              :title="role.enabled ? '角色开启中（点按关闭）' : '角色已关闭'"
              @click="toggleRoleEnabled(role)"
            >
              <span
                class="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all"
                :class="role.enabled ? 'left-3.5' : 'left-0.5'"
              />
            </button>
          </div>
        </div>

        <!-- 事件卡片 -->
        <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          <div v-if="!eventsOf(role.id).length" class="flex h-full items-center justify-center px-2 text-center text-[11px] leading-5 text-zinc-600">
            {{ role.description }}
          </div>

          <div
            v-for="ev in eventsOf(role.id)"
            :key="ev.id"
            class="slide-in rounded-lg border p-2.5 text-xs leading-5"
            :class="
              ev.type === 'interrupt' && ev.executed
                ? 'border-red-500/50 bg-red-500/10'
                : ev.type === 'interrupt'
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : ev.type === 'listen'
                    ? 'border-zinc-700/60 bg-zinc-800/30'
                    : roleColor(role.color).border + ' ' + roleColor(role.color).soft
            "
          >
            <div class="mb-1 flex items-center justify-between">
              <span
                v-if="ev.type === 'interrupt' && ev.executed"
                class="rounded px-1.5 py-0.5 text-[10px] text-red-300"
                :class="{ 'animate-pulse': store.ttsActiveRole === role.id }"
              >
                ⚠ 已插话{{ store.ttsActiveRole === role.id ? ' · 语音播放中' : '' }}
              </span>
              <span v-else-if="ev.type === 'interrupt'" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                想打断（未执行）
              </span>
              <span v-else-if="ev.type === 'listen'" class="rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-300">
                再听听
              </span>
              <span
                v-else
                class="rounded px-1.5 py-0.5 text-[10px]"
                :class="ev.type === 'reply' ? 'bg-sky-500/15 text-sky-300' : roleColor(role.color).badge"
              >
                {{ ev.type === 'reply' ? '回复' : '观点' }}
              </span>
              <span class="font-mono text-[10px] text-zinc-600">{{ msToStamp(ev.tsMs) }}</span>
            </div>
            <p :class="ev.type === 'listen' ? 'text-zinc-400' : 'text-zinc-200'">{{ ev.text }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
