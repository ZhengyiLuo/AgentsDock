import { useEffect, useRef, useState, type RefObject } from 'react'
import { hoverTooltips, LSPPlugin, serverCompletion, serverDiagnostics, signatureHelp } from '@codemirror/lsp-client'
import { Compartment, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { WorkspaceProfileScope } from '@shared/types'
import { t } from './i18n'
import {
  codeLanguageId,
  createCodeIntelligenceClient,
  languageForCodePath,
  normalizedCodeLocations,
  workspaceFileUri,
  type CodeIntelligenceClient,
  type CodeLocation
} from './code-intelligence'

export interface EditorCodeIntelligenceContext {
  scope: WorkspaceProfileScope
  sessionId: string
  cwd: string
  active: boolean
  onNavigate(location: CodeLocation): void
}

export type CodeNavigationKind = 'definition' | 'references'

interface EditorIntelligenceState {
  phase: 'connecting' | 'ready' | 'unavailable'
  message?: string
  installHint?: string
}

export function useEditorCodeIntelligence(
  viewRef: RefObject<EditorView | null>,
  compartment: Compartment,
  path: string,
  context?: EditorCodeIntelligenceContext
) {
  const [state, setState] = useState<EditorIntelligenceState>({ phase: 'connecting' })
  const [locations, setLocations] = useState<CodeLocation[] | null>(null)
  const [finding, setFinding] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const navigateRef = useRef<((kind: CodeNavigationKind) => boolean) | null>(null)
  const cancelNavigationRef = useRef<(() => void) | null>(null)
  const openLocationRef = useRef<((location: CodeLocation) => void) | null>(null)
  const onNavigateRef = useRef(context?.onNavigate)
  onNavigateRef.current = context?.onNavigate
  const enabled = Boolean(context?.active && languageForCodePath(path))
  const ownership = JSON.stringify([path, context?.scope.profileId, context?.scope.profileGeneration,
    context?.scope.serverIdentity, context?.sessionId, context?.cwd, enabled])
  const ownershipRef = useRef(ownership)
  ownershipRef.current = ownership

  useEffect(() => {
    const view = viewRef.current
    const language = languageForCodePath(path)
    if (!enabled || !view || !context || !language) return
    const abort = new AbortController()
    let connection: CodeIntelligenceClient | undefined
    let sequence = 0
    let pendingParams: object | undefined
    let showingLocations = false
    const current = () => !abort.signal.aborted && viewRef.current === view && ownershipRef.current === ownership
    const clearExtension = () => {
      if (viewRef.current === view) view.dispatch({ effects: compartment.reconfigure([]) })
    }
    const unavailable = (message?: string, installHint?: string) => {
      if (!current()) return
      setState({ phase: 'unavailable', message, installHint })
      setFinding(false)
      setLocations(null)
      navigateRef.current = null
      openLocationRef.current = null
      clearExtension()
    }
    setState({ phase: 'connecting' })
    setLocations(null)
    setNavigationError(null)
    setFinding(false)
    const api = window.agentsDock?.intelligence
    if (!api) {
      unavailable(t('codeIntelligence.updateServer'))
      return () => abort.abort()
    }
    void (async () => {
      try {
        const status = await api.status(context.scope, context.sessionId)
        if (!current()) return
        const availability = status.languages.find(item => item.id === language)
        if (!availability?.available) {
          unavailable(availability?.message || t('codeIntelligence.unavailableLanguage'), availability?.install_hint)
          return
        }
        const uri = workspaceFileUri(status.root_uri, path)
        if (!uri) { unavailable(t('codeIntelligence.unavailable')); return }
        const result = await createCodeIntelligenceClient({
          api, scope: context.scope, sessionId: context.sessionId, language, rootUri: status.root_uri,
          signal: abort.signal,
          onClose: message => {
            unavailable(message || t('codeIntelligence.connectionClosed'))
            abort.abort()
          },
          extensions: [serverCompletion({ override: true }), hoverTooltips({ hoverTime: 500 }), signatureHelp(), serverDiagnostics()],
          notificationHandlers: {
            'textDocument/publishDiagnostics': (client, params) => {
              const file = client.workspace.getFile(params?.uri)
              const activeView = file?.getView()
              const plugin = activeView && LSPPlugin.get(activeView)
              // The official diagnostic extension checks synchronized versions.
              // Also discard results while a newer local draft awaits its 500ms sync.
              return Boolean(plugin && !plugin.unsyncedChanges.empty)
            },
            'window/showMessage': () => true,
            'window/logMessage': () => true
          }
        })
        if (!current()) { result.close(); return }
        connection = result
        const client = result.client
        const cancelNavigation = () => {
          sequence += 1
          if (pendingParams) client.cancelRequest(pendingParams)
          pendingParams = undefined
          showingLocations = false
          setFinding(false)
          setLocations(null)
          setNavigationError(null)
        }
        cancelNavigationRef.current = cancelNavigation
        openLocationRef.current = location => {
          if (!current()) return
          cancelNavigation()
          onNavigateRef.current?.(location)
        }
        const navigate = (kind: CodeNavigationKind): boolean => {
          if (!current()) return false
          const plugin = LSPPlugin.get(view)
          if (!plugin) return false
          if (pendingParams) client.cancelRequest(pendingParams)
          const request = ++sequence
          const doc = view.state.doc
          const head = view.state.selection.main.head
          const params = {
            textDocument: { uri }, position: plugin.toPosition(head),
            ...(kind === 'references' ? { context: { includeDeclaration: true } } : {})
          }
          pendingParams = params
          setFinding(true)
          setLocations(null)
          setNavigationError(null)
          client.sync()
          void client.request<object, unknown>(`textDocument/${kind}`, params).then(response => {
            if (!current() || request !== sequence || view.state.doc !== doc || view.state.selection.main.head !== head) return
            const found = normalizedCodeLocations(status.root_uri, response)
            if (kind === 'definition' && found.length === 1) onNavigateRef.current?.(found[0])
            else { showingLocations = true; setLocations(found) }
          }).catch(error => {
            if (current() && request === sequence && view.state.doc === doc) {
              showingLocations = true
              setNavigationError(error instanceof Error ? error.message : t('codeIntelligence.locationError'))
            }
          }).finally(() => {
            if (current() && request === sequence) { pendingParams = undefined; setFinding(false) }
          })
          return true
        }
        navigateRef.current = navigate
        view.dispatch({ effects: compartment.reconfigure([
          client.plugin(uri, codeLanguageId(path)),
          EditorView.updateListener.of(update => {
            if (update.docChanged && (pendingParams || showingLocations)) cancelNavigation()
          }),
          Prec.highest(keymap.of([
            { key: 'F12', run: () => navigate('definition'), preventDefault: true },
            { key: 'Shift-F12', run: () => navigate('references'), preventDefault: true },
            { key: 'Escape', run: () => {
              if (!pendingParams && !showingLocations) return false
              cancelNavigation()
              return true
            } }
          ]))
        ]) })
        setState({ phase: 'ready' })
      } catch (error) {
        unavailable(error instanceof Error ? error.message : t('codeIntelligence.unavailable'))
      }
    })()
    return () => {
      sequence += 1
      navigateRef.current = null
      cancelNavigationRef.current = null
      openLocationRef.current = null
      clearExtension()
      abort.abort()
      connection?.close()
    }
  }, [path, context?.scope.profileId, context?.scope.profileGeneration, context?.scope.serverIdentity, context?.sessionId, context?.cwd, enabled, retry, compartment, viewRef])

  return {
    enabled, ...state, locations, finding, navigationError,
    navigate: (kind: CodeNavigationKind) => navigateRef.current?.(kind),
    retry: () => setRetry(value => value + 1),
    closeLocations: () => { cancelNavigationRef.current?.(); setLocations(null); setNavigationError(null) },
    openLocation: (location: CodeLocation) => openLocationRef.current?.(location)
  }
}
