// Writes the usage snapshot the `usage-bar` CLI reads, and puts the CLI beside it.
//
//   node snapshot.mjs <cacheDir>      (one reading as JSON on stdin)
//
// The plugin runs this whenever its limit reading changes, with exactly what the
// bar shows: `{ readAt, limits: [{ kind, percentUsed, resetsAt }] }`. Nothing is
// worked out here. Files are written to a temporary name and renamed into place,
// so a reader sees either the old snapshot or the new one, never half of one.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SNAPSHOT = 'status.json'
const CLI_FILES = ['usage-bar.mjs', 'usage-bar.cmd']
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

// Turns the plugin's reading into the snapshot, or throws on anything malformed,
// so a bad call never replaces a good snapshot.
export function toSnapshot(reading, writtenAt = Date.now()) {
  if (!reading || typeof reading !== 'object') throw new Error('reading must be an object')
  const { readAt, limits } = reading
  if (!Array.isArray(limits)) throw new Error('limits must be an array')
  const windows = limits.map(limit => {
    const { kind, percentUsed, resetsAt } = limit ?? {}
    if (typeof kind !== 'string' || kind === '') throw new Error('a limit has no kind')
    if (typeof percentUsed !== 'number' || !Number.isFinite(percentUsed)) {
      throw new Error(`limit ${kind} has no percentage`)
    }
    if (resetsAt !== undefined && Number.isNaN(Date.parse(resetsAt))) {
      throw new Error(`limit ${kind} has a bad reset time`)
    }

    return { kind, used_percent: percentUsed, resets_at: resetsAt ?? null }
  })

  return {
    schema_version: 1,
    source: 'usage-bar plugin',
    written_at: new Date(writtenAt).toISOString(),
    reading_at: typeof readAt === 'number' && readAt > 0 ? new Date(readAt).toISOString() : null,
    windows,
  }
}

// Copies the CLI next to the snapshot, so it sits at one path that does not move
// when the plugin updates. Unchanged files are left alone.
export async function installCli(dir, from = join(here, '..', 'cli')) {
  for (const name of CLI_FILES) {
    const text = await readFile(join(from, name), 'utf8')
    const target = join(dir, name)
    const held = await readFile(target, 'utf8').catch(() => null)
    if (held !== text) await writeAtomic(target, text)
  }
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
  const snapshot = toSnapshot(JSON.parse(await readStdin()))
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, SNAPSHOT), `${JSON.stringify(snapshot, null, 2)}\n`)
  await installCli(dir)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`usage-bar snapshot: ${error.message}\n`)
    process.exit(1)
  })
}
