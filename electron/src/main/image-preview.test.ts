// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { imagePreviewResponse } from './image-preview'

const { PNG } = createRequire(import.meta.url)('pngjs') as {
  PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Uint8Array } } }
}
const request = () => new Request('agentsdock-media://file/profile/1/chat/image')
const fixture = (name = 'rgb') => Uint8Array.from(readFileSync(join(__dirname, 'test-fixtures/tiff', `${name}.tiff`)))
const original = (name = 'rgb') => new Response(fixture(name), { headers: { 'Content-Type': 'image/tiff' } })
const expectedPixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 0, 255, 255, 255]

describe('TIFF media previews', () => {
  // These tiny, synthetic 2x3 colour fixtures are encoded by Pillow/libtiff;
  // codec tests therefore do not generate their inputs with the decoder.
  it.each(['rgb', 'big-endian', 'lzw', 'deflate', 'packbits', 'multipage'])('decodes the first %s TIFF page into real PNG pixels off the main thread', async name => {
    const response = await imagePreviewResponse(request(), async () => original(name))
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const png = PNG.sync.read(bytes)
    expect([png.width, png.height]).toEqual([2, 3])
    expect([...png.data]).toEqual(expectedPixels)
  })

  it.each(['jpeg', 'fax'])('decodes %s TIFF compression', async name => {
    const response = await imagePreviewResponse(request(), async () => original(name))
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()))
    expect([png.width, png.height]).toEqual([2, 3])
    expect([...png.data.filter((_value, index) => index % 4 === 3)]).toEqual([255, 255, 255, 255, 255, 255])
  })

  it('applies TIFF orientation instead of displaying the raw pixel order', async () => {
    const response = await imagePreviewResponse(request(), async () => original('rotated'))
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()))
    expect([png.width, png.height]).toEqual([3, 2])
    expect([...png.data]).toEqual([255, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0, 255])
  })

  it('refetches the full TIFF after a byte-range response and drops original length and validators', async () => {
    const partialCancelled = vi.fn()
    const partial = new Response(new ReadableStream({ cancel: partialCancelled }), {
      status: 206,
      headers: { 'Content-Type': 'image/tiff', 'Content-Range': 'bytes 0-9/158' }
    })
    const full = original()
    full.headers.set('ETag', 'original-tiff')
    full.headers.set('Accept-Ranges', 'bytes')
    const fetchOriginal = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(full)
    const ranged = new Request(request(), { headers: { Range: 'bytes=0-9' } })
    const response = await imagePreviewResponse(ranged, fetchOriginal)
    expect(partialCancelled).toHaveBeenCalledOnce()
    expect(fetchOriginal).toHaveBeenCalledTimes(2)
    expect(fetchOriginal.mock.calls[0][0]).toBe(ranged)
    expect(fetchOriginal.mock.calls[1][0].headers.get('Range')).toBeNull()
    expect(response.headers.get('Content-Range')).toBeNull()
    expect(response.headers.get('ETag')).toBeNull()
    expect(response.headers.get('Accept-Ranges')).toBeNull()
    expect(PNG.sync.read(Buffer.from(await response.arrayBuffer())).width).toBe(2)
  })

  it.each([
    ['photo.TIF', {}],
    ['', { 'Content-Disposition': 'inline; filename="photo.tiff"' }],
    ['', { 'Content-Type': 'image/x-tiff; charset=binary' }]
  ])('recognizes TIFF from legacy metadata (%s)', async (filename, headers) => {
    const response = await imagePreviewResponse(request(), async () => new Response(fixture(), { headers }), filename)
    expect(response.headers.get('Content-Type')).toBe('image/png')
  })

  it('keeps HEAD probes bodyless without decoding or reporting the original byte length', async () => {
    const response = await imagePreviewResponse(new Request(request(), { method: 'HEAD' }), async () => new Response(null, {
      headers: { 'Content-Type': 'image/tiff', 'Content-Length': '158' }
    }))
    expect(response.body).toBeNull()
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBeNull()
  })

  it.each(['image/png', 'video/mp4', 'application/pdf'])('leaves %s streaming untouched', async type => {
    const response = new Response('original bytes', { status: 206, headers: { 'Content-Type': type } })
    const fetchOriginal = vi.fn().mockResolvedValue(response)
    expect(await imagePreviewResponse(request(), fetchOriginal)).toBe(response)
    expect(fetchOriginal).toHaveBeenCalledOnce()
    expect(response.bodyUsed).toBe(false)
  })

  it('preserves upstream errors', async () => {
    const response = new Response('Not found', { status: 404 })
    expect(await imagePreviewResponse(request(), async () => response, 'missing.tiff')).toBe(response)
  })

  it.each(['invalid header', 'truncated directory', 'bad strip offset', 'unsupported compression'])('rejects %s and leaves the next preview usable', async kind => {
    const bytes = fixture()
    const view = new DataView(bytes.buffer)
    const offset = view.getUint32(4, true)
    let malformed = bytes
    if (kind === 'invalid header') malformed = new Uint8Array([1, 2, 3])
    if (kind === 'truncated directory') malformed = bytes.slice(0, offset + 2)
    for (let entry = offset + 2; entry < offset + 2 + view.getUint16(offset, true) * 12; entry += 12) {
      if (kind === 'bad strip offset' && view.getUint16(entry, true) === 273) view.setUint32(entry + 8, bytes.length + 1, true)
      if (kind === 'unsupported compression' && view.getUint16(entry, true) === 259) view.setUint16(entry + 8, 65535, true)
    }
    await expect(imagePreviewResponse(request(), async () => new Response(malformed), 'bad.tiff')).rejects.toThrow('could not decode')
    expect((await imagePreviewResponse(request(), async () => original())).headers.get('Content-Type')).toBe('image/png')
  })

  it('cancels an interrupted upstream read promptly and can preview again', async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'image/tiff' } })
    const pending = imagePreviewResponse(new Request(request(), { signal: controller.signal }), async () => response)
    const rejected = expect(pending).rejects.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await rejected
    expect(cancelled).toHaveBeenCalledOnce()
    expect((await imagePreviewResponse(request(), async () => original())).ok).toBe(true)
  })

  it('does not apply the decoder watchdog to a slow remote transfer', async () => {
    vi.useFakeTimers()
    let send: (() => void) | undefined
    const response = new Response(new ReadableStream({
      start(controller) { send = () => { controller.enqueue(fixture()); controller.close() } }
    }), { headers: { 'Content-Type': 'image/tiff' } })
    const pending = imagePreviewResponse(request(), async () => response)
    try {
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
      send?.()
    }
    expect((await pending).headers.get('Content-Type')).toBe('image/png')
  })

  it('keeps queued sources unbuffered and cancels them without poisoning subsequent previews', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const stalledSource = () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'image/tiff' } })
    const first = imagePreviewResponse(new Request(request(), { signal: firstController.signal }), async () => stalledSource())
    const second = imagePreviewResponse(new Request(request(), { signal: secondController.signal }), async () => stalledSource())
    const settled = Promise.allSettled([first, second])
    const controller = new AbortController()
    const cancelled = vi.fn()
    const source = new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'image/tiff' } })
    const queued = imagePreviewResponse(new Request(request(), { signal: controller.signal }), async () => source)
    const rejected = expect(queued).rejects.toThrow('cancelled')
    await new Promise(resolve => setImmediate(resolve))
    expect(source.bodyUsed).toBe(false)
    expect(source.body?.locked).toBe(false)
    controller.abort()
    await rejected
    expect(cancelled).toHaveBeenCalledOnce()
    firstController.abort()
    secondController.abort()
    await settled
    expect((await imagePreviewResponse(request(), async () => original())).ok).toBe(true)
  })
})
