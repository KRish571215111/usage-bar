#!/usr/bin/env node
// usage-bar: prints the last usage reading the Usage Bar plugin saved. Read-only.
//
//   usage-bar status [--json] [--check-freshness] [--max-age <seconds>] [--cache-dir <dir>]
//
// It reads status.json, which the plugin writes each time Claude Code hands it new
// limits (with each reply). It never contacts Anthropic, never starts Claude Code
// and never works out usage itself: it reports the saved reading and how old it is.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SNAPSHOT = 'status.json'
export const DEFAULT_MAX_AGE_SECONDS = 300
const here = dirname(fileURLToPath(import.meta.url))

const USAGE = `usage: usage-bar status [--json] [--check-freshness] [--max-age <seconds>] [--cache-dir <dir>]

  --json             machine-readable JSON only
  --check-freshness  exit 0 when fresh, 1 when stale or a window has reset, 2 when unavailable
  --max-age <s>      seconds a reading counts as fresh (default ${DEFAULT_MAX_AGE_SECONDS})
  --cache-dir <dir>  where status.json lives (default: USAGE_BAR_CACHE_DIR, this script's
                     folder, then ~/.claude/usage-bar)
`

// Where the snapshot is: an explicit folder, the plugin's own setting, the folder
// this script was installed into, then the plugin's default.
export function resolveCacheDir({ cacheDir, env = process.env, scriptDir = here } = {}) {
  if (cacheDir) return resolve(cacheDir)
  if (env.USAGE_BAR_CACHE_DIR) return resolve(env.USAGE_BAR_CACHE_DIR)
  if (existsSync(join(scriptDir, SNAPSHOT))) return scriptDir
  const home = env.USERPROFILE || env.HOME || homedir()

  return join(home, '.claude', 'usage-bar')
}

const pad = n => String(n).padStart(2, '0')

// An instant in the computer's own timezone, with its offset: 2026-11-13T04:40:00+05:30.
export function localIso(ms) {
  const offset = -new Date(ms).getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19)

  return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const round1 = n => Math.round(n * 10) / 10

// Reads the snapshot. A miss or a bad file is an answer, not a crash.
export async function readSnapshot(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: 'no_snapshot' }

    return { error: 'unreadable_snapshot', detail: error?.code ?? String(error) }
  }
  try {
    return { snapshot: JSON.parse(text) }
  } catch {
    return { error: 'corrupt_snapshot', detail: 'status.json is not valid JSON' }
  }
}

const REASONS = {
  no_snapshot:
    'No usage snapshot yet. It is written by Usage Bar 1.3.0 or newer after a reply in Claude Code.',
  unreadable_snapshot: 'The usage snapshot could not be read.',
  corrupt_snapshot: 'The usage snapshot is damaged. It is rewritten after the next reply in Claude Code.',
  unsupported_schema: 'The usage snapshot was written by a newer Usage Bar. Update the CLI.',
  no_windows: 'Claude Code has not reported any limits yet. They come with the next reply.',
}

const ageSeconds = (ms, now) => (Number.isNaN(ms) ? null : Math.max(0, Math.floor((now - ms) / 1000)))

// When Claude Code reported this window's figure, how long ago, and how it came.
// Snapshots from Usage Bar 1.3.0 have one time for all windows: `fallbackAt`.
function readingOf(entry, now, fallbackAt, maxAgeSeconds) {
  const at = entry.reading_at ?? fallbackAt ?? null
  const ms = at ? Date.parse(at) : NaN
  const age = ageSeconds(ms, now)

  return {
    received_at: Number.isNaN(ms) ? null : localIso(ms),
    age_seconds: age,
    fresh: age !== null && age <= maxAgeSeconds,
    source: entry.source ?? 'reply',
  }
}

