/**
 * Brama HTTP/WebSocket przed serwerem DSH, publikowana w sieci Tailscale przez `tailscale serve`.
 *
 * Kontrakt bezpieczenstwa:
 * - nasluchuje tylko na 127.0.0.1; do sieci wystawia ja wylacznie `tailscale serve` (TLS + naglowek
 *   Tailscale-User-Login, ktory serve nadpisuje, wiec klient go nie sfalszuje);
 * - wpuszcza tylko zadania z tozsamoscia, ktora przechodzi `admit(login)`; brak tozsamosci = 403;
 * - ZANIM cokolwiek przepisze, sprawdza zewnetrzne Origin i sec-fetch-site (ochrona przed CSRF
 *   z innych stron otwartych na telefonie), a dopiero potem podmienia Host/Origin/Referer na adres
 *   petli zwrotnej, wiec wlasna zapora DSH (Host/Origin, DNS rebinding) dziala bez zmian;
 * - token startowy DSH nigdy nie opuszcza komputera: wymiane token -> ciasteczko robi brama
 *   i oddaje telefonowi tylko ciasteczko (z dopisana flaga Secure).
 */

import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

const SESSION_COOKIE_PREFIX = 'dsh-auth-'
const LOOP_COOKIE = 'dshr-login'
const IDENTITY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-headers-info', 'x-dsh-rc-secret']
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']

/**
 * Tworzy brame (jeszcze nie nasluchuje).
 * @param {object} opts
 * @param {string} [opts.targetHost] - adres serwera DSH (petla zwrotna).
 * @param {() => number} opts.targetPort - port serwera DSH, czytany przy kazdym zadaniu.
 * @param {() => string} opts.authenticatedUrl - zwraca adres logowania DSH z tokenem startowym.
 * @param {(login: string) => boolean} opts.admit - czy wpuscic dana tozsamosc Tailscale.
 * @param {string} [opts.secret] - wymagany X-Dsh-Rc-Secret (tryb wbudowany dsh-tsnet); bez niego 403.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>} [opts.api]
 *   - obsluga sciezek /__remote/* po bramie tozsamosci; true = obsluzone, nie przekazuj do DSH.
 * @param {{ info: Function, warn: Function }} [opts.log]
 * @returns {{ server: http.Server, close: () => Promise<void> }}
 */
