import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface as Api, Register } from 'claude-code'

import type { Limit, Sample, SessionStats, Summary, Tokens, View } from '../types'
import {
  averagesCard,
  breakdownCard,
  cacheCard,
  compareCard,
  countdown,
  dayName,
  daysCard,
  forecastCard,
  gaugesCard,
  GRAY,
  GREEN,
  heatCard,
  hoursCard,
  limitLabel,
  localHour,
  amount,
  modelsCard,
  modelTableCard,
  monthsCard,
  ORANGE,
  pctColor,
  periodsCard,
  projectsCard,
  projectsTodayCard,
  projectsWeekCard,
  RED,
  sessionCard,
  sessionsCard,
  setUtcOffset,
  stripSvg,
  tokensOf,
  when,
} from './charts'
import type { Prediction } from './charts'

const PANE = 'usage-bar'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const view = atom({ plugin: 'usage-bar', key: 'view' } as const, 'bar')
const limits = atom({ plugin: 'usage-bar', key: 'limits' } as const, [])
const limitsAt = atom({ plugin: 'usage-bar', key: 'limitsAt' } as const, 0)
const samples = atom({ plugin: 'usage-bar', key: 'samples' } as const, [])
const summary = atom({ plugin: 'usage-bar', key: 'summary' } as const, null)
const scanNote = atom({ plugin: 'usage-bar', key: 'scanNote' } as const, null)
const tick = atom({ plugin: 'usage-bar', key: 'tick' } as const, 0)
// A gauge, in the text form so it takes the colour it is given. A Button holds
// only text: a drawn Svg cannot be pressed.
const GAUGE = '\u{1F55B}︎'

const session = atom({ plugin: 'usage-bar', key: 'session' } as const, null)

function bar(pct: number, cells = 10): string {
  const full = Math.min(cells, Math.round((Math.min(100, pct) / 100) * cells))

  return '█'.repeat(full) + '░'.repeat(cells - full)
}

function dayPart(ms: number): string {
  const h = localHour(ms)
  if (h < 5) return 'early morning'
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 21) return 'evening'

  return 'night'
}

// A window past its reset has started over, whatever was last reported.
function current(limit: Limit | undefined, now: number): Limit | undefined {
  if (limit?.resetsAt && Date.parse(limit.resetsAt) <= now) {
    return { kind: limit.kind, percentUsed: 0 }
  }

  return limit
}

const resetMs = (limit: Limit) => (limit.resetsAt ? Date.parse(limit.resetsAt) : 0)

// Which of two readings of one window to keep. A later window (its reset more
// than an hour later) is newer than any reading of an earlier one. Inside one
// window the reading Claude Code reported later wins, whatever its percentage;
// only two readings stamped with the same time fall back to the higher figure,
// since usage inside a window only rises.
export function newerReading(held: Limit, next: Limit): Limit {
  const heldReset = resetMs(held)
  const nextReset = resetMs(next)
  if (Math.abs(heldReset - nextReset) >= HOUR) return nextReset > heldReset ? next : held
  const heldAt = held.readAt ?? 0
  const nextAt = next.readAt ?? 0
  if (heldAt !== nextAt) return nextAt > heldAt ? next : held

  return next.percentUsed > held.percentUsed ? next : held
}

// Several sessions report the same account windows, some of them idle and out
// of date: each window keeps its newest reading, on its own.
export function mergeLimits(a: readonly Limit[], b: readonly Limit[]): Limit[] {
  const out = new Map<string, Limit>()
  for (const limit of [...a, ...b]) {
    const held = out.get(limit.kind)
    out.set(limit.kind, held ? newerReading(held, limit) : limit)
  }

  return [...out.values()]
}

// The time of the newest reading among the windows; 0 when none has one.
export function latestReadAt(list: readonly Limit[]): number {
  return list.reduce((latest, limit) => Math.max(latest, limit.readAt ?? 0), 0)
}

// How old the limit reading is, once it is old enough to matter. Claude Code
// reports limits only with a reply, so usage elsewhere shows up late.
export function ageOf(readAt: number, now: number): string | null {
  if (readAt <= 0 || now - readAt < 3 * MIN) return null

  return `Reading ${countdown(now - readAt)} old`
}

