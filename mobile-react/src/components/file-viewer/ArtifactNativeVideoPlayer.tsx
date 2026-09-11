import { useEvent } from 'expo'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState as NativeAppState,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from 'react-native'
import { Download, Pause, Play, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react-native'
import { adaptiveViewerDismissAllowed } from '../../lib/adaptive-file-viewer-state'
import type { MobileFileViewerLayout } from '../../lib/file-viewer'
import { clampVideoTime, formatVideoTime, validVideoDuration, videoProgress, videoTimeAtPosition } from '../../lib/video-playback'
import { isVideoFilled, type VideoContentFitMode } from '../../lib/video-fit'
import { usePalette } from '../../theme'
import { Text } from '../AppText'
import { SwipeDismissVideoSurface } from '../FullscreenImageViewer'

export interface ArtifactNativeVideoSource {
  readonly uri: string
  readonly headers?: Record<string, string>
  readonly contentType?: 'progressive'
}

// No byte-level buffering progress is available pre-readyToPlay, so this is a flat deadline rather than a stall timer.
const VIDEO_LOAD_TIMEOUT_MS = 45_000

export function ArtifactNativeVideoPlayer({ source, layout, registerPause, onDownload, onClose, onRetrySource }: {
  source: ArtifactNativeVideoSource
  layout: MobileFileViewerLayout
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
  onRetrySource?: () => void
}) {
  const colors = usePalette()
  // Create the native player without a source, then load asynchronously. This
  // keeps remote asset setup away from the presenting UI transaction and gives
  // us an explicit, bounded retry path on both AVPlayer and ExoPlayer.
  const player = useVideoPlayer(null, value => {
    value.timeUpdateEventInterval = 0
    value.keepScreenOnWhilePlaying = false
    value.staysActiveInBackground = false
    value.showNowPlayingNotification = false
    value.allowsExternalPlayback = false
    value.bufferOptions = { preferredForwardBufferDuration: 8, waitsToMinimizeStalling: true }
  })
  const statusChange = useEvent(player, 'statusChange', { status: player.status })
  const { status } = statusChange
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing })
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    bufferedPosition: -1,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  })
  const sourceLoad = useEvent(player, 'sourceLoad', null)
  const [appActive, setAppActive] = useState(NativeAppState.currentState === 'active')
  const [scrubbing, setScrubbing] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [videoFit, setVideoFit] = useState<VideoContentFitMode>('contain')
  const customControls = Platform.OS === 'ios' && layout === 'phone'
  const videoFilled = isVideoFilled(videoFit)
  const duration = validVideoDuration(sourceLoad?.duration ?? 0) || validVideoDuration(player.duration)
  const dismissible = customControls && adaptiveViewerDismissAllowed(layout, { source: 'content', kind: 'video', scrubbing })
  const pause = useCallback(() => {
    try { player.pause() } catch { /* the app-owned Close path must remain live */ }
  }, [player])
  const play = useCallback(() => {
    try {
      player.play()
    } catch {
      setLoadProblem('The video player could not start playback.')
    }
  }, [player])
  const seek = useCallback((value: number) => {
    try {
      player.currentTime = value
    } catch {
      setLoadProblem('The video player could not seek in this file.')
    }
  }, [player])
  const close = useCallback(() => {
    pause()
    onClose()
  }, [onClose, pause])

  useEffect(() => {
    let active = true
    setVideoFit('contain')
    setLoadProblem(null)
    void player.replaceAsync(source).catch(cause => {
      if (!active) return
      const detail = cause instanceof Error ? cause.message.trim() : ''
      setLoadProblem(detail ? `Video could not be loaded: ${detail}` : 'Video could not be loaded.')
    })
    return () => { active = false }
  }, [loadAttempt, player, source])
  useEffect(() => {
    if (status === 'readyToPlay') {
      setLoadProblem(null)
      return
    }
    if (status === 'error') {
      const detail = statusChange.error?.message?.trim()
      setLoadProblem(detail ? `Video could not be played: ${detail}` : 'Video could not be played.')
    }
  }, [status, statusChange.error?.message])
  useEffect(() => {
    if (!appActive || loadProblem || status === 'readyToPlay' || status === 'error') return
    const timeout = setTimeout(() => {
      setLoadProblem('Video loading took too long. Retry, download it, or close the viewer.')
    }, VIDEO_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [appActive, loadAttempt, loadProblem, status])

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => {
      const active = state === 'active'
      setAppActive(active)
      if (!active) pause()
    })
    return () => subscription.remove()
  }, [pause])
  useEffect(() => {
    player.timeUpdateEventInterval = customControls && appActive && isPlaying ? 0.5 : 0
  }, [appActive, customControls, isPlaying, player])
  useEffect(() => {
    return registerPause(pause)
  }, [pause, registerPause])

  const retry = useCallback(() => {
    pause()
    setLoadProblem(null)
    if (onRetrySource) onRetrySource()
    else setLoadAttempt(value => value + 1)
  }, [onRetrySource, pause])
  const ready = status === 'readyToPlay' && !loadProblem

  return <View testID="artifact-video-viewport" style={styles.videoViewport}>
    <VideoView
      player={player}
      nativeControls={!customControls && ready}
      // Android's native fullscreen opens a separate Activity with no back-press handling, which can strand the user; the viewer is already full-screen via the RN Modal.
      fullscreenOptions={{ enable: !customControls && Platform.OS !== 'android' }}
      allowsVideoFrameAnalysis={false}
      contentFit={videoFit}
      surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
      pointerEvents={customControls || !ready ? 'none' : 'auto'}
      style={StyleSheet.absoluteFill}
    />
    {dismissible ? <SwipeDismissVideoSurface onDismiss={close} testID="artifact-video-dismiss-surface" gestureTestID="artifact-video-dismiss-gesture" style={StyleSheet.absoluteFill} /> : null}
    {!ready && !loadProblem ? <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading video" pointerEvents="none" style={styles.videoStatus}><ActivityIndicator color="white" /><Text style={styles.videoLoadingText}>Loading video…</Text></View> : null}
    {loadProblem ? <View accessibilityRole="alert" testID="artifact-video-problem" style={styles.videoProblem}>
      <Text style={styles.videoProblemTitle}>Video could not be opened</Text>
      <Text style={styles.videoProblemBody} numberOfLines={4}>{loadProblem}</Text>
      <View style={styles.videoProblemActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry opening video" testID="artifact-video-retry" onPress={retry} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><RefreshCw size={16} color="white" /><Text style={styles.videoProblemButtonText}>Retry</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Download video" testID="artifact-video-download" onPress={onDownload} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><Download size={16} color="white" /><Text style={styles.videoProblemButtonText}>Download</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close video viewer" testID="artifact-video-problem-close" onPress={close} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><X size={16} color="white" /><Text style={styles.videoProblemButtonText}>Close</Text></Pressable>
      </View>
    </View> : null}
    {customControls && ready ? <>
      <ArtifactVideoTimeline
        currentTime={timeUpdate.currentTime}
        bufferedPosition={timeUpdate.bufferedPosition}
        duration={duration}
        isPlaying={isPlaying}
        onScrubbingChange={setScrubbing}
        onPause={pause}
        onResume={play}
        onSeek={seek}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
        accessibilityState={{ selected: isPlaying }}
        testID="artifact-video-playback-toggle"
        onPress={() => { if (player.playing) pause(); else play() }}
        style={({ pressed }) => [styles.videoPlay, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
      >
        {isPlaying ? <Pause size={24} color="white" fill="white" /> : <Play size={24} color="white" fill="white" />}
      </Pressable>
    </> : null}
    {!customControls && ready ? <View pointerEvents="box-none" testID="artifact-video-zoom-controls" style={styles.videoZoomControls}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Zoom video out"
        accessibilityHint="Fits the entire video inside the viewer"
        accessibilityState={{ disabled: !videoFilled }}
        testID="artifact-video-zoom-out"
        disabled={!videoFilled}
        onPress={() => setVideoFit('contain')}
        style={({ pressed }) => [styles.videoZoomButton, { opacity: !videoFilled ? 0.34 : pressed ? 0.65 : 1 }]}
      >
        <ZoomOut size={19} color="white" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Zoom video in"
        accessibilityHint="Fills the viewer and may crop the video edges"
        accessibilityState={{ disabled: videoFilled }}
        testID="artifact-video-zoom-in"
        disabled={videoFilled}
        onPress={() => setVideoFit('cover')}
        style={({ pressed }) => [styles.videoZoomButton, { opacity: videoFilled ? 0.34 : pressed ? 0.65 : 1 }]}
      >
        <ZoomIn size={19} color="white" />
      </Pressable>
    </View> : null}
  </View>
}

function ArtifactVideoTimeline({ currentTime, bufferedPosition, duration, isPlaying, onScrubbingChange, onPause, onResume, onSeek }: {
  currentTime: number
  bufferedPosition: number
  duration: number
  isPlaying: boolean
  onScrubbingChange: (value: boolean) => void
  onPause: () => void
  onResume: () => void
  onSeek: (value: number) => void
}) {
  const [trackWidth, setTrackWidth] = useState(0)
  const [draftTime, setDraftTime] = useState<number | null>(null)
  const draftRef = useRef<number | null>(null)
  const resumeRef = useRef(false)
  const playingRef = useRef(isPlaying)
  playingRef.current = isPlaying
  const validDuration = validVideoDuration(duration)
  const displayTime = draftTime ?? clampVideoTime(currentTime, validDuration)
  const bufferedWidth = trackWidth * videoProgress(bufferedPosition, validDuration)
  const playedWidth = trackWidth * videoProgress(displayTime, validDuration)

  const updateDraft = useCallback((event: GestureResponderEvent) => {
    const value = videoTimeAtPosition(event.nativeEvent.locationX, trackWidth, validDuration)
    draftRef.current = value
    setDraftTime(value)
  }, [trackWidth, validDuration])
  const begin = useCallback((event: GestureResponderEvent) => {
    if (!validDuration) return
    onScrubbingChange(true)
    resumeRef.current = playingRef.current
    if (playingRef.current) onPause()
    updateDraft(event)
  }, [onPause, onScrubbingChange, updateDraft, validDuration])
  const finish = useCallback(() => {
    const value = draftRef.current
    draftRef.current = null
    setDraftTime(null)
    if (value != null) onSeek(clampVideoTime(value, validDuration))
    if (resumeRef.current) onResume()
    resumeRef.current = false
    onScrubbingChange(false)
  }, [onResume, onScrubbingChange, onSeek, validDuration])
  const cancel = useCallback(() => {
    draftRef.current = null
    setDraftTime(null)
    if (resumeRef.current) onResume()
    resumeRef.current = false
    onScrubbingChange(false)
  }, [onResume, onScrubbingChange])
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => validDuration > 0,
    onMoveShouldSetPanResponder: () => validDuration > 0,
    onPanResponderGrant: begin,
    onPanResponderMove: updateDraft,
    onPanResponderRelease: finish,
    onPanResponderTerminate: cancel,
    onPanResponderTerminationRequest: () => false,
  }), [begin, cancel, finish, updateDraft, validDuration])

  useEffect(() => () => onScrubbingChange(false), [onScrubbingChange])

  return <View testID="artifact-video-timeline" style={styles.videoTimeline}>
    <Text style={styles.videoTime}>{formatVideoTime(displayTime)}</Text>
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Video timeline"
      accessibilityValue={{ min: 0, max: Math.round(validDuration), now: Math.round(displayTime), text: `${formatVideoTime(displayTime)} of ${formatVideoTime(validDuration)}` }}
      testID="artifact-video-timeline-track"
      onLayout={event => setTrackWidth(Math.max(0, event.nativeEvent.layout.width))}
      style={styles.videoTimelineTrack}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={styles.videoRail}>
        <View style={[styles.videoBuffered, { width: bufferedWidth }]} />
        <View style={[styles.videoPlayed, { width: playedWidth }]} />
        <View style={[styles.videoThumb, { left: Math.max(0, playedWidth - 7) }]} />
      </View>
    </View>
    <Text style={styles.videoTime}>{formatVideoTime(validDuration)}</Text>
  </View>
}

