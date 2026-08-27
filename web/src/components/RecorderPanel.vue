<script setup lang="ts">
/**
 * 录音工作台（左侧面板）：
 * - 顶部标题栏：会议标题（可编辑）+ 当前功能状态（语音识别引擎/Claude 模型/会话 ID 参数）
 * - 录音控制：开始/暂停/继续 + 结束 + 计时（合并卡片）
 * - ASR 配置折叠卡（提供商/模型/Key）
 * - 回放时间轴 + 实时转写
 */
import { reactive, ref } from 'vue'
import { useMeetingStore } from '../stores/meeting'
import { getVolcConfig, saveVolcConfig, loadVolcFromServer } from '../services/volcAsr'
import TranscriptPanel from './TranscriptPanel.vue'

const store = useMeetingStore()
const asrExpanded = ref(false)
const paramsExpanded = ref(false)

// 会议标题编辑
const titleEditing = ref(false)
const titleDraft = ref('')

function startTitleEdit(): void {
  titleDraft.value = store.meetingTitle
  titleEditing.value = true
}

function commitTitle(): void {
  store.setMeetingTitle(titleDraft.value)
  titleEditing.value = false
}

// ASR 配置表单
const volc = reactive({
  ...getVolcConfig(),
  configured: getVolcConfig().ready,
})

// 提供商/模型选择
const asrProvider = ref<'volc' | 'alibaba'>('volc')
const asrModel = ref('bigmodel') // 火山默认模型

const alibaba = reactive({
  appKey: '',
  model: 'fun-asr-realtime',
})

function saveVolc(): void {
  saveVolcConfig({
    appid: volc.appid.trim(),
    token: volc.token.trim(),
    resourceId: volc.resourceId,
    endpoint: volc.endpoint,
  })
  // 同步回显状态（是否自定义 Key）
  volc.configured = !!volc.token.trim()
  Object.assign(volc, getVolcConfig())
}


/** 2026-08-27 开源配套：从 gateway 的 .env 拉取豆包 ASR 配置并填入（改 .env 后点此生效） */
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
  Object.assign(volc, getVolcConfig(), { configured: true })
}

function resetVolc(): void {
  localStorage.removeItem('volc-asr:token')
  localStorage.removeItem('volc-asr:appid')
  Object.assign(volc, getVolcConfig(), { configured: true })
}

function toggleRecording(): void {
  if (store.state === 'idle') {
    void store.start()
  } else if (store.state === 'recording') {
    store.pause()
  } else if (store.state === 'paused') {
    store.resume()
  }
}

function stopRecording(): void {
  if (store.state !== 'idle') store.stop()
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}
</script>

