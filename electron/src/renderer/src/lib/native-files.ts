import type { NativeFileRef } from '@shared/types'

export async function nativeFileRefsFromFiles(files: FileList | File[]): Promise<NativeFileRef[]> {
  const selection = Array.from(files)
  const refs: NativeFileRef[] = []
  for (const file of selection) {
    const native = await window.agentsDock.files.stageNativeFile(file)
    if (native) refs.push({ ...native, type: native.type || file.type })
    else if (file.type.startsWith('image/')) refs.push(await window.agentsDock.files.stageClipboardImage(await file.arrayBuffer(), file.name, file.type))
  }
  return refs
}
