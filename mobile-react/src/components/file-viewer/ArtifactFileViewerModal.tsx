import { FlashList } from '@shopify/flash-list'
import * as FileSystem from 'expo-file-system/legacy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileImage,
  FileText,
  Film,
  MoreHorizontal,
  Pin,
  Share2,
} from 'lucide-react-native'
import type { AgentServerClient } from '../../api/AgentServerClient'
import {
  adaptiveViewerActionLayout,
  adaptiveViewerDismissAllowed,
  reconcileAdaptiveViewerNavigation,
} from '../../lib/adaptive-file-viewer-state'
import { dismissAppKeyboard } from '../../lib/app-keyboard'
import { inferredMobileFileContentType, mobileFileViewerKind, mobileFileViewerLayout, workspaceRelativeSourcePath, type MobileFileViewerKind, type MobileFileViewerLayout } from '../../lib/file-viewer'
import { fullscreenModalPadding, type FullscreenSafeAreaInsets } from '../../lib/fullscreen-modal-layout'
import { filesNewestFirst, formatBytes } from '../../lib/format'
import { client, useAppStore } from '../../store/useAppStore'
import { usePalette } from '../../theme'
import type { AgentFile, WorkspaceInfo } from '../../types'
import { Text } from '../AppText'
import { EmptyState, IconButton, SheetCloseButton } from '../ui'
import { FilePreview, type LoadedFileText } from './FilePreview'
import type { ArtifactFileViewerRequest } from './FileViewerContext'
import { ArtifactVideoPlayer } from './ArtifactVideoPlayer'
import { artifactTransferRequest, type FileTransferAction } from '../../lib/file-transfer'
import { useFileTransfer } from './useFileTransfer'
import { FileTransferNotice } from './FileTransferNotice'

interface ArtifactConnectionScope {
  readonly client: AgentServerClient
  readonly key: string
  readonly cacheNamespace: string
  readonly sessionId: string
  readonly profileId: string | null
  readonly generation: number
}

export function ArtifactFileViewerModal({ request, modalInsets, onClose }: { request: ArtifactFileViewerRequest; modalInsets: FullscreenSafeAreaInsets; onClose: () => void }) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverURL = useAppStore(state => state.serverURL)
  const serverIdentity = useAppStore(state => state.profiles.find(value => value.id === activeProfileId)?.serverIdentity ?? null)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const scope = useMemo<ArtifactConnectionScope>(() => ({
    client: connection,
    key: connectionKey,
    cacheNamespace: serverIdentity || serverURL,
    sessionId: request.sessionId,
    profileId: activeProfileId,
    generation: profileGeneration,
  }), [activeProfileId, connection, connectionKey, profileGeneration, request.sessionId, serverIdentity, serverURL])
  const close = useCallback(() => {
    onClose()
    requestAnimationFrame(dismissAppKeyboard)
  }, [onClose])
  const sessionReady = Boolean(request.sessionId) && selectedSessionId === request.sessionId
  const connectionReady = sessionReady
    && connected
    && !connecting
    && !switchingProfileId
    && connection.isValidated
  const modalPadding = fullscreenModalPadding(modalInsets, Platform.OS)

  return <Modal
    visible
    animationType="slide"
    presentationStyle="fullScreen"
    statusBarTranslucent={Platform.OS === 'android'}
    onRequestClose={close}
  >
    {connectionReady
      ? <ScopedArtifactFileViewer
          key={`${connectionKey}:${request.sessionId}:${request.ownerKey}`}
          request={request}
          connection={scope}
          modalPadding={modalPadding}
          onClose={close}
        />
      : <UnavailableArtifactViewer
          reconnecting={connecting || Boolean(switchingProfileId)}
          sessionChanged={!sessionReady}
          modalPadding={modalPadding}
          onClose={close}
        />}
  </Modal>
}