const styles = StyleSheet.create({
  videoViewport: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: '#050506' },
  videoStatus: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 9 },
  videoLoadingText: { color: '#d6d8dc', fontSize: 12, lineHeight: 17, fontWeight: '700' },
  videoProblem: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 4, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 7, backgroundColor: '#050506e8' },
  videoProblemTitle: { color: 'white', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  videoProblemBody: { color: '#b7bbc2', fontSize: 12, textAlign: 'center' },
  videoProblemActions: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  videoProblemButton: { minWidth: 96, minHeight: 44, borderRadius: 10, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#23262b' },
  videoProblemButtonText: { color: 'white', fontSize: 12, lineHeight: 16, fontWeight: '800' },
  videoTimeline: { position: 'absolute', left: 14, right: 14, bottom: 78, zIndex: 3, minHeight: 52, borderRadius: 12, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#000000dc' },
  videoTime: { minWidth: 36, color: 'white', fontSize: 10, lineHeight: 14, fontVariant: ['tabular-nums'], textAlign: 'center' },
  videoTimelineTrack: { flex: 1, height: 48, justifyContent: 'center' },
  videoRail: { height: 4, borderRadius: 2, backgroundColor: '#ffffff30' },
  videoBuffered: { position: 'absolute', left: 0, top: 0, height: 4, borderRadius: 2, backgroundColor: '#ffffff55' },
  videoPlayed: { position: 'absolute', left: 0, top: 0, height: 4, borderRadius: 2, backgroundColor: '#ffffff' },
  videoThumb: { position: 'absolute', top: -5, width: 14, height: 14, borderRadius: 7, backgroundColor: 'white' },
  videoPlay: { position: 'absolute', left: '50%', bottom: 14, zIndex: 3, width: 54, height: 54, marginLeft: -27, borderRadius: 27, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  videoZoomControls: { position: 'absolute', top: 10, right: 10, zIndex: 3, height: 44, borderRadius: 22, flexDirection: 'row', alignItems: 'center', overflow: 'hidden', backgroundColor: '#000000c9' },
  videoZoomButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
})
