<script setup lang="ts">
/**
 * 主布局：顶栏（简化）/ 左栏（录音+计时+ASR配置+转写） / 右栏（角色栏+AI输出多栏/历史）。
 * 左侧 = 用户录音相关；右侧 = AI 角色相关。
 * 设置/会话信息已内联到左侧面板（RecorderPanel），不再需要独立弹窗。
 * 2026-08-27：打断提示条移入 AgentFeed 各角色列内（打断方一侧）；左侧回放时间轴已删除。
 */
import { onMounted } from 'vue'
import { useMeetingStore } from './stores/meeting'
import TopBar from './components/TopBar.vue'
import RecorderPanel from './components/RecorderPanel.vue'
import RoleBar from './components/RoleBar.vue'
import AgentFeed from './components/AgentFeed.vue'
import PostTalkBar from './components/PostTalkBar.vue'
import HistoryPanel from './components/HistoryPanel.vue'

const store = useMeetingStore()

onMounted(() => {
  store.init()
})
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden">
    <TopBar />

    <main class="flex min-h-0 flex-1">
      <!-- 左侧（w-96）：录音控制 + ASR 配置 + 实时转写 -->
      <RecorderPanel />

      <!-- 右侧：AI 角色内容或历史视图 -->
      <section v-if="store.view === 'live'" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
        <!-- 角色栏：全局控制 + 角色横向排列 -->
        <RoleBar />

        <!-- AI 输出区域（多栏，按角色数自适应；打断条在各角色列内） -->
        <div class="min-h-0 flex-1">
          <AgentFeed />
        </div>
      </section>
      <HistoryPanel v-else />
    </main>

    <PostTalkBar />
  </div>
</template>
