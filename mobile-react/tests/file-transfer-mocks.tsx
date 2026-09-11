import { createElement } from 'react'
export * from './component-mocks/react-native'
export const KeyboardAvoidingView = 'KeyboardAvoidingView'
export const ActionSheetIOS = { showActionSheetWithOptions() {} }
export let testWidth = 390
export function setTestWidth(width: number) { testWidth = width }
export const useWindowDimensions = () => ({ width: testWidth, height: 1024, scale: 2, fontScale: 1 })
export const Paths = { cache: 'file:///synthetic-cache' }
export const cacheDirectory = 'file:///synthetic-cache/'
const data = new Map<string, number>()
const directories = new Set<string>()
const pathFor = (parts: Array<string | { uri: string }>) => parts.map((part, index) => (typeof part === 'string' ? part : part.uri).replace(index ? /^\/+|\/+$/g : /\/+$/g, '')).join('/')
export const nativeTransfer = {
  pickerCalls: 0,
  downloads: [] as Array<{ url: string; file: File; options: { headers?: Record<string, string>; signal?: AbortSignal; onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void } }>,
  shares: [] as string[],
  copies: [] as Array<{ from: string; to: string; overwrite?: boolean; directoryTarget: boolean }>,
  deleted: [] as string[],
  picker: async () => new Directory('file:///user-selected-folder'),
  download: async (file: File) => { data.set(file.uri, 100); return file },
  copy: async (_source: File, _destination: File) => {},
  sharingAvailable: true,
  share: async () => {},
  reset() {
    this.pickerCalls = 0; this.downloads = []; this.shares = []; this.copies = []; this.deleted = []
    data.clear(); directories.clear()
    this.picker = async () => new Directory('file:///user-selected-folder')
    this.download = async file => { data.set(file.uri, 100); return file }
    this.copy = async () => {}
    this.sharingAvailable = true; this.share = async () => {}
  },
  put(uri: string, bytes: number) { data.set(uri, bytes) },
  files() { return new Map(data) },
}
export class Directory {
  uri: string
  constructor(...parts: Array<string | { uri: string }>) { this.uri = pathFor(parts) }
  static async pickDirectoryAsync() { nativeTransfer.pickerCalls += 1; return nativeTransfer.picker() }
  get name() { return this.uri.split('/').at(-1)! }
  create() { directories.add(this.uri) }
  list() { return [...directories].filter(uri => uri.slice(0, uri.lastIndexOf('/')) === this.uri).map(uri => new Directory(uri)) }
  delete() {
    nativeTransfer.deleted.push(this.uri)
    directories.delete(this.uri)
    for (const uri of data.keys()) if (uri.startsWith(`${this.uri}/`)) data.delete(uri)
  }
}
export class File {
  uri: string
  constructor(...parts: Array<string | { uri: string }>) { this.uri = pathFor(parts) }
  get name() { return this.uri.split('/').at(-1)! }
  get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))) }
  get exists() { return data.has(this.uri) }
  get size() { return data.get(this.uri) ?? null }
  rename(name: string) {
    const old = this.uri
    this.uri = pathFor([this.parentDirectory, name])
    const size = data.get(old)
    data.delete(old)
    if (size != null) data.set(this.uri, size)
  }
  static async downloadFileAsync(url: string, file: File, options: { headers?: Record<string, string>; signal?: AbortSignal; onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void }) {
    nativeTransfer.downloads.push({ url, file, options })
    return nativeTransfer.download(file)
  }
  async copy(target: File | Directory, options: { overwrite?: boolean } = {}) {
    const destination = target instanceof Directory ? new File(target, this.name) : target
    nativeTransfer.copies.push({ from: this.uri, to: destination.uri, overwrite: options.overwrite, directoryTarget: target instanceof Directory })
    await nativeTransfer.copy(this, destination)
    if (destination.exists && !options.overwrite) throw new Error('File already exists')
    data.set(destination.uri, this.size ?? 0)
  }
}
export async function isAvailableAsync() { return nativeTransfer.sharingAvailable }
export async function shareAsync(uri: string) { nativeTransfer.shares.push(uri); await nativeTransfer.share() }
export async function deleteAsync() {}
export async function getInfoAsync() { return { exists: false } }
export async function downloadAsync() { throw new Error('Legacy transfer must not run in these tests') }
export async function setStringAsync() {}
export function FlashList({ data: items = [], renderItem, ListEmptyComponent }: any) { return createElement('List', {}, items.length ? items.map((item: any, index: number) => createElement('Row', { key: index }, renderItem({ item, index }))) : ListEmptyComponent) }
// Preview engines and native pixels are outside this transfer test. Keep their
// public fallback Download callback so that production viewer routing runs.
export function FilePreview({ onDownload }: any) { return createElement('Pressable', { testID: 'preview-fallback-download', onPress: onDownload }) }
export function ArtifactVideoPlayer({ onDownload }: any) { return createElement('Pressable', { testID: 'video-fallback-download', onPress: onDownload }) }
export function VideoThumbnailLoader() { return null }
export function useTextPrompt() { return { promptText: async () => null, textPromptDialog: null } }