function ScopedArtifactFileViewer({ request, connection, modalPadding, onClose }: {
  request: ArtifactFileViewerRequest
  connection: ArtifactConnectionScope
  modalPadding: ReturnType<typeof fullscreenModalPadding>
  onClose: () => void
}) {
  const colors = usePalette()
  const { width, height } = useWindowDimensions()
  const layout = mobileFileViewerLayout(width, height)
  const pins = useAppStore(state => state.pins)
  const pinFile = useAppStore(state => state.pinFile)
  const removePin = useAppStore(state => state.removePin)
  const [currentId, setCurrentId] = useState<string | null>(request.initialId)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const [error, setError] = useState('')
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null)
  const [workspaceInfoResolved, setWorkspaceInfoResolved] = useState(false)
  const activeVideoPauseRef = useRef<(() => void) | null>(null)
  const navigationInFlightRef = useRef(false)
  const closeViewer = useCallback(() => {
    // Pause while the shared native object is still mounted. Letting the modal
    // unmount first queues AVPlayer teardown on the iOS main thread and can
    // make the otherwise app-owned Close control appear frozen.
    try {
      activeVideoPauseRef.current?.()
    } catch {
      activeVideoPauseRef.current = null
    }
    onClose()
  }, [onClose])

  const orderedFiles = useMemo(() => scopedArtifactFiles(request.files, request.sessionId), [request.files, request.sessionId])
  const hasWorkspaceBackedPreview = useMemo(() => orderedFiles.some(value => {
    const valueKind = mobileFileViewerKind(value.filename, value.content_type)
    return Boolean(value.source_path) && (valueKind === 'image' || valueKind === 'pdf')
  }), [orderedFiles])
  const filesById = useMemo(() => new Map(orderedFiles.map(file => [file.id, file])), [orderedFiles])
  const adaptiveFiles = useMemo(() => orderedFiles.map(file => ({
    id: file.id,
    kind: mobileFileViewerKind(file.filename, file.content_type),
  })), [orderedFiles])
  const navigation = useMemo(
    () => reconcileAdaptiveViewerNavigation(adaptiveFiles, currentId, request.initialId),
    [adaptiveFiles, currentId, request.initialId],
  )
  const actionLayout = useMemo(
    () => adaptiveViewerActionLayout(layout, navigation.fileIds.length),
    [layout, navigation.fileIds.length],
  )
  const file = navigation.currentId ? filesById.get(navigation.currentId) ?? null : null
  const fileTransfer = useFileTransfer(`${connection.key}:${request.sessionId}:${file?.id ?? ''}`)
  const kind = file ? mobileFileViewerKind(file.filename, file.content_type) : null
  const workspacePath = file && workspaceInfo ? workspaceRelativeSourcePath(file.source_path, workspaceInfo.root) : null
  const pinned = Boolean(file && pins.some(value => value.kind === 'file' && value.fileId === file.id))

  useEffect(() => {
    if (!hasWorkspaceBackedPreview) {
      setWorkspaceInfoResolved(true)
      return
    }
    let current = true
    void connection.client.workspaceInfo(request.sessionId).then(value => {
      if (current && artifactConnectionIsCurrent(connection)) setWorkspaceInfo(value)
    }).catch(() => undefined).finally(() => {
      if (current && artifactConnectionIsCurrent(connection)) setWorkspaceInfoResolved(true)
    })
    return () => { current = false }
  }, [connection, hasWorkspaceBackedPreview, request.sessionId])

  useEffect(() => {
    if (currentId !== navigation.currentId) setCurrentId(navigation.currentId)
  }, [currentId, navigation.currentId])
  useEffect(() => {
    setOverflowOpen(false)
    setError('')
    navigationInFlightRef.current = false
  }, [file?.id])

  const navigate = useCallback((nextId: string | null) => {
    if (!nextId || nextId === file?.id || navigationInFlightRef.current) return
    navigationInFlightRef.current = true
    // Pause while the outgoing player is still mounted. Both the Android Expo
    // player and the iOS AVPlayer view own their player lifetime and must finish
    // this synchronous navigation handoff before the next preview is selected.
    try {
      activeVideoPauseRef.current?.()
    } catch {
      // Navigation must remain available if the OS already invalidated the
      // outgoing player during a lifecycle transition.
      activeVideoPauseRef.current = null
    }
    setCurrentId(nextId)
    setOverflowOpen(false)
  }, [file?.id])
  const registerActiveVideoPause = useCallback((pause: () => void) => {
    activeVideoPauseRef.current = pause
    return () => {
      if (activeVideoPauseRef.current === pause) activeVideoPauseRef.current = null
    }
  }, [])
  const transfer = useCallback((action: FileTransferAction) => {
    if (!file || !artifactConnectionIsCurrent(connection)) return
    setOverflowOpen(false)
    setError('')
    dismissAppKeyboard()
    void fileTransfer.start(artifactTransferRequest(file, request.sessionId, connection.client, action, () => artifactConnectionIsCurrent(connection)))
  }, [connection, file, fileTransfer.start, request.sessionId])
  const togglePin = useCallback(async () => {
    if (!file || pinBusy || !artifactConnectionIsCurrent(connection)) return
    setPinBusy(true)
    setOverflowOpen(false)
    setError('')
    try {
      const saved = pinned
        ? await removePin(`file:${file.id}`, connection.generation)
        : await pinFile(request.sessionId, file, connection.generation)
      if (!saved && artifactConnectionIsCurrent(connection)) setError(`Could not ${pinned ? 'remove' : 'save'} this pin.`)
    } catch (cause) {
      if (artifactConnectionIsCurrent(connection)) setError(artifactViewerError(cause))
    } finally {
      if (artifactConnectionIsCurrent(connection)) setPinBusy(false)
    }
  }, [connection, file, pinBusy, pinFile, pinned, removePin, request.sessionId])

  const loadText = useCallback(async (limit: number): Promise<LoadedFileText> => {
    if (!file || (kind !== 'text' && kind !== 'markdown')) throw new Error('No text file is selected.')
    return loadBoundedArtifactText(file, limit, connection)
  }, [connection, file, kind])
  const loadPDF = useCallback(async (): Promise<string> => {
    if (!file || kind !== 'pdf') throw new Error('No PDF is selected.')
    if (workspacePath && workspaceMediaPreviewAllowed(workspaceInfo, file, kind)) {
      try {
        return await downloadWorkspaceArtifactPreview(file, workspacePath, connection)
      } catch (cause) {
        if (!artifactConnectionIsCurrent(connection)) throw cause
      }
    }
    return downloadArtifactToCache(file, connection, 'pdf')
  }, [connection, file, kind, workspaceInfo, workspacePath])

  if (!file || !kind) {
    return <View onAccessibilityEscape={closeViewer} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}>
      <ViewerHeader
        layout={layout}
        title="Files"
        subtitle="No supported preview"
        previousId={null}
        nextId={null}
        pinned={false}
        busy={false}
        pinBusy={false}
        fileActionsAvailable={false}
        overflowOpen={false}
        onClose={closeViewer}
        onPrevious={() => undefined}
        onNext={() => undefined}
        onShare={() => undefined}
        onDownload={() => undefined}
        onPin={() => undefined}
        onOverflow={() => undefined}
      />
      <EmptyState title="No supported files" body="Images, videos, PDFs, Markdown, and text files can be previewed here." />
    </View>
  }

  const preview = file.source_path && (kind === 'image' || kind === 'pdf') && !workspaceInfoResolved ? <View style={styles.previewLoading}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Resolving workspace file…</Text></View> : <ArtifactPreview
    key={`${connection.key}:${file.id}`}
    file={file}
    kind={kind}
    layout={layout}
    connection={connection}
    workspacePath={workspacePath}
    workspaceInfo={workspaceInfo}
    loadText={loadText}
    loadPDF={loadPDF}
    registerVideoPause={registerActiveVideoPause}
    onDownload={() => void transfer('download')}
    onClose={closeViewer}
  />

  return <View onAccessibilityEscape={closeViewer} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}>
    <ViewerHeader
      layout={layout}
      title={artifactFileTitle(file)}
      subtitle={`${navigation.index + 1} of ${navigation.fileIds.length}${formatBytes(file.size) ? ` · ${formatBytes(file.size)}` : ''}`}
      previousId={navigation.previousId}
      nextId={navigation.nextId}
      pinned={pinned}
      busy={fileTransfer.busy}
      pinBusy={pinBusy}
      overflowOpen={overflowOpen}
      onClose={closeViewer}
      onPrevious={() => navigate(navigation.previousId)}
      onNext={() => navigate(navigation.nextId)}
      onShare={() => void transfer('share')}
      onDownload={() => void transfer('download')}
      onPin={() => void togglePin()}
      onOverflow={() => setOverflowOpen(value => !value)}
    />
    {layout === 'phone' && overflowOpen ? <PhoneOverflowActions
      actions={actionLayout.overflow}
      pinned={pinned}
      disabled={fileTransfer.busy || pinBusy}
      onDownload={() => void transfer('download')}
      onPin={() => void togglePin()}
    /> : null}
    <FileTransferNotice state={fileTransfer.state} onCancel={fileTransfer.cancel} onDismiss={fileTransfer.dismiss} />
    {error ? <View style={[styles.inlineError, { backgroundColor: `${colors.red}12`, borderColor: `${colors.red}38` }]}><Text style={[styles.inlineErrorText, { color: colors.red }]}>{error}</Text></View> : null}
    {layout === 'pad' && actionLayout.showFileRail
      ? <View style={styles.padBody}>
          <ArtifactSidebar
            files={navigation.fileIds.map(id => filesById.get(id)).filter((value): value is AgentFile => Boolean(value))}
            selectedId={file.id}
            onSelect={navigate}
          />
          <View style={styles.preview}>{preview}</View>
        </View>
      : <View style={styles.preview}>{preview}</View>}
    {layout === 'phone' ? <PhoneNavigation
      previousId={navigation.previousId}
      nextId={navigation.nextId}
      current={navigation.index + 1}
      total={navigation.fileIds.length}
      onPrevious={() => navigate(navigation.previousId)}
      onNext={() => navigate(navigation.nextId)}
    /> : null}
  </View>
}