// Runs the pace over the whole window so far forward to 100%, as the usage screen
// in Settings does. The pace is taken where the reading was: dividing an old
// percentage by the time since would understate it.
export function predict(week: Limit | undefined, now: number, readAt: number = now): Prediction {
  if (!week?.resetsAt) {
    return { color: GRAY, text: 'Prediction after the next reply' }
  }

  const resetAt = Date.parse(week.resetsAt)
  const resetText = when(resetAt, now)
  const pct = week.percentUsed
  if (pct >= 100) {
    return { color: RED, text: `Run out, back ${resetText}`, runsOutAt: now }
  }

  const at = readAt > 0 ? Math.min(readAt, now) : now
  const elapsed = at - (resetAt - WEEK)
  if (elapsed <= 0 || pct <= 0) {
    return { color: GREEN, text: `Lasts till reset, ${resetText}` }
  }

  const rate = pct / elapsed
  const runsOutAt = Math.max(now, at + (100 - pct) / rate)

  if (runsOutAt >= resetAt) {
    return { color: GREEN, text: `Lasts till reset, ${resetText}`, rate }
  }

  return {
    // At or past the reset is green; under a day short is orange; more is red.
    color: resetAt - runsOutAt <= DAY ? ORANGE : RED,
    text: `Expected run out ${dayName(runsOutAt, now)} ${dayPart(runsOutAt)}`,
    runsOutAt,
    rate,
  }
}

function nextSamples(history: readonly Sample[], list: readonly Limit[], now: number): Sample[] {
  const week = list.find(l => l.kind === 'seven_day')
  const kept = history.filter(s => s.t >= now - 8 * DAY)
  if (!week?.resetsAt) return kept
  const last = kept[kept.length - 1]
  const isNews = !last || last.pct !== week.percentUsed || now - last.t >= 10 * MIN
  if (!isNews) return kept

  return [...kept, { t: now, pct: week.percentUsed, resetsAt: week.resetsAt }].slice(-800)
}

const isArray = (v: unknown): v is unknown[] => Array.isArray(v)
const isView = (v: unknown): v is View =>
  v === 'off' || v === 'dot' || v === 'bar' || v === 'full'

let isScanning = false
let lastScanAt = 0

// What this session itself was told, per window, and when. Kept so a session
// re-asserts its own newest reading with its true time: a store or snapshot that
// another session overwrote with an older one heals at the next refresh.
const ownReadings = new Map<string, Limit>()

const plain = (l: { kind: string; percentUsed: number; resetsAt?: string }) => ({
  kind: l.kind,
  percentUsed: l.percentUsed,
  ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
})

// Readings saved before 1.4.0 carry no time of their own: they take the one
// time those versions kept for all of them.
export function withTimes(stored: readonly Limit[], legacyAt: number): Limit[] {
  return stored.map(l => (l.readAt === undefined ? { ...l, readAt: legacyAt, source: l.source ?? 'reply' } : l))
}

// Folds what this session sees into the shared reading. `reported` is either a
// reading that just arrived (`isFresh`: a turn ended or a window moved, so it is
// stamped now) or the session's standing figures from a periodic refresh. The
// latter are only news when they differ from what this session last saw, which
// means a reply arrived in between; otherwise they carry no time and can never
// make an old reading look new.
export function foldReadings(
  stored: readonly Limit[],
  own: Map<string, Limit>,
  reported: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  now: number,
  isFresh: boolean,
): Limit[] {
  const untimed: Limit[] = []
  for (const r of reported) {
    const seen = own.get(r.kind)
    const isChanged = !seen || seen.percentUsed !== r.percentUsed || seen.resetsAt !== r.resetsAt
    if (isFresh) {
      own.set(r.kind, { ...plain(r), readAt: now, source: 'reply' })
    } else if (seen && isChanged) {
      own.set(r.kind, { ...plain(r), readAt: now, source: 'poll' })
    } else if (!seen) {
      untimed.push({ ...plain(r), readAt: 0, source: 'session' })
    }
  }

  return mergeLimits(mergeLimits(stored, untimed), [...own.values()])
}

