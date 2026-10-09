/**
 * dsh-remote-control: zdalne sterowanie DeepSeek Harness z telefonu przez Tailscale.
 *
 * Wtyczka dziala w procesie serwera DSH (profil desktop albo web). Uruchamia brame na
 * 127.0.0.1:<port> i wystawia ja w sieci Tailscale na jeden z dwoch sposobow:
 * - embedded (domyslnie na Windows): wbudowany wezel bin/dsh-tsnet.exe (biblioteka tsnet), bez
 *   instalowania Tailscale, bez VPN i bez uprawnien administratora; tozsamosc z WhoIs, do bramy
 *   razem z sekretem biezacego startu;
 * - system: zainstalowany Tailscale i `tailscale serve`.
 * Wpuszcza tylko wlasciciela wezla (albo allowedLogins). Logowanie do DSH robi oficjalnym
 * `ctx.connection.authenticatedUrl`. Stan zapisuje w $DSH_HOME/remote-control.json.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './lib/api.js'
import { installArchiveGuard } from './lib/archive-guard.js'
import { superviseTsnet } from './lib/embedded.js'
import { createGateway } from './lib/gateway.js'
import { createLinkApi } from './lib/link-api.js'
import { createLinks } from './lib/links.js'
import { createOutbox } from './lib/outbox.js'
import * as tailscale from './lib/tailscale.js'
import { guardTurnStart } from './lib/sync.js'
import { createDshClient } from './lib/transfer.js'

/** Trasy ikon „Eksportuj na telefon” na serwerze DSH (ta sama sesja co interfejs). */
const UI_PREFIX = '/api/dsh-remote-control'

export const name = 'dsh-remote-control'
export const inject = ['connection', 'webServer']

const OWNER_CACHE_MS = 60_000
/**
 * Wersje DSH, na ktorych przeszedl test przejecia na prawdziwym DSH. reloadSession i bramka tury
 * opieraja sie na wnetrzu agenta DSH (licznik tur w `phase`), wiec na innej wersji synchronizacja
 * jest wylaczona, dopoki test nie przejdzie i wersja nie trafi na te liste.
 */
