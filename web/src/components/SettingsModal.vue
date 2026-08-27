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
  // 填的内容与内置默认相同 -> 清掉 localStorage（跟随内置）
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
  // 本地立即生效（服务端会回 roles.list 校准）
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
        <div class="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <!-- 头 -->
          <div class="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
            <h2 class="text-sm font-semibold text-zinc-100">会议设置</h2>
            <button class="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300" @click="emit('close')">
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" /></svg>
            </button>
          </div>

          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <!-- 实时识别引擎 -->
            <section>
              <h3 class="mb-2 text-xs font-medium text-zinc-400">实时识别引擎（用户录音 -> 文字）</h3>
              <div class="flex rounded-lg bg-zinc-950 p-0.5 ring-1 ring-zinc-800">
                <button
                  class="flex-1 rounded-md px-3 py-1.5 text-xs transition"
                  :class="store.asrEngine === 'volc'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'"
                  @click="pickEngine('volc')"
                >
                  火山豆包流式（云端 · 按时长计费）
                </button>
                <button
                  class="flex-1 rounded-md px-3 py-1.5 text-xs transition"
                  :class="store.asrEngine === 'browser'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'"
                  @click="pickEngine('browser')"
                >
                  浏览器内置（降级）
                </button>
              </div>

              <!-- 火山配置 -->
              <div v-if="store.asrEngine === 'volc'" class="mt-3 space-y-2.5 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] text-zinc-400">已内置默认 Key，开箱即用；下方可覆盖</span>
                  <span class="flex items-center gap-1.5">
                    <span
                      class="rounded-full px-2 py-0.5 text-[10px]"
                      :class="volc.hasCustomToken ? 'bg-sky-500/15 text-sky-300' : 'bg-zinc-700/60 text-zinc-400'"
                    >
                      {{ volc.hasCustomToken ? '自定义 Key' : '内置默认' }}
                    </span>
                    <button
                      v-if="volc.hasCustomToken"
                      class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
                      title="清除自定义，恢复内置默认"
                      @click="resetVolc"
                    >
                      恢复默认
                    </button>
                  </span>
                </div>
                <label class="block">
                  <span class="mb-1 block text-[10px] text-zinc-500">
                    API Key<span class="ml-1 text-sky-400">← 必填，形如 b7d7f640-… 的 UUID</span>
                  </span>
                  <input
                    v-model="volc.token"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-sky-600/60"
                    placeholder="粘贴你的 API Key（UUID 格式，不是数字串）"
                    @change="saveVolc"
                  />
                </label>
                <label class="block">
                  <span class="mb-1 block text-[10px] text-zinc-500">App ID（选填，纯数字；旧版控制台才需要）</span>
                  <input
                    v-model="volc.appid"
                    class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-sky-600/60"
                    placeholder="纯数字 App ID，可留空"
                    @change="saveVolc"
                  />
                </label>
                <div v-if="!/^\d+$/.test(volc.appid) && volc.appid" class="text-[10px] text-amber-400">
                  ⚠ App ID 应为纯数字；你填的内容更像 API Key——请检查两个栏位是否填反
                </div>
                <div v-if="/^\d{6,}$/.test(volc.token)" class="text-[10px] text-amber-400">
                  ⚠ API Key 应为 UUID 格式（含连字符）；纯数字串通常是 App ID——请检查是否填反
                </div>
                <details class="text-[11px] text-zinc-500">
                  <summary class="cursor-pointer select-none py-0.5">高级（resource id / cluster，默认值适用时长版计费）</summary>
                  <div class="mt-2 space-y-2">
                    <label class="block">
                      <span class="mb-1 block text-[10px] text-zinc-500">Resource ID</span>
                      <input
                        v-model="volc.resourceId"
                        class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800"
                        @change="saveVolc"
                      />
                    </label>
                    <label class="block">
                      <span class="mb-1 block text-[10px] text-zinc-500">端点（默认双向流式）</span>
                      <input
                        v-model="volc.endpoint"
                        class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800"
                        @change="saveVolc"
                      />
                    </label>
                  </div>
                </details>
                <p class="text-[10px] leading-4 text-zinc-600">
                  默认使用项目内置 Key（仅经本机 gateway 中转）；修改后仅存本机浏览器 localStorage。修改后需重新开始录音生效。
                </p>
              </div>
            </section>

            <!-- 角色管理 -->
            <section>
              <h3 class="mb-2 text-xs font-medium text-zinc-400">AI 角色</h3>
              <div class="space-y-2">
                <div
                  v-for="role in store.roles"
                  :key="role.id"
                  class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
                  :class="{ 'opacity-50': !role.enabled }"
                >
                  <span class="h-8 w-8 shrink-0 rounded-lg" :class="roleColor(role.color).soft + ' ' + roleColor(role.color).border + ' border'">
                    <span class="flex h-full w-full items-center justify-center text-xs font-bold" :class="roleColor(role.color).text">
                      {{ role.name[0] }}
                    </span>
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium text-zinc-200">{{ role.name }}</span>
                      <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">音色 · {{ role.voice }}</span>
                      <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">优先级 {{ role.priority }}</span>
                      <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {{ AGGRESSIVENESS_LABEL[role.interruptAggressiveness] }}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate text-[11px] text-zinc-500">{{ role.description }}</p>
                  </div>
                  <button
                    role="switch"
                    :aria-checked="role.enabled"
                    class="relative h-5 w-9 shrink-0 rounded-full transition"
                    :class="role.enabled ? 'bg-emerald-600' : 'bg-zinc-700'"
                    @click="toggleRole(role.id, !role.enabled)"
                  >
                    <span
                      class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                      :class="role.enabled ? 'left-4.5' : 'left-0.5'"
                    />
                  </button>
                </div>
              </div>
              <p class="mt-2 text-[11px] leading-5 text-zinc-600">
                角色人设提示词、hooks、独立记忆位于项目 <code class="rounded bg-zinc-800 px-1">roles/&lt;角色&gt;/</code> 目录（标准 Claude Code 项目），可直接用 Claude Code 编辑。
              </p>
            </section>

            <!-- 会话信息 -->
            <section>
              <h3 class="mb-2 text-xs font-medium text-zinc-400">当前会话</h3>
              <div class="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-400">
                <div class="flex justify-between py-0.5">
                  <span class="text-zinc-600">会议 ID</span>
                  <span class="font-mono">{{ store.meetingId || '-' }}</span>
                </div>
                <div v-for="(sid, rid) in store.claudeSessionIds" :key="rid" class="flex justify-between py-0.5">
                  <span class="text-zinc-600">{{ store.roleById.get(rid)?.name ?? rid }} · Claude session</span>
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