// `isFresh`: Claude Code just reported limits (a turn ended, or a window moved).
async function refresh($: Api, seen?: readonly Limit[], isFresh = false): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('limits')
  const usage = await $.session.usage()
  const reported = seen ?? usage.rateLimits
  const stats: SessionStats = {
    ...(usage.context.percent === undefined ? {} : { contextPercent: usage.context.percent }),
    ...(usage.cost === undefined ? {} : { usd: usage.cost.usd }),
  }
  await update($, session, () => stats)
  const heldAt = await $.store.get('limitsAt')
  const before = withTimes(
    isArray(stored) ? (stored as Limit[]) : [],
    typeof heldAt === 'number' ? heldAt : 0,
  )
  const merged = foldReadings(before, ownReadings, reported, now, isFresh)
  const readAt = latestReadAt(merged)
  const held = await $.store.get('samples')
  const history = nextSamples(isArray(held) ? (held as Sample[]) : [], merged, now)
  await $.store.set('limits', merged)
  await $.store.set('limitsAt', readAt)
  await update($, limitsAt, () => readAt)
  await $.store.set('samples', history)
  await update($, limits, () => merged)
  await update($, samples, () => history)
  await update($, tick, n => n + 1)
  void writeSnapshot($, merged, now)
}

// The readings last saved for the `usage-bar` CLI, and when the refresh time
// was last saved, so status.json is rewritten when a reading changes and
// otherwise only every few minutes, to keep `refreshed_at` current.
let lastSnapshot = ''
let lastSnapshotRefresh = 0
const SNAPSHOT_HEARTBEAT = 5 * MIN

// Saves the readings the bar shows to status.json in the cache folder, where the
// read-only `usage-bar` CLI finds them. Node writes the file under a lock, keeps
// the newer reading of each window where another session saved one, and renames
// it into place; this module's own file calls cannot rename. A failure leaves the
// bar as it is.
async function writeSnapshot($: Api, list: readonly Limit[], refreshedAt: number): Promise<void> {
  const readings = JSON.stringify(list)
  if (readings === lastSnapshot && refreshedAt - lastSnapshotRefresh < SNAPSHOT_HEARTBEAT) return
  try {
    const run = await $.process.run(
      ['node', `${$.plugin.root}/scanner/snapshot.mjs`, await cacheDir($)],
      { stdin: JSON.stringify({ refreshedAt, limits: list }), timeoutMs: 30_000 },
    )
    if (run.exitCode === 0) {
      lastSnapshot = readings
      lastSnapshotRefresh = refreshedAt
    }
  } catch {
    // No Node.js, or the folder cannot be written: the CLI keeps its last snapshot.
  }
}

// Where the scanner keeps its totals: USAGE_BAR_CACHE_DIR, else beside the
// person's other Claude Code files.
async function cacheDir($: Api): Promise<string> {
  const chosen = await $.env.get('USAGE_BAR_CACHE_DIR')
  if (chosen) return chosen
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home ? `${home}/.claude/usage-bar` : `${$.plugin.root}/.cache`
}

async function scan($: Api): Promise<void> {
  const now = await $.clock.now()
  if (isScanning || now - lastScanAt < 20_000) return
  isScanning = true
  lastScanAt = now
  try {
    const run = await $.process.run(
      ['node', `${$.plugin.root}/scanner/scan.mjs`, await cacheDir($), await $.session.id()],
      { timeoutMs: 10 * MIN },
    )
    if (run.exitCode !== 0) throw new Error(`exit ${run.exitCode}`)
    const parsed = JSON.parse(run.stdout) as Summary
    setUtcOffset(parsed.utcOffsetMs)
    await $.store.set('utcOffset', parsed.utcOffsetMs)
    await update($, summary, () => parsed)
    await update($, scanNote, () => null)
  } catch {
    await update($, scanNote, () => 'Token totals need Node.js on your PATH')
  } finally {
    isScanning = false
  }
}

// Turned off, the mod does no counting in the background either.
async function scanWhenOn($: Api): Promise<void> {
  if ((await read($, view)) !== 'off') await scan($)
}

