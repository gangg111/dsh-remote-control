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
  assert.ok((await info(true)).includes('workspace-files-return'))
  assert.ok(!(await info(false)).includes('workspace-files-return'))
})
