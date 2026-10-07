// Przenoszenie sesji: czytanie natywnego eksportu, import przez sztuczne uslugi DSH o ksztaltach
// z 0.2.0-rc.2 (sessionPersistence.create/append, workspaceRegistry, attachments, sessionQuery), skrzynka.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox } from '../lib/outbox.js'
import { importSession, parseExport, remapAttachments, sessionModel, TransferError } from '../lib/transfer.js'
import { readZip } from '../lib/zip.js'
import { writeZip } from './zip-writer.js'

const OLD_IMG = 'sha256:' + 'a'.repeat(64)
const NEW_IMG = 'sha256:' + 'b'.repeat(64)
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function sampleExport({ version = 4 } = {}) {
  const header = { type: 'session', version, id: 'session-src', createdAt: 1, cwd: '/data/home/x', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const events = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 11, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'czesc' }, { type: 'image', attachment: { attachmentId: OLD_IMG, mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'zrzut.png' } }] } },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session-log-deepseek/delivery-accepted', seq: 3, time: 13, data: { sessionId: 'session-src', sessionFormatVersion: 4, throughSeq: 2 } },
  ]
  const log = [header, ...events].map((l) => JSON.stringify(l)).join('\n') + '\n'
  return writeZip([[`session.v${version}.jsonl`, log], [`media/${OLD_IMG}.png`, PNG], ['subagents/session-sub/session.v4.jsonl', '{}\n']])
}

function fakeDsh({ observeFails = false } = {}) {
  const written = { header: null, events: [], flushed: false, closed: false, attached: [], removed: [], emitted: [] }
  const services = {
    sessionPersistence: {
      async create(header) {
        written.header = header
        return { append: async (ev) => { written.events.push(...ev) }, flush: async () => { written.flushed = true }, close: async () => { written.closed = true } }
      },
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', path: 'C:\\proj\\alpha', attachSession: async (id) => written.attached.push(['w1', id]) }, { id: 'w2', path: 'C:\\Users\\A\\deepseek-harness-default-workspace', attachSession: async (id) => written.attached.push(['w2', id]) }],
      resolveByPath: async () => undefined,
    },
    attachments: { saveImage: async ({ data, mediaType }) => ({ attachmentId: NEW_IMG, mediaType, bytes: data.length, width: 2, height: 2 }) },
    sessionQuery: {
      async observeSession() { if (observeFails) throw new Error('unknown event type foo/bar'); return { [Symbol.dispose]() {} } },
      async readTitle() { return { text: 'Tytul z telefonu' } },
    },
  }
  return { written, get: (n) => services[n] }
}

test('zip: odczyt wlasnego archiwum i odrzucenie uszkodzonego CRC', () => {
  const zip = writeZip([['a.txt', 'zazolc gesla jazn'], ['d/b.bin', Buffer.from([1, 2, 3])]])
  const m = readZip(zip)
  assert.equal(m.get('a.txt').toString(), 'zazolc gesla jazn')
  assert.deepEqual([...m.get('d/b.bin')], [1, 2, 3])
  const bad = Buffer.from(zip)
  bad.writeUInt32LE(0x12345678, 14) // CRC w naglowku lokalnym nie jest czytany; psujemy CRC centralny:
  const cdStart = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  bad.writeUInt32LE(0xdeadbeef, cdStart + 16)
  assert.throws(() => readZip(bad), /uszkodzona zawartosc/)
})

test('zip: odrzuca nazwe wychodzaca poza archiwum', () => {
  assert.throws(() => readZip(writeZip([['../evil.txt', 'x']])), /niedozwolona nazwa/)
})

test('eksport: naglowek, zdarzenia, obraz, liczba podagentow', () => {
  const p = parseExport(sampleExport())
  assert.equal(p.header.id, 'session-src')
  assert.equal(p.events.length, 4)
  assert.equal(p.images.get(OLD_IMG).mediaType, 'image/png')
  assert.equal(p.subagents, 1)
})

test('eksport: inny format = czytelny 422', () => {
  assert.throws(() => parseExport(sampleExport({ version: 3 })), (e) => e instanceof TransferError && e.status === 422 && /formacie 3/.test(e.message))
})

