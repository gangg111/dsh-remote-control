/**
 * Przenoszenie sesji miedzy instalacjami DSH (telefon <-> komputer) na natywnym eksporcie DSH.
 *
 * Eksport: oficjalna trasa `GET /api/session.export?sessionId=&includeDescendants=true` (ZIP:
 * `session.v4.jsonl`, `subagents/<id>/session.v4.jsonl`, `media/<attachmentId>.<ext>`,
 * `files/<sha2>/<sha>/<nazwa>`).
 *
 * Import: DSH nie ma importu, wiec sesja powstaje tak, jak wyglada kazda sesja po restarcie:
 * `sessionPersistence.create(header)` + `append(zdarzenia)` z nowym id, potem kontrolny odczyt
 * (`sessionQuery.observeSession`, ktory waliduje typy zdarzen), przypiecie do obszaru roboczego
 * i `api-session/added`, zeby lista klienta pokazala ja od razu. Niedomknieta ostatnia ture DSH
 * domyka sam przy wznowieniu. Zalaczniki sa zapisywane ponownie przez `ctx.attachments`, a ich
 * opisy w zdarzeniach podmieniane na nowe (identyfikator obrazu moze sie zmienic po normalizacji).
 * Logi podagentow nie sa przenoszone (wyniki podagentow sa w logu glownym jako wyniki narzedzi).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readZip, ZipError } from './zip.js'

export const SESSION_FORMAT = 4
const ROOT_LOG = `session.v${SESSION_FORMAT}.jsonl`
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** Blad z kodem HTTP dla odpowiedzi API. */
export class TransferError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Rozbiera natywny eksport: naglowek i zdarzenia logu glownego plus zalaczniki.
 * @param {Buffer} zip
 */
export function parseExport(zip) {
  let entries
  try { entries = readZip(zip) } catch (error) {
    throw new TransferError(400, error instanceof ZipError ? `Niepoprawny eksport sesji: ${error.message}` : String(error))
  }
  const root = entries.get(ROOT_LOG)
  if (!root) {
    const other = [...entries.keys()].find((k) => /^session\.v\d+\.jsonl$/.test(k))
    if (other) throw new TransferError(422, `Sesja jest w formacie ${other.match(/v(\d+)/)[1]}, a ten DSH obsluguje format ${SESSION_FORMAT}. Zaktualizuj DSH po obu stronach do tej samej wersji.`)
    throw new TransferError(400, 'Eksport nie zawiera logu sesji.')
  }
  const lines = root.toString('utf8').split('\n').filter((l) => l.trim())
  let header
  const events = []
  try {
    header = JSON.parse(lines[0])
    for (const line of lines.slice(1)) events.push(JSON.parse(line))
  } catch {
    throw new TransferError(400, 'Log sesji nie jest poprawnym JSONL.')
  }
  if (header?.type !== 'session') throw new TransferError(400, 'Log sesji nie zaczyna sie od naglowka.')
  if (header.version !== SESSION_FORMAT) throw new TransferError(422, `Sesja jest w formacie ${header.version}, a ten DSH obsluguje format ${SESSION_FORMAT}. Zaktualizuj DSH.`)
  events.forEach((e, i) => {
    if (e?.seq !== i || typeof e.type !== 'string') throw new TransferError(400, `Zdarzenie ${i} ma niepoprawny numer kolejny.`)
  })
  const { images, files } = readMedia(entries)
  return { header, events, images, files, subagents: [...entries.keys()].filter((k) => k.startsWith('subagents/')).length }
}

/**
 * Obrazy i pliki z archiwum w ukladzie natywnego eksportu DSH.
 * @param {Map<string, Buffer>} entries - wynik readZip.
 */
export function readMedia(entries) {
  const images = new Map()
  const files = new Map()
  for (const [name, data] of entries) {
    let m
    if ((m = /^media\/(.+)\.([a-z]+)$/.exec(name)) && IMAGE_TYPES[m[2]]) images.set(m[1], { data, mediaType: IMAGE_TYPES[m[2]] })
    else if ((m = /^files\/[0-9a-f]{2}\/([0-9a-f]{64})\/(.+)$/.exec(name))) files.set(`sha256:${m[1]}`, { data, name: m[2] })
  }
  return { images, files }
}

