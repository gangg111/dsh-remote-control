// API dla telefonu na falszywych uslugach DSH o ksztaltach z 0.1.7-rc.2
// (sessionController.list/create/prompt, sessionQuery.filterEvents/readTitle, workspaceRegistry).
import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createApi } from '../lib/api.js'

function fakeServices() {
  const prompts = []
  const services = {
    sessionController: {
      async list() {
        return { items: [
          { sessionId: 's1', updatedAt: 3000, running: true, cwd: 'C:\\proj\\alpha', projections: { kind: 'x', asOfSeq: 1, values: { title: 'Sesja z tytulem' } } },
          { sessionId: 's2', updatedAt: 2000, running: false, cwd: 'C:\\proj\\beta' },
          { sessionId: 'sub', updatedAt: 1500, running: false, origin: 'subagent', parentSessionId: 's1' },
          { sessionId: 'blank', updatedAt: 1000, running: false, blank: true },
        ] }
      },
      async create(req) { return { sessionId: `new-${req.workspaceId ?? 'domyslny'}` } },
      async prompt(req) { prompts.push(req); return { accepted: true } },
    },
    sessionQuery: {
      async filterEvents(id) {
        if (id === 's1') return [
          { type: 'user/message', text: 'zrob build' },
          { type: 'assistant/message', text: 'Przesłać to tam?' },
          { type: 'approval/asked', text: 'bash' },
        ]
        return [{ type: 'user/message', text: 'a' }, { type: 'assistant/message', text: 'gotowe' }, { type: 'approval/asked', text: '' }, { type: 'approval/decided', text: '' }]
      },
      async readTitle(id) { return id === 's2' ? { text: 'Tytul z projekcji' } : undefined },
    },
    workspaceRegistry: {
      list() { return [{ id: 'w1', name: 'alpha', path: 'C:\\proj\\alpha' }, { id: 'w2', path: 'C:\\proj\\beta' }] },
      async resolveByPath(p) { return p.endsWith('alpha') ? { id: 'w1', name: 'alpha' } : undefined },
    },
  }
  return { services, prompts }
}

async function call(api, method, path, body) {
  const req = new PassThrough()
  req.method = method
  const res = { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b ?? '' } }
  const done = api(req, res, new URL(path, 'http://x'))
  req.end(body ? JSON.stringify(body) : undefined)
  const handled = await done
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

test('sesje: bez podagentow i pustych, tytul, obszar, praca, oczekiwanie, ostatnia wiadomosc', async () => {
  const { services } = fakeServices()
  const api = createApi({ get: (n) => services[n] })
  const r = await call(api, 'GET', '/__remote/api/sessions')
  assert.equal(r.status, 200)
  const [a, b] = r.json.sessions
  assert.equal(r.json.sessions.length, 2)
  assert.deepEqual({ id: a.sessionId, title: a.title, ws: a.workspace, running: a.running, waiting: a.waiting, last: a.last },
    { id: 's1', title: 'Sesja z tytulem', ws: 'alpha', running: true, waiting: true, last: { role: 'assistant', text: 'Przesłać to tam?' } })
  assert.deepEqual({ title: b.title, ws: b.workspace, waiting: b.waiting }, { title: 'Tytul z projekcji', ws: 'beta', waiting: false })
})

test('podglad ostatniej wiadomosci bez skladni Markdown', async () => {
  const { services } = fakeServices()
  services.sessionQuery.filterEvents = async () => [{ type: 'assistant/message', text: '## Wynik\n**Dlaczego plik** powstał w `6 s`.\n\n| A | B |\n|---|---|\n| x | y |\n\n```ps1\nGet-Item\n```\n[docs](https://x.y)' }]
  const r = await call(createApi({ get: (n) => services[n] }), 'GET', '/__remote/api/sessions')
  assert.equal(r.json.sessions[0].last.text, 'Wynik Dlaczego plik powstał w 6 s. A · B · x · y · docs')
})

test('info: znacznik uslugi do wykrywania komputera przez telefon', async () => {
  const r = await call(createApi({ get: () => undefined }), 'GET', '/__remote/api/info')
  assert.equal(r.json.service, 'dsh-remote-control')
  assert.equal(r.json.api, 1)
  assert.equal(typeof r.json.name, 'string')
})

test('sesje: zarchiwizowane nie trafiaja na telefon', async () => {
  const { services } = fakeServices()
  services.workspaceRegistry.archivedSessionIds = ['s2']
  const r = await call(createApi({ get: (n) => services[n] }), 'GET', '/__remote/api/sessions')
  assert.deepEqual(r.json.sessions.map((s) => s.sessionId), ['s1'])
})

test('obszary robocze: nazwa albo ostatni czlon sciezki', async () => {
  const { services } = fakeServices()
  const r = await call(createApi({ get: (n) => services[n] }), 'GET', '/__remote/api/workspaces')
  assert.deepEqual(r.json.workspaces.map((w) => w.name), ['alpha', 'beta'])
})

test('nowa sesja: create + pierwsza wiadomosc z requestId', async () => {
  const { services, prompts } = fakeServices()
  const r = await call(createApi({ get: (n) => services[n] }), 'POST', '/__remote/api/sessions', { workspaceId: 'w2', text: '  hej  ' })
  assert.deepEqual(r.json, { sessionId: 'new-w2' })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'new-w2')
  assert.equal(prompts[0].mode, 'queue')
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hej' }])
  assert.match(prompts[0].requestId, /^[0-9a-f-]{36}$/)
})

test('brak uslugi DSH: 503 z opisem, a obce sciezki nie sa przechwytywane', async () => {
  const api = createApi({ get: () => undefined })
  const r = await call(api, 'GET', '/__remote/api/sessions')
  assert.equal(r.status, 503)
  assert.match(r.json.error, /sessionController/)
  const other = await call(api, 'GET', '/__remote/inne')
  assert.equal(other.handled, false)
})
