import { describe, expect, mock, test } from 'claude-code/testing'

import { amount, paceOf, setUtcOffset, when } from './charts'
import { ageOf, foldReadings, latestReadAt, mergeLimits, newerReading, predict, withTimes } from './register'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const GREEN = '#22c55e'
const ORANGE = '#f97316'
const RED = '#ef4444'

setUtcOffset(5.5 * HOUR)

// Tuesday 10 Nov 2026, 11:30 AM at UTC+5:30.
const RESET = Date.parse('2026-11-10T06:00:00Z')
const resetsAt = new Date(RESET).toISOString()
const week = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt })
const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 40, columns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('the run-out prediction', () => {
  test('on pace to reach the reset is green', () => {
    // Half the window gone, under half the limit used.
    const p = predict(week(40), RESET - 3.5 * DAY)
    expect(p.color).toBe(GREEN)
    expect(p.text).toContain('Lasts till reset')
  })

  test('exactly on pace for the reset is green', () => {
    expect(predict(week(50), RESET - 3.5 * DAY).color).toBe(GREEN)
  })

  test('running out the morning of the reset is orange', () => {
    // 3.5 days in at 53%: 100% lands about 2h 45m before the reset.
    const p = predict(week(51.3), RESET - 3.5 * DAY)
    expect(p.color).toBe(ORANGE)
    expect(p.text).toBe('Expected run out Tuesday morning')
  })

  test('the small hours read as early morning, not night', () => {
    // About 3 AM on the day of the reset: before it, so orange.
    const p = predict(week(52.7), RESET - 3.5 * DAY)
    expect(p.color).toBe(ORANGE)
    expect(p.text).toBe('Expected run out Tuesday early morning')
  })

  test('running out Sunday afternoon is red', () => {
    const now = Date.parse('2026-11-05T12:30:00Z') // Thursday 6 PM at UTC+5:30.
    const elapsed = now - (RESET - 7 * DAY)
    const out = Date.parse('2026-11-08T09:30:00Z') // Sunday 3 PM at UTC+5:30.
    const pct = (100 * elapsed) / (elapsed + (out - now))
    const p = predict(week(pct), now)
    expect(p.color).toBe(RED)
    expect(p.text).toBe('Expected run out Sunday afternoon')
  })

  test('60% on Friday evening runs out Sunday night, as Settings says', () => {
    const p = predict(week(60), Date.parse('2026-11-06T13:00:00Z'))
    expect(p.text).toBe('Expected run out Sunday night')
    expect(p.color).toBe(RED)
  })

  test('an old reading is paced from when it was read', () => {
    const now = Date.parse('2026-11-06T13:00:00Z')
    const fresh = predict(week(60), now)
    const old = predict(week(60), now, now - 12 * HOUR)
    expect(old.runsOutAt).toBeLessThan(fresh.runsOutAt as number)
  })

  test('a limit already used up says so', () => {
    const p = predict(week(100), RESET - DAY)
    expect(p.color).toBe(RED)
    expect(p.text).toContain('Run out')
  })

  test('no reading yet stays neutral', () => {
    expect(predict(undefined, RESET).text).toContain('next reply')
  })
})

test('times read in the local timezone', () => {
  expect(when(RESET, RESET - 3 * DAY)).toBe('Tuesday 11:30 AM')
  expect(when(RESET, RESET - HOUR)).toBe('today 11:30 AM')
})

test('tokens read in the unit that fits', () => {
  expect(amount(850_000)).toBe('850K')
  expect(amount(50_200_000)).toBe('50.2M')
  expect(amount(1_300_000)).toBe('1.30M')
  expect(amount(4_409_300_000)).toBe('4.41B')
  expect(amount(999)).toBe('999')
})

test('an idle session cannot pull a window backwards, a new window replaces', () => {
  const later = new Date(RESET + 7 * DAY).toISOString()
  expect(mergeLimits([week(60)], [week(40)])[0]?.percentUsed).toBe(60)
  expect(mergeLimits([week(40)], [week(60)])[0]?.percentUsed).toBe(60)
  expect(
    mergeLimits([week(90)], [{ kind: 'seven_day', percentUsed: 2, resetsAt: later }])[0]?.percentUsed,
  ).toBe(2)
})

test('the bar minimises to a dot and comes back', async ($, on) => {
  mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'usage-details' })).toBeDefined()

    await ui.press({ key: 'usage-minimise' })
    expect(await ui.find({ key: 'usage-open' })).toBeDefined()
    expect(await ui.find({ key: 'usage-details' })).toBeUndefined()

    await ui.press({ key: 'usage-open' })
    expect(await ui.find({ key: 'usage-details' })).toBeDefined()
    await ui.unmount()
  }
})

