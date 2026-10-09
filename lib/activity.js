/**
 * Trwajace transfery miedzy PC a telefonem, do animacji ikony sesji na PC.
 *
 * Kierunek z punktu widzenia PC: `out` (PC -> telefon: eksport sesji, pliki, ogon PC) albo `in`
 * (telefon -> PC: ogon telefonu, zwrot plikow). `total` jest znany, gdy znany jest rozmiar (bufor
 * ZIP, naglowek content-length); bez niego interfejs pokazuje sam ruch. Zakonczony transfer jest
 * jeszcze przez `lingerMs` na liscie, zeby krotka wymiana zdazyla mignac w interfejsie.
 */

import { Transform } from 'node:stream'

/** @param {{ lingerMs?: number, now?: () => number }} [opts] */
export function createActivity(opts = {}) {
  const lingerMs = opts.lingerMs ?? 1500
  const now = opts.now ?? (() => Date.now())
  const items = new Map()
  let seq = 0

  return {
    /**
     * @param {string} sessionId - sesja PC.
     * @param {'in'|'out'} direction
     * @param {number} [total] - rozmiar w bajtach, gdy znany.
     */
    start(sessionId, direction, total) {
      const id = ++seq
      const item = { id, sessionId, direction, bytes: 0, total: Number.isFinite(total) && total > 0 ? total : null, startedAt: now(), endedAt: null }
      items.set(id, item)
      return {
        add(n) { item.bytes += n },
        end() { if (item.endedAt === null) { item.endedAt = now(); if (item.total !== null) item.bytes = Math.max(item.bytes, item.total) } },
      }
    },
    /** Transfery trwajace i niedawno zakonczone. */
    list() {
      const t = now()
      const out = []
      for (const [id, item] of items) {
        if (item.endedAt !== null && t - item.endedAt > lingerMs) { items.delete(id); continue }
        out.push({ sessionId: item.sessionId, direction: item.direction, bytes: item.bytes, total: item.total, done: item.endedAt !== null })
      }
      return out
    },
  }
}

/** Strumien przepuszczajacy dane i liczacy bajty do `handle.add`. */
export function countingStream(handle) {
  return new Transform({
    transform(chunk, _enc, cb) { handle.add(chunk.length); cb(null, chunk) },
  })
}

/**
 * Wysyla bufor kawalkami (z poszanowaniem `drain`), liczac postep; konczy odpowiedz.
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} buf
 * @param {{ add: (n: number) => void, end: () => void }} [handle]
 */
export async function sendBuffer(res, buf, handle, chunk = 64 * 1024) {
  try {
    // Odpowiedz bez `write` (atrapa w testach) dostaje calosc naraz.
    if (typeof res.write !== 'function') { handle?.add(buf.length); res.end(buf); return }
    for (let off = 0; off < buf.length; off += chunk) {
      const part = buf.subarray(off, off + chunk)
      handle?.add(part.length)
      if (!res.write(part)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
      if (res.destroyed) break
    }
    res.end()
  } finally {
    handle?.end()
  }
}
