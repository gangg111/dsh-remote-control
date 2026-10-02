// Czesc przegladarkowa dsh-remote-control (format ladowarki modulow klienta DSH).
// Telefon otwiera sesje adresem https://<komputer>/?dshOpen=<id>: po starcie interfejsu wybieramy
// te sesje przez oficjalne ctx.uiWorkspace.openSession i usuwamy parametr z adresu.
window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory() {
    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
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
      },
    }
  },
})
