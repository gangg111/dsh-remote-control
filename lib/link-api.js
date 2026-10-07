/**
 * Trasy synchronizacji powiazanych sesji (`capabilities: session-sync`), dla telefonu-kuriera przez
 * brame i dla interfejsu PC przez serwer DSH. Stan: lib/links.js; mechanika ogonow: lib/sync.js.
 *
 * Telefon (brama, /__remote/api):
 *   GET    /links                                stan powiazan + stan sesji PC (pcLastSeq, pcBoundary, pcBusy)
 *   POST   /links                                { pcSessionId, phoneSessionId, owner, sharedCount, title? }
 *   GET    /links/:id/events?after=&epoch=       ogon PC (ZIP), gdy wlascicielem jest PC
 *   POST   /links/:id/applied                    { epoch, ownerTo, mirrorLast, pairs, error? } po dopisaniu ogona PC na telefonie
 *   POST   /links/:id/events?after=&to=&epoch=   cialo: ogon telefonu (ZIP) -> dopisanie do lustra na PC
 *   POST   /links/:id/claim                      { epoch, phoneLast } telefon przejmuje pisanie
 *   POST   /links/:id/claim-confirm              { epoch, phoneBoundary, phoneBusy } telefon oddaje pisanie na prosbe PC
 *   POST   /links/:id/resume                     zdjecie wstrzymania (po wyrownaniu licznika tur agenta PC)
 *   DELETE /links/:id                            odlaczenie
 * Interfejs PC (serwer DSH, /api/dsh-remote-control):
 *   GET /links, POST /links/:id/claim (prosba), POST /links/:id/force (bez telefonu), POST /links/:id/resume, DELETE /links/:id
 */

import { appendTail, readTail, reloadSession, SeqMap, sessionState } from './sync.js'

const MAX_TAIL_BYTES = 256 * 1024 * 1024

/**
 * @param {{ get: (name: string) => any, links: ReturnType<typeof import('./links.js').createLinks>, log?: { warn: Function }, enabled?: boolean, disabledReason?: string }} deps
 *   `enabled` (domyslnie false) wlacza trasy zmieniajace stan; `disabledReason` to komunikat 503, gdy wylaczone.
 */
