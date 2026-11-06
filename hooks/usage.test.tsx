import { describe, expect, mock, test } from 'claude-code/testing'

import { amount, paceOf, setUtcOffset, when } from './charts'
import { ageOf, mergeLimits, predict } from './register'

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
