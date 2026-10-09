// Tryb "caly projekt": eksport i pobranie po przejeciu biora caly katalog z wykluczeniami i limitami.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createApi } from '../lib/api.js'
import { createFileBase } from '../lib/file-base.js'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'
import { collectFiles, diffAgainstBase, readWorkspaceZip } from '../lib/workspace-files.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const put = (root, rel, data) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data); return f }
const sha = (s) => createHash('sha256').update(s).digest('hex')

function projectDir() {
  const root = tmp('proj-')
  put(root, 'a.txt', 'a')
  put(root, 'sub/b.sh', '#!/bin/sh\necho b\n')
  put(root, 'node_modules/x/i.js', 'x')
  put(root, 'klucz.pfx', 'S')
  put(root, 'a.txt.przed-importem-2026', 'stara kopia')
  return root
}

async function rawGet(handler, path, query) {
  const req = new PassThrough(); req.method = 'GET'
  const res = { status: 0, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h }, end(b) { if (b) this.chunks.push(Buffer.from(b)) } }
  await handler(req, res, path, new URL(path + query, 'http://x'))
  return { status: res.status, headers: res.headers, body: Buffer.concat(res.chunks) }
}

test('eksport ?scope=project: caly katalog bez wykluczonych i bez kopii konfliktowych', async () => {
  const root = projectDir()
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: root }, events: [], [Symbol.dispose]() {} }) } }
  const api = createApi({
    get: (n) => services[n],
    outbox: { get: () => ({ sessionId: 's1', state: 'waiting' }), waiting: () => [] },
    dsh: { exportSession: async () => ({ ok: false }) },
  })
  const id = '00000000-0000-4000-8000-000000000000'
  const path = `/__remote/api/outbox/${id}/files`
  const req = new PassThrough(); req.method = 'GET'
  const res = { status: 0, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h }, end(b) { if (b) this.chunks.push(Buffer.from(b)) } }
  await api(req, res, new URL(path + '?scope=project', 'http://x'))
  const { manifest } = readWorkspaceZip(Buffer.concat(res.chunks))
  assert.equal(manifest.scope, 'project')
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['a.txt', 'sub/b.sh'])
  const reasons = Object.fromEntries(manifest.skipped.map((s) => [s.path, s.reason]))
  assert.equal(reasons['klucz.pfx'], 'secret')
  assert.equal(reasons['a.txt.przed-importem-2026'], 'transfer-copy')
  assert.equal(reasons['node_modules/x/i.js'], undefined, 'katalogi zaleznosci nie sa nawet ogladane')
  // Bez scope: tryb agenta, zero plikow (sesja bez narzedzi).
  const req2 = new PassThrough(); req2.method = 'GET'
  const res2 = { headers: null, chunks: [], writeHead(s, h) { this.headers = h }, end(b) { if (b) this.chunks.push(Buffer.from(b)) } }
  await api(req2, res2, new URL(path, 'http://x'))
  assert.equal(res2.headers['x-dsh-files'], '0')
})

test('pobranie po przejeciu ?scope=project: plik zrobiony powloka na PC tez leci', async () => {
  const root = tmp('proj-pull-')
  put(root, 'a.txt', 'a zmienione')
  put(root, 'z-powloki.txt', 'utworzony poleceniem')
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: root }, events: [], [Symbol.dispose]() {} }) } }
  const links = createLinks(join(tmp('proj-links-'), 'links.json'))
  const fileBase = createFileBase(join(tmp('proj-base-'), 'fb.json'))
  fileBase.merge(root, [{ path: 'a.txt', sha256: sha('a') }, { path: 'usuniety.txt', sha256: sha('u') }])
  const api = createLinkApi({ get: (n) => services[n], links, enabled: true, fileBase })
  const link = links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'phone', sharedCount: 3 })
  const p = `/links/${link.linkId}/files`
  const agentOnly = await rawGet(api.phone, p, '?ack=1')
  assert.deepEqual(readWorkspaceZip(agentOnly.body).manifest.files.map((f) => f.path), ['a.txt'], 'tryb agenta nie widzi pliku z powloki')
  const whole = await rawGet(api.phone, p, '?ack=1&scope=project')
  const { manifest } = readWorkspaceZip(whole.body)
  assert.equal(manifest.scope, 'project')
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['a.txt', 'z-powloki.txt'])
  assert.deepEqual(manifest.deleted, ['usuniety.txt'])
})

test('limit przejscia: walk-limit w skipped, nieobejrzany plik nie jest "usuniety"', () => {
  const root = tmp('proj-walk-')
  for (const n of ['1', '2', '3', '4']) put(root, `f${n}.txt`, n)
  const { manifest } = collectFiles({ root, scope: 'project', origin: {}, limits: { walkFiles: 2 } })
  assert.ok(manifest.files.length <= 2)
  assert.ok(manifest.skipped.some((s) => s.reason === 'walk-limit'))
  const base = { files: ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'naprawde-brak.txt'].map((path) => ({ path, sha256: 'x' })) }
  const d = diffAgainstBase(root, base, 2)
  assert.equal(d.truncated, true)
  assert.deepEqual(d.deleted, ['naprawde-brak.txt'])
})
