import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactTransferRequest, createFileTransferRunner, isFileTransferBusy,
  numberedDownloadFilename, safeDownloadFilename, workspaceTransferRequest,
  type FileTransferDependencies, type FileTransferRequest, type FileTransferState,
} from './file-transfer'
import type { AgentServerClient } from '../api/AgentServerClient'

type TestFile = { uri: string; exists: boolean; size: number | null }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(patch: Partial<FileTransferDependencies<string, TestFile>> = {}) {
  const order: string[] = [], states: FileTransferState[] = []
  const file: TestFile = { uri: 'file:///fixture/report.txt', exists: true, size: 10 }
  const dependencies: FileTransferDependencies<string, TestFile> = {
    pickDirectory: async () => { order.push('pick'); return 'chosen-folder' },
    sharingAvailable: async () => { order.push('sharing-available'); return true },
    createTemporaryFile: async name => { order.push(`temporary:${name}`); return file },
    download: async (source, target, signal, progress) => {
      assert.equal(source.url, 'https://example.invalid/authenticated-file')
      assert.equal(signal.aborted, false)
      order.push('download'); progress({ bytesWritten: 5, totalBytes: 10 }); return target
    },
    save: async (value, folder, name) => { assert.equal(value, file); assert.equal(folder, 'chosen-folder'); order.push('save'); return name },
    share: async () => { order.push('share') },
    removeTemporaryFile: async value => { assert.equal(value, file); order.push('cleanup') },
    ...patch,
  }
  const request: FileTransferRequest = {
    action: 'download', filename: 'report.txt', title: 'Report', contentType: 'text/plain', expectedBytes: 10,
    source: () => { order.push('source'); return { url: 'https://example.invalid/authenticated-file', headers: { Authorization: 'Bearer fixture-only' } } },
    isCurrent: () => true,
  }
  const controller = new AbortController()
  const runner = createFileTransferRunner(dependencies)
  const run = (value = request) => runner(value, controller.signal, state => states.push(state))
  return { order, states, file, dependencies, request, controller, runner, run }
}

test('Download shows destination choice before credentials or bytes, then reports progress/save/success', async () => {
  const picker = deferred<string>()
  const f = fixture({ pickDirectory: () => picker.promise })
  const pending = f.run()
  assert.deepEqual(f.order, [])
  assert.equal(f.states[0].phase, 'choosing')
  picker.resolve('chosen-folder')
  await pending
  assert.deepEqual(f.order, ['source', 'temporary:report.txt', 'download', 'save', 'cleanup'])
  assert.deepEqual(f.states.map(state => state.phase), ['choosing', 'downloading', 'downloading', 'saving', 'done'])
  assert.equal(f.states[2].bytesWritten, 5)
  assert.equal(f.states[2].totalBytes, 10)
  assert.match(f.states.at(-1)!.message!, /Saved report.txt to the selected folder/)
})

test('cancelling the native folder picker does not resolve credentials, download, or create a temporary file', async () => {
  const f = fixture({ pickDirectory: async () => { throw { code: 'ERR_DIRECTORY_PICKING_CANCELLED', message: 'Directory picking was cancelled by the user' } } })
  await f.run()
  assert.deepEqual(f.order, [])
  assert.equal(f.states.at(-1)!.phase, 'cancelled')
})

test('leaving the source chat while choosing a folder cannot download with a replacement connection', async () => {
  const picker = deferred<string>()
  const f = fixture({ pickDirectory: () => picker.promise })
  let current = true
  const pending = f.run({ ...f.request, isCurrent: () => current })
  current = false
  picker.resolve('chosen-folder')
  await pending
  assert.deepEqual(f.order, [])
  assert.deepEqual(f.states.map(state => state.phase), ['choosing'])
})

test('download cancellation aborts the transport and cleans only its staged file', async () => {
  const started = deferred<void>()
  const f = fixture({ download: (_source, _file, signal, progress) => new Promise((_resolve, reject) => {
    progress({ bytesWritten: 3, totalBytes: 10 })
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    started.resolve()
  }) })
  const pending = f.run()
  await started.promise
  f.controller.abort()
  await pending
  assert.equal(f.states.at(-1)!.phase, 'cancelled')
  assert.equal(f.order.at(-1), 'cleanup')
  assert.ok(!f.order.includes('save'))
})

test('one native picker owns all concurrent transfers and the lock releases after cancellation', async () => {
  const picker = deferred<string>()
  const f = fixture({ pickDirectory: () => picker.promise })
  const pending = f.run()
  await assert.rejects(f.runner(f.request, new AbortController().signal, () => {}), /Another file is being saved or shared/)
  picker.reject({ code: 'ERR_DIRECTORY_PICKING_CANCELLED' })
  await pending
  f.dependencies.pickDirectory = async () => 'chosen-folder'
  await f.runner(f.request, new AbortController().signal, () => {})
  assert.equal(f.order.filter(value => value === 'download').length, 1)
})

