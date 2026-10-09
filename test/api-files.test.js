// Trasa GET /outbox/:id/files: pliki projektu zmienione przez agenta jako ZIP (manifest + tree/).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createApi } from '../lib/api.js'
import { readWorkspaceZip } from '../lib/workspace-files.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const put = (root, rel, data) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data); return f }
const tcall = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

function apiWith(root, events, { state = 'waiting' } = {}) {
  const services = {
    sessionQuery: {
      async observeSession(id) {
        assert.equal(id, 's1')
        return { header: { id, cwd: root }, events, [Symbol.dispose]() {} }
      },
    },
  }
  return createApi({
    get: (n) => services[n],
    outbox: { get: () => ({ sessionId: 's1', state, title: 't' }), waiting: () => [] },
    dsh: { exportSession: async () => ({ ok: false }) },
  })
}

async function raw(api, path) {
  const req = new PassThrough()
  req.method = 'GET'
  const res = { status: 0, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h }, end(b) { if (b) this.chunks.push(Buffer.from(b)) } }
  const handled = await api(req, res, new URL(path, 'http://x'))
  return { handled, status: res.status, headers: res.headers, body: Buffer.concat(res.chunks) }
}

test('info oglasza workspace-files, gdy wlaczone przenoszenie sesji', async () => {
  const api = apiWith(tmp('api-f-'), [])
  const req = new PassThrough(); req.method = 'GET'
  const res = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b ?? '' } }
  await api(req, res, new URL('/__remote/api/info', 'http://x')); req.end()
  assert.ok(JSON.parse(res.body).capabilities.includes('workspace-files'))
})

test('GET /outbox/:id/files: tylko pliki zmienione przez agenta, manifest z origin', async () => {
  const root = tmp('api-files-')
  const a = put(root, 'src/a.c', 'AAA')
  put(root, 'src/nietkniety.c', 'B')
  put(root, 'sekret.pfx', 'X')
  const events = [tcall('edit', { file_path: a }), tcall('write', { file_path: join(root, 'sekret.pfx') })]
  const api = apiWith(root, events)
  const id = '00000000-0000-4000-8000-000000000000'
  const r = await raw(api, `/__remote/api/outbox/${id}/files`)
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/zip')
  assert.equal(r.headers['x-dsh-files'], '1')
  const { manifest, tree } = readWorkspaceZip(r.body)
  assert.equal(manifest.origin.name, basename(root))
  assert.deepEqual(manifest.files.map((f) => f.path), ['src/a.c'])
  assert.equal(tree.get('src/a.c').toString(), 'AAA')
  assert.equal(manifest.skipped.find((s) => s.path === 'sekret.pfx').reason, 'secret')
})

test('GET /outbox/:id/files: brak wpisu w skrzynce -> 404', async () => {
  const api = createApi({
    get: () => undefined,
    outbox: { get: () => undefined, waiting: () => [] },
    dsh: { exportSession: async () => ({ ok: false }) },
  })
  const id = '00000000-0000-4000-8000-000000000000'
  const r = await raw(api, `/__remote/api/outbox/${id}/files`)
  assert.equal(r.status, 404)
})
