import * as FileSystem from 'expo-file-system/legacy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState as NativeAppState,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native'
import { Download, RefreshCw, X } from 'lucide-react-native'
import type { AgentServerClient } from '../../api/AgentServerClient'
import {
  artifactVideoStageCacheKey,
  artifactVideoStageProgress,
  completedArtifactVideoDownload,
  IOS_VIDEO_STAGE_PLAYER_DELAY_MS,
  IOS_VIDEO_STAGE_STALL_MS,
  reusableArtifactVideoCache,
} from '../../lib/artifact-video-staging'
import type { MobileFileViewerLayout } from '../../lib/file-viewer'
import type { AgentFile } from '../../types'
import { Text } from '../AppText'
import { ArtifactIOSSystemVideoPlayer } from './ArtifactIOSSystemVideoPlayer'
import { ArtifactPlatformVideoPlayer, type ArtifactPlatformVideoSource } from './ArtifactPlatformVideoPlayer'

interface ArtifactVideoConnection {
  readonly client: AgentServerClient
  readonly cacheNamespace: string
  readonly key: string
  readonly sessionId: string
}

type VideoStageTask = ReturnType<typeof FileSystem.createDownloadResumable>

const VIDEO_STAGE_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024

export function ArtifactVideoPlayer({ file, layout, connection, registerPause, onDownload, onClose }: {
  file: AgentFile
  layout: MobileFileViewerLayout
  connection: ArtifactVideoConnection
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}) {
  const remoteSource = useMemo<ArtifactPlatformVideoSource>(() => ({
    uri: connection.client.fileURL(connection.sessionId, file.id),
    headers: connection.client.authHeaders(),
    contentType: 'progressive',
  }), [connection, file.id])

  if (Platform.OS !== 'ios') {
    return <ArtifactPlatformVideoPlayer
      source={remoteSource}
      layout={layout}
      registerPause={registerPause}
      onDownload={onDownload}
      onClose={onClose}
    />
  }

  return <StagedIOSArtifactVideo
    file={file}
    connection={connection}
    remoteSource={remoteSource}
    registerPause={registerPause}
    onDownload={onDownload}
    onClose={onClose}
  />
}