<template>
  <aside class="flex w-96 min-w-0 flex-col gap-3 border-r border-zinc-800/70 bg-zinc-950/40 p-4">
    <!-- ===== 顶部标题栏 ===== -->
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <!-- 会议标题（可编辑） -->
      <div class="flex items-center gap-2 border-b border-zinc-800/70 px-3 py-2.5">
        <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke-linecap="round" />
        </svg>
        <input
          v-if="titleEditing"
          v-model="titleDraft"
          class="min-w-0 flex-1 rounded bg-zinc-950 px-2 py-1 text-sm font-medium text-zinc-100 outline-none ring-1 ring-sky-600/60"
          placeholder="输入会议标题…"
          @keydown.enter.prevent="commitTitle"
          @keydown.esc="titleEditing = false"
          @blur="commitTitle"
        />
        <button
          v-else
          class="min-w-0 flex-1 truncate text-left text-sm font-medium text-zinc-100 transition hover:text-sky-300"
          title="点击编辑标题"
          @click="startTitleEdit"
        >
          {{ store.meetingTitle || '未命名会议（点击编辑）' }}
        </button>
      </div>

      <!-- 当前功能状态行 -->
      <div class="flex items-center gap-2 px-3 py-2 text-[11px]">
        <span class="flex items-center gap-1 text-zinc-400">
          <span class="h-1.5 w-1.5 rounded-full" :class="store.state === 'recording' ? 'bg-emerald-500 animate-pulse' : store.state === 'paused' ? 'bg-amber-500' : 'bg-zinc-600'"></span>
          {{ store.state === 'idle' ? '待机' : store.state === 'recording' ? '录音中' : store.state === 'paused' ? '已暂停' : '已结束' }}
        </span>
        <span class="flex items-center gap-1 text-zinc-500">
          <span class="h-1.5 w-1.5 rounded-full" :class="volc.configured ? 'bg-sky-500' : 'bg-zinc-600'"></span>
          语音识别 {{ asrProvider === 'volc' ? '火山' : '阿里' }}·{{ asrModel }}
        </span>
        <button
          class="ml-auto flex items-center gap-1 text-zinc-500 transition hover:text-zinc-300"
          @click="paramsExpanded = !paramsExpanded"
        >
          参数
          <svg
            viewBox="0 0 24 24"
            class="h-3 w-3 transition"
            :class="paramsExpanded ? 'rotate-180' : ''"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- 参数详情（折叠）：Claude 模型 / 会话 ID -->
      <div v-if="paramsExpanded" class="space-y-1.5 border-t border-zinc-800/70 px-3 py-2 text-[10px]">
        <!-- Claude 模型 -->
        <div>
          <span class="text-zinc-500">Claude 模型</span>
          <div class="mt-0.5 space-y-0.5">
            <div v-for="(mdl, rid) in store.claudeModels" :key="rid" class="flex items-center gap-2">
              <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">{{ store.roleById.get(rid)?.name ?? rid }}</span>
              <span class="font-mono text-zinc-300">{{ mdl }}</span>
            </div>
            <div v-if="!Object.keys(store.claudeModels).length" class="text-zinc-600">会议开始后显示</div>
          </div>
        </div>
        <!-- Claude 会话 ID -->
        <div>
          <span class="text-zinc-500">Claude 会话 ID</span>
          <div class="mt-0.5 space-y-0.5">
            <div v-for="(sid, rid) in store.claudeSessionIds" :key="rid" class="flex items-center gap-2">
              <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">{{ store.roleById.get(rid)?.name ?? rid }}</span>
              <span class="max-w-[200px] truncate font-mono text-zinc-500" :title="String(sid)">{{ sid }}</span>
              <button
                class="shrink-0 text-zinc-600 transition hover:text-zinc-300"
                title="复制"
                @click="copyText(String(sid))"
              >
                <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <div v-if="!Object.keys(store.claudeSessionIds).length" class="text-zinc-600">会议开始后显示</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 录音控制（开始/暂停/继续 + 结束 + 计时）===== -->
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div class="flex items-center gap-3">
        <!-- 主按钮 -->
        <button
          class="flex h-14 w-14 items-center justify-center rounded-full transition"
          :class="store.state === 'recording'
            ? 'bg-amber-500 shadow-lg shadow-amber-500/30 hover:bg-amber-400'
            : 'bg-emerald-600 hover:bg-emerald-500'"
          :title="store.state === 'idle' ? '开始录音' : store.state === 'recording' ? '暂停录音' : '恢复录音'"
          @click="toggleRecording"
        >
          <svg v-if="store.state === 'recording'" viewBox="0 0 24 24" class="h-5 w-5 text-white" fill="currentColor">
            <rect x="7" y="5" width="4" height="14" rx="1" />
            <rect x="13" y="5" width="4" height="14" rx="1" />
          </svg>
          <svg v-else-if="store.state === 'paused'" viewBox="0 0 24 24" class="h-5 w-5 text-white" fill="currentColor">
            <path d="M8 5.14v13.72c0 .8.87 1.3 1.57.9l11.1-6.86a1.05 1.05 0 0 0 0-1.8L9.57 4.24A1.05 1.05 0 0 0 8 5.14z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" class="h-5 w-5 text-white" fill="currentColor">
            <path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z" />
            <path d="M6 14h12v1a6 6 0 0 1-12 0v-1z" />
          </svg>
        </button>

        <!-- 结束按钮 -->
        <button
          v-if="store.state === 'recording' || store.state === 'paused'"
          class="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition hover:bg-red-600/80 hover:text-white"
          title="结束录音"
          @click="stopRecording"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
          </svg>
        </button>

        <div class="flex flex-col">
          <span class="font-mono text-2xl font-bold tracking-wider" :class="store.state === 'recording' ? 'text-amber-400' : store.state === 'paused' ? 'text-zinc-500' : 'text-zinc-300'">
            {{ store.elapsedText }}
          </span>
          <span class="text-[11px] text-zinc-500">
            {{ store.state === 'idle' ? '准备就绪' : store.state === 'recording' ? '正在录音·识别中' : store.state === 'paused' ? '已暂停·不识别' : '录音已结束' }}
          </span>
        </div>
      </div>
    </div>

    <!-- ===== 语音识别配置（折叠式） ===== -->
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        class="flex w-full items-center justify-between px-3 py-2 text-xs text-zinc-400 transition hover:text-zinc-200"
        @click="asrExpanded = !asrExpanded"
      >
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="volc.configured ? 'bg-emerald-500' : 'bg-amber-500'"></span>
          <span class="font-medium">语音识别设置</span>
          <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {{ asrProvider === 'volc' ? '火山引擎' : '阿里云' }} · {{ asrModel }}
          </span>
        </div>
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5 transition"
          :class="asrExpanded ? 'rotate-180' : ''"
          fill="none" stroke="currentColor" stroke-width="2"
        >
          <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <Transition
        enter-active-class="transition-all duration-200"
        enter-from-class="max-h-0 opacity-0"
        leave-active-class="transition-all duration-150"
        leave-to-class="max-h-0 opacity-0"
      >
        <div v-if="asrExpanded" class="border-t border-zinc-800/80 px-3 pb-3 pt-2.5 space-y-2.5">
          <!-- 提供商选择 -->
          <div>
            <span class="text-[10px] text-zinc-500">语音识别服务商</span>
            <div class="mt-1 flex rounded-lg bg-zinc-950 p-0.5 ring-1 ring-zinc-800">
              <button
                class="flex-1 rounded-md px-2 py-1 text-[11px] transition"
                :class="asrProvider === 'volc' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
                @click="asrProvider = 'volc'"
              >
                火山引擎
              </button>
              <button
                class="flex-1 rounded-md px-2 py-1 text-[11px] transition"
                :class="asrProvider === 'alibaba' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
                @click="asrProvider = 'alibaba'"
              >
                阿里云
              </button>
            </div>
          </div>

          <!-- 火山配置 -->
          <template v-if="asrProvider === 'volc'">
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-zinc-400">默认 Key 来自服务端 .env；下方可覆盖</span>
              <span class="flex items-center gap-1.5">
                <span
                  class="rounded-full px-1.5 py-0.5 text-[10px]"
                  :class="volc.hasCustomToken ? 'bg-sky-500/15 text-sky-300' : 'bg-zinc-700/60 text-zinc-400'"
                >
                  {{ volc.hasCustomToken ? '自定义 Key' : '内置默认' }}
                </span>
                <button
                  v-if="volc.hasCustomToken"
                  class="rounded px-1 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
                  @click="resetVolc"
                >
                  恢复默认
                </button>
                <button
                  class="rounded px-1 py-0.5 text-[10px] text-sky-400/80 transition hover:bg-sky-500/10 hover:text-sky-300"
                  title="读取服务端 .env 的豆包 ASR 配置并填入（修改 .env 后点此生效）"
                  @click="importFromEnv"
                >
                  从 .env 导入
                </button>
              </span>
            </div>
            <label class="block">
              <span class="mb-1 block text-[10px] text-zinc-500">
                API Key<span class="ml-1 text-sky-400">← 点击<a class="underline" href="https://console.volcengine.com/audio/overview/" target="_blank">这里获取密钥</a></span>
              </span>
              <input
                v-model="volc.token"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-sky-600/60"
                placeholder="粘贴 API Key（UUID 格式）"
                @change="saveVolc"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-[10px] text-zinc-500">App ID（选填）</span>
              <input
                v-model="volc.appid"
                class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-sky-600/60"
                placeholder="纯数字 App ID，可留空"
                @change="saveVolc"
              />
            </label>
            <!-- 模型选择 -->
            <div>
              <span class="mb-1 block text-[10px] text-zinc-500">模型</span>
              <div class="flex flex-wrap gap-1">
                <button
                  class="rounded px-2 py-1 text-[10px] transition"
                  :class="asrModel === 'bigmodel' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                  @click="asrModel = 'bigmodel'"
                >
                  推荐 · bigmodel
                </button>
                <button
                  class="rounded px-2 py-1 text-[10px] transition"
                  :class="asrModel === 'deep-punc' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                  @click="asrModel = 'deep-punc'"
                >
                  deep-punc
                </button>
              </div>
            </div>
          </template>

          <!-- 阿里云配置 -->
          <template v-if="asrProvider === 'alibaba'">
            <p class="text-[10px] text-zinc-500">阿里云语音识别配置（可留空，后续完善）</p>
            <label class="block">
              <span class="mb-1 block text-[10px] text-zinc-500">
                AppKey<span class="ml-1 text-zinc-600">← 点击<a class="underline" href="https://nls-portal.console.aliyun.com/" target="_blank">这里获取密钥</a></span>
              </span>
              <input
                v-model="alibaba.appKey"
                type="text"
                autocomplete="off"
                class="w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-800"
                placeholder="阿里云 AppKey"
              />
            </label>
            <!-- 阿里云模型选择 -->
            <div>
              <span class="mb-1 block text-[10px] text-zinc-500">模型</span>
              <div class="flex flex-wrap gap-1">
                <button
                  class="rounded px-2 py-1 text-[10px] transition"
                  :class="alibaba.model === 'fun-asr-realtime' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                  @click="alibaba.model = 'fun-asr-realtime'"
                >
                  推荐 · fun-asr-realtime
                </button>
                <button
                  class="rounded px-2 py-1 text-[10px] transition"
                  :class="alibaba.model === 'qwen3-asr-flash-realtime' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                  @click="alibaba.model = 'qwen3-asr-flash-realtime'"
                >
                  qwen3-asr-flash-realtime
                </button>
                <button
                  class="rounded px-2 py-1 text-[10px] transition"
                  :class="alibaba.model === 'fun-asr-flash-2026-06-15' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                  @click="alibaba.model = 'fun-asr-flash-2026-06-15'"
                >
                  fun-asr-flash-2026-06-15
                </button>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <!-- ===== 实时转写（剩余空间）===== -->
    <div class="flex min-h-0 flex-1 flex-col">
      <TranscriptPanel />
    </div>
  </aside>
</template>