async function setView($: Api, to: View): Promise<void> {
  await update($, view, () => to)
  await $.store.set('view', to)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const offset = await $.store.get('utcOffset')
    if (typeof offset === 'number') setUtcOffset(offset)
    const saved = await $.store.get('view')
    if (isView(saved)) await update($, view, () => saved)

    await $.command.register({
      name: 'usage-bar',
      description: 'Turn the usage bar on or off, or open the full details in a pane',
      argumentHint: '[enable|disable|details]',
    })
    await refresh($).catch(() => undefined)
    void scanWhenOn($)
    $.clock.every(MIN, () => {
      void refresh($).catch(() => undefined)
    })
    $.clock.every(90_000, () => {
      void scanWhenOn($)
    })

    // The editor has no band above the prompt, so its details live in a pane.
    const isOff = (await read($, view)) === 'off'
    if (!isOff && (await $.session.surfaces()).includes('vscode')) {
      void $.ui.open({ id: PANE, title: 'Usage' })
    }

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    if (word === 'enable' || word === 'on') {
      await setView($, 'bar')
      void scan($)

      return { text: 'Usage bar on.' }
    }
    if (word === 'disable' || word === 'off') {
      await setView($, 'off')
      await $.ui.close({ id: PANE }).catch(() => undefined)

      return { text: 'Usage bar off. /usage-bar enable brings it back.' }
    }
    if (word !== '' && word !== 'details') {
      return { text: 'Try /usage-bar enable, /usage-bar disable or /usage-bar details.' }
    }

    void scan($)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage details opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e.rateLimits, true).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($, undefined, true).catch(() => undefined)
    void scanWhenOn($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, view)
    if (shown === 'off') return next(e)

    const set = (to: View) => async () => {
      await update($, view, () => to)
      await $.store.set('view', to)
    }

    await read($, tick)
    const now = await $.clock.now()
    const list = await read($, limits)
    const week = current(list.find(l => l.kind === 'seven_day'), now)
    const hour5 = current(list.find(l => l.kind === 'five_hour'), now)
    const readAt = await read($, limitsAt)
    const prediction = predict(week, now, list.find(l => l.kind === 'seven_day')?.readAt || readAt)
    const age = list.length > 0 ? ageOf(readAt, now) : null
    const totals = await read($, summary)

    if (shown === 'dot') {
      return (
        <Box>
          <Button key="usage-open" plain onPress={set('bar')}>
            <Text color={prediction.color} size="heading">
              {GAUGE}
            </Text>
          </Button>
        </Box>
      )
    }

    const stats = await read($, session)
    const note = await read($, scanNote)
    const history = await read($, samples)
    const todayTokens = totals ? tokensOf(totals.periods.today.total) : null
    const table = $.ui.resolve(e)

    const expand = async () => {
      // The side pane and the full view show the same thing: keep one.
      await $.ui.close({ id: PANE }).catch(() => undefined)
      await set('full')()
    }

    const controls = (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
        <Button key="usage-minimise" onPress={set('dot')}>
          <Text color={prediction.color}>{GAUGE}</Text>
        </Button>
        {shown === 'full' ? null : (
          <Button key="usage-details" onPress={expand}>
            ⤢
          </Button>
        )}
      </Box>
    )

    if (e.surface === 'terminal') {
      const limitChip = (name: string, limit: Limit | undefined) => (
        <Text>
          <Text dimColor>{name} </Text>
          {limit ? (
            <Text color={pctColor(limit.percentUsed)}>{limit.percentUsed}%</Text>
          ) : (
            <Text dimColor>--</Text>
          )}
          {limit?.resetsAt ? (
            <Text dimColor> · resets {when(Date.parse(limit.resetsAt), now)}</Text>
          ) : null}
        </Text>
      )

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
            {controls}
            {limitChip('5h', hour5)}
            {limitChip('Week', week)}
            <Text color={prediction.color} weight="semibold">
              {prediction.text}
            </Text>
            {age ? <Text dimColor>{age}</Text> : null}
            {todayTokens === null ? null : (
              <Text>
                <Text weight="semibold">{amount(todayTokens)}</Text>
                <Text dimColor> tokens today</Text>
              </Text>
            )}
          </Box>
          {shown === 'full' ? (
            <Button key="usage-close" onPress={set('dot')}>
              ✕
            </Button>
          ) : null}
          {shown === 'full' ? details(Box, Text, list, totals, note, now) : null}
        </Box>
      )
    }

    const { Svg } = table as ElementTable<'desktop'>

    if (shown === 'full') {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text weight="semibold" size="heading">
              <Text color={prediction.color}>{GAUGE}</Text> Usage
            </Text>
            <Button key="usage-close" role="dismiss" onPress={set('dot')}>
              ✕
            </Button>
          </Box>
          {dashboard(Box, Text, Svg, list, week, history, prediction, stats, totals, note, now, readAt, age)}
        </Box>
      )
    }

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {controls}
        <Box flexGrow={1} flexShrink={1}>
          <Svg
            source={stripSvg(hour5, week, prediction, todayTokens, now, age)}
            alt={`5 hour ${hour5?.percentUsed ?? 'unknown'} percent, week ${week?.percentUsed ?? 'unknown'} percent. ${prediction.text}.`}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table

    await read($, tick)
    const now = await $.clock.now()
    const list = await read($, limits)
    const week = current(list.find(l => l.kind === 'seven_day'), now)
    const history = await read($, samples)
    const readAt = await read($, limitsAt)
    const prediction = predict(week, now, list.find(l => l.kind === 'seven_day')?.readAt || readAt)
    const age = list.length > 0 ? ageOf(readAt, now) : null
    const totals = await read($, summary)
    const note = await read($, scanNote)

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={prediction.color} weight="semibold">
            {prediction.text}
          </Text>
          {age ? <Text dimColor>{age}</Text> : null}
          {details(Box, Text, list, totals, note, now)}
        </Box>
      )
    }

    const { Svg } = table as ElementTable<'desktop'>
    const stats = await read($, session)

    return dashboard(Box, Text, Svg, list, week, history, prediction, stats, totals, note, now, readAt, age)
  })
}

