import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

// A decode needs both compressed input and temporary RGBA/PNG buffers. These
// safeguards apply only to previews; native open/save always fetch the original.
const MAX_TIFF_SOURCE_BYTES = 256 * 1024 * 1024
const TIFF_PREVIEW_TIMEOUT_MS = 30_000
const MAX_ACTIVE_TIFF_PREVIEWS = 2
const pendingPreviews: Array<() => void> = []
let activePreviews = 0

export async function imagePreviewResponse(
  request: Request,
  fetchOriginal: (request: Request) => Promise<Response>,
  filename = ''
): Promise<Response> {
  let response = await fetchOriginal(request)
  if (!response.ok || !isTiffResponse(response, filename)) return response
  // Byte ranges describe the original TIFF, never the generated PNG. Fetch the
  // complete source only for this format and keep video/PDF streaming unchanged.
  if (request.method === 'GET' && response.status === 206) {
    await response.body?.cancel()
    const headers = new Headers(request.headers)
    headers.delete('Range')
    response = await fetchOriginal(new Request(request, { headers }))
    if (response.status !== 200) return response
  }
  const headers = new Headers({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  if (request.method === 'HEAD') return new Response(null, { headers })
  try {
    request.signal.throwIfAborted()
    const png = await queueTiffPreview(response, request.signal)
    headers.set('Content-Length', String(png.byteLength))
    return new Response(png, { headers })
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
}

function queueTiffPreview(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  // Admit before buffering so a grid of TIFFs cannot retain unbounded compressed
  // data in the main process. Waiting responses retain stream backpressure.
  // Transfers have no new deadline; two slots let another preview make progress
  // while a remote source is slow. Closing a queued view cancels it immediately.
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = pendingPreviews.indexOf(start)
      if (index >= 0) pendingPreviews.splice(index, 1)
      reject(new Error('TIFF preview cancelled'))
    }
    const start = () => {
      signal.removeEventListener('abort', abort)
      activePreviews++
      void readTiffSource(response, signal).then(bytes => decodeTiffPreview(bytes, signal)).then(resolve, reject).finally(() => {
        activePreviews--
        pendingPreviews.shift()?.()
      })
    }
    signal.addEventListener('abort', abort, { once: true })
    if (activePreviews >= MAX_ACTIVE_TIFF_PREVIEWS) pendingPreviews.push(start)
    else start()
  })
}

function isTiffResponse(response: Response, filename: string): boolean {
  const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  return type === 'image/tiff' || type === 'image/x-tiff'
    || /\.tiff?$/i.test(filename)
    || /filename\*?=(?:UTF-8''|["'])?[^;]*\.tiff?(?:["'])?(?:;|$)/i.test(response.headers.get('Content-Disposition') || '')
}

async function readTiffSource(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!response.body) throw new Error('Empty TIFF image')
  if (Number(response.headers.get('Content-Length')) > MAX_TIFF_SOURCE_BYTES) throw new Error('TIFF exceeds the preview memory budget')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      total += value.byteLength
      if (total > MAX_TIFF_SOURCE_BYTES) throw new Error('TIFF exceeds the preview memory budget')
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes.buffer
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function decodeTiffPreview(bytes: ArrayBuffer, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'tiff-preview-worker.cjs'), {
      workerData: bytes,
      transferList: [bytes],
      resourceLimits: { maxOldGenerationSizeMb: 128 }
    })
    let settled = false
    const finish = (error?: Error, png?: Uint8Array<ArrayBuffer>) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      signal.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error)
      else if (png) resolve(png)
    }
    const abort = () => finish(new Error('TIFF preview cancelled'))
    // Malformed compressed data must not leave a busy decoder alive forever.
    // This watchdog starts after transfer and queueing have both completed.
    const watchdog = setTimeout(() => finish(new Error('TIFF decoder stopped responding')), TIFF_PREVIEW_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.once('message', (result: { png?: Uint8Array<ArrayBuffer>; error?: string }) => {
      finish(result.error || !result.png ? new Error(result.error || 'Invalid TIFF preview') : undefined, result.png)
    })
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    worker.once('exit', () => finish(new Error('TIFF preview stopped')))
  })
}
