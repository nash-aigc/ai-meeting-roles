<script setup lang="ts">
/**
 * 角色管理弹窗：
 * - 左侧：角色列表 + 添加按钮 + 行业标签筛选
 * - 右侧：顶部操作区（删除/保存）+ 详情区（左=参数单列，右=提示词）
 * - 底部：内置预设按行业分类展示，可一键添加
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { speakWithGain, stopVoicePlayback } from '../services/tts'
import type { RoleInfo, RolePresetGroup, RolePreset } from '../types/protocol'

const props = defineProps<{
  onClose: () => void
  initialRoleId?: string | null
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

// 完整提示词异步到达时填充编辑框
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
        if (confirm(`导入 ${data.roles.length} 个角色？会覆盖同名角色。`)) {
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

// ---- 保存反馈 ----
type SaveState = 'idle' | 'saving' | 'ok' | 'error'
const saveState = ref<SaveState>('idle')
let saveTimer: ReturnType<typeof setTimeout> | null = null

async function submitUpdate(): Promise<void> {
  if (!selectedRoleId.value || saveState.value === 'saving') return
  saveState.value = 'saving'
  try {
    store.updateRolePrompt(selectedRoleId.value, form.value.prompt)
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

// ---- 删除二次确认 ----
function deleteCurrent(): void {
  if (!selectedRoleId.value) return
  const id = selectedRoleId.value
  if (!confirm(`确定要删除角色 "${id}" 吗？`)) return
  if (!confirm(`二次确认：删除后该角色的提示词与配置无法恢复。\n真的要删除 "${id}" 吗？`)) return
  store.deleteRole(id)
  selectedRoleId.value = null
}

// ---- 音色试听 ----
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
  // 如果传入了初始角色ID，自动选中并定位
  if (props.initialRoleId) {
    const role = store.roles.find(r => r.id === props.initialRoleId)
    if (role) {
      selectRole(role)
    }
  }
})

onUnmounted(() => {
  if (previewing.value && store.state !== 'recording') stopVoicePlayback()
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div class="flex h-[85vh] w-[90vw] max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-warm-normal bg-warm-card shadow-2xl">
      <!-- 头部 -->
      <div class="flex items-center justify-between border-b border-warm-subtle px-4 py-[14px]">
        <h3 class="text-[15px] font-semibold text-warm-100">AI 角色管理</h3>
        <button
          class="btn btn-ghost" style="height: 30px; width: 30px; padding: 0;"
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
        <div class="flex w-[260px] min-w-0 flex-col border-r-2 border-warm-normal p-[14px]">
          <!-- 筛选 -->
          <div class="mb-[12px] flex flex-wrap gap-2">
            <button
              class="tag transition hover:border-warm-hover"
              :class="!searchIndustry ? 'tag-info' : ''"
              style="cursor: pointer; padding: 6px 16px; font-size: 13px;"
              @click="searchIndustry = null"
            >
              全部
            </button>
            <button
              v-for="tag in ['销售', '管理', '产品']"
              :key="tag"
              class="tag transition hover:border-warm-hover"
              :class="searchIndustry === tag ? 'tag-info' : ''"
              style="cursor: pointer; padding: 6px 16px; font-size: 13px;"
              @click="searchIndustry = searchIndustry === tag ? null : tag"
            >
              {{ tag }}
            </button>
          </div>

          <!-- 粗分割线 -->
          <div class="mb-[12px] h-[2px] w-full rounded-full" style="background: var(--border-normal);"></div>

          <!-- 角色列表 -->
          <div class="flex-1 space-y-1 overflow-y-auto">
            <button
              v-for="role in filteredRoles"
              :key="role.id"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-[10px] text-left text-[13px] transition"
              :class="selectedRoleId === role.id ? 'bg-warm-selected text-warm-100' : 'text-warm-300 hover:bg-warm-selected'"
              @click="selectRole(role)"
            >
              <span class="h-2.5 w-2.5 rounded-full" :class="role.color + '-400 bg-'"></span>
              <span class="min-w-0 truncate">{{ role.name }}</span>
              <span v-if="!role.enabled" class="ml-auto text-[11px] text-warm-600">已关闭</span>
            </button>
          </div>

          <!-- 新建 + 导入/导出 -->
          <div class="mt-[14px] space-y-2">
            <button
              class="btn btn-primary w-full"
              @click="createNew"
            >
              <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" />
              </svg>
              新建角色
            </button>
            <div class="grid grid-cols-2 gap-2">
              <button
                class="btn" style="font-size: 12px;"
                @click="exportAllRoles"
              >
                <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                导出
              </button>
              <button
                class="btn" style="font-size: 12px;"
                @click="triggerImport"
              >
                <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5m0 0l5 5m-5-5v12" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                导入
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧：编辑表单 -->
        <div class="min-h-0 flex-1 overflow-y-auto p-[16px]">
          <template v-if="selectedRoleId || form.id">
            <!-- 顶部操作区 -->
            <div class="sticky top-0 z-10 mb-[14px] flex items-center gap-2 rounded-lg border border-warm-subtle bg-warm-card/95 p-[10px] backdrop-blur">
              <template v-if="selectedRoleId">
                <button
                  class="btn" style="color: var(--danger); border-color: var(--danger);"
                  @click="deleteCurrent"
                >
                  <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  删除角色
                </button>
                <button
                  class="btn btn-primary"
                  :class="{
                    'cursor-wait opacity-70': saveState === 'saving',
                    'scale-105': saveState === 'ok',
                  }"
                  :disabled="saveState === 'saving'"
                  @click="submitUpdate"
                >
                  <svg v-if="saveState === 'ok'" viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M5 12h14M12 5l0 14" stroke-linecap="round" />
                  </svg>
                  {{ saveState === 'saving' ? '保存中…' : saveState === 'ok' ? '已保存' : saveState === 'error' ? '保存失败' : '保存修改' }}
                </button>
                <span class="ml-auto text-[11px] text-warm-600">roles/{{ form.id }}/CLAUDE.md</span>
              </template>
              <template v-else>
                <button
                  class="btn btn-primary"
                  @click="submitCreate"
                >
                  <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                  </svg>
                  创建角色
                </button>
                <span class="ml-auto text-[11px] text-warm-600">新角色（填写左侧参数与右侧提示词）</span>
              </template>
            </div>

            <!-- 详情区：左=角色参数，右=提示词 -->
            <div class="flex gap-[14px]">
              <!-- 左：角色参数单列 -->
              <div class="w-[220px] shrink-0 space-y-[14px]">
                <div>
                  <label class="form-label block text-[12px] text-warm-500">角色ID</label>
                  <input
                    v-model="form.id"
                    type="text"
                    class="input"
                    :disabled="!!selectedRoleId"
                    placeholder="英文小写下划线，如: marketing_expert"
                  />
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500">角色名称</label>
                  <input
                    v-model="form.name"
                    type="text"
                    class="input"
                    placeholder="显示名称"
                  />
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500">音色（可试听对比响度）</label>
                  <div class="flex gap-2">
                    <select
                      v-model="form.voice"
                      class="input min-w-0 flex-1"
                    >
                      <option v-for="v in availableVoices" :key="v.key" :value="v.key">
                        {{ v.name }}
                      </option>
                    </select>
                    <button
                      class="btn shrink-0"
                      :class="previewing ? 'btn-primary' : ''"
                      @click="testVoice"
                    >
                      {{ previewing ? '■ 停止' : '▶ 试听' }}
                    </button>
                  </div>
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500">主题色</label>
                  <div class="grid grid-cols-4 gap-2">
                    <button
                      v-for="c in availableColors"
                      :key="c.key"
                      class="h-[28px] rounded transition"
                      :class="`${form.color === c.key ? 'ring-2 ring-' + c.key + '-400' : ''} bg-${c.key}-500/20`"
                      @click="form.color = c.key"
                    >
                    </button>
                  </div>
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500">自动思考间隔（秒）</label>
                  <input
                    v-model.number="form.thinkIntervalSec"
                    type="number"
                    min="2"
                    max="120"
                    step="1"
                    class="input"
                  />
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500" title="多个角色同一轮都想发言时，数字小的先说（1 最高）">发言优先级（1 先说）</label>
                  <input
                    v-model.number="form.priority"
                    type="number"
                    min="1"
                    max="99"
                    step="1"
                    class="input"
                  />
                </div>
                <div>
                  <label class="form-label block text-[12px] text-warm-500">行业标签</label>
                  <input
                    v-model="form.industryTag"
                    type="text"
                    class="input"
                    placeholder="如: 销售, 管理, 产品"
                  />
                </div>
                <div>
                  <label class="flex items-center justify-between text-[12px] text-warm-500">
                    <span>语音播放</span>
                    <span class="text-warm-600">开启后语音播报</span>
                  </label>
                  <button
                    role="switch"
                    :aria-checked="form.ttsEnabled"
                    class="switch mt-1"
                    :class="{ on: form.ttsEnabled }"
                    @click="form.ttsEnabled = !form.ttsEnabled"
                  />
                </div>
              </div>

              <!-- 右：提示词编辑 -->
              <div class="flex min-w-0 flex-1 flex-col">
                <div class="mb-1 flex items-center justify-between">
                  <label class="text-[12px] text-warm-500">角色提示词（完整）</label>
                  <span class="text-[11px] text-warm-600">roles/{{ form.id || 'new' }}/CLAUDE.md</span>
                </div>
                <textarea
                  v-model="form.prompt"
                  class="w-full flex-1 min-h-[480px] resize-none rounded-lg bg-warm-input px-3 py-2 text-[13px] leading-6 text-warm-100 outline-none ring-1 ring-warm-subtle focus:ring-accent-warm"
                  placeholder="在这里写下完整的角色提示词..."
                />
              </div>
            </div>
          </template>

          <template v-else>
            <div class="flex h-full items-center justify-center text-center text-[13px] text-warm-600">
              左侧选择一个角色编辑，或点击"新建角色"开始
            </div>
          </template>

          <!-- 预设推荐 -->
          <div class="mt-[16px] border-t border-warm-subtle pt-[14px]">
            <h4 class="mb-2 text-[13px] font-medium text-warm-300">内置预设（点击添加）</h4>
            <div class="space-y-3">
              <template v-for="group in presets" :key="group.industryTag">
                <div class="mb-1 text-[12px] text-warm-500">{{ group.industryTag }}</div>
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div
                    v-for="preset in group.presets"
                    :key="preset.id"
                    class="card card-hover p-[10px]"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[13px] font-medium text-warm-100">{{ preset.name }}</span>
                      <button
                        class="btn btn-primary" style="height: 26px; padding: 0 10px; font-size: 11px;"
                        @click="addPreset(preset)"
                      >
                        添加
                      </button>
                    </div>
                    <p class="mt-1 text-[12px] text-warm-300 line-clamp-2">{{ preset.description }}</p>
                  </div>
                </div>
              </template>
              <div v-if="!presets.length" class="text-[12px] text-warm-600">加载预设中...</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
