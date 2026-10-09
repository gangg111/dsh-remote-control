// Pliki projektu przenoszone z sesja: zbieranie, pakowanie, zastosowanie, konflikty, wykluczenia.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentEditedPaths, applyWorkspaceZip, collectFiles, diffAgainstBase, packWorkspaceZip, readWorkspaceZip, safeRelSegments,
} from '../lib/workspace-files.js'
import { writeZip } from '../lib/zipwrite.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const put = (root, rel, data) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data); return f }
const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

test('agentEditedPaths: edit/write/apply_patch, tylko wewnatrz root i istniejace', () => {
  const root = tmp('wf-edited-')
  const a = put(root, 'src/a.c', 'a')
  put(root, 'src/b.c', 'b')
  const events = [
    call('edit', { file_path: a }),
    call('write', { file_path: join(root, 'src/b.c') }),
    call('read', { file_path: join(root, 'src/a.c') }),
    call('edit', { file_path: join(root, 'nie-ma.c') }),
    call('edit', { file_path: 'C:/gdzie/indziej.c' }),
    call('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/a.c\n@@\n-a\n+aa\n*** End Patch' }),
    { type: 'assistant/message', data: {} },
  ]
  const got = agentEditedPaths(events, root).map((p) => p.replaceAll('\\', '/')).sort()
  assert.deepEqual(got, [`${root.replaceAll('\\', '/')}/src/a.c`, `${root.replaceAll('\\', '/')}/src/b.c`])
})

test('collectFiles(agent): manifest z sha256, wykluczenia na skipped', () => {
  const root = tmp('wf-collect-')
  const paths = [
    put(root, 'main.c', 'int main(){}'),
    put(root, 'klucz.pfx', 'SEKRET'),
    put(root, 'tool.exe', 'MZ'),
    put(root, 'node_modules/x/index.js', 'x'),
  ]
  const { entries, manifest } = collectFiles({ root, scope: 'agent', paths, origin: { device: 'pc', root, name: 'proj' } })
  assert.deepEqual(manifest.files.map((f) => f.path), ['main.c'])
  assert.equal(manifest.files[0].sha256.length, 64)
  const reasons = Object.fromEntries(manifest.skipped.map((s) => [s.path, s.reason]))
  assert.deepEqual(reasons, { 'klucz.pfx': 'secret', 'tool.exe': 'binary', 'node_modules/x/index.js': 'build-or-dep' })
  assert.ok(entries.some(([n]) => n === 'manifest.json'))
  assert.ok(entries.some(([n]) => n === 'tree/main.c'))
})

test('collectFiles: limity rozmiaru i liczby plikow', () => {
  const root = tmp('wf-limit-')
  const big = put(root, 'big.bin', Buffer.alloc(2000))
  const small = put(root, 'small.txt', 'ok')
  const { manifest } = collectFiles({ root, scope: 'agent', paths: [big, small], origin: {}, limits: { fileBytes: 1000, totalBytes: 999999, fileCount: 100 } })
  assert.deepEqual(manifest.files.map((f) => f.path), ['small.txt'])
  assert.equal(manifest.skipped.find((s) => s.path === 'big.bin').reason, 'too-large')
})

test('pack + read + apply: nowe pliki tworzone w katalogu docelowym', () => {
  const src = tmp('wf-src-')
  const paths = [put(src, 'a/x.txt', 'XXX'), put(src, 'b.txt', 'B')]
  const { zip } = packWorkspaceZip({ root: src, scope: 'agent', paths, origin: { device: 'pc', root: src, name: 'proj' } })
  const { manifest, tree } = readWorkspaceZip(zip)
  assert.equal(manifest.files.length, 2)
  assert.equal(tree.get('a/x.txt').toString(), 'XXX')
  const dst = tmp('wf-dst-')
  const { report } = applyWorkspaceZip({ root: dst, zip })
  assert.deepEqual(report.created.sort(), ['a/x.txt', 'b.txt'])
  assert.equal(readFileSync(join(dst, 'a/x.txt'), 'utf8'), 'XXX')
})

