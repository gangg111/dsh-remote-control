// Czesc przegladarkowa dsh-remote-control (format ladowarki modulow klienta DSH).
//
// 1. Telefon otwiera sesje adresem https://<komputer>/?dshOpen=<id>: po starcie interfejsu wybieramy
//    te sesje przez oficjalne ctx.uiWorkspace.openSession i usuwamy parametr z adresu.
// 2. Ikona „Eksportuj na telefon” w przyciskach wiersza sesji (slot
//    `sidebar.workspaces.session.row.action`): dodaje sesje do skrzynki nadawczej bramy
//    (POST /api/dsh-remote-control/outbox), telefon odbiera ja sam. Stany: zwykla, „czeka na telefon”
//    (klikniecie anuluje), „odebrane”. Jeden wspolny odczyt skrzynki co 5 s dla wszystkich wierszy.
window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/dsh-remote-control/outbox'
    const POLL_MS = 5000

    const COPY = {
      pl: { send: 'Eksportuj na telefon', waiting: 'Czeka na telefon (kliknij, aby anulować)', received: 'Odebrane przez telefon (kliknij, aby wysłać ponownie)', failed: 'Nie udało się dodać do wysyłki na telefon' },
      en: { send: 'Export to phone', waiting: 'Waiting for the phone (click to cancel)', received: 'Received by the phone (click to send again)', failed: 'Could not queue the session for the phone' },
    }
    const copy = () => ((document.documentElement.lang || '').toLowerCase().startsWith('pl') ? COPY.pl : COPY.en)

    /** Wspolny stan skrzynki: sessionId -> wpis; odczyt tylko, gdy jakis wiersz jest zamontowany. */
    const store = (() => {
      let bySession = new Map()
      const listeners = new Set()
      let timer = null
      const notify = () => { for (const l of listeners) l() }
      async function refresh() {
        try {
          const res = await fetch(API, { credentials: 'same-origin', cache: 'no-store' })
          if (!res.ok) return
          const { items } = await res.json()
          const next = new Map()
          for (const item of items) next.set(item.sessionId, item)
          bySession = next
          notify()
        } catch (error) {
          console.warn('[dsh-remote-control] outbox', error)
        }
      }
      return {
        refresh,
        get: (sessionId) => bySession.get(sessionId),
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) { void refresh(); timer = window.setInterval(refresh, POLL_MS) }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && timer !== null) { window.clearInterval(timer); timer = null }
          }
        },
        snapshot: () => bySession,
      }
    })()

    async function call(method, path, body) {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** Telefon ze strzalka (stan zwykly), ten sam telefon w akcencie (czeka), telefon z haczykiem (odebrane). */
    function PhoneIcon({ state }) {
      const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
      const body = h('rect', { x: 3.5, y: 1.5, width: 9, height: 13, rx: 1.8 })
      const speaker = h('path', { d: 'M7 3.6h2' })
      const mark = state === 'received'
        ? h('path', { d: 'M5.8 8.4l1.6 1.6 2.9-3.2' })
        : h('path', { d: 'M8 5.6v5M5.9 8.6L8 10.7l2.1-2.1' })
      return h('svg', common, body, speaker, mark)
    }

    function ExportToPhoneButton({ sessionId, displayTitle }) {
      const t = copy()
      const entries = React.useSyncExternalStore(store.subscribe, store.snapshot)
      const item = entries.get(sessionId)
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const state = item?.state === 'waiting' ? 'waiting' : item?.state === 'received' ? 'received' : 'idle'
      const label = state === 'waiting' ? t.waiting : state === 'received' ? t.received : t.send
      async function onClick(event) {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        try {
          if (state === 'waiting') await call('DELETE', `${API}/${item.transferId}`)
          else await call('POST', API, { sessionId, title: displayTitle })
          await store.refresh()
        } catch (error) {
          console.warn('[dsh-remote-control] export', error)
          window.alert(t.failed)
        } finally {
          setBusy(false)
        }
      }
      const color = state === 'waiting'
        ? 'var(--dsw-alias-state-business-primary)'
        : hover ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)'
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-pressed': state === 'waiting',
        disabled: busy,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, padding: 0, border: 'none', borderRadius: 'var(--dsw-radius-xs)',
          background: 'transparent', cursor: busy ? 'progress' : 'pointer', color, opacity: busy ? 0.5 : 1,
        },
      }, h(PhoneIcon, { state }))
    }

    function openFromAddress(ctx) {
      const params = new URLSearchParams(window.location.search)
      const sessionId = params.get('dshOpen')
      if (!sessionId) return
      params.delete('dshOpen')
      const rest = params.toString()
      window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash)
      // Odtwarzanie ostatniej sesji przy starcie moze nadpisac wybor, wiec wybieramy jeszcze raz chwile pozniej.
      const open = () => { try { ctx.uiWorkspace.openSession(sessionId) } catch (error) { console.warn('[dsh-remote-control] openSession', error) } }
      open()
      const timer = window.setTimeout(open, 1200)
      ctx.effect(() => () => window.clearTimeout(timer), 'dsh-remote-control: deferred open')
    }

    return {
      inject: ['uiWorkspace', 'slots'],
      apply(ctx) {
        openFromAddress(ctx)
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 'dsh-remote-control.export-to-phone', order: 50 },
          ExportToPhoneButton,
        ))
      },
    }
  },
})
