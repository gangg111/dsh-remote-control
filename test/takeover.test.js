// Przejecie pisania a licznik tur agenta DSH. Sztuczny agent odwzorowuje ReactLoopAgent z DSH 0.2
// (agent-loop/src/agent.ts): licznik tur czytany z projekcji `turnBoundary` tylko w konstruktorze,
// `agent/status: running` emitowane synchronicznie w wakeDriver, a `turn/start` zapisywany w turn()
// po `signal.throwIfAborted()` i PRZED `agent/pre-step`. Bez przeladowania musi dac zly numer tury.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'
import { guardTurnStart, readTail, reloadSession } from '../lib/sync.js'
import { writeZip } from '../lib/zipwrite.js'

const turn = (seq0, n) => [
  { type: 'turn/start', seq: seq0, time: 1, data: { turn: n } },
  { type: 'user/message', seq: seq0 + 1, time: 1, data: { text: `pytanie ${n}` }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: seq0 + 2, time: 1, data: { text: `odpowiedz ${n}` } },
  { type: 'turn/end', seq: seq0 + 3, time: 1, data: { turn: n } },
]

class FakeAgent {
  constructor(dsh, session) {
    this.dsh = dsh
    this.session = session
    this.id = session.header.id
    this.requestHeaderLogged = true
    this.phase = { kind: 'idle', lastTurn: dsh.projections.stateOf(session, 'turnBoundary').lastTurn }
  }
  get status() { return this.phase.kind === 'running' ? 'running' : 'idle' }
  setPhase(next) {
    const before = this.status
    this.phase = next
    if (this.status !== before) this.dsh.emitStatus({ agent: this, status: this.status })
  }
  cancel(_cause, options = {}) {
    if (!options.keepInbox) this.session.append('agent/inbox/spliced', { cleared: true })
    if (this.phase.kind !== 'idle') this.phase.abort.abort()
  }
  /** Jedna tura (prompt usera): wakeDriver + kick z jedna tura. */
  followup() {
    this.setPhase({ kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false })
    const phase = this.phase
    try {
      phase.abort.signal.throwIfAborted()
      const n = phase.turn + 1
      this.session.append('turn/start', { turn: n })
      phase.turn = n
      this.session.append('turn/end', { turn: n })
    } catch {
      // przerwanie przed `turn/start`: nic nie zapisane
    } finally {
      this.setPhase({ kind: 'idle', lastTurn: phase.turn })
    }
  }
}

/** Sztuczny DSH: sesje, projekcja `turnBoundary`, rejestr agentow, `agent/status`. */
function fakeDsh(logs) {
  const listeners = []
  const dsh = {
    emitStatus: (payload) => { for (const l of listeners) l(payload) },
    onStatus: (l) => listeners.push(l),
    projections: {
      stateOf: (session, key) => key === 'turnBoundary'
        ? { lastTurn: Math.max(0, ...session.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)) }
        : undefined,
    },
  }
  const sessions = new Map(Object.entries(logs).map(([id, events]) => [id, {
    header: { id },
    events,
    append(type, data, opts) {
      const e = { type, seq: this.events.length, time: 1, data, ...(opts ?? {}) }
      this.events.push(e)
      return e
    },
  }]))
  const agents = new Map()
  dsh.sessions = sessions
  dsh.agents = agents
  /** Wznowienie sesji jak w DSH: agent powstaje z logu. */
  dsh.resume = (id) => { const a = new FakeAgent(dsh, sessions.get(id)); agents.set(id, a); return a }
  const services = {
    sessions: { get: (id) => sessions.get(id) },
    sessionQuery: { observeSession: async (id) => { const s = sessions.get(id); if (!s) throw new Error('not found'); return { events: [...s.events], [Symbol.dispose]() {} } } },
    sessionProjections: dsh.projections,
    agents: { get: (id) => agents.get(id) },
    attachments: {},
  }
  dsh.get = (n) => services[n]
  return dsh
}

const turnsOf = (session) => session.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)

/** Kazde `turn/start` otwiera kolejny numer: to samo sprawdza DSH przy wczytaniu logu. */
function assertTurnsValid(session) {
  turnsOf(session).forEach((n, i) => assert.equal(n, i + 1, `turn/start nr ${i} ma numer ${n}`))
}

