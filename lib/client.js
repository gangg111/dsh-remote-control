// Czesc przegladarkowa dsh-remote-control (format ladowarki modulow klienta DSH).
//
// 1. Telefon otwiera sesje adresem https://<komputer>/?dshOpen=<id>: po starcie interfejsu wybieramy
//    te sesje przez oficjalne ctx.uiWorkspace.openSession i usuwamy parametr z adresu.
// 2. Ikona przy wierszu sesji (`sidebar.workspaces.session.row.action`):
//    - bez powiazania: „Eksportuj na telefon” (skrzynka nadawcza; stany: czeka, odebrane);
//    - sesja powiazana z telefonem: „piszesz tutaj” albo „lustro z telefonu”; klikniecie odlacza.
// 3. Lustro tylko do odczytu: pole pisania zablokowane (`conversation.blocks`), nad nim pasek
//    `conversation.input.dock` z przyciskiem „Przejmij pisanie tutaj”; PC nie moze zawolac telefonu,
//    wiec przejecie czeka, az telefon odda pisanie; po minucie mozna przejac bez telefonu.
// Jeden wspolny odczyt skrzynki i powiazan co 5 s dla wszystkich miejsc.
window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/api/dsh-remote-control'
    const POLL_MS = 5000
    const FORCE_AFTER_MS = 60000

    const COPY = {
      pl: {
        send: 'Eksportuj na telefon', waiting: 'Czeka na telefon (kliknij, aby anulować)', received: 'Odebrane przez telefon (kliknij, aby wysłać ponownie)', failed: 'Nie udało się wykonać operacji na sesji telefonu',
        ownerHere: 'Synchronizowane z telefonem, piszesz tutaj (kliknij, aby odłączyć)', mirror: 'Lustro sesji z telefonu, tylko do odczytu (kliknij, aby odłączyć)', claiming: 'Czekam, aż telefon odda pisanie (kliknij, aby odłączyć)',
        unlinkConfirm: 'Odłączyć synchronizację z telefonem? Obie kopie zostaną, ale przestaną się aktualizować.',
        blocked: 'Ta sesja jest lustrem rozmowy z telefonu. Przejmij pisanie, aby kontynuować tutaj.',
        bannerMirror: 'Lustro sesji z telefonu: nowe tury pojawiają się tu same.', claim: 'Przejmij pisanie tutaj',
        bannerClaiming: 'Czekam, aż telefon dokończy turę i odda pisanie…', force: 'Przejmij bez telefonu',
        forceConfirm: 'Telefon nie odpowiada. Przejąć pisanie bez niego? To, co napiszesz w międzyczasie na telefonie, trafi tam do osobnej gałęzi.',
        bannerPaused: 'Synchronizacja wstrzymana:', resume: 'Wznów synchronizację',
      },
      en: {
        send: 'Export to phone', waiting: 'Waiting for the phone (click to cancel)', received: 'Received by the phone (click to send again)', failed: 'The phone session operation failed',
        ownerHere: 'Synced with the phone, you write here (click to unlink)', mirror: 'Mirror of the phone session, read-only (click to unlink)', claiming: 'Waiting for the phone to hand over writing (click to unlink)',
        unlinkConfirm: 'Unlink from the phone? Both copies stay but stop updating.',
        blocked: 'This session mirrors a conversation on the phone. Take over writing to continue here.',
        bannerMirror: 'Mirror of the phone session: new turns appear here by themselves.', claim: 'Take over writing here',
        bannerClaiming: 'Waiting for the phone to finish its turn and hand over writing…', force: 'Take over without the phone',
        forceConfirm: 'The phone does not respond. Take over writing without it? Whatever you write on the phone meanwhile goes to a separate branch there.',
        bannerPaused: 'Sync paused:', resume: 'Resume sync',
      },
    }
    const copy = () => ((document.documentElement.lang || '').toLowerCase().startsWith('pl') ? COPY.pl : COPY.en)

    /** Wspolny stan: skrzynka (sessionId -> wpis) i powiazania (pcSessionId -> powiazanie). */
    const store = (() => {
      let state = { outbox: new Map(), links: new Map() }
      const listeners = new Set()
      let timer = null
      const notify = () => { for (const l of listeners) l() }
      async function refresh() {
        try {
          const [o, l] = await Promise.all([BASE + '/outbox', BASE + '/links'].map((u) => fetch(u, { credentials: 'same-origin', cache: 'no-store' })))
          if (!o.ok || !l.ok) return
          const outbox = new Map((await o.json()).items.map((i) => [i.sessionId, i]))
          const links = new Map((await l.json()).links.map((x) => [x.pcSessionId, x]))
          state = { outbox, links }
          notify()
        } catch (error) {
          console.warn('[dsh-remote-control] stan', error)
        }
      }
      return {
        refresh,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) { void refresh(); timer = window.setInterval(refresh, POLL_MS) }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && timer !== null) { window.clearInterval(timer); timer = null }
          }
        },
        snapshot: () => state,
      }
    })()

    async function call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** Ikona telefonu: strzalka (wyslij), haczyk (odebrane), strzalki w obie strony (powiazane), klodka (lustro). */
    function PhoneIcon({ state }) {
      const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
      const body = h('rect', { x: 3.5, y: 1.5, width: 9, height: 13, rx: 1.8 })
      const speaker = h('path', { d: 'M7 3.6h2' })
      const marks = {
        received: h('path', { d: 'M5.8 8.4l1.6 1.6 2.9-3.2' }),
        owner: h('path', { d: 'M5.6 7h4.6l-1.3-1.3M10.4 10H5.8l1.3 1.3' }),
        mirror: h('path', { d: 'M6 8.6h4v2.8H6zM6.8 8.6V7.5a1.2 1.2 0 0 1 2.4 0v1.1' }),
        claiming: h('path', { d: 'M8 6v2.7l1.6 1' }),
      }
      return h('svg', common, body, speaker, marks[state] ?? h('path', { d: 'M8 5.6v5M5.9 8.6L8 10.7l2.1-2.1' }))
    }

    function useStore() {
      return React.useSyncExternalStore(store.subscribe, store.snapshot)
    }

    function RowButton({ sessionId, displayTitle }) {
      const t = copy()
      const { outbox, links } = useStore()
      const link = links.get(sessionId)
      const item = outbox.get(sessionId)
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      let state = 'idle'
      if (link) state = link.owner === 'pc' ? 'owner' : link.claim ? 'claiming' : 'mirror'
      else if (item?.state === 'waiting') state = 'waiting'
      else if (item?.state === 'received') state = 'received'
      const label = { idle: t.send, waiting: t.waiting, received: t.received, owner: t.ownerHere, mirror: t.mirror, claiming: t.claiming }[state]
      async function onClick(event) {
        event.preventDefault()
        if (busy) return
        if (link && !window.confirm(t.unlinkConfirm)) return
        setBusy(true)
        try {
          if (link) await call('DELETE', `/links/${link.linkId}`)
          else if (state === 'waiting') await call('DELETE', `/outbox/${item.transferId}`)
          else await call('POST', '/outbox', { sessionId, title: displayTitle })
          await store.refresh()
        } catch (error) {
          console.warn('[dsh-remote-control] akcja', error)
          window.alert(t.failed)
        } finally {
          setBusy(false)
        }
      }
      const accent = state === 'waiting' || state === 'owner' || state === 'claiming'
      const color = accent ? 'var(--dsw-alias-state-business-primary)' : hover ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)'
      return h('button', {
        type: 'button', title: label, 'aria-label': label, 'aria-pressed': state !== 'idle' && state !== 'received', disabled: busy, onClick,
        onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
        style: {
          flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, padding: 0, border: 'none',
          borderRadius: 'var(--dsw-radius-xs)', background: 'transparent', cursor: busy ? 'progress' : 'pointer', color, opacity: busy ? 0.5 : 1,
        },
      }, h(PhoneIcon, { state }))
    }

    function sessionIdOf(session) {
      return session?.sessionId ?? session?.id ?? session?.header?.id
    }

    function MirrorBanner({ session }) {
      const t = copy()
      const { links } = useStore()
      const link = links.get(sessionIdOf(session))
      const [busy, setBusy] = React.useState(false)
      const [, tick] = React.useState(0)
      React.useEffect(() => {
        if (!link?.claim) return undefined
        const left = FORCE_AFTER_MS - (Date.now() - link.claim.at)
        if (left <= 0) return undefined
        const timer = window.setTimeout(() => tick((n) => n + 1), left + 50)
        return () => window.clearTimeout(timer)
      }, [link?.claim?.at])
      if (!link || (link.owner === 'pc' && !link.paused)) return null
      const claiming = Boolean(link.claim)
      const canForce = claiming && Date.now() - link.claim.at >= FORCE_AFTER_MS
      async function act(path, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return
        setBusy(true)
        try { await call('POST', `/links/${link.linkId}${path}`); await store.refresh() } catch (error) {
          console.warn('[dsh-remote-control] przejecie', error)
          window.alert(t.failed)
        } finally { setBusy(false) }
      }
      const button = (label, onClick, primary) => h('button', {
        type: 'button', disabled: busy, onClick,
        style: {
          flex: 'none', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)', cursor: busy ? 'progress' : 'pointer', font: 'inherit', fontSize: 13,
          border: primary ? 'none' : '1px solid var(--dsw-alias-border-primary, currentColor)',
          background: primary ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
          color: primary ? 'var(--dsw-alias-label-on-color, #fff)' : 'var(--dsw-alias-label-primary)',
        },
      }, label)
      return h('div', {
        role: 'status',
        style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 8, borderRadius: 'var(--dsw-radius-md, 10px)', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-fill-secondary, transparent)', border: '1px solid var(--dsw-alias-border-secondary, transparent)' },
      },
      h(PhoneIcon, { state: link.paused ? 'claiming' : claiming ? 'claiming' : 'mirror' }),
      h('span', { style: { flex: 1 } }, link.paused ? `${t.bannerPaused} ${link.paused.message}` : claiming ? t.bannerClaiming : t.bannerMirror),
      link.paused ? button(t.resume, () => act('/resume'), true)
        : claiming ? (canForce ? button(t.force, () => act('/force', t.forceConfirm), false) : null) : button(t.claim, () => act('/claim'), true))
    }

    /** Blokada pola pisania dla luster: podnoszona i zdejmowana wraz ze stanem powiazan. */
    function syncComposerBlocks(ctx) {
      const blocked = new Set()
      const apply = () => {
        const blocks = ctx.conversation?.blocks
        if (!blocks) return
        const now = new Set()
        for (const link of store.snapshot().links.values()) if (link.owner !== 'pc') now.add(link.pcSessionId)
        for (const id of now) if (!blocked.has(id)) blocks.set(id, { reason: copy().blocked })
        for (const id of blocked) if (!now.has(id)) blocks.set(id, undefined)
        blocked.clear()
        for (const id of now) blocked.add(id)
      }
      const unsubscribe = store.subscribe(apply)
      ctx.effect(() => () => { unsubscribe(); for (const id of blocked) ctx.conversation?.blocks?.set(id, undefined) }, 'dsh-remote-control: composer blocks')
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
      inject: ['uiWorkspace', 'slots', 'conversation'],
      apply(ctx) {
        openFromAddress(ctx)
        syncComposerBlocks(ctx)
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 'dsh-remote-control.export-to-phone', order: 50 },
          RowButton,
        ))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'dsh-remote-control.mirror-banner', order: 50 },
          MirrorBanner,
        ))
      },
    }
  },
})