test('remap: caly opis zalacznika podmieniony, nazwa zachowana, reszta nietknieta', () => {
  const ev = { data: { content: [{ type: 'image', attachment: { attachmentId: OLD_IMG, width: 1, name: 'z.png' } }, { type: 'text', text: OLD_IMG }] } }
  const out = remapAttachments(ev, new Map([[OLD_IMG, { attachmentId: NEW_IMG, width: 2 }]]))
  assert.deepEqual(out.data.content[0].attachment, { attachmentId: NEW_IMG, width: 2, name: 'z.png' })
  assert.equal(out.data.content[1].text, OLD_IMG)
  assert.equal(ev.data.content[0].attachment.attachmentId, OLD_IMG, 'oryginal bez zmian')
})

test('import: nowa sesja w domyslnym obszarze, zdarzenia od seq 0, zalaczniki podmienione, lista powiadomiona', async () => {
  const { written, get } = fakeDsh()
  const r = await importSession(get, sampleExport(), { emit: (e, p) => written.emitted.push([e, p]) })
  assert.match(r.sessionId, /^session-[0-9a-f-]{36}$/)
  assert.notEqual(r.sessionId, 'session-src')
  assert.equal(r.title, 'Tytul z telefonu')
  assert.deepEqual({ version: written.header.version, isSeeded: written.header.isSeeded, cwd: written.header.cwd, preset: written.header.agentPreset },
    { version: 4, isSeeded: false, cwd: 'C:\\Users\\A\\deepseek-harness-default-workspace', preset: 'standard' })
  assert.equal('parentSession' in written.header, false)
  assert.deepEqual(written.events.map((e) => e.seq), [0, 1, 2, 3])
  assert.equal(written.events[3].data.sessionId, r.sessionId, 'znacznik wyslania wskazuje nowa sesje')
  assert.equal(written.events[1].data.content[1].attachment.attachmentId, NEW_IMG)
  assert.ok(written.flushed && written.closed)
  assert.deepEqual(written.attached, [['w2', r.sessionId]])
  assert.equal(written.emitted[0][0], 'api-session/added')
  assert.equal(r.skippedSubagents, 1)
})

test('import rozgalezienia: znaczniki rodzica wskazuja nowa sesje, sesja rozgaleziona z ta sama czescia odziedziczona', async () => {
  const header = { type: 'session', version: 4, id: 'session-fork', createdAt: 1, cwd: '/x', parentSession: 'session-parent', isSeeded: true, delegationDepth: 0 }
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 1, data: { sessionId: 'session-parent', sessionFormatVersion: 4, throughSeq: 0 } },
    { type: 'turn/end', seq: 2, time: 1, data: { turn: 1 } },
    { type: 'session/end-seed', seq: 3, time: 1, data: { inherited: true } },
    { type: 'session-log-deepseek/delivery-accepted', seq: 4, time: 1, data: { sessionId: 'session-fork', sessionFormatVersion: 4, throughSeq: 3 } },
  ]
  const zip = writeZip([['session.v4.jsonl', [header, ...events].map((l) => JSON.stringify(l)).join('\n') + '\n']])
  let created
  const { written, get } = fakeDsh()
  const persistence = get('sessionPersistence')
  const services = { ...Object.fromEntries(['workspaceRegistry', 'sessionQuery', 'attachments'].map((n) => [n, get(n)])),
    sessionPersistence: { create: async (h, opts) => { created = { h, opts }; return persistence.create(h) } } }
  const r = await importSession((n) => services[n], zip)
  assert.deepEqual([created.h.isSeeded, created.opts?.inheritedEventCount, 'parentSession' in created.h], [true, 3, false])
  assert.deepEqual(written.events.filter((e) => e.type.startsWith('session-log')).map((e) => e.data.sessionId), [r.sessionId, r.sessionId])
})

