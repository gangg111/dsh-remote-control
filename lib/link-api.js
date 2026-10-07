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
 *   DELETE /links/:id                            odlaczenie
 * Interfejs PC (serwer DSH, /api/dsh-remote-control):
 *   GET /links, POST /links/:id/claim (prosba), POST /links/:id/force (bez telefonu), DELETE /links/:id
 */

import { appendTail, readTail, SeqMap, sessionState } from './sync.js'

const MAX_TAIL_BYTES = 256 * 1024 * 1024

/**
 * @param {{ get: (name: string) => any, links: ReturnType<typeof import('./links.js').createLinks>, log?: { warn: Function } }} deps
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

  /** Trasy telefonu; `path` bez prefiksu /__remote/api. Zwraca false, gdy sciezka nie nalezy do synchronizacji. */
  async function phone(req, res, path, url) {
    if (path === '/links' && req.method === 'GET') return json(res, 200, { links: await Promise.all(links.list().map(withPcState)) })
    if (path === '/links' && req.method === 'POST') return json(res, 200, links.create(await readJson(req)))
    const m = /^\/links\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(path)
    if (!m) return false
    const [, id, action = ''] = m
    const link = links.get(id)
    if (!link) return json(res, 404, { error: 'Nie ma takiego powiazania.' })
    const epoch = url.searchParams.get('epoch')

    if (action === '' && req.method === 'DELETE') return json(res, 200, { removed: links.remove(id) })

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
      const state = await sessionState(get, link.pcSessionId)
      const updated = links.recordApplied(id, {
        epoch: link.epoch, from: 'phone', ownerTo: to, mirrorLast: state.lastSeq, pairs: applied.pairs, error: applied.error,
      })
      return json(res, applied.error ? 409 : 200, { ...updated, applied: applied.pairs.length, ...(applied.error ? { error: applied.error } : {}) })
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
    if (action === '/claim' && req.method === 'POST') return json(res, 200, links.requestClaim(id))
    if (action === '/force' && req.method === 'POST') {
      const link = links.get(id)
      if (!link) return json(res, 404, { error: 'Nie ma takiego powiazania.' })
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
