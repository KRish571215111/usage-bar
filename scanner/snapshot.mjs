// Writes the usage snapshot the `usage-bar` CLI reads, and puts the CLI beside it.
//
//   node snapshot.mjs <cacheDir>      (the plugin's readings as JSON on stdin)
//
// Input: `{ refreshedAt, limits: [{ kind, percentUsed, resetsAt, readAt, source }] }`,
// exactly what the bar shows. Nothing is worked out here. Several Claude Code
// sessions write this file, so each write takes a lock, reads what is there, keeps
// the newer reading of each window, and renames a finished file into place: a
// reader sees the old snapshot or the new one, never half of one, and an idle
// session can never put an older reading back over a newer one.
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SNAPSHOT = 'status.json'
const LOCK = 'status.lock'
const CLI_FILES = ['usage-bar.mjs', 'usage-bar.cmd']
const HOUR = 3_600_000
const STALE_LOCK_MS = 10_000
const here = dirname(fileURLToPath(import.meta.url))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Windows refuses a rename while another process has the target open for a
// moment (a reader, an antivirus scan), so a refused rename is tried again.
export async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path)
      return
    } catch (error) {
      const isBusy = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
      if (!isBusy || attempt >= 20) {
        await rm(tmp, { force: true })
        throw error
      }
      await sleep(25 + attempt * 10)
    }
  }
}

// One writer at a time. A lock left by a writer that died is taken over after a while.
export async function withLock(dir, work) {
  const lock = join(dir, LOCK)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const age = await stat(lock).then(s => Date.now() - s.mtimeMs, () => 0)
      if (age > STALE_LOCK_MS) await rmdir(lock).catch(() => undefined)
      else if (attempt > 400) throw new Error('status.json is locked')
      else await sleep(15)
    }
  }
  try {
    return await work()
  } finally {
    await rmdir(lock).catch(() => undefined)
  }
}

const resetOf = w => (w.resets_at ? Date.parse(w.resets_at) : 0)
const timeOf = w => (w.reading_at ? Date.parse(w.reading_at) : 0)

// The same rule the plugin keeps: a later window beats any reading of an earlier
// one; inside one window the later reading wins; equal times fall back to the
// higher figure.
export function newerWindow(held, next) {
  if (Math.abs(resetOf(held) - resetOf(next)) >= HOUR) return resetOf(next) > resetOf(held) ? next : held
  if (timeOf(held) !== timeOf(next)) return timeOf(next) > timeOf(held) ? next : held

  return next.used_percent > held.used_percent ? next : held
}

const iso = ms => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null)

// Turns the plugin's readings into snapshot windows, or throws on anything
// malformed, so a bad call never replaces a good snapshot. `readAt` at the top is
// what 1.3.0 sent: one time for every window.
export function toWindows(input) {
  if (!input || typeof input !== 'object') throw new Error('reading must be an object')
  const { limits } = input
  if (!Array.isArray(limits)) throw new Error('limits must be an array')

  return limits.map(limit => {
    const { kind, percentUsed, resetsAt, readAt, source } = limit ?? {}
    if (typeof kind !== 'string' || kind === '') throw new Error('a limit has no kind')
    if (typeof percentUsed !== 'number' || !Number.isFinite(percentUsed)) {
      throw new Error(`limit ${kind} has no percentage`)
    }
    if (resetsAt !== undefined && Number.isNaN(Date.parse(resetsAt))) {
      throw new Error(`limit ${kind} has a bad reset time`)
    }

    return {
      kind,
      used_percent: percentUsed,
      resets_at: resetsAt ?? null,
      reading_at: iso(readAt ?? input.readAt),
      source: typeof source === 'string' ? source : 'reply',
    }
  })
}

// What a snapshot already on disk holds, as windows with their own times. Files
// from 1.3.0 have one `reading_at` for all; a damaged file holds nothing.
export function heldWindows(snapshot) {
  if (!snapshot || snapshot.schema_version !== 1 || !Array.isArray(snapshot.windows)) return []

  return snapshot.windows
    .filter(w => w && typeof w.kind === 'string' && typeof w.used_percent === 'number')
    .map(w => ({ ...w, reading_at: w.reading_at ?? snapshot.reading_at ?? null, source: w.source ?? 'reply' }))
}

export function mergeSnapshot(held, input, writtenAt = Date.now()) {
  const byKind = new Map()
  for (const w of [...heldWindows(held), ...toWindows(input)]) {
    const kept = byKind.get(w.kind)
    byKind.set(w.kind, kept ? newerWindow(kept, w) : w)
  }
  const windows = [...byKind.values()]
  const newest = Math.max(0, ...windows.map(timeOf))
  const refreshed = Math.max(
    held?.refreshed_at ? Date.parse(held.refreshed_at) || 0 : 0,
    typeof input.refreshedAt === 'number' ? input.refreshedAt : 0,
  )

  return {
    schema_version: 1,
    source: 'usage-bar plugin',
    written_at: new Date(writtenAt).toISOString(),
    // Newest reading Claude Code reported; each window has its own below.
    reading_at: iso(newest),
    // Last time a Claude Code session with the plugin checked for readings.
    refreshed_at: iso(refreshed),
    windows,
  }
}

// Kept for 1.3.0's tests and callers: a snapshot built from one input alone.
export function toSnapshot(input, writtenAt = Date.now()) {
  return mergeSnapshot(null, input, writtenAt)
}

// Copies the CLI next to the snapshot, so it sits at one path that does not move
// when the plugin updates. Unchanged files are left alone.
export async function installCli(dir, from = join(here, '..', 'cli')) {
  for (const name of CLI_FILES) {
    const text = await readFile(join(from, name), 'utf8')
    const target = join(dir, name)
    const held = await readFile(target, 'utf8').catch(() => null)
    if (held?.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) await writeAtomic(target, text)
  }
}

export async function writeSnapshot(dir, input) {
  toWindows(input) // refuse a bad reading before touching anything
  await mkdir(dir, { recursive: true })
  const path = join(dir, SNAPSHOT)
  await withLock(dir, async () => {
    // A missing or damaged file holds nothing to keep: the new reading replaces it.
    const text = await readFile(path, 'utf8').catch(() => null)
    let held = null
    try {
      held = text === null ? null : JSON.parse(text)
    } catch {
      held = null
    }
    await writeAtomic(path, `${JSON.stringify(mergeSnapshot(held, input), null, 2)}\n`)
  })
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk

  return text
}

async function main() {
  const dir = process.argv[2]
  if (!dir) {
    process.stderr.write('usage: snapshot.mjs <cacheDir> < reading.json\n')
    process.exit(2)
  }
  await writeSnapshot(dir, JSON.parse(await readStdin()))
  await installCli(dir)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`usage-bar snapshot: ${error.message}\n`)
    process.exit(1)
  })
}
