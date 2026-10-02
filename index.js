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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './lib/api.js'
import { superviseTsnet } from './lib/embedded.js'
import { createGateway } from './lib/gateway.js'
import * as tailscale from './lib/tailscale.js'

export const name = 'dsh-remote-control'
export const inject = ['connection', 'webServer']

const OWNER_CACHE_MS = 60_000
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

  ctx.effect(() => {
    const gateway = createGateway({
      targetPort: () => ctx.webServer.port,
      authenticatedUrl: () => ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`),
      admit,
      secret,
      api: createApi({ get: (service) => ctx.get(service), log }),
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
