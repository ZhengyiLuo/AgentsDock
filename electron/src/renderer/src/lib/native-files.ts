import type { NativeFileRef } from '@shared/types'

export async function nativeFileRefsFromFiles(files: FileList | File[]): Promise<NativeFileRef[]> {
  const selection = Array.from(files)
  // Shared-chat methods use an unsupported-action proxy for missing entries;
  // only the desktop preload can advertise native selection batches.
  const nativeSelections = !window.agentsDock.sharedChat && window.agentsDock.files.stageNativeFiles
    ? await window.agentsDock.files.stageNativeFiles(selection)
    : await Promise.all(selection.map(file => window.agentsDock.files.stageNativeFile(file)))
  const refs: NativeFileRef[] = []
  for (const [index, file] of selection.entries()) {
    const native = nativeSelections[index]
    if (native) refs.push({ ...native, type: native.type || file.type })
    else if (file.type.startsWith('image/')) refs.push(await window.agentsDock.files.stageClipboardImage(await file.arrayBuffer(), file.name, file.type))
  }
  return refs
}
