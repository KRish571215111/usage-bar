// Every chart the usage bar draws, as SVG text. Pure: numbers in, markup out.
// Each card paints its own dark background, so it reads on any app theme.
import type { Limit, Sample, SessionStats, Summary, Tokens } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY

// The person's offset from UTC. A hooks module's own clock may not know it, so
// the scanner, which runs on the host, reports it and register.tsx sets it here.
let shift = -new Date().getTimezoneOffset() * MIN

export function setUtcOffset(ms: number): void {
  shift = ms
}

export const GREEN = '#22c55e'
export const ORANGE = '#f97316'
export const RED = '#ef4444'
export const GRAY = '#9ca3af'

const BG = '#14161b'
const TILE = '#1b1e25'
const LINE = '#2a2e37'
const TEXT = '#f3f4f6'
const MUTED = '#9ca3af'
const CLAUDE = '#d97757'
const BLUE = '#60a5fa'
const PURPLE = '#a78bfa'
const TEAL = '#2dd4bf'
const YELLOW = '#fbbf24'
const SERIES = [CLAUDE, BLUE, PURPLE, TEAL, YELLOW, '#f472b6', GREEN, MUTED]

export type Prediction = {
  color: string
  text: string
  runsOutAt?: number
  /** Percent per millisecond, the pace the prediction ran forward. */
  rate?: number
}

export const tokensOf = (t: Tokens) => t.in + t.out + t.cr + t.cw

// The unit that fits the number: 850K, 50.2M, 4.41B, 1.20T.
export function amount(n: number): string {
  const size = Math.abs(n)
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const
  for (const [unit, name] of units) {
    if (size >= unit) {
      const v = n / unit

      return `${Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)}${name}`
    }
  }

  return String(Math.round(n))
}

// The same on a chart's own bars, where there is room for fewer digits.
function short(n: number): string {
  const text = amount(n)

  return text.replace(/\.\d+(?=[KMBT])/, match => (Math.abs(n) >= 1e9 ? match.slice(0, 2) : ''))
}

const local = (ms: number) => new Date(ms + shift)

export const localHour = (ms: number) => local(ms).getUTCHours()
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function clockTime(ms: number): string {
  const d = local(ms)
  const h = d.getUTCHours()
  const m = String(d.getUTCMinutes()).padStart(2, '0')

  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

export function dayName(ms: number, now: number): string {
  const days = Math.floor((ms + shift) / DAY) - Math.floor((now + shift) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'

  return WEEKDAYS[local(ms).getUTCDay()] as string
}

export function when(ms: number, now: number): string {
  return `${dayName(ms, now)} ${clockTime(ms)}`
}

export function countdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`

  return `${m}m`
}

export const pctColor = (pct: number) => (pct >= 90 ? RED : pct >= 70 ? ORANGE : GREEN)

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Names that share a start stay apart: my-app…frontend, my-app…backend.
function clipMiddle(s: string, n: number): string {
  if (s.length <= n) return s
  const end = Math.floor((n - 1) / 2)

  return `${s.slice(0, n - 1 - end)}…${s.slice(-end)}`
}

const round = (n: number) => Math.round(n * 10) / 10

type TextOptions = {
  size?: number
  color?: string
  anchor?: 'start' | 'middle' | 'end'
  weight?: number
}

function t(x: number, y: number, text: string, o: TextOptions = {}): string {
  return `<text x="${round(x)}" y="${round(y)}" font-size="${o.size ?? 12}" fill="${o.color ?? TEXT}" text-anchor="${o.anchor ?? 'start'}" font-weight="${o.weight ?? 400}">${esc(text)}</text>`
}

function rect(x: number, y: number, w: number, h: number, fill: string, r = 0): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, w))}" height="${round(Math.max(0, h))}" rx="${r}" fill="${fill}"/>`
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, dash = ''): string {
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${color}" stroke-width="1"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
}

function svg(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">${inner}</svg>`
}

function card(w: number, h: number, title: string, inner: string, note = ''): string {
  return svg(
    w,
    h,
    rect(0.5, 0.5, w - 1, h - 1, BG, 12).replace('/>', ` stroke="${LINE}"/>`) +
      t(16, 25, title, { size: 13, weight: 600 }) +
      (note ? t(w - 16, 25, note, { size: 11, color: MUTED, anchor: 'end' }) : '') +
      inner,
  )
}

function ring(cx: number, cy: number, r: number, pct: number, color: string, width = 10): string {
  const c = 2 * Math.PI * r
  const shown = (Math.min(100, Math.max(0, pct)) / 100) * c

  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LINE}" stroke-width="${width}"/>` +
    (shown > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${round(shown)} ${round(c)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : '')
  )
}

