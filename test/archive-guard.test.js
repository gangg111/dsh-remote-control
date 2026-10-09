// Archiwizacja sesji powiazanej z telefonem: aktywnosc w oknie potwierdzenia, odlaczenie przy zatrzymaniu.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArchiveGuard, SYNC_ACTIVITY } from '../lib/archive-guard.js'
import { createLinks } from '../lib/links.js'

function setup() {
  const handlers = {}
  const ctx = { on: (name, fn) => { handlers[name] = fn } }
  const links = createLinks(join(mkdtempSync(join(tmpdir(), 'rc-archive-')), 'links.json'))
  installArchiveGuard(ctx, links)
  return { handlers, links }
}

test('sesja powiazana: aktywnosc synchronizacji przed innymi zgloszeniami', async () => {
  const { handlers, links } = setup()
  const link = links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'phone', sharedCount: 3 })
  const got = await handlers['workspace/session-activity']({ sessionId: 'pc' }, async () => [{ kind: 'turn' }])
  assert.deepEqual(got, [{ kind: SYNC_ACTIVITY, items: [{ id: link.linkId, label: 'lustro sesji z telefonu' }] }, { kind: 'turn' }])
})

test('sesja niepowiazana: zgloszenia bez zmian', async () => {
  const { handlers } = setup()
  assert.deepEqual(await handlers['workspace/session-activity']({ sessionId: 'inna' }, async () => []), [])
})

test('zatrzymanie przy archiwizacji odlacza powiazanie tylko tej sesji', () => {
  const { handlers, links } = setup()
  links.create({ pcSessionId: 'pc', phoneSessionId: 'tel', owner: 'pc', sharedCount: 3 })
  const other = links.create({ pcSessionId: 'pc2', phoneSessionId: 'tel2', owner: 'pc', sharedCount: 3 })
  handlers['workspace/session-stop']({ sessionId: 'pc' })
  assert.equal(links.byPcSession('pc'), undefined)
  assert.equal(links.byPcSession('pc2').linkId, other.linkId)
  handlers['workspace/session-stop']({ sessionId: 'brak' })
})
