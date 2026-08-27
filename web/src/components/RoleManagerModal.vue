<script setup lang="ts">
/**
 * 角色管理弹窗：
 * - 左侧：角色列表 + 添加按钮 + 行业标签筛选（筛选项 2026-08-27 字体放大 15%）
 * - 右侧：顶部操作区（删除/保存，2026-08-27 从底部上移）+ 详情区（左=参数单列，右=提示词）
 * - 底部：内置预设按行业分类展示，可一键添加
 *
 * 2026-08-27 优化：
 * - 删除角色二次确认（两道弹窗，防误删）
 * - 保存修改成功反馈：按钮切换为带对勾的成功态动画，2s 后自动恢复
 * - 音色支持「试听」（WebAudio 增益播放；王新月响度补偿见 services/tts.ts）
 * - 详情排版：角色参数单列窄栏在左、提示词在右，更紧凑
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { speakWithGain, stopVoicePlayback } from '../services/tts'
import type { RoleInfo, RolePresetGroup, RolePreset } from '../types/protocol'

const props = defineProps<{
  onClose: () => void
}>()

const store = useMeetingStore()
const selectedRoleId = ref<string | null>(null)
const searchIndustry = ref<string | null>(null)
const presets = ref<RolePresetGroup[]>([])

// 编辑表单
const form = ref({
  id: '',
  name: '',
  voice: '高晴',
  color: 'sky',
  thinkIntervalSec: 10,
  ttsEnabled: false,
  priority: 50,
  industryTag: '',
  prompt: '',
})

const availableColors = [
  { key: 'sky', name: '天蓝', label: 'sky' },
  { key: 'amber', name: '琥珀', label: 'amber' },
  { key: 'rose', name: '玫瑰', label: 'rose' },
  { key: 'violet', name: '紫罗兰', label: 'violet' },
]

// 完整提示词异步到达时填充编辑框（selectRole 先用预览占位）
watch(
  () => store.rolePromptCache,
  (cache) => {
    const rid = selectedRoleId.value
    if (rid && cache[rid] !== undefined) {
      form.value.prompt = cache[rid]
    }
  },
  { deep: true },
)

const availableVoices = [
  { key: '高晴', name: '高晴' },
  { key: '王新月', name: '王新月' },
]

const filteredRoles = computed(() => {
  if (!searchIndustry.value) return store.roles
  return store.roles.filter(r => r.industryTag === searchIndustry.value)
})

// 导入/导出
function exportAllRoles(): void {
  const data = {
    roles: store.roles,
    exportedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai-roles-export-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function handleImport(file: File): void {
  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target?.result as string)
      if (Array.isArray(data.roles)) {
        // 提示确认
        if (confirm(`导入 ${data.roles.length} 个角色？会覆盖同名角色。`)) {
          // 逐个创建
          data.roles.forEach((role: any) => {
            store.createRole({
              id: role.id,
              name: role.name || role.id,
              voice: role.voice || '高晴',
              color: role.color || 'sky',
              description: role.description || '',
              prompt: role.prompt || '',
              thinkIntervalSec: role.thinkIntervalSec || 10,
              ttsEnabled: role.ttsEnabled || false,
              industryTag: role.industryTag,
            })
          })
          alert('导入完成，请刷新查看')
        }
      } else {
        alert('格式错误：未找到 roles 数组')
      }
    } catch (err) {
      alert(`解析失败: ${err}`)
    }
  }
  reader.readAsText(file)
}

function triggerImport(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = (e: any) => {
    const file = e.target.files?.[0]
    if (file) handleImport(file)
  }
  input.click()
}

function selectRole(role: RoleInfo): void {
  selectedRoleId.value = role.id
  form.value = {
    id: role.id,
    name: role.name,
    voice: role.voice,
    color: role.color,
    thinkIntervalSec: role.thinkIntervalSec,
    ttsEnabled: role.ttsEnabled,
    priority: role.priority ?? 50,
    industryTag: role.industryTag || '',
    // 先用缓存/预览占位，随后向 gateway 请求完整提示词（role.prompt 响应更新缓存）
    prompt: store.rolePromptCache[role.id] || role.promptPreview || '',
  }
  store.getRolePrompt(role.id)
}

function createNew(): void {
  selectedRoleId.value = null
  form.value = {
    id: '',
    name: '',
    voice: '高晴',
    color: 'sky',
    thinkIntervalSec: 10,
    ttsEnabled: false,
    priority: 50,
    industryTag: '',
    prompt: '# 角色身份\n\n在这里写下完整的角色提示词...\n\n# 输出要求\n\n- 每次只输出一行观点\n- 使用简洁犀利的语言\n',
  }
}

function submitCreate(): void {
  const id = form.value.id.trim().toLowerCase().replace(/\s+/g, '_')
  if (!id) return
  store.createRole({
    id,
    name: form.value.name || id,
    voice: form.value.voice,
    color: form.value.color,
    description: form.value.name,
    prompt: form.value.prompt,
    thinkIntervalSec: form.value.thinkIntervalSec,
    ttsEnabled: form.value.ttsEnabled,
    industryTag: form.value.industryTag || undefined,
  })
  selectedRoleId.value = null
  form.value = {
    id: '',
    name: '',
    voice: '高晴',
    color: 'sky',
    thinkIntervalSec: 10,
    ttsEnabled: false,
    priority: 50,
    industryTag: '',
    prompt: '',
  }
}

// ---- 保存反馈（2026-08-27）：saving -> ok(对勾+成功色动画) / error，2s 后回落 ----
type SaveState = 'idle' | 'saving' | 'ok' | 'error'
const saveState = ref<SaveState>('idle')
let saveTimer: ReturnType<typeof setTimeout> | null = null

async function submitUpdate(): Promise<void> {
  if (!selectedRoleId.value || saveState.value === 'saving') return
  saveState.value = 'saving'
  try {
    store.updateRolePrompt(selectedRoleId.value, form.value.prompt)
    // also update config for thinkInterval and ttsEnabled
    store.updateConfig({
      roles: [{
        id: selectedRoleId.value,
        thinkIntervalSec: form.value.thinkIntervalSec,
        ttsEnabled: form.value.ttsEnabled,
        priority: form.value.priority,
      }],
    })
    saveState.value = 'ok'
  } catch {
    saveState.value = 'error'
  } finally {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveState.value = 'idle' }, 2000)
  }
}

// ---- 删除二次确认（2026-08-27 用户要求）：两道弹窗，第二道明示不可恢复 ----
function deleteCurrent(): void {
  if (!selectedRoleId.value) return
  const id = selectedRoleId.value
  if (!confirm(`确定要删除角色 "${id}" 吗？`)) return
  if (!confirm(`二次确认：删除后该角色的提示词与配置无法恢复。\n真的要删除 "${id}" 吗？`)) return
  store.deleteRole(id)
  selectedRoleId.value = null
}

// ---- 音色试听（2026-08-27）：走 speakWithGain，与正式播放同一增益口径，便于对比响度 ----
const previewing = ref(false)

async function testVoice(): Promise<void> {
  if (previewing.value) {
    stopVoicePlayback()
    previewing.value = false
    return
  }
  previewing.value = true
  await speakWithGain(
    `大家好，我是${form.value.voice}，这是一段音色试听，请注意对比音量响度。`,
    form.value.voice,
    {
      onEnd: () => { previewing.value = false },
      onError: () => { previewing.value = false },
    },
  )
}

function addPreset(preset: RolePreset): void {
  const id = preset.id
  if (store.roles.some(r => r.id === id)) {
    if (!confirm(`角色 "${preset.name}" 已存在，是否重新添加？这会覆盖现有角色。`)) return
  }
  store.createRole({
    id: preset.id,
    name: preset.name,
    voice: preset.voice,
    color: preset.color,
    description: preset.description,
    prompt: preset.prompt,
    thinkIntervalSec: preset.thinkIntervalSec,
    ttsEnabled: preset.ttsEnabled,
  })
}

onMounted(() => {
  store.requestRolePresets()
})

onUnmounted(() => {
  // 弹窗关闭时停掉试听语音（录音进行中不打断会议语音队列，让试听自然播完）
  if (previewing.value && store.state !== 'recording') stopVoicePlayback()
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div class="flex h-[85vh] w-[90vw] max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <!-- 头部 -->
      <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h3 class="text-sm font-semibold text-zinc-100">AI 角色管理</h3>
        <button
          class="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          @click="props.onClose"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- 主体：左侧列表 + 右侧编辑 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左侧：角色列表 + 筛选 -->
        <div class="flex w-64 min-w-0 flex-col border-r border-zinc-800 p-3">
          <!-- 筛选（2026-08-27 常用项字体放大 15%：text-xs -> text-[13.8px]） -->
          <div class="mb-2 flex flex-wrap gap-1.5">
            <button
              class="rounded-full px-3 py-1 text-[13.8px] transition"
              :class="!searchIndustry ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
              @click="searchIndustry = null"
            >
              全部
            </button>
            <button
              v-for="tag in ['销售', '管理', '产品']"
              :key="tag"
              class="rounded-full px-3 py-1 text-[13.8px] transition"
              :class="searchIndustry === tag ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
              @click="searchIndustry = searchIndustry === tag ? null : tag"
            >
              {{ tag }}
            </button>
          </div>

          <!-- 角色列表 -->
          <div class="flex-1 space-y-1 overflow-y-auto">
            <button
              v-for="role in filteredRoles"
              :key="role.id"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
              :class="selectedRoleId === role.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/50'"
              @click="selectRole(role)"
            >
              <span class="h-2 w-2 rounded-full" :class="role.color + '-400 bg-'"></span>
              <span class="min-w-0 truncate">{{ role.name }}</span>
              <span v-if="!role.enabled" class="ml-auto text-[10px] text-zinc-600">已关闭</span>
            </button>
          </div>

          <!-- 新建 + 导入/导出 -->
          <div class="mt-3 space-y-2">
            <button
              class="flex w-full items-center justify-center gap-1 rounded-lg bg-emerald-600/80 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-600"
              @click="createNew"
            >
              <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" />
              </svg>
              新建角色
            </button>
            <div class="grid grid-cols-2 gap-2">
              <button
                class="flex items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500"
                @click="exportAllRoles"
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                导出
              </button>
              <button
                class="flex items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500"
                @click="triggerImport"
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5m0 0l5 5m-5-5v12" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                导入
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧：编辑表单 -->
        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <template v-if="selectedRoleId || form.id">
            <!-- 顶部操作区（2026-08-27 从底部上移）：删除 / 保存常驻页面最顶 -->
            <div class="sticky top-0 z-10 mb-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/95 p-2 backdrop-blur">
              <template v-if="selectedRoleId">
                <button
                  class="flex items-center gap-1 rounded-lg bg-red-600/80 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-red-600"
                  @click="deleteCurrent"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  删除角色
                </button>
                <button
                  class="flex items-center gap-1 rounded-lg px-4 py-1.5 text-xs font-medium text-white transition-all duration-300"
                  :class="{
                    'bg-sky-600/80 hover:bg-sky-600': saveState === 'idle',
                    'cursor-wait bg-sky-600/50': saveState === 'saving',
                    'scale-105 bg-emerald-600 shadow-lg shadow-emerald-600/30': saveState === 'ok',
                    'bg-red-600': saveState === 'error',
                  }"
                  :disabled="saveState === 'saving'"
                  @click="submitUpdate"
                >
                  <svg v-if="saveState === 'ok'" viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M5 12h14M12 5l0 14" stroke-linecap="round" />
                  </svg>
                  {{ saveState === 'saving' ? '保存中…' : saveState === 'ok' ? '已保存' : saveState === 'error' ? '保存失败' : '保存修改' }}
                </button>
                <span class="ml-auto text-[10px] text-zinc-600">roles/{{ form.id }}/CLAUDE.md</span>
              </template>
              <template v-else>
                <button
                  class="flex items-center gap-1 rounded-lg bg-emerald-600/80 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-600"
                  @click="submitCreate"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                  </svg>
                  创建角色
                </button>
                <span class="ml-auto text-[10px] text-zinc-600">新角色（填写左侧参数与右侧提示词）</span>
              </template>
            </div>

            <!-- 详情区（2026-08-27 排版调整）：左=角色参数（单列窄栏），右=提示词 -->
            <div class="flex gap-3">
              <!-- 左：角色参数单列 -->
              <div class="w-56 shrink-0 space-y-3">
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">角色ID</label>
                  <input
                    v-model="form.id"
                    type="text"
                    class="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                    :disabled="!!selectedRoleId"
                    placeholder="英文小写下划线，如: marketing_expert"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">角色名称</label>
                  <input
                    v-model="form.name"
                    type="text"
                    class="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                    placeholder="显示名称"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">音色（可试听对比响度）</label>
                  <div class="flex gap-1.5">
                    <select
                      v-model="form.voice"
                      class="min-w-0 flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                    >
                      <option v-for="v in availableVoices" :key="v.key" :value="v.key">
                        {{ v.name }}
                      </option>
                    </select>
                    <button
                      class="shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] transition"
                      :class="previewing
                        ? 'border-sky-500/60 bg-sky-500/20 text-sky-300'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-sky-500/60 hover:text-sky-300'"
                      @click="testVoice"
                    >
                      {{ previewing ? '■ 停止' : '▶ 试听' }}
                    </button>
                  </div>
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">主题色</label>
                  <div class="grid grid-cols-4 gap-1">
                    <button
                      v-for="c in availableColors"
                      :key="c.key"
                      class="h-6 rounded text-[10px] transition"
                      :class="`${form.color === c.key ? 'ring-2 ring-' + c.key + '-400' : ''} bg-${c.key}-500/20`"
                      @click="form.color = c.key"
                    >
                    </button>
                  </div>
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">自动思考间隔（秒）</label>
                  <input
                    v-model.number="form.thinkIntervalSec"
                    type="number"
                    min="2"
                    max="120"
                    step="1"
                    class="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1" title="多个角色同一轮都想发言时，数字小的先说（1 最高）">发言优先级（1 先说）</label>
                  <input
                    v-model.number="form.priority"
                    type="number"
                    min="1"
                    max="99"
                    step="1"
                    class="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-zinc-500 mb-1">行业标签</label>
                  <input
                    v-model="form.industryTag"
                    type="text"
                    class="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                    placeholder="如: 销售, 管理, 产品"
                  />
                </div>
                <div>
                  <label class="flex items-center justify-between text-[11px] text-zinc-500 mb-1">
                    <span>语音播放</span>
                    <span class="text-zinc-600">开启后语音播报</span>
                  </label>
                  <button
                    role="switch"
                    :aria-checked="form.ttsEnabled"
                    class="relative h-6 w-11 rounded-full transition"
                    :class="form.ttsEnabled ? 'bg-sky-600' : 'bg-zinc-700'"
                    @click="form.ttsEnabled = !form.ttsEnabled"
                  >
                    <span
                      class="absolute top-1 h-4 w-4 rounded-full bg-white transition-all"
                      :class="form.ttsEnabled ? 'left-6' : 'left-1'"
                    />
                  </button>
                </div>
              </div>

              <!-- 右：提示词编辑 -->
              <div class="flex min-w-0 flex-1 flex-col">
                <div class="mb-1 flex items-center justify-between">
                  <label class="text-[11px] text-zinc-500">角色提示词（完整）</label>
                  <span class="text-[10px] text-zinc-600">roles/{{ form.id || 'new' }}/CLAUDE.md</span>
                </div>
                <textarea
                  v-model="form.prompt"
                  class="w-full flex-1 min-h-[480px] resize-none rounded-lg bg-zinc-800 px-3 py-2 text-xs leading-6 text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-sky-500/50"
                  placeholder="在这里写下完整的角色提示词..."
                />
              </div>
            </div>
          </template>

          <template v-else>
            <div class="flex h-full items-center justify-center text-center text-xs text-zinc-600">
              左侧选择一个角色编辑，或点击"新建角色"开始
            </div>
          </template>

          <!-- 预设推荐 -->
          <div class="mt-4 border-t border-zinc-800 pt-4">
            <h4 class="mb-2 text-xs font-medium text-zinc-400">内置预设（点击添加）</h4>
            <div class="space-y-3">
              <template v-for="group in presets" :key="group.industryTag">
                <div class="mb-1 text-[11px] text-zinc-500">{{ group.industryTag }}</div>
                <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <div
                    v-for="preset in group.presets"
                    :key="preset.id"
                    class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 transition hover:border-zinc-600"
                  >
                    <div class="flex items-center justify-between gap-1">
                      <span class="text-xs font-medium text-zinc-200">{{ preset.name }}</span>
                      <button
                        class="rounded bg-emerald-600/80 px-2 py-0.5 text-[10px] text-white transition hover:bg-emerald-600"
                        @click="addPreset(preset)"
                      >
                        添加
                      </button>
                    </div>
                    <p class="mt-1 text-[11px] text-zinc-400 line-clamp-2">{{ preset.description }}</p>
                  </div>
                </div>
              </template>
              <div v-if="!presets.length" class="text-[11px] text-zinc-600">加载预设中...</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
