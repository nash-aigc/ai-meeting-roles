<script setup lang="ts">
/**
 * 系统设置弹窗（整合角色管理、语音识别、导入导出）
 * - 选项卡：角色管理 | 语音识别 | 导入导出
 * - 点击弹窗外部自动关闭
 * - 支持 initialRoleId 打开时自动定位到对应角色
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { getVolcConfig, saveVolcConfig, loadVolcFromServer } from '../services/volcAsr'
import { loadHistory, upsertHistory } from '../services/history'
import { speakWithGain, stopVoicePlayback } from '../services/tts'
import type { RoleInfo, RolePresetGroup, RolePreset } from '../types/protocol'
import type { MeetingHistoryEntry } from '../services/history'

const props = defineProps<{
  onClose: () => void
  initialRoleId?: string | null
}>()

const store = useMeetingStore()
const activeTab = ref<'roles' | 'asr' | 'io'>('roles')

// ---------- 角色管理 ----------
const selectedRoleId = ref<string | null>(null)
const creating = ref(false)
const searchIndustry = ref<string | null>(null)
const presets = ref<RolePresetGroup[]>([])

const form = ref({
  id: '',
  name: '',
  voice: '高晴',
  color: 'sky',
  thinkIntervalSec: 10,
  ttsEnabled: false,
  defaultEnabled: false,
  priority: 50,
  industryTag: '',
  prompt: '',
})

const availableColors = [
  { key: 'sky', name: '天蓝' },
  { key: 'amber', name: '琥珀' },
  { key: 'rose', name: '玫瑰' },
  { key: 'violet', name: '紫罗兰' },
]

const availableVoices = [
  { key: '高晴', name: '高晴' },
  { key: '王新月', name: '王新月' },
]

const filteredRoles = computed(() => {
  if (!searchIndustry.value) return store.roles
  return store.roles.filter(r => r.industryTag === searchIndustry.value)
})

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

function selectRole(role: RoleInfo): void {
  selectedRoleId.value = role.id
  creating.value = false
  form.value = {
    id: role.id,
    name: role.name,
    voice: role.voice,
    color: role.color,
    thinkIntervalSec: role.thinkIntervalSec,
    ttsEnabled: role.ttsEnabled,
    defaultEnabled: role.defaultEnabled ?? false,
    priority: role.priority ?? 50,
    industryTag: role.industryTag || '',
    prompt: store.rolePromptCache[role.id] || role.promptPreview || '',
  }
  store.getRolePrompt(role.id)
}

function createNew(): void {
  selectedRoleId.value = null
  creating.value = true
  form.value = {
    id: '',
    name: '',
    voice: '高晴',
    color: 'sky',
    thinkIntervalSec: 10,
    ttsEnabled: false,
    defaultEnabled: false,
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
  creating.value = false
}

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
        defaultEnabled: form.value.defaultEnabled,
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

function deleteCurrent(): void {
  if (!selectedRoleId.value) return
  const id = selectedRoleId.value
  if (!confirm(`确定要删除角色 "${id}" 吗？`)) return
  if (!confirm(`二次确认：删除后该角色的提示词与配置无法恢复。\n真的要删除 "${id}" 吗？`)) return
  store.deleteRole(id)
  selectedRoleId.value = null
}

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

// ---------- 语音识别 ----------
const asrProvider = ref<'volc' | 'alibaba'>('volc')
const asrModel = ref('bigmodel')
const volc = ref({
  ...getVolcConfig(),
  configured: getVolcConfig().ready,
})

function saveVolc(): void {
  saveVolcConfig({
    appid: volc.value.appid.trim(),
    token: volc.value.token.trim(),
    resourceId: volc.value.resourceId,
    endpoint: volc.value.endpoint,
  })
  volc.value.configured = !!volc.value.token.trim()
  Object.assign(volc.value, getVolcConfig())
}

async function importFromEnv(): Promise<void> {
  const ok = await loadVolcFromServer()
  if (!ok) {
    alert('未能从 .env 读取豆包 ASR 配置：请确认服务端 .env 已填写 VOLC_ASR_TOKEN')
    return
  }
  const cfg = (await (await fetch('/api/config/asr')).json()).volc
  saveVolcConfig({
    token: cfg.token,
    appid: cfg.appid,
    resourceId: cfg.resourceId,
    endpoint: cfg.endpoint,
  })
  Object.assign(volc.value, getVolcConfig(), { configured: true })
}

function resetVolc(): void {
  localStorage.removeItem('volc-asr:token')
  localStorage.removeItem('volc-asr:appid')
  Object.assign(volc.value, getVolcConfig(), { configured: true })
}

// ---------- ASR 配置测试 ----------
const asrTesting = ref(false)
const asrTestResult = ref('')
const asrTestError = ref('')
const asrTestExpected = ref('')

async function testAsrConfig(): Promise<void> {
  if (asrTesting.value) return
  asrTesting.value = true
  asrTestResult.value = ''
  asrTestError.value = ''
  asrTestExpected.value = ''

  try {
    // 1. 从服务端获取测试音频（TTS 生成的 16kHz PCM）
    const resp = await fetch('/api/asr/test-audio')
    const data = await resp.json()
    if (!data.ok) {
      asrTestError.value = data.error || '生成测试音频失败'
      return
    }
    asrTestExpected.value = data.text

    // 2. 解码 base64 PCM 为 Int16Array
    const binary = atob(data.pcmBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const pcm = new Int16Array(bytes.buffer)

    // 3. 使用 VolcASR 发送音频进行识别
    const { VolcASR } = await import('../services/volcAsr')
    const asr = new VolcASR()
    let finalText = ''

    const started = asr.start({
      onFinal: (text: string) => {
        finalText += (finalText ? ' ' : '') + text
        asrTestResult.value = finalText
      },
      onInterim: (text: string) => {
        asrTestResult.value = finalText + (finalText && text ? ' ' : '') + text
      },
      onError: (msg: string) => {
        asrTestError.value = msg
      },
      onDebug: (msg: string) => {
        console.log('[ASR Test]', msg)
      },
    })

    if (!started) {
      asrTestError.value = 'ASR 未配置或启动失败'
      return
    }

    // 4. 等待连接就绪后发送音频（分块发送，模拟实时流，每块 200ms）
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const chunkSize = 3200 // 200ms @16kHz
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length))
      asr.feed(chunk)
      await new Promise((resolve) => setTimeout(resolve, 180))
    }

    // 5. 停止，等待最终结果
    asr.stop()
    await new Promise((resolve) => setTimeout(resolve, 3000))

    if (!asrTestResult.value && !asrTestError.value) {
      asrTestError.value = '未收到识别结果，请检查 API Key 和网络连接'
    }
  } catch (e: any) {
    asrTestError.value = `测试失败: ${e?.message || String(e)}`
  } finally {
    asrTesting.value = false
  }
}

// ---------- 导入导出 ----------
const includeHistory = ref(true)
const includeAudio = ref(true)
const ioStatus = ref('')

function exportAll(): void {
  ioStatus.value = '正在导出...'
  try {
    const data: any = {
      version: 2,
      exportedAt: new Date().toISOString(),
      roles: store.roles.map(r => ({
        ...r,
        prompt: store.rolePromptCache[r.id] || r.promptPreview || '',
      })),
      asr: {
        engine: store.asrEngine,
        volc: getVolcConfig(),
        provider: asrProvider.value,
        model: asrModel.value,
      },
      config: {
        aiListen: store.config.aiListen,
        ttsPlayback: store.config.ttsPlayback,
        interruptMode: store.config.interruptMode,
      },
    }

    if (includeHistory.value) {
      const history = loadHistory()
      data.history = history
      if (includeAudio.value) {
        data.historyWithAudio = []
        // 音频导出：尝试 fetch 后端音频转 base64
        // 由于音频可能较大，这里只标记，实际导出提示用户
        ioStatus.value = '正在处理音频（可能较慢）...'
      }
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-meeting-settings-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    ioStatus.value = '导出成功！'
    setTimeout(() => { ioStatus.value = '' }, 3000)
  } catch (err) {
    ioStatus.value = `导出失败: ${err}`
  }
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

function handleImport(file: File): void {
  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target?.result as string)
      const confirmMsg = [
        `即将导入：`,
        data.roles ? `${data.roles.length} 个角色` : '',
        data.asr ? '语音识别配置' : '',
        data.history ? `${data.history.length} 条会议历史` : '',
      ].filter(Boolean).join('、')
      if (!confirm(`${confirmMsg}\n\n是否继续？`)) return

      // 导入角色
      if (Array.isArray(data.roles)) {
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
      }

      // 导入 ASR 配置
      if (data.asr?.volc) {
        saveVolcConfig({
          token: data.asr.volc.token || '',
          appid: data.asr.volc.appid || '',
          resourceId: data.asr.volc.resourceId,
          endpoint: data.asr.volc.endpoint,
        })
        Object.assign(volc.value, getVolcConfig(), { configured: true })
      }

      // 导入会议历史
      if (Array.isArray(data.history) && includeHistory.value) {
        data.history.forEach((entry: MeetingHistoryEntry) => {
          upsertHistory(entry)
        })
        store.history = loadHistory()
      }

      ioStatus.value = '导入成功！请刷新页面生效。'
      setTimeout(() => { ioStatus.value = '' }, 3000)
    } catch (err) {
      ioStatus.value = `导入失败: ${err}`
    }
  }
  reader.readAsText(file)
}

// ---------- 生命周期 ----------
onMounted(() => {
  store.requestRolePresets()
  if (props.initialRoleId) {
    const role = store.roles.find(r => r.id === props.initialRoleId)
    if (role) {
      activeTab.value = 'roles'
      selectRole(role)
    }
  }
})

onUnmounted(() => {
  if (previewing.value && store.state !== 'recording') stopVoicePlayback()
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    @click.self="props.onClose"
  >
    <div class="flex h-[85vh] w-[90vw] max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-warm-normal bg-warm-card shadow-2xl">
      <!-- 头部 -->
      <div class="flex items-center justify-between border-b border-warm-subtle px-5 py-[14px]">
        <h3 class="text-[16px] font-semibold text-warm-100">系统设置</h3>
        <button
          class="btn btn-ghost" style="height: 30px; width: 30px; padding: 0;"
          @click="props.onClose"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- 选项卡导航 -->
      <div class="flex border-b border-warm-subtle px-5">
        <button
          v-for="tab in [
            { key: 'roles', label: '角色管理' },
            { key: 'asr', label: '语音识别' },
            { key: 'io', label: '导入导出' },
          ]"
          :key="tab.key"
          class="relative px-4 py-[12px] text-[13px] font-medium transition"
          :class="activeTab === tab.key ? 'text-accent-warm' : 'text-warm-500 hover:text-warm-300'"
          @click="activeTab = tab.key as any"
        >
          {{ tab.label }}
          <span
            v-if="activeTab === tab.key"
            class="absolute bottom-0 left-0 right-0 h-[2px] rounded-full"
            style="background: var(--accent);"
          ></span>
        </button>
      </div>

      <!-- 内容区域 -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        <!-- ========== 角色管理 ========== -->
        <div v-if="activeTab === 'roles'" class="flex h-full min-h-0">
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
                <span v-if="role.defaultEnabled" class="tag tag-success ml-auto" style="font-size: 10px; padding: 1px 6px;">默认</span>
                <span v-else-if="!role.enabled" class="ml-auto text-[11px] text-warm-600">已关闭</span>
              </button>
            </div>

            <!-- 新建角色 -->
            <div class="mt-[14px]">
              <button class="btn btn-primary w-full" @click="createNew">
                <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                </svg>
                新建角色
              </button>
            </div>
          </div>

          <!-- 右侧：编辑表单 -->
          <div class="min-h-0 flex-1 overflow-y-auto p-[16px]">
            <template v-if="selectedRoleId || creating">
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
                    :class="{ 'cursor-wait opacity-70': saveState === 'saving' }"
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
                  <button class="btn btn-primary" @click="submitCreate">
                    <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                    </svg>
                    创建角色
                  </button>
                </template>
              </div>

              <!-- 详情区 -->
              <div class="flex gap-[14px]">
                <!-- 左：参数 -->
                <div class="w-[220px] shrink-0 space-y-[14px]">
                  <div>
                    <label class="form-label block text-[12px] text-warm-500">角色ID</label>
                    <input v-model="form.id" type="text" class="input" :disabled="!!selectedRoleId" placeholder="英文小写下划线" />
                  </div>
                  <div>
                    <label class="form-label block text-[12px] text-warm-500">角色名称</label>
                    <input v-model="form.name" type="text" class="input" placeholder="显示名称" />
                  </div>
                  <div>
                    <label class="form-label block text-[12px] text-warm-500">音色（可试听）</label>
                    <div class="flex gap-2">
                      <select v-model="form.voice" class="input min-w-0 flex-1">
                        <option v-for="v in availableVoices" :key="v.key" :value="v.key">{{ v.name }}</option>
                      </select>
                      <button class="btn shrink-0" :class="previewing ? 'btn-primary' : ''" @click="testVoice">
                        {{ previewing ? '■' : '▶' }}
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
                      ></button>
                    </div>
                  </div>
                  <div>
                    <label class="form-label block text-[12px] text-warm-500">自动思考间隔（秒）</label>
                    <input v-model.number="form.thinkIntervalSec" type="number" min="2" max="120" class="input" />
                  </div>
                  <div>
                    <label class="form-label block text-[12px] text-warm-500" title="数字小的先说">发言优先级（1 先说）</label>
                    <input v-model.number="form.priority" type="number" min="1" max="99" class="input" />
                  </div>
                  <div>
                    <label class="form-label block text-[12px] text-warm-500">行业标签</label>
                    <input v-model="form.industryTag" type="text" class="input" placeholder="如: 销售, 管理" />
                  </div>
                  <!-- 默认启用开关 -->
                  <div class="rounded-lg border border-warm-subtle bg-warm-input p-[10px]">
                    <label class="flex items-center justify-between">
                      <span class="text-[12px] text-warm-300">默认启动</span>
                      <button
                        role="switch"
                        :aria-checked="form.defaultEnabled"
                        class="switch"
                        :class="{ on: form.defaultEnabled }"
                        @click="form.defaultEnabled = !form.defaultEnabled"
                      />
                    </label>
                    <p class="mt-1 text-[11px] leading-4 text-warm-600">开启后，新会话自动启用该角色</p>
                  </div>
                  <div>
                    <label class="flex items-center justify-between text-[12px] text-warm-500">
                      <span>语音播放</span>
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

                <!-- 右：提示词 -->
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
                    <div v-for="preset in group.presets" :key="preset.id" class="card card-hover p-[10px]">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-[13px] font-medium text-warm-100">{{ preset.name }}</span>
                        <button class="btn btn-primary" style="height: 26px; padding: 0 10px; font-size: 11px;" @click="addPreset(preset)">添加</button>
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

        <!-- ========== 语音识别 ========== -->
        <div v-else-if="activeTab === 'asr'" class="p-[20px]">
          <div class="max-w-[600px] space-y-[18px]">
            <div>
              <h4 class="mb-2 text-[14px] font-medium text-warm-300">实时识别引擎</h4>
              <div class="segmented">
                <button :class="store.asrEngine === 'volc' ? 'active' : ''" @click="store.setAsrEngine('volc')">
                  火山豆包流式（云端）
                </button>
                <button :class="store.asrEngine === 'browser' ? 'active' : ''" @click="store.setAsrEngine('browser')">
                  浏览器内置（降级）
                </button>
              </div>
            </div>

            <!-- 火山配置 -->
            <div v-if="store.asrEngine === 'volc'" class="space-y-[14px] rounded-xl border border-warm-subtle bg-warm-input p-[16px]">
              <div class="flex items-center justify-between">
                <span class="text-[12px] text-warm-300">已内置默认 Key，开箱即用；下方可覆盖</span>
                <span class="flex items-center gap-2">
                  <span class="tag" :class="volc.hasCustomToken ? 'tag-info' : ''">
                    {{ volc.hasCustomToken ? '自定义 Key' : '内置默认' }}
                  </span>
                  <button v-if="volc.hasCustomToken" class="btn" style="height: 26px; padding: 0 8px; font-size: 11px;" @click="resetVolc">恢复默认</button>
                  <button class="btn" style="height: 26px; padding: 0 8px; font-size: 11px; color: var(--info);" @click="importFromEnv">从 .env 导入</button>
                </span>
              </div>

              <label class="block">
                <span class="form-label block text-[12px] text-warm-500">API Key <span class="ml-1 text-info-warm">← 点击<a class="underline" href="https://console.volcengine.com/audio/overview/" target="_blank">这里获取密钥</a></span></span>
                <input v-model="volc.token" type="text" autocomplete="off" spellcheck="false" class="input font-mono" placeholder="粘贴 API Key（UUID 格式）" @change="saveVolc" />
              </label>

              <label class="block">
                <span class="form-label block text-[12px] text-warm-500">App ID（选填，纯数字）</span>
                <input v-model="volc.appid" class="input font-mono" placeholder="纯数字 App ID，可留空" @change="saveVolc" />
              </label>

              <div>
                <span class="form-label block text-[12px] text-warm-500">模型</span>
                <div class="mt-1 flex flex-wrap gap-2">
                  <button class="tag transition hover:border-warm-hover" :class="asrModel === 'bigmodel' ? 'tag-info' : ''" style="cursor: pointer; padding: 4px 12px;" @click="asrModel = 'bigmodel'">推荐 · bigmodel</button>
                  <button class="tag transition hover:border-warm-hover" :class="asrModel === 'deep-punc' ? 'tag-info' : ''" style="cursor: pointer; padding: 4px 12px;" @click="asrModel = 'deep-punc'">deep-punc</button>
                </div>
              </div>

              <details class="text-[12px] text-warm-500">
                <summary class="cursor-pointer select-none py-1">高级（resource id / endpoint）</summary>
                <div class="mt-2 space-y-2">
                  <label class="block">
                    <span class="form-label block text-[12px] text-warm-500">Resource ID</span>
                    <input v-model="volc.resourceId" class="input font-mono" @change="saveVolc" />
                  </label>
                  <label class="block">
                    <span class="form-label block text-[12px] text-warm-500">端点</span>
                    <input v-model="volc.endpoint" class="input font-mono" @change="saveVolc" />
                  </label>
                </div>
              </details>

              <!-- ASR 配置测试 -->
              <div class="border-t border-warm-subtle pt-[14px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] text-warm-300">配置测试</span>
                  <button
                    class="btn btn-primary"
                    style="height: 32px; padding: 0 16px; font-size: 12px;"
                    :disabled="asrTesting"
                    @click="testAsrConfig"
                  >
                    {{ asrTesting ? '测试中...' : '测试识别' }}
                  </button>
                </div>
                <p class="mt-2 text-[11px] text-warm-500">自动生成一段测试语音，验证 API Key、模型和网络是否正常</p>

                <!-- 测试结果 -->
                <div v-if="asrTestResult || asrTestError || asrTestExpected" class="mt-3 space-y-2 rounded-lg border border-warm-subtle bg-warm-deepest p-[12px]">
                  <div v-if="asrTestExpected" class="text-[12px]">
                    <span class="text-warm-500">预期文本：</span>
                    <span class="text-warm-300">{{ asrTestExpected }}</span>
                  </div>
                  <div v-if="asrTestResult" class="text-[12px]">
                    <span class="text-warm-500">识别结果：</span>
                    <span class="text-success-warm">{{ asrTestResult }}</span>
                  </div>
                  <div v-if="asrTestError" class="text-[12px]">
                    <span class="text-warm-500">错误信息：</span>
                    <span class="text-danger-warm">{{ asrTestError }}</span>
                  </div>
                  <div v-if="asrTestResult && !asrTestError" class="text-[11px] text-success-warm">
                    ✓ 配置正常，ASR 识别成功
                  </div>
                </div>
              </div>
            </div>

            <!-- 浏览器内置提示 -->
            <div v-else class="rounded-xl border border-warm-subtle bg-warm-input p-[16px] text-[13px] text-warm-300">
              <p>浏览器内置语音识别（Web Speech API），无需配置，但识别准确率和稳定性取决于浏览器。</p>
              <p class="mt-2 text-warm-500">建议使用 Chrome 浏览器以获得最佳效果。</p>
            </div>
          </div>
        </div>

        <!-- ========== 导入导出 ========== -->
        <div v-else-if="activeTab === 'io'" class="p-[20px]">
          <div class="max-w-[600px] space-y-[18px]">
            <!-- 导出 -->
            <div class="rounded-xl border border-warm-subtle bg-warm-input p-[16px]">
              <h4 class="mb-3 text-[14px] font-medium text-warm-300">导出配置</h4>
              <p class="mb-3 text-[12px] text-warm-500">导出角色管理参数、语音识别模型配置，可选包含会议历史记录</p>

              <label class="mb-2 flex items-center gap-2 text-[13px] text-warm-300">
                <input type="checkbox" v-model="includeHistory" class="h-4 w-4 rounded accent-warm" />
                包含会议历史记录
              </label>
              <label v-if="includeHistory" class="mb-3 flex items-center gap-2 pl-6 text-[12px] text-warm-500">
                <input type="checkbox" v-model="includeAudio" class="h-3.5 w-3.5 rounded accent-warm" />
                包含音频文件（导出文件较大）
              </label>

              <button class="btn btn-primary w-full" @click="exportAll">
                <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                导出全部配置
              </button>
            </div>

            <!-- 导入 -->
            <div class="rounded-xl border border-warm-subtle bg-warm-input p-[16px]">
              <h4 class="mb-3 text-[14px] font-medium text-warm-300">导入配置</h4>
              <p class="mb-3 text-[12px] text-warm-500">从 JSON 文件导入完整配置，包括角色、模型设置和会议历史</p>

              <label class="mb-2 flex items-center gap-2 text-[13px] text-warm-300">
                <input type="checkbox" v-model="includeHistory" class="h-4 w-4 rounded accent-warm" />
                同时导入会议历史记录
              </label>

              <button class="btn w-full" @click="triggerImport">
                <svg viewBox="0 0 24 24" class="h-[14px] w-[14px]" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M21 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5m0 0l5 5m-5-5v12" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                选择文件导入
              </button>
            </div>

            <!-- 状态提示 -->
            <div v-if="ioStatus" class="rounded-lg border border-info-warm/30 bg-info-soft px-4 py-3 text-[13px] text-info-warm">
              {{ ioStatus }}
            </div>

            <!-- 说明 -->
            <div class="rounded-lg bg-warm-tag p-[12px] text-[12px] leading-5 text-warm-500">
              <p class="font-medium text-warm-400">说明：</p>
              <ul class="mt-1 list-disc pl-4 space-y-1">
                <li>导出文件包含：角色配置（含提示词）、语音识别引擎配置、全局设置</li>
                <li>勾选"包含会议历史"时，同时导出转写记录和 AI 事件</li>
                <li>音频文件较大时导出可能较慢，建议按需选择</li>
                <li>导入会覆盖同名角色配置，会议历史按 ID 合并</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