function StagedIOSArtifactVideo({ file, connection, remoteSource, registerPause, onDownload, onClose }: {
  file: AgentFile
  connection: ArtifactVideoConnection
  remoteSource: ArtifactPlatformVideoSource
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}) {
  const [appActive, setAppActive] = useState(NativeAppState.currentState === 'active')
  const [stageAttempt, setStageAttempt] = useState(0)
  const [localURI, setLocalURI] = useState<string | null>(null)
  const [mountPlayer, setMountPlayer] = useState(false)
  const [stageProblem, setStageProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const taskRef = useRef<VideoStageTask | null>(null)
  const generationRef = useRef(0)
  const expectedBytes = Number.isSafeInteger(file.size) && (file.size ?? 0) > 0 ? Number(file.size) : null
  const cacheDestination = useMemo(() => {
    if (!FileSystem.cacheDirectory) return null
    const identity = `${connection.cacheNamespace}\u0000${connection.sessionId}\u0000${file.id}`
    return `${FileSystem.cacheDirectory}artifact-video-${artifactVideoStageCacheKey(identity)}-${safeVideoCacheName(file.filename, file.content_type)}`
  }, [connection.cacheNamespace, connection.sessionId, file.content_type, file.filename, file.id])
  const cancelStaging = useCallback(() => {
    const task = taskRef.current
    taskRef.current = null
    if (task) void task.cancelAsync().catch(() => undefined)
  }, [])
  const close = useCallback(() => {
    generationRef.current += 1
    cancelStaging()
    onClose()
  }, [cancelStaging, onClose])
  const restage = useCallback(() => {
    generationRef.current += 1
    cancelStaging()
    setMountPlayer(false)
    setLocalURI(null)
    setStageProblem(null)
    setProgress(null)
    setStageAttempt(value => value + 1)
  }, [cancelStaging])

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => {
      const active = state === 'active'
      setAppActive(active)
      if (!active) cancelStaging()
    })
    return () => subscription.remove()
  }, [cancelStaging])

  useEffect(() => {
    if (!appActive) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    let active = true
    let stalled = false
    let stallTimer: ReturnType<typeof setInterval> | null = null
    let lastProgressAt = Date.now()
    let lastPublishedAt = 0
    let lastPublishedProgress = -1

    setLocalURI(null)
    setMountPlayer(false)
    setStageProblem(null)
    setProgress(null)

    const stillCurrent = () => active
      && generationRef.current === generation
      && !connection.client.isDisposed
      && connection.client.isValidated

    void (async () => {
      if (!cacheDestination) throw new Error('The device cache is unavailable.')
      const existing = await FileSystem.getInfoAsync(cacheDestination)
      if (!stillCurrent()) return
      if (stageAttempt === 0 && reusableArtifactVideoCache(existing, expectedBytes)) {
        setProgress(1)
        setLocalURI(existing.uri)
        return
      }
      if (existing.exists) await FileSystem.deleteAsync(cacheDestination, { idempotent: true }).catch(() => undefined)
      if (!stillCurrent()) return

      if (expectedBytes != null) {
        const freeBytes = await FileSystem.getFreeDiskStorageAsync().catch(() => null)
        if (!stillCurrent()) return
        if (freeBytes != null && expectedBytes + VIDEO_STAGE_STORAGE_RESERVE_BYTES > freeBytes) {
          throw new Error('There is not enough free storage to prepare this video safely.')
        }
      }

      const task = FileSystem.createDownloadResumable(
        remoteSource.uri,
        cacheDestination,
        { headers: remoteSource.headers },
        value => {
          if (!stillCurrent()) return
          lastProgressAt = Date.now()
          const next = artifactVideoStageProgress(
            value.totalBytesWritten,
            value.totalBytesExpectedToWrite,
            expectedBytes,
          )
          if (next == null) return
          const now = Date.now()
          if (next >= 1 || now - lastPublishedAt >= 150 || next - lastPublishedProgress >= 0.02) {
            lastPublishedAt = now
            lastPublishedProgress = next
            setProgress(next)
          }
        },
      )
      taskRef.current = task
      stallTimer = setInterval(() => {
        if (!stillCurrent() || Date.now() - lastProgressAt < IOS_VIDEO_STAGE_STALL_MS) return
        stalled = true
        if (taskRef.current === task) taskRef.current = null
        void task.cancelAsync().catch(() => undefined)
        setStageProblem('The video download stopped responding. Retry, download it, or close the viewer.')
      }, 1_000)
      const result = await task.downloadAsync()
      if (taskRef.current === task) taskRef.current = null
      if (stallTimer) clearInterval(stallTimer)
      stallTimer = null
      if (!stillCurrent() || stalled) return
      if (!result) throw new Error('The video download was cancelled.')
      if (result.status < 200 || result.status >= 300) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
        throw new Error(`Video download failed with HTTP ${result.status}.`)
      }
      const downloaded = await FileSystem.getInfoAsync(result.uri)
      if (!stillCurrent()) return
      if (!completedArtifactVideoDownload(downloaded, expectedBytes)) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
        throw new Error('The downloaded video did not match the server metadata.')
      }
      setProgress(1)
      setLocalURI(downloaded.uri)
    })().catch(cause => {
      if (!stillCurrent() || stalled) return
      const detail = cause instanceof Error ? cause.message.trim() : ''
      setStageProblem(detail || 'The video could not be prepared.')
    })

    return () => {
      active = false
      if (stallTimer) clearInterval(stallTimer)
      const task = taskRef.current
      taskRef.current = null
      if (task) void task.cancelAsync().catch(() => undefined)
    }
  }, [appActive, cacheDestination, connection.client, expectedBytes, remoteSource.headers, remoteSource.uri, stageAttempt])

  useEffect(() => {
    setMountPlayer(false)
    if (!localURI || !appActive) return
    const timer = setTimeout(() => setMountPlayer(true), IOS_VIDEO_STAGE_PLAYER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [appActive, localURI])

  if (localURI && mountPlayer) {
    return <ArtifactIOSSystemVideoPlayer
      key={`${connection.key}:${file.id}:${stageAttempt}`}
      sourceURI={localURI}
      registerPause={registerPause}
      onDownload={onDownload}
      onClose={close}
      onRetrySource={restage}
    />
  }

  const progressPercent = progress == null ? null : Math.round(progress * 100)
  return <View testID="artifact-video-staging" style={styles.stage}>
    {stageProblem ? <View accessibilityRole="alert" testID="artifact-video-stage-problem" style={styles.problem}>
      <Text style={styles.problemTitle}>Video could not be prepared</Text>
      <Text style={styles.problemBody} numberOfLines={5}>{stageProblem}</Text>
      <View style={styles.actions}>
        <StageButton icon={RefreshCw} label="Retry" testID="artifact-video-stage-retry" onPress={restage} />
        <StageButton icon={Download} label="Download" testID="artifact-video-stage-download" onPress={onDownload} />
        <StageButton icon={X} label="Close" testID="artifact-video-stage-close" onPress={close} />
      </View>
    </View> : <View style={styles.loading}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Preparing video"
        accessibilityValue={progressPercent == null ? undefined : { min: 0, max: 100, now: progressPercent }}
        style={styles.loadingStatus}
      >
        <ActivityIndicator color="white" />
        <Text style={styles.loadingTitle}>{localURI ? 'Opening video…' : progressPercent == null ? 'Preparing video…' : `Downloading video… ${progressPercent}%`}</Text>
        {progressPercent != null && !localURI ? <View style={styles.progressRail}><View style={[styles.progressFill, { width: `${progressPercent}%` }]} /></View> : null}
      </View>
      <StageButton icon={X} label="Close" testID="artifact-video-stage-close" onPress={close} />
    </View>}
  </View>
}

function StageButton({ icon: Icon, label, testID, onPress }: {
  icon: typeof X
  label: string
  testID: string
  onPress: () => void
}) {
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    testID={testID}
    onPress={onPress}
    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.68 : 1 }]}
  >
    <Icon size={16} color="white" />
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>
}

