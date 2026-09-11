import { useCallback, useEffect, useRef, useState } from 'react'
import { isFileTransferBusy, type FileTransferRequest, type FileTransferState } from '../../lib/file-transfer'
import { runNativeFileTransfer } from '../../lib/native-file-transfer'

export function useFileTransfer(scopeKey: string) {
  const [state, setState] = useState<FileTransferState | null>(null)
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const scope = useRef(scopeKey)
  scope.current = scopeKey
  useEffect(() => {
    mounted.current = true
    setState(null)
    return () => {
      mounted.current = false
      active.current?.abort()
      active.current = null
    }
  }, [scopeKey])
  const start = useCallback(async (request: FileTransferRequest) => {
    if (active.current || !request.isCurrent()) return
    const controller = new AbortController()
    active.current = controller
    const isCurrent = () => active.current === controller && mounted.current && scope.current === scopeKey && request.isCurrent()
    try {
      await runNativeFileTransfer({ ...request, isCurrent }, controller.signal, next => {
        if (isCurrent()) setState(next)
      })
    } catch (cause) {
      if (isCurrent()) setState({ phase: 'error', filename: request.filename, message: `Could not ${request.action === 'download' ? 'download' : 'share'} ${request.title}: ${cause instanceof Error ? cause.message : String(cause)}` })
    } finally {
      if (active.current === controller) {
        if (mounted.current && scope.current === scopeKey && !request.isCurrent()) setState(null)
        active.current = null
      }
    }
  }, [scopeKey])
  const cancel = useCallback(() => active.current?.abort(), [])
  const dismiss = useCallback(() => setState(null), [])
  return { state, busy: isFileTransferBusy(state), start, cancel, dismiss }
}
