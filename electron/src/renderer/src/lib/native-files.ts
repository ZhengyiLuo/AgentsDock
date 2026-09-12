import type { NativeFileRef } from '@shared/types'

export async function nativeFileRefsFromFiles(files: FileList | File[]): Promise<NativeFileRef[]> {
  const selection = Array.from(files)
  if (window.agentsDock.sharedChat && (selection.length > 4 || selection.some(file => file.size > 8 * 1024 * 1024))) {
    throw new Error('Choose at most 4 files, up to 8 MiB each.')
  }
  const refs: NativeFileRef[] = []
  for (const file of selection) {
    const native = await window.agentsDock.files.stageNativeFile(file)
    if (native) refs.push({ ...native, type: native.type || file.type })
    else if (file.type.startsWith('image/')) refs.push(await window.agentsDock.files.stageClipboardImage(await file.arrayBuffer(), file.name, file.type))
  }
  return refs
}
