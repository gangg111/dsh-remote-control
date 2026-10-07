/**
 * Skrzynka nadawcza PC -> telefon: lista sesji oznaczonych ikona „Eksportuj na telefon”.
 *
 * Wpis zostaje w stanie `waiting`, dopoki telefon nie potwierdzi udanego importu (`markReceived`),
 * wiec zerwane polaczenie niczego nie gubi. Odebrane wpisy zostaja na dobe (ikona pokazuje
 * „odebrane”), oczekujace znikaja po 7 dniach. Zapis atomowy: plik tymczasowy + rename.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const KEEP_RECEIVED_MS = 24 * 60 * 60 * 1000
const KEEP_WAITING_MS = 7 * 24 * 60 * 60 * 1000

/** @param {string} file - sciezka pliku stanu. */
export function createOutbox(file, now = () => Date.now()) {
  function load() {
    try {
      const items = JSON.parse(readFileSync(file, 'utf8')).items
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }
  function save(items) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ items }, null, 2) + '\n')
    renameSync(tmp, file)
  }
  function pruned() {
    const t = now()
    const items = load()
    const kept = items.filter((i) => (i.state === 'received' ? t - (i.receivedAt ?? 0) < KEEP_RECEIVED_MS : t - i.createdAt < KEEP_WAITING_MS))
    if (kept.length !== items.length) save(kept)
    return kept
  }

  return {
    /** Wszystkie wpisy (dla ikon na PC). */
    list: () => pruned(),
    /** Oczekujace (dla telefonu). */
    waiting: () => pruned().filter((i) => i.state === 'waiting'),
    get: (transferId) => pruned().find((i) => i.transferId === transferId),
    /** Dodaje sesje; ponowne klikniecie przy oczekujacym wpisie nie tworzy duplikatu. */
    add(sessionId, title) {
      if (typeof sessionId !== 'string' || !sessionId) throw Object.assign(new Error('brak sessionId'), { status: 400 })
      const items = pruned()
      const existing = items.find((i) => i.sessionId === sessionId && i.state === 'waiting')
      if (existing) return existing
      const item = { transferId: randomUUID(), sessionId, title: typeof title === 'string' && title ? title.slice(0, 200) : null, createdAt: now(), state: 'waiting' }
      save([...items.filter((i) => i.sessionId !== sessionId), item])
      return item
    },
    /** Potwierdzenie z telefonu po udanym imporcie. */
    markReceived(transferId) {
      const items = pruned()
      const item = items.find((i) => i.transferId === transferId)
      if (!item) return undefined
      item.state = 'received'
      item.receivedAt = now()
      save(items)
      return item
    },
    /** Anulowanie z PC (ponowne klikniecie przy oczekujacym). */
    remove(transferId) {
      const items = pruned()
      const kept = items.filter((i) => i.transferId !== transferId)
      if (kept.length !== items.length) save(kept)
      return kept.length !== items.length
    },
  }
}
