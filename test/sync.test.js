// Synchronizacja powiazanych sesji: mapa numerow, przeliczanie odwolan, ogon, magazyn powiazan
// i trasy kuriera na sztucznych uslugach DSH (sesja aktywna z append nadajacym wlasne numery).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'
import { appendTail, latestBoundary, readTail, remapSeqRefs, SeqMap } from '../lib/sync.js'
import { readZip } from '../lib/zip.js'

/** Sztuczny DSH z jedna lub kilkoma sesjami; `append` nadaje kolejny numer jak Session.append. */
function fakeDsh(logs) {
  const sessions = new Map(Object.entries(logs).map(([id, events]) => [id, {
    events,
    append(type, data, opts) {
      const e = { type, seq: this.events.length, time: 1, data, ...(opts ?? {}) }
      this.events.push(e)
      return e
    },
  }]))
  const services = {
    sessions: { get: (id) => sessions.get(id) },
    sessionQuery: { observeSession: async (id) => { const s = sessions.get(id); if (!s) throw new Error('not found'); return { events: [...s.events], [Symbol.dispose]() {} } } },
    attachments: { saveImage: async () => { throw new Error('bez obrazow w tym tescie') } },
  }
  return { get: (n) => services[n], sessions }
}

const turn = (seq0, n) => [
  { type: 'turn/start', seq: seq0, time: 1, data: { turn: n } },
  { type: 'user/message', seq: seq0 + 1, time: 1, data: { text: `pytanie ${n}` }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: seq0 + 2, time: 1, data: { text: `odpowiedz ${n}` } },
  { type: 'tool/result', seq: seq0 + 3, time: 1, data: { ok: true }, sourceEventSeqs: [seq0 + 2] },
  { type: 'turn/end', seq: seq0 + 4, time: 1, data: { turn: n } },
]

test('SeqMap: wspolny poczatek, laczenie zakresow, oba kierunki', () => {
  const m = SeqMap.shared(10)
  m.add(10, 12); m.add(11, 13); m.add(20, 30)
  assert.deepEqual(m.toJSON(), [[0, 0, 10], [10, 12, 2], [20, 30, 1]])
  assert.equal(m.toPhone(11), 13)
  assert.equal(m.toPc(30), 20)
  assert.equal(m.toPhone(15), undefined)
})

test('remapSeqRefs: wszystkie znane pola, straznik nieznanego pola', () => {
  const e = { type: 'tool/result', seq: 9, time: 1, sourceEventSeqs: [3, 4], surfaceOp: { kind: 'replace', startSeq: 3, endSeq: 4 }, data: { shadowedSeqs: [3], messageSeqs: [4], headerSeq: 3, sourceEventSeq: 4 } }
  const out = remapSeqRefs(e, (o) => o + 100)
  assert.deepEqual(out.sourceEventSeqs, [103, 104])
  assert.deepEqual([out.surfaceOp.startSeq, out.surfaceOp.endSeq], [103, 104])
  assert.deepEqual([out.data.shadowedSeqs, out.data.messageSeqs, out.data.headerSeq, out.data.sourceEventSeq], [[103], [104], 103, 104])
  assert.equal('seq' in out, false)
  assert.throws(() => remapSeqRefs({ type: 'x', seq: 1, data: { parentSeq: 2 } }, (o) => o), (err) => err.status === 409 && /parentSeq/.test(err.message))
})

test('latestBoundary: ostatni turn/end plus samodzielne zdarzenia do nastepnej tury', () => {
  const ev = [...turn(0, 1), { type: 'session/title', seq: 5, time: 1, data: {} }, { type: 'turn/start', seq: 6, time: 1, data: { turn: 2 } }]
  assert.equal(latestBoundary(ev), 5)
  assert.equal(latestBoundary([{ type: 'turn/start', seq: 0 }]), undefined)
})

test('readTail + appendTail: ogon konczy sie na zakonczonej turze, odwolania wskazuja te same zdarzenia w lustrze', async () => {
  const owner = [...turn(0, 1), ...turn(5, 2), ...turn(10, 3), { type: 'turn/start', seq: 15, time: 1, data: { turn: 4 } }]
  // Lustro: wspolne 0..4 plus 2 lokalne zdarzenia (wznowienie i tytul), wiec numeracja sie rozjezdza.
  const mirror = [...turn(0, 1), { type: 'session/end-seed', seq: 5, time: 1, data: {} }, { type: 'session/title', seq: 6, time: 1, data: { text: 't' } }]
  const dsh = fakeDsh({ owner, mirror })
  const tail = await readTail(dsh.get, 'owner', 4)
  assert.deepEqual([tail.fromSeq, tail.toSeq, tail.busy, tail.count], [4, 14, true, 10])
  assert.ok(readZip(tail.zip).has('tail.jsonl'))
  const map = SeqMap.shared(5)
  const r = await appendTail(dsh.get, 'mirror', tail.zip, (o) => map.toPhone(o))
  assert.equal(r.error, undefined)
  assert.deepEqual(r.pairs[0], [5, 7])
  const m = dsh.sessions.get('mirror').events
  assert.equal(m.length, 17)
  assert.deepEqual(m[10].sourceEventSeqs, [9], 'tool/result z tury 2 wskazuje assistant/message lustra')
  assert.equal(m[9].type, 'assistant/message')
})

test('appendTail: odwolanie spoza mapy przerywa przed dopisaniem tego zdarzenia', async () => {
  const owner = [...turn(0, 1), ...turn(5, 2)]
  owner[8] = { ...owner[8], sourceEventSeqs: [2] } // tool/result tury 2 wskazuje zdarzenie sprzed ogona
  const dsh = fakeDsh({ owner, mirror: [{ type: 'turn/start', seq: 0, time: 1, data: {} }] })
  const tail = await readTail(dsh.get, 'owner', 4)
  const r = await appendTail(dsh.get, 'mirror', tail.zip, () => undefined)
  assert.match(r.error, /nie weszlo/)
  assert.equal(r.pairs.length, 3, 'zdarzenia przed bledem weszly i sa zgloszone do znacznikow')
})

