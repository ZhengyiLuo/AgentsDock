import assert from 'node:assert/strict'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { MediaGrid } from '../src/components/MediaGrid'
import { ArtifactFileViewerModal } from '../src/components/file-viewer/ArtifactFileViewerModal'
import { WorkspaceFileViewerModal } from '../src/components/file-viewer/WorkspaceFileViewerModal'
import { FileViewerContext } from '../src/components/file-viewer/FileViewerContext'
import { useFileTransfer } from '../src/components/file-viewer/useFileTransfer'
import { FileTransferNotice } from '../src/components/file-viewer/FileTransferNotice'
import { Directory, File, nativeTransfer, setTestWidth } from './file-transfer-mocks'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import type { AgentFile, WorkspaceInfo } from '../src/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const insets = { top: 30, bottom: 20, left: 0, right: 0 }
const viewerContext = { viewerActive: false, openArtifacts() {}, openWorkspace() {}, closeViewer() {}, setPresentationBlocked() {} }
const workspaceEntry = { name: 'report.txt', path: 'folder/report.txt', kind: 'file' as const, size: 100 }
const baseFile: AgentFile = { id: 'file/one', session_id: 'session-a', filename: 'report.txt', size: 100 }
const connection = () => setTestClient({
  fileURL: (session, id) => `https://synthetic.invalid/api/sessions/${encodeURIComponent(session)}/files/${encodeURIComponent(id)}`,
  workspaceDownloadURL: (session, path) => `https://synthetic.invalid/api/sessions/${encodeURIComponent(session)}/workspace/download?path=${encodeURIComponent(path)}`,
  workspacePreviewURL: () => 'https://synthetic.invalid/preview',
  authHeaders: () => ({ Authorization: 'Bearer synthetic-test-token' }),
  workspaceInfo: async () => ({ root: '/server/workspace', name: 'Workspace', read_only: true, capability_version: 2, max_text_file_bytes: 1000 } as WorkspaceInfo),
  workspaceEntries: async () => ({ entries: [workspaceEntry], total: 1, has_more: false, path: '', offset: 0, limit: 500 }),
})
function reset() {
  nativeTransfer.reset()
  setTestWidth(390)
  resetComponentStore({ selectedSessionId: 'session-a', pins: [], profiles: [], serverURL: 'https://synthetic.invalid' })
  connection()
}
let renderer!: ReturnType<typeof create>
const host = (predicate: (node: ReactTestInstance) => boolean) => renderer.root.findAll(node => node.type === 'Pressable' && predicate(node))[0]
const label = (value: string) => host(node => node.props.accessibilityLabel === value)
const id = (value: string) => host(node => node.props.testID === value)
const rendered = () => JSON.stringify(renderer.toJSON())
const flush = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
const click = async (node: ReactTestInstance) => { assert(node, 'Expected a rendered tappable'); await act(async () => { node.props.onPress() }) }
const close = async () => { await act(async () => { renderer.unmount() }); await flush() }
type Variant = { name: string; family: 'media' | 'artifact' | 'workspace'; compact?: boolean; filename?: string; width?: number; fallback?: boolean; video?: boolean }
const variants: Variant[] = [
  { name: 'timeline image tile', family: 'media', filename: 'image.png' },
  { name: 'timeline file row', family: 'media' },
  { name: 'unsupported file identity', family: 'media', filename: 'archive.zip', fallback: true },
  { name: 'inspector media tile', family: 'media', compact: true, filename: 'clip.mp4' },
  { name: 'inspector file row', family: 'media', compact: true },
  { name: 'artifact phone overflow', family: 'artifact' },
  { name: 'artifact iPad header', family: 'artifact', width: 1024 },
  { name: 'artifact preview fallback', family: 'artifact', fallback: true },
  { name: 'artifact video fallback', family: 'artifact', fallback: true, video: true, filename: 'clip.mp4' },
  { name: 'workspace phone download', family: 'workspace' },
  { name: 'workspace iPad download', family: 'workspace', width: 1024 },
  { name: 'workspace preview fallback', family: 'workspace', fallback: true },
]
async function mount(variant: Variant) {
  setTestWidth(variant.width ?? 390)
  const file = { ...baseFile, filename: variant.filename ?? baseFile.filename }
  await act(async () => {
    renderer = create(variant.family === 'media'
      ? <FileViewerContext.Provider value={viewerContext}><MediaGrid files={[file]} sessionId="session-a" compact={variant.compact} /></FileViewerContext.Provider>
      : variant.family === 'artifact'
        ? <ArtifactFileViewerModal request={{ kind: 'artifacts', sessionId: 'session-a', files: [file], initialId: file.id, ownerKey: 'test' }} modalInsets={insets} onClose={() => {}} />
        : <WorkspaceFileViewerModal request={{ kind: 'workspace', sessionId: 'session-a' }} modalInsets={insets} onClose={() => {}} />)
  })
  if (variant.family === 'workspace') await click(label('Open file report.txt'))
  if (variant.family === 'artifact' && !variant.fallback && !variant.width) await click(label('More file actions'))
  return variant.fallback
    ? variant.family === 'media' ? label(`Download ${file.filename}`) : id(variant.video ? 'video-fallback-download' : 'preview-fallback-download')
    : label(variant.family === 'media' ? 'Download' : 'Download file')
}

