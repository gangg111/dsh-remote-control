/**
 * Baza sum plikow projektu przeniesionych miedzy PC a telefonem (`~/.dsh/remote-control-filebase.json`).
 *
 * Klucz: katalog projektu na PC (znormalizowany: ukosniki `/`, mala litera dysku i calosc malymi
 * literami, bo Windows nie rozroznia wielkosci). Wartosc: sciezka wzgledna -> sha256 tresci, ktora
 * ostatnio przeszla w ktoras strone (wyslana na telefon albo przyjeta z telefonu). Przy zwrocie plik
 * na PC o sumie z bazy nie byl od tego czasu zmieniany i moze byc nadpisany bez kopii konfliktowej.
 * Zapis atomowy: plik tymczasowy + rename.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Klucz katalogu: ukosniki `/`, bez koncowego ukosnika, malymi literami. */
export function rootKey(root) {
  return String(root).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/** @param {string} file */
export function createFileBase(file) {
  function loadAll() {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return {
        roots: data.roots && typeof data.roots === 'object' ? data.roots : {},
        pending: data.pending && typeof data.pending === 'object' ? data.pending : {},
      }
    } catch {
      return { roots: {}, pending: {} }
    }
  }
  function saveAll(data) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data) + '\n')
    renameSync(tmp, file)
  }
  const load = () => loadAll().roots
  const save = (roots) => saveAll({ ...loadAll(), roots })
  return {
    /** @returns {Record<string, string>} sciezka wzgledna -> sha256 dla katalogu `root`. */
    get(root) {
      return { ...(load()[rootKey(root)] ?? {}) }
    },
    /**
     * Dopisuje sumy przeniesionych plikow (pozostale wpisy katalogu zostaja).
     * @param {string} root
     * @param {ReadonlyArray<{ path: string, sha256: string }>} files
     */
    merge(root, files) {
      if (!files?.length) return
      const roots = load()
      const key = rootKey(root)
      const entry = { ...(roots[key] ?? {}) }
      for (const f of files) entry[f.path] = f.sha256
      roots[key] = entry
      save(roots)
    },
    /**
     * Pobranie czekajace na potwierdzenie zastosowania (jedno na powiazanie; nowe zastepuje stare).
     * @param {string} linkId
     * @param {{ pullId: string, root: string, files: ReadonlyArray<{path: string, sha256: string}>, deleted: string[] }} pull
     */
    setPending(linkId, pull) {
      const data = loadAll()
      data.pending[linkId] = { pullId: pull.pullId, root: pull.root, files: Object.fromEntries(pull.files.map((f) => [f.path, f.sha256])), deleted: [...pull.deleted], at: Date.now() }
      saveAll(data)
    },
    /**
     * Potwierdzenie: do bazy trafiaja sumy tylko zastosowanych sciezek z oczekujacego pobrania,
     * usuniete na PC wypadaja z bazy. Zwraca liczbe zapisanych sum albo null przy innym `pullId`.
     */
    ack(linkId, pullId, applied) {
      const data = loadAll()
      const p = data.pending[linkId]
      if (!p || p.pullId !== pullId) return null
      const key = rootKey(p.root)
      const entry = { ...(data.roots[key] ?? {}) }
      let merged = 0
      for (const path of applied ?? []) {
        if (typeof p.files[path] === 'string') { entry[path] = p.files[path]; merged++ }
      }
      for (const path of p.deleted) delete entry[path]
      data.roots[key] = entry
      delete data.pending[linkId]
      saveAll(data)
      return merged
    },
    /** Usuwa wpisy plikow, ktorych juz nie ma (zgloszonych drugiej stronie jako usuniete). */
    forget(root, paths) {
      if (!paths?.length) return
      const roots = load()
      const key = rootKey(root)
      if (!roots[key]) return
      for (const p of paths) delete roots[key][p]
      save(roots)
    },
  }
}
