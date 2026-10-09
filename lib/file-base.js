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
  function load() {
    try {
      const roots = JSON.parse(readFileSync(file, 'utf8')).roots
      return roots && typeof roots === 'object' ? roots : {}
    } catch {
      return {}
    }
  }
  function save(roots) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ roots }) + '\n')
    renameSync(tmp, file)
  }
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