function call(handler, method, path, body, query = '') {
  const req = new PassThrough()
  req.method = method
  req.headers = {}
  const res = { status: 0, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  const url = new URL(path + query, 'http://x')
  const done = handler(req, res, url.pathname, url)
  req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
  // Jak api.js: wyjatek z `status` staje sie odpowiedzia z tym kodem.
  return done.then(
    (handled) => ({ handled, status: res.status, headers: res.headers, json: res.headers?.['content-type']?.includes('json') ? JSON.parse(res.body) : null, raw: res.body }),
    (error) => ({ handled: true, status: error.status ?? 500, json: { error: error.message } }),
  )
}

test('cykl powiazania: ogon PC -> telefon, przejecie przez telefon, ogon telefonu -> lustro PC, prosba PC i oddanie', async () => {
  const pc = [...turn(0, 1), ...turn(5, 2)]
  const dsh = fakeDsh({ pc })
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-links-')), 'links.json'))
  const api = createLinkApi({ get: dsh.get, links })
  const phone = (m, p, b, q) => call(api.phone, m, p, b, q)

  const created = (await phone('POST', '/links', { pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'pc', sharedCount: 5 })).json
  assert.deepEqual([created.pcMark, created.phoneMark, created.epoch], [4, 4, 1])
  const id = created.linkId

  const listed = (await phone('GET', '/links')).json.links[0]
  assert.deepEqual([listed.pcLastSeq, listed.pcBoundary, listed.pcBusy], [9, 9, false])

  const tail = await phone('GET', `/links/${id}/events`, undefined, '?after=4&epoch=1')
  assert.equal(tail.headers['x-dsh-to'], '9')
  // Telefon dopisal 5 zdarzen jako 7..11 (mial 2 lokalne).
  const applied = (await phone('POST', `/links/${id}/applied`, { epoch: 1, ownerTo: 9, mirrorLast: 11, pairs: [[5, 7], [6, 8], [7, 9], [8, 10], [9, 11]] })).json
  assert.deepEqual([applied.pcMark, applied.phoneMark], [9, 11])

  assert.equal((await phone('POST', `/links/${id}/claim`, { epoch: 2, phoneLast: 11 })).status, 409, 'zly epoch')
  const claimed = (await phone('POST', `/links/${id}/claim`, { epoch: 1, phoneLast: 11 })).json
  assert.deepEqual([claimed.owner, claimed.epoch], ['phone', 2])
  assert.equal(links.isPcMirror('pc'), true)

  // Telefon pisze dalej (12..16), odwolanie tool/result wskazuje jego assistant/message 14.
  const { writeZip } = await import('../lib/zipwrite.js')
  const phoneTail = turn(12, 3).map((e) => JSON.stringify(e)).join('\n') + '\n'
  const pushed = await phone('POST', `/links/${id}/events`, writeZip([['tail.jsonl', phoneTail]]), '?after=11&to=16&epoch=2')
  assert.equal(pushed.status, 200)
  assert.deepEqual([pushed.json.pcMark, pushed.json.phoneMark, pushed.json.applied], [14, 16, 5])
  assert.deepEqual(dsh.sessions.get('pc').events[13].sourceEventSeqs, [12])
  assert.equal(dsh.sessions.get('pc').events[12].type, 'assistant/message')

  assert.equal((await phone('POST', `/links/${id}/events`, writeZip([['tail.jsonl', '']]), '?after=11&to=16&epoch=2')).status, 409, 'ogon od starego znacznika odrzucony')

  // PC prosi o przejecie; telefon oddaje po dostarczeniu ogona.
  assert.equal((await call(api.ui, 'POST', `/links/${id}/claim`)).json.claim.by, 'pc')
  assert.equal(links.get(id).owner, 'phone')
  const back = (await phone('POST', `/links/${id}/claim-confirm`, { epoch: 2, phoneBoundary: 16, phoneBusy: false })).json
  assert.deepEqual([back.owner, back.epoch, back.claim, back.pcMark], ['pc', 3, null, 14])
  assert.equal(links.isPcMirror('pc'), false)
})

test('przejecie odrzucone, gdy na wlascicielu trwa tura albo lustro nie ma najnowszych zdarzen', async () => {
  const dsh = fakeDsh({ pc: [...turn(0, 1), ...turn(5, 2), { type: 'turn/start', seq: 10, time: 1, data: { turn: 3 } }] })
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-links-')), 'links.json'))
  const api = createLinkApi({ get: dsh.get, links })
  const { linkId } = (await call(api.phone, 'POST', '/links', { pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'pc', sharedCount: 5 })).json
  const r = await call(api.phone, 'POST', `/links/${linkId}/claim`, { epoch: 1, phoneLast: 6 })
  assert.equal(r.status, 409)
  assert.match(r.json.error, /tura/)
})

test('rejestracja: walidacja i brak podwojnego powiazania', async () => {
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-links-')), 'links.json'))
  assert.throws(() => links.create({ pcSessionId: 'a', phoneSessionId: 'b', owner: 'x', sharedCount: 3 }), /owner/)
  links.create({ pcSessionId: 'a', phoneSessionId: 'b', owner: 'pc', sharedCount: 3 })
  assert.throws(() => links.create({ pcSessionId: 'a', phoneSessionId: 'c', owner: 'pc', sharedCount: 3 }), (e) => e.status === 409)
})
