// Counts tokens from Claude Code transcripts, incrementally, and prints one JSON
// summary on stdout. Only numbers leave here: no message text is kept or printed.
//
//   node scan.mjs <cacheDir> [sessionId]
//
// Each transcript is read from where the last run stopped. Messages are counted
// once across all files (a resumed or forked session copies earlier messages, and
// one response spans several lines). Totals stay in the cache after Claude Code
// cleans old transcripts away.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

const VERSION = 4
// Days and hours read in this computer's own timezone.
const local = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
const STALE_LOCK_MS = 15 * 60 * 1000
const FIELDS = ['in', 'out', 'cr', 'cw']

const cacheDir = process.argv[2]
const sessionId = process.argv[3] ?? ''
if (!cacheDir) {
  console.error('usage: scan.mjs <cacheDir> [sessionId]')
  process.exit(2)
}

const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const cachePath = join(cacheDir, 'cache.json')
const lockPath = join(cacheDir, 'scan.lock')

const dayOf = ms => local(ms).toISOString().slice(0, 10)
const hash = id => createHash('sha1').update(id).digest('hex').slice(0, 16)
const zero = () => ({ in: 0, out: 0, cr: 0, cw: 0, n: 0 })

function add(into, u, n = 1) {
  for (const f of FIELDS) into[f] += u[f]
  into.n += n
}

async function loadCache() {
  try {
    const c = JSON.parse(await readFile(cachePath, 'utf8'))
    if (c.version === VERSION) return c
  } catch {}
  return { version: VERSION, files: {}, days: {}, sessions: {}, projects: {}, seen: '' }
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// A usage row is an assistant line. Streaming can write the same message more
// than once, so a repeat within a file keeps the largest output count.
function record(line, sid, project, state) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  const m = row.message
  const raw = m?.usage
  if (row.type !== 'assistant' || !raw || !m.id || !row.timestamp) return
  if (m.model === '<synthetic>') return
  const t = Date.parse(row.timestamp)
  if (Number.isNaN(t)) return

  const u = {
    in: raw.input_tokens ?? 0,
    out: raw.output_tokens ?? 0,
    cr: raw.cache_read_input_tokens ?? 0,
    cw: raw.cache_creation_input_tokens ?? 0,
  }
  const key = hash(m.id)
  const day = dayOf(t)
  const hour = local(t).getUTCHours()
  const model = m.model ?? 'unknown'

  const pending = state.pending.get(key)
  if (pending) {
    if (u.out > pending.u.out) pending.u = u
    return
  }
  if (state.seen.has(key)) return
  state.pending.set(key, { u, day, hour, model, sid, project })
}

function settle(state, cache) {
  for (const [key, { u, day, hour, model, sid, project }] of state.pending) {
    state.seen.add(key)
    state.added.push(key)
    const d = (cache.days[day] ??= { ...zero(), models: {} })
    add(d, u)
    add((d.models[model] ??= zero()), u)
    const s = (cache.sessions[sid] ??= {})
    add((s[day] ??= zero()), u)
    const total = u.in + u.out + u.cr + u.cw
    d.hours ??= new Array(24).fill(0)
    d.hours[hour] += total
    const p = (cache.projects[project] ??= {})
    p[day] = (p[day] ?? 0) + total
    ;(cache.owners ??= {})[sid] = project
  }
  state.pending.clear()
}

async function readNew(path, from, sid, project, state) {
  let offset = from
  let rest = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { start: from, highWaterMark: 1 << 20 })) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) {
      rest = buf
      continue
    }
    for (const line of buf.toString('utf8', 0, end).split('\n')) record(line, sid, project, state)
    offset += end + 1
    rest = buf.subarray(end + 1)
  }
  return offset
}