// The whole picture, chart by chart. A chart that has no room scales down.
function dashboard(
  Box: ElementTable<'desktop'>['Box'],
  Text: ElementTable<'desktop'>['Text'],
  Svg: ElementTable<'desktop'>['Svg'],
  list: readonly Limit[],
  week: Limit | undefined,
  history: readonly Sample[],
  prediction: Prediction,
  stats: SessionStats | null,
  totals: Summary | null,
  note: string | null,
  now: number,
  readAt: number,
  age: string | null,
) {
  const windows = list.map(l => ({ ...l, ...current(l, now) }))
  const at = readAt > 0 ? Math.min(readAt, now) : now
  const chart = (source: string, alt: string) => <Svg source={source} alt={alt} />

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
      {chart(gaugesCard(windows, now, at, age), 'Limit gauges')}
      {chart(forecastCard(week, history, prediction, at), `Weekly forecast. ${prediction.text}.`)}
      {totals ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {chart(periodsCard(totals), 'Tokens today, this week, month, year and all time')}
          {chart(compareCard(totals), 'Each period against the same point in the one before')}
          {chart(sessionCard(stats, totals, now), 'This session and the running rates')}
          {chart(averagesCard(totals), 'Averages, peaks and active streak')}
          {chart(hoursCard(totals, now), 'Tokens today by the hour')}
          {chart(daysCard(totals, now), 'Tokens day by day')}
          {chart(breakdownCard(totals), 'Input, output and cache tokens per period')}
          {chart(modelTableCard(totals), 'Every model against every period')}
          {chart(modelsCard(totals), 'Tokens by model')}
          {chart(cacheCard(totals), 'Cache share and reply counts')}
          {chart(projectsCard(totals), 'Top projects')}
          {chart(sessionsCard(totals), 'Top sessions today')}
          {chart(projectsTodayCard(totals), 'Projects today')}
          {chart(projectsWeekCard(totals), 'Projects this week')}
          {chart(monthsCard(totals), 'Tokens per month and year')}
          {chart(heatCard(totals), 'Tokens by weekday and hour')}
        </Box>
      ) : (
        <Text dimColor>{note ?? 'Counting tokens...'}</Text>
      )}
    </Box>
  )
}