export function createLinkApi(deps) {
  const { get, links } = deps

  async function withPcState(link) {
    try {
      const s = await sessionState(get, link.pcSessionId)
      return { ...link, pcLastSeq: s.lastSeq, pcBoundary: s.boundary ?? null, pcBusy: s.busy }
    } catch (error) {
      return { ...link, pcMissing: true, pcError: String(error?.message ?? error) }
    }
  }

  /** reloadSession sesji PC; blad zwracany jako `{ error }` zamiast wyjatku. */
  function tryReload(link) {
    try { return reloadSession(get, link.pcSessionId) } catch (error) {
      return { error: `Licznik tur agenta PC: ${error?.message ?? error}` }
    }
  }

  /** Zdejmuje wstrzymanie, gdy agent PC da sie wyrownac do logu. */
  function resumeLink(link) {
    const reload = tryReload(link)
    if (reload.error) throw Object.assign(new Error(reload.error), { status: 409 })
    return { ...links.resume(link.linkId), reload }
  }

  /** Trasy telefonu; `path` bez prefiksu /__remote/api. Zwraca false, gdy sciezka nie nalezy do synchronizacji. */
  async function phone(req, res, path, url) {
    // Wylaczona, gdy wersja DSH nie przeszla testu przejecia (reloadSession i bramka tury opieraja sie
    // na wnetrzu agenta DSH); wtedy trasy zmieniajace stan odmawiaja, a odczyt i rozlaczenie dzialaja.
    if (!deps.enabled && path.startsWith('/links') && req.method !== 'GET' && req.method !== 'DELETE') {
      return json(res, 503, { error: deps.disabledReason ?? 'Synchronizacja sesji jest wylaczona.' })
    }
    if (path === '/links' && req.method === 'GET') return json(res, 200, { links: await Promise.all(links.list().map(withPcState)) })
    if (path === '/links' && req.method === 'POST') return json(res, 200, links.create(await readJson(req)))
    const m = /^\/links\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(path)
    if (!m) return false
    const [, id, action = ''] = m
    const link = links.get(id)
    if (!link) return json(res, 404, { error: 'Nie ma takiego powiazania.' })
    const epoch = url.searchParams.get('epoch')

    if (action === '' && req.method === 'DELETE') return json(res, 200, { removed: links.remove(id) })
    if (action === '/resume' && req.method === 'POST') return json(res, 200, resumeLink(link))
    if (link.paused) return json(res, 409, { error: `Powiazanie wstrzymane: ${link.paused.message}`, paused: link.paused })

    if (action === '/events' && req.method === 'GET') {
      if (link.owner !== 'pc') return json(res, 409, { error: 'Wlascicielem jest telefon.' })
      if (epoch !== null && Number(epoch) !== link.epoch) return json(res, 409, { error: 'Stan powiazania sie zmienil.', epoch: link.epoch })
      const after = Number(url.searchParams.get('after') ?? link.pcMark)
      const tail = await readTail(get, link.pcSessionId, after)
      res.writeHead(200, {
        'content-type': 'application/zip', 'cache-control': 'no-store',
        'x-dsh-from': String(tail.fromSeq), 'x-dsh-to': String(tail.toSeq), 'x-dsh-last': String(tail.lastSeq),
        'x-dsh-busy': String(tail.busy), 'x-dsh-count': String(tail.count), 'x-dsh-epoch': String(link.epoch),
      })
      res.end(tail.zip)
      return true
    }

    if (action === '/applied' && req.method === 'POST') {
      const body = await readJson(req)
      return json(res, 200, links.recordApplied(id, { ...body, from: 'pc' }))
    }

    if (action === '/events' && req.method === 'POST') {
      if (link.owner !== 'phone') return json(res, 409, { error: 'Wlascicielem jest PC.' })
      if (epoch !== null && Number(epoch) !== link.epoch) return json(res, 409, { error: 'Stan powiazania sie zmienil.', epoch: link.epoch })
      const after = Number(url.searchParams.get('after'))
      const to = Number(url.searchParams.get('to'))
      if (after !== link.phoneMark) return json(res, 409, { error: `Ogon zaczyna sie po ${after}, a PC ma telefon do ${link.phoneMark}.`, phoneMark: link.phoneMark })
      if (!Number.isSafeInteger(to) || to < after) return json(res, 400, { error: 'Brak poprawnego parametru to.' })
      const zip = await readBody(req, MAX_TAIL_BYTES)
      const map = new SeqMap(link.runs)
      const applied = await appendTail(get, link.pcSessionId, zip, (phoneSeq) => map.toPc(phoneSeq))
      // Agent lustra nie widzi dopisanych tur; bez tego po przejeciu nadalby numer, ktory juz jest w logu.
      const reload = tryReload(link)
      const state = await sessionState(get, link.pcSessionId)
      let updated = links.recordApplied(id, {
        epoch: link.epoch, from: 'phone', ownerTo: to, mirrorLast: state.lastSeq, pairs: applied.pairs, error: applied.error,
      })
      if (reload.error) updated = links.pause(id, reload.error)
      const error = applied.error ?? reload.error
      return json(res, error ? 409 : 200, { ...updated, applied: applied.pairs.length, reload, ...(error ? { error } : {}) })
    }

    if (action === '/claim' && req.method === 'POST') {
      const body = await readJson(req)
      const state = await sessionState(get, link.pcSessionId)
      return json(res, 200, links.switchOwner(id, {
        to: 'phone', epoch: body.epoch, ownerMark: link.pcMark, ownerBoundary: state.boundary ?? link.pcMark, ownerBusy: state.busy, mirrorLast: body.phoneLast,
      }))
    }

    if (action === '/claim-confirm' && req.method === 'POST') {
      const body = await readJson(req)
      if (!link.claim) return json(res, 409, { error: 'PC nie prosi o przejecie.' })
      // PC zostaje wlascicielem: jego agent musi znac ostatnia ture z logu, zanim przyjmie pierwsza.
      const reload = tryReload(link)
      if (reload.error) return json(res, 409, { ...links.pause(id, reload.error), error: reload.error })
      const state = await sessionState(get, link.pcSessionId)
      return json(res, 200, links.switchOwner(id, {
        to: 'pc', epoch: body.epoch, ownerMark: link.phoneMark, ownerBoundary: body.phoneBoundary ?? link.phoneMark, ownerBusy: Boolean(body.phoneBusy), mirrorLast: state.lastSeq,
      }))
    }
    return json(res, 404, { error: 'nieznana sciezka' })
  }

  /** Trasy interfejsu PC; `path` bez prefiksu /api/dsh-remote-control. */
  async function ui(req, res, path) {
    if (path === '/links' && req.method === 'GET') return json(res, 200, { links: links.list() })
    const m = /^\/links\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(path)
    if (!m) return false
    const [, id, action = ''] = m
    if (action === '' && req.method === 'DELETE') return json(res, 200, { removed: links.remove(id) })
    const link = links.get(id)
    if (!link) return json(res, 404, { error: 'Nie ma takiego powiazania.' })
    if (action === '/resume' && req.method === 'POST') return json(res, 200, resumeLink(link))
    if (!deps.enabled) return json(res, 503, { error: deps.disabledReason ?? 'Synchronizacja sesji jest wylaczona.' })
    if (link.paused) return json(res, 409, { error: `Powiazanie wstrzymane: ${link.paused.message}`, paused: link.paused })
    if (action === '/claim' && req.method === 'POST') return json(res, 200, links.requestClaim(id))
    if (action === '/force' && req.method === 'POST') {
      const reload = tryReload(link)
      if (reload.error) return json(res, 409, { ...links.pause(id, reload.error), error: reload.error })
      const state = await sessionState(get, link.pcSessionId)
      return json(res, 200, links.switchOwner(id, { to: 'pc', epoch: link.epoch, force: true, mirrorLast: state.lastSeq }))
    }
    return json(res, 404, { error: 'nieznana sciezka' })
  }

  return { phone, ui }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers?.['content-length']) > limit) return reject(Object.assign(new Error('za duzy ogon'), { status: 413 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('za duzy ogon'), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const data = await readBody(req, 1024 * 1024)
  if (data.length === 0) return {}
  try { return JSON.parse(data.toString('utf8')) } catch { throw Object.assign(new Error('tresc nie jest JSON'), { status: 400 }) }
}
