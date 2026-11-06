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

// Several sessions report the same account windows, some of them idle and out
// of date. Inside one window usage only rises, so the later reset wins, then the
// higher percentage.
export function mergeLimits(a: readonly Limit[], b: readonly Limit[]): Limit[] {
  const out = new Map<string, Limit>()
  for (const limit of [...a, ...b]) {
    const held = out.get(limit.kind)
    const heldAt = held?.resetsAt ? Date.parse(held.resetsAt) : 0
    const at = limit.resetsAt ? Date.parse(limit.resetsAt) : 0
    const isSameWindow = Math.abs(heldAt - at) < HOUR
    if (!held || (isSameWindow ? limit.percentUsed >= held.percentUsed : at > heldAt)) {
      out.set(limit.kind, limit)
    }
  }

  return [...out.values()]
}

// Runs the pace forward to 100%: half the pace over the whole window so far, half
// the last 24 hours, which holds a full day-night cycle and so no sleep bias.
export function predict(
  week: Limit | undefined,
  history: readonly Sample[],
  now: number,
): Prediction {
  if (!week?.resetsAt) {
    return { color: GRAY, text: 'Prediction after the next reply' }
  }

  const resetAt = Date.parse(week.resetsAt)
  const resetText = when(resetAt, now)
  const pct = week.percentUsed
  if (pct >= 100) {
    return { color: RED, text: `Run out, back ${resetText}`, runsOutAt: now }
  }

  const elapsed = now - (resetAt - WEEK)
  if (elapsed <= 0 || pct <= 0) {
    return { color: GREEN, text: `Lasts till reset, ${resetText}` }
  }

  const windowRate = pct / elapsed
  const inWindow = history.filter(
    s => Math.abs(Date.parse(s.resetsAt) - resetAt) < HOUR && s.t >= now - DAY && s.t < now,
  )
  const oldest = inWindow[0]
  const hasDay = oldest !== undefined && now - oldest.t >= 3 * HOUR
  const recentRate = hasDay ? Math.max(0, pct - oldest.pct) / (now - oldest.t) : windowRate
  const rate = (windowRate + recentRate) / 2
  const runsOutAt = rate > 0 ? now + (100 - pct) / rate : Infinity

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

async function refresh($: Api, seen?: readonly Limit[]): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('limits')
  const usage = await $.session.usage()
  const reported = seen ?? usage.rateLimits
  const stats: SessionStats = {
    ...(usage.context.percent === undefined ? {} : { contextPercent: usage.context.percent }),
    ...(usage.cost === undefined ? {} : { usd: usage.cost.usd }),
  }
  await update($, session, () => stats)
  const merged = mergeLimits(isArray(stored) ? (stored as Limit[]) : [], reported)
  const held = await $.store.get('samples')
  const history = nextSamples(isArray(held) ? (held as Sample[]) : [], merged, now)
  await $.store.set('limits', merged)
  await $.store.set('samples', history)
  await update($, limits, () => merged)
  await update($, samples, () => history)
  await update($, tick, n => n + 1)
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
    await refresh($, e.rateLimits).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
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
    const prediction = predict(week, await read($, samples), now)
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
          {dashboard(Box, Text, Svg, list, week, history, prediction, stats, totals, note, now)}
        </Box>
      )
    }

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {controls}
        <Box flexGrow={1} flexShrink={1}>
          <Svg
            source={stripSvg(hour5, week, prediction, todayTokens, now)}
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
    const prediction = predict(week, history, now)
    const totals = await read($, summary)
    const note = await read($, scanNote)

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={prediction.color} weight="semibold">
            {prediction.text}
          </Text>
          {details(Box, Text, list, totals, note, now)}
        </Box>
      )
    }

    const { Svg } = table as ElementTable<'desktop'>
    const stats = await read($, session)

    return dashboard(Box, Text, Svg, list, week, history, prediction, stats, totals, note, now)
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
) {
  const windows = list.map(l => ({ ...l, ...current(l, now) }))
  const chart = (source: string, alt: string) => <Svg source={source} alt={alt} />

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
      {chart(gaugesCard(windows, now), 'Limit gauges')}
      {chart(forecastCard(week, history, prediction, now), `Weekly forecast. ${prediction.text}.`)}
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