function call(handler, method, path, body, query = '') {
  const req = new PassThrough()
  req.method = method
  req.headers = {}
  const res = { status: 0, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  const url = new URL(path + query, 'http://x')
  const done = handler(req, res, url.pathname, url)
  req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
  return done.then(
    (handled) => ({ handled, status: res.status, json: res.headers?.['content-type']?.includes('json') ? JSON.parse(res.body) : null }),
    (error) => ({ handled: true, status: error.status ?? 500, json: { error: error.message } }),
  )
}

test('sztuczny agent odtwarza blad: bez przeladowania tura po przejeciu dostaje numer, ktory juz jest w logu', async () => {
  const dsh = fakeDsh({ owner: [...turn(0, 1), ...turn(4, 2), ...turn(8, 3)], mirror: [...turn(0, 1)] })
  const agent = dsh.resume('mirror') // lustro otwarte w DSH: agent zna ture 1
  const tail = await readTail(dsh.get, 'owner', 3)
  const { appendTail, SeqMap } = await import('../lib/sync.js')
  const map = SeqMap.shared(4)
  await appendTail(dsh.get, 'mirror', tail.zip, (o) => map.toPhone(o))
  assert.deepEqual(turnsOf(dsh.sessions.get('mirror')), [1, 2, 3])
  agent.followup()
  assert.deepEqual(turnsOf(dsh.sessions.get('mirror')), [1, 2, 3, 2], 'stary licznik: tura 2 drugi raz')
})

test('reloadSession: agent lustra po dopisaniu ogona nadaje ostatnia ture + 1', async () => {
  const dsh = fakeDsh({ owner: [...turn(0, 1), ...turn(4, 2), ...turn(8, 3)], mirror: [...turn(0, 1)] })
  const agent = dsh.resume('mirror')
  const { appendTail, SeqMap } = await import('../lib/sync.js')
  const map = SeqMap.shared(4)
  await appendTail(dsh.get, 'mirror', (await readTail(dsh.get, 'owner', 3)).zip, (o) => map.toPhone(o))
  assert.deepEqual(reloadSession(dsh.get, 'mirror'), { mode: 'live', before: 1, lastTurn: 3 })
  assert.equal(agent.requestHeaderLogged, false, 'nastepne zapytanie zapisze naglowek resume jak po wczytaniu')
  agent.followup()
  const mirror = dsh.sessions.get('mirror')
  assert.deepEqual(turnsOf(mirror), [1, 2, 3, 4])
  assertTurnsValid(mirror)
  // Ponowne wczytanie z logu (jak po restarcie DSH) daje ten sam licznik.
  assert.equal(dsh.resume('mirror').phase.lastTurn, 4)
})

test('reloadSession: bez agenta nic nie robi, przy trwajacej turze 409, przy nieznanym stanie 500', () => {
  const dsh = fakeDsh({ s: [...turn(0, 1)] })
  assert.deepEqual(reloadSession(dsh.get, 's'), { mode: 'cold' })
  const agent = dsh.resume('s')
  agent.phase = { kind: 'running', abort: new AbortController(), turn: 1, step: 1, wakeRequested: false }
  assert.throws(() => reloadSession(dsh.get, 's'), (e) => e.status === 409)
  agent.phase = { kind: 'cos-nowego' }
  assert.throws(() => reloadSession(dsh.get, 's'), (e) => e.status === 500)
})

test('bramka tury u wlasciciela: zly numer przerwany przed zapisem, licznik wyrownany, kolejna tura poprawna', () => {
  const dsh = fakeDsh({ s: [...turn(0, 1)] })
  const agent = dsh.resume('s')
  dsh.sessions.get('s').append('turn/start', { turn: 2 }) // obca tura bez przeladowania
  dsh.sessions.get('s').append('turn/end', { turn: 2 })
  const stopped = []
  dsh.onStatus((p) => { const r = guardTurnStart(dsh.get, p, () => 'owner'); if (r) stopped.push(r) })
  const before = dsh.sessions.get('s').events.length
  agent.followup()
  assert.equal(dsh.sessions.get('s').events.length, before, 'nic nie zapisane')
  assert.deepEqual(stopped, [{ sessionId: 's', role: 'owner', reason: 'turn', expected: 2, actual: 1 }])
  assert.deepEqual(agent.phase, { kind: 'idle', lastTurn: 2 })
  agent.followup()
  assert.deepEqual(turnsOf(dsh.sessions.get('s')), [1, 2, 3])
  assert.equal(stopped.length, 1, 'poprawna tura przechodzi bez przerwania')
})

test('bramka tury w lustrze: kazda tura przerwana bez turn/start, sesja niepowiazana bez zmian', () => {
  const dsh = fakeDsh({ m: [...turn(0, 1)], free: [...turn(0, 1)] })
  dsh.onStatus((p) => { guardTurnStart(dsh.get, p, (id) => (id === 'm' ? 'mirror' : undefined)) })
  dsh.resume('m').followup()
  dsh.resume('free').followup()
  assert.deepEqual(turnsOf(dsh.sessions.get('m')), [1])
  assert.deepEqual(turnsOf(dsh.sessions.get('free')), [1, 2])
})

test('trasy: ogon telefonu przeladowuje agenta lustra PC, po oddaniu pisania PC nadaje ostatnia ture + 1', async () => {
  const dsh = fakeDsh({ pc: [...turn(0, 1)] })
  const pcAgent = dsh.resume('pc')
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-takeover-')), 'links.json'))
  const api = createLinkApi({ get: dsh.get, links, enabled: true })
  dsh.onStatus((p) => { guardTurnStart(dsh.get, p, links.pcRole) })
  const { linkId } = (await call(api.phone, 'POST', '/links', { pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'phone', sharedCount: 4 })).json

  pcAgent.followup() // lustro: przerwane
  assert.deepEqual(turnsOf(dsh.sessions.get('pc')), [1])
  const mirrorLast = dsh.sessions.get('pc').events.length - 1

  const phoneTail = [...turn(4, 2), ...turn(8, 3)].map((e) => JSON.stringify(e)).join('\n') + '\n'
  const pushed = await call(api.phone, 'POST', `/links/${linkId}/events`, writeZip([['tail.jsonl', phoneTail]]), `?after=3&to=11&epoch=1`)
  assert.equal(pushed.status, 200)
  assert.deepEqual(pushed.json.reload, { mode: 'live', before: 1, lastTurn: 3 })
  assert.ok(mirrorLast > 3)

  await call(api.ui, 'POST', `/links/${linkId}/claim`)
  const back = await call(api.phone, 'POST', `/links/${linkId}/claim-confirm`, { epoch: 1, phoneBoundary: 11, phoneBusy: false })
  assert.equal(back.json.owner, 'pc')
  pcAgent.followup()
  assertTurnsValid(dsh.sessions.get('pc'))
  assert.deepEqual(turnsOf(dsh.sessions.get('pc')), [1, 2, 3, 4])
})

test('wstrzymanie: trasy odmawiaja 409, resume wyrownuje licznik i zdejmuje wstrzymanie, odlaczenie dziala', async () => {
  const dsh = fakeDsh({ pc: [...turn(0, 1)] })
  dsh.resume('pc')
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-takeover-')), 'links.json'))
  const api = createLinkApi({ get: dsh.get, links, enabled: true })
  const { linkId } = (await call(api.phone, 'POST', '/links', { pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'pc', sharedCount: 4 })).json
  links.pause(linkId, 'test')
  const refused = await call(api.phone, 'GET', `/links/${linkId}/events`, undefined, '?after=3&epoch=1')
  assert.equal(refused.status, 409)
  assert.match(refused.json.error, /wstrzymane: test/)
  assert.equal((await call(api.ui, 'POST', `/links/${linkId}/force`)).status, 409)
  const resumed = await call(api.ui, 'POST', `/links/${linkId}/resume`)
  assert.equal(resumed.status, 200)
  assert.equal(resumed.json.paused, undefined)
  assert.equal(resumed.json.reload.mode, 'live')
  assert.equal((await call(api.phone, 'GET', `/links/${linkId}/events`, undefined, '?after=3&epoch=1')).status, 200)
  links.pause(linkId, 'znowu')
  assert.equal((await call(api.phone, 'DELETE', `/links/${linkId}`)).json.removed, true)
})