/** Nazwa wpisu ZIP dla obrazu albo pliku w ukladzie eksportu DSH. */
export function mediaEntryName(ref) {
  if (typeof ref.mediaType === 'string' && ref.mediaType.startsWith('image/')) {
    const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === ref.mediaType)?.[0] ?? 'png'
    return `media/${ref.attachmentId}.${ext}`
  }
  const sha = String(ref.attachmentId).replace(/^sha256:/, '')
  return `files/${sha.slice(0, 2)}/${sha}/${ref.name ?? 'plik'}`
}

/** Zapisuje zalaczniki ponownie; zwraca mape stary attachmentId -> nowy opis. */
export async function saveAttachments(attachments, images, files) {
  const map = new Map()
  if (!attachments) {
    if (images.size + files.size > 0) throw new TransferError(503, 'Usluga zalacznikow DSH jest niedostepna.')
    return map
  }
  for (const [id, img] of images) map.set(id, await attachments.saveImage({ data: new Uint8Array(img.data), mediaType: img.mediaType }))
  for (const [id, file] of files) {
    try { map.set(id, await attachments.saveFile({ data: new Uint8Array(file.data), name: file.name })) } catch (error) {
      throw new TransferError(422, `Ten DSH nie przyjmuje zalacznikow plikowych (${file.name}): ${error?.message ?? error}`)
    }
  }
  return map
}

/** Podmienia opisy zalacznikow `{attachmentId, ...}` w zdarzeniach (kopia gleboka). */
export function remapAttachments(value, map) {
  if (map.size === 0) return value
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      if (typeof v.attachmentId === 'string' && map.has(v.attachmentId)) {
        const ref = map.get(v.attachmentId)
        return { ...v, ...ref, ...(v.name !== undefined && ref.name === undefined ? { name: v.name } : {}) }
      }
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x)
      return out
    }
    return v
  }
  return walk(value)
}

/**
 * Znacznik wyslania logu do DeepSeek (`session-log-deepseek/delivery-accepted`) musi nazywac sesje,
 * w ktorej lezy (DSH odrzuca log z obcym `sessionId`). Rozgalezienie dziedziczy znaczniki rodzica,
 * a import tworzy sesje bez rodzica, wiec KAZDY znacznik wskazuje po imporcie nowa sesje (juz
 * wyslane zdarzenia nie sa wysylane ponownie).
 */
export function rebindDeliveryMarker(event, _fromId, toId) {
  if (event.type !== 'session-log-deepseek/delivery-accepted' || typeof event.data?.sessionId !== 'string') return event
  return { ...event, data: { ...event.data, sessionId: toId } }
}

/** Obszar roboczy docelowy: wskazany albo domyslny (sciezka z `default-workspace`), inaczej pierwszy. */
function pickWorkspace(registry, workspaceId) {
  const list = registry.list()
  if (workspaceId) {
    const w = list.find((x) => x.id === workspaceId)
    if (!w) throw new TransferError(404, `Nie ma obszaru roboczego ${workspaceId}.`)
    return w
  }
  const pathOf = (w) => w.path ?? w.cwd ?? w.root ?? ''
  return list.find((w) => /default-workspace/i.test(pathOf(w))) ?? list[0]
}

/**
 * Importuje natywny eksport jako NOWA sesje.
 * @param {(name: string) => any} get - `ctx.get` hosta DSH.
 * @param {Buffer} zip
 * @param {{ workspaceId?: string, device?: string, emit?: (event: string, payload: unknown) => void, removeSession?: (id: string, cwd: string) => Promise<void> }} [options]
 * @returns {Promise<{ sessionId: string, title: string | null, events: number, attachments: number, skippedSubagents: number }>}
 */
