/**
 * Synchronizacja powiazanych kopii sesji (wlasciciel -> lustro tylko do odczytu), wspolna dla PC i telefonu.
 *
 * Obie kopie maja WLASNA numeracje `seq`: lustro dopisuje lokalne zdarzenia (domkniecia tury przy
 * wznowieniu, tytul), a `Session.append` nadaje numery sam. Dlatego:
 * - powiazanie trzyma `SeqMap` (pary pc <-> telefon zapisane zakresami);
 * - przy dopisywaniu kazde odwolanie po numerze jest przeliczane na numeracje lustra (pola z
 *   prawdziwych logow DSH 0.2: `sourceEventSeqs`, `surfaceOp.startSeq/endSeq`, `data.shadowedSeqs`,
 *   `data.messageSeqs`, `data.headerSeq`, `data.sourceEventSeq`); inne pole z numerem albo odwolanie
 *   spoza mapy PRZERYWA synchronizacje (blad 409), zamiast po cichu zapisac zle wskazanie;
 * - znaczniki wyslania logu do DeepSeek (`session-log-deepseek/delivery-accepted`) nie sa
 *   przenoszone: dotycza wysylek drugiego urzadzenia.
 *
 * Ogon konczy sie na ostatniej zakonczonej turze (ta sama regula co rozgalezianie w DSH), wiec tura
 * w trakcie nigdy nie jest przenoszona. Dopisywanie wylacznie przez `Session.append` aktywnej sesji
 * (DSH nadaje numer i czas, sprawdza gramatyke zdarzen, otwarte okna widza zmiane od razu); zapis
 * wprost do pliku niczego nie sprawdza, wiec nie jest uzywany.
 */

import { readZip } from './zip.js'
import { writeZip } from './zipwrite.js'
import { mediaEntryName, readMedia, remapAttachments, saveAttachments } from './transfer.js'

export const DELIVERY = 'session-log-deepseek/delivery-accepted'
const TAIL_LOG = 'tail.jsonl'

/** Blad synchronizacji z kodem HTTP. */
export class SyncError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Ostatnia zakonczona granica: ostatni `turn/end` plus samodzielne zdarzenia po nim, do nastepnego
 * `turn/start`, dopisanej wiadomosci usera albo zmiany skrzynki (jak latestCompletedPrefixBoundary w DSH).
 * @param {readonly {type: string, seq: number, surfaceOp?: unknown}[]} events
 * @returns {number | undefined}
 */
export function latestBoundary(events) {
  let i = events.findLastIndex((e) => e.type === 'turn/end')
  if (i < 0) return undefined
  let boundary = events[i].seq
  for (const next of events.slice(i + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append') || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Pary numerow pc <-> telefon zapisane zakresami `[pcStart, phoneStart, length]`. */
export class SeqMap {
  /** @param {Array<[number, number, number]>} [runs] */
  constructor(runs = []) {
    this.runs = runs.map((r) => [...r])
  }

  /** Wspolny poczatek po przeniesieniu: numery 0..count-1 sa identyczne po obu stronach. */
  static shared(count) {
    return new SeqMap(count > 0 ? [[0, 0, count]] : [])
  }

  toPhone(pc) {
    for (const [p, f, n] of this.runs) if (pc >= p && pc < p + n) return f + (pc - p)
    return undefined
  }

  toPc(phone) {
    for (const [p, f, n] of this.runs) if (phone >= f && phone < f + n) return p + (phone - f)
    return undefined
  }

  /** Dopisuje pare; sasiadujace pary lacza sie w jeden zakres. */
  add(pc, phone) {
    const last = this.runs.at(-1)
    if (last && pc === last[0] + last[2] && phone === last[1] + last[2]) last[2]++
    else this.runs.push([pc, phone, 1])
  }

  toJSON() {
    return this.runs
  }
}

const KNOWN_SEQ_PATHS = new Set(['sourceEventSeqs', 'surfaceOp.startSeq', 'surfaceOp.endSeq', 'data.shadowedSeqs', 'data.messageSeqs', 'data.headerSeq', 'data.sourceEventSeq'])

/**
 * Przelicza odwolania po numerach w jednym zdarzeniu (kopia gleboka).
 * @param {object} event - zdarzenie wlasciciela (bez `seq`/`time` w wyniku).
 * @param {(ownerSeq: number) => number} map - numer wlasciciela -> numer lustra; rzuca dla nieznanego.
 */
export function remapSeqRefs(event, map) {
  const { seq: _seq, time: _time, ...rest } = event
  // Straznik: kazde inne pole wygladajace na numer zdarzenia przerywa synchronizacje.
  const scan = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x) => scan(x, path)); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k
        if (/seqs?$/i.test(k) && !KNOWN_SEQ_PATHS.has(p) && !(event.type === DELIVERY && p === 'data.throughSeq')) {
          throw new SyncError(409, `Zdarzenie ${event.type} ma nieznane odwolanie po numerze (${p}); synchronizacja przerwana.`)
        }
        scan(x, p)
      }
    }
  }
  scan(rest, '')
  const out = structuredClone(rest)
  const one = (n) => (typeof n === 'number' ? map(n) : n)
  const many = (a) => (Array.isArray(a) ? a.map(one) : a)
  if (out.sourceEventSeqs !== undefined) out.sourceEventSeqs = many(out.sourceEventSeqs)
  if (out.surfaceOp && typeof out.surfaceOp === 'object') {
    if ('startSeq' in out.surfaceOp) out.surfaceOp.startSeq = one(out.surfaceOp.startSeq)
    if ('endSeq' in out.surfaceOp) out.surfaceOp.endSeq = one(out.surfaceOp.endSeq)
  }
  if (out.data && typeof out.data === 'object') {
    for (const k of ['shadowedSeqs', 'messageSeqs']) if (k in out.data) out.data[k] = many(out.data[k])
    for (const k of ['headerSeq', 'sourceEventSeq']) if (k in out.data) out.data[k] = one(out.data[k])
  }
  return out
}

