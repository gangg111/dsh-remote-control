/**
 * Minimalny czytnik ZIP dla natywnego eksportu sesji DSH (`dsh-session-<id>.zip`).
 *
 * Czyta katalog centralny (takze ZIP64), metody 0 (store) i 8 (deflate); sprawdza CRC-32 kazdego
 * wpisu. Szyfrowanie i inne metody kompresji sa odrzucane. Nazwy wpisow ze sciezka wychodzaca
 * poza archiwum (`..`, absolutne) sa odrzucane, chociaz ten czytnik niczego nie zapisuje na dysk.
 */

import { crc32, inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const EOCD64_LOCATOR = 0x07064b50
const EOCD64 = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Blad formatu archiwum; `status` dla odpowiedzi HTTP. */
export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) return i
  throw new ZipError('to nie jest archiwum ZIP (brak katalogu centralnego)')
}

/**
 * @param {Buffer} buf - cale archiwum.
 * @returns {Map<string, Buffer>} nazwa wpisu -> rozpakowana zawartosc (katalogi pominiete).
 */
export function readZip(buf) {
  const eocd = findEocd(buf)
  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOCATOR) throw new ZipError('uszkodzony naglowek ZIP64')
    const e64 = Number(buf.readBigUInt64LE(loc + 8))
    if (buf.readUInt32LE(e64) !== EOCD64) throw new ZipError('uszkodzony rekord ZIP64')
    count = Number(buf.readBigUInt64LE(e64 + 32))
    cdOffset = Number(buf.readBigUInt64LE(e64 + 48))
  }
  const out = new Map()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('uszkodzony katalog centralny')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    let compressed = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    // Pola ZIP64 w extra (id 0x0001) w kolejnosci: size, compressed, offset, tylko te z 0xffffffff.
    let e = p + 46 + nameLen
    const eEnd = e + extraLen
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e)
      const len = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (compressed === 0xffffffff) { compressed = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8 }
      }
      e += 4 + len
    }
    p = eEnd + commentLen
    if (name.endsWith('/')) continue
    if (flags & 0x1) throw new ZipError(`wpis ${name} jest zaszyfrowany`)
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..')) throw new ZipError(`niedozwolona nazwa wpisu: ${name}`)
    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError(`uszkodzony naglowek lokalny: ${name}`)
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(dataStart, dataStart + compressed)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new ZipError(`nieobslugiwana kompresja (${method}) w ${name}`)
    if (data.length !== size || (crc32(data) >>> 0) !== crc) throw new ZipError(`uszkodzona zawartosc: ${name}`)
    out.set(name, data)
  }
  return out
}
