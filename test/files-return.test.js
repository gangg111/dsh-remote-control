// Faza 2: pliki projektu odsylane z telefonu na PC (POST /links/:id/files) z baza sum.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createApi } from '../lib/api.js'
import { createFileBase } from '../lib/file-base.js'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'
import { packWorkspaceZip } from '../lib/workspace-files.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const put = (root, rel, data) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data); return f }
const sha = (s) => createHash('sha256').update(s).digest('hex')

function setup({ owner = 'phone' } = {}) {
  const pcRoot = tmp('ret-pc-')
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: pcRoot }, events: [], [Symbol.dispose]() {} }) } }
  const links = createLinks(join(tmp('ret-links-'), 'links.json'))
  const fileBase = createFileBase(join(tmp('ret-base-'), 'filebase.json'))
  const api = createLinkApi({ get: (n) => services[n], links, enabled: true, fileBase })
  const link = links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner, sharedCount: 3 })
  return { pcRoot, links, fileBase, api, link }
}

/** ZIP plikow tak, jak buduje go telefon: origin telefonu, returnTo z importu. */
function phoneZip(files, returnTo) {
  const dir = tmp('ret-phone-')
  const paths = Object.entries(files).map(([rel, data]) => put(dir, rel, data))
  return packWorkspaceZip({ root: dir, scope: 'agent', paths, origin: { device: 'phone', root: dir, name: 'proj' }, ...(returnTo ? { returnTo: { root: returnTo } } : {}) }).zip
}

function post(api, path, body) {
  const req = new PassThrough()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/zip' }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  const done = api.phone(req, res, path, new URL(path, 'http://x'))
  req.end(body)
  return done.then(() => ({ status: res.status, json: JSON.parse(res.body) }), (e) => ({ status: e.status ?? 500, json: { error: e.message } }))
}

test('zwrot: niezmieniony na PC nadpisany bez kopii, nowy utworzony, zmieniony takze na PC dostaje kopie', async () => {
  const { pcRoot, fileBase, api, link } = setup()
  put(pcRoot, 'a.txt', 'stare a')
  put(pcRoot, 'c.txt', 'c zmienione na PC')
  // Stan z wyslania na telefon: a.txt i c.txt w starej tresci.
  fileBase.merge(pcRoot, [{ path: 'a.txt', sha256: sha('stare a') }, { path: 'c.txt', sha256: sha('stare c') }])
  const zip = phoneZip({ 'a.txt': 'nowe a', 'b.txt': 'nowe b', 'c.txt': 'c z telefonu' }, pcRoot)
  const r = await post(api, `/links/${link.linkId}/files`, zip)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.report.written, ['a.txt'])
  assert.deepEqual(r.json.report.created, ['b.txt'])
  assert.deepEqual(r.json.report.conflicts.map((c) => c.path), ['c.txt'])
  assert.equal(readFileSync(join(pcRoot, 'a.txt'), 'utf8'), 'nowe a')
  assert.equal(readFileSync(join(pcRoot, 'c.txt'), 'utf8'), 'c z telefonu')
  const copies = readdirSync(pcRoot).filter((f) => f.includes('.przed-importem-'))
  assert.equal(copies.length, 1)
  assert.equal(readFileSync(join(pcRoot, copies[0]), 'utf8'), 'c zmienione na PC')
  // Baza po zwrocie: tresc z telefonu.
  assert.deepEqual(fileBase.get(pcRoot), { 'a.txt': sha('nowe a'), 'b.txt': sha('nowe b'), 'c.txt': sha('c z telefonu') })

  // Drugi zwrot z kolejna zmiana a.txt: PC nie ruszal pliku od poprzedniego zwrotu, wiec bez kopii.
  const r2 = await post(api, `/links/${link.linkId}/files`, phoneZip({ 'a.txt': 'jeszcze nowsze a' }, pcRoot))
  assert.deepEqual([r2.json.report.written, r2.json.report.conflicts], [['a.txt'], []])
  assert.equal(readdirSync(pcRoot).filter((f) => f.includes('.przed-importem-')).length, 1)
})

