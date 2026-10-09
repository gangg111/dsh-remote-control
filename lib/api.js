/**
 * API dla apki na telefonie (ekran „Code”), obslugiwane przez brame za kontrola tozsamosci Tailscale:
 *   GET  /__remote/api/info        znacznik uslugi (service: 'dsh-remote-control', do wykrywania przez telefon) i nazwa komputera
 *   GET  /__remote/api/sessions    sesje (tytul, obszar, czas, praca/oczekiwanie, ostatnia wiadomosc)
 *   GET  /__remote/api/workspaces  obszary robocze do „Nowa sesja”
 *   POST /__remote/api/sessions    { workspaceId?, text? } -> { sessionId }
 * Przenoszenie sesji (capabilities: session-transfer, lib/transfer.js):
 *   GET    /__remote/api/outbox            sesje oznaczone na PC „Eksportuj na telefon”, czekajace na odbior
 *   GET    /__remote/api/outbox/:id        natywny eksport ZIP tej sesji (strumien z DSH)
 *   GET    /__remote/api/outbox/:id/files  pliki projektu zmienione przez agenta (ZIP: manifest + tree/), capabilities: workspace-files
 *   DELETE /__remote/api/outbox/:id        potwierdzenie udanego importu na telefonie
 *   POST   /__remote/api/sessions/import   cialo: natywny eksport ZIP -> { sessionId, title }
 * Uslugi DSH (sessionController, sessionQuery, workspaceRegistry) sa czytane przy kazdym zadaniu,
 * wiec przeladowanie wtyczek DSH nie zostawia nieaktualnych referencji.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { importSession, SESSION_FORMAT } from './transfer.js'
import { agentEditedPaths, packWorkspaceZip } from './workspace-files.js'

const MAX_BODY = 64 * 1024
/** Limit ciala importu: sesje z obrazkami maja dziesiatki MB. */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024
const PREVIEW_CHARS = 280
const EVENT_TYPES = ['user/message', 'assistant/message', 'approval/asked', 'approval/decided']

/**
 * @param {{
 *   get: (name: string) => any,
 *   log?: { warn: Function },
 *   outbox?: ReturnType<typeof import('./outbox.js').createOutbox>,
 *   dsh?: ReturnType<typeof import('./transfer.js').createDshClient>,
 *   emit?: (event: string, payload: unknown) => void,
 *   removeSession?: (id: string, cwd: string) => Promise<void>,
 *   dshVersion?: string,
 *   linkApi?: ReturnType<typeof import('./link-api.js').createLinkApi>,
 * }} deps - `get` zwraca usluge DSH albo undefined; reszta wlacza przenoszenie sesji.
 * @returns {(req, res, url: URL) => Promise<boolean>}
 */