function windowStatus(entry, now, fallbackAt, maxAgeSeconds) {
  const resetMs = entry.resets_at ? Date.parse(entry.resets_at) : NaN
  const resetsAt = Number.isNaN(resetMs) ? null : localIso(resetMs)
  const reading = readingOf(entry, now, fallbackAt, maxAgeSeconds)
  if (!Number.isNaN(resetMs) && resetMs <= now) {
    // The window started over, but no reading has said where it stands now:
    // report the old one as old, never as a made-up 0%.
    return {
      state: 'expired',
      used_percent: null,
      remaining_percent: null,
      resets_at: resetsAt,
      last_reading: { used_percent: entry.used_percent, ...reading, fresh: false },
      note: 'This window has reset. A new reading comes with the next reply in Claude Code.',
    }
  }

  return {
    state: 'current',
    used_percent: entry.used_percent,
    remaining_percent: round1(Math.max(0, 100 - entry.used_percent)),
    resets_at: resetsAt,
    reading,
  }
}

function unavailable(base, reason, detail, maxAge) {
  return {
    ...base,
    available: false,
    reason,
    message: REASONS[reason] ?? reason,
    ...(detail ? { detail } : {}),
    five_hour: null,
    weekly: null,
    other: [],
    missing: ['five_hour', 'weekly'],
    awaiting_new_reading: false,
    reading: {
      updated_at: null,
      age_seconds: null,
      oldest_age_seconds: null,
      fresh: false,
      status: 'unavailable',
      max_age_seconds: maxAge,
      source: 'claude-code-replies',
    },
    plugin: { refreshed_at: null, refresh_age_seconds: null, snapshot_written_at: null },
  }
}

// The status the CLI prints, from what readSnapshot found.
export function buildStatus(found, { now = Date.now(), maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS, path = null } = {}) {
  const base = { schema_version: 1, generated_at: localIso(now), snapshot_path: path }
  if (found.error) return unavailable(base, found.error, found.detail, maxAgeSeconds)

  const snapshot = found.snapshot
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.windows)) {
    return unavailable(base, 'corrupt_snapshot', 'status.json has no windows list', maxAgeSeconds)
  }
  if (snapshot.schema_version !== 1) {
    return unavailable(base, 'unsupported_schema', `schema_version ${snapshot.schema_version}`, maxAgeSeconds)
  }

  const windows = snapshot.windows.filter(
    w => w && typeof w.kind === 'string' && typeof w.used_percent === 'number' && Number.isFinite(w.used_percent),
  )
  if (windows.length === 0) return unavailable(base, 'no_windows', null, maxAgeSeconds)

  const byKind = kind => windows.find(w => w.kind === kind)
  const fiveHour = byKind('five_hour')
  const weekly = byKind('seven_day')
  const status = w => windowStatus(w, now, snapshot.reading_at, maxAgeSeconds)
  const five_hour = fiveHour ? status(fiveHour) : null
  const week = weekly ? status(weekly) : null
  const other = windows
    .filter(w => w.kind !== 'five_hour' && w.kind !== 'seven_day')
    .map(w => ({ kind: w.kind, ...status(w) }))

  // The newest reading, and whether every window still running is fresh: one
  // old window makes the whole status stale.
  const readMs = snapshot.reading_at ? Date.parse(snapshot.reading_at) : NaN
  const age = ageSeconds(readMs, now)
  const all = [five_hour, week, ...other].filter(Boolean)
  const running = all.filter(w => w.state === 'current')
  const ages = running.map(w => w.reading.age_seconds)
  const oldest = ages.includes(null) || ages.length === 0 ? null : Math.max(...ages)
  const fresh = running.length > 0 && running.every(w => w.reading.fresh)
  const refreshMs = snapshot.refreshed_at ? Date.parse(snapshot.refreshed_at) : NaN
  const writtenMs = snapshot.written_at ? Date.parse(snapshot.written_at) : NaN

  return {
    ...base,
    available: true,
    five_hour,
    weekly: week,
    other,
    missing: [...(five_hour ? [] : ['five_hour']), ...(week ? [] : ['weekly'])],
    awaiting_new_reading: all.some(w => w.state === 'expired'),
    reading: {
      updated_at: Number.isNaN(readMs) ? null : localIso(readMs),
      age_seconds: age,
      oldest_age_seconds: oldest,
      fresh,
      status: fresh ? 'fresh' : 'stale',
      max_age_seconds: maxAgeSeconds,
      // Readings come only with Claude Code replies. The IDE's own Account &
      // Usage panel reads a source that Claude Code does not give plugins.
      source: 'claude-code-replies',
    },
    // A plugin refresh or a file write is not a new reading: they are kept apart.
    plugin: {
      refreshed_at: Number.isNaN(refreshMs) ? null : localIso(refreshMs),
      refresh_age_seconds: ageSeconds(refreshMs, now),
      snapshot_written_at: Number.isNaN(writtenMs) ? null : localIso(writtenMs),
    },
  }
}