/**
 * Stan sesji do decyzji kuriera: ostatni numer, ostatnia zakonczona granica, czy trwa tura.
 * @param {(name: string) => any} get
 * @param {string} sessionId
 * @returns {Promise<{ lastSeq: number, boundary: number | undefined, busy: boolean }>}
 */
export async function sessionState(get, sessionId) {
  const query = get('sessionQuery')
  if (!query) throw new SyncError(503, 'Usluga odczytu sesji DSH jest niedostepna.')
  let observed
  try { observed = await query.observeSession(sessionId) } catch (error) {
    throw new SyncError(404, `Nie ma sesji ${sessionId} (${error?.message ?? error}).`)
  }
  try {
    const events = observed.events
    const boundary = latestBoundary(events)
    return { lastSeq: events.at(-1)?.seq ?? -1, boundary, busy: events.some((e) => e.seq > (boundary ?? -1) && e.type === 'turn/start') }
  } finally {
    observed?.[Symbol.dispose]?.()
  }
}

/** Opisy zalacznikow `{attachmentId, ...}` wystepujace w zdarzeniach. */
function collectAttachmentRefs(events) {
  const refs = new Map()
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === 'object') {
      if (typeof v.attachmentId === 'string') refs.set(v.attachmentId, v)
      else for (const x of Object.values(v)) walk(x)
    }
  }
  events.forEach((e) => walk(e.data))
  return [...refs.values()]
}

/**
 * Ogon sesji wlasciciela: zdarzenia po `afterSeq` do ostatniej zakonczonej tury, jako ZIP
 * (`tail.jsonl` + `media/` + `files/`).
 * @param {(name: string) => any} get - `ctx.get` hosta DSH.
 * @param {string} sessionId
 * @param {number} afterSeq - ostatni numer wlasciciela, ktory lustro juz ma.
 * @returns {Promise<{ zip: Buffer, fromSeq: number, toSeq: number, lastSeq: number, busy: boolean, count: number }>}
 */
export async function readTail(get, sessionId, afterSeq) {
  const query = get('sessionQuery')
  if (!query) throw new SyncError(503, 'Usluga odczytu sesji DSH jest niedostepna.')
  let observed
  try { observed = await query.observeSession(sessionId) } catch (error) {
    throw new SyncError(404, `Nie ma sesji ${sessionId} (${error?.message ?? error}).`)
  }
  try {
    const events = observed.events
    const boundary = latestBoundary(events)
    const toSeq = boundary === undefined ? afterSeq : Math.max(afterSeq, boundary)
    const busy = events.some((e) => e.seq > (boundary ?? -1) && e.type === 'turn/start')
    const tail = events.filter((e) => e.seq > afterSeq && e.seq <= toSeq && e.type !== DELIVERY)
    const entries = [[TAIL_LOG, tail.map((e) => JSON.stringify(e)).join('\n') + (tail.length ? '\n' : '')]]
    const attachments = get('attachments')
    for (const ref of collectAttachmentRefs(tail)) {
      if (!attachments) throw new SyncError(503, 'Usluga zalacznikow DSH jest niedostepna.')
      if (typeof ref.mediaType === 'string' && ref.mediaType.startsWith('image/')) {
        entries.push([mediaEntryName(ref), Buffer.from((await attachments.readImage(ref)).data)])
      } else {
        const chunks = []
        for await (const c of attachments.readFileStream(ref)) chunks.push(Buffer.from(c))
        entries.push([mediaEntryName(ref), Buffer.concat(chunks)])
      }
    }
    return { zip: writeZip(entries), fromSeq: afterSeq, toSeq, lastSeq: events.at(-1)?.seq ?? -1, busy, count: tail.length }
  } finally {
    observed?.[Symbol.dispose]?.()
  }
}

