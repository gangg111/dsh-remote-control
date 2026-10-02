// Nadzor nad dsh-tsnet: zdarzenia stanu, jednorazowe otwarcie linku logowania, wznowienie po awarii,
// zamkniecie przez stdin. Zamiast binarki uruchamiany jest skrypt Node o tym samym zachowaniu.
import test from 'node:test'
import assert from 'node:assert/strict'
import { superviseTsnet } from '../lib/embedded.js'

const FAKE = `
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n')
emit({ type: 'state', backendState: 'NeedsLogin', authURL: 'https://login.tailscale.com/a/abc' })
emit({ type: 'state', backendState: 'NeedsLogin', authURL: 'https://login.tailscale.com/a/abc' })
emit({ type: 'state', backendState: 'Running', dnsName: 'dsh-pc.tail1.ts.net', owner: 'artur@example.com' })
if (process.env.CRASH_ONCE && !require('fs').existsSync(process.env.CRASH_ONCE)) { require('fs').writeFileSync(process.env.CRASH_ONCE, '1'); process.exit(3) }
process.stdin.resume(); process.stdin.on('end', () => process.exit(0))
`

function run(extraEnv = {}) {
  const events = []
  const opened = []
  const sup = superviseTsnet({ exe: process.execPath, args: ['-e', FAKE], env: { DSH_RC_SECRET: 'x', ...extraEnv }, onEvent: (e) => events.push(e), openUrl: (u) => opened.push(u) })
  return { sup, events, opened }
}

const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)) } }

test('stan i link logowania: przegladarka otwarta raz na dany link', async () => {
  const { sup, events, opened } = run()
  await until(() => events.some((e) => e.backendState === 'Running'))
  sup.stop()
  assert.deepEqual(opened, ['https://login.tailscale.com/a/abc'])
  assert.equal(events.filter((e) => e.type === 'state').length, 3)
  assert.equal(events.at(-1).owner, 'artur@example.com')
})

test('awaria procesu: zdarzenie exit i wznowienie', async () => {
  const marker = `${process.env.TEMP || '/tmp'}/dsh-tsnet-crash-${process.pid}-${Date.now()}`
  const { sup, events } = run({ CRASH_ONCE: marker })
  await until(() => events.some((e) => e.type === 'exit'))
  assert.equal(events.find((e) => e.type === 'exit').code, 3)
  await until(() => events.filter((e) => e.backendState === 'Running').length >= 2)
  sup.stop()
})
