// Testy bramy na falszywym serwerze DSH, ktory odtwarza zachowanie oryginalu (browser-auth.ts 0.1.7-rc.2):
// GET /?token=T -> 303 + dsh-auth-* (HttpOnly; SameSite=Strict), bez ciasteczka -> 401, WebSocket echo.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createGateway } from '../lib/gateway.js'

const TOKEN = 'tok-secret-123'
const COOKIE = 'dsh-auth-abc=signed'
const OWNER = 'artur@example.com'
const PHONE_HOST = 'pc.tailnet.ts.net'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function setup() {
  const seen = []
  const dsh = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    const url = new URL(req.url, 'http://x')
    const authed = (req.headers.cookie ?? '').includes(COOKIE)
    if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': [`${COOKIE}; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`] })
      return res.end()
    }
    if (!authed) { res.writeHead(401); return res.end('unauthorized') }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('INDEX') }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${dshPort}/target` }); return res.end() }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body, headers: req.headers })) })
  })
  const upgradedSockets = new Set()
  dsh.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket)
    seen.push({ upgrade: true, headers: req.headers })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  const dshPort = await listen(dsh)
  const gw = createGateway({
    targetPort: () => dshPort,
    authenticatedUrl: () => `http://127.0.0.1:${dshPort}/?token=${TOKEN}`,
    admit: (login) => login.toLowerCase() === OWNER,
  })
  const gwPort = await listen(gw.server)
  // Gniazda po upgrade nie podlegaja closeAllConnections(), wiec falszywy DSH zamyka je sam.
  return { seen, dshPort, gwPort, async close() { await gw.close(); for (const s of upgradedSockets) s.destroy(); dsh.closeAllConnections(); await new Promise((r) => dsh.close(r)) } }
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: PHONE_HOST, ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const id = { 'tailscale-user-login': OWNER }

test('bez tozsamosci Tailscale: 403', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort)
  assert.equal(r.status, 403)
  assert.equal(s.seen.length, 0, 'zadanie nie moze dotrzec do DSH')
})

test('tryb wbudowany: bez poprawnego sekretu 403, z sekretem wpuszcza, sekret nie trafia do DSH', async (t) => {
  const { createGateway: make } = await import('../lib/gateway.js')
  const s = await setup(); t.after(() => s.close())
  const gw = make({ targetPort: () => s.dshPort, authenticatedUrl: () => '', admit: (l) => l === OWNER, secret: 's3cret-0123456789' })
  const port = await listen(gw.server); t.after(() => gw.close())
  const bad = await request(port, { headers: { ...id, 'x-dsh-rc-secret': 'zly' } })
  const none = await request(port, { headers: id })
  assert.equal(bad.status, 403)
  assert.equal(none.status, 403)
  assert.equal(s.seen.length, 0)
  const ok = await request(port, { headers: { ...id, 'x-dsh-rc-secret': 's3cret-0123456789', cookie: COOKIE } })
  assert.equal(ok.status, 200)
  assert.equal(s.seen.at(-1).headers['x-dsh-rc-secret'], undefined)
})

test('obce konto Tailscale: 403', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { headers: { 'tailscale-user-login': 'obcy@example.com' } })
  assert.equal(r.status, 403)
  assert.equal(s.seen.length, 0)
})

test('zadanie z obcej strony (sec-fetch-site: cross-site) i obcy Origin: 403', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const a = await request(s.gwPort, { method: 'POST', path: '/api/x', headers: { ...id, 'sec-fetch-site': 'cross-site' } })
  const b = await request(s.gwPort, { method: 'POST', path: '/api/x', headers: { ...id, origin: 'https://zla.strona' } })
  assert.equal(a.status, 403)
  assert.equal(b.status, 403)
  assert.equal(s.seen.length, 0)
})