// Real controls, hooks, notices and adapter are exercised for every entry point.
// Each delayed picker must appear before the first authenticated request.
for (const variant of variants) {
  reset()
  const picker = deferred<Directory>()
  const download = deferred<File>()
  nativeTransfer.picker = () => picker.promise
  nativeTransfer.download = file => {
    const signal = nativeTransfer.downloads.at(-1)!.options.signal!
    signal.addEventListener('abort', () => download.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true })
    return download.promise
  }
  const button = await mount(variant)
  await act(async () => { button.props.onPress(); button.props.onPress() })
  assert.equal(nativeTransfer.pickerCalls, 1, `${variant.name}: rapid repeated taps cannot present two pickers`)
  assert.equal(nativeTransfer.downloads.length, 0, `${variant.name}: location must be chosen before network`)
  assert.match(rendered(), /Choose a folder/, `${variant.name}: immediate visible response`)
  await act(async () => picker.resolve(new Directory('file:///user-selected-folder')))
  assert.equal(nativeTransfer.downloads.length, 1, variant.name)
  const current = nativeTransfer.downloads[0]
  assert.equal(current.options.headers?.Authorization, 'Bearer synthetic-test-token')
  assert.match(current.url, variant.family === 'workspace' ? /\/workspace\/download\?path=folder%2Freport.txt$/ : /\/sessions\/session-a\/files\/file%2Fone$/)
  await act(async () => current.options.onProgress!({ bytesWritten: 25, totalBytes: 100 }))
  assert.match(rendered(), /25%/, `${variant.name}: real progress callback reaches the visible notice`)
  assert(id('file-transfer-cancel'), `${variant.name}: cancellable transfer`)
  await act(async () => { nativeTransfer.put(current.file.uri, 100); download.resolve(current.file) })
  await flush()
  assert.match(rendered(), /Saved .* to the selected folder/, `${variant.name}: completion stays visible`)
  assert.equal(nativeTransfer.shares.length, 0, `${variant.name}: Download never falls through to Share`)
  assert.equal(nativeTransfer.copies.length, 1)
  assert.equal(nativeTransfer.copies[0].overwrite, false)
  assert.equal(nativeTransfer.deleted.length, 1, `${variant.name}: owned cache is removed after saving`)
  await close()
  console.log(`PASS ${variant.name}: picker first, repeated taps, authenticated request, progress, save, cleanup`)
}

