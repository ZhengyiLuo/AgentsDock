import type { UploadRef } from '../types'

export interface PickedPhotoAsset {
  uri: string
  fileName?: string | null
  mimeType?: string | null
  fileSize?: number | null
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
}

/** Convert iOS/Android photo-picker assets into the existing guarded upload path. */
export function photoAssetsToUploads(assets: readonly PickedPhotoAsset[], timestamp = Date.now()): UploadRef[] {
  return assets.flatMap((asset, index) => {
    const uri = asset.uri?.trim()
    if (!uri) return []
    const type = asset.mimeType?.trim() || undefined
    const explicitName = asset.fileName?.trim()
    const extension = uriExtension(uri) ?? (type ? MIME_EXTENSIONS[type.toLowerCase()] : undefined) ?? 'jpg'
    return [{
      uri,
      name: explicitName || `photo-${timestamp}-${index + 1}.${extension}`,
      type,
      size: typeof asset.fileSize === 'number' && Number.isFinite(asset.fileSize) && asset.fileSize >= 0
        ? asset.fileSize
        : undefined,
    }]
  })
}

/** Detect local picker images before server metadata is available. */
export function isImageUpload(file: Pick<UploadRef, 'uri' | 'name' | 'type'>): boolean {
  if (file.type?.toLowerCase().startsWith('image/')) return true
  const candidate = (file.name || file.uri).split(/[?#]/, 1)[0]
  return /\.(avif|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(candidate)
}

function uriExtension(uri: string): string | undefined {
  const path = uri.split(/[?#]/, 1)[0]
  const match = path.match(/\.([a-z0-9]{2,5})$/i)
  return match?.[1]?.toLowerCase()
}
