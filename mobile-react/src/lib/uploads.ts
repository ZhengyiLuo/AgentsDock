import type { UploadRef } from '../types'

export interface PickedPhotoAsset {
  uri: string
  fileName?: string | null
  mimeType?: string | null
  fileSize?: number | null
  type?: string | null
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/ogg': 'ogv',
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  png: 'image/png',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  webm: 'video/webm',
  webp: 'image/webp',
}

/** Convert iOS/Android media-picker assets into the existing guarded upload path. */
export function mediaAssetsToUploads(assets: readonly PickedPhotoAsset[], timestamp = Date.now()): UploadRef[] {
  return assets.flatMap((asset, index) => {
    const uri = asset.uri?.trim()
    if (!uri) return []
    const pickerType = asset.mimeType?.trim() || undefined
    const explicitName = asset.fileName?.trim()
    const video = isVideoPickerAsset(asset, uri, pickerType)
    const extension = filenameExtension(explicitName) ?? uriExtension(uri) ?? (pickerType ? MIME_EXTENSIONS[pickerType.toLowerCase()] : undefined) ?? (video ? 'mp4' : 'jpg')
    const type = pickerType ?? EXTENSION_MIME_TYPES[extension]
    const upload: UploadRef = {
      uri,
      name: explicitName ? nameWithExtension(explicitName, extension) : `${video ? 'video' : 'photo'}-${timestamp}-${index + 1}.${extension}`,
    }
    if (type) upload.type = type
    if (typeof asset.fileSize === 'number' && Number.isFinite(asset.fileSize) && asset.fileSize >= 0) upload.size = asset.fileSize
    return [upload]
  })
}

export const photoAssetsToUploads = mediaAssetsToUploads

/** Detect local picker images before server metadata is available. */
export function isImageUpload(file: Pick<UploadRef, 'uri' | 'name' | 'type'>): boolean {
  if (file.type?.toLowerCase().startsWith('image/')) return true
  const candidate = (file.name || file.uri).split(/[?#]/, 1)[0]
  return /\.(avif|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(candidate)
}

/** Detect local picker videos before server metadata is available. */
export function isVideoUpload(file: Pick<UploadRef, 'uri' | 'name' | 'type'>): boolean {
  if (file.type?.toLowerCase().startsWith('video/')) return true
  const candidate = (file.name || file.uri).split(/[?#]/, 1)[0]
  return /\.(m4v|mov|mp4|ogv|ogg|webm)$/i.test(candidate)
}

function uriExtension(uri: string): string | undefined {
  return filenameExtension(uri)
}

function filenameExtension(value?: string | null): string | undefined {
  if (!value) return undefined
  const path = value.split(/[?#]/, 1)[0]
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!name.includes('.')) return undefined
  const match = name.match(/\.([a-z0-9]{2,5})$/i)
  return match?.[1]?.toLowerCase()
}

function nameWithExtension(name: string, extension: string): string {
  return filenameExtension(name) ? name : `${name}.${extension}`
}

function isVideoPickerAsset(asset: PickedPhotoAsset, uri: string, type?: string): boolean {
  if (asset.type?.toLowerCase() === 'video') return true
  if (type?.toLowerCase().startsWith('video/')) return true
  return isVideoUpload({ uri, name: asset.fileName?.trim() || '', type })
}