function safeVideoCacheName(value: string, contentType: string | null | undefined): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-72) || 'video'
  if (/\.[a-zA-Z0-9]{1,8}$/.test(safe)) return safe
  const mime = contentType?.split(';', 1)[0].trim().toLocaleLowerCase()
  const extension = mime === 'video/quicktime' ? 'mov' : mime === 'video/webm' ? 'webm' : mime === 'video/x-m4v' ? 'm4v' : 'mp4'
  return `${safe}.${extension}`
}

const styles = StyleSheet.create({
  stage: { flex: 1, minHeight: 0, backgroundColor: '#050506' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 11, padding: 24 },
  loadingStatus: { width: '100%', alignItems: 'center', justifyContent: 'center', gap: 11 },
  loadingTitle: { color: '#d6d8dc', fontSize: 12, lineHeight: 17, fontWeight: '700', textAlign: 'center' },
  progressRail: { width: '72%', maxWidth: 420, height: 5, overflow: 'hidden', borderRadius: 3, backgroundColor: '#ffffff2c' },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: 'white' },
  problem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, backgroundColor: '#050506' },
  problemTitle: { color: 'white', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  problemBody: { color: '#b7bbc2', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  actions: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  button: { minWidth: 96, minHeight: 44, borderRadius: 10, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#23262b' },
  buttonText: { color: 'white', fontSize: 12, lineHeight: 16, fontWeight: '800' },
})