function details(
  // The drawing surface's own elements, the same on the band and the pane.
  Box: ElementTable<'terminal'>['Box'],
  Text: ElementTable<'terminal'>['Text'],
  list: readonly Limit[],
  totals: Summary | null,
  note: string | null,
  now: number,
) {
  const windows = list.map(l => ({ ...l, ...current(l, now) }))
  const pad = (s: string, n: number) => s.padStart(n)
  const row = (name: string, cells: readonly string[]) =>
    name.padEnd(12) + cells.map(c => pad(c, 11)).join('')
  const line = (t: Tokens) => [
    amount(tokensOf(t)),
    amount(t.in),
    amount(t.out),
    amount(t.cr),
    amount(t.cw),
    String(t.n),
  ]
  const minus = (a: Tokens, b: Tokens): Tokens => ({
    in: a.in - b.in,
    out: a.out - b.out,
    cr: a.cr - b.cr,
    cw: a.cw - b.cw,
    n: a.n - b.n,
  })

  const names = [
    ['today', 'Today'],
    ['week', 'This week'],
    ['month', 'This month'],
    ['year', 'This year'],
    ['all', 'All time'],
  ] as const

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="semibold">Limits</Text>
        {windows.length === 0 ? <Text dimColor>No reading yet, it comes with the next reply.</Text> : null}
        {windows.map(l => {
          const at = l.resetsAt ? Date.parse(l.resetsAt) : undefined

          return (
            <Text>
              <Text>{limitLabel(l.kind).padEnd(19)}</Text>
              <Text color={pctColor(l.percentUsed)} mono>{bar(l.percentUsed)}</Text>
              <Text> {l.percentUsed}% used, {Math.max(0, 100 - l.percentUsed).toFixed(1).replace(/\.0$/, '')}% left</Text>
              {at ? <Text dimColor> · resets {when(at, now)} (in {countdown(at - now)})</Text> : null}
            </Text>
          )
        })}
      </Box>

      {totals ? (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="semibold">Tokens: this session, other sessions, total</Text>
            <Text mono dimColor>{row('', ['Total', 'This sess.', 'Others'])}</Text>
            {names.map(([key, name]) => {
              const p = totals.periods[key]

              return (
                <Text mono>
                  {row(name, [
                    amount(tokensOf(p.total)),
                    amount(tokensOf(p.session)),
                    amount(tokensOf(minus(p.total, p.session))),
                  ])}
                </Text>
              )
            })}
          </Box>

          <Box flexDirection="column">
            <Text weight="semibold">Breakdown</Text>
            <Text mono dimColor>{row('', ['Total', 'Input', 'Output', 'Cache read', 'Cache new', 'Replies'])}</Text>
            {names.map(([key, name]) => (
              <Text mono>{row(name, line(totals.periods[key].total))}</Text>
            ))}
          </Box>

          <Box flexDirection="column">
            <Text weight="semibold">By model, all time</Text>
            {Object.entries(totals.periods.all.models)
              .sort(([, a], [, b]) => tokensOf(b) - tokensOf(a))
              .map(([model, t]) => (
                <Text mono>{row(model.replace('claude-', '').replace(/-\d{8}$/, ''), [amount(tokensOf(t))])}</Text>
              ))}
          </Box>

          <Box flexDirection="column">
            <Text weight="semibold">By day</Text>
            {[...totals.days].reverse().map(d => (
              <Text mono>{row(d.key, [amount(tokensOf(d))])}</Text>
            ))}
          </Box>

          <Box flexDirection="column">
            <Text weight="semibold">By month and year</Text>
            {[...totals.months].reverse().map(d => (
              <Text mono>{row(d.key, [amount(tokensOf(d))])}</Text>
            ))}
            {[...totals.years].reverse().map(d => (
              <Text mono>{row(d.key, [amount(tokensOf(d))])}</Text>
            ))}
          </Box>

          <Text dimColor>
            Totals include cache reads. Counted from transcripts on this PC since {totals.firstDay ?? 'today'}.
          </Text>
        </Box>
      ) : (
        <Text dimColor>{note ?? 'Counting tokens...'}</Text>
      )}
    </Box>
  )
}