function ViewerHeader({
  layout,
  title,
  subtitle,
  previousId,
  nextId,
  pinned,
  busy,
  pinBusy,
  fileActionsAvailable = true,
  overflowOpen,
  onClose,
  onPrevious,
  onNext,
  onShare,
  onDownload,
  onPin,
  onOverflow,
}: {
  layout: MobileFileViewerLayout
  title: string
  subtitle: string
  previousId: string | null
  nextId: string | null
  pinned: boolean
  busy: boolean
  pinBusy: boolean
  fileActionsAvailable?: boolean
  overflowOpen: boolean
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
  onShare: () => void
  onDownload: () => void
  onPin: () => void
  onOverflow: () => void
}) {
  const colors = usePalette()
  const actions = adaptiveViewerActionLayout(layout, previousId || nextId ? 2 : 1)
  return <View collapsable={false} pointerEvents="auto" style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
    <SheetCloseButton onPress={onClose} label="Close file viewer" testID="artifact-file-viewer-close" activateOnPressIn />
    {actions.header.includes('previous') ? <IconButton icon={ChevronLeft} disabled={!previousId} onPress={onPrevious} label="Previous file" /> : null}
    {actions.header.includes('next') ? <IconButton icon={ChevronRight} disabled={!nextId} onPress={onNext} label="Next file" /> : null}
    <View style={styles.headerIdentity}>
      <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <Text style={[styles.headerSubtitle, { color: colors.muted }]} numberOfLines={1}>{subtitle}</Text>
    </View>
    {busy ? <View style={styles.headerBusy}><ActivityIndicator size="small" color={colors.blue} /></View> : null}
    {fileActionsAvailable && actions.header.includes('share') ? <IconButton icon={Share2} disabled={busy} onPress={onShare} label="Share file" /> : null}
    {fileActionsAvailable && actions.header.includes('download') ? <IconButton icon={Download} disabled={busy} onPress={onDownload} label="Download file" /> : null}
    {fileActionsAvailable && actions.header.includes('pin') ? <IconButton icon={Pin} selected={pinned} disabled={pinBusy} onPress={onPin} label={pinned ? 'Unpin file' : 'Pin file'} /> : null}
    {fileActionsAvailable && actions.header.includes('overflow') ? <IconButton icon={MoreHorizontal} selected={overflowOpen} disabled={busy || pinBusy} onPress={onOverflow} label="More file actions" /> : null}
  </View>
}