/**
 * Dopisuje ogon wlasciciela do lustra.
 * @param {(name: string) => any} get - `ctx.get` hosta DSH.
 * @param {string} sessionId - sesja lustra.
 * @param {Buffer} zip - wynik readTail drugiej strony.
 * @param {(ownerSeq: number) => number | undefined} resolve - numer wlasciciela -> numer lustra z mapy powiazania.
 * @returns {Promise<{ pairs: Array<[number, number]>, lastOwnerSeq: number | undefined, lastMirrorSeq: number | undefined, error?: string }>}
 *   `pairs` = [numer wlasciciela, numer lustra] dla dopisanych zdarzen; przy bledzie w polowie
 *   ogona zawiera to, co juz weszlo (synchronizacja wznowi sie od tego miejsca).
 */
export async function appendTail(get, sessionId, zip, resolve) {
  let entries
  try { entries = readZip(zip) } catch (error) { throw new SyncError(400, `Niepoprawny ogon: ${error?.message ?? error}`) }
  const log = entries.get(TAIL_LOG)
  if (!log) throw new SyncError(400, 'Ogon nie zawiera tail.jsonl.')
  let events
  try { events = log.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) } catch {
    throw new SyncError(400, 'tail.jsonl nie jest poprawnym JSONL.')
  }
  const { images, files } = readMedia(entries)
  const attachmentMap = await saveAttachments(get('attachments'), images, files)
  const local = new Map()
  const map = (o) => {
    const m = local.get(o) ?? resolve(o)
    if (m === undefined) throw new SyncError(409, `Odwolanie do zdarzenia ${o}, ktorego lustro nie zna; synchronizacja przerwana.`)
    return m
  }
  const pairs = []
  const result = (error) => ({ pairs, lastOwnerSeq: pairs.at(-1)?.[0], lastMirrorSeq: pairs.at(-1)?.[1], ...(error ? { error } : {}) })
  const prepared = events.filter((e) => e.type !== DELIVERY)

  const live = await ensureLive(get, sessionId)
  for (const e of prepared) {
    try {
      const x = remapSeqRefs(remapAttachments(e, attachmentMap), map)
      const opts = {}
      if (x.surfaceOp !== undefined) opts.surfaceOp = x.surfaceOp
      if (x.sourceEventSeqs !== undefined) opts.sourceEventSeqs = x.sourceEventSeqs
      const logged = Object.keys(opts).length > 0 ? live.append(x.type, x.data, opts) : live.append(x.type, x.data)
      local.set(e.seq, logged.seq)
      pairs.push([e.seq, logged.seq])
    } catch (error) {
      return result(`Zdarzenie ${e.seq} (${e.type}) nie weszlo: ${error?.message ?? error}`)
    }
  }
  return result()
}

/** Ostatnia tura zapisana w logu sesji (projekcja `turnBoundary`, ta sama, z ktorej agent DSH bierze licznik przy wczytaniu). */
export function projectedLastTurn(get, session) {
  return get('sessionProjections')?.stateOf?.(session, 'turnBoundary')?.lastTurn ?? 0
}

/** Faza agenta DSH 0.2 (`ReactLoopAgent.phase`); inny ksztalt = zmienione wnetrze DSH, synchronizacja odmawia. */
function agentPhase(agent) {
  const phase = agent?.phase
  if (!phase || typeof phase !== 'object' || !['idle', 'maintenance', 'running'].includes(phase.kind)) {
    throw new SyncError(500, 'Nieznany stan agenta DSH (zmienione wnetrze DSH); synchronizacja wstrzymana.')
  }
  return phase
}

/**
 * Doprowadza aktywnego agenta sesji do stanu, w jakim DSH wczytuje go z logu.
 *
 * Agent DSH czyta licznik tur z projekcji `turnBoundary` tylko w konstruktorze (agent-loop agent.ts),
 * a `Session.append` go nie przesuwa. Wtyczka nie moze agenta zwolnic: uchwyt z `dispose()` dostaje
 * wylacznie tworca, a kontroler sesji go odrzuca (agent zyje do restartu DSH). Dlatego:
 * - brak aktywnego agenta: nic do zrobienia, nastepne wznowienie czyta licznik z logu;
 * - agent w trakcie tury: blad 409 (nie ruszamy pracujacego agenta);
 * - agent bezczynny: licznik tur = ostatnia tura w logu, a nastepne zapytanie zapisze naglowek
 *   `resume`, dokladnie jak po wczytaniu z logu (pozostaly stan agenta to projekcje sesji).
 * @param {(name: string) => any} get - `ctx.get` hosta DSH.
 * @param {string} sessionId
 * @returns {{ mode: 'cold' } | { mode: 'live', before: number, lastTurn: number }}
 */
