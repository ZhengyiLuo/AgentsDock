import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { createFileTransferRunner, numberedDownloadFilename } from './file-transfer'

const TEMPORARY_DIRECTORY = 'agentsdock-file-transfers'
const SHARED_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000
let transferSequence = 0

export const runNativeFileTransfer = createFileTransferRunner<Directory, File>({
  pickDirectory: async () => {
    if (typeof Directory.pickDirectoryAsync !== 'function') throw new Error('Choosing a download folder is unavailable in this app build. Please update the app.')
    return Directory.pickDirectoryAsync()
  },
  sharingAvailable: () => Sharing.isAvailableAsync(),
  createTemporaryFile: async filename => {
    const root = new Directory(Paths.cache, TEMPORARY_DIRECTORY)
    root.create({ idempotent: true, intermediates: true })
    for (const entry of root.list()) {
      if (!(entry instanceof Directory) || !/^\d+-\d+$/.test(entry.name)) continue
      if (Date.now() - Number(entry.name.split('-')[0]) > SHARED_FILE_LIFETIME_MS) {
        try { entry.delete() } catch { /* The OS may already have evicted it. */ }
      }
    }
    const directory = new Directory(root, `${Date.now()}-${++transferSequence}`)
    directory.create()
    return new File(directory, filename)
  },
  download: async (source, file, signal, onProgress) => File.downloadFileAsync(source.url, file, { headers: source.headers, signal, onProgress }),
  save: async (file, directory, filename) => {
    // Copy to the picked Directory itself. Constructing a child by appending
    // a filename is invalid for Android's opaque SAF content:// tree URIs.
    // Expo's iOS picker establishes security-scoped access for this operation.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const name = numberedDownloadFilename(filename, attempt)
      if (file.name !== name) file.rename(name)
      try {
        await file.copy(directory, { overwrite: false })
        return name
      } catch (cause) {
        // Native copy performs the existence check, covering both files and
        // folders and races with other writers without replacing their data.
        // Cocoa code 516 is stable even when the reason text is localized.
        const error = cause as { code?: string; message?: string }
        if (/DESTINATION_ALREADY_EXISTS|FILE_ALREADY_EXISTS|EEXIST/i.test(String(error?.code ?? ''))
          || /(?:already exists|file exists|EEXIST|NSCocoaErrorDomain[^\n]*(?:Code=|error )516)/i.test(error?.message ?? String(cause))) continue
        throw cause
      }
    }
    throw new Error('This folder already contains too many files with that name. Choose another folder.')
  },
  share: (file, request) => Sharing.shareAsync(file.uri, { mimeType: request.contentType, dialogTitle: `Share ${request.title}` }),
  removeTemporaryFile: async file => {
    try { file.parentDirectory.delete() } catch { /* Cache eviction is harmless. */ }
  },
})
