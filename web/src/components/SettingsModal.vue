<script setup lang="ts">
/**
 * 设置模态：角色管理（启用/优先级/积极性）、推送周期、会话信息。
 * 角色提示词等深度配置提示走 roles/<id>/（Claude Code 项目目录）。
 */
import { reactive } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { roleColor } from '../composables/roleColor'
import { getVolcConfig, saveVolcConfig } from '../services/volcAsr'

const store = useMeetingStore()
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

// ---- 实时识别引擎配置（localStorage 覆盖内置默认）----
const volc = reactive({
  ...getVolcConfig(),
  configured: getVolcConfig().ready,
})
function saveVolc(): void {
  saveVolcConfig({
    appid: volc.appid.trim(),
    token: volc.token.trim(),
    resourceId: volc.resourceId,
    endpoint: volc.endpoint,
  })
  volc.configured = !!volc.token.trim()
}
function resetVolc(): void {
  localStorage.removeItem('volc-asr:token')
  localStorage.removeItem('volc-asr:appid')
  Object.assign(volc, getVolcConfig(), { configured: true })
}
function pickEngine(engine: 'volc' | 'browser'): void {
  store.setAsrEngine(engine)
}

const AGGRESSIVENESS_LABEL: Record<string, string> = {
  low: '低（很少插话）',
  medium: '中（关键时插话）',
  high: '高（随时质疑）',
}

