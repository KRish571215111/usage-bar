// Tests for the read-only `usage-bar` CLI and the snapshot writer.
//   node --test tests/cli.node-test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildStatus, freshnessCode, localIso, readSnapshot, resolveCacheDir } from '../cli/usage-bar.mjs'
import { installCli, toSnapshot, writeAtomic } from '../scanner/snapshot.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'cli', 'usage-bar.mjs')
const WRITER = join(ROOT, 'scanner', 'snapshot.mjs')
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-11-12T20:00:00Z')

const scratch = mkdtempSync(join(tmpdir(), 'usage-bar-cli-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const freshDir = (name = 'case') => {
  const dir = join(scratch, `${name}-${(n += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const snapshot = (windows, readAt = NOW - 2 * MIN) => ({
  schema_version: 1,
  source: 'usage-bar plugin',
  written_at: new Date(readAt).toISOString(),
  reading_at: new Date(readAt).toISOString(),
  windows,
})
const FIVE = { kind: 'five_hour', used_percent: 68, resets_at: new Date(NOW + 3 * HOUR).toISOString() }
const WEEK = { kind: 'seven_day', used_percent: 80, resets_at: new Date(NOW + 4 * 24 * HOUR).toISOString() }

// For runs of the real CLI, which reads the real clock.
const LIVE_FIVE = { ...FIVE, resets_at: new Date(Date.now() + 3 * HOUR).toISOString() }
const LIVE_WEEK = { ...WEEK, resets_at: new Date(Date.now() + 4 * 24 * HOUR).toISOString() }

const status = (snap, options = {}) => buildStatus({ snapshot: snap }, { now: NOW, ...options })

const runCli = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, USAGE_BAR_CACHE_DIR: '', ...env } })

test('1. valid usage data', () => {
  const s = status(snapshot([FIVE, WEEK]))
  assert.equal(s.available, true)
  assert.deepEqual(s.five_hour, {
    state: 'current',
    used_percent: 68,
    remaining_percent: 32,
    resets_at: localIso(NOW + 3 * HOUR),
    reading: { received_at: localIso(NOW - 2 * MIN), age_seconds: 120, fresh: true, source: 'reply' },
  })
  assert.equal(s.weekly.used_percent, 80)
  assert.equal(s.weekly.remaining_percent, 20)
  assert.equal(s.reading.age_seconds, 120)
  assert.equal(s.reading.fresh, true)
  assert.equal(s.reading.status, 'fresh')
  assert.equal(s.awaiting_new_reading, false)
  assert.deepEqual(s.missing, [])
  assert.equal(freshnessCode(s), 0)
  assert.match(s.five_hour.resets_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
})

test('2. missing five-hour data', () => {
  const s = status(snapshot([WEEK]))
  assert.equal(s.available, true)
  assert.equal(s.five_hour, null)
  assert.equal(s.weekly.used_percent, 80)
  assert.deepEqual(s.missing, ['five_hour'])
})

test('3. missing weekly data', () => {
  const s = status(snapshot([FIVE]))
  assert.equal(s.available, true)
  assert.equal(s.weekly, null)
  assert.deepEqual(s.missing, ['weekly'])
})

test('4. no cached snapshot', async () => {
  const dir = freshDir('empty')
  const found = await readSnapshot(join(dir, 'status.json'))
  assert.deepEqual(found, { error: 'no_snapshot' })
  const s = buildStatus(found, { now: NOW })
  assert.equal(s.available, false)
  assert.equal(s.reason, 'no_snapshot')
  assert.equal(s.reading.status, 'unavailable')
  assert.equal(freshnessCode(s), 2)

  const run = runCli(['status', '--json', '--check-freshness', '--cache-dir', dir])
  assert.equal(run.status, 2)
  assert.equal(JSON.parse(run.stdout).available, false)
})

test('5. stale reading', () => {
  const s = status(snapshot([FIVE, WEEK], NOW - 3 * HOUR))
  assert.equal(s.available, true)
  assert.equal(s.reading.fresh, false)
  assert.equal(s.reading.status, 'stale')
  assert.equal(s.reading.age_seconds, 3 * 3600)
  assert.equal(s.five_hour.used_percent, 68, 'a stale reading still reports its numbers')
  assert.equal(freshnessCode(s), 1)
  assert.equal(status(snapshot([FIVE], NOW - 3 * HOUR), { maxAgeSeconds: 4 * 3600 }).reading.fresh, true)
})

test('6. expired five-hour reset', () => {
  const old = { ...FIVE, resets_at: new Date(NOW - 1 * MIN).toISOString() }
  const s = status(snapshot([old, WEEK]))
  assert.equal(s.five_hour.state, 'expired')
  assert.equal(s.five_hour.used_percent, null, 'never claims a 0% reading it did not receive')
  assert.equal(s.five_hour.remaining_percent, null)
  assert.equal(s.five_hour.last_reading.used_percent, 68)
  assert.equal(s.five_hour.last_reading.fresh, false)
  assert.equal(s.five_hour.resets_at, localIso(NOW - MIN))
  assert.equal(s.weekly.state, 'current')
  assert.equal(s.awaiting_new_reading, true)
  assert.equal(freshnessCode(s), 1)
})

test('7. expired weekly reset', () => {
  const old = { ...WEEK, resets_at: new Date(NOW - HOUR).toISOString() }
  const s = status(snapshot([FIVE, old]))
  assert.equal(s.weekly.state, 'expired')
  assert.equal(s.weekly.used_percent, null)
  assert.equal(s.weekly.last_reading.used_percent, 80)
  assert.equal(s.five_hour.state, 'current')
  assert.equal(s.awaiting_new_reading, true)
})

test('8. invalid or corrupted JSON', async () => {
  const dir = freshDir('corrupt')
  writeFileSync(join(dir, 'status.json'), '{"schema_version": 1, "windows": [')
  const s = buildStatus(await readSnapshot(join(dir, 'status.json')), { now: NOW })
  assert.equal(s.available, false)
  assert.equal(s.reason, 'corrupt_snapshot')

  const run = runCli(['status', '--json', '--cache-dir', dir])
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).reason, 'corrupt_snapshot')

  assert.equal(status({ schema_version: 1 }).reason, 'corrupt_snapshot')
  assert.equal(status({ ...snapshot([FIVE]), schema_version: 2 }).reason, 'unsupported_schema')
  assert.equal(status(snapshot([])).reason, 'no_windows')
  assert.throws(() => toSnapshot({ readAt: NOW, limits: [{ kind: 'five_hour' }] }), /percentage/)
})

test('9. atomic snapshot update', async () => {
  const dir = freshDir('atomic')
  const path = join(dir, 'status.json')
  const big = pct => JSON.stringify({ ...snapshot([{ ...FIVE, used_percent: pct }, WEEK]), padding: 'x'.repeat(200_000) })
  await writeAtomic(path, big(0))

  let reads = 0
  let stop = false
  const reader = (async () => {
    while (!stop) {
      const text = readFileSync(path, 'utf8')
      JSON.parse(text) // throws if a reader ever sees half a file
      reads += 1
      await new Promise(resolve => setImmediate(resolve))
    }
  })()
  for (let i = 1; i <= 60; i += 1) await writeAtomic(path, big(i))
  stop = true
  await reader
  assert.ok(reads > 0)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).windows[0].used_percent, 60)
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temporary files left behind')

  // The writer itself, run the way the plugin runs it, in parallel.
  const writes = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WRITER, dir])
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))))
      child.stdin.end(JSON.stringify({ readAt: NOW, limits: [{ kind: 'five_hour', percentUsed: 10 + i, resetsAt: FIVE.resets_at }] }))
    }),
  )
  await Promise.all(writes)
  const final = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(final.windows[0].used_percent >= 10 && final.windows[0].used_percent <= 15)
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [])

  // A bad reading never replaces a good snapshot.
  const bad = spawnSync(process.execPath, [WRITER, dir], { input: '{"limits": "nope"}', encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), final)
})

test('10. Windows path handling', async () => {
  const dir = join(freshDir('paths'), 'Usage Bar Data', 'nested folder')
  const winDir = process.platform === 'win32' ? dir.replace(/\//g, '\\') : dir
  const write = spawnSync(process.execPath, [WRITER, winDir], {
    // An hour-old reading, so --check-freshness has to call it stale.
    input: JSON.stringify({ readAt: Date.now() - HOUR, limits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: LIVE_FIVE.resets_at }] }),
    encoding: 'utf8',
  })
  assert.equal(write.status, 0, write.stderr)
  assert.ok(existsSync(join(dir, 'status.json')))
  assert.ok(existsSync(join(dir, 'usage-bar.mjs')) && existsSync(join(dir, 'usage-bar.cmd')), 'CLI installed beside it')

  for (const args of [['--cache-dir', winDir], []]) {
    const run = runCli(['status', '--json', ...args], args.length ? {} : { USAGE_BAR_CACHE_DIR: winDir })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(run.stdout).five_hour.used_percent, 41)
  }

  assert.equal(resolveCacheDir({ env: { USERPROFILE: 'C:\\Users\\Someone' }, scriptDir: dir }), dir, 'finds its own folder')
  assert.equal(resolveCacheDir({ env: {}, cacheDir: winDir }), dir)

  if (process.platform === 'win32') {
    // The shim, through cmd and PowerShell, the way a person runs it.
    const viaCmd = spawnSync('cmd.exe', ['/d', '/c', join(dir, 'usage-bar.cmd'), 'status', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, USAGE_BAR_CACHE_DIR: '' },
    })
    assert.equal(viaCmd.status, 0, viaCmd.stderr)
    assert.equal(JSON.parse(viaCmd.stdout).five_hour.used_percent, 41)

    const ps = `& '${join(dir, 'usage-bar.cmd').replace(/'/g, "''")}' status --json --check-freshness; exit $LASTEXITCODE`
    const viaPs = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      env: { ...process.env, USAGE_BAR_CACHE_DIR: '' },
    })
    assert.equal(JSON.parse(viaPs.stdout).five_hour.used_percent, 41)
    assert.equal(viaPs.status, 1, 'an hour-old reading is stale: exit code 1 reaches PowerShell')
  }

  // Installing the CLI again leaves an unchanged copy alone.
  await installCli(dir)
})

