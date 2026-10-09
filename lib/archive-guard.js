/**
 * Archiwizacja sesji powiazanej z telefonem: DSH pyta `workspace/session-activity`, zanim cokolwiek
 * zapisze; zgloszona aktywnosc zamienia archiwizacje w okno potwierdzenia z lista pracy w toku.
 * Synchronizacja jest tam pokazana jako praca do zatrzymania, a „Zatrzymaj i zarchiwizuj”
 * (`workspace/session-stop`) najpierw odlacza powiazanie. Twarda odmowa (wyjatek w sluchaczu)
 * konczy sie w DSH tylko wpisem w konsoli, bez komunikatu, wiec nie jest uzywana.
 */

/** Rodzaj aktywnosci; DSH pokazuje nieznany rodzaj doslownie w nawiasie. */
export const SYNC_ACTIVITY = 'synchronizacja z telefonem'

/**
 * @param {{ on: (name: string, listener: Function) => unknown }} ctx
 * @param {{ byPcSession: (id: string) => any, remove: (linkId: string) => boolean }} links
 * @param {{ info?: Function, warn?: Function }} [log]
 */
export function installArchiveGuard(ctx, links, log) {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const rest = await next()
    const link = links.byPcSession(sessionId)
    if (!link) return rest
    const label = link.owner === 'pc' ? 'piszesz na PC' : 'lustro sesji z telefonu'
    return [{ kind: SYNC_ACTIVITY, items: [{ id: link.linkId, label }] }, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    const link = links.byPcSession(sessionId)
    if (!link) return
    try {
      links.remove(link.linkId)
      log?.info?.(`[dsh-remote-control] archiwizacja ${sessionId}: odlaczono synchronizacje z telefonem (${link.linkId})`)
    } catch (error) {
      log?.warn?.(`[dsh-remote-control] archiwizacja ${sessionId}: nie odlaczono synchronizacji: ${error?.message ?? error}`)
    }
  })
}