test('the terminal gets the text view, the desktop gets charts', async ($, on) => {
  mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }))
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await terminal.press({ key: 'usage-details' })
  expect(await terminal.find({ type: 'Text', text: /Limits/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
})

test('the minimised dot and the minimise button draw no words', async ($, on) => {
  mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Exactly the gauge character: no letters on either button.
  expect((await ui.find({ key: 'usage-minimise' }))?.text).toBe('\u{1F55B}︎')
  await ui.press({ key: 'usage-minimise' })
  expect((await ui.find({ key: 'usage-open' }))?.text).toBe('\u{1F55B}︎')
  await ui.unmount()
})

test('expanding fills the band and X collapses to the gauge', async ($, on) => {
  mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'usage-details' })
  expect(await ui.find({ key: 'usage-close' })).toBeDefined()
  expect(await ui.find({ key: 'usage-details' })).toBeUndefined()

  await ui.press({ key: 'usage-close' })
  expect(await ui.find({ key: 'usage-open' })).toBeDefined()
  expect(await ui.find({ key: 'usage-close' })).toBeUndefined()
  await ui.unmount()
})

test('a limit reads its own pace', () => {
  const at = RESET - 3.5 * DAY
  expect(paceOf(week(40), at)?.text).toBe('Lasts till reset')
  expect(paceOf(week(70), at)?.text).toContain('Out')
  expect(paceOf({ kind: 'five_hour', percentUsed: 80, resetsAt }, RESET - 4 * HOUR)?.text).toContain('Out')
})

test('/usage-bar disable hides the bar and enable brings it back', async ($, on) => {
  mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('session.id', () => ({ value: 'test' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  // Stands for the engine's empty band beneath the mod.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'usage-details' })).toBeDefined()

  const off = await $.command.run({ command: 'usage-bar', args: 'disable' })
  expect(off.text).toContain('off')
  expect(await ui.find({ key: 'usage-details' })).toBeUndefined()
  expect(await ui.find({ key: 'usage-open' })).toBeUndefined()

  const again = await $.command.run({ command: 'usage-bar', args: 'enable' })
  expect(again.text).toContain('on')
  expect(await ui.find({ key: 'usage-details' })).toBeDefined()

  const unknown = await $.command.run({ command: 'usage-bar', args: 'banana' })
  expect(unknown.text).toContain('Try')
  await ui.unmount()
})

test('a reading says how old it is once that matters', () => {
  expect(ageOf(RESET, RESET + 60_000)).toBeNull()
  expect(ageOf(RESET, RESET + 2 * HOUR)).toBe('Reading 2h 0m old')
  expect(ageOf(0, RESET)).toBeNull()
})

test('a new reading is saved for the usage-bar CLI, once', async ($, on) => {
  const clock = mock.clock(on, { now: RESET - 3 * DAY })
  mock.store(on)
  mock.env(on, { USAGE_BAR_CACHE_DIR: 'D:\\data\\usage bar' })
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }) })

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  // Stands for the engine beneath the plugin.
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const measured = [
    { kind: 'five_hour', percentUsed: 68, resetsAt: new Date(RESET - 2 * DAY).toISOString() },
    { kind: 'seven_day', percentUsed: 80, resetsAt },
  ]

  await $.session.measure({ context: { window: 200_000 }, rateLimits: measured, changed: ['rateLimits'] })
  await clock.settle()
  const saved = runs.filter(r => (r.argv[1] ?? '').endsWith('scanner/snapshot.mjs'))
  expect(saved.length).toBe(1)
  expect(saved[0]?.argv[0]).toBe('node')
  expect(saved[0]?.argv[2]).toBe('D:\\data\\usage bar')
  const at = RESET - 3 * DAY
  expect(JSON.parse(saved[0]?.stdin ?? '{}')).toEqual({
    refreshedAt: at,
    limits: measured.map(l => ({ ...l, readAt: at, source: 'reply' })),
  })

  // The same reading again writes nothing new.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: measured, changed: [] })
  await clock.settle()
  expect(runs.filter(r => (r.argv[1] ?? '').endsWith('scanner/snapshot.mjs')).length).toBe(1)
})