type Part = { name: string; value: number; color: string }

// A ring cut into slices, biggest first.
function donut(cx: number, cy: number, r: number, parts: readonly Part[]): string {
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1
  const c = 2 * Math.PI * r
  let at = 0
  let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LINE}" stroke-width="16"/>`
  for (const p of parts) {
    const len = (p.value / total) * c
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.color}" stroke-width="16" stroke-dasharray="${round(len)} ${round(c)}" stroke-dashoffset="${round(-at)}" transform="rotate(-90 ${cx} ${cy})"/>`
    at += len
  }

  return out
}

function legend(x: number, y: number, parts: readonly Part[], width: number): string {
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1

  return parts
    .map((p, i) => {
      const yy = y + i * 19

      return (
        rect(x, yy - 9, 9, 9, p.color, 2) +
        t(x + 15, yy, clip(p.name, 15), { size: 11 }) +
        t(x + width, yy, `${amount(p.value)} · ${Math.round((p.value / total) * 100)}%`, {
          size: 11,
          color: MUTED,
          anchor: 'end',
        })
      )
    })
    .join('')
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour session'
  if (kind === 'seven_day') return 'Weekly, all models'
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
  const scoped = /^(seven_day|five_hour)_(.+)$/.exec(kind)
  if (scoped) {
    const scope = (scoped[2] as string).split('_').map(cap).join(' ')

    return `${scoped[1] === 'seven_day' ? 'Weekly' : '5-hour'}, ${scope}`
  }

  return cap(kind.replace(/_/g, ' '))
}

function clockOrDay(ms: number, now: number): string {
  const name = dayName(ms, now)
  if (name === 'today') return clockTime(ms)

  return `${name === 'tomorrow' ? 'tmrw' : name.slice(0, 3)} ${clockTime(ms)}`
}

/** The bar itself: two meters, the prediction and today's tokens, on one strip. */
export function stripSvg(
  hour5: Limit | undefined,
  week: Limit | undefined,
  prediction: Prediction,
  today: number | null,
  now: number,
  age: string | null = null,
): string {
  const W = 560
  const H = 44
  const meter = (
    x: number,
    name: string,
    limit: Limit | undefined,
    width: number,
    tickAt?: number,
  ) => {
    const pct = limit?.percentUsed ?? 0
    const color = limit ? pctColor(pct) : MUTED
    const reset = limit?.resetsAt ? clockOrDay(Date.parse(limit.resetsAt), now) : ''

    return (
      t(x, 13, name, { size: 11, color: MUTED }) +
      t(x + width, 13, limit ? `${pct}%` : '--', { size: 12, color, anchor: 'end', weight: 700 }) +
      rect(x, 18, width, 6, LINE, 3) +
      rect(x, 18, (Math.min(100, pct) / 100) * width, 6, color, 3) +
      (tickAt === undefined ? '' : rect(x + (tickAt / 100) * width - 1, 16, 2, 10, TEXT, 1)) +
      t(x, 36, reset ? reset : '', { size: 10, color: MUTED })
    )
  }
  const resetAt = week?.resetsAt ? Date.parse(week.resetsAt) : undefined
  const pace = resetAt ? Math.min(100, ((now - (resetAt - WEEK)) / WEEK) * 100) : undefined

  return svg(
    W,
    H,
    rect(0.5, 0.5, W - 1, H - 1, BG, 10).replace('/>', ` stroke="${LINE}"/>`) +
      `<g transform="translate(10 3)">${meter(0, '5h', hour5, 88)}${meter(100, 'Week', week, 104, pace)}</g>` +
      `<circle cx="228" cy="22" r="5" fill="${prediction.color}"/>` +
      t(238, age ? 20 : 26, clip(prediction.text, 41), { size: 12, color: prediction.color, weight: 600 }) +
      (age ? t(238, 35, `${age}, updates on the next reply`, { size: 10, color: MUTED }) : '') +
      (today === null
        ? ''
        : t(W - 10, 20, amount(today), { size: 14, anchor: 'end', weight: 700 }) +
          t(W - 10, 35, 'tokens today', { size: 10, color: MUTED, anchor: 'end' })),
  )
}