test('apply: identyczny plik bez zmian, rozny -> kopia obok', () => {
  const src = tmp('wf-src2-')
  const p = put(src, 'f.txt', 'nowa')
  const { zip } = packWorkspaceZip({ root: src, scope: 'agent', paths: [p], origin: {} })
  const dst = tmp('wf-dst2-')
  put(dst, 'f.txt', 'stara')
  const { report } = applyWorkspaceZip({ root: dst, zip, stamp: () => 'T' })
  assert.deepEqual(report.conflicts, [{ path: 'f.txt', keptAs: join(dst, 'f.txt.przed-importem-T') }])
  assert.equal(readFileSync(join(dst, 'f.txt'), 'utf8'), 'nowa')
  assert.equal(readFileSync(join(dst, 'f.txt.przed-importem-T'), 'utf8'), 'stara')
  // Drugie zastosowanie tego samego: identyczny -> written, bez nowej kopii.
  const again = applyWorkspaceZip({ root: dst, zip, stamp: () => 'U' })
  assert.deepEqual(again.report.written, ['f.txt'])
  assert.equal(again.report.conflicts.length, 0)
  assert.equal(existsSync(join(dst, 'f.txt.przed-importem-U')), false)
})

test('apply: sha w manifescie nie zgadza sie z trescia -> pominiete', () => {
  const src = tmp('wf-src3-')
  const p = put(src, 'f.txt', 'tresc')
  const { zip } = packWorkspaceZip({ root: src, scope: 'agent', paths: [p], origin: {} })
  // Podmieniamy manifest na zly sha przez ponowne spakowanie z recznym wpisem.
  const { manifest, tree } = readWorkspaceZip(zip)
  manifest.files[0].sha256 = 'f'.repeat(64)
  const bad = writeZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['tree/f.txt', tree.get('f.txt')]])
  const dst = tmp('wf-dst3-')
  const { report } = applyWorkspaceZip({ root: dst, zip: bad })
  assert.equal(existsSync(join(dst, 'f.txt')), false)
  assert.equal(report.skipped.find((s) => s.path === 'f.txt').reason, 'sha-mismatch')
})

test('safeRelSegments: odrzuca ucieczki i nazwy windowsowe', () => {
  assert.deepEqual(safeRelSegments('a/b.txt', 'linux'), ['a', 'b.txt'])
  assert.equal(safeRelSegments('../x', 'linux'), null)
  assert.equal(safeRelSegments('/abs', 'linux'), null)
  assert.equal(safeRelSegments('C:/x', 'linux'), null)
  assert.equal(safeRelSegments('a/\0b', 'linux'), null)
  assert.equal(safeRelSegments('a/CON', 'win32'), null)
  assert.equal(safeRelSegments('a/CON', 'linux')?.length, 2)
  assert.equal(safeRelSegments('a/b.', 'win32'), null)
})

test('readWorkspaceZip: sciezka z ucieczka ../ odrzucona juz przez czytnik ZIP', () => {
  const manifest = { version: 1, origin: {}, scope: 'agent', files: [], skipped: [] }
  const zip = writeZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['tree/../ucieczka.txt', Buffer.from('zle')]])
  assert.throws(() => applyWorkspaceZip({ root: tmp('wf-esc-'), zip, platform: 'linux' }), /Niepoprawny ZIP/)
})

test('apply: nazwa zarezerwowana Windows pominieta jako unsafe-path', () => {
  const manifest = { version: 1, origin: {}, scope: 'agent', files: [{ path: 'CON', sha256: 'x', size: 1 }], skipped: [] }
  const zip = writeZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['tree/CON', Buffer.from('zle')]])
  const dst = tmp('wf-dst4-')
  const { report } = applyWorkspaceZip({ root: dst, zip, platform: 'win32' })
  assert.equal(report.skipped.find((s) => s.reason === 'unsafe-path').path, 'CON')
  assert.equal(existsSync(join(dst, 'CON')), false)
})

test('diffAgainstBase: nowe, zmienione i usuniete wzgledem manifestu', () => {
  const root = tmp('wf-diff-')
  put(root, 'same.txt', 'same')
  put(root, 'changed.txt', 'new')
  put(root, 'added.txt', 'add')
  const base = collectFiles({
    root, scope: 'project', origin: {},
  }).manifest
  // Manifest bazowy ma inna tresc changed.txt i plik removed.txt, ktorego juz nie ma.
  base.files = [
    { path: 'same.txt', sha256: base.files.find((f) => f.path === 'same.txt').sha256, size: 4 },
    { path: 'changed.txt', sha256: 'a'.repeat(64), size: 3 },
    { path: 'removed.txt', sha256: 'b'.repeat(64), size: 1 },
  ]
  const { paths, deleted } = diffAgainstBase(root, base)
  const rels = paths.map((p) => p.replaceAll('\\', '/').split('/').at(-1)).sort()
  assert.deepEqual(rels, ['added.txt', 'changed.txt'])
  assert.deepEqual(deleted, ['removed.txt'])
})
