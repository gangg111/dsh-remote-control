/**
 * Nadzor nad bin/dsh-tsnet.exe (wbudowany wezel Tailscale, tryb domyslny na Windows).
 * Uruchamia proces bez okna, czyta jego stan (linie JSON), otwiera przegladarke na stronie logowania
 * Tailscale raz na kazdy nowy link, wznawia proces po awarii z rosnacym odstepem i zamyka go
 * zamknieciem stdin (proces konczy sie sam).
 */

import { spawn } from 'node:child_process'

const MAX_BACKOFF_MS = 60_000

/**
 * @param {object} opts
 * @param {string} opts.exe - sciezka do dsh-tsnet.exe
 * @param {string[]} [opts.args] - argumenty procesu (dsh-tsnet ich nie potrzebuje; uzywane w testach)
 * @param {Record<string, string>} opts.env - DSH_RC_STATE_DIR, DSH_RC_HOSTNAME, DSH_RC_GATEWAY, DSH_RC_SECRET
 * @param {(event: object) => void} opts.onEvent - zdarzenia stanu i bledow
 * @param {(url: string) => void} [opts.openUrl] - otwarcie linku logowania (domyslnie przegladarka systemowa)
 * @returns {{ stop: () => void }}
 */
export function superviseTsnet(opts) {
  const openUrl = opts.openUrl ?? openInBrowser
  let child = null
  let stopped = false
  let backoff = 2000
  let timer = null
  let openedAuthURL = null

  function start() {
    if (stopped) return
    const startedAt = Date.now()
    child = spawn(opts.exe, opts.args ?? [], { env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let pending = ''
    child.stdout.on('data', (chunk) => {
      pending += chunk
      let i
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim()
        pending = pending.slice(i + 1)
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === 'state' && event.backendState === 'NeedsLogin' && event.authURL && event.authURL !== openedAuthURL) {
          openedAuthURL = event.authURL
          try { openUrl(event.authURL) } catch {}
        }
        opts.onEvent(event)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', (error) => opts.onEvent({ type: 'error', message: `nie uruchomiono ${opts.exe}: ${error.message}` }))
    child.on('exit', (code) => {
      child = null
      if (stopped) return
      if (Date.now() - startedAt > 30_000) backoff = 2000
      opts.onEvent({ type: 'exit', code, retryInMs: backoff })
      timer = setTimeout(start, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    })
  }

  start()
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      if (child) {
        child.stdin.end()
        const c = child
        setTimeout(() => { if (c.exitCode === null) c.kill() }, 3000).unref?.()
      }
    },
  }
}

/** Domyslna przegladarka na Windows bez okna konsoli (rundll32 to program GUI). */
function openInBrowser(url) {
  if (process.platform !== 'win32') return
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