function windowLength(kind: string): number {
  return kind.startsWith('five_hour') ? 5 * HOUR : WEEK
}

// Where one window's even pace ends: its own run-out time, or the reset.
export function paceOf(limit: Limit, now: number): { text: string; color: string; even: number } | null {
  if (!limit.resetsAt) return null
  const resetAt = Date.parse(limit.resetsAt)
  const length = windowLength(limit.kind)
  const elapsed = now - (resetAt - length)
  if (elapsed <= 0) return null
  const even = Math.min(100, Math.round((elapsed / length) * 100))
  if (limit.percentUsed <= 0) return { text: 'Lasts till reset', color: GREEN, even }
  const runsOutAt = now + (100 - limit.percentUsed) / (limit.percentUsed / elapsed)
  if (runsOutAt >= resetAt) return { text: 'Lasts till reset', color: GREEN, even }

  return {
    text: `Out ${clockOrDay(runsOutAt, now)}`,
    color: resetAt - runsOutAt <= length / 7 ? ORANGE : RED,
    even,
  }
}

/** A ring per limit window, with used, left, when it resets and its own pace. */
export function gaugesCard(
  list: readonly Limit[],
  now: number,
  readAt: number = now,
  age: string | null = null,
): string {
  const W = 720
  if (list.length === 0) {
    return card(
      W,
      70,
      'Limits',
      t(16, 50, 'No reading yet, it comes with the next reply.', { color: MUTED }),
    )
  }
  const columns = Math.min(3, list.length)
  const rowH = 134
  const H = 42 + Math.ceil(list.length / 3) * rowH
  const each = (W - 16) / columns
  const inner = list
    .map((l, i) => {
      const x = 8 + each * (i % 3)
      const cy = 100 + Math.floor(i / 3) * rowH
      const cx = x + 60
      const at = l.resetsAt ? Date.parse(l.resetsAt) : undefined
      const color = pctColor(l.percentUsed)
      const pace = paceOf(l, readAt)

      return (
        ring(cx, cy, 44, l.percentUsed, color) +
        t(cx, cy + 7, `${Math.round(l.percentUsed)}%`, { size: 20, anchor: 'middle', weight: 700 }) +
        t(x + 118, cy - 40, clip(limitLabel(l.kind), 18), { size: 13, weight: 600 }) +
        t(x + 118, cy - 21, `${Math.max(0, round(100 - l.percentUsed))}% left`, { size: 12, color }) +
        (at
          ? t(x + 118, cy - 2, `resets ${clockOrDay(at, now)}`, { size: 11, color: MUTED }) +
            t(x + 118, cy + 14, `in ${countdown(at - now)}`, { size: 11, color: MUTED })
          : '') +
        (pace
          ? t(x + 118, cy + 31, `even pace ${pace.even}%`, { size: 11, color: MUTED }) +
            t(x + 118, cy + 47, pace.text, { size: 11, color: pace.color, weight: 600 })
          : '')
      )
    })
    .join('')

  return card(W, H, 'Limits', inner, age ?? '')
}