test('zwrot: zly katalog w returnTo -> 409 i nic nie zapisane', async () => {
  const { pcRoot, api, link } = setup()
  const r = await post(api, `/links/${link.linkId}/files`, phoneZip({ 'x.txt': 'x' }, 'C:\\inny\\katalog'))
  assert.equal(r.status, 409)
  assert.match(r.json.error, /nic nie zapisano/)
  assert.equal(existsSync(join(pcRoot, 'x.txt')), false)
})

test('zwrot: returnTo rozni sie tylko wielkoscia liter i ukosnikami -> przyjete', async () => {
  const { pcRoot, api, link } = setup()
  const hint = pcRoot.replaceAll('\\', '/').toUpperCase() + '/'
  const r = await post(api, `/links/${link.linkId}/files`, phoneZip({ 'x.txt': 'x' }, hint))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.report.created, ['x.txt'])
})

test('zwrot: wlascicielem jest PC -> 409', async () => {
  const { api, link } = setup({ owner: 'pc' })
  const r = await post(api, `/links/${link.linkId}/files`, phoneZip({ 'x.txt': 'x' }))
  assert.equal(r.status, 409)
})

test('info: workspace-files-return tylko przy wlaczonej synchronizacji', async () => {
  const info = async (syncEnabled) => {
    const api = createApi({ get: () => undefined, outbox: { waiting: () => [] }, dsh: {}, linkApi: { phone: async () => false }, syncEnabled })
    const req = new PassThrough(); req.method = 'GET'
    const res = { body: '', writeHead() {}, end(b) { this.body = b } }
    await api(req, res, new URL('/__remote/api/info', 'http://x')); req.end()
    return JSON.parse(res.body).capabilities
  }
  assert.ok((await info(true)).includes('workspace-files-return')); assert.ok((await info(true)).includes('workspace-files-pull')); assert.ok((await info(true)).includes('workspace-files-pull-ack'))
  assert.ok(!(await info(false)).includes('workspace-files-return'))
})

test('pobranie przez telefon: tylko pliki z bazy i agenta zmienione od bazy, usuniete na liscie, baza zaktualizowana', async () => {
  const pcRoot = tmp('pull-pc-')
  put(pcRoot, 'a.txt', 'a zmienione na PC')
  put(pcRoot, 'same.txt', 'bez zmian')
  const c = put(pcRoot, 'nowy/c.txt', 'c od agenta')
  put(pcRoot, 'obcy.bin', 'reszta projektu, nie przenoszona')
  const events = [{ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: c }) } }]
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: pcRoot }, events, [Symbol.dispose]() {} }) } }
  const links = createLinks(join(tmp('pull-links-'), 'links.json'))
  const fileBase = createFileBase(join(tmp('pull-base-'), 'filebase.json'))
  fileBase.merge(pcRoot, [
    { path: 'a.txt', sha256: sha('a stare') },
    { path: 'same.txt', sha256: sha('bez zmian') },
    { path: 'usuniety.txt', sha256: sha('byl') },
  ])
  const api = createLinkApi({ get: (n) => services[n], links, enabled: true, fileBase })
  const link = links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'phone', sharedCount: 3 })

  const req = new PassThrough(); req.method = 'GET'
  const res = { status: 0, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  await api.phone(req, res, `/links/${link.linkId}/files`, new URL(`/links/${link.linkId}/files`, 'http://x'))
  req.end()
  assert.equal(res.status, 200)
  const { readWorkspaceZip } = await import('../lib/workspace-files.js')
  const { manifest, tree } = readWorkspaceZip(res.body)
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['a.txt', 'nowy/c.txt'])
  assert.deepEqual(manifest.deleted, ['usuniety.txt'])
  assert.equal(manifest.origin.device, 'pc')
  assert.equal(tree.get('a.txt').toString(), 'a zmienione na PC')
  assert.equal(fileBase.get(pcRoot)['a.txt'], sha('a zmienione na PC'))

  // Telefon stosuje to u siebie i drugi raz nie ma nic nowego.
  const dst = tmp('pull-phone-')
  const { applyWorkspaceZip } = await import('../lib/workspace-files.js')
  assert.deepEqual(applyWorkspaceZip({ root: dst, zip: res.body }).report.created.sort(), ['a.txt', 'nowy/c.txt'])
  const req2 = new PassThrough(); req2.method = 'GET'
  const res2 = { headers: null, body: null, writeHead(s, h) { this.headers = h }, end(b) { this.body = b } }
  await api.phone(req2, res2, `/links/${link.linkId}/files`, new URL(`/links/${link.linkId}/files`, 'http://x'))
  assert.equal(res2.headers['x-dsh-files'], '0')
  assert.equal(res2.headers['x-dsh-files-deleted'], '0', 'usuniety zgloszony tylko raz')
  assert.equal(fileBase.get(pcRoot)['usuniety.txt'], undefined)
})