for (const variant of [variants[0], variants[6], variants[9]]) {
  reset()
  const button = await mount(variant)
  nativeTransfer.download = () => Promise.reject(new Error('HTTP 403: access expired'))
  await click(button)
  await flush()
  assert.match(rendered(), /Could not download .*HTTP 403/, `${variant.family}: failure visible in current view`)
  assert.equal(nativeTransfer.copies.length, 0)
  assert.equal(nativeTransfer.shares.length, 0)
  assert.equal(nativeTransfer.deleted.length, 1)
  nativeTransfer.download = async file => { nativeTransfer.put(file.uri, 100); return file }
  await click(label(variant.family === 'media' ? 'Download' : 'Download file'))
  await flush()
  assert.match(rendered(), /Saved /, `${variant.family}: failure releases the action for retry`)
  await close()

  reset()
  const cancelButton = await mount(variant)
  nativeTransfer.download = file => new Promise((_resolve, reject) => {
    nativeTransfer.put(file.uri, 10)
    nativeTransfer.downloads.at(-1)!.options.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true })
  })
  await click(cancelButton)
  await click(id('file-transfer-cancel'))
  await flush()
  assert(nativeTransfer.downloads[0].options.signal!.aborted)
  assert.match(rendered(), /Download cancelled/)
  assert.equal(nativeTransfer.copies.length, 0)
  assert.equal(nativeTransfer.files().size, 0, `${variant.family}: partial download removed on Cancel`)
  await close()

  reset()
  const picker = deferred<Directory>()
  nativeTransfer.picker = () => picker.promise
  await click(await mount(variant))
  await act(async () => useAppStore.setState({ selectedSessionId: 'session-b' }))
  await act(async () => picker.resolve(new Directory('file:///user-selected-folder')))
  await flush()
  assert.equal(nativeTransfer.downloads.length, 0, `${variant.family}: a stale chooser cannot download another chat's file`)
  assert.equal(nativeTransfer.copies.length, 0)
  await close()

  reset()
  nativeTransfer.download = file => new Promise((_resolve, reject) => {
    nativeTransfer.put(file.uri, 12)
    nativeTransfer.downloads.at(-1)!.options.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true })
  })
  await click(await mount(variant))
  const previous = nativeTransfer.downloads[0]
  await act(async () => { connection(); useAppStore.setState({ profileGeneration: 2 }) })
  await flush()
  assert(previous.options.signal!.aborted, `${variant.family}: replacing the server cancels native work`)
  assert.equal(nativeTransfer.copies.length, 0)
  assert.equal(nativeTransfer.files().size, 0)
  assert.doesNotMatch(rendered(), /Could not download|Download cancelled|Downloading/, `${variant.family}: old connection cannot publish status into the replacement`)
  await close()
  console.log(`PASS ${variant.family}: visible error, retry, cancel, partial cleanup, stale chat and replaced client`)
}

reset()
nativeTransfer.picker = () => Promise.reject(Object.assign(new Error('File picking was cancelled by the user'), { code: 'ERR_FILE_PICKING_CANCELLED' }))
await click(await mount(variants[0]))
await flush()
assert.match(rendered(), /Download cancelled/)
assert.doesNotMatch(rendered(), /Could not download/)
assert.equal(nativeTransfer.downloads.length, 0)
await close()

// An unavailable native picker must fail visibly without consuming bandwidth.
reset()
const pickDirectory = Directory.pickDirectoryAsync
;(Directory as any).pickDirectoryAsync = undefined
await click(await mount(variants[0]))
await flush()
assert.match(rendered(), /Choosing a download folder is unavailable/)
assert.equal(nativeTransfer.downloads.length, 0)
Directory.pickDirectoryAsync = pickDirectory
await close()

// Collision copies retain the exact user-selected folder object, which matters
// for Android provider tree URIs and iOS security-scoped access.
reset()
nativeTransfer.picker = async () => new Directory('content://synthetic.provider/tree/picked-folder')
nativeTransfer.put('content://synthetic.provider/tree/picked-folder/report.txt', 37)
let copyAttempt = 0
nativeTransfer.copy = async (_source, destination) => {
  copyAttempt += 1
  if (copyAttempt === 2) {
    nativeTransfer.put(destination.uri, 42)
    throw Object.assign(new Error('NSCocoaErrorDomain Code=516 "localized collision"'), { code: 'ERR_UNEXPECTED' })
  }
}
await click(await mount(variants[1]))
await flush()
assert.match(rendered(), /Saved report.txt \(2\)|Saved report \(2\).txt/)
const saved = nativeTransfer.files()
assert.equal(saved.get('content://synthetic.provider/tree/picked-folder/report.txt'), 37)
assert.equal(saved.get('content://synthetic.provider/tree/picked-folder/report (1).txt'), 42)
assert.equal(saved.get('content://synthetic.provider/tree/picked-folder/report (2).txt'), 100)
assert(nativeTransfer.copies.every(copy => copy.overwrite === false && copy.directoryTarget), 'Native copies must target the picked Directory, never append names to provider tree URIs')
await close()