/** The week so far, the even pace, and where this pace lands. */
export function forecastCard(
  week: Limit | undefined,
  history: readonly Sample[],
  prediction: Prediction,
  now: number,
): string {
  const W = 720
  const H = 268
  if (!week?.resetsAt) {
    return card(W, 70, 'Weekly forecast', t(16, 50, prediction.text, { color: MUTED }))
  }
  const L = 44
  const R = W - 18
  const T = 64
  const B = H - 34
  const resetAt = Date.parse(week.resetsAt)
  const start = resetAt - WEEK
  const x = (ms: number) => L + ((Math.min(resetAt, Math.max(start, ms)) - start) / WEEK) * (R - L)
  const y = (pct: number) => B - (Math.min(100, Math.max(0, pct)) / 100) * (B - T)

  let grid = ''
  for (const pct of [0, 25, 50, 75, 100]) {
    grid += line(L, y(pct), R, y(pct), pct === 100 ? RED : LINE, pct === 100 ? '3 3' : '')
    grid += t(L - 8, y(pct) + 4, `${pct}%`, { size: 10, color: MUTED, anchor: 'end' })
  }
  for (let i = 0; i <= 7; i += 1) {
    const at = start + i * DAY
    grid += line(x(at), T, x(at), B, LINE)
    if (i < 7) {
      const name = (WEEKDAYS[local(at + DAY / 2).getUTCDay()] as string).slice(0, 3)
      grid += t(x(at + DAY / 2), B + 18, name, { size: 11, color: MUTED, anchor: 'middle' })
    }
  }

  const inWindow = history.filter(
    s => Math.abs(Date.parse(s.resetsAt) - resetAt) < HOUR && s.t <= now,
  )
  // Before the first reading the line can only assume the week started at zero.
  const path = [
    [start, 0] as const,
    ...inWindow.map(s => [s.t, s.pct] as const),
    [now, week.percentUsed] as const,
  ]
    .map(([a, b]) => `${round(x(a))},${round(y(b))}`)
    .join(' ')
  const area = `${path} ${round(x(now))},${round(y(0))}`

  const endAt = prediction.runsOutAt ?? resetAt
  const endPct =
    prediction.runsOutAt !== undefined
      ? 100
      : Math.min(100, week.percentUsed + (prediction.rate ?? 0) * (resetAt - now))

  const marks =
    `<polygon points="${area}" fill="${prediction.color}" opacity="0.14"/>` +
    line(x(start), y(0), x(resetAt), y(100), MUTED, '2 4') +
    `<polyline points="${path}" fill="none" stroke="${prediction.color}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<line x1="${round(x(now))}" y1="${round(y(week.percentUsed))}" x2="${round(x(endAt))}" y2="${round(y(endPct))}" stroke="${prediction.color}" stroke-width="2" stroke-dasharray="6 5"/>` +
    `<circle cx="${round(x(now))}" cy="${round(y(week.percentUsed))}" r="5" fill="${TEXT}" stroke="${prediction.color}" stroke-width="2"/>` +
    (prediction.runsOutAt === undefined
      ? t(R - 4, y(endPct) + (endPct > 90 ? 16 : -8), `${Math.round(endPct)}% at reset`, {
          size: 11,
          color: prediction.color,
          anchor: 'end',
          weight: 600,
        })
      : `<circle cx="${round(x(endAt))}" cy="${round(y(100))}" r="6" fill="${prediction.color}"/>` +
        t(Math.min(R - 90, x(endAt) + 9), y(100) + 16, clockOrDay(endAt, now), {
          size: 11,
          color: prediction.color,
          weight: 600,
        }))

  const evenPace = Math.round(((now - start) / WEEK) * 100)
  const header =
    t(16, 47, prediction.text, { size: 15, color: prediction.color, weight: 700 }) +
    t(W - 16, 47, `${week.percentUsed}% used now · even pace ${evenPace}%`, {
      size: 11,
      color: MUTED,
      anchor: 'end',
    })

  return card(W, H, 'Weekly forecast', grid + marks + header, `resets ${when(resetAt, now)}`)
}

const PERIODS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
] as const

/** Today, week, month, year, all time: this session against the others. */
export function periodsCard(s: Summary): string {
  const W = 720
  const H = 150
  const each = (W - 24) / PERIODS.length
  const inner = PERIODS.map(([key, name], i) => {
    const p = s.periods[key]
    const total = tokensOf(p.total)
    const mine = tokensOf(p.session)
    const x = 12 + each * i
    const w = each - 12

    return (
      rect(x + 6, 40, w, 98, TILE, 8) +
      t(x + 16, 58, name, { size: 11, color: MUTED }) +
      t(x + 16, 82, amount(total), { size: 19, weight: 700 }) +
      rect(x + 16, 91, w - 20, 5, LINE, 2) +
      rect(x + 16, 91, Math.max(mine > 0 ? 2 : 0, (mine / (total || 1)) * (w - 20)), 5, CLAUDE, 2) +
      t(x + 16, 110, `This ${amount(mine)}`, { size: 10, color: CLAUDE }) +
      t(x + 16, 125, `Other ${amount(total - mine)}`, { size: 10, color: MUTED })
    )
  }).join('')

  return card(W, H, 'Tokens', inner, 'cache reads included')
}

