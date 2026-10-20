// Bezpiecznik wersji: trasy przenoszace zdarzenia i pliki wymagaja tej samej wersji DSH (naglowek x-dsh-version).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'

function call(api, method, path, { body, version, query = '' } = {}) {
  const req = new PassThrough()
  req.method = method
  req.headers = version === undefined ? {} : { 'x-dsh-version': version }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  const done = api.phone(req, res, path, new URL(path + query, 'http://x'))
  req.end(body === undefined ? undefined : JSON.stringify(body))
  return done.then(() => ({ status: res.status, json: res.body ? JSON.parse(res.body) : null }), (e) => ({ status: e.status ?? 500, json: { error: e.message } }))
}

function setup(dshVersion) {
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'ver-')), 'links.json'))
  const services = { sessionQuery: { observeSession: async () => ({ events: [], [Symbol.dispose]() {} }) } }
  return { links, api: createLinkApi({ get: (n) => services[n], links, enabled: true, dshVersion }) }
}

const body = { pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'pc', sharedCount: 3 }

test('zakladanie powiazania: rozne wersje i brak naglowka -> 409, ta sama wersja -> 200', async () => {
  const { api, links } = setup('0.2.1-rc.2')
  const old = await call(api, 'POST', '/links', { body, version: '0.2.0-rc.2' })
  assert.equal(old.status, 409)
  assert.deepEqual([old.json.pcVersion, old.json.phoneVersion], ['0.2.1-rc.2', '0.2.0-rc.2'])
  const none = await call(api, 'POST', '/links', { body })
  assert.equal(none.status, 409)
  assert.equal(none.json.phoneVersion, null)
  assert.match(none.json.error, /x-dsh-version/)
  assert.equal(links.list().length, 0)
  assert.equal((await call(api, 'POST', '/links', { body, version: '0.2.1-rc.2' })).status, 200)
})

test('ogon i przejecie: blokowane przy roznej wersji; lista, odlaczenie i wstrzymanie przechodza', async () => {
  const { api, links } = setup('0.2.1-rc.2')
  const link = links.create(body)
  const p = `/links/${link.linkId}`
  assert.equal((await call(api, 'GET', `${p}/events`, { version: '0.2.0-rc.2', query: '?after=2' })).status, 409)
  assert.equal((await call(api, 'POST', `${p}/claim`, { body: { epoch: 1, phoneLast: 2 }, version: '0.2.0-rc.2' })).status, 409)
  assert.equal(links.get(link.linkId).owner, 'pc', 'przejecie nie weszlo')
  assert.equal((await call(api, 'GET', '/links', { version: '0.2.0-rc.2' })).status, 200)
  assert.equal((await call(api, 'POST', `${p}/pause`, { body: { message: 'x' }, version: '0.2.0-rc.2' })).status, 200)
  assert.equal((await call(api, 'DELETE', p, { version: '0.2.0-rc.2' })).status, 200)
})

test('PC bez znanej wersji (profil web): kontroli nie ma', async () => {
  const { api } = setup(undefined)
  assert.equal((await call(api, 'POST', '/links', { body })).status, 200)
})
