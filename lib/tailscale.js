/**
 * Obsluga Tailscale CLI: wlasciciel wezla, adres MagicDNS i konfiguracja `tailscale serve`.
 * Nigdy nie uzywa `funnel` (publiczny internet) i nigdy nie nadpisuje cudzego wpisu serve
 * na tym samym porcie HTTPS.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe'

/** Sciezka do CLI Tailscale albo null, gdy Tailscale nie jest zainstalowany. */
export function findCli(env = process.env) {
  if (env.DSH_TAILSCALE_CLI) return env.DSH_TAILSCALE_CLI
  if (process.platform === 'win32') return existsSync(WINDOWS_CLI) ? WINDOWS_CLI : 'tailscale'
  return 'tailscale'
}

/**
 * Uruchamia CLI Tailscale bez okna konsoli (rodzic to Electron bez konsoli).
 * @returns {Promise<string>} stdout
 */
export function run(cli, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${cli} ${args.join(' ')}: ${(stderr || error.message).trim()}`
        reject(error)
      } else resolve(stdout)
    })
  })
}

/**
 * Stan wezla z `tailscale status --json`.
 * @returns {{ backendState: string, ownerLogin: string | null, dnsName: string | null }}
 */
export function parseStatus(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json
  const self = s.Self ?? {}
  const user = s.User?.[String(self.UserID)] ?? null
  const dns = typeof self.DNSName === 'string' && self.DNSName.length > 0 ? self.DNSName.replace(/\.$/, '') : null
  return { backendState: s.BackendState ?? 'Unknown', ownerLogin: user?.LoginName ?? null, dnsName: dns }
}

export async function status(cli) {
  return parseStatus(await run(cli, ['status', '--json']))
}

/**
 * Co dzis obsluguje dany port HTTPS w `tailscale serve status --json`.
 * @returns {{ state: 'free' } | { state: 'ours' } | { state: 'other', proxy: string }}
 */
export function servePortState(json, httpsPort, ourTarget) {
  const s = typeof json === 'string' ? (json.trim() ? JSON.parse(json) : {}) : json
  const web = s.Web ?? {}
  for (const [hostPort, cfg] of Object.entries(web)) {
    if (!hostPort.endsWith(`:${httpsPort}`)) continue
    const handlers = cfg?.Handlers ?? {}
    const root = handlers['/']
    const proxy = root?.Proxy ?? Object.values(handlers).map((h) => h?.Proxy ?? h?.Path ?? h?.Text).find(Boolean) ?? 'inny wpis'
    return normalizeTarget(proxy) === normalizeTarget(ourTarget) ? { state: 'ours' } : { state: 'other', proxy }
  }
  if (s.TCP?.[String(httpsPort)]) return { state: 'other', proxy: 'przekierowanie TCP' }
  return { state: 'free' }
}

function normalizeTarget(t) {
  return String(t).replace(/\/+$/, '').replace('localhost', '127.0.0.1').toLowerCase()
}

/**
 * Publikuje brame w sieci Tailscale, jesli port HTTPS jest wolny albo juz nasz.
 * @returns {Promise<{ changed: boolean, state: string, detail?: string }>}
 */
export async function ensureServe(cli, httpsPort, gatewayPort) {
  const ourTarget = `http://127.0.0.1:${gatewayPort}`
  const current = servePortState(await run(cli, ['serve', 'status', '--json']), httpsPort, ourTarget)
  if (current.state === 'ours') return { changed: false, state: 'ours' }
  if (current.state === 'other') return { changed: false, state: 'other', detail: current.proxy }
  await run(cli, ['serve', '--bg', `--https=${httpsPort}`, ourTarget])
  return { changed: true, state: 'ours' }
}