function shortDay(key: string): string {
  const parts = key.split('-')

  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]}`
}

/** The live session and the running rates. */
export function sessionCard(stats: SessionStats | null, s: Summary, now: number): string {
  const W = 720
  const H = 118
  const today = tokensOf(s.periods.today.total)
  const hoursGone = local(now).getUTCHours() + local(now).getUTCMinutes() / 60 || 1
  const nowHour = local(now).getUTCHours()
  let last5 = 0
  for (let i = 0; i < 5; i += 1) {
    const h = nowHour - i
    last5 += (h >= 0 ? s.hoursToday[h] : s.hoursYesterday[h + 24]) ?? 0
  }
  const all = s.periods.all
  const busiest = [...s.days].sort((a, b) => tokensOf(b) - tokensOf(a))[0]
  const tiles: [string, string, string][] = [
    [
      'This session',
      amount(tokensOf(s.periods.today.session)),
      stats?.usd === undefined ? 'today' : `$${stats.usd.toFixed(2)} API value`,
    ],
    ['Last 5 hours', amount(last5), `${amount(last5 / 5)} an hour`],
    ['Pace today', amount(today / hoursGone), 'an hour'],
    ['Daily average', amount(tokensOf(all.total) / (all.activeDays || 1)), `${all.activeDays} active days`],
    ['Busiest day', busiest ? amount(tokensOf(busiest)) : '--', busiest ? shortDay(busiest.key) : ''],
    ['Sessions', String(s.periods.today.sessions), `today, ${all.sessions.toLocaleString('en-US')} ever`],
  ]
  const contextPct = stats?.contextPercent
  const left = 92
  const each = (W - left - 10) / tiles.length
  const inner =
    ring(50, 68, 26, contextPct ?? 0, contextPct === undefined ? LINE : pctColor(contextPct), 7) +
    t(50, 73, contextPct === undefined ? '--' : `${contextPct}%`, {
      size: 13,
      anchor: 'middle',
      weight: 700,
    }) +
    t(50, 110, 'context', { size: 10, color: MUTED, anchor: 'middle' }) +
    tiles
      .map(([name, big, small], i) => {
        const x = left + each * i

        return (
          t(x, 56, name, { size: 11, color: MUTED }) +
          t(x, 78, big, { size: 16, weight: 700 }) +
          t(x, 95, clip(small, 18), { size: 10, color: MUTED })
        )
      })
      .join('')

  return card(W, H, 'Right now', inner)
}

/** Today by the hour, yesterday behind it. */
export function hoursCard(s: Summary, now: number): string {
  const W = 720
  const H = 200
  const L = 16
  const R = W - 16
  const T = 48
  const B = H - 30
  const peak = Math.max(1, ...s.hoursToday, ...s.hoursYesterday)
  const each = (R - L) / 24
  const hourNow = local(now).getUTCHours()
  const scale = (n: number) => (n / peak) * (B - T)
  let inner = ''
  for (let h = 0; h < 24; h += 1) {
    const x = L + each * h
    const was = s.hoursYesterday[h] ?? 0
    const is = s.hoursToday[h] ?? 0
    inner += rect(x + 1, B - scale(was), each - 2, scale(was), LINE, 2)
    if (is > 0) {
      const height = Math.max(2, scale(is))
      inner += rect(x + 4, B - height, each - 8, height, h === hourNow ? YELLOW : CLAUDE, 2)
      inner += t(x + each / 2, B - height - 4, short(is), {
        size: 9,
        color: MUTED,
        anchor: 'middle',
      })
    }
    if (h % 3 === 0) {
      inner += t(x + each / 2, B + 16, `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`, {
        size: 10,
        color: MUTED,
        anchor: 'middle',
      })
    }
  }

  return card(W, H, 'Today by the hour', inner + line(L, B, R, B, LINE), 'tokens, gray is yesterday')
}

/** The last 31 active days, with the average marked. */
export function daysCard(s: Summary, now: number): string {
  const W = 720
  const H = 210
  const L = 16
  const R = W - 16
  const T = 52
  const B = H - 32
  const days = s.days
  const peak = Math.max(1, ...days.map(tokensOf))
  const each = (R - L) / Math.max(days.length, 1)
  const today = new Date(now + shift).toISOString().slice(0, 10)
  const average = days.reduce((sum, d) => sum + tokensOf(d), 0) / (days.length || 1)
  let inner = ''
  days.forEach((d, i) => {
    const x = L + each * i
    const total = tokensOf(d)
    const height = Math.max(2, (total / peak) * (B - T))
    inner += rect(x + 2, B - height, Math.max(2, each - 4), height, d.key === today ? YELLOW : BLUE, 3)
    if (each >= 22 || total === peak) {
      inner += t(x + each / 2, B - height - 4, short(total), {
        size: 9,
        color: MUTED,
        anchor: 'middle',
      })
    }
    if (i % Math.ceil(days.length / 8) === 0) {
      inner += t(x + each / 2, B + 16, shortDay(d.key), { size: 10, color: MUTED, anchor: 'middle' })
    }
  })
  const ay = B - (average / peak) * (B - T)
  inner += line(L, ay, R, ay, MUTED, '4 4')

  return card(
    W,
    H,
    'Day by day',
    inner + line(L, B, R, B, LINE),
    `dashed line is the ${amount(average)} average`,
  )
}

/** Input, output and cache, for each period. */
export function breakdownCard(s: Summary): string {
  const W = 720
  const H = 196
  const parts = [
    ['Cache read', 'cr', TEAL],
    ['Cache new', 'cw', PURPLE],
    ['Input', 'in', BLUE],
    ['Output', 'out', CLAUDE],
  ] as const
  const L = 92
  const BAR = 280
  const COL = 74
  const right = (i: number) => L + BAR + 12 + (i + 1) * COL - 14
  let inner = ''
  parts.forEach(([name, , color], i) => {
    inner += t(right(i), 54, name, { size: 10, color, anchor: 'end' })
  })
  PERIODS.forEach(([key, name], r) => {
    const total = s.periods[key].total
    const y = 66 + r * 24
    const sum = tokensOf(total) || 1
    inner += t(16, y + 12, name, { size: 12, color: MUTED })
    let x = L
    for (const [, field, color] of parts) {
      const w = (total[field] / sum) * BAR
      inner += rect(x, y + 2, w, 13, color)
      x += w
    }
    parts.forEach(([, field], i) => {
      inner += t(right(i), y + 12, amount(total[field]), { size: 11, anchor: 'end' })
    })
  })

  return card(W, H, 'What the tokens are', inner)
}

/** Share by model. */
export function modelsCard(s: Summary): string {
  const parts = Object.entries(s.periods.all.models)
    .map(([name, u]) => ({
      name: name.replace('claude-', '').replace(/-\d{8}$/, ''),
      value: tokensOf(u),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 7)
    .map((p, i) => ({ ...p, color: SERIES[i] as string }))

  return card(354, 200, 'By model', donut(68, 118, 42, parts) + legend(128, 62, parts, 210), 'all time')
}

/** Replies, sessions and how the cache is doing. */
export function cacheCard(s: Summary): string {
  const a = s.periods.all.total
  const d = s.periods.today.total
  const hit = (u: Tokens) => {
    const read = u.cr + u.cw + u.in

    return read === 0 ? 0 : Math.round((u.cr / read) * 100)
  }
  const inner =
    ring(68, 118, 44, hit(a), TEAL) +
    t(68, 125, `${hit(a)}%`, { size: 20, anchor: 'middle', weight: 700 }) +
    t(130, 66, 'Served from cache', { size: 12, weight: 600 }) +
    t(130, 84, `${hit(d)}% today`, { size: 11, color: TEAL }) +
    t(130, 112, `${d.n.toLocaleString('en-US')} replies today`, { size: 11, color: MUTED }) +
    t(130, 130, `${a.n.toLocaleString('en-US')} replies all time`, { size: 11, color: MUTED }) +
    t(130, 148, `${amount(a.out)} written by Claude`, { size: 11, color: MUTED }) +
    t(130, 166, `Counted since ${s.firstDay ? shortDay(s.firstDay) : 'today'}`, {
      size: 11,
      color: MUTED,
    })

  return card(354, 200, 'Cache and replies', inner, 'all time')
}

function barsList(
  W: number,
  title: string,
  rows: readonly { name: string; value: number; color?: string }[],
  note: string,
  minRows = 0,
): string {
  const peak = Math.max(1, ...rows.map(r => r.value))
  const L = 16
  const labelW = 122
  const barW = W - L - labelW - 76
  const inner = rows
    .map((r, i) => {
      const y = 44 + i * 21

      return (
        t(L, y + 11, clipMiddle(r.name, 20), { size: 11, color: r.color ?? TEXT }) +
        rect(L + labelW, y + 2, barW, 11, TILE, 3) +
        rect(L + labelW, y + 2, Math.max(2, (r.value / peak) * barW), 11, r.color ?? CLAUDE, 3) +
        t(W - 16, y + 12, amount(r.value), { size: 11, anchor: 'end' })
      )
    })
    .join('')

  return card(W, 54 + Math.max(rows.length, minRows) * 21, title, inner, note)
}

export function projectsCard(s: Summary): string {
  return barsList(
    354,
    'Top projects',
    s.periods.all.projects.slice(0, 8).map(p => ({ name: p.name, value: p.tokens })),
    'all time',
    8,
  )
}

export function sessionsCard(s: Summary): string {
  return barsList(
    354,
    'Top sessions',
    s.topSessions.map(x => ({
      name: `${x.isThis ? 'this one' : x.id.slice(0, 4)} ${x.project.replace(' (background)', '')}`,
      value: x.tokens,
      ...(x.isThis ? { color: YELLOW } : {}),
    })),
    'today',
    8,
  )
}

function monthName(key: string): string {
  const parts = key.split('-')

  return `${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`
}

/** Each month and each year so far. */
export function monthsCard(s: Summary): string {
  const rows = [
    ...[...s.months].reverse().map(m => ({ name: monthName(m.key), value: tokensOf(m) })),
    ...[...s.years].reverse().map(y => ({ name: `Year ${y.key}`, value: tokensOf(y), color: PURPLE })),
  ].slice(0, 12)

  return barsList(720, 'Months and years', rows, 'tokens')
}

/** When the tokens get spent: weekday against hour. */
export function heatCard(s: Summary): string {
  const W = 720
  const H = 214
  const L = 46
  const T = 42
  const cell = (W - L - 16) / 24
  const rowH = 20
  const peak = Math.max(1, ...s.heat.flat())
  let inner = ''
  // Monday first, reading as the week does.
  ;[1, 2, 3, 4, 5, 6, 0].forEach((wd, r) => {
    const y = T + r * rowH
    inner += t(16, y + 14, (WEEKDAYS[wd] as string).slice(0, 3), { size: 11, color: MUTED })
    for (let h = 0; h < 24; h += 1) {
      const v = s.heat[wd]?.[h] ?? 0
      const strength = v === 0 ? 1 : 0.2 + 0.8 * Math.sqrt(v / peak)
      inner += `<rect x="${round(L + h * cell + 1)}" y="${y + 1}" width="${round(cell - 2)}" height="${rowH - 2}" rx="3" fill="${v === 0 ? TILE : CLAUDE}" opacity="${Math.round(strength * 100) / 100}"/>`
    }
  })
  for (let h = 0; h < 24; h += 3) {
    inner += t(L + h * cell + cell / 2, T + 7 * rowH + 16, `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`, {
      size: 10,
      color: MUTED,
      anchor: 'middle',
    })
  }

  return card(W, H, 'When you use it', inner, 'darker is more')
}

function change(now: number, before: number): { text: string; color: string } {
  if (before <= 0) return now > 0 ? { text: `+${amount(now)}`, color: ORANGE } : { text: 'same', color: MUTED }
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return { text: 'same', color: MUTED }

  return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, color: pct > 0 ? ORANGE : GREEN }
}

/** Each period against the same point in the one before it. */
export function compareCard(s: Summary): string {
  const W = 720
  const H = 118
  const rows = [
    ['Today', 'yesterday by now', tokensOf(s.periods.today.total), s.compare.yesterdayByNow],
    ['This week', 'last week by now', tokensOf(s.periods.week.total), s.compare.lastWeekByNow],
    ['This month', 'last month by now', tokensOf(s.periods.month.total), s.compare.lastMonthByNow],
  ] as const
  const each = (W - 24) / rows.length
  const inner = rows
    .map(([name, against, is, was], i) => {
      const x = 12 + each * i
      const w = each - 12
      const d = change(is, was)
      const peak = Math.max(is, was, 1)

      return (
        rect(x + 6, 38, w, 68, TILE, 8) +
        t(x + 16, 56, name, { size: 11, color: MUTED }) +
        t(x + w - 4, 56, d.text, { size: 12, color: d.color, anchor: 'end', weight: 700 }) +
        rect(x + 16, 63, w - 20, 5, LINE, 2) +
        rect(x + 16, 63, (is / peak) * (w - 20), 5, CLAUDE, 2) +
        rect(x + 16, 71, w - 20, 5, LINE, 2) +
        rect(x + 16, 71, (was / peak) * (w - 20), 5, MUTED, 2) +
        t(x + 16, 94, `${amount(is)} vs ${amount(was)} ${against}`, { size: 10, color: MUTED })
      )
    })
    .join('')

  return card(W, H, 'Compared with before', inner)
}

/** The figures behind the bars: per reply, per session, peaks and streak. */
export function averagesCard(s: Summary): string {
  const W = 720
  const H = 108
  const all = s.periods.all
  const total = tokensOf(all.total)
  const flat = s.heat.flat()
  const peakAt = flat.indexOf(Math.max(...flat))
  const peakHour = peakAt % 24
  const byDay = s.heat.map(row => row.reduce((a, b) => a + b, 0))
  const peakDay = byDay.indexOf(Math.max(...byDay))
  const hours = Array.from({ length: 24 }, (_, h) => s.heat.reduce((sum, row) => sum + (row[h] ?? 0), 0))
  const topHour = hours.indexOf(Math.max(...hours))
  let streak = 0
  const dates = new Set(s.days.map(d => d.key))
  for (let at = Date.parse(`${s.days[s.days.length - 1]?.key ?? '2000-01-01'}T00:00:00Z`); ; at -= DAY) {
    if (!dates.has(new Date(at).toISOString().slice(0, 10))) break
    streak += 1
  }
  const tiles: [string, string, string][] = [
    ['Per reply', amount(total / (all.total.n || 1)), `${amount(all.total.out / (all.total.n || 1))} written`],
    ['Per session', amount(total / (all.sessions || 1)), `${all.sessions.toLocaleString('en-US')} sessions`],
    ['Busiest hour', `${topHour % 12 || 12} ${topHour < 12 ? 'AM' : 'PM'}`, amount(Math.max(...hours))],
    ['Busiest weekday', (WEEKDAYS[peakDay] as string).slice(0, 3), amount(Math.max(...byDay))],
    ['Hottest slot', `${(WEEKDAYS[Math.floor(peakAt / 24)] as string).slice(0, 3)} ${peakHour % 12 || 12}${peakHour < 12 ? 'a' : 'p'}`, amount(Math.max(...flat))],
    ['Active streak', `${streak} ${streak === 1 ? 'day' : 'days'}`, `${s.periods.month.activeDays} this month`],
  ]
  const each = (W - 24) / tiles.length
  const inner = tiles
    .map(([name, big, small], i) => {
      const x = 16 + each * i

      return (
        t(x, 52, name, { size: 11, color: MUTED }) +
        t(x, 74, big, { size: 16, weight: 700 }) +
        t(x, 91, clip(small, 18), { size: 10, color: MUTED })
      )
    })
    .join('')

  return card(W, H, 'Averages and records', inner)
}

/** Every model against every period. */
export function modelTableCard(s: Summary): string {
  const W = 720
  const names = Object.entries(s.periods.all.models)
    .sort(([, a], [, b]) => tokensOf(b) - tokensOf(a))
    .slice(0, 7)
    .map(([name]) => name)
  const H = 66 + names.length * 22
  const L = 150
  const col = (W - L - 16) / PERIODS.length
  const right = (i: number) => L + col * (i + 1)
  let inner = ''
  PERIODS.forEach(([, name], i) => {
    inner += t(right(i), 50, name, { size: 10, color: MUTED, anchor: 'end' })
  })
  names.forEach((model, r) => {
    const y = 72 + r * 22
    inner += rect(16, y - 9, 9, 9, SERIES[r] as string, 2)
    inner += t(31, y, clip(model.replace('claude-', '').replace(/-\d{8}$/, ''), 17), { size: 12 })
    PERIODS.forEach(([key], i) => {
      const u = s.periods[key].models[model]
      inner += t(right(i), y, u ? amount(tokensOf(u)) : '–', {
        size: 12,
        color: u ? TEXT : MUTED,
        anchor: 'end',
      })
    })
  })

  return card(W, H, 'Models by period', inner)
}

export function projectsTodayCard(s: Summary): string {
  return barsList(
    354,
    'Projects today',
    s.periods.today.projects.slice(0, 6).map(p => ({ name: p.name, value: p.tokens })),
    'today',
    6,
  )
}

export function projectsWeekCard(s: Summary): string {
  return barsList(
    354,
    'Projects this week',
    s.periods.week.projects.slice(0, 6).map(p => ({ name: p.name, value: p.tokens })),
    'this week',
    6,
  )
}
