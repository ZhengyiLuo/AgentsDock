import assert from 'node:assert/strict'
import { createUploadFormData } from './upload-form'

interface FormPart { name: string; type: string; bytes(): Promise<Uint8Array> }

// Node's global FormData coerces non-Blob values to strings, which would discard
// the byte-backed part. Mirror the Expo/RawFormData shape used by upload.test.ts
// so the appended part survives and its lazy bytes() can be exercised.
class RawFormData {
  readonly parts: { name: string; value: unknown }[] = []
  append(name: string, value: unknown): void { this.parts.push({ name, value }) }
  get(name: string): unknown { return this.parts.find(part => part.name === name)?.value }
}

const originalFormData = globalThis.FormData
globalThis.FormData = RawFormData as unknown as typeof FormData
try {
  const readable = createUploadFormData({ uri: 'file:///tmp/photo.jpg', name: 'photo.jpg' })
  const readablePart = (readable as unknown as RawFormData).get('file') as FormPart
  assert.ok((await readablePart.bytes()).length > 0, 'a readable file yields bytes')

  // An unreadable iOS/iCloud URI must surface a clear, retry-able error rather
  // than an opaque reject that (before the fix) could strand the chip.
  const unreadable = createUploadFormData({ uri: 'file:///tmp/photo.jpg#unreadable', name: 'photo.jpg' })
  const unreadablePart = (unreadable as unknown as RawFormData).get('file') as FormPart
  await assert.rejects(
    unreadablePart.bytes(),
    /Couldn.t read .*photo\.jpg.*iCloud/i,
    'an unreadable photo URI fails with a readable, actionable message',
  )
} finally {
  globalThis.FormData = originalFormData
}

console.log('upload-form byte-read failure handling regressions passed')