describe('readings keep their own time', () => {
  const R5 = new Date(RESET - 2 * DAY).toISOString()
  const at = RESET - 3 * DAY

  test('a periodic refresh with no new account data never makes a reading newer', () => {
    const own = new Map()
    const first = foldReadings([], own, [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at, true)
    expect(latestReadAt(first)).toBe(at)
    // Forty minutes of refreshes, the session still showing the same 71%.
    const later = foldReadings(first, own, [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at + 40 * 60_000, false)
    expect(later[0]?.readAt).toBe(at)
    expect(later[0]?.percentUsed).toBe(71)
  })

  test('the 71% / 74% case: a newer reading in the shared store is not pulled back by an idle session', () => {
    const idle = new Map()
    foldReadings([], idle, [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at, true)
    // Another session saved 74% ten minutes later.
    const store = [{ kind: 'five_hour', percentUsed: 74, resetsAt: R5, readAt: at + 10 * 60_000, source: 'reply' }]
    const merged = foldReadings(store, idle, [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at + 12 * 60_000, false)
    expect(merged[0]?.percentUsed).toBe(74)
    expect(merged[0]?.readAt).toBe(at + 10 * 60_000)
  })

  test('a session heals a store another session overwrote with an older reading', () => {
    const own = new Map()
    foldReadings([], own, [{ kind: 'five_hour', percentUsed: 76, resetsAt: R5 }], at + 20 * 60_000, true)
    const clobbered = [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5, readAt: at, source: 'reply' }]
    const merged = foldReadings(clobbered, own, [{ kind: 'five_hour', percentUsed: 76, resetsAt: R5 }], at + 21 * 60_000, false)
    expect(merged[0]?.percentUsed).toBe(76)
    expect(merged[0]?.readAt).toBe(at + 20 * 60_000)
  })

  test('a figure that changed between refreshes is a new reading, from a poll', () => {
    const own = new Map()
    foldReadings([], own, [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at, true)
    const merged = foldReadings([], own, [{ kind: 'five_hour', percentUsed: 73, resetsAt: R5 }], at + 60_000, false)
    expect(merged[0]?.percentUsed).toBe(73)
    expect(merged[0]?.source).toBe('poll')
  })

  test("a session's figures of unknown time never beat a timed reading of the same window", () => {
    const store = [{ kind: 'five_hour', percentUsed: 74, resetsAt: R5, readAt: at, source: 'reply' }]
    const merged = foldReadings(store, new Map(), [{ kind: 'five_hour', percentUsed: 80, resetsAt: R5 }], at + 60_000, false)
    expect(merged[0]?.percentUsed).toBe(74)
    const alone = foldReadings([], new Map(), [{ kind: 'five_hour', percentUsed: 80, resetsAt: R5 }], at, false)
    expect(alone[0]?.readAt).toBe(0)
    expect(alone[0]?.source).toBe('session')
  })

  test('windows are handled on their own, and an older reset window loses', () => {
    const later = new Date(RESET - DAY).toISOString()
    expect(newerReading({ kind: 'five_hour', percentUsed: 97, resetsAt: R5, readAt: at + 9 }, { kind: 'five_hour', percentUsed: 3, resetsAt: later, readAt: at })?.percentUsed).toBe(3)
    const merged = mergeLimits(
      [{ kind: 'five_hour', percentUsed: 70, resetsAt: R5, readAt: at + 5 }, { kind: 'seven_day', percentUsed: 79, resetsAt, readAt: at }],
      [{ kind: 'five_hour', percentUsed: 65, resetsAt: R5, readAt: at }, { kind: 'seven_day', percentUsed: 81, resetsAt, readAt: at + 5 }],
    )
    expect(merged.find(l => l.kind === 'five_hour')?.percentUsed).toBe(70)
    expect(merged.find(l => l.kind === 'seven_day')?.percentUsed).toBe(81)
  })

  test('readings saved by 1.3.0 take the one time those versions kept', () => {
    const migrated = withTimes([{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }], at)
    expect(migrated[0]?.readAt).toBe(at)
  })
})

test('a periodic refresh writes the refresh time, never a new reading time', async ($, on) => {
  const clock = mock.clock(on, { now: RESET - 3 * DAY })
  const at = RESET - 3 * DAY
  const R5 = new Date(RESET - 2 * DAY).toISOString()
  mock.store(on, { limits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5, readAt: at - 40 * 60_000, source: 'reply' }], limitsAt: at - 40 * 60_000 })
  mock.env(on, { USAGE_BAR_CACHE_DIR: 'D:\\data' })
  const runs: string[] = []
  on('process.run', (_, e) => {
    if ((e.argv[1] ?? '').endsWith('scanner/snapshot.mjs')) runs.push(e.init?.stdin ?? '')

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: R5 }] } }))
  on('command.register', () => ({ value: { command: 'usage-bar' } }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const sent = JSON.parse(runs[runs.length - 1] ?? '{}')
  expect(sent.refreshedAt).toBe(at)
  expect(sent.limits[0].readAt).toBe(at - 40 * 60_000)
  expect(sent.limits[0].percentUsed).toBe(71)
})
