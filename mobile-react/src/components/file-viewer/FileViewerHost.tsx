import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { trackEvent } from '../../lib/analytics'
import { importWithDeadline } from '../../lib/deferred-import'
import { useAppStore } from '../../store/useAppStore'
import { usePalette } from '../../theme'
import { Text } from '../AppText'
import { DeferredLoadBoundary } from '../DeferredLoadBoundary'
import { SheetCloseButton } from '../ui'
import { FileViewerContext, type FileViewerRequest } from './FileViewerContext'

// Keep the editor payload and Expo Video native module out of the cold-start
// require graph. Metro includes these modules in the release bundle, but does
// not evaluate them until their matching viewer is actually presented.
const ArtifactFileViewerModal = lazy(() => importWithDeadline(
  () => import('./ArtifactFileViewerModal'),
  'Artifact file viewer',
).then(module => ({
  default: module.ArtifactFileViewerModal,
})))
const WorkspaceFileViewerModal = lazy(() => importWithDeadline(
  () => import('./WorkspaceFileViewerModal'),
  'Workspace file viewer',
).then(module => ({
  default: module.WorkspaceFileViewerModal,
})))

export function FileViewerProvider({ children }: { children: ReactNode }) {
  // Capture safe-area values in the persistent app root. Native full-screen
  // Modal roots can report a zero top inset on iPhone, which places their
  // controls underneath the status bar / Dynamic Island.
  const modalInsets = useSafeAreaInsets()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const [activeRequest, setActiveRequest] = useState<FileViewerRequest | null>(null)
  const [pendingRequest, setPendingRequest] = useState<FileViewerRequest | null>(null)
  const [presentationBlocked, setPresentationBlockedState] = useState(false)
  const blocked = useRef(false)
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId

  const present = useCallback((request: FileViewerRequest) => {
    if (request.sessionId !== selectedSessionIdRef.current) return
    trackEvent('file_view_opened')
    if (blocked.current) setPendingRequest(request)
    else setActiveRequest(request)
  }, [])
  const closeViewer = useCallback(() => {
    setActiveRequest(null)
    setPendingRequest(null)
  }, [])
  const setPresentationBlocked = useCallback((nextBlocked: boolean) => {
    blocked.current = nextBlocked
    setPresentationBlockedState(nextBlocked)
  }, [])
  const value = useMemo(() => ({
    viewerActive: Boolean(activeRequest || pendingRequest),
    openArtifacts: (request: Omit<Extract<FileViewerRequest, { kind: 'artifacts' }>, 'kind'>) => present({ kind: 'artifacts', ...request }),
    openWorkspace: (sessionId: string) => present({ kind: 'workspace', sessionId }),
    closeViewer,
    setPresentationBlocked,
  }), [activeRequest, closeViewer, pendingRequest, present, setPresentationBlocked])

  useEffect(() => {
    blocked.current = false
    setPresentationBlockedState(false)
    closeViewer()
  }, [closeViewer, profileGeneration])
  useEffect(() => {
    if (presentationBlocked || !pendingRequest) return
    setPendingRequest(null)
    if (pendingRequest.sessionId === selectedSessionIdRef.current) setActiveRequest(pendingRequest)
  }, [pendingRequest, presentationBlocked])
  useEffect(() => {
    setPendingRequest(current => current?.sessionId === selectedSessionId ? current : null)
    setActiveRequest(current => current?.sessionId === selectedSessionId ? current : null)
  }, [selectedSessionId])

  return <FileViewerContext.Provider value={value}>
    {children}
    <DeferredLoadBoundary
      resetKey={activeRequest ? `${activeRequest.kind}:${activeRequest.sessionId}` : 'closed'}
      fallback={<DeferredViewerUnavailable topInset={modalInsets.top} onClose={closeViewer} />}
    >
      <Suspense fallback={activeRequest ? <DeferredViewerLoading topInset={modalInsets.top} onClose={closeViewer} /> : null}>
        {activeRequest?.kind === 'artifacts' ? <ArtifactFileViewerModal request={activeRequest} modalInsets={modalInsets} onClose={closeViewer} /> : null}
        {activeRequest?.kind === 'workspace' ? <WorkspaceFileViewerModal request={activeRequest} modalInsets={modalInsets} onClose={closeViewer} /> : null}
      </Suspense>
    </DeferredLoadBoundary>
  </FileViewerContext.Provider>
}

function DeferredViewerLoading({ topInset, onClose }: { topInset: number; onClose: () => void }) {
  const colors = usePalette()
  return <View
    accessibilityViewIsModal
    onAccessibilityEscape={onClose}
    style={[styles.failedRoot, styles.deferredOverlay, { paddingTop: Math.max(14, topInset + 8), backgroundColor: colors.background }]}
  >
    <SheetCloseButton onPress={onClose} label="Close file viewer" testID="deferred-file-viewer-loading-close" />
    <View style={styles.failedBody}>
      <ActivityIndicator color={colors.blue} />
      <Text style={[styles.failedMessage, { color: colors.muted }]}>Loading file viewer…</Text>
    </View>
  </View>
}

function DeferredViewerUnavailable({ topInset, onClose }: { topInset: number; onClose: () => void }) {
  const colors = usePalette()
  return <View
    accessibilityViewIsModal
    onAccessibilityEscape={onClose}
    style={[styles.failedRoot, styles.deferredOverlay, { paddingTop: Math.max(14, topInset + 8), backgroundColor: colors.background }]}
  >
    <SheetCloseButton onPress={onClose} label="Close file viewer" testID="deferred-file-viewer-close" />
    <View style={styles.failedBody}>
      <Text style={[styles.failedTitle, { color: colors.text }]}>File viewer unavailable</Text>
      <Text style={[styles.failedMessage, { color: colors.muted }]}>Close this viewer and continue using the chat.</Text>
    </View>
  </View>
}

const styles = StyleSheet.create({
  failedRoot: { flex: 1, paddingHorizontal: 14 },
  // This boundary must not use a native Modal. Replacing a Suspense fallback
  // Modal with the loaded viewer's Modal in the same frame can make UIKit try
  // to present from a controller whose view was just removed, leaving native
  // playback alive underneath an unchanged chat. A root overlay keeps the presenter in
  // the window hierarchy until the one real viewer Modal is ready.
  deferredOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 10_000, elevation: 10_000 },
  failedBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  failedTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center' },
  failedMessage: { maxWidth: 320, fontSize: 13, lineHeight: 19, textAlign: 'center' },
})