export async function importSession(get, zip, options = {}) {
  const parsed = parseExport(zip)
  const persistence = get('sessionPersistence')
  const registry = get('workspaceRegistry')
  const query = get('sessionQuery')
  if (!persistence || !registry) throw new TransferError(503, 'Uslugi sesji DSH sa niedostepne.')
  const workspace = pickWorkspace(registry, options.workspaceId)
  if (!workspace) throw new TransferError(409, 'Na tym urzadzeniu nie ma zadnego obszaru roboczego.')
  const cwd = workspace.path ?? workspace.cwd ?? workspace.root
  const map = await saveAttachments(get('attachments'), parsed.images, parsed.files)
  const id = `session-${randomUUID()}`
  const events = parsed.events.map((e) => rebindDeliveryMarker(remapAttachments(e, map), parsed.header.id, id))
  // Rozgalezienie ma w logu znacznik `session/end-seed {inherited:true}` na koncu odziedziczonej czesci,
  // a DSH nie przyjmuje go w sesji nierozgalezionej: importujemy je jako rozgalezienie (bez rodzica,
  // ktorego tu nie ma) z ta sama liczba odziedziczonych zdarzen.
  const seedIndex = events.findIndex((e) => e.type === 'session/end-seed' && e.data?.inherited === true)
  const header = {
    version: SESSION_FORMAT,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: seedIndex >= 0,
    delegationDepth: 0,
    ...(typeof parsed.header.agentPreset === 'string' ? { agentPreset: parsed.header.agentPreset } : {}),
  }
  const handle = await persistence.create(header, seedIndex >= 0 ? { inheritedEventCount: seedIndex } : undefined)
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  // Typy zdarzen DSH sprawdza dopiero przy odczycie: niech odczyt rozstrzygnie teraz, nie przy otwarciu w UI.
  let title = null
  if (query) {
    try {
      const observed = await query.observeSession(id)
      try { title = titleOf(await query.readTitle?.(id)) } catch { title = null }
      observed?.[Symbol.dispose]?.()
    } catch (error) {
      await options.removeSession?.(id, cwd).catch(() => {})
      throw new TransferError(422, `DSH nie przyjal tej sesji (${error?.message ?? error}). Wersje DSH po obu stronach sa pewnie rozne.`)
    }
  }
  const ws = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : undefined
  await (ws ?? workspace).attachSession?.(id)
  options.emit?.('api-session/added', { sessionId: id, updatedAt: Date.now(), agentAvailable: false, running: false, blank: false, cwd })
  // Lista bierze tytul nieotwieranej sesji z cache projekcji, ktory powstaje dopiero dla sesji aktywnej.
  // Oficjalna zmiana nazwy najpierw wznawia sesje (projekcje sa liczone), potem utrwala tytul.
  const controller = get('sessionController')
  if (title && typeof controller?.rename === 'function') {
    try { await controller.rename({ sessionId: id, title }) } catch (error) { options.log?.warn?.(`[dsh-remote-control] tytul importu: ${error?.message ?? error}`) }
  }
  return { sessionId: id, title, events: events.length, attachments: map.size, skippedSubagents: parsed.subagents }
}

function titleOf(t) {
  if (typeof t === 'string') return t || null
  if (t && typeof t === 'object') return [t.text, t.title, t.value].find((x) => typeof x === 'string' && x) ?? null
  return null
}

/**
 * Klient trasy eksportu DSH po petli zwrotnej: wymienia token startowy na ciasteczko sesji
 * (jak brama dla telefonu), trzyma je w pamieci i loguje ponownie po 401.
 * @param {{ port: () => number, authenticatedUrl: () => string }} opts
 */
export function createDshClient(opts) {
  let cookie = null
  const base = () => `http://127.0.0.1:${opts.port()}`
  async function login() {
    const launch = new URL(opts.authenticatedUrl())
    const res = await fetch(base() + launch.pathname + launch.search, { redirect: 'manual' })
    const set = res.headers.getSetCookie().filter((c) => c.startsWith('dsh-auth-'))
    if (set.length === 0) throw new TransferError(502, `DSH nie wydal sesji (status ${res.status}).`)
    cookie = set.map((c) => c.split(';')[0]).join('; ')
  }
  async function get(path) {
    if (!cookie) await login()
    let res = await fetch(base() + path, { headers: { cookie } })
    if (res.status === 401) { await login(); res = await fetch(base() + path, { headers: { cookie } }) }
    return res
  }
  return {
    /** @returns {Promise<Response>} odpowiedz z ZIP-em eksportu (sprawdz `ok`). */
    exportSession(sessionId) {
      return get(`/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`)
    },
  }
}

/** Do testow: wczytanie eksportu z pliku. */
export function readExportFile(path) {
  return parseExport(readFileSync(path))
}
