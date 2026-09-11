import {
  requireAgentsDockNativeVideo,
  type AgentsDockNativeVideoHandle,
  type AgentsDockNativeVideoStatus,
} from 'agentsdock-native-video'
import { Download, RefreshCw, X } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View, type NativeSyntheticEvent } from 'react-native'
import { Text } from '../AppText'

const IOS_NATIVE_VIDEO_LOAD_TIMEOUT_MS = 15_000

export function ArtifactIOSSystemVideoPlayer({ sourceURI, registerPause, onDownload, onClose, onRetrySource }: {
  sourceURI: string
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
  onRetrySource: () => void
}) {
  const NativeVideo = useMemo(requireAgentsDockNativeVideo, [])
  const playerRef = useRef<AgentsDockNativeVideoHandle | null>(null)
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const pause = useCallback(() => {
    void playerRef.current?.pause().catch(() => undefined)
  }, [])
  const close = useCallback(() => {
    pause()
    onClose()
  }, [onClose, pause])
  const retry = useCallback(() => {
    pause()
    setReady(false)
    setProblem(null)
    onRetrySource()
  }, [onRetrySource, pause])
  const handleStatus = useCallback((event: NativeSyntheticEvent<AgentsDockNativeVideoStatus>) => {
    const { status, message } = event.nativeEvent
    if (status === 'Error') {
      setReady(false)
      setProblem(message?.trim() || "Apple's video player could not open this file.")
      return
    }
    if (status === 'Ready' || status === 'Playing' || status === 'Paused') {
      setReady(true)
      setProblem(null)
    }
  }, [])

  useEffect(() => registerPause(pause), [pause, registerPause])
  useEffect(() => () => pause(), [pause])
  useEffect(() => {
    setReady(false)
    setProblem(null)
  }, [sourceURI])
  useEffect(() => {
    if (ready || problem) return
    const timeout = setTimeout(() => {
      setProblem('Apple\'s video player took too long to open this file.')
    }, IOS_NATIVE_VIDEO_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [problem, ready, sourceURI])

  return <View testID="artifact-ios-system-video" style={styles.root}>
    <NativeVideo
      ref={playerRef}
      sourceURI={sourceURI}
      autoplay
      onStatus={handleStatus}
      style={StyleSheet.absoluteFill}
    />
    {!ready && !problem ? <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Opening video with Apple video player"
      pointerEvents="none"
      style={styles.loading}
    >
      <ActivityIndicator color="white" />
      <Text style={styles.loadingText}>Opening with Apple video player…</Text>
    </View> : null}
    {problem ? <View accessibilityRole="alert" testID="artifact-ios-system-video-problem" style={styles.problem}>
      <Text style={styles.problemTitle}>Video could not be opened</Text>
      <Text style={styles.problemBody} numberOfLines={5}>{problem}</Text>
      <View style={styles.actions}>
        <Action icon={RefreshCw} label="Retry" testID="artifact-ios-system-video-retry" onPress={retry} />
        <Action icon={Download} label="Download" testID="artifact-ios-system-video-download" onPress={onDownload} />
        <Action icon={X} label="Close" testID="artifact-ios-system-video-close" onPress={close} />
      </View>
    </View> : null}
  </View>
}

function Action({ icon: Icon, label, testID, onPress }: {
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

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: '#050506' },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#050506' },
  loadingText: { color: '#d6d8dc', fontSize: 12, lineHeight: 17, fontWeight: '700', textAlign: 'center' },
  problem: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, backgroundColor: '#050506' },
  problemTitle: { color: 'white', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  problemBody: { color: '#b7bbc2', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  actions: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  button: { minWidth: 96, minHeight: 44, borderRadius: 10, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#23262b' },
  buttonText: { color: 'white', fontSize: 12, lineHeight: 16, fontWeight: '800' },
})
