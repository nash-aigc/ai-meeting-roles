<script setup lang="ts">
/**
 * 顶部全局控制栏：
 * - 第一行：AI 总开关 + 语音播放总开关
 * - 第二行：所有角色列表，每个角色带编辑按钮和开关
 * 角色开关控制该角色是否在下方 AgentFeed 中显示，默认全部关闭。
 * 编辑按钮打开系统设置弹窗并定位到对应角色。
 */
import { useMeetingStore } from '../stores/meeting'
import { roleColor } from '../composables/roleColor'
import type { RoleInfo } from '../types/protocol'

const store = useMeetingStore()

function toggleRoleEnabled(role: RoleInfo): void {
  store.updateConfig({ roles: [{ id: role.id, enabled: !role.enabled }] })
}

function editRole(roleId: string): void {
  store.openSettings(roleId)
}
</script>

<template>
  <div class="card flex flex-col gap-[12px] px-4 py-[12px]" style="min-height: auto;">
    <!-- 第一行：全局开关 -->
    <div class="flex items-center gap-5">
      <label class="flex cursor-pointer items-center gap-2">
        <span class="text-[13px] text-warm-300">AI 总开关</span>
        <button
          role="switch"
          :aria-checked="store.config.aiListen"
          class="switch"
          :class="{ on: store.config.aiListen }"
          @click="store.updateConfig({ aiListen: !store.config.aiListen })"
        />
      </label>

      <label class="flex cursor-pointer items-center gap-2">
        <span class="text-[13px] text-warm-300">语音播放</span>
        <button
          role="switch"
          :aria-checked="store.config.ttsPlayback"
          class="switch"
          :class="{ on: store.config.ttsPlayback }"
          @click="store.updateConfig({ ttsPlayback: !store.config.ttsPlayback })"
        />
      </label>
    </div>

    <!-- 分割线 -->
    <div class="h-px w-full" style="background: var(--border-subtle);"></div>

    <!-- 第二行：所有角色列表 -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div
        v-for="role in store.roles"
        :key="role.id"
        class="flex items-center gap-2 rounded-lg px-2 py-1 transition"
        :class="role.enabled ? 'bg-warm-selected' : ''"
      >
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="roleColor(role.color).dot" />
        <span
          class="text-[13px]"
          :class="role.enabled ? 'text-warm-100 font-medium' : 'text-warm-500'"
        >
          {{ role.name }}
        </span>
        <!-- 编辑按钮 -->
        <button
          class="flex h-[26px] w-[26px] items-center justify-center rounded transition hover:bg-warm-tag hover:text-warm-100"
          :class="role.enabled ? 'text-warm-300' : 'text-warm-600'"
          title="编辑角色"
          @click="editRole(role.id)"
        >
          <svg viewBox="0 0 24 24" class="h-[13px] w-[13px]" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 20h9" stroke-linecap="round" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <!-- 角色开关 -->
        <button
          role="switch"
          :aria-checked="role.enabled"
          class="switch"
          :class="{ on: role.enabled }"
          :title="role.enabled ? '关闭该角色' : '开启该角色'"
          @click="toggleRoleEnabled(role)"
        />
      </div>
    </div>
  </div>
</template>