const SYNC_TESTED_DSH = ['0.2.0-rc.2']
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ mode?: 'embedded' | 'system', hostname?: string, port?: number, httpsPort?: number, allowedLogins?: string[], manageServe?: boolean, openBrowser?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const port = config.port ?? 19390
  const exe = join(PLUGIN_DIR, 'bin', 'dsh-tsnet.exe')
  const mode = config.mode ?? (process.platform === 'win32' && existsSync(exe) ? 'embedded' : 'system')
  const explicit = (config.allowedLogins ?? []).map((l) => String(l).toLowerCase())
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const statusFile = join(home, 'remote-control.json')
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m) }

  const state = { mode, gatewayPort: port, url: null, owner: null, backendState: null, loginURL: null, serve: null, allowedLogins: explicit, error: null, updatedAt: null }
  const writeState = () => {
    state.updatedAt = new Date().toISOString()
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(statusFile, JSON.stringify(state, null, 2) + '\n')
    } catch (error) {
      log.warn(`[dsh-remote-control] nie zapisano ${statusFile}: ${error.message}`)
    }
  }

  let ownerLogin = null
  const secret = mode === 'embedded' ? randomBytes(32).toString('base64url') : undefined
  let refreshSystemOwner = async () => {}
  let ownerAt = 0
  const admit = (login) => {
    const l = login.toLowerCase()
    if (explicit.length > 0) return explicit.includes(l)
    if (mode === 'system' && Date.now() - ownerAt > OWNER_CACHE_MS) void refreshSystemOwner().then(writeState)
    return ownerLogin !== null && l === ownerLogin
  }

  const outbox = createOutbox(join(home, 'remote-control-outbox.json'))
  const authenticatedUrl = () => ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  const dsh = createDshClient({ port: () => ctx.webServer.port, authenticatedUrl })
  const links = createLinks(join(home, 'remote-control-links.json'))
  const dshVersion = readDshVersion()
  const syncEnabled = SYNC_TESTED_DSH.includes(dshVersion)
  const linkApi = createLinkApi({
    get: (service) => ctx.get(service), links, log, enabled: syncEnabled,
    disabledReason: `Synchronizacja sesji nie jest sprawdzona na DSH ${dshVersion ?? '(nieznana wersja)'}; wylaczona do aktualizacji wtyczki.`,
  })

  // Archiwizacja sesji powiazanej: okno DSH pokazuje synchronizacje jako prace w toku, a zatrzymanie ja odlacza.
  installArchiveGuard(ctx, links, log)

  // Bramka tury w sesjach powiazanych (przed zapisem `turn/start`, patrz guardTurnStart):
  // - lustro: kazda tura jest przerywana (pisze sie na drugim urzadzeniu), dotyczy kazdego klienta;
  // - wlasciciel: tura z numerem innym niz ostatnia tura w logu + 1 jest przerywana, a powiazanie
  //   wstrzymane z bledem (licznik agenta jest juz wyrownany, wiec `resume` i ponowne wyslanie dzialaja).
  ctx.on('agent/status', (payload) => {
    const stopped = guardTurnStart((service) => ctx.get(service), payload, links.pcRole)
    if (!stopped || stopped.reason === 'mirror') return
    const link = links.byPcSession(stopped.sessionId)
    const message = stopped.reason === 'unknown'
      ? 'Nieznany stan agenta DSH (zmienione wnetrze DSH); tura przerwana, nic nie zapisano.'
      : `Tura agenta PC miala numer ${stopped.actual + 1}, a w logu ostatnia jest ${stopped.expected}; tura przerwana, nic nie zapisano.`
    log.warn(`[dsh-remote-control] ${message}`)
    if (link) links.pause(link.linkId, message)
  })

  /** Usuwa katalog sesji, ktorej DSH nie przyjal przy kontrolnym odczycie po imporcie. */
  async function removeSession(id) {
    const root = join(home, 'sessions')
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = join(root, project.name, id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: UI_PREFIX,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) return sendJson(res, admission.rejection, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://local')
      const path = url.pathname.slice(UI_PREFIX.length)
      try {
        if (req.method === 'GET' && path === '/outbox') return sendJson(res, 200, { items: outbox.list() })
        if (req.method === 'POST' && path === '/outbox') {
          const body = JSON.parse((await readSmallBody(req)) || '{}')
          return sendJson(res, 200, outbox.add(body.sessionId, body.title))
        }
        const m = /^\/outbox\/([0-9a-f-]{36})$/.exec(path)
        if (m && req.method === 'DELETE') return sendJson(res, 200, { removed: outbox.remove(m[1]) })
        if ((await linkApi.ui(req, res, path)) !== false) return
        return sendJson(res, 404, { error: 'nieznana sciezka' })
      } catch (error) {
        return sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-remote-control: outbox routes')

  ctx.effect(() => {
    const gateway = createGateway({
      targetPort: () => ctx.webServer.port,
      authenticatedUrl,
      admit,
      secret,
      api: createApi({
        get: (service) => ctx.get(service),
        log,
        outbox,
        dsh,
        emit: (event, payload) => ctx.emit(event, payload),
        removeSession,
        dshVersion,
        linkApi,
        syncEnabled,
      }),
      log,
    })
    let tsnet = null
    gateway.server.on('error', (error) => {
      state.error = `Brama nie wystartowala na 127.0.0.1:${port}: ${error.message}`
      log.warn(`[dsh-remote-control] ${state.error}`)
      writeState()
    })
    gateway.server.listen(port, '127.0.0.1', async () => {
      log.info(`[dsh-remote-control] brama na 127.0.0.1:${port} (tryb ${mode}) -> DSH 127.0.0.1:${ctx.webServer.port}`)
      if (mode === 'embedded') tsnet = startEmbedded()
      else await startSystem()
      writeState()
    })
    return () => {
      tsnet?.stop()
      return gateway.close()
    }
  }, 'dsh-remote-control: gateway')

  function startEmbedded() {
    return superviseTsnet({
      exe,
      ...(config.openBrowser === false ? { openUrl: () => {} } : {}),
      env: {
        DSH_RC_STATE_DIR: join(home, 'remote-control', 'tsnet'),
        DSH_RC_HOSTNAME: config.hostname ?? 'dsh-pc',
        DSH_RC_GATEWAY: `127.0.0.1:${port}`,
        DSH_RC_SECRET: secret,
      },
      onEvent(event) {
        if (event.type === 'state') {
          state.backendState = event.backendState
          state.loginURL = event.backendState === 'NeedsLogin' ? event.authURL || null : null
          ownerLogin = event.owner ? String(event.owner).toLowerCase() : null
          state.owner = event.owner ?? null
          state.url = event.dnsName ? `https://${event.dnsName}/` : null
          state.error = event.backendState === 'NeedsLogin' ? 'Zaloguj komputer do Tailscale: link w loginURL (otwiera się też sam w przeglądarce).' : null
          if (event.backendState === 'Running' && event.magicDNS === false) state.error = 'Włącz MagicDNS w panelu Tailscale.'
        } else if (event.type === 'cert') {
          state.cert = event.ok ? { ok: true, domain: event.domain } : { ok: false, domain: event.domain, message: event.message, at: new Date().toISOString() }
          if (!event.ok) log.warn(`[dsh-remote-control] certyfikat ${event.domain}: ${event.message}`)
        } else if (event.type === 'httpError') {
          state.lastHttpError = { message: event.message, at: new Date().toISOString() }
        } else if (event.type === 'error') {
          state.error = event.message
          log.warn(`[dsh-remote-control] dsh-tsnet: ${event.message}`)
        } else if (event.type === 'exit') {
          state.backendState = 'stopped'
          log.warn(`[dsh-remote-control] dsh-tsnet zakonczony (kod ${event.code}), ponowienie za ${event.retryInMs} ms`)
        } else return
        writeState()
        if (event.type === 'state' && event.backendState === 'Running' && state.url) log.info(`[dsh-remote-control] adres dla telefonu: ${state.url}`)
      },
    })
  }

  async function startSystem() {
    const cli = tailscale.findCli()
    const httpsPort = config.httpsPort ?? 443
    refreshSystemOwner = async () => {
      try {
        const s = await tailscale.status(cli)
        ownerLogin = s.ownerLogin?.toLowerCase() ?? null
        state.owner = s.ownerLogin
        state.backendState = s.backendState
        state.url = s.dnsName ? `https://${s.dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}/` : null
        state.error = s.backendState === 'Running' ? null : `Tailscale nie dziala (stan: ${s.backendState})`
      } catch (error) {
        ownerLogin = null
        state.error = `Brak Tailscale albo CLI nie odpowiada: ${error.message}`
      }
      ownerAt = Date.now()
    }
    await refreshSystemOwner()
    if ((config.manageServe ?? true) && !state.error) {
      try {
        const r = await tailscale.ensureServe(cli, httpsPort, port)
        state.serve = r.state === 'other' ? `port ${httpsPort} zajety przez: ${r.detail}; ustaw inny httpsPort` : (r.changed ? 'wlaczono' : 'juz aktywne')
      } catch (error) {
        state.serve = `blad: ${error.message}`
      }
    }
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readSmallBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(Object.assign(new Error('za duze zadanie'), { status: 413 })); req.destroy() } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Wersja DSH z runtime.json instalacji (Electron: process.resourcesPath), albo undefined. */
function readDshVersion() {
  try {
    const base = process.resourcesPath ?? ''
    return JSON.parse(readFileSync(join(base, 'runtime', 'primary-runtime', 'runtime.json'), 'utf8')).desktopVersion
  } catch {
    return undefined
  }
}