function PhoneOverflowActions({ actions, pinned, disabled, onDownload, onPin }: {
  actions: ReturnType<typeof adaptiveViewerActionLayout>['overflow']
  pinned: boolean
  disabled: boolean
  onDownload: () => void
  onPin: () => void
}) {
  const colors = usePalette()
  return <View style={[styles.phoneOverflow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    {actions.includes('download') ? <Pressable accessibilityRole="button" accessibilityLabel="Download file" disabled={disabled} onPress={onDownload} style={({ pressed }) => [styles.phoneAction, { opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Download size={17} color={colors.blue} /><Text style={{ color: colors.text, fontWeight: '700' }}>Download</Text></Pressable> : null}
    {actions.includes('pin') ? <Pressable accessibilityRole="button" accessibilityLabel={pinned ? 'Unpin file' : 'Pin file'} disabled={disabled} onPress={onPin} style={({ pressed }) => [styles.phoneAction, { opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Pin size={17} color={pinned ? colors.blue : colors.muted} /><Text style={{ color: colors.text, fontWeight: '700' }}>{pinned ? 'Unpin' : 'Pin'}</Text></Pressable> : null}
  </View>
}

function PhoneNavigation({ previousId, nextId, current, total, onPrevious, onNext }: {
  previousId: string | null
  nextId: string | null
  current: number
  total: number
  onPrevious: () => void
  onNext: () => void
}) {
  const colors = usePalette()
  return <View style={[styles.phoneNavigation, { borderColor: colors.border, backgroundColor: colors.background }]}>
    <IconButton icon={ChevronLeft} touchSize={48} disabled={!previousId} onPress={onPrevious} label="Previous file" />
    <Text style={[styles.phoneNavigationCount, { color: colors.muted }]}>{current} / {total}</Text>
    <IconButton icon={ChevronRight} touchSize={48} disabled={!nextId} onPress={onNext} label="Next file" />
  </View>
}

function ArtifactSidebar({ files, selectedId, onSelect }: { files: AgentFile[]; selectedId: string; onSelect: (id: string) => void }) {
  const colors = usePalette()
  return <View style={[styles.sidebar, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={styles.sidebarHeading}><Text style={[styles.sidebarTitle, { color: colors.muted }]}>FILES</Text><Text style={[styles.sidebarCount, { color: colors.muted }]}>{files.length}</Text></View>
    <FlashList
      data={files}
      keyExtractor={file => file.id}
      contentContainerStyle={styles.sidebarList}
      showsVerticalScrollIndicator={false}
      renderItem={({ item: file }) => {
        const kind = mobileFileViewerKind(file.filename, file.content_type)
        const ItemIcon = artifactKindIcon(kind)
        const selected = file.id === selectedId
        return <Pressable
          key={file.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${artifactFileTitle(file)}`}
          accessibilityState={{ selected }}
          onPress={() => onSelect(file.id)}
          style={({ pressed }) => [styles.sidebarItem, { backgroundColor: selected ? colors.raised : 'transparent', opacity: pressed ? 0.65 : 1 }]}
        >
          <ItemIcon size={18} color={selected ? colors.blue : colors.muted} />
          <View style={styles.sidebarIdentity}><Text style={[styles.sidebarName, { color: colors.text }]} numberOfLines={2}>{artifactFileTitle(file)}</Text><Text style={[styles.sidebarMeta, { color: colors.muted }]} numberOfLines={1}>{artifactKindLabel(kind)}{formatBytes(file.size) ? ` · ${formatBytes(file.size)}` : ''}</Text></View>
        </Pressable>
      }}
    />
  </View>
}

function ArtifactPreview({ file, kind, layout, connection, workspacePath, workspaceInfo, loadText, loadPDF, registerVideoPause, onDownload, onClose }: {
  file: AgentFile
  kind: MobileFileViewerKind
  layout: MobileFileViewerLayout
  connection: ArtifactConnectionScope
  workspacePath: string | null
  workspaceInfo: WorkspaceInfo | null
  loadText: (limit: number) => Promise<LoadedFileText>
  loadPDF: () => Promise<string>
  registerVideoPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}) {
  const automaticPreviewAllowed = artifactAutomaticPreviewAllowed(file, kind, layout)
  const artifactURL = connection.client.fileURL(connection.sessionId, file.id)
  const liveImageURL = useMemo(() => automaticPreviewAllowed && workspacePath && kind === 'image' && workspaceMediaPreviewAllowed(workspaceInfo, file, kind)
    ? `${connection.client.workspacePreviewURL(connection.sessionId, workspacePath)}&opened=${Date.now()}`
    : null, [automaticPreviewAllowed, connection, file, kind, workspaceInfo, workspacePath])
  if (kind === 'video') {
    return <ArtifactVideoPlayer
      file={file}
      layout={layout}
      connection={connection}
      registerPause={registerVideoPause}
      onDownload={onDownload}
      onClose={onClose}
    />
  }
  const preview = <FilePreview
    name={file.filename}
    contentType={file.content_type}
    size={kind === 'text' || kind === 'markdown' ? undefined : file.size}
    layout={layout}
    previewURL={kind === 'image' && automaticPreviewAllowed ? liveImageURL ?? artifactURL : undefined}
    fallbackPreviewURL={kind === 'image' && automaticPreviewAllowed && liveImageURL ? artifactURL : undefined}
    headers={connection.client.authHeaders()}
    loadText={kind === 'text' || kind === 'markdown' ? loadText : undefined}
    loadLocalPreview={kind === 'pdf' && automaticPreviewAllowed ? loadPDF : undefined}
    imageViewer={kind === 'image' ? {
      onDismiss: adaptiveViewerDismissAllowed(layout, { source: 'content', kind: 'image', zoomScale: 1 }) ? onClose : undefined,
      testID: 'artifact-image-dismiss-surface',
      gestureTestID: 'artifact-image-dismiss-gesture',
    } : undefined}
    onDownload={onDownload}
  />
  return preview
}

function UnavailableArtifactViewer({ reconnecting, sessionChanged, modalPadding, onClose }: { reconnecting: boolean; sessionChanged: boolean; modalPadding: ReturnType<typeof fullscreenModalPadding>; onClose: () => void }) {
  const colors = usePalette()
  return <View onAccessibilityEscape={onClose} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}>
    <View collapsable={false} pointerEvents="auto" style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <SheetCloseButton onPress={onClose} label="Close file viewer" testID="artifact-file-viewer-close" />
      <Text style={[styles.headerTitle, { color: colors.text }]}>File viewer</Text>
    </View>
    <EmptyState
      title={sessionChanged ? 'Chat changed' : reconnecting ? 'Verifying file access…' : 'Server unavailable'}
      body={sessionChanged ? 'Close this viewer and open the file from the active chat.' : 'Reconnect this server to preview chat files.'}
    />
  </View>
}

function scopedArtifactFiles(files: readonly AgentFile[], sessionId: string): AgentFile[] {
  const seen = new Set<string>()
  return filesNewestFirst(files).filter(file => {
    const id = file.id.trim()
    if (!id || id !== file.id || seen.has(id)) return false
    if (file.session_id && file.session_id !== sessionId) return false
    seen.add(id)
    return true
  })
}

async function loadBoundedArtifactText(file: AgentFile, requestedLimit: number, connection: ArtifactConnectionScope): Promise<LoadedFileText> {
  assertArtifactFileScope(file, connection)
  if (file.size === 0) return { content: '', truncated: false }
  const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 8 * 1024 * 1024))
  const controller = new AbortController()
  const response = await fetch(connection.client.fileURL(connection.sessionId, file.id), {
    headers: { ...connection.client.authHeaders(), Range: `bytes=0-${limit - 1}` },
    signal: controller.signal,
  })
  if (!artifactConnectionIsCurrent(connection)) {
    controller.abort()
    throw new Error('The active server or chat changed while opening this file.')
  }
  if (response.status !== 200 && response.status !== 206) {
    controller.abort()
    throw new Error(`File preview request failed with HTTP ${response.status}.`)
  }
  const declaredLength = strictHeaderInteger(response.headers.get('content-length'))
  const contentRange = parseContentRange(response.headers.get('content-range'))
  if (response.status === 206) {
    if (!contentRange || contentRange.start !== 0 || contentRange.end >= limit) {
      controller.abort()
      throw new Error('The server returned an invalid bounded file range.')
    }
  } else if ((declaredLength == null || declaredLength > limit) && (file.size == null || file.size > limit)) {
    controller.abort()
    throw new Error('The server did not honor the bounded text preview request.')
  }
  if (declaredLength != null && declaredLength > limit) {
    controller.abort()
    throw new Error('The text preview response exceeded its memory limit.')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > limit) throw new Error('The text preview response exceeded its memory limit.')
  if (!artifactConnectionIsCurrent(connection)) throw new Error('The active server or chat changed while opening this file.')
  return {
    content: new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''),
    truncated: response.status === 206
      ? contentRange?.total == null || contentRange.end + 1 < contentRange.total
      : typeof file.size === 'number' && file.size > bytes.byteLength,
  }
}

function workspaceMediaPreviewAllowed(info: WorkspaceInfo | null, file: AgentFile, kind: MobileFileViewerKind): boolean {
  if (!info || (kind !== 'image' && kind !== 'pdf')) return false
  if (typeof file.size === 'number' && typeof info.max_preview_file_bytes === 'number' && file.size > info.max_preview_file_bytes) return false
  const recordedType = file.content_type?.split(';', 1)[0].trim().toLocaleLowerCase()
  const contentType = recordedType && recordedType !== 'application/octet-stream' && recordedType !== 'binary/octet-stream'
    ? recordedType
    : inferredMobileFileContentType(file.filename).toLocaleLowerCase()
  const advertised = info.preview_media_types
  if (!advertised?.length) return contentType.startsWith('image/') || contentType === 'application/pdf'
  return advertised.some(value => {
    const pattern = value.trim().toLocaleLowerCase()
    return pattern.endsWith('/*') ? contentType.startsWith(pattern.slice(0, -1)) : pattern === contentType
  })
}

function artifactAutomaticPreviewAllowed(file: AgentFile, kind: MobileFileViewerKind, layout: MobileFileViewerLayout): boolean {
  if (kind !== 'image' && kind !== 'pdf') return true
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) return false
  const limit = kind === 'image' && layout === 'phone' ? 40 * 1024 * 1024 : 100 * 1024 * 1024
  return file.size <= limit
}

async function downloadWorkspaceArtifactPreview(file: AgentFile, path: string, connection: ArtifactConnectionScope): Promise<string> {
  assertArtifactFileScope(file, connection)
  if (!FileSystem.cacheDirectory) throw new Error('The device cache is unavailable.')
  const scopeHash = artifactCacheScopeHash(connection.cacheNamespace, connection.sessionId, `workspace:${path}:${file.id}`)
  const destination = `${FileSystem.cacheDirectory}workspace-artifact-${scopeHash}.pdf`
  await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined)
  const result = await FileSystem.downloadAsync(
    connection.client.workspacePreviewURL(connection.sessionId, path),
    destination,
    { headers: connection.client.authHeaders() },
  )
  if (result.status !== 200) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
    throw new Error(`Workspace preview failed with HTTP ${result.status}.`)
  }
  if (!artifactConnectionIsCurrent(connection)) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
    throw new Error('The active server or chat changed while opening this file.')
  }
  return result.uri
}

async function downloadArtifactToCache(file: AgentFile, connection: ArtifactConnectionScope, forcedExtension = ''): Promise<string> {
  assertArtifactFileScope(file, connection)
  if (!FileSystem.cacheDirectory) throw new Error('The device cache is unavailable.')
  const extension = forcedExtension.replace(/^\.+/, '').toLocaleLowerCase()
  const shortName = shortCacheFilename(file.filename, extension)
  const scopeHash = artifactCacheScopeHash(connection.cacheNamespace, connection.sessionId, file.id)
  const destination = `${FileSystem.cacheDirectory}artifact-${scopeHash}-${shortName}`
  const existing = await FileSystem.getInfoAsync(destination)
  if (existing.exists && !existing.isDirectory && (file.size == null || existing.size === file.size)) {
    if (!artifactConnectionIsCurrent(connection)) throw new Error('The active server or chat changed while opening this file.')
    return existing.uri
  }
  if (existing.exists) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined)
  const result = await FileSystem.downloadAsync(
    connection.client.fileURL(connection.sessionId, file.id),
    destination,
    { headers: connection.client.authHeaders() },
  )
  if (result.status !== 200) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
    throw new Error(`File download failed with HTTP ${result.status}.`)
  }
  if (!artifactConnectionIsCurrent(connection)) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
    throw new Error('The active server or chat changed while downloading this file.')
  }
  const downloaded = await FileSystem.getInfoAsync(result.uri)
  if (!downloaded.exists || downloaded.isDirectory) throw new Error('The downloaded file is unavailable.')
  if (file.size != null && downloaded.size !== file.size) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
    throw new Error('The downloaded file did not match the server metadata.')
  }
  return result.uri
}

function artifactConnectionIsCurrent(connection: ArtifactConnectionScope): boolean {
  const state = useAppStore.getState()
  return !connection.client.isDisposed
    && connection.client.isValidated
    && client === connection.client
    && state.activeProfileId === connection.profileId
    && state.profileGeneration === connection.generation
    && state.selectedSessionId === connection.sessionId
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}

function assertArtifactFileScope(file: AgentFile, connection: ArtifactConnectionScope): void {
  if (!artifactConnectionIsCurrent(connection)) throw new Error('The active server or chat changed while opening this file.')
  if (!file.id.trim() || file.id !== file.id.trim()) throw new Error('The file identity is invalid.')
  if (file.session_id && file.session_id !== connection.sessionId) throw new Error('This file belongs to another chat.')
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '')
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null
  if (total != null && (!Number.isSafeInteger(total) || total <= end)) return null
  return { start, end, total }
}

function strictHeaderInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function artifactFileTitle(file: AgentFile): string { return file.title?.trim() || file.filename }
function shortCacheFilename(value: string, forcedExtension: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-72) || 'file'
  return forcedExtension && !safe.toLocaleLowerCase().endsWith(`.${forcedExtension}`)
    ? `${safe}.${forcedExtension}`
    : safe
}
function artifactCacheScopeHash(cacheNamespace: string, sessionId: string, fileId: string): string {
  const scope = `${cacheNamespace}\u0000${sessionId}\u0000${fileId}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < scope.length; index += 1) {
    const code = scope.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
function artifactViewerError(cause: unknown): string { return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/i, '').trim() || 'The file operation failed.' }
function artifactKindLabel(kind: MobileFileViewerKind): string {
  if (kind === 'image') return 'Image'
  if (kind === 'video') return 'Video'
  if (kind === 'pdf') return 'PDF'
  if (kind === 'markdown') return 'Markdown'
  if (kind === 'text') return 'Text'
  return 'File'
}
function artifactKindIcon(kind: MobileFileViewerKind) {
  if (kind === 'image') return FileImage
  if (kind === 'video') return Film
  if (kind === 'pdf' || kind === 'markdown' || kind === 'text') return FileText
  return File
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 64, flexShrink: 0, position: 'relative', zIndex: 20, elevation: 20, flexDirection: 'row', alignItems: 'center', gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 8 },
  headerIdentity: { flex: 1, minWidth: 0, paddingHorizontal: 3 },
  headerTitle: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  headerSubtitle: { fontSize: 10, lineHeight: 14, marginTop: 1 },
  headerBusy: { width: 24, alignItems: 'center', justifyContent: 'center' },
  inlineError: { minHeight: 36, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' },
  inlineErrorText: { fontSize: 11, lineHeight: 16 },
  preview: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' },
  previewLoading: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 9 },
  padBody: { flex: 1, minHeight: 0, flexDirection: 'row' },
  sidebar: { width: 286, minWidth: 230, maxWidth: 340, borderRightWidth: StyleSheet.hairlineWidth },
  sidebarHeading: { minHeight: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sidebarTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  sidebarCount: { fontSize: 10, fontVariant: ['tabular-nums'] },
  sidebarList: { paddingHorizontal: 7, paddingBottom: 16 },
  sidebarItem: { minHeight: 58, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 9 },
  sidebarIdentity: { flex: 1, minWidth: 0 },
  sidebarName: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  sidebarMeta: { fontSize: 10, lineHeight: 14, marginTop: 2 },
  phoneOverflow: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  phoneAction: { minWidth: 116, minHeight: 44, borderRadius: 7, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  phoneNavigation: { minHeight: 58, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  phoneNavigationCount: { minWidth: 72, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'center' },
})
