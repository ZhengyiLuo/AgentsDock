// This worker has the same filename in source and in the packaged main bundle.
// Pure JavaScript codecs keep TIFF previews consistent on macOS, Linux and Windows.
const { parentPort, workerData } = require('node:worker_threads')
const UTIF = require('utif')
const { PNG } = require('pngjs')

// Bound temporary decode allocations, not the size of files users can download.
const DECODE_BYTES = 256 * 1024 * 1024

function tiffToPNG(buffer) {
  const view = new DataView(buffer)
  if (view.byteLength < 8) throw new Error('Invalid TIFF header')
  const order = view.getUint16(0)
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Invalid TIFF byte order')
  const little = order === 0x4949
  if (view.getUint16(2, little) !== 42) throw new Error('Unsupported TIFF format')
  const offset = view.getUint32(4, little)
  if (offset < 8 || offset + 2 > view.byteLength) throw new Error('Invalid TIFF directory')
  const count = view.getUint16(offset, little)
  const end = offset + 2 + count * 12
  if (end + 4 > view.byteLength) throw new Error('Incomplete TIFF directory')
  const typeBytes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]
  for (let entry = offset + 2; entry < end; entry += 12) {
    const tag = view.getUint16(entry, little)
    const type = view.getUint16(entry + 2, little)
    const length = view.getUint32(entry + 4, little) * (typeBytes[type] || 0)
    const start = length <= 4 ? entry + 8 : view.getUint32(entry + 8, little)
    if (!typeBytes[type] || start + length > view.byteLength) throw new Error('Invalid TIFF tag')
    // A preview uses only the first page. Do not traverse unrelated EXIF, maker
    // notes or subdirectories (including cycles in malformed metadata).
    if ([330, 34665, 50740, 37500].includes(tag)) view.setUint16(entry, 0, little)
  }
  view.setUint32(end, 0, little)
  const [page] = UTIF.decode(buffer)
  const width = page.t256?.[0]
  const height = page.t257?.[0]
  const bits = page.t258 || [1]
  const channels = page.t277?.[0] || bits.length
  const compression = page.t259?.[0] || 1
  const photo = page.t262?.[0] ?? 2
  const samples = page.t339 || [1]
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
    || width * height * Math.max(4, channels * Math.ceil(Math.max(...bits) / 8)) > DECODE_BYTES) {
    throw new Error('TIFF dimensions exceed the preview memory budget')
  }
  if (![1, 3, 4, 5, 6, 7, 8, 32946, 32773, 32809].includes(compression)
    || page.t284?.[0] === 2 || samples.some(sample => sample !== 1)
    || !bits.every(bit => bit === bits[0])
    || !(photo === 0 && [1, 4, 8].includes(bits[0])
      || photo === 1 && [1, 2, 8, 16].includes(bits[0]) && channels === 1
      || photo === 2 && [8, 16].includes(bits[0]) && [3, 4].includes(channels)
      || photo === 3 && bits[0] === 8 && page.t320?.length === 768
      || photo === 5 && bits[0] === 8 && [4, 5].includes(channels)
      || photo === 6 && [6, 7].includes(compression))) {
    throw new Error('Unsupported TIFF image encoding')
  }
  const offsets = page.t273 || page.t324
  const lengths = page.t279 || page.t325
  if (!offsets?.length || !lengths || offsets.length !== lengths.length
    || offsets.some((start, index) => start < 0 || lengths[index] < 1 || start + lengths[index] > buffer.byteLength)) {
    throw new Error('Incomplete TIFF image data')
  }
  if (page.t322 || page.t323) {
    const tileWidth = page.t322?.[0]
    const tileHeight = page.t323?.[0]
    if (!tileWidth || !tileHeight || tileWidth * tileHeight * channels * Math.ceil(bits[0] / 8) > DECODE_BYTES) {
      throw new Error('Invalid TIFF tile dimensions')
    }
  }
  if (compression === 32946) page.t259 = [8]
  UTIF.decodeImage(buffer, page, [page])
  let rgba = UTIF.toRGBA8(page)
  if (rgba.length !== width * height * 4) throw new Error('Incomplete TIFF pixels')
  // TIFF associated alpha is premultiplied; PNG uses straight alpha.
  if (page.t338?.[0] === 1) {
    for (let index = 0; index < rgba.length; index += 4) {
      const alpha = rgba[index + 3]
      if (alpha > 0 && alpha < 255) {
        for (let channel = 0; channel < 3; channel++) rgba[index + channel] = Math.min(255, Math.round(rgba[index + channel] * 255 / alpha))
      }
    }
  }
  const orientation = page.t274?.[0] || 1
  if (orientation < 1 || orientation > 8) throw new Error('Invalid TIFF orientation')
  const rotated = orientation >= 5
  const outputWidth = rotated ? height : width
  const outputHeight = rotated ? width : height
  if (orientation !== 1) {
    const oriented = new Uint8Array(rgba.length)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const outputX = rotated ? ([6, 7].includes(orientation) ? height - 1 - y : y) : ([2, 3].includes(orientation) ? width - 1 - x : x)
      const outputY = rotated ? ([7, 8].includes(orientation) ? width - 1 - x : x) : ([3, 4].includes(orientation) ? height - 1 - y : y)
      const source = (y * width + x) * 4
      const target = (outputY * outputWidth + outputX) * 4
      for (let channel = 0; channel < 4; channel++) oriented[target + channel] = rgba[source + channel]
    }
    rgba = oriented
  }
  return PNG.sync.write({ width: outputWidth, height: outputHeight, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) })
}

if (parentPort) {
  try {
    const png = Uint8Array.from(tiffToPNG(workerData))
    parentPort.postMessage({ png }, [png.buffer])
  } catch {
    parentPort.postMessage({ error: 'AgentsDock could not decode this TIFF image.' })
  }
}