test('sessionModel: ostatni wybor po ostatnim naglowku zadania, inaczej konfiguracja naglowka', () => {
  const header = (provider, model, seq) => ({ type: 'request/header', seq, time: 1, data: { header: { config: { provider, model, reasoningEffort: 'max' } }, reason: 'resume' } })
  assert.deepEqual(sessionModel([header('deepseek-account', 'deepseek-flash', 0)]), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(sessionModel([header('a', 'x', 0), { type: 'model/selection', seq: 1, time: 1, data: { provider: 'b', model: 'y' } }]), { provider: 'b', model: 'y' })
  assert.deepEqual(sessionModel([{ type: 'model/selection', seq: 0, time: 1, data: { provider: 'b', model: 'y' } }, header('a', 'x', 1)]), { provider: 'a', model: 'x' })
  assert.equal(sessionModel([{ type: 'turn/start', seq: 0, time: 1, data: {} }]), undefined)
})

function modelDsh({ providers, defaultSelection, failSelect = false }) {
  const { written, get } = fakeDsh()
  const selected = []
  const services = {
    ...Object.fromEntries(['sessionPersistence', 'workspaceRegistry', 'sessionQuery', 'attachments'].map((n) => [n, get(n)])),
    llm: { listProviders: () => Object.keys(providers).map((id) => ({ id })), listModels: async (p) => (providers[p] ?? []).map((id) => ({ id })) },
    agentDefaultModel: { currentSelection: () => defaultSelection },
    sessionController: { selectModel: async (r) => { if (failSelect) throw new Error('model/unavailable'); selected.push(r); return { selected: { provider: r.provider, model: r.model } } } },
  }
  return { written, selected, get: (n) => services[n] }
}

function exportWithModel(provider, model) {
  const header = { type: 'session', version: 4, id: 'session-src', createdAt: 1, cwd: '/x', isSeeded: false, delegationDepth: 0 }
  const events = [{ type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider, model } }, reason: 'resume' } }]
  return writeZip([['session.v4.jsonl', [header, ...events].map((l) => JSON.stringify(l)).join('\n') + '\n']])
}

test('import: model niedostepny na urzadzeniu -> oficjalny selectModel na domyslny, wynik modelChanged', async () => {
  const dsh = modelDsh({ providers: { 'deepseek-api': ['deepseek-v41-flash'] }, defaultSelection: { provider: 'deepseek-api', model: 'deepseek-v41-flash', reasoningEffort: 'max' } })
  const r = await importSession(dsh.get, exportWithModel('deepseek-account', 'deepseek-flash'))
  assert.deepEqual(r.modelChanged, { from: 'deepseek-account/deepseek-flash', to: 'deepseek-api/deepseek-v41-flash' })
  assert.deepEqual(dsh.selected, [{ sessionId: r.sessionId, provider: 'deepseek-api', model: 'deepseek-v41-flash', reasoningEffort: 'max' }])
})

test('import: model dostepny -> bez zmiany; blad selectModel nie wywraca importu', async () => {
  const ok = modelDsh({ providers: { 'deepseek-account': ['deepseek-flash'] }, defaultSelection: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  assert.equal((await importSession(ok.get, exportWithModel('deepseek-account', 'deepseek-flash'))).modelChanged, null)
  assert.equal(ok.selected.length, 0)
  const warnings = []
  const bad = modelDsh({ providers: { api: ['m'] }, defaultSelection: { provider: 'api', model: 'm' }, failSelect: true })
  const r = await importSession(bad.get, exportWithModel('konto', 'x'), { log: { warn: (m) => warnings.push(m) } })
  assert.equal(r.modelChanged, null)
  assert.match(warnings[0], /model importu/)
})

test('import: wskazany obszar roboczy', async () => {
  const { written, get } = fakeDsh()
  await importSession(get, sampleExport(), { workspaceId: 'w1' })
  assert.equal(written.header.cwd, 'C:\\proj\\alpha')
})

test('import: DSH nie przyjmuje sesji przy odczycie -> 422 i usuniecie zapisu', async () => {
  const { written, get } = fakeDsh({ observeFails: true })
  await assert.rejects(importSession(get, sampleExport(), { removeSession: async (id) => written.removed.push(id) }), (e) => e.status === 422)
  assert.equal(written.removed.length, 1)
  assert.equal(written.attached.length, 0)
})

test('skrzynka: bez duplikatow, odbior, sprzatanie odebranych po dobie', () => {
  let t = 1_000_000
  const box = createOutbox(join(mkdtempSync(join(tmpdir(), 'rc-outbox-')), 'outbox.json'), () => t)
  const a = box.add('session-1', 'Pierwsza')
  assert.equal(box.add('session-1', 'Pierwsza').transferId, a.transferId)
  assert.equal(box.waiting().length, 1)
  box.markReceived(a.transferId)
  assert.equal(box.waiting().length, 0)
  assert.equal(box.list()[0].state, 'received')
  t += 25 * 60 * 60 * 1000
  assert.equal(box.list().length, 0)
})
