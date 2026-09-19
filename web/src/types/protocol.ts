/**
 * WebSocket 消息协议（与 docs/02-架构设计.md §5 对齐）
 * 前后端共同遵守；改这里必须同步改架构文档。
 */

// ---------- 会议状态机 ----------
/**
 * 会议只有开始/结束两态：idle（未开始）-> recording（进行中，录音+识别同步）-> closed（已结束）。
 * 点击结束：录音与识别立即同步停止，无会后持续监听。
 */
export type MeetingState = 'idle' | 'recording' | 'paused' | 'closed'

// ---------- 上行（浏览器 -> gateway）----------
export type ClientMessage =
  | { type: 'meeting.start'; patch?: { interruptMode?: string; aiListen?: boolean; ttsPlayback?: boolean } }
  | { type: 'meeting.pause' }
  | { type: 'meeting.resume' }
  | { type: 'meeting.stop' }
  | { type: 'meeting.close' } // 彻底关闭（角色进程退出）
  | { type: 'meeting.rename'; title: string } // 用户修改会议标题
  | { type: 'transcript.edit'; itemId: string; text: string }
  | { type: 'user.text'; text: string } // 会后交流文字输入
  | { type: 'user.speech'; text: string } // 用户语音转写增量（实时推给角色代理）
  | { type: 'user.note'; text: string } // 提示词输入框内容（同样进入所有角色上下文）
  | {
      type: 'config.update'
      patch: {
        interruptMode?: 'noInterrupt' | 'allowInterrupt'
        aiListen?: boolean
        ttsPlayback?: boolean // 全局主开关（各角色还可以单独开关）
        roles?: {
          id: string
          enabled?: boolean
          thinkIntervalSec?: number // 每隔多少秒"思考一次"并输出（默认 10）
          ttsEnabled?: boolean // 该角色是否允许语音播放（默认 false）
          priority?: number // 发言顺序优先级（1 最高，同轮到期小者先说）
          interruptEnabled?: boolean // 该角色「可打断/不打扰」开关（2026-08-27 起按角色独立，默认不打扰）
        }[]
      }
    }
  // 角色 CRUD
  | { type: 'role.create'; role: { id: string; name: string; voice: string; color: string; description: string; prompt: string; thinkIntervalSec?: number; ttsEnabled?: boolean; industryTag?: string } }
  | { type: 'role.delete'; id: string }
  | { type: 'role.update_prompt'; id: string; prompt: string } // 编辑提示词
  | { type: 'role.get_prompt'; id: string } // 请求读取完整提示词
  | { type: 'role.presets.list' } // 请求预设列表

// ---------- 下行（gateway -> 浏览器）----------
export type ServerMessage =
  | { type: 'meeting.state'; state: MeetingState; meetingId?: string; claudeSessionIds?: Record<string, string> }
  | { type: 'meeting.started'; meetingId: string; startedAt: number; claudeSessionIds: Record<string, string> }
  | { type: 'claude.models'; models: Record<string, string> } // 各角色实际模型名（CLI init 后异步推送）
  | { type: 'meeting.title'; title: string } // AI 自动生成的会议标题
  | { type: 'transcript.delta'; itemId: string; tsMs: number; text: string; speaker?: 'user' | string }
  | { type: 'agent.observe'; id: string; role: string; text: string; sentiment?: string; tsMs: number }
  | { type: 'agent.reply'; id: string; role: string; text: string; tsMs: number }
  | { type: 'agent.listen'; id: string; role: string; text: string; tsMs: number } // 「再听听」：本轮不开口，只记卡片
  | {
      type: 'agent.interrupt'
      id: string
      role: string
      text: string
      urgency: 'low' | 'medium' | 'high'
      executed: boolean // 可打断模式=true；不打断模式降级为 observe
      tsMs: number
    }
  | { type: 'agent.state'; role: string; state: string; detail: string } // 角色运行状态更新（时间线）
  | { type: 'tts.start'; role: string; windowId: string }
  | { type: 'tts.end'; windowId: string }
  | { type: 'asr.status'; status: 'loading' | 'ready' | 'unloaded' | 'error'; detail?: string }
  | {
      type: 'meeting.archived'
      path: string
      summary: string
      transcriptFile: string // 纯用户转写（后缀：.用户.txt）
      combinedFile: string // 用户 + 多AI（后缀：.用户+AI.txt）
    }
  | { type: 'user.text.echo'; text: string; tsMs: number }
  | { type: 'roles.list'; roles: RoleInfo[] }
  | { type: 'role.prompt'; id: string; prompt: string } // 完整提示词（role.get_prompt 的响应）
  | { type: 'role.presets'; presets: RolePresetGroup[] } // 内置预设（按行业分组）
  | { type: 'error'; detail: string }

// ---------- 角色 ----------
export interface RoleInfo {
  id: string
  name: string
  voice: string // CosyVoice 音色名
  color: string // 前端主题色（tailwind 色系标识）
  enabled: boolean
  defaultEnabled: boolean // 是否默认启动（新会话/重置时是否自动启用）
  thinkIntervalSec: number // 每隔多少秒"思考一次"（默认 60）
  ttsEnabled: boolean // 是否允许该角色语音播放
  interruptEnabled: boolean // 该角色「可打断」开关（列头控件；默认 false 不打扰）
  promptPreview?: string // 角色提示词预览（只读）
  priority: number // 打断仲裁优先级，小者优先
  interruptAggressiveness: 'low' | 'medium' | 'high'
  description: string
  industryTag?: string // 行业标签（如"销售"、"营销"、"建筑"）
}

// ---------- 角色预设系统 ----------
export interface RolePreset {
  id: string
  name: string
  description: string
  voice: string
  color: string
  priority: number
  interruptAggressiveness: 'low' | 'medium' | 'high'
  thinkIntervalSec: number
  ttsEnabled: boolean
  prompt: string // 完整的提示词模板
}

export interface RolePresetGroup {
  industryTag: string // 行业标签："销售"、"营销"、"建筑"等
  presets: RolePreset[]
}

// ---------- 预置角色（mock / 首屏兜底；真实列表由 gateway 下发）----------
export const DEFAULT_THINK_INTERVAL = 10

export const DEFAULT_ROLES: RoleInfo[] = [
  {
    id: 'customer',
    name: '客户',
    voice: '高晴',
    color: 'sky',
    enabled: false,
    defaultEnabled: false,
    thinkIntervalSec: DEFAULT_THINK_INTERVAL,
    ttsEnabled: false,
    interruptEnabled: false,
    priority: 2,
    interruptAggressiveness: 'high',
    description: '有顾虑的潜在客户，随时抛出异议，检验你的推销与应变能力',
    industryTag: '销售',
  },
  {
    id: 'boss',
    name: '老板',
    voice: '王新月',
    color: 'amber',
    enabled: false,
    defaultEnabled: false,
    thinkIntervalSec: DEFAULT_THINK_INTERVAL,
    ttsEnabled: false,
    interruptEnabled: false,
    priority: 1,
    interruptAggressiveness: 'medium',
    description: '管理层视角，直接犀利，复盘式提问，关注结果与风险',
    industryTag: '管理',
  },
]