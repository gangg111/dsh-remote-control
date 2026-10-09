/**
 * Pliki projektu przenoszone razem z sesja (PC <-> telefon), wspolne dla obu stron.
 *
 * Eksport sesji dowozi log i media; ten modul dokłada pliki z katalogu projektu, zeby agent po
 * drugiej stronie pracowal dalej na tych samych plikach. Faza 1: `scope: 'agent'` (tylko pliki,
 * ktore agent zmienil narzedziami `edit`/`write`/`apply_patch`) oraz zastosowanie ich po imporcie.
 *
 * Pliki ida w osobnym ZIP-ie (`manifest.json` + `tree/<sciezka wzgledna>`), nie w ZIP-ie sesji:
 * eksport sesji zostaje strumieniowany bez buforowania mediow, a pliki pobiera sie dopiero, gdy
 * druga strona oglasza zdolnosc `workspace-files`.
 *
 * Czysty Node (`fs`, `crypto`); zadnej zaleznosci od DSH. Telefon trzyma kopie w `lib/vendor/`.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readZip } from './zip.js'
import { writeZip } from './zipwrite.js'

export const MANIFEST = 'manifest.json'
const TREE = 'tree/'

/** Katalogi pomijane w obie strony (wyniki budowania, zaleznosci, cache). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'build', 'dist', 'out', 'target', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.cache', '.tox', '.mypy_cache', '.pytest_cache'])
/** Rozszerzenia bezuzyteczne po drugiej stronie albo wrazliwe (klucze, certyfikaty, sekrety). */
const SKIP_EXT_BINARY = new Set(['.exe', '.dll', '.so', '.dylib'])
const SKIP_EXT_SECRET = new Set(['.pfx', '.p12', '.key', '.pem', '.env', '.keystore', '.jks', '.crt', '.cer'])
/** Nazwy plikow traktowane jako sekret niezaleznie od rozszerzenia. */
const SKIP_NAME = new Set(['.env', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc'])

export const DEFAULT_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, fileCount: 2000 })

/** Blad z kodem HTTP, zgodny z reszta wtyczki. */
export class WorkspaceFilesError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const toSlash = (p) => p.replaceAll('\\', '/')
const lowerDrive = (p) => p.replace(/^([a-zA-Z]):/, (_, d) => `${d.toLowerCase()}:`)

/** Czy `child` lezy w `root` (porownanie po ukosnikach, z tolerancja wielkosci litery dysku). */
function withinRoot(root, child) {
  const r = lowerDrive(toSlash(root)).replace(/\/+$/, '') + '/'
  const c = lowerDrive(toSlash(child))
  return c === r.slice(0, -1) || c.startsWith(r)
}

/** Sciezka wzgledna `child` do `root`, zawsze z ukosnikami `/`; undefined, gdy poza `root`. */
function relTo(root, child) {
  if (!withinRoot(root, child)) return undefined
  const r = lowerDrive(toSlash(root)).replace(/\/+$/, '')
  const c = toSlash(child)
  const rel = c.slice(r.length).replace(/^\/+/, '')
  return rel.length ? rel : undefined
}

const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * Sprawdza sciezke wzgledna przed zapisem; zwraca znormalizowane segmenty albo null.
 * Odrzuca sciezki absolutne, `..`, litery dyskow, znak zero, a dla Windows nazwy zarezerwowane,
 * dwukropek i koncowe kropki lub spacje w segmencie.
 */
export function safeRelSegments(rel, platform = process.platform) {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const s = toSlash(rel)
  if (s.includes('\0') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const segs = s.split('/').filter((x) => x.length)
  if (segs.length === 0) return null
  const win = platform === 'win32'
  for (const seg of segs) {
    if (seg === '.' || seg === '..') return null
    if (win && (reserved.test(seg) || seg.includes(':') || /[ .]$/.test(seg))) return null
  }
  return segs
}

function excluded(rel) {
  const segs = rel.split('/')
  if (segs.some((s) => SKIP_DIRS.has(s))) return 'build-or-dep'
  const name = segs.at(-1)
  if (SKIP_NAME.has(name)) return 'secret'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  if (SKIP_EXT_BINARY.has(ext)) return 'binary'
  if (SKIP_EXT_SECRET.has(ext)) return 'secret'
  return null
}

/**
 * Sciezki plikow, ktore agent zmienil narzedziami, wewnatrz `root` i wciaz istniejace.
 * @param {ReadonlyArray<{type: string, data?: any}>} events - zdarzenia sesji (z observeSession).
 * @param {string} root - absolutna sciezka projektu (platforma zrodla).
 * @returns {string[]} sciezki absolutne (platforma zrodla), bez duplikatow.
 */
export function agentEditedPaths(events, root) {
  const out = new Set()
  const addPatch = (patch) => {
    for (const line of String(patch).split('\n')) {
      const m = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line.trim())
      if (m) out.add(m[1].trim())
    }
  }
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    let args
    try { args = JSON.parse(e.data.arguments) } catch { continue }
    if ((e.data.name === 'edit' || e.data.name === 'write') && typeof args.file_path === 'string') out.add(args.file_path)
    else if (e.data.name === 'apply_patch' && typeof args.patch === 'string') addPatch(args.patch)
  }
  const resolved = new Set()
  for (const p of out) {
    const abs = toSlash(p)
    const full = /^([a-zA-Z]:|\/)/.test(abs) ? p : join(root, p)
    if (relTo(root, full) && existsSync(full) && statSync(full).isFile()) resolved.add(full)
  }
  return [...resolved]
}

/** Przechodzi katalog, zwraca absolutne sciezki plikow z pominieciem SKIP_DIRS. */
function walk(root) {
  const files = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) stack.push(full) }
      else if (ent.isFile()) files.push(full)
    }
  }
  return files
}

/**
 * Zbiera pliki do przeniesienia i buduje manifest.
 * @param {{ root: string, paths?: string[], scope: 'agent'|'project', origin: object, limits?: object, returnTo?: object, deleted?: string[] }} opts
 *   `deleted`: sciezki wzgledne usuniete u nadawcy (tylko informacja dla odbiorcy).
 *   `paths` wymagane dla `scope:'agent'`; dla `scope:'project'` przechodzimy caly `root`.
 * @returns {{ entries: Array<[string, Buffer|string]>, manifest: object }}
 */
export function collectFiles(opts) {
  const { root, scope, origin, returnTo, deleted } = opts
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
  const abs = scope === 'project' ? walk(root) : (opts.paths ?? [])
  const files = []
  const skipped = []
  let total = 0
  for (const full of abs) {
    const rel = relTo(root, full)
    if (!rel) { skipped.push({ path: toSlash(full), reason: 'outside-root' }); continue }
    const why = excluded(rel)
    if (why) { skipped.push({ path: rel, reason: why }); continue }
    let buf
    try { buf = readFileSync(full) } catch { skipped.push({ path: rel, reason: 'unreadable' }); continue }
    if (buf.length > limits.fileBytes) { skipped.push({ path: rel, reason: 'too-large' }); continue }
    if (files.length >= limits.fileCount) { skipped.push({ path: rel, reason: 'file-count-limit' }); continue }
    if (total + buf.length > limits.totalBytes) { skipped.push({ path: rel, reason: 'total-size-limit' }); continue }
    total += buf.length
    // Windows nie zglasza bitu wykonywania dla skryptow, wiec liczy sie tez linia `#!`.
    let exec = buf.length > 1 && buf[0] === 0x23 && buf[1] === 0x21
    if (!exec && process.platform !== 'win32') {
      try { exec = (statSync(full).mode & 0o111) !== 0 } catch { /* tryb nieznany: exec=false */ }
    }
    files.push({ rel, buf, entry: { path: rel, sha256: sha256(buf), size: buf.length, ...(exec ? { exec: true } : {}) } })
  }
  const manifest = {
    version: 1,
    origin,
    scope,
    files: files.map((f) => f.entry),
    skipped,
    ...(deleted?.length ? { deleted: [...deleted] } : {}),
    ...(returnTo ? { returnTo } : {}),
  }
  const entries = [[MANIFEST, Buffer.from(JSON.stringify(manifest))], ...files.map((f) => [TREE + f.rel, f.buf])]
  return { entries, manifest }
}

/** Buduje ZIP plikow projektu (manifest + tree/) z wyniku collectFiles. */
export function packWorkspaceZip(opts) {
  const { entries, manifest } = collectFiles(opts)
  return { zip: writeZip(entries), manifest }
}

/** Czyta ZIP plikow projektu: manifest + mapa sciezka wzgledna -> Buffer. */
export function readWorkspaceZip(zip) {
  let entries
  try { entries = readZip(zip) } catch (error) { throw new WorkspaceFilesError(400, `Niepoprawny ZIP plikow: ${error?.message ?? error}`) }
  const manifestBuf = entries.get(MANIFEST)
  if (!manifestBuf) throw new WorkspaceFilesError(400, 'ZIP plikow nie zawiera manifest.json.')
  let manifest
  try { manifest = JSON.parse(manifestBuf.toString('utf8')) } catch { throw new WorkspaceFilesError(400, 'manifest.json nie jest poprawnym JSON.') }
  const tree = new Map()
  for (const [name, buf] of entries) {
    if (name === MANIFEST || !name.startsWith(TREE)) continue
    tree.set(name.slice(TREE.length), buf)
  }
  return { manifest, tree }
}

/**
 * Czy na drodze od `root` do pliku (katalogi posrednie albo sam plik) jest dowiazanie symboliczne.
 * Sam `root` moze nim byc (to wybor wlasciciela); zapis za dowiazaniem moglby wyjsc poza `root`.
 */
function linkOnPath(root, segs) {
  let p = root
  for (const seg of segs) {
    p = join(p, seg)
    let st
    try { st = lstatSync(p) } catch { return false }
    if (st.isSymbolicLink()) return true
  }
  return false
}

/**
 * Zapisuje pliki projektu do katalogu `root`. Zapis atomowy (plik tymczasowy + rename).
 * Istniejacy plik o innej tresci: stara wersja obok jako kopia, nic nie znika. Wyjatek: gdy jego
 * suma rowna sie sumie z `base` (stan z ostatniego przeniesienia), nikt go od tego czasu nie
 * zmienil, wiec jest nadpisywany bez kopii.
 * @param {{ root: string, zip: Buffer, platform?: string, stamp?: () => string, base?: Record<string, string> }} opts
 *   `base`: sciezka wzgledna -> sha256 z ostatniego przeniesienia w ktoras strone.
 * @returns {{ written: string[], created: string[], conflicts: Array<{path: string, keptAs: string}>, skipped: Array<{path: string, reason: string}>, deletedRemote: string[] }}
 */
export function applyWorkspaceZip(opts) {
  const { root, zip } = opts
  const platform = opts.platform ?? process.platform
  const stamp = opts.stamp ?? (() => new Date().toISOString().replace(/[:.]/g, '-'))
  const { manifest, tree } = readWorkspaceZip(zip)
  const report = { written: [], created: [], conflicts: [], skipped: [...(manifest.skipped ?? [])], deletedRemote: [...(manifest.deleted ?? [])] }
  const byPath = new Map((manifest.files ?? []).map((f) => [f.path, f]))
  for (const [rel, buf] of tree) {
    const segs = safeRelSegments(rel, platform)
    if (!segs) { report.skipped.push({ path: rel, reason: 'unsafe-path' }); continue }
    const declared = byPath.get(rel)
    if (!declared) { report.skipped.push({ path: rel, reason: 'undeclared' }); continue }
    if (sha256(buf) !== declared.sha256) { report.skipped.push({ path: rel, reason: 'sha-mismatch' }); continue }
    if (linkOnPath(root, segs)) { report.skipped.push({ path: rel, reason: 'symlink-in-path' }); continue }
    const full = join(root, ...segs)
    const exists = existsSync(full)
    let replace = false
    if (exists) {
      const current = sha256(readFileSync(full))
      if (current === declared.sha256) { report.written.push(rel); continue }
      // Plik niezmieniony od ostatniego przeniesienia (suma z bazy) jest nadpisywany bez kopii.
      replace = opts.base?.[rel] === current
    }
    if (exists && !replace) {
      const keptAs = `${full}.przed-importem-${stamp()}`
      renameSync(full, keptAs)
      report.conflicts.push({ path: rel, keptAs })
    }
    mkdirSync(dirname(full), { recursive: true })
    const tmp = `${full}.dsh-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, buf)
    // Bit wykonywania tylko poza Windows (tam o uruchamianiu decyduje rozszerzenie).
    if (declared.exec && platform !== 'win32') chmodSync(tmp, statSync(tmp).mode | 0o111)
    renameSync(tmp, full)
    // Kazdy plik w jednej grupie: konflikt jest juz w `conflicts`.
    if (!exists) report.created.push(rel)
    else if (replace) report.written.push(rel)
  }
  return { manifest, report }
}

/**
 * Pliki do wyslania z katalogu, w ktorym obok przeniesionych lezy reszta projektu (PC): kandydaci to
 * pliki z bazy oraz `extraPaths` (np. zmienione narzedziami agenta), nie caly katalog. Zwraca te,
 * ktorych suma rozni sie od bazy albo ktorych w bazie nie ma, oraz pliki z bazy, ktorych juz nie ma.
 * @param {string} root
 * @param {Record<string, string>} base - sciezka wzgledna -> sha256.
 * @param {string[]} extraPaths - sciezki absolutne.
 * @returns {{ paths: string[], deleted: string[] }}
 */
export function changedSinceBase(root, base, extraPaths = []) {
  const candidates = new Map()
  for (const rel of Object.keys(base ?? {})) {
    const segs = safeRelSegments(rel)
    if (segs) candidates.set(rel, join(root, ...segs))
  }
  for (const full of extraPaths) {
    const rel = relTo(root, full)
    if (rel) candidates.set(rel, full)
  }
  const paths = []
  const deleted = []
  for (const [rel, full] of candidates) {
    let buf
    try { buf = readFileSync(full) } catch {
      if (base?.[rel]) deleted.push(rel)
      continue
    }
    if (base?.[rel] !== sha256(buf)) paths.push(full)
  }
  return { paths, deleted }
}

/**
 * Pliki nowe i zmienione w `root` wzgledem manifestu `base`, plus lista usunietych.
 * Uzywane przy odsylaniu (faza 2); w fazie 1 juz dostepne dla telefonu.
 * @returns {{ paths: string[], deleted: string[] }}
 */
export function diffAgainstBase(root, base) {
  const baseByPath = new Map((base?.files ?? []).map((f) => [f.path, f]))
  const seen = new Set()
  const paths = []
  for (const full of walk(root)) {
    const rel = relTo(root, full)
    if (!rel || excluded(rel)) continue
    seen.add(rel)
    const prev = baseByPath.get(rel)
    if (!prev) { paths.push(full); continue }
    let buf
    try { buf = readFileSync(full) } catch { continue }
    if (sha256(buf) !== prev.sha256) paths.push(full)
  }
  const deleted = [...baseByPath.keys()].filter((p) => !seen.has(p))
  return { paths, deleted }
}