async function scan(cache) {
  const seen = new Set()
  for (let i = 0; i < cache.seen.length; i += 16) seen.add(cache.seen.slice(i, i + 16))
  const state = { seen, pending: new Map(), added: [] }
  let changed = false

  for (const path of await walk(projectsDir)) {
    const rel = relative(projectsDir, path)
    let st
    try {
      st = await stat(path)
    } catch {
      continue
    }
    const known = cache.files[rel]
    if (known && known.size === st.size) continue
    const from = known && st.size > known.size ? known.offset : 0
    const parts = rel.split(sep)
    const project = parts[0]
    const sid = parts[1].replace(/\.jsonl$/, '')
    try {
      const offset = await readNew(path, from, sid, project, state)
      cache.files[rel] = { size: st.size, offset }
      changed = true
    } catch {}
    settle(state, cache)
  }

  if (changed) {
    cache.seen += state.added.join('')
    const tmp = `${cachePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(cache))
    await rename(tmp, cachePath)
  }
}

function projectName(dir) {
  if (dir.includes('claude-mem-observer')) return 'claude-mem (background)'
  return dir.replace(/^[A-Za-z]--/, '') || 'other'
}

function summarize(cache) {
  const now = Date.now()
  const today = dayOf(now)
  const weekday = local(now).getUTCDay()
  const weekStart = dayOf(now - ((weekday + 6) % 7) * 86400000)
  const month = today.slice(0, 7)
  const year = today.slice(0, 4)
  const inPeriod = {
    today: d => d === today,
    week: d => d >= weekStart,
    month: d => d.startsWith(month),
    year: d => d.startsWith(year),
    all: () => true,
  }

  const periods = {}
  for (const [name, test] of Object.entries(inPeriod)) {
    const total = zero()
    const models = {}
    for (const [day, d] of Object.entries(cache.days)) {
      if (!test(day)) continue
      add(total, d, d.n)
      for (const [m, u] of Object.entries(d.models)) add((models[m] ??= zero()), u, u.n)
    }
    const session = zero()
    for (const [day, u] of Object.entries(cache.sessions[sessionId] ?? {})) {
      if (test(day)) add(session, u, u.n)
    }
    let sessions = 0
    for (const s of Object.values(cache.sessions)) {
      if (Object.keys(s).some(test)) sessions += 1
    }
    let activeDays = 0
    for (const day of Object.keys(cache.days)) if (test(day)) activeDays += 1
    const projects = {}
    for (const [project, byDay] of Object.entries(cache.projects ?? {})) {
      const name = projectName(project)
      for (const [day, n] of Object.entries(byDay)) {
        if (test(day)) projects[name] = (projects[name] ?? 0) + n
      }
    }
    const top = Object.entries(projects)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, tokens]) => ({ name, tokens }))
    periods[name] = { total, session, models, sessions, activeDays, projects: top }
  }

  const topSessions = Object.entries(cache.sessions)
    .map(([id, byDay]) => {
      const u = byDay[today]
      return { id: id.slice(0, 8), isThis: id === sessionId, project: projectName(cache.owners?.[id] ?? ''), tokens: u ? u.in + u.out + u.cr + u.cw : 0, replies: u?.n ?? 0 }
    })
    .filter(s => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6)

  // Weekday by hour, all time: when the tokens get spent. Sunday first.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0))
  for (const [day, d] of Object.entries(cache.days)) {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay()
    ;(d.hours ?? []).forEach((n, h) => (heat[wd][h] += n))
  }
  const hoursOf = key => cache.days[key]?.hours ?? new Array(24).fill(0)

  // Fair comparisons: each against the same point in the period before it.
  const totalOf = d => d.in + d.out + d.cr + d.cw
  const sumDays = test =>
    Object.entries(cache.days).reduce((sum, [day, d]) => (test(day) ? sum + totalOf(d) : sum), 0)
  const hourNow = local(now).getUTCHours()
  const daysIntoWeek = (weekday + 6) % 7
  const lastWeekStart = dayOf(now - (daysIntoWeek + 7) * 86400000)
  const lastWeekSamePoint = dayOf(now - 7 * 86400000)
  const lastMonthDate = new Date(Date.UTC(Number(year), Number(today.slice(5, 7)) - 2, 1))
  const lastMonth = lastMonthDate.toISOString().slice(0, 7)
  const dayOfMonth = today.slice(8, 10)
  const compare = {
    yesterdayByNow: hoursOf(dayOf(now - 86400000))
      .slice(0, hourNow + 1)
      .reduce((a, b) => a + b, 0),
    lastWeekByNow: sumDays(d => d >= lastWeekStart && d <= lastWeekSamePoint),
    lastMonthByNow: sumDays(d => d.startsWith(lastMonth) && d.slice(8, 10) <= dayOfMonth),
  }

  const plain = ([, d]) => ({ in: d.in, out: d.out, cr: d.cr, cw: d.cw, n: d.n })
  const sortedDays = Object.entries(cache.days).sort(([a], [b]) => (a < b ? -1 : 1))
  const days = sortedDays.slice(-31).map(e => ({ key: e[0], ...plain(e) }))
  const rollUp = len => {
    const out = {}
    for (const [day, d] of sortedDays) add((out[day.slice(0, len)] ??= zero()), d, d.n)
    return Object.entries(out).map(([key, u]) => ({ key, ...u }))
  }

  return {
    generatedAt: now,
    utcOffsetMs: -new Date(now).getTimezoneOffset() * 60000,
    firstDay: sortedDays[0]?.[0] ?? null,
    periods,
    days,
    hoursToday: hoursOf(today),
    hoursYesterday: hoursOf(dayOf(now - 86400000)),
    heat,
    topSessions,
    compare,
    months: rollUp(7).slice(-12),
    years: rollUp(4),
  }
}

async function takeLock() {
  try {
    await mkdir(lockPath)
    return true
  } catch {
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true })
        await mkdir(lockPath)
        return true
      }
    } catch {}
    return false
  }
}

await mkdir(cacheDir, { recursive: true })
const locked = await takeLock()
const cache = await loadCache()
try {
  // Another session holding the lock is mid-scan: answer from the last totals.
  if (locked) await scan(cache)
} finally {
  if (locked) await rm(lockPath, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(summarize(cache)))
