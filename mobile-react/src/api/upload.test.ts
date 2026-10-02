import assert from 'node:assert/strict'
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData'

import { mediaAssetsToUploads } from '../lib/uploads'
import { AgentServerClient } from './AgentServerClient'

interface RawFormEntry {
  name: string
  value: unknown
}

class RawFormData {
  readonly parts: RawFormEntry[] = []

  append(name: string, value: unknown): void {
    this.parts.push({ name, value })
  }

  *entries(): IterableIterator<[string, unknown]> {
    for (const part of this.parts) yield [part.name, part.value]
  }
}

interface UploadRequest {
  headers: Headers
  part: { name: string; type: string; bytes(): Promise<Uint8Array>; uri?: unknown }
  bytes: Uint8Array
  multipart: string
}

const originalFetch = globalThis.fetch
const originalFormData = globalThis.FormData
const requests: UploadRequest[] = []
globalThis.FormData = RawFormData as unknown as typeof FormData
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(init?.method, 'POST')
  assert(init?.body instanceof RawFormData)
  const entries = [...init.body.entries()]
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.[0], 'file')
  const entry = entries[0]?.[1]

  if (!entry || typeof entry !== 'object' || !('bytes' in entry) || typeof entry.bytes !== 'function') {
    throw new Error('Unsupported FormDataPart implementation')
  }
  const part = entry as UploadRequest['part']
  const bytes = await part.bytes()
  const { body } = await convertFormDataAsync(init.body as unknown as FormData, 'AgentsDockBoundary')
  requests.push({ headers: new Headers(init.headers), part, bytes, multipart: new TextDecoder().decode(body) })
  return new Response(JSON.stringify({ file: { id: 'uploaded-file', filename: part.name } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

try {
  const [photo, video] = mediaAssetsToUploads([
    { uri: 'file:///picker/render', mimeType: 'image/png' },
    { uri: 'file:///picker/movie', mimeType: 'video/mp4', fileSize: 1_000 },
  ], 1234)
  assert(photo)
  assert(video)

  const client = new AgentServerClient('https://upload.example', 'upload-token')
  const result = await client.upload('session /?', photo)
  const videoResult = await client.upload('session /?', video)
  client.dispose()

  assert.equal(result.filename, 'photo-1234-1.png')
  assert.equal(videoResult.filename, 'video-1234-2.mp4')
  assert.equal(requests.length, 2)
  const request = requests[0]
  assert(request)
  assert.equal(request.part.name, 'photo-1234-1.png')
  assert.equal(request.part.type, 'image/png')
  assert.equal('uri' in request.part, false)
  assert.equal(new TextDecoder().decode(request.bytes), 'fixture:file:///picker/render')
  assert.match(request.multipart, /content-disposition: form-data; name="file"; filename="photo-1234-1.png"/)
  assert.match(request.multipart, /content-type: image\/png/)
  assert.match(request.multipart, /fixture:file:\/\/\/picker\/render/)
  assert.equal(request.headers.get('X-ZenithDock-Token'), 'upload-token')
  assert.equal(request.headers.has('Content-Type'), false)
  const videoRequest = requests[1]
  assert(videoRequest)
  assert.equal(videoRequest.part.name, 'video-1234-2.mp4')
  assert.equal(videoRequest.part.type, 'video/mp4')
  assert.equal(new TextDecoder().decode(videoRequest.bytes), 'fixture:file:///picker/movie')
  assert.match(videoRequest.multipart, /content-disposition: form-data; name="file"; filename="video-1234-2.mp4"/)
  assert.match(videoRequest.multipart, /content-type: video\/mp4/)
} finally {
  globalThis.fetch = originalFetch
  globalThis.FormData = originalFormData
}

console.log('Expo multipart upload regression passed')