test('11. JSON output contains no extra text', () => {
  const dir = freshDir('json')
  writeFileSync(join(dir, 'status.json'), JSON.stringify(snapshot([LIVE_FIVE, LIVE_WEEK], Date.now() - MIN)))
  const run = runCli(['status', '--json', '--cache-dir', dir])
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  assert.equal(run.stdout.trim(), JSON.stringify(JSON.parse(run.stdout), null, 2))
  assert.ok(run.stdout.trimStart().startsWith('{') && run.stdout.endsWith('}\n'))

  const text = runCli(['status', '--cache-dir', dir])
  assert.match(text.stdout, /5-hour: 68% used, 32% left/)
  assert.match(text.stdout, /Weekly: 80% used, 20% left/)

  const wrong = runCli(['stats'])
  assert.equal(wrong.status, 64)
  assert.equal(wrong.stdout, '')
})

test('12. CLI does not launch a Claude session', () => {
  const dir = freshDir('noclaude')
  writeFileSync(join(dir, 'status.json'), JSON.stringify(snapshot([LIVE_FIVE, LIVE_WEEK], Date.now() - MIN)))
  const trap = freshDir('trap')
  const marker = join(trap, 'claude-was-run')
  // A fake `claude` first on PATH records any call to it.
  writeFileSync(join(trap, 'claude.cmd'), `@echo off\r\necho ran> "${marker}"\r\n`)
  writeFileSync(join(trap, 'claude'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 })
  const sep = process.platform === 'win32' ? ';' : ':'
  const run = runCli(['status', '--json', '--check-freshness', '--cache-dir', dir], {
    PATH: `${trap}${sep}${process.env.PATH}`,
    Path: `${trap}${sep}${process.env.Path ?? process.env.PATH}`,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(marker), false)

  const source = readFileSync(CLI, 'utf8')
  assert.doesNotMatch(source, /child_process|\bfetch\(|node:https?|node:net/, 'no process, network or HTTP use')
})
