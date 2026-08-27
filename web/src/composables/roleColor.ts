/**
 * 角色配色映射。Tailwind JIT 无法解析拼接类名，必须显式全量列出。
 */
export interface RoleColorSet {
  dot: string
  text: string
  border: string
  soft: string
  badge: string
}

const COLORS: Record<string, RoleColorSet> = {
  sky: {
    dot: 'bg-sky-400',
    text: 'text-sky-400',
    border: 'border-sky-500/40',
    soft: 'bg-sky-500/10',
    badge: 'bg-sky-500/15 text-sky-300',
  },
  amber: {
    dot: 'bg-amber-400',
    text: 'text-amber-400',
    border: 'border-amber-500/40',
    soft: 'bg-amber-500/10',
    badge: 'bg-amber-500/15 text-amber-300',
  },
  rose: {
    dot: 'bg-rose-400',
    text: 'text-rose-400',
    border: 'border-rose-500/40',
    soft: 'bg-rose-500/10',
    badge: 'bg-rose-500/15 text-rose-300',
  },
  violet: {
    dot: 'bg-violet-400',
    text: 'text-violet-400',
    border: 'border-violet-500/40',
    soft: 'bg-violet-500/10',
    badge: 'bg-violet-500/15 text-violet-300',
  },
  emerald: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
    border: 'border-emerald-500/40',
    soft: 'bg-emerald-500/10',
    badge: 'bg-emerald-500/15 text-emerald-300',
  },
}

export function roleColor(colorKey: string): RoleColorSet {
  return COLORS[colorKey] ?? COLORS.sky
}

/** 毫秒 -> mm:ss 时间戳 */
export function msToStamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
