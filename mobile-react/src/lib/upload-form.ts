import { File } from 'expo-file-system'

import type { UploadRef } from '../types'

interface ExpoMultipartFilePart {
  readonly name: string
  readonly type: string
  bytes(): Promise<Uint8Array>
}

/** Build the byte-backed multipart shape required by Expo's fetch implementation. */
export function createUploadFormData(file: UploadRef): FormData {
  const source = new File(file.uri)
  const label = file.name || source.name || 'this file'
  const part: ExpoMultipartFilePart = {
    name: file.name || source.name || 'upload',
    type: file.type || source.type || 'application/octet-stream',
    // iOS photo URIs backed by iCloud, a limited-library selection, or a File
    // provider can fail to materialize their bytes. Surface a readable, tappable
    // failure instead of an opaque reject; combined with the attachFiles cleanup
    // this keeps the chip from ever hanging on "Uploading…".
    bytes: async () => {
      try {
        return await source.bytes()
      } catch {
        throw new Error(`Couldn’t read “${label}”. If it’s a photo stored in iCloud, open it once in Photos to download it, then try again.`)
      }
    },
  }
  const form = new FormData()
  form.append('file', part as unknown as Blob)
  return form
}