export function createApi(deps) {
  const details = new Map() // sessionId -> { updatedAt, value }
  const transfer = Boolean(deps.outbox && deps.dsh)

  return async function api(req, res, url) {
    if (!url.pathname.startsWith('/__remote/api/')) return false
    const path = url.pathname.slice('/__remote/api'.length)
    const route = `${req.method} ${path}`
    try {
      if (route === 'GET /info') {
        return json(res, 200, {
          service: 'dsh-remote-control', api: 1, name: hostname(), platform: process.platform,
          capabilities: [...(transfer ? ['session-transfer', 'workspace-files'] : []), ...(deps.linkApi && deps.syncEnabled ? ['session-sync', 'workspace-files-return', 'workspace-files-pull'] : [])], sessionFormat: SESSION_FORMAT,
          ...(deps.dshVersion ? { dshVersion: deps.dshVersion } : {}),
        })
      }
      if (route === 'GET /sessions') return json(res, 200, { sessions: await listSessions(Number(url.searchParams.get('limit')) || 40) })
      if (route === 'GET /workspaces') return json(res, 200, { workspaces: listWorkspaces() })
      if (route === 'POST /sessions') return json(res, 200, await createSession(await readJson(req)))
      if (transfer) {
        if (route === 'GET /outbox') return json(res, 200, { items: deps.outbox.waiting() })
        const mf = /^\/outbox\/([0-9a-f-]{36})\/files$/.exec(path)
        if (mf && req.method === 'GET') return await sendWorkspaceFiles(res, mf[1])
        const m = /^\/outbox\/([0-9a-f-]{36})$/.exec(path)
        if (m && req.method === 'GET') return await sendExport(res, m[1])
        if (m && req.method === 'DELETE') {
          const item = deps.outbox.markReceived(m[1])
          return json(res, item ? 200 : 404, item ? { ok: true } : { error: 'nie ma takiego wpisu' })
        }
        if (route === 'POST /sessions/import') {
          const zip = await readBody(req, MAX_IMPORT_BYTES)
          const result = await importSession(deps.get, zip, {
            workspaceId: url.searchParams.get('workspaceId') || undefined,
            emit: deps.emit,
            removeSession: deps.removeSession,
            log: deps.log,
          })
          return json(res, 200, result)
        }
      }
      if (deps.linkApi && (await deps.linkApi.phone(req, res, path, url)) !== false) return true
      return json(res, 404, { error: 'nieznana sciezka' })
    } catch (error) {
      deps.log?.warn(`[dsh-remote-control] API ${route}: ${error?.stack ?? error}`)
      return json(res, error.status ?? 500, { error: String(error?.message ?? error) })
    }
  }

  /** Strumieniuje natywny eksport sesji z DSH; wpis zostaje w skrzynce do potwierdzenia importu. */
  async function sendExport(res, transferId) {
    const item = deps.outbox.get(transferId)
    if (!item || item.state !== 'waiting') return json(res, 404, { error: 'nie ma takiego wpisu' })
    const upstream = await deps.dsh.exportSession(item.sessionId)
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      return json(res, upstream.status === 404 ? 404 : 502, { error: `DSH nie wyeksportowal sesji (${upstream.status}) ${text.slice(0, 200)}`.trim() })
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'cache-control': 'no-store',
      'x-dsh-session-id': item.sessionId,
      ...(item.title ? { 'x-dsh-session-title': encodeURIComponent(item.title) } : {}),
    })
    Readable.fromWeb(upstream.body).pipe(res)
    return true
  }

  /**
   * Pliki projektu zmienione przez agenta w tej sesji, jako ZIP (manifest + tree/). Osobno od
   * eksportu sesji, zeby log i media zostaly strumieniowane. `cwd` i zdarzenia z observeSession.
   */
  async function sendWorkspaceFiles(res, transferId) {
    const item = deps.outbox.get(transferId)
    if (!item || item.state !== 'waiting') return json(res, 404, { error: 'nie ma takiego wpisu' })
    const query = need('sessionQuery')
    let observed
    try { observed = await query.observeSession(item.sessionId) } catch (error) {
      return json(res, 404, { error: `nie ma sesji ${item.sessionId} (${error?.message ?? error})` })
    }
    try {
      const root = observed.header?.cwd
      const hasRoot = typeof root === 'string' && Boolean(root)
      const paths = hasRoot ? agentEditedPaths(observed.events, root) : []
      const origin = { device: 'pc', root: hasRoot ? root : null, name: hasRoot ? basename(root) : 'projekt' }
      const { zip, manifest } = packWorkspaceZip({ root: hasRoot ? root : '/', scope: 'agent', paths, origin })
      // Baza do zwrotu: plik na PC o tej sumie nie byl zmieniany od wyslania.
      if (hasRoot) deps.fileBase?.merge(root, manifest.files)
      res.writeHead(200, {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'x-dsh-session-id': item.sessionId,
        'x-dsh-files': String(manifest.files.length),
        'x-dsh-files-skipped': String(manifest.skipped.length),
      })
      res.end(zip)
      return true
    } finally {
      observed?.[Symbol.dispose]?.()
    }
  }

  function need(name) {
    const service = deps.get(name)
    if (!service) throw Object.assign(new Error(`usluga DSH ${name} jest niedostepna`), { status: 503 })
    return service
  }

  async function listSessions(limit) {
    const controller = need('sessionController')
    const query = deps.get('sessionQuery')
    const registry = deps.get('workspaceRegistry')
    const { items } = await controller.list({}, AbortSignal.timeout(15000))
    // Zarchiwizowane DSH chowa z paska bocznego; telefon pokazuje to samo co PC.
    const archived = new Set(registry?.archivedSessionIds ?? [])
    // Podagenci maja `origin` (np. 'subagent'); rozgalezienia maja tylko `parentSessionId` i sa zwyklymi rozmowami.
    const top = items.filter((s) => !s.origin && !s.blank && !archived.has(s.sessionId)).slice(0, Math.min(limit, 100))
    return Promise.all(top.map(async (s) => {
      const extra = await sessionDetails(query, s)
      const workspace = s.cwd ? await workspaceName(registry, s.cwd) : null
      return {
        sessionId: s.sessionId,
        title: titleOf(s.projections?.values?.title) ?? extra.title ?? null,
        cwd: s.cwd ?? null,
        workspace,
        updatedAt: s.updatedAt,
        running: Boolean(s.running),
        waiting: extra.waiting,
        last: extra.last,
      }
    }))
  }

  async function sessionDetails(query, s) {
    const cached = details.get(s.sessionId)
    if (cached && cached.updatedAt === s.updatedAt) return cached.value
    const value = { title: null, waiting: false, last: null }
    if (query) {
      try {
        const events = await query.filterEvents(s.sessionId, [{ kind: 'type', values: EVENT_TYPES }])
        let asked = 0
        let decided = 0
        for (const e of events) {
          if (e.type === 'approval/asked') asked++
          else if (e.type === 'approval/decided') decided++
          else if (e.text) value.last = { role: e.type === 'user/message' ? 'user' : 'assistant', text: preview(e.text) }
        }
        value.waiting = asked > decided
        if (!titleOf(s.projections?.values?.title)) value.title = titleOf((await query.readTitle(s.sessionId).catch(() => undefined)))
      } catch (error) {
        deps.log?.warn(`[dsh-remote-control] szczegoly sesji ${s.sessionId}: ${error?.message ?? error}`)
      }
    }
    details.set(s.sessionId, { updatedAt: s.updatedAt, value })
    return value
  }

  function listWorkspaces() {
    const registry = need('workspaceRegistry')
    return registry.list().map((w) => {
      const path = firstString(w.path, w.cwd, w.root, w.directory)
      return { id: w.id, name: firstString(w.name, w.label, w.title) ?? (path ? basename(path) : String(w.id)), path }
    })
  }

  async function createSession(body) {
    const controller = need('sessionController')
    const request = {}
    if (typeof body.workspaceId === 'string' && body.workspaceId) request.workspaceId = body.workspaceId
    const { sessionId } = await controller.create(request)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text) {
      await controller.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(30000))
    }
    return { sessionId }
  }
}