// 0 fresh, 1 stale or a window has reset, 2 unavailable.
export function freshnessCode(status) {
  if (!status.available) return 2
  if (!status.reading.fresh || status.awaiting_new_reading) return 1

  return 0
}

function ago(seconds) {
  if (seconds === null) return 'at an unknown time'
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m ago`

  return `${Math.floor(h / 24)}d ${h % 24}h ago`
}

function clock(iso) {
  const d = new Date(Date.parse(iso))

  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export function formatText(status) {
  if (!status.available) return `Usage Bar: unavailable. ${status.message}\n`
  const r = status.reading
  const lines = [
    `Usage Bar, last reading ${ago(r.age_seconds)}${r.updated_at ? ` (${clock(r.updated_at)})` : ''}: ${
      r.fresh ? 'fresh' : 'STALE, send a message in Claude Code to refresh it'
    }`,
  ]
  if (status.plugin.refreshed_at) lines.push(`Plugin last checked ${ago(status.plugin.refresh_age_seconds)}`)
  const line = (name, w) => {
    if (!w) return `${name}: no reading`
    if (w.state === 'expired') {
      return `${name}: reset at ${clock(w.resets_at)}, waiting for a new reading (was ${w.last_reading.used_percent}%)`
    }

    const lag = w.reading.age_seconds !== null && w.reading.age_seconds !== r.age_seconds ? ` (read ${ago(w.reading.age_seconds)})` : ''

    return `${name}: ${w.used_percent}% used, ${w.remaining_percent}% left${w.resets_at ? `, resets ${clock(w.resets_at)}` : ''}${lag}`
  }
  lines.push(line('5-hour', status.five_hour), line('Weekly', status.weekly))
  for (const w of status.other) lines.push(line(w.kind, w))

  return `${lines.join('\n')}\n`
}

export function parseArgs(argv) {
  const options = { command: argv[0], json: false, check: false, maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--check-freshness') options.check = true
    else if (arg === '--max-age') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value < 0) throw new Error('--max-age needs a number of seconds')
      options.maxAgeSeconds = value
    } else if (arg === '--cache-dir') {
      if (!argv[i + 1]) throw new Error('--cache-dir needs a folder')
      options.cacheDir = argv[++i]
    } else throw new Error(`unknown option ${arg}`)
  }

  return options
}

export async function main(argv = process.argv.slice(2), { env = process.env, now = Date.now() } = {}) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  let options
  try {
    options = parseArgs(argv)
    if (options.command !== 'status') throw new Error(argv[0] ? `unknown command ${argv[0]}` : 'no command')
  } catch (error) {
    process.stderr.write(`usage-bar: ${error.message}\n\n${USAGE}`)
    return 64
  }

  const path = join(resolveCacheDir({ cacheDir: options.cacheDir, env }), SNAPSHOT)
  const status = buildStatus(await readSnapshot(path), { now, maxAgeSeconds: options.maxAgeSeconds, path })
  process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : formatText(status))

  return options.check ? freshnessCode(status) : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code
  })
}
