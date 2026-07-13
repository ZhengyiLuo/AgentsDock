import { useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { VideoView, useVideoPlayer } from 'expo-video'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { ChevronLeft, ChevronRight, Download, File, Maximize2, Pin, Play } from 'lucide-react-native'
import { client } from '../store/useAppStore'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { AgentFile } from '../types'
import { formatBytes, isImage, isMedia, isVideo } from '../lib/format'
import { IconButton } from './ui'

export function MediaGrid({ files, sessionId, compact = false }: { files: AgentFile[]; sessionId: string; compact?: boolean }) {
  const colors = usePalette()
  const { width } = useWindowDimensions()
  const pinFile = useAppStore(state => state.pinFile)
  const removePin = useAppStore(state => state.removePin)
  const pins = useAppStore(state => state.pins)
  const pinnedIds = useMemo(() => new Set(pins.filter(value => value.kind === 'file').map(value => value.fileId)), [pins])
  const [selected, setSelected] = useState<number | null>(null)
  const visible = useMemo(() => files.slice(0, compact ? 8 : 24), [compact, files])
  const columns = width >= 1100 ? 4 : width >= 680 ? 3 : 2
  if (!files.length) return null
  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {visible.map((file, index) => (
          <Pressable key={file.id} onPress={() => isMedia(file) ? setSelected(index) : void downloadAndShare(file)} style={[styles.tile, { width: `${100 / columns - 1.2}%`, borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={[styles.preview, { backgroundColor: isMedia(file) ? '#08090a' : colors.raised }]}>
              {isImage(file) ? (
                <Image source={{ uri: client.fileURL(file.id), headers: client.authHeaders() }} contentFit="cover" style={StyleSheet.absoluteFill} transition={120} />
              ) : isVideo(file) ? (
                <View style={styles.center}><Play size={25} color="white" fill="white" /></View>
              ) : (
                <View style={styles.center}><File size={24} color={colors.muted} /></View>
              )}
            </View>
            <View style={styles.caption}>
              <Text style={[styles.fileTitle, { color: colors.text }]} numberOfLines={2}>{file.title || file.filename}</Text>
              <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
            </View>
            <View style={styles.tileActions}>
              <IconButton icon={Download} size={14} label="Download" onPress={() => void downloadAndShare(file)} />
              <IconButton icon={Pin} size={14} selected={pinnedIds.has(file.id)} label={pinnedIds.has(file.id) ? 'Unpin' : 'Pin'} onPress={() => void (pinnedIds.has(file.id) ? removePin(`file:${file.id}`) : pinFile(sessionId, file))} />
              {isMedia(file) ? <IconButton icon={Maximize2} size={14} label="Preview" onPress={() => setSelected(index)} /> : null}
            </View>
          </Pressable>
        ))}
      </View>
      {files.length > visible.length ? <Text style={[styles.more, { color: colors.muted }]}>Showing {visible.length} of {files.length}</Text> : null}
      <Modal
        visible={selected != null}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={() => setSelected(null)}
      >
        {selected != null && visible[selected] ? <MediaViewer files={visible.filter(isMedia)} initialId={visible[selected].id} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </View>
  )
}

function MediaViewer({ files, initialId, onClose }: { files: AgentFile[]; initialId: string; onClose: () => void }) {
  const colors = usePalette()
  const [index, setIndex] = useState(Math.max(0, files.findIndex(file => file.id === initialId)))
  const file = files[index]
  return (
    <SafeAreaView style={[styles.viewer, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.viewerTop}>
        <IconButton icon={ChevronLeft} onPress={onClose} label="Back" />
        <Text style={[styles.viewerTitle, { color: colors.text }]} numberOfLines={1}>{file?.title || file?.filename}</Text>
        <IconButton icon={Download} onPress={() => file && void downloadAndShare(file)} label="Download" />
      </View>
      <View style={styles.viewerBody}>
        {file && isImage(file) ? <Image source={{ uri: client.fileURL(file.id), headers: client.authHeaders() }} contentFit="contain" style={StyleSheet.absoluteFill} /> : file ? <RemoteVideo file={file} /> : <ActivityIndicator />}
        {files.length > 1 ? <>
          <Pressable disabled={index === 0} onPress={() => setIndex(value => Math.max(0, value - 1))} style={[styles.nav, styles.navLeft]}><ChevronLeft size={30} color="white" /></Pressable>
          <Pressable disabled={index === files.length - 1} onPress={() => setIndex(value => Math.min(files.length - 1, value + 1))} style={[styles.nav, styles.navRight]}><ChevronRight size={30} color="white" /></Pressable>
        </> : null}
      </View>
      <Text style={[styles.viewerCount, { color: colors.muted }]}>{index + 1} / {files.length}</Text>
    </SafeAreaView>
  )
}

function RemoteVideo({ file }: { file: AgentFile }) {
  const player = useVideoPlayer({ uri: client.fileURL(file.id), headers: client.authHeaders(), contentType: 'progressive' }, value => { value.play() })
  return <VideoView player={player} nativeControls fullscreenOptions={{ enable: true }} contentFit="contain" style={StyleSheet.absoluteFill} />
}

async function downloadAndShare(file: AgentFile): Promise<void> {
  try {
    const destination = `${FileSystem.cacheDirectory}${safeFilename(file.filename)}`
    const result = await FileSystem.downloadAsync(client.fileURL(file.id), destination, { headers: client.authHeaders() })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri, { mimeType: file.content_type ?? undefined, dialogTitle: file.title || file.filename })
    else await Share.share({ url: result.uri, title: file.title || file.filename })
  } catch { /* the parent error surface is intentionally not replaced by a media share failure */ }
}
function safeFilename(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'download' }

const styles = StyleSheet.create({
  wrap: { gap: 8 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { minWidth: 130, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  preview: { height: 112, position: 'relative' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  caption: { paddingHorizontal: 9, paddingTop: 8, minHeight: 50 }, fileTitle: { fontSize: 12, fontWeight: '700' }, fileMeta: { fontSize: 10, marginTop: 2 },
  tileActions: { height: 34, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2 },
  more: { fontSize: 11, textAlign: 'center' },
  viewer: { flex: 1 }, viewerTop: { height: 58, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 }, viewerTitle: { flex: 1, fontSize: 14, fontWeight: '700' },
  viewerBody: { flex: 1, position: 'relative' }, viewerCount: { textAlign: 'center', paddingVertical: 12 },
  nav: { position: 'absolute', top: '45%', width: 50, height: 60, borderRadius: 8, backgroundColor: '#00000077', alignItems: 'center', justifyContent: 'center' }, navLeft: { left: 12 }, navRight: { right: 12 },
})