async function workspaceName(registry, cwd) {
  try {
    const w = registry ? await registry.resolveByPath(cwd) : undefined
    return firstString(w?.name, w?.label, w?.title) ?? basename(cwd)
  } catch {
    return basename(cwd)
  }
}

/** Tytul bywa napisem albo migawka z polem tekstu; zwraca napis albo null. */
function titleOf(t) {
  if (typeof t === 'string') return t || null
  if (t && typeof t === 'object') return firstString(t.text, t.title, t.value) ?? null
  return null
}

function firstString(...values) {
  return values.find((v) => typeof v === 'string' && v.length > 0)
}

/** Podglad na liscie: zwykly tekst bez skladni Markdown (pelna tresc zostaje w sesji). */
function preview(text) {
  const flat = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '|')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s·)+\s*$/, '')
    .replace(/(\s·)+/g, ' ·')
    .trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

/** Cale cialo zadania jako Buffer, z limitem (413 po przekroczeniu). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'])
    if (declared > limit) return reject(Object.assign(new Error(`za duza sesja (limit ${Math.round(limit / 1048576)} MB)`), { status: 413 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error(`za duza sesja (limit ${Math.round(limit / 1048576)} MB)`), { status: 413 })); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('za duza tresc zadania'), { status: 413 })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(Object.assign(new Error('tresc nie jest JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}
