/**
 * Powiazania sesji PC <-> telefon (jedno zrodlo prawdy na bramie PC; telefon jest kurierem).
 *
 * Wpis: `{ linkId, pcSessionId, phoneSessionId, owner: 'pc'|'phone', epoch, pcMark, phoneMark,
 * runs, claim, forced?, title, createdAt, updatedAt, lastError? }`.
 * - `pcMark` / `phoneMark`: ostatni numer zdarzenia po danej stronie, ktory druga strona juz ma
 *   (albo ktory jest lokalny i nigdy nie bedzie przeniesiony).
 * - `runs`: mapa numerow pc <-> telefon (SeqMap z lib/sync.js).
 * - `epoch`: rosnie przy kazdej zmianie wlasciciela; kazda operacja kuriera podaje epoch, ktory
 *   widziala, i dostaje 409, gdy stan sie zmienil.
 * - `claim`: prosba PC o przejecie pisania (`{ by: 'pc', at }`), ktora telefon zatwierdza po
 *   dostarczeniu swojego ogona; PC nie moze zawolac telefonu, wiec przejecie z PC jest dwuetapowe.
 * Zapis atomowy: plik tymczasowy + rename.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SeqMap } from './sync.js'

/** Blad stanu powiazania z kodem HTTP. */
export class LinkError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** @param {string} file @param {() => number} [now] */
export function createLinks(file, now = () => Date.now()) {
  function load() {
    try {
      const links = JSON.parse(readFileSync(file, 'utf8')).links
      return Array.isArray(links) ? links : []
    } catch {
      return []
    }
  }
  function save(links) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ links }, null, 1) + '\n')
    renameSync(tmp, file)
  }
  /** Zmiana jednego wpisu w transakcji odczyt-zapis. */
  function update(linkId, fn) {
    const links = load()
    const link = links.find((l) => l.linkId === linkId)
    if (!link) throw new LinkError(404, 'Nie ma takiego powiazania.')
    const result = fn(link)
    link.updatedAt = now()
    save(links)
    return result ?? link
  }
  const expectEpoch = (link, epoch) => {
    if (epoch !== undefined && Number(epoch) !== link.epoch) throw new LinkError(409, `Stan powiazania sie zmienil (epoch ${link.epoch}, a nie ${epoch}).`)
  }

  return {
    list: () => load(),
    get: (linkId) => load().find((l) => l.linkId === linkId),
    /** Powiazanie, w ktorym dana sesja PC jest stroną. */
    byPcSession: (sessionId) => load().find((l) => l.pcSessionId === sessionId),
    /** Czy sesja PC jest teraz lustrem (nie wolno w niej pisac). */
    isPcMirror: (sessionId) => load().some((l) => l.pcSessionId === sessionId && l.owner !== 'pc'),

    /**
     * Rejestracja po przeniesieniu: numery 0..sharedCount-1 sa identyczne po obu stronach.
     * @param {{ pcSessionId: string, phoneSessionId: string, owner: 'pc'|'phone', sharedCount: number, title?: string }} body
     */
    create(body) {
      const { pcSessionId, phoneSessionId, owner, sharedCount } = body ?? {}
      if (typeof pcSessionId !== 'string' || typeof phoneSessionId !== 'string' || !pcSessionId || !phoneSessionId) throw new LinkError(400, 'Brak pcSessionId albo phoneSessionId.')
      if (owner !== 'pc' && owner !== 'phone') throw new LinkError(400, 'owner musi byc "pc" albo "phone".')
      if (!Number.isSafeInteger(sharedCount) || sharedCount < 1) throw new LinkError(400, 'sharedCount musi byc dodatnia liczba calkowita.')
      const links = load()
      if (links.some((l) => l.pcSessionId === pcSessionId || l.phoneSessionId === phoneSessionId)) throw new LinkError(409, 'Ta sesja jest juz powiazana.')
      const link = {
        linkId: randomUUID(), pcSessionId, phoneSessionId, owner, epoch: 1,
        pcMark: sharedCount - 1, phoneMark: sharedCount - 1, runs: SeqMap.shared(sharedCount).toJSON(),
        claim: null, title: typeof body.title === 'string' ? body.title.slice(0, 200) : null,
        createdAt: now(), updatedAt: now(),
      }
      save([...links, link])
      return link
    },

    /**
     * Zapisuje wynik dopisania ogona w lustrze.
     * @param {string} linkId
     * @param {{ epoch: number, from: 'pc'|'phone', ownerTo: number, mirrorLast: number, pairs: Array<[number, number]>, error?: string }} r
     *   `ownerTo` = ostatni numer wlasciciela objety ogonem; `mirrorLast` = ostatni numer lustra po dopisaniu;
     *   `pairs` = [numer wlasciciela, numer lustra].
     */
    recordApplied(linkId, r) {
      return update(linkId, (link) => {
        expectEpoch(link, r.epoch)
        if (link.owner !== r.from) throw new LinkError(409, `Wlascicielem jest ${link.owner}, nie ${r.from}.`)
        const map = new SeqMap(link.runs)
        for (const [o, m] of r.pairs ?? []) r.from === 'pc' ? map.add(o, m) : map.add(m, o)
        link.runs = map.toJSON()
        if (r.error) {
          // Czesc ogona weszla: znacznik wlasciciela przesuwa sie tylko do ostatniego dopisanego zdarzenia.
          const last = r.pairs?.at(-1)
          if (last) { if (r.from === 'pc') { link.pcMark = last[0]; link.phoneMark = last[1] } else { link.phoneMark = last[0]; link.pcMark = last[1] } }
          link.lastError = { at: now(), message: r.error }
        } else {
          if (r.from === 'pc') { link.pcMark = r.ownerTo; link.phoneMark = r.mirrorLast } else { link.phoneMark = r.ownerTo; link.pcMark = r.mirrorLast }
          delete link.lastError
        }
      })
    },

    /** Prosba PC o przejecie pisania (telefon zatwierdza przy nastepnym odpytaniu). */
    requestClaim(linkId) {
      return update(linkId, (link) => {
        if (link.owner === 'pc') return
        link.claim = { by: 'pc', at: now() }
      })
    },

    /**
     * Zmiana wlasciciela. Telefon przejmuje z PC albo zatwierdza prosbe PC.
     * @param {string} linkId
     * @param {{ to: 'pc'|'phone', epoch: number, ownerMark?: number, ownerBoundary?: number, ownerBusy?: boolean, mirrorLast?: number, force?: boolean }} r
     *   Przy przejeciu wymagane jest, by lustro mialo wszystko od wlasciciela: `ownerMark` ===
     *   `ownerBoundary` i wlasciciel nie jest w trakcie tury. `mirrorLast` = ostatni numer nowego
     *   wlasciciela (jego lokalne zdarzenia zostaja lokalne).
     */
    switchOwner(linkId, r) {
      return update(linkId, (link) => {
        expectEpoch(link, r.epoch)
        if (link.owner === r.to) return
        if (!r.force) {
          if (r.ownerBusy) throw new LinkError(409, 'Na drugim urzadzeniu trwa tura; poczekaj na jej koniec.')
          if (r.ownerMark !== undefined && r.ownerBoundary !== undefined && r.ownerMark < r.ownerBoundary) {
            throw new LinkError(409, 'Najpierw dociagnij najnowsze zdarzenia od wlasciciela.')
          }
        }
        link.owner = r.to
        link.epoch++
        link.claim = null
        if (r.force) link.forced = { at: now() }
        if (typeof r.mirrorLast === 'number') { if (r.to === 'pc') link.pcMark = r.mirrorLast; else link.phoneMark = r.mirrorLast }
      })
    },

    remove(linkId) {
      const links = load()
      const kept = links.filter((l) => l.linkId !== linkId)
      if (kept.length === links.length) throw new LinkError(404, 'Nie ma takiego powiazania.')
      save(kept)
      return true
    },
  }
}
