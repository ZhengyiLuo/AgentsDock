import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState as NativeAppState, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { Image } from 'expo-image'
import type { VideoThumbnail } from 'expo-video'
import { Download, File, Images, Maximize2, Pin, Play } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { DeferredLoadBoundary } from './DeferredLoadBoundary'
import type { AgentFile } from '../types'
import { filesNewestFirst, formatBytes, isImage, isMedia, isVideo } from '../lib/format'
import { boundedMediaClaimsForOwner, nextBoundedVisibleCount } from '../lib/media-viewer-state'
import { shouldGenerateAutomaticVideoThumbnail } from '../lib/artifact-video-staging'
import { importWithDeadline } from '../lib/deferred-import'
import { SerialWorkQueue } from '../lib/serial-work-queue'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { IconButton } from './ui'
import { mobileFileViewerKind } from '../lib/file-viewer'
import { useFileViewer } from './file-viewer/FileViewerContext'
import { artifactTransferRequest } from '../lib/file-transfer'
import { useFileTransfer } from './file-viewer/useFileTransfer'
import { FileTransferNotice } from './file-viewer/FileTransferNotice'

// Importing expo-video registers and patches its native shared-object class at
// module scope. Defer that work until a visible video has won the bounded
// thumbnail queue rather than doing it during every app launch.
const VideoThumbnailLoader = lazy(() => importWithDeadline(
  () => import('./VideoThumbnailLoader'),
  'Video thumbnail loader',
  6_000,
).then(module => ({
  default: module.VideoThumbnailLoader,
})))

const TILE_GAP = 8
const TIMELINE_MEDIA_LIMIT = 4
const INSPECTOR_MEDIA_LIMIT = 8
const TIMELINE_FILE_LIMIT = 3
const INSPECTOR_FILE_LIMIT = 6
const AUTOMATIC_VIDEO_THUMBNAIL_LIMIT = 4
const videoThumbnailQueue = new SerialWorkQueue()
interface AutomaticVideoThumbnailScope {
  owners: Map<string, readonly string[]>
  listeners: Set<() => void>
}
const automaticVideoThumbnailScopes = new Map<string, AutomaticVideoThumbnailScope>()
interface MediaConnectionScope {
  readonly client: AgentServerClient
  readonly key: string
  readonly sessionId: string
  readonly profileId: string | null
  readonly generation: number
}

interface MediaGridProps {
  files: AgentFile[]
  sessionId: string
  compact?: boolean
  ownerKey?: string
  onViewerRequested?: () => void
}