test('pobranie z ack: baza czeka na potwierdzenie; telefon, ktory padl po GET, dostaje pliki ponownie', async () => {
  const pcRoot = tmp('ack-pc-')
  put(pcRoot, 'a.txt', 'a v3 z PC')
  put(pcRoot, 'b.txt', 'b nowe na PC')
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: pcRoot }, events: [], [Symbol.dispose]() {} }) } }
  const links = createLinks(join(tmp('ack-links-'), 'links.json'))
  const fileBase = createFileBase(join(tmp('ack-base-'), 'filebase.json'))
  fileBase.merge(pcRoot, [{ path: 'a.txt', sha256: sha('a v2') }, { path: 'b.txt', sha256: sha('b stare') }, { path: 'zniknal.txt', sha256: sha('z') }])
  const api = createLinkApi({ get: (n) => services[n], links, enabled: true, fileBase })
  const link = links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'phone', sharedCount: 3 })
  const get = async (q) => {
    const req = new PassThrough(); req.method = 'GET'
    const res = { headers: null, body: null, writeHead(s, h) { this.headers = h }, end(b) { this.body = b } }
    const p = `/links/${link.linkId}/files`
    await api.phone(req, res, p, new URL(p + q, 'http://x'))
    return res
  }
  const ack = (body) => {
    const req = new PassThrough(); req.method = 'POST'
    const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
    const p = `/links/${link.linkId}/files-applied`
    const done = api.phone(req, res, p, new URL(p, 'http://x'))
    req.end(JSON.stringify(body))
    return done.then(() => ({ status: res.status, json: JSON.parse(res.body) }))
  }
  const { readWorkspaceZip } = await import('../lib/workspace-files.js')

  const first = await get('?ack=1')
  const id1 = first.headers['x-dsh-files-id']
  assert.equal(readWorkspaceZip(first.body).manifest.pullId, id1)
  assert.equal(first.headers['x-dsh-files'], '2')
  assert.equal(fileBase.get(pcRoot)['a.txt'], sha('a v2'), 'baza bez zmian przed potwierdzeniem')

  // Telefon padl przed zastosowaniem: ponowne pobranie zwraca te same pliki z nowym id, stare id jest niewazne.
  const again = await get('?ack=1')
  const id2 = again.headers['x-dsh-files-id']
  assert.equal(again.headers['x-dsh-files'], '2')
  assert.notEqual(id2, id1)
  assert.equal((await ack({ pullId: id1, applied: ['a.txt'] })).status, 409)

  // Zastosowany tylko a.txt (np. b.txt pominiety): do bazy trafia tylko a.txt, zniknal.txt wypada.
  const ok = await ack({ pullId: id2, applied: ['a.txt', 'nie-z-tego-pobrania.txt'] })
  assert.deepEqual([ok.status, ok.json.merged], [200, 1])
  const baseNow = fileBase.get(pcRoot)
  assert.equal(baseNow['a.txt'], sha('a v3 z PC'))
  assert.equal(baseNow['b.txt'], sha('b stare'))
  assert.equal(baseNow['zniknal.txt'], undefined)
  assert.equal((await ack({ pullId: id2, applied: ['a.txt'] })).status, 409, 'potwierdzenie tylko raz')

  // Nastepne pobranie: tylko b.txt, ktorego telefon nie potwierdzil.
  const next = await get('?ack=1')
  assert.deepEqual(readWorkspaceZip(next.body).manifest.files.map((f) => f.path), ['b.txt'])

  // Bez ack (stare telefony): baza aktualizowana od razu, jak dotad.
  await get('')
  assert.equal(fileBase.get(pcRoot)['b.txt'], sha('b nowe na PC'))
})
