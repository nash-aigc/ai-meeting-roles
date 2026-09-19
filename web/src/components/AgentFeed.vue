<script setup lang="ts">
/**
 * AI 角色观点流：每个启用角色一列，按角色数自适应分栏。
 * 每个角色列：
 * - 打断提示条（打断方一侧，「AI 生成内容」下方、角色标题上方）
 * - 角色列表头：名称 + 该角色的独立控件——
 *   语音喇叭 / 可打断-不打扰 / 角色开关（全部放在该角色这一行的标题栏上，不放顶部）
 * - 运行状态时间线：启动中 → 会话创建 → 模型就绪 → 已发送 → 生成中/完成
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

// 状态时间线定义
const TIMELINE_STEPS = [
  { key: 'starting', label: '启动' },
  { key: 'session', label: '会话' },
  { key: 'ready', label: '就绪' },
  { key: 'sent', label: '发送' },
  { key: 'receiving', label: '生成' },
]

function getStepIndex(state: string): number {
  const order = ['starting', 'session', 'ready', 'sent', 'receiving', 'done']
  const idx = order.indexOf(state)
  return idx < 0 ? 0 : idx
}

function roleStateOf(roleId: string) {
  return store.roleStates[roleId] || { state: '', detail: '' }
}

// ---- per-role 控件 ----
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
  <div class="card flex h-full min-h-0 flex-col overflow-hidden">
    <div class="flex items-center justify-between border-b border-warm-subtle px-4 py-[11px]" style="min-height: 44px;">
      <span class="text-[14px] font-semibold text-warm-300">AI 生成内容</span>
      <span class="text-[12px] text-warm-500">{{ activeRoles.length }} 个角色活跃 · 语音按队列依次播放</span>
    </div>

    <!-- 动态分栏：最多3列，超出时换行滚动 -->
    <div
      v-if="activeRoles.length"
      class="grid min-h-0 flex-1 gap-[10px] overflow-y-auto p-[12px]"
      :style="{
        gridTemplateColumns: `repeat(${Math.min(activeRoles.length, 3)}, 1fr)`,
      }"
    >
      <div
        v-for="role in activeRoles"
        :key="role.id"
        class="flex min-h-[160px] flex-col overflow-hidden rounded-lg border border-warm-subtle bg-warm-input"
      >
        <!-- 打断提示条：打断方一侧 -->
        <InterruptAlert v-if="store.activeInterrupt?.role === role.id" />

        <!-- 角色列头：名称 + 该角色独立控件 -->
        <div class="flex flex-wrap items-center gap-2 border-b border-warm-subtle px-3 py-[12px]" style="min-height: 56px;">
          <span class="h-2.5 w-2.5 rounded-full" :class="roleColor(role.color).dot" />
          <span class="mr-1 text-[14px] font-semibold text-warm-100">{{ role.name }}</span>
          <span
            v-if="store.ttsActiveRole === role.id"
            class="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
            style="background: var(--danger-soft); color: var(--danger);"
          >
            <span class="h-1 w-1 animate-pulse rounded-full" style="background: var(--danger);" />说话中
          </span>

          <!-- 右侧控件组：语音喇叭 + 可打断/不打扰 + 角色开关 -->
          <div class="ml-auto flex items-center gap-2">
            <!-- 该角色语音开关 -->
            <button
              class="rounded p-1 transition"
              :class="role.ttsEnabled ? 'text-info-warm' : 'text-warm-600 hover:text-warm-300'"
              :title="role.ttsEnabled ? '语音播放：开（点按关闭）' : '语音播放：关（点按开启）'"
              @click="toggleRoleTts(role)"
            >
              <svg viewBox="0 0 24 24" class="h-[16px] w-[16px]" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z" stroke-linejoin="round" />
                <path v-if="role.ttsEnabled" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke-linecap="round" />
                <path v-else d="M22 9l-6 6M16 9l6 6" stroke-linecap="round" />
              </svg>
            </button>
            <!-- 可打断 / 不打扰 -->
            <button
              class="rounded-full px-2.5 py-1 text-[11px] transition"
              :class="role.interruptEnabled
                ? 'tag-danger'
                : 'tag'"
              :style="role.interruptEnabled ? 'background: var(--danger-soft); color: var(--danger);' : ''"
              :title="role.interruptEnabled ? '可打断：该角色可以插话打断（点按切换）' : '不打扰：该角色不会插话（点按切换）'"
              @click="toggleRoleInterrupt(role)"
            >
              {{ role.interruptEnabled ? '可打断' : '不打扰' }}
            </button>
            <!-- 角色开关 -->
            <button
              role="switch"
              :aria-checked="role.enabled"
              class="switch"
              :class="{ on: role.enabled }"
              :title="role.enabled ? '角色开启中（点按关闭）' : '角色已关闭'"
              @click="toggleRoleEnabled(role)"
            />
          </div>
        </div>

        <!-- 运行状态时间线 -->
        <div class="border-b border-warm-subtle bg-warm-deepest/50 px-3 py-[10px]">
          <div class="flex items-center justify-between">
            <div
              v-for="(step, idx) in TIMELINE_STEPS"
              :key="step.key"
              class="flex flex-1 flex-col items-center"
            >
              <div class="flex w-full items-center">
                <!-- 连接线 -->
                <div
                  class="h-[2px] flex-1"
                  :class="idx > 0 && getStepIndex(roleStateOf(role.id).state) >= idx ? 'bg-accent-warm' : 'bg-warm-normal'"
                />
                <!-- 节点圆点 -->
                <div
                  class="relative flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border-2"
                  :class="getStepIndex(roleStateOf(role.id).state) >= idx
                    ? 'border-accent-warm bg-accent-warm'
                    : 'border-warm-normal bg-warm-input'"
                >
                  <div
                    v-if="getStepIndex(roleStateOf(role.id).state) === idx && roleStateOf(role.id).state !== 'done' && roleStateOf(role.id).state !== 'error'"
                    class="absolute h-[14px] w-[14px] animate-ping rounded-full opacity-40"
                    style="background: var(--accent);"
                  />
                </div>
                <!-- 连接线 -->
                <div
                  class="h-[2px] flex-1"
                  :class="idx < TIMELINE_STEPS.length - 1 && getStepIndex(roleStateOf(role.id).state) > idx ? 'bg-accent-warm' : 'bg-warm-normal'"
                />
              </div>
              <span
                class="mt-1 text-[10px]"
                :class="getStepIndex(roleStateOf(role.id).state) >= idx ? 'text-accent-warm' : 'text-warm-600'"
              >{{ step.label }}</span>
            </div>
          </div>
          <!-- 状态详情 -->
          <div v-if="roleStateOf(role.id).detail" class="mt-1 text-center text-[11px] text-warm-500">
            <span v-if="roleStateOf(role.id).state === 'error'" class="text-danger-warm">{{ roleStateOf(role.id).detail }}</span>
            <span v-else>{{ roleStateOf(role.id).detail }}</span>
          </div>
        </div>

        <!-- 事件卡片 -->
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-[12px]">
          <div v-if="!eventsOf(role.id).length" class="flex h-full items-center justify-center px-2 text-center text-[13px] leading-5 text-warm-600">
            {{ role.description }}
          </div>

          <div
            v-for="ev in eventsOf(role.id)"
            :key="ev.id"
            class="slide-in rounded-lg border p-[10px] text-[13px] leading-[1.65]"
            :class="
              ev.type === 'interrupt' && ev.executed
                ? 'border-danger-warm/50'
                : ev.type === 'interrupt'
                  ? 'border-accent-warm/40'
                  : ev.type === 'listen'
                    ? 'border-warm-normal'
                    : roleColor(role.color).border
            "
            :style="
              ev.type === 'interrupt' && ev.executed
                ? 'background: var(--danger-soft);'
                : ev.type === 'interrupt'
                  ? 'background: var(--accent-soft);'
                  : ev.type === 'listen'
                    ? 'background: var(--bg-tag);'
                    : roleColor(role.color).soft
            "
          >
            <div class="mb-1 flex items-center justify-between">
              <span
                v-if="ev.type === 'interrupt' && ev.executed"
                class="rounded px-1.5 py-0.5 text-[11px] font-medium"
                style="color: var(--danger);"
                :class="{ 'animate-pulse': store.ttsActiveRole === role.id }"
              >
                ⚠ 已插话{{ store.ttsActiveRole === role.id ? ' · 语音播放中' : '' }}
              </span>
              <span v-else-if="ev.type === 'interrupt'" class="tag tag-accent">
                想打断（未执行）
              </span>
              <span v-else-if="ev.type === 'listen'" class="tag">
                再听听
              </span>
              <span
                v-else
                class="tag"
                :class="ev.type === 'reply' ? 'tag-info' : roleColor(role.color).badge"
              >
                {{ ev.type === 'reply' ? '回复' : '观点' }}
              </span>
              <span class="font-mono text-[11px] text-warm-600">{{ msToStamp(ev.tsMs) }}</span>
            </div>
            <p :class="ev.type === 'listen' ? 'text-warm-300' : 'text-warm-100'">{{ ev.text }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态：无角色开启 -->
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-[20px] text-center">
      <svg viewBox="0 0 24 24" class="h-10 w-10 text-warm-600" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div>
        <p class="text-[14px] text-warm-300">暂无开启的角色</p>
        <p class="mt-1 text-[12px] text-warm-600">在上方角色栏中开启角色开关，AI 生成内容将显示在这里</p>
      </div>
    </div>
  </div>
</template>
