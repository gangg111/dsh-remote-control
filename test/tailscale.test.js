// Parsowanie wyjscia Tailscale CLI: wlasciciel wezla, adres MagicDNS i stan portu w `serve status`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, servePortState } from '../lib/tailscale.js'

test('status: wlasciciel i adres bez kropki na koncu', () => {
  const s = parseStatus({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'pc.tail1234.ts.net.' }, User: { 42: { LoginName: 'artur@example.com' } } })
  assert.deepEqual(s, { backendState: 'Running', ownerLogin: 'artur@example.com', dnsName: 'pc.tail1234.ts.net' })
})

test('status: wylogowany Tailscale nie daje wlasciciela', () => {
  const s = parseStatus({ BackendState: 'NeedsLogin', Self: {} })
  assert.equal(s.ownerLogin, null)
  assert.equal(s.dnsName, null)
})

test('serve: wolny, nasz, cudzy i przekierowanie TCP', () => {
  const ours = 'http://127.0.0.1:19390'
  assert.deepEqual(servePortState('', 443, ours), { state: 'free' })
  assert.deepEqual(servePortState({ Web: { 'pc.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:19390/' } } } } }, 443, ours), { state: 'ours' })
  assert.equal(servePortState({ Web: { 'pc.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } }, 443, ours).state, 'other')
  assert.equal(servePortState({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }, 443, ours).state, 'other')
  assert.deepEqual(servePortState({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } }, 443, ours), { state: 'free' })
})