test('logowanie: token zostaje na komputerze, telefon dostaje tylko ciasteczko z Secure', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { headers: id })
  assert.equal(r.status, 303)
  assert.equal(r.headers.location, './')
  assert.ok(!JSON.stringify(r.headers).includes(TOKEN), 'token nie moze trafic do telefonu')
  const session = r.headers['set-cookie'].find((c) => c.startsWith('dsh-auth-'))
  assert.match(session, /; Secure$/)
  assert.match(session, /HttpOnly; SameSite=Strict/)
  assert.ok(r.headers['set-cookie'].some((c) => c.startsWith('dshr-login=')))
  const tokenReq = s.seen.find((x) => x.url?.includes('token='))
  assert.equal(tokenReq.headers.host, `127.0.0.1:${s.dshPort}`, 'wymiana tokena idzie na adres petli zwrotnej')
})

test('logowanie zachowuje ?dshOpen, zeby po zalogowaniu otworzyla sie wskazana sesja', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { path: '/?dshOpen=sesja-42', headers: id })
  assert.equal(r.status, 303)
  assert.equal(r.headers.location, './?dshOpen=sesja-42')
})

test('z ciasteczkiem: interfejs, a DSH widzi adres petli zwrotnej bez tozsamosci i X-Forwarded', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { headers: { ...id, cookie: COOKIE, origin: `https://${PHONE_HOST}`, 'x-forwarded-for': '100.64.0.2' } })
  assert.equal(r.status, 200)
  assert.equal(r.body, 'INDEX')
  const h = s.seen.at(-1).headers
  assert.equal(h.host, `127.0.0.1:${s.dshPort}`)
  assert.equal(h.origin, `http://127.0.0.1:${s.dshPort}`)
  assert.equal(h['tailscale-user-login'], undefined)
  assert.equal(h['x-forwarded-for'], undefined)
})

test('petla logowania przerwana, gdy telefon nie zapisal ciasteczka', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { headers: { ...id, cookie: 'dshr-login=1' } })
  assert.equal(r.status, 401)
  assert.match(r.body, /ciasteczka/)
})

test('API: tresc POST, Referer przepisany, Location z petli zwrotnej jako sciezka', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const r = await request(s.gwPort, { method: 'POST', path: '/api/echo', body: '{"a":1}', headers: { ...id, cookie: COOKIE, 'content-type': 'application/json', origin: `https://${PHONE_HOST}`, referer: `https://${PHONE_HOST}/sesja/1` } })
  assert.equal(r.status, 200)
  const echo = JSON.parse(r.body)
  assert.equal(echo.body, '{"a":1}')
  assert.equal(echo.headers.referer, `http://127.0.0.1:${s.dshPort}/sesja/1`)
  const red = await request(s.gwPort, { path: '/redirect', headers: { ...id, cookie: COOKIE } })
  assert.equal(red.status, 302)
  assert.equal(red.headers.location, '/target')
})

test('WebSocket: tozsamosc wymagana, naglowki przepisane, dane plyna w obie strony', async (t) => {
  const s = await setup(); t.after(() => s.close())
  const handshake = (headers) => new Promise((resolve) => {
    const sock = net.connect(s.gwPort, '127.0.0.1', () => {
      sock.write(['GET /api/remote.mux HTTP/1.1', `Host: ${PHONE_HOST}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...headers, '', ''].join('\r\n'))
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d
      if (buf.includes('\r\n\r\n') && !buf.includes('PING')) {
        if (buf.startsWith('HTTP/1.1 101')) sock.write('PING')
        else { sock.destroy(); resolve(buf) }
      } else if (buf.includes('PING')) { sock.destroy(); resolve(buf) }
    })
    sock.on('close', () => resolve(buf))
  })
  const denied = await handshake([])
  assert.match(denied, /^HTTP\/1\.1 403/)
  const ok = await handshake([`Tailscale-User-Login: ${OWNER}`, `Origin: https://${PHONE_HOST}`, `Cookie: ${COOKIE}`])
  assert.match(ok, /^HTTP\/1\.1 101/)
  assert.match(ok, /PING$/)
  const up = s.seen.find((x) => x.upgrade).headers
  assert.equal(up.host, `127.0.0.1:${s.dshPort}`)
  assert.equal(up.origin, `http://127.0.0.1:${s.dshPort}`)
  assert.equal(up['tailscale-user-login'], undefined)
})
