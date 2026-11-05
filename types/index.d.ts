export type View = 'off' | 'dot' | 'bar' | 'full'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Sample = { t: number; pct: number; resetsAt: string }

export type Tokens = { in: number; out: number; cr: number; cw: number; n: number }

export type Period = {
  total: Tokens
  session: Tokens
  models: Record<string, Tokens>
  sessions: number
  activeDays: number
  projects: { name: string; tokens: number }[]
}

export type SessionStats = { contextPercent?: number; usd?: number }

export type Summary = {
  generatedAt: number
  utcOffsetMs: number
  firstDay: string | null
  periods: Record<'today' | 'week' | 'month' | 'year' | 'all', Period>
  days: (Tokens & { key: string })[]
  hoursToday: number[]
  hoursYesterday: number[]
  heat: number[][]
  compare: { yesterdayByNow: number; lastWeekByNow: number; lastMonthByNow: number }
  topSessions: { id: string; isThis: boolean; project: string; tokens: number; replies: number }[]
  months: (Tokens & { key: string })[]
  years: (Tokens & { key: string })[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      view: View
      limits: Limit[]
      samples: Sample[]
      summary: Summary | null
      scanNote: string | null
      tick: number
      session: SessionStats | null
    }
  }
}
