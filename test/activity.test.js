// Rejestr transferow do animacji ikony: postep, zakonczenie, krotkie przytrzymanie, liczenie odbioru.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { createActivity, sendBuffer } from '../lib/activity.js'
import { createFileBase } from '../lib/file-base.js'
import { createLinkApi } from '../lib/link-api.js'
import { createLinks } from '../lib/links.js'
import { packWorkspaceZip } from '../lib/workspace-files.js'
import { writeFileSync } from 'node:fs'

test('rejestr: postep, koniec, przytrzymanie i znikniecie', () => {
  let t = 1000
  const a = createActivity({ lingerMs: 500, now: () => t })
  const h = a.start('s1', 'out', 100)
  h.add(40)
  assert.deepEqual(a.list(), [{ sessionId: 's1', direction: 'out', bytes: 40, total: 100, done: false }])
  h.end()
  assert.deepEqual(a.list()[0], { sessionId: 's1', direction: 'out', bytes: 100, total: 100, done: true })
  t += 400
  assert.equal(a.list().length, 1, 'jeszcze widoczny')
  t += 200
  assert.equal(a.list().length, 0, 'po przytrzymaniu znika')
  const u = a.start('s2', 'in')
  assert.equal(a.list()[0].total, null, 'nieznany rozmiar')
  u.end()
})

test('sendBuffer: wysyla kawalkami, liczy bajty i konczy wpis', async () => {
  const a = createActivity()
  const got = []
  const res = new Writable({ highWaterMark: 16, write(chunk, _e, cb) { got.push(chunk); setImmediate(cb) } })
  res.destroyed = false
  const buf = Buffer.alloc(200_000, 7)
  await sendBuffer(res, buf, a.start('s', 'out', buf.length), 64 * 1024)
  assert.equal(Buffer.concat(got).length, buf.length)
  assert.deepEqual(a.list()[0], { sessionId: 's', direction: 'out', bytes: buf.length, total: buf.length, done: true })
})

test('zwrot plikow z telefonu liczy odbierane bajty dla sesji PC', async () => {
  const pcRoot = mkdtempSync(join(tmpdir(), 'act-pc-'))
  const services = { sessionQuery: { observeSession: async (id) => ({ header: { id, cwd: pcRoot }, events: [], [Symbol.dispose]() {} }) } }
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'act-l-')), 'l.json'))
  const activity = createActivity()
  const api = createLinkApi({ get: (n) => services[n], links, enabled: true, fileBase: createFileBase(join(pcRoot, '..', `fb-${Date.now()}.json`)), activity })
  const link = links.create({ pcSessionId: 'pc-1', phoneSessionId: 'tel', owner: 'phone', sharedCount: 3 })
  const phoneDir = mkdtempSync(join(tmpdir(), 'act-tel-'))
  writeFileSync(join(phoneDir, 'x.txt'), 'x'.repeat(5000))
  const { zip } = packWorkspaceZip({ root: phoneDir, scope: 'agent', paths: [join(phoneDir, 'x.txt')], origin: { device: 'phone' } })
  const req = new PassThrough(); req.method = 'POST'; req.headers = { 'content-length': String(zip.length) }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  const p = `/links/${link.linkId}/files`
  const done = api.phone(req, res, p, new URL(p, 'http://x'))
  req.end(zip)
  await done
  assert.equal(res.status, 200)
  assert.deepEqual(activity.list(), [{ sessionId: 'pc-1', direction: 'in', bytes: zip.length, total: zip.length, done: true }])
})