reset()
nativeTransfer.copy = async () => { throw new Error('Cloud folder access was revoked') }
await click(await mount(variants[1]))
await flush()
assert.match(rendered(), /Cloud folder access was revoked/)
assert.equal(nativeTransfer.copies.length, 1, 'Provider failures must not be treated as filename collisions')
assert.equal(nativeTransfer.deleted.length, 1)
await close()

reset()
const unknownDownload = deferred<File>()
nativeTransfer.download = () => unknownDownload.promise
await click(await mount(variants[9]))
const unknownRequest = nativeTransfer.downloads[0]
await act(async () => unknownRequest.options.onProgress!({ bytesWritten: 50, totalBytes: -1 }))
assert.match(rendered(), /50 B downloaded/)
assert.equal(renderer.root.findAll(node => node.props.accessibilityRole === 'progressbar').length, 0, 'Unknown content length must not invent a percentage')
await act(async () => { nativeTransfer.put(unknownRequest.file.uri, 100); unknownDownload.resolve(unknownRequest.file) })
await flush()
await close()

// Share remains a distinct action and waits until the local file is ready.
for (const variant of [variants[6], variants[9]]) {
  reset()
  await mount(variant)
  const transfer = deferred<File>()
  nativeTransfer.download = () => transfer.promise
  await click(label('Share file'))
  assert.equal(nativeTransfer.pickerCalls, 0)
  assert.equal(nativeTransfer.shares.length, 0)
  assert.match(rendered(), /Downloading/)
  const current = nativeTransfer.downloads[0]
  await act(async () => { nativeTransfer.put(current.file.uri, 100); transfer.resolve(current.file) })
  await flush()
  assert.equal(nativeTransfer.shares.length, 1)
  assert.equal(nativeTransfer.copies.length, 0)
  assert.equal(nativeTransfer.deleted.length, 0, 'Recipient may still read a shared file after chooser dismissal')
  await close()

  reset()
  nativeTransfer.sharingAvailable = false
  await mount(variant)
  await click(label('Share file'))
  await flush()
  assert.match(rendered(), /File sharing is unavailable/)
  assert.equal(nativeTransfer.downloads.length, 0)
  await close()
}

// Exercise a mounted hook across A -> B -> A while its first picker is still
// open. The old cancellation must not replace the newest action's visible error.
function TransferProbe({ scope }: { scope: string }) {
  const transfer = useFileTransfer(scope)
  return <><button onClick={() => void transfer.start({ action: 'download', filename: 'test.txt', title: 'test.txt', contentType: 'text/plain', source: () => ({ url: 'https://synthetic.invalid/test', headers: {} }), isCurrent: () => true })} /><FileTransferNotice state={transfer.state} onCancel={transfer.cancel} onDismiss={transfer.dismiss} /></>
}
reset()
const stalePicker = deferred<Directory>()
nativeTransfer.picker = () => stalePicker.promise
await act(async () => { renderer = create(<TransferProbe scope="a" />) })
await act(async () => renderer.root.findByType('button').props.onClick())
await act(async () => renderer.update(<TransferProbe scope="b" />))
await act(async () => renderer.update(<TransferProbe scope="a" />))
await act(async () => renderer.root.findByType('button').props.onClick())
assert.match(rendered(), /Another file is being saved/)
await act(async () => stalePicker.resolve(new Directory('file:///user-selected-folder')))
await flush()
assert.match(rendered(), /Another file is being saved/)
assert.doesNotMatch(rendered(), /Download cancelled/)
assert.equal(nativeTransfer.downloads.length, 0)
await close()

console.log('PASS picker cancellation, missing capability, provider collisions, cloud error, separate Share, A→B→A stale guard')
console.log('All rendered file transfer behavioral tests passed')