export function createGateway(opts) {
  const targetHost = opts.targetHost ?? '127.0.0.1'
  const log = opts.log ?? { info() {}, warn() {} }
  const target = () => `${targetHost}:${opts.targetPort()}`
  const upgraded = new Set()

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log.warn(`[dsh-remote-control] blad przekazania ${req.method} ${req.url}: ${error?.message ?? error}`)
      if (!res.headersSent) sendText(res, 502, 'Brama nie dostala odpowiedzi od DeepSeek Harness.')
      else res.destroy()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    try { handleUpgrade(req, socket, head) } catch (error) {
      log.warn(`[dsh-remote-control] blad WebSocket ${req.url}: ${error?.message ?? error}`)
      socket.destroy()
    }
  })

  /** Brama tozsamosci i zewnetrzna zapora CSRF; zwraca null albo [status, komunikat]. */
  function gate(req) {
    // Tryb wbudowany (dsh-tsnet): tozsamosc przyjmujemy tylko od procesu, ktory zna sekret biezacego startu.
    if (opts.secret && !secretMatches(header(req, 'x-dsh-rc-secret'), opts.secret)) return [403, 'Zadanie nie przyszlo przez wbudowany wezel Tailscale.']
    const login = header(req, 'tailscale-user-login')
    if (!login) return [403, 'Brak tozsamosci Tailscale. Wejdz przez adres https z tailscale serve.']
    if (!opts.admit(login)) return [403, `Konto Tailscale ${login} nie ma dostepu do tego komputera.`]
    const host = header(req, 'host')
    if (!host) return [400, 'Brak naglowka Host.']
    if (header(req, 'sec-fetch-site') === 'cross-site') return [403, 'Zadanie z obcej strony odrzucone.']
    const origin = header(req, 'origin')
    if (origin && origin !== `https://${host}` && origin !== `http://${host}`) return [403, 'Niezgodny naglowek Origin.']
    return null
  }

  /** Naglowki dla DSH: adres petli zwrotnej zamiast zewnetrznego, bez tozsamosci i X-Forwarded. */
  function forwardHeaders(req, { keepUpgrade }) {
    const out = []
    const t = target()
    const raw = req.rawHeaders
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i]
      const lower = name.toLowerCase()
      let value = raw[i + 1]
      if (lower === 'host' || IDENTITY_HEADERS.includes(lower) || FORWARDED.includes(lower)) continue
      if (!keepUpgrade && HOP_BY_HOP.includes(lower)) continue
      if (lower === 'origin') value = `http://${t}`
      if (lower === 'referer') value = value.replace(/^https?:\/\/[^/]+/i, `http://${t}`)
      out.push([name, value])
    }
    out.unshift(['Host', t])
    return out
  }

  /** Naglowki odpowiedzi dla telefonu: Secure na ciasteczkach, adresy petli zwrotnej jako sciezki. */
  function backwardHeaders(headers) {
    const out = {}
    const t = target()
    for (const [name, value] of Object.entries(headers)) {
      if (HOP_BY_HOP.includes(name)) continue
      if (name === 'set-cookie') out[name] = value.map(secureCookie)
      else if (name === 'location' && typeof value === 'string') out[name] = value.replace(new RegExp(`^https?://${escapeRegExp(t)}`, 'i'), '') || '/'
      else out[name] = value
    }
    return out
  }

  async function handleHttp(req, res) {
    const denied = gate(req)
    if (denied) return sendText(res, denied[0], denied[1])
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (url.pathname.startsWith('/__remote/') && opts.api && await opts.api(req, res, url)) return
    const isIndex = req.method === 'GET' && url.pathname === '/'
    const pres = await forward(req)
    if (isIndex && pres.statusCode === 401) {
      pres.resume()
      return login(req, res)
    }
    res.writeHead(pres.statusCode ?? 502, backwardHeaders(pres.headers))
    pres.pipe(res)
  }

  function forward(req) {
    return new Promise((resolve, reject) => {
      const headers = {}
      for (const [k, v] of forwardHeaders(req, { keepUpgrade: false })) appendHeader(headers, k, v)
      const preq = http.request({ host: targetHost, port: opts.targetPort(), method: req.method, path: req.url, headers })
      preq.on('response', resolve)
      preq.on('error', reject)
      req.pipe(preq)
    })
  }

  /** Wymiana tokena startowego na ciasteczko po stronie komputera; telefon dostaje tylko ciasteczko. */
  async function login(req, res) {
    if (hasCookie(req, LOOP_COOKIE)) {
      return sendText(res, 401, 'Logowanie nie powiodlo sie: przegladarka nie zapisala ciasteczka sesji. Sprawdz, czy WebView przyjmuje ciasteczka.')
    }
    const launch = new URL(opts.authenticatedUrl())
    const pres = await new Promise((resolve, reject) => {
      const r = http.request({ host: targetHost, port: opts.targetPort(), method: 'GET', path: launch.pathname + launch.search, headers: { Host: target() } })
      r.on('response', resolve)
      r.on('error', reject)
      r.end()
    })
    pres.resume()
    const cookies = (pres.headers['set-cookie'] ?? []).filter((c) => c.startsWith(SESSION_COOKIE_PREFIX))
    if (pres.statusCode !== 303 || cookies.length === 0) {
      log.warn(`[dsh-remote-control] DSH nie wydal sesji (status ${pres.statusCode})`)
      return sendText(res, 502, 'DeepSeek Harness odmowil wydania sesji.')
    }
    // Parametry adresu (np. ?dshOpen=<sesja>) przezywaja logowanie; samego tokena tu nigdy nie ma.
    const params = new URL(req.url ?? '/', 'http://gateway.invalid').searchParams
    params.delete('token')
    const query = params.toString()
    res.writeHead(303, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'location': query ? `./?${query}` : './',
      'set-cookie': [...cookies.map(secureCookie), `${LOOP_COOKIE}=1; Max-Age=30; Path=/; HttpOnly; Secure; SameSite=Strict`],
    })
    res.end()
    log.info(`[dsh-remote-control] wydano sesje dla ${header(req, 'tailscale-user-login')}`)
  }

  function handleUpgrade(req, socket, head) {
    const denied = gate(req)
    if (denied) {
      socket.end(`HTTP/1.1 ${denied[0]} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const upstream = net.connect(opts.targetPort(), targetHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [k, v] of forwardHeaders(req, { keepUpgrade: true })) lines.push(`${k}: ${v}`)
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upgraded.add(socket)
    upgraded.add(upstream)
    const cleanup = () => { upgraded.delete(socket); upgraded.delete(upstream); socket.destroy(); upstream.destroy() }
    socket.on('error', cleanup)
    upstream.on('error', cleanup)
    socket.on('close', cleanup)
    upstream.on('close', cleanup)
  }

  async function close() {
    for (const s of upgraded) s.destroy()
    upgraded.clear()
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { server, close }
}

function header(req, name) {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function hasCookie(req, name) {
  const c = header(req, 'cookie') ?? ''
  return c.split(';').some((part) => part.trim().startsWith(`${name}=`))
}

function appendHeader(obj, name, value) {
  const key = name.toLowerCase()
  if (obj[key] === undefined) obj[key] = value
  else if (Array.isArray(obj[key])) obj[key].push(value)
  else obj[key] = [obj[key], value]
}

function secretMatches(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function secureCookie(cookie) {
  return /;\s*secure\b/i.test(cookie) ? cookie : `${cookie}; Secure`
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