function toggleRole(roleId: string, enabled: boolean): void {
  const r = store.roles.find((x) => x.id === roleId)
  if (r) r.enabled = enabled
  store.updateConfig({
    roles: store.roles.map((r2) => ({ id: r2.id, enabled: r2.enabled })),
  })
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="props.open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <div class="flex max-h-[80vh] w-[680px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-warm-normal bg-warm-card shadow-2xl">
          <!-- 头 -->
          <div class="flex items-center justify-between border-b border-warm-subtle px-5 py-[14px]">
            <h2 class="text-[15px] font-semibold text-warm-100">会议设置</h2>
            <button class="btn btn-ghost" style="height: 30px; width: 30px; padding: 0;" @click="emit('close')">
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" /></svg>
            </button>
          </div>

          <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-[16px]">
            <!-- 实时识别引擎 -->
            <section>
              <h3 class="mb-2 text-[13px] font-medium text-warm-300">实时识别引擎（用户录音 -> 文字）</h3>
              <div class="segmented">
                <button
                  :class="store.asrEngine === 'volc' ? 'active' : ''"
                  @click="pickEngine('volc')"
                >
                  火山豆包流式（云端 · 按时长计费）
                </button>
                <button
                  :class="store.asrEngine === 'browser' ? 'active' : ''"
                  @click="pickEngine('browser')"
                >
                  浏览器内置（降级）
                </button>
              </div>

              <!-- 火山配置 -->
              <div v-if="store.asrEngine === 'volc'" class="mt-3 space-y-3 rounded-xl border border-warm-subtle bg-warm-input p-[14px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] text-warm-300">已内置默认 Key，开箱即用；下方可覆盖</span>
                  <span class="flex items-center gap-2">
                    <span class="tag" :class="volc.hasCustomToken ? 'tag-info' : ''">
                      {{ volc.hasCustomToken ? '自定义 Key' : '内置默认' }}
                    </span>
                    <button
                      v-if="volc.hasCustomToken"
                      class="btn" style="height: 26px; padding: 0 8px; font-size: 11px;"
                      title="清除自定义，恢复内置默认"
                      @click="resetVolc"
                    >
                      恢复默认
                    </button>
                  </span>
                </div>
                <label class="block">
                  <span class="form-label block text-[12px] text-warm-500">
                    API Key<span class="ml-1 text-info-warm">← 必填，形如 b7d7f640-… 的 UUID</span>
                  </span>
                  <input
                    v-model="volc.token"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    class="input font-mono"
                    placeholder="粘贴你的 API Key（UUID 格式，不是数字串）"
                    @change="saveVolc"
                  />
                </label>
                <label class="block">
                  <span class="form-label block text-[12px] text-warm-500">App ID（选填，纯数字；旧版控制台才需要）</span>
                  <input
                    v-model="volc.appid"
                    class="input font-mono"
                    placeholder="纯数字 App ID，可留空"
                    @change="saveVolc"
                  />
                </label>
                <div v-if="!/^\d+$/.test(volc.appid) && volc.appid" class="text-[12px] text-accent-warm">
                  ⚠ App ID 应为纯数字；你填的内容更像 API Key——请检查两个栏位是否填反
                </div>
                <div v-if="/^\d{6,}$/.test(volc.token)" class="text-[12px] text-accent-warm">
                  ⚠ API Key 应为 UUID 格式（含连字符）；纯数字串通常是 App ID——请检查是否填反
                </div>
                <details class="text-[12px] text-warm-500">
                  <summary class="cursor-pointer select-none py-1">高级（resource id / cluster，默认值适用时长版计费）</summary>
                  <div class="mt-2 space-y-2">
                    <label class="block">
                      <span class="form-label block text-[12px] text-warm-500">Resource ID</span>
                      <input
                        v-model="volc.resourceId"
                        class="input font-mono"
                        @change="saveVolc"
                      />
                    </label>
                    <label class="block">
                      <span class="form-label block text-[12px] text-warm-500">端点（默认双向流式）</span>
                      <input
                        v-model="volc.endpoint"
                        class="input font-mono"
                        @change="saveVolc"
                      />
                    </label>
                  </div>
                </details>
                <p class="text-[11px] leading-5 text-warm-600">
                  默认使用项目内置 Key（仅经本机 gateway 中转）；修改后仅存本机浏览器 localStorage。修改后需重新开始录音生效。
                </p>
              </div>
            </section>

            <!-- 角色管理 -->
            <section>
              <h3 class="mb-2 text-[13px] font-medium text-warm-300">AI 角色</h3>
              <div class="space-y-2">
                <div
                  v-for="role in store.roles"
                  :key="role.id"
                  class="card flex items-center gap-3 p-[12px]"
                  :class="{ 'opacity-50': !role.enabled }"
                  style="min-height: 60px;"
                >
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold" :class="roleColor(role.color).soft + ' ' + roleColor(role.color).border + ' border ' + roleColor(role.color).text">
                    {{ role.name[0] }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-[14px] font-medium text-warm-100">{{ role.name }}</span>
                      <span class="tag">音色 · {{ role.voice }}</span>
                      <span class="tag">优先级 {{ role.priority }}</span>
                      <span class="tag">
                        {{ AGGRESSIVENESS_LABEL[role.interruptAggressiveness] }}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate text-[12px] text-warm-500">{{ role.description }}</p>
                  </div>
                  <button
                    role="switch"
                    :aria-checked="role.enabled"
                    class="switch"
                    :class="{ on: role.enabled }"
                    @click="toggleRole(role.id, !role.enabled)"
                  />
                </div>
              </div>
              <p class="mt-2 text-[12px] leading-5 text-warm-600">
                角色人设提示词、hooks、独立记忆位于项目 <code class="rounded bg-warm-tag px-1 py-0.5">roles/&lt;角色&gt;/</code> 目录（标准 Claude Code 项目），可直接用 Claude Code 编辑。
              </p>
            </section>

            <!-- 会话信息 -->
            <section>
              <h3 class="mb-2 text-[13px] font-medium text-warm-300">当前会话</h3>
              <div class="card p-[14px] text-[13px] text-warm-300">
                <div class="flex justify-between py-1">
                  <span class="text-warm-600">会议 ID</span>
                  <span class="font-mono">{{ store.meetingId || '-' }}</span>
                </div>
                <div v-for="(sid, rid) in store.claudeSessionIds" :key="rid" class="flex justify-between py-1">
                  <span class="text-warm-600">{{ store.roleById.get(rid)?.name ?? rid }} · Claude session</span>
                  <span class="font-mono">{{ sid }}</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