export function reloadSession(get, sessionId) {
  const agent = get('agents')?.get?.(sessionId)
  if (!agent) return { mode: 'cold' }
  const phase = agentPhase(agent)
  if (phase.kind === 'running') throw new SyncError(409, 'W tej sesji trwa tura; poczekaj na jej koniec.')
  if (typeof phase.lastTurn !== 'number') throw new SyncError(500, 'Nieznany stan agenta DSH (brak licznika tur); synchronizacja wstrzymana.')
  const before = phase.lastTurn
  const lastTurn = projectedLastTurn(get, agent.session)
  phase.lastTurn = lastTurn
  if ('requestHeaderLogged' in agent) agent.requestHeaderLogged = false
  return { mode: 'live', before, lastTurn }
}

/**
 * Bramka przed tura. DSH zapisuje `turn/start` ZANIM zapyta `agent/pre-step`, wiec odrzucenie tam
 * zostawia w logu otwarta i zablokowana ture. `agent/status: running` przychodzi synchronicznie przed
 * zapisem `turn/start`; przerwanie w tym miejscu konczy ture, zanim cokolwiek trafi do logu.
 * @param {(name: string) => any} get
 * @param {{ agent: any, status: string }} payload - zdarzenie `agent/status`.
 * @param {(sessionId: string) => 'mirror' | 'owner' | undefined} roleOf - rola sesji w powiazaniu.
 * @returns {undefined | { sessionId: string, role: 'mirror' | 'owner', reason: 'mirror' | 'turn' | 'unknown', expected: number, actual: number }}
 *   opis przerwanej tury albo undefined, gdy tura moze ruszyc.
 */
export function guardTurnStart(get, payload, roleOf) {
  if (payload?.status !== 'running') return undefined
  const agent = payload.agent
  const sessionId = agent?.session?.header?.id ?? agent?.id
  const role = sessionId ? roleOf(sessionId) : undefined
  if (!role) return undefined
  let phase
  try { phase = agentPhase(agent) } catch {
    agent.cancel?.({ kind: 'user' }, { keepInbox: true })
    return { sessionId, role, reason: 'unknown', expected: NaN, actual: NaN }
  }
  if (phase.kind !== 'running' || phase.step !== 0) return undefined
  const expected = projectedLastTurn(get, agent.session)
  const actual = phase.turn
  if (role === 'owner' && actual === expected) return undefined
  // Po przerwaniu agent wraca do bezczynnosci z licznikiem z `phase.turn`: ustawiamy go na stan logu.
  phase.turn = expected
  // Lustro: wiadomosc nie zostaje w kolejce (nie wykona sie po przejeciu); wlasciciel: zostaje.
  agent.cancel({ kind: 'user' }, { keepInbox: role === 'owner' })
  return { sessionId, role, reason: role === 'mirror' ? 'mirror' : 'turn', expected, actual }
}

/**
 * Aktywna sesja lustra. Dopisujemy tylko przez `Session.append`, ktory sprawdza kazde zdarzenie
 * przed zapisem (zapis do pliku nie sprawdza niczego i bledne zdarzenie zepsuloby lustro na stale).
 * Nieaktywna sesje wznawia oficjalna zmiana nazwy na biezacy tytul (wznowienie, potem tytul).
 */
async function ensureLive(get, sessionId) {
  const sessions = get('sessions')
  let live = sessions?.get?.(sessionId)
  if (live) return live
  const controller = get('sessionController')
  const query = get('sessionQuery')
  if (typeof controller?.rename !== 'function') throw new SyncError(503, 'Kontroler sesji DSH jest niedostepny.')
  let title = null
  try {
    const t = await query?.readTitle?.(sessionId)
    title = typeof t === 'string' ? t : [t?.text, t?.title, t?.value].find((x) => typeof x === 'string' && x) ?? null
  } catch (error) {
    void error // brak tytulu: ponizej tytul zastepczy
  }
  await controller.rename({ sessionId, title: title || 'Sesja synchronizowana' })
  live = sessions?.get?.(sessionId)
  if (!live) throw new SyncError(409, 'Nie udalo sie wznowic lustra w DSH.')
  return live
}