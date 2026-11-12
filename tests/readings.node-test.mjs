// Readings from several sessions, stale refreshes and resets: the 71% / 74% bug.
//   node --test tests/readings.node-test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildStatus, freshnessCode, readSnapshot } from '../cli/usage-bar.mjs'
import { mergeSnapshot, writeSnapshot } from '../scanner/snapshot.mjs'

const WRITER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scanner', 'snapshot.mjs')
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-11-12T20:20:00Z') // 1:50 AM IST
const RESET_5H = new Date(NOW + 3 * HOUR).toISOString()
const RESET_WEEK = new Date(NOW + 4 * 24 * HOUR).toISOString()

const scratch = mkdtempSync(join(tmpdir(), 'usage-bar-readings-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const freshDir = () => {
  const dir = join(scratch, `case-${(n += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const five = (pct, readAt, resetsAt = RESET_5H, source = 'reply') => ({ kind: 'five_hour', percentUsed: pct, resetsAt, readAt, source })
const week = (pct, readAt, resetsAt = RESET_WEEK, source = 'reply') => ({ kind: 'seven_day', percentUsed: pct, resetsAt, readAt, source })
const statusAt = async (dir, now = NOW) => buildStatus(await readSnapshot(join(dir, 'status.json')), { now })
const held = dir => JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))

test('the reported bug: CLI held 71% while a newer 74% existed; the newer reading wins and stays', async () => {
  const dir = freshDir()
  // Session A (idle) last saw 71% at 1:35.
  await writeSnapshot(dir, { refreshedAt: NOW - 15 * MIN, limits: [five(71, NOW - 15 * MIN), week(80, NOW - 15 * MIN)] })
  // Session B got a reply at 1:48 showing 74%.
  await writeSnapshot(dir, { refreshedAt: NOW - 2 * MIN, limits: [five(74, NOW - 2 * MIN), week(81, NOW - 2 * MIN)] })
  // Session A's periodic refresh re-sends its old 71% afterwards.
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(71, NOW - 15 * MIN), week(80, NOW - 15 * MIN)] })

  const s = await statusAt(dir)
  assert.equal(s.five_hour.used_percent, 74, 'an older reading never overwrites a newer one')
  assert.equal(s.weekly.used_percent, 81)
  assert.equal(s.five_hour.reading.age_seconds, 120)
})

test('a newer reading arriving from another active session replaces the older one', async () => {
  const dir = freshDir()
  await writeSnapshot(dir, { refreshedAt: NOW - 10 * MIN, limits: [five(71, NOW - 10 * MIN)] })
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(76, NOW - MIN)] })
  assert.equal((await statusAt(dir)).five_hour.used_percent, 76)
})

test('a later reading wins even when its figure is lower: the highest is not assumed newest', () => {
  const merged = mergeSnapshot(
    { schema_version: 1, windows: [{ kind: 'five_hour', used_percent: 80, resets_at: RESET_5H, reading_at: new Date(NOW - 10 * MIN).toISOString() }] },
    { limits: [five(78, NOW - MIN)] },
  )
  assert.equal(merged.windows[0].used_percent, 78)
})

test('identical readings from two sessions resolve the same way every time', () => {
  const a = { limits: [five(70, NOW - MIN)] }
  const b = { limits: [five(72, NOW - MIN)] }
  assert.equal(mergeSnapshot(mergeSnapshot(null, a), b).windows[0].used_percent, 72)
  assert.equal(mergeSnapshot(mergeSnapshot(null, b), a).windows[0].used_percent, 72)
})

test('a stale reading refreshed without new account data stays stale', async () => {
  const dir = freshDir()
  await writeSnapshot(dir, { refreshedAt: NOW - 40 * MIN, limits: [five(71, NOW - 40 * MIN), week(80, NOW - 40 * MIN)] })
  // The plugin keeps refreshing, but Claude Code has sent nothing new.
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(71, NOW - 40 * MIN), week(80, NOW - 40 * MIN)] })

  const s = await statusAt(dir)
  assert.equal(s.reading.fresh, false)
  assert.equal(s.reading.age_seconds, 40 * 60, 'the reading keeps its own age')
  assert.equal(s.plugin.refresh_age_seconds, 0, 'the refresh is reported apart, as a refresh')
  assert.notEqual(held(dir).written_at, held(dir).reading_at, 'a file write is not a new reading')
  assert.equal(freshnessCode(s), 1)
})

test('five-hour reset: the expired window is reported as awaiting a reading, weekly carries on', async () => {
  const dir = freshDir()
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(76, NOW - MIN), week(81, NOW - MIN)] })
  const after5h = await statusAt(dir, Date.parse(RESET_5H) + MIN)
  assert.equal(after5h.five_hour.state, 'expired')
  assert.equal(after5h.five_hour.used_percent, null)
  assert.equal(after5h.five_hour.last_reading.used_percent, 76)
  assert.equal(after5h.weekly.state, 'current')
  assert.equal(after5h.awaiting_new_reading, true)

  // The first reply after the reset brings the new window, which replaces the old one.
  const newReset = new Date(Date.parse(RESET_5H) + 5 * HOUR).toISOString()
  await writeSnapshot(dir, { refreshedAt: Date.parse(RESET_5H) + 2 * MIN, limits: [five(2, Date.parse(RESET_5H) + 2 * MIN, newReset)] })
  const s = await statusAt(dir, Date.parse(RESET_5H) + 3 * MIN)
  assert.equal(s.five_hour.state, 'current')
  assert.equal(s.five_hour.used_percent, 2)
  assert.equal(s.weekly.used_percent, 81, 'the weekly window is left alone')
})

test('weekly reset is handled on its own', async () => {
  const dir = freshDir()
  const soon = new Date(NOW + 10 * MIN).toISOString()
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(30, NOW - MIN), week(99, NOW - MIN, soon)] })
  const s = await statusAt(dir, NOW + 11 * MIN)
  assert.equal(s.weekly.state, 'expired')
  assert.equal(s.five_hour.state, 'current')
})

test('a reading from an older reset window never replaces the current window', async () => {
  const dir = freshDir()
  const newReset = new Date(NOW + 5 * HOUR).toISOString()
  const oldReset = new Date(NOW - 10 * MIN).toISOString()
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(4, NOW - 5 * MIN, newReset)] })
  // An idle session whose last reply was in the previous window, stamped later.
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(97, NOW - MIN, oldReset)] })
  const s = await statusAt(dir)
  assert.equal(s.five_hour.used_percent, 4)
  assert.equal(s.five_hour.state, 'current')
})

test('sessions with different timestamps per window: each window keeps its own newest', async () => {
  const dir = freshDir()
  await writeSnapshot(dir, { limits: [five(70, NOW - 1 * MIN), week(79, NOW - 30 * MIN)] })
  await writeSnapshot(dir, { limits: [five(65, NOW - 20 * MIN), week(81, NOW - 2 * MIN)] })
  const s = await statusAt(dir)
  assert.equal(s.five_hour.used_percent, 70)
  assert.equal(s.five_hour.reading.age_seconds, 60)
  assert.equal(s.weekly.used_percent, 81)
  assert.equal(s.weekly.reading.age_seconds, 120)
  assert.equal(s.reading.oldest_age_seconds, 120)
})

test('many sessions writing at once never lose the newest reading', async () => {
  const dir = freshDir()
  const run = input =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WRITER, dir])
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))))
      child.stdin.end(JSON.stringify(input))
    })
  const inputs = Array.from({ length: 8 }, (_, i) => ({ refreshedAt: NOW, limits: [five(60 + i, NOW - (8 - i) * MIN)] }))
  await Promise.all(inputs.map(run))
  assert.equal(held(dir).windows[0].used_percent, 67, 'the newest of eight parallel writes')
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp') || f === 'status.lock'), [])
})

test('a corrupted snapshot is replaced by the next reading', async () => {
  const dir = freshDir()
  writeFileSync(join(dir, 'status.json'), '{"schema_version":1,"windows":[{')
  assert.equal((await statusAt(dir)).reason, 'corrupt_snapshot')
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [five(76, NOW - MIN)] })
  assert.equal((await statusAt(dir)).five_hour.used_percent, 76)
})

test('no reading available: valid status, nothing invented', async () => {
  const dir = freshDir()
  await writeSnapshot(dir, { refreshedAt: NOW, limits: [] })
  const s = await statusAt(dir)
  assert.equal(s.available, false)
  assert.equal(s.reason, 'no_windows')
  assert.equal(s.five_hour, null)
})

test('a 1.3.0 snapshot (one time for all windows) still reads, and merges', async () => {
  const dir = freshDir()
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ schema_version: 1, reading_at: new Date(NOW - 5 * MIN).toISOString(), windows: [{ kind: 'five_hour', used_percent: 71, resets_at: RESET_5H }] }),
  )
  assert.equal((await statusAt(dir)).five_hour.reading.age_seconds, 300)
  await writeSnapshot(dir, { limits: [five(74, NOW - MIN)] })
  assert.equal((await statusAt(dir)).five_hour.used_percent, 74)
})

test('IDE Account & Usage panel as a source: unavailable', { skip: 'unavailable: Claude Code gives plugins no supported interface to the IDE usage panel or the account usage it shows, so this cannot be tested or integrated' }, () => {})