test('Share checks availability, reports immediate busy state, and retains staged bytes for the receiving app', async () => {
  const f = fixture()
  await f.run({ ...f.request, action: 'share' })
  assert.equal(f.states[0].phase, 'downloading')
  assert.deepEqual(f.order, ['sharing-available', 'source', 'temporary:report.txt', 'download', 'share'])
  assert.equal(f.states.at(-1)!.phase, 'done')
})

test('unavailable native sharing returns an actionable error without a silent fallback or download', async () => {
  const f = fixture({ sharingAvailable: async () => false })
  await assert.rejects(f.run({ ...f.request, action: 'share' }), /Use Download to choose a folder/)
  assert.deepEqual(f.order, [])
})

for (const phase of ['download', 'save', 'share'] as const) test(`${phase} failure remains visible to the caller and releases staged bytes`, async () => {
  const f = fixture({ [phase]: async () => { throw new Error(`${phase} failed`) } })
  await assert.rejects(f.run({ ...f.request, action: phase === 'share' ? 'share' : 'download' }), new RegExp(`${phase} failed`))
  assert.equal(f.order.at(-1), 'cleanup')
  assert.ok(!f.states.some(state => state.phase === 'done'))
})

test('incomplete immutable attachments are not saved, but valid empty files are allowed', async () => {
  const f = fixture()
  f.file.size = 9
  await assert.rejects(f.run(), /download was incomplete/)
  assert.ok(!f.order.includes('save'))
  assert.equal(f.order.at(-1), 'cleanup')
  f.file.size = 0
  await f.runner({ ...f.request, expectedBytes: 0 }, new AbortController().signal, () => {})
  assert.ok(f.order.includes('save'))
})

test('unknown-length transfers show downloaded bytes without a bogus percentage', async () => {
  const f = fixture({ download: async (_source, file, _signal, progress) => { progress({ bytesWritten: 5, totalBytes: -1 }); return file } })
  await f.run({ ...f.request, expectedBytes: undefined })
  assert.deepEqual(f.states.filter(state => state.phase === 'downloading').at(-1), { phase: 'downloading', filename: 'report.txt', bytesWritten: 5, totalBytes: undefined })
})

test('filenames keep a safe human-readable leaf and preserve extensions when numbering collisions', () => {
  assert.equal(safeDownloadFilename('../reports/final report.pdf'), 'final report.pdf')
  assert.equal(safeDownloadFilename('C:\\reports\\final.pdf'), 'final.pdf')
  assert.equal(safeDownloadFilename('..'), 'download')
  assert.equal(safeDownloadFilename('bad\u0000name.txt'), 'bad_name.txt')
  assert.equal(numberedDownloadFilename('final report.pdf', 0), 'final report.pdf')
  assert.equal(numberedDownloadFilename('final report.pdf', 2), 'final report (2).pdf')
  const unicode = safeDownloadFilename('文件'.repeat(100) + '.pdf')
  assert.ok(new TextEncoder().encode(unicode).length <= 180)
  assert.ok(unicode.endsWith('.pdf'))
})

test('artifact and workspace requests resolve only their authenticated chat-scoped endpoint', () => {
  const calls: string[] = []
  const client = {
    fileURL(session: string, id: string) { calls.push(`artifact:${session}:${id}`); return 'https://example.invalid/file' },
    workspaceDownloadURL(session: string, path: string) { calls.push(`workspace:${session}:${path}`); return 'https://example.invalid/workspace' },
    authHeaders() { return { Authorization: 'Bearer fixture-only' } },
  } as unknown as AgentServerClient
  const file = { id: 'file-id', session_id: 'chat', filename: 'report.pdf', size: 20 }
  const artifact = artifactTransferRequest(file, 'chat', client, 'download', () => true)
  assert.deepEqual(calls, [])
  assert.equal(artifact.source().headers.Authorization, 'Bearer fixture-only')
  assert.throws(() => artifactTransferRequest(file, 'other-chat', client, 'download', () => true).source(), /another chat/)
  const workspace = workspaceTransferRequest({ name: 'source.txt', path: '/server/project/source.txt', kind: 'file', size: 4 }, 'chat', client, 'share', () => true)
  workspace.source()
  assert.equal(workspace.expectedBytes, undefined, 'Mutable workspace file metadata must not reject a newer complete version')
  assert.deepEqual(calls, ['artifact:chat:file-id', 'workspace:chat:/server/project/source.txt'])
})

test('only actual transfer phases keep controls busy', () => {
  for (const phase of ['choosing', 'downloading', 'saving', 'sharing'] as const) assert.equal(isFileTransferBusy({ phase, filename: 'report' }), true)
  for (const phase of ['done', 'cancelled', 'error'] as const) assert.equal(isFileTransferBusy({ phase, filename: 'report' }), false)
  assert.equal(isFileTransferBusy(null), false)
})