export function MediaGrid({ files, sessionId, compact = false, ownerKey = 'standalone', onViewerRequested }: MediaGridProps) {
  const thumbnailOwnerInstanceId = useId()
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  const connectionScope = useMemo<MediaConnectionScope>(() => ({
    client: connection,
    key: connectionKey,
    sessionId,
    profileId: activeProfileId,
    generation: profileGeneration,
  }), [activeProfileId, connection, connectionKey, profileGeneration, sessionId])
  if (!files.length) return null
  if (!connectionReady) {
    return <View style={[styles.unavailable, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <Text style={[styles.unavailableText, { color: colors.muted }]}>{connecting || switchingProfileId ? 'Verifying media access…' : 'Media is available after this server reconnects.'}</Text>
    </View>
  }
  return <ScopedMediaGrid
    key={`${connectionKey}:${sessionId}:${ownerKey}:${compact ? 'compact' : 'timeline'}`}
    files={files}
    sessionId={sessionId}
    compact={compact}
    onViewerRequested={onViewerRequested}
    thumbnailOwnerKey={`${compact ? 'compact' : 'timeline'}:${ownerKey}:${thumbnailOwnerInstanceId}`}
    connectionScope={connectionScope}
  />
}

function ScopedMediaGrid({ files, sessionId, compact, onViewerRequested, thumbnailOwnerKey, connectionScope }: MediaGridProps & { thumbnailOwnerKey: string; connectionScope: MediaConnectionScope }) {
  const colors = usePalette()
  const { openArtifacts, viewerActive } = useFileViewer()
  const connectionKey = connectionScope.key
  const transfer = useFileTransfer(`${connectionKey}:${sessionId}`)
  const download = (file: AgentFile) => void transfer.start(artifactTransferRequest(file, sessionId, connectionScope.client, 'download', () => connectionIsCurrent(connectionScope)))
  const pinFile = useAppStore(state => state.pinFile)
  const removePin = useAppStore(state => state.removePin)
  const pins = useAppStore(state => state.pins)
  const pinnedIds = useMemo(() => new Set(pins.filter(value => value.kind === 'file').map(value => value.fileId)), [pins])
  const [containerWidth, setContainerWidth] = useState(0)
  const mediaLimit = compact ? INSPECTOR_MEDIA_LIMIT : TIMELINE_MEDIA_LIMIT
  const fileLimit = compact ? INSPECTOR_FILE_LIMIT : TIMELINE_FILE_LIMIT
  const [visibleMediaCount, setVisibleMediaCount] = useState(mediaLimit)
  const [visibleFileCount, setVisibleFileCount] = useState(fileLimit)
  const scopeKeyRef = useRef(connectionKey)
  scopeKeyRef.current = connectionKey
  useEffect(() => {
    setVisibleMediaCount(mediaLimit)
    setVisibleFileCount(fileLimit)
  }, [connectionKey, fileLimit, mediaLimit, sessionId])
  const orderedFiles = useMemo(() => filesNewestFirst(files), [files])
  const viewerFiles = useMemo(() => orderedFiles.filter(file => mobileFileViewerKind(file.filename, file.content_type) !== 'unsupported'), [orderedFiles])
  const openViewer = useCallback((fileId: string) => {
    if (!viewerFiles.some(file => file.id === fileId)) return
    onViewerRequested?.()
    openArtifacts({ sessionId, files: viewerFiles, initialId: fileId, ownerKey: thumbnailOwnerKey })
    requestAnimationFrame(dismissAppKeyboard)
  }, [onViewerRequested, openArtifacts, sessionId, thumbnailOwnerKey, viewerFiles])
  const media = useMemo(() => orderedFiles.filter(isMedia), [orderedFiles])
  const documents = useMemo(() => orderedFiles.filter(file => !isMedia(file)), [orderedFiles])
  const automaticVideoThumbnailIds = useAutomaticVideoThumbnailClaims(
    `${connectionKey}:${sessionId}`,
    thumbnailOwnerKey,
    shouldGenerateAutomaticVideoThumbnail(Platform.OS, viewerActive)
      ? media.filter(isVideo).map(file => file.id)
      : [],
  )
  const visibleMedia = media.slice(0, visibleMediaCount)
  const visibleDocuments = documents.slice(0, visibleFileCount)
  const compactFileIds = new Set([...visibleMedia, ...visibleDocuments].map(file => file.id))
  const compactFiles = compact ? orderedFiles.filter(file => compactFileIds.has(file.id)) : []
  const columns = mediaColumns(containerWidth, visibleMedia.length)
  const measuredWidth = containerWidth || 320
  const tileWidth = Math.max(118, Math.floor((measuredWidth - TILE_GAP * (columns - 1)) / columns))

  if (!files.length) return null
  const handleLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    setContainerWidth(current => Math.abs(current - width) < 2 ? current : width)
  }
  const togglePin = (file: AgentFile) => {
    if (scopeKeyRef.current !== connectionKey || !connectionIsCurrent(connectionScope)) return
    void (pinnedIds.has(file.id)
      ? removePin(`file:${file.id}`, connectionScope.generation)
      : pinFile(sessionId, file, connectionScope.generation))
  }

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      <FileTransferNotice state={transfer.state} onCancel={transfer.cancel} onDismiss={transfer.dismiss} />
      {compactFiles.length ? (
        <View style={styles.compactMediaList}>
          {compactFiles.map(file => {
            if (!isMedia(file)) {
              return <FileRow
                key={`${connectionKey}:${file.id}`}
                file={file}
                pinned={pinnedIds.has(file.id)}
                downloadBusy={transfer.busy}
                onDownload={() => download(file)}
                onPreview={mobileFileViewerKind(file.filename, file.content_type) !== 'unsupported' ? () => openViewer(file.id) : undefined}
                onPin={() => togglePin(file)}
              />
            }
            return <CompactMediaTile
                key={`${connectionKey}:${file.id}`}
                file={file}
                connection={connectionScope}
                generateVideoThumbnail={automaticVideoThumbnailIds.has(file.id)}
                pinned={pinnedIds.has(file.id)}
                onPreview={() => openViewer(file.id)}
                downloadBusy={transfer.busy}
                onDownload={() => download(file)}
                onPin={() => togglePin(file)}
              />
          })}
        </View>
      ) : null}

      {!compact && visibleMedia.length ? (
        <View style={styles.grid}>
          {visibleMedia.map(file => <MediaTile
              key={`${connectionKey}:${file.id}`}
              file={file}
              connection={connectionScope}
              generateVideoThumbnail={automaticVideoThumbnailIds.has(file.id)}
              width={tileWidth}
              pinned={pinnedIds.has(file.id)}
              onPreview={() => openViewer(file.id)}
              downloadBusy={transfer.busy}
              onDownload={() => download(file)}
              onPin={() => togglePin(file)}
            />)}
        </View>
      ) : null}

      {!compact && visibleDocuments.length ? (
        <View style={styles.fileList}>
          {visibleDocuments.map(file => <FileRow
            key={`${connectionKey}:${file.id}`}
            file={file}
            pinned={pinnedIds.has(file.id)}
            downloadBusy={transfer.busy}
            onDownload={() => download(file)}
            onPreview={mobileFileViewerKind(file.filename, file.content_type) !== 'unsupported' ? () => openViewer(file.id) : undefined}
            onPin={() => togglePin(file)}
          />)}
        </View>
      ) : null}

      <View style={styles.moreRow}>
        {media.length > mediaLimit ? (
          <Pressable accessibilityRole="button" accessibilityLabel={visibleMedia.length >= media.length ? 'Show fewer media' : 'Show more media'} onPress={() => setVisibleMediaCount(value => nextBoundedVisibleCount(value, media.length, mediaLimit))} style={[styles.moreButton, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <Images size={14} color={colors.blue} />
            <Text style={[styles.moreText, { color: colors.blue }]}>{visibleMedia.length >= media.length ? 'Show fewer media' : `Show ${Math.min(mediaLimit, media.length - visibleMedia.length)} more media · ${visibleMedia.length}/${media.length}`}</Text>
          </Pressable>
        ) : null}
        {documents.length > fileLimit ? (
          <Pressable accessibilityRole="button" accessibilityLabel={visibleDocuments.length >= documents.length ? 'Show fewer files' : 'Show more files'} onPress={() => setVisibleFileCount(value => nextBoundedVisibleCount(value, documents.length, fileLimit))} style={[styles.moreButton, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <File size={14} color={colors.muted} />
            <Text style={[styles.moreText, { color: colors.muted }]}>{visibleDocuments.length >= documents.length ? 'Show fewer files' : `Show ${Math.min(fileLimit, documents.length - visibleDocuments.length)} more files · ${visibleDocuments.length}/${documents.length}`}</Text>
          </Pressable>
        ) : null}
      </View>

    </View>
  )
}

function CompactMediaTile({ file, connection, generateVideoThumbnail, pinned, downloadBusy, onPreview, onDownload, onPin }: { file: AgentFile; connection: MediaConnectionScope; generateVideoThumbnail: boolean; pinned: boolean; downloadBusy: boolean; onPreview: () => void; onDownload: () => void; onPin: () => void }) {
  const colors = usePalette()
  return <View testID={`compact-media-tile-${file.id}`} style={[styles.compactTile, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.title || file.filename}`} onPress={onPreview} style={styles.compactPreviewButton}>
      <View style={styles.compactPreview}>
        {isImage(file) ? <RemoteImagePreview file={file} connection={connection} /> : <VideoThumbnailPreview file={file} connection={connection} enabled={generateVideoThumbnail} />}
        {isVideo(file) ? <View pointerEvents="none" style={styles.playBadge}><Play size={18} color="white" fill="white" /></View> : null}
      </View>
    </Pressable>
    <View style={styles.compactDetails}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.title || file.filename}`} onPress={onPreview} style={styles.compactIdentity}>
        <Text style={[styles.compactTitle, { color: colors.text }]} numberOfLines={2}>{file.title || file.filename}</Text>
        <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
      </Pressable>
      <View style={styles.compactActions}>
        <IconButton icon={Download} size={14} label="Download" disabled={downloadBusy} onPress={onDownload} />
        <IconButton icon={Pin} size={14} selected={pinned} label={pinned ? 'Unpin' : 'Pin'} onPress={onPin} />
        <IconButton icon={Maximize2} size={14} label="Preview" onPress={onPreview} />
      </View>
    </View>
  </View>
}

function MediaTile({ file, connection, generateVideoThumbnail, width, pinned, downloadBusy, onPreview, onDownload, onPin }: { file: AgentFile; connection: MediaConnectionScope; generateVideoThumbnail: boolean; width: number; pinned: boolean; downloadBusy: boolean; onPreview: () => void; onDownload: () => void; onPin: () => void }) {
  const colors = usePalette()
  return <View style={[styles.tile, { width, borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.title || file.filename}`} onPress={onPreview}>
      <View style={styles.preview}>
        {isImage(file) ? <RemoteImagePreview file={file} connection={connection} /> : <VideoThumbnailPreview file={file} connection={connection} enabled={generateVideoThumbnail} />}
        {isVideo(file) ? <View pointerEvents="none" style={styles.playBadge}><Play size={18} color="white" fill="white" /></View> : null}
      </View>
      <View style={styles.caption}>
        <Text style={[styles.fileTitle, { color: colors.text }]} numberOfLines={2}>{file.title || file.filename}</Text>
        <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
      </View>
    </Pressable>
    <View style={styles.tileActions}>
      <IconButton icon={Download} size={14} label="Download" disabled={downloadBusy} onPress={onDownload} />
      <IconButton icon={Pin} size={14} selected={pinned} label={pinned ? 'Unpin' : 'Pin'} onPress={onPin} />
      <IconButton icon={Maximize2} size={14} label="Preview" onPress={onPreview} />
    </View>
  </View>
}

function FileRow({ file, pinned, downloadBusy, onPreview, onDownload, onPin }: { file: AgentFile; pinned: boolean; downloadBusy: boolean; onPreview?: () => void; onDownload: () => void; onPin: () => void }) {
  const colors = usePalette()
  return <View style={[styles.fileRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={[styles.fileIcon, { backgroundColor: colors.raised }]}><File size={18} color={colors.muted} /></View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${onPreview ? 'Preview' : 'Download'} ${file.title || file.filename}`} disabled={!onPreview && downloadBusy} onPress={onPreview ?? onDownload} style={styles.fileIdentity}>
      <Text style={[styles.fileRowTitle, { color: colors.text }]} numberOfLines={1}>{file.title || file.filename}</Text>
      <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
    </Pressable>
    <IconButton icon={Download} size={14} label="Download" disabled={downloadBusy} onPress={onDownload} />
    <IconButton icon={Pin} size={14} selected={pinned} label={pinned ? 'Unpin' : 'Pin'} onPress={onPin} />
    {onPreview ? <IconButton icon={Maximize2} size={14} label="Preview" onPress={onPreview} /> : null}
  </View>
}

function RemoteImagePreview({ file, connection }: { file: AgentFile; connection: MediaConnectionScope }) {
  const colors = usePalette()
  const [failed, setFailed] = useState(false)
  if (failed) return <View style={[styles.center, { backgroundColor: colors.raised }]}><Images size={22} color={colors.muted} /></View>
  return <Image source={{ uri: connection.client.fileURL(connection.sessionId, file.id), headers: connection.client.authHeaders() }} contentFit="contain" style={StyleSheet.absoluteFill} transition={120} onError={() => setFailed(true)} />
}

function VideoThumbnailPreview({ file, connection, enabled }: { file: AgentFile; connection: MediaConnectionScope; enabled: boolean }) {
  const colors = usePalette()
  const [thumbnail, setThumbnail] = useState<VideoThumbnail | null>(null)
  const [failed, setFailed] = useState(false)
  const acceptThumbnail = useCallback((value: VideoThumbnail) => setThumbnail(value), [])
  const rejectThumbnail = useCallback(() => setFailed(true), [])

  if (thumbnail) return <Image source={thumbnail} contentFit="contain" style={StyleSheet.absoluteFill} transition={100} />
  if (Platform.OS === 'ios' || !enabled || failed) return <View style={[styles.center, { backgroundColor: '#090a0b' }]}><File size={22} color={colors.muted} /></View>
  return <QueuedVideoThumbnailLoader file={file} connection={connection} onThumbnail={acceptThumbnail} onFailure={rejectThumbnail} />
}

function QueuedVideoThumbnailLoader({ file, connection, onThumbnail, onFailure }: { file: AgentFile; connection: MediaConnectionScope; onThumbnail: (value: VideoThumbnail) => void; onFailure: () => void }) {
  const colors = usePalette()
  const [granted, setGranted] = useState(false)
  const [appActive, setAppActive] = useState(NativeAppState.currentState === 'active')
  const finishRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => setAppActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  useEffect(() => {
    if (!appActive) {
      setGranted(false)
      return
    }
    const cancel = videoThumbnailQueue.enqueue(finish => {
      finishRef.current = finish
      setGranted(true)
    })
    return () => {
      finishRef.current = null
      cancel()
    }
  }, [appActive, file.id])

  const finish = useCallback(() => {
    const complete = finishRef.current
    finishRef.current = null
    complete?.()
    setGranted(false)
  }, [])
  const acceptThumbnail = useCallback((value: VideoThumbnail) => {
    finish()
    onThumbnail(value)
  }, [finish, onThumbnail])
  const rejectThumbnail = useCallback(() => {
    finish()
    onFailure()
  }, [finish, onFailure])

  if (!appActive || !granted) return <View style={[styles.center, { backgroundColor: '#090a0b' }]}><File size={22} color={colors.muted} /></View>
  const placeholder = <View style={[styles.center, { backgroundColor: '#090a0b' }]}><File size={22} color={colors.muted} /></View>
  return <DeferredLoadBoundary resetKey={file.id} fallback={placeholder} onError={rejectThumbnail}>
    <Suspense fallback={placeholder}>
      <VideoThumbnailLoader file={file} connection={connection} onThumbnail={acceptThumbnail} onFailure={rejectThumbnail} />
    </Suspense>
  </DeferredLoadBoundary>
}

function mediaColumns(width: number, count: number): number {
  if (count <= 1) return 1
  if (width >= 760) return Math.min(4, count)
  if (width >= 500) return Math.min(3, count)
  if (width >= 270) return Math.min(2, count)
  return 1
}

function useAutomaticVideoThumbnailClaims(scopeKey: string, ownerKey: string, candidates: readonly string[]): Set<string> {
  const candidateSignature = candidates.join('\u0000')
  useEffect(() => {
    const scope = automaticVideoThumbnailScope(scopeKey)
    scope.owners.set(ownerKey, candidateSignature ? candidateSignature.split('\u0000') : [])
    notifyAutomaticVideoThumbnailScope(scope)
    return () => {
      const current = automaticVideoThumbnailScopes.get(scopeKey)
      if (!current) return
      current.owners.delete(ownerKey)
      notifyAutomaticVideoThumbnailScope(current)
      if (!current.owners.size && !current.listeners.size) automaticVideoThumbnailScopes.delete(scopeKey)
    }
  }, [candidateSignature, ownerKey, scopeKey])
  const subscribe = useCallback(
    (listener: () => void) => subscribeAutomaticVideoThumbnailScope(scopeKey, listener),
    [scopeKey],
  )
  const getSnapshot = useCallback(
    () => automaticVideoThumbnailClaimSnapshot(scopeKey, ownerKey),
    [ownerKey, scopeKey],
  )
  const claimSignature = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => '',
  )
  return useMemo(() => new Set(claimSignature ? claimSignature.split('\u0000') : []), [claimSignature])
}

function automaticVideoThumbnailScope(scopeKey: string): AutomaticVideoThumbnailScope {
  const existing = automaticVideoThumbnailScopes.get(scopeKey)
  if (existing) return existing
  const created: AutomaticVideoThumbnailScope = { owners: new Map(), listeners: new Set() }
  automaticVideoThumbnailScopes.set(scopeKey, created)
  return created
}

function subscribeAutomaticVideoThumbnailScope(scopeKey: string, listener: () => void): () => void {
  const scope = automaticVideoThumbnailScope(scopeKey)
  scope.listeners.add(listener)
  return () => {
    scope.listeners.delete(listener)
    if (!scope.owners.size && !scope.listeners.size) automaticVideoThumbnailScopes.delete(scopeKey)
  }
}

function automaticVideoThumbnailClaimSnapshot(scopeKey: string, ownerKey: string): string {
  const scope = automaticVideoThumbnailScopes.get(scopeKey)
  if (!scope) return ''
  return boundedMediaClaimsForOwner(
    [...scope.owners].map(([key, ownerCandidates]) => ({ ownerKey: key, candidates: ownerCandidates })),
    ownerKey,
    AUTOMATIC_VIDEO_THUMBNAIL_LIMIT,
  ).join('\u0000')
}

function notifyAutomaticVideoThumbnailScope(scope: AutomaticVideoThumbnailScope): void {
  for (const listener of scope.listeners) listener()
}

function connectionIsCurrent(connection: MediaConnectionScope): boolean {
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

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 8 },
  unavailable: { width: '100%', minHeight: 52, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  unavailableText: { fontSize: 11, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  compactMediaList: { width: '100%', gap: TILE_GAP },
  compactTile: { width: '100%', minHeight: 112, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 8, flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  compactPreviewButton: { width: '38%', minWidth: 96, maxWidth: 148, alignSelf: 'center' },
  compactPreview: { width: '100%', aspectRatio: 16 / 9, position: 'relative', overflow: 'hidden', borderRadius: 5, backgroundColor: '#090a0b' },
  compactDetails: { flex: 1, minWidth: 0, justifyContent: 'space-between' },
  compactIdentity: { flex: 1, minHeight: 50, paddingTop: 2 },
  compactTitle: { fontSize: 12, lineHeight: 16, fontWeight: '800' },
  compactActions: { minHeight: 44, flexDirection: 'row', alignItems: 'center' },
  tile: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  preview: { width: '100%', aspectRatio: 16 / 9, position: 'relative', backgroundColor: '#090a0b' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playBadge: { position: 'absolute', left: '50%', top: '50%', marginLeft: -19, marginTop: -19, width: 38, height: 38, borderRadius: 19, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  caption: { paddingHorizontal: 9, paddingTop: 7, minHeight: 48 },
  fileTitle: { fontSize: 12, fontWeight: '700' },
  fileMeta: { fontSize: 10, marginTop: 2 },
  tileActions: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2 },
  fileList: { gap: 6 },
  fileRow: { minHeight: 48, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  fileIcon: { width: 32, height: 32, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  fileIdentity: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: 7 },
  fileRowTitle: { fontSize: 11.5, fontWeight: '700' },
  moreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  moreButton: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  moreText: { fontSize: 11, fontWeight: '700' },
})
