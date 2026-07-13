import { useEffect, useMemo, useState } from 'react'
import { useEvent } from 'expo'
import { ActivityIndicator, Modal, Platform, Pressable, Share, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { VideoView, useVideoPlayer, type VideoThumbnail } from 'expo-video'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { ChevronLeft, ChevronRight, Download, File, Images, Maximize2, Pin, Play } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { AgentFile } from '../types'
import { formatBytes, isImage, isMedia, isVideo } from '../lib/format'
import { IconButton } from './ui'

const TILE_GAP = 8
const TIMELINE_MEDIA_LIMIT = 4
const INSPECTOR_MEDIA_LIMIT = 8
const TIMELINE_FILE_LIMIT = 3
const INSPECTOR_FILE_LIMIT = 6

export function MediaGrid({ files, sessionId, compact = false }: { files: AgentFile[]; sessionId: string; compact?: boolean }) {
  const colors = usePalette()
  const pinFile = useAppStore(state => state.pinFile)
  const removePin = useAppStore(state => state.removePin)
  const pins = useAppStore(state => state.pins)
  const pinnedIds = useMemo(() => new Set(pins.filter(value => value.kind === 'file').map(value => value.fileId)), [pins])
  const [containerWidth, setContainerWidth] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAllFiles, setShowAllFiles] = useState(false)
  const media = useMemo(() => files.filter(isMedia), [files])
  const documents = useMemo(() => files.filter(file => !isMedia(file)), [files])
  const mediaLimit = compact ? INSPECTOR_MEDIA_LIMIT : TIMELINE_MEDIA_LIMIT
  const fileLimit = compact ? INSPECTOR_FILE_LIMIT : TIMELINE_FILE_LIMIT
  const visibleMedia = media.slice(0, mediaLimit)
  const visibleDocuments = showAllFiles ? documents : documents.slice(0, fileLimit)
  const columns = mediaColumns(containerWidth, visibleMedia.length)
  const measuredWidth = containerWidth || 320
  const tileWidth = Math.max(118, Math.floor((measuredWidth - TILE_GAP * (columns - 1)) / columns))

  if (!files.length) return null
  const handleLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    setContainerWidth(current => Math.abs(current - width) < 2 ? current : width)
  }
  const togglePin = (file: AgentFile) => {
    void (pinnedIds.has(file.id) ? removePin(`file:${file.id}`) : pinFile(sessionId, file))
  }

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      {visibleMedia.length ? (
        <View style={styles.grid}>
          {visibleMedia.map((file, index) => {
            const hidden = media.length - visibleMedia.length
            return <MediaTile
              key={file.id}
              file={file}
              width={tileWidth}
              hiddenCount={index === visibleMedia.length - 1 ? hidden : 0}
              pinned={pinnedIds.has(file.id)}
              onPreview={() => setSelectedId(file.id)}
              onDownload={() => void downloadAndShare(file)}
              onPin={() => togglePin(file)}
            />
          })}
        </View>
      ) : null}

      {visibleDocuments.length ? (
        <View style={styles.fileList}>
          {visibleDocuments.map(file => <FileRow
            key={file.id}
            file={file}
            pinned={pinnedIds.has(file.id)}
            onDownload={() => void downloadAndShare(file)}
            onPin={() => togglePin(file)}
          />)}
        </View>
      ) : null}

      <View style={styles.moreRow}>
        {media.length > visibleMedia.length ? (
          <Pressable onPress={() => setSelectedId(media[0]?.id ?? null)} style={[styles.moreButton, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <Images size={14} color={colors.blue} />
            <Text style={[styles.moreText, { color: colors.blue }]}>View all {media.length} media</Text>
          </Pressable>
        ) : null}
        {documents.length > fileLimit ? (
          <Pressable onPress={() => setShowAllFiles(value => !value)} style={[styles.moreButton, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <File size={14} color={colors.muted} />
            <Text style={[styles.moreText, { color: colors.muted }]}>{showAllFiles ? 'Show fewer files' : `Show all ${documents.length} files`}</Text>
          </Pressable>
        ) : null}
      </View>

      <Modal
        visible={selectedId != null}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={() => setSelectedId(null)}
      >
        {selectedId ? <MediaViewer files={media} initialId={selectedId} onClose={() => setSelectedId(null)} /> : null}
      </Modal>
    </View>
  )
}

function MediaTile({ file, width, hiddenCount, pinned, onPreview, onDownload, onPin }: { file: AgentFile; width: number; hiddenCount: number; pinned: boolean; onPreview: () => void; onDownload: () => void; onPin: () => void }) {
  const colors = usePalette()
  return <View style={[styles.tile, { width, borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.title || file.filename}`} onPress={onPreview}>
      <View style={styles.preview}>
        {isImage(file) ? <RemoteImagePreview file={file} /> : <VideoThumbnailPreview file={file} />}
        {isVideo(file) ? <View pointerEvents="none" style={styles.playBadge}><Play size={18} color="white" fill="white" /></View> : null}
        {hiddenCount > 0 ? <View pointerEvents="none" style={styles.hiddenBadge}><Text style={styles.hiddenText}>+{hiddenCount}</Text></View> : null}
      </View>
      <View style={styles.caption}>
        <Text style={[styles.fileTitle, { color: colors.text }]} numberOfLines={2}>{file.title || file.filename}</Text>
        <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
      </View>
    </Pressable>
    <View style={styles.tileActions}>
      <IconButton icon={Download} size={14} label="Download" onPress={onDownload} />
      <IconButton icon={Pin} size={14} selected={pinned} label={pinned ? 'Unpin' : 'Pin'} onPress={onPin} />
      <IconButton icon={Maximize2} size={14} label="Preview" onPress={onPreview} />
    </View>
  </View>
}

function FileRow({ file, pinned, onDownload, onPin }: { file: AgentFile; pinned: boolean; onDownload: () => void; onPin: () => void }) {
  const colors = usePalette()
  return <View style={[styles.fileRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={[styles.fileIcon, { backgroundColor: colors.raised }]}><File size={18} color={colors.muted} /></View>
    <Pressable onPress={onDownload} style={styles.fileIdentity}>
      <Text style={[styles.fileRowTitle, { color: colors.text }]} numberOfLines={1}>{file.title || file.filename}</Text>
      <Text style={[styles.fileMeta, { color: colors.muted }]}>{formatBytes(file.size)}</Text>
    </Pressable>
    <IconButton icon={Download} size={14} label="Download" onPress={onDownload} />
    <IconButton icon={Pin} size={14} selected={pinned} label={pinned ? 'Unpin' : 'Pin'} onPress={onPin} />
  </View>
}

function RemoteImagePreview({ file }: { file: AgentFile }) {
  const colors = usePalette()
  const [failed, setFailed] = useState(false)
  if (failed) return <View style={[styles.center, { backgroundColor: colors.raised }]}><Images size={22} color={colors.muted} /></View>
  return <Image source={{ uri: client.fileURL(file.id), headers: client.authHeaders() }} contentFit="contain" style={StyleSheet.absoluteFill} transition={120} onError={() => setFailed(true)} />
}

function VideoThumbnailPreview({ file }: { file: AgentFile }) {
  const colors = usePalette()
  const source = useMemo(() => ({ uri: client.fileURL(file.id), headers: client.authHeaders(), contentType: 'progressive' as const }), [file.id])
  const player = useVideoPlayer(source, value => { value.muted = true })
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  const [thumbnail, setThumbnail] = useState<VideoThumbnail | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (status !== 'readyToPlay' || thumbnail || failed) return
    let active = true
    const requestedTime = Math.min(0.5, Math.max(0, player.duration * 0.05))
    void player.generateThumbnailsAsync(requestedTime, { maxWidth: 640, maxHeight: 360 })
      .then(values => { if (active && values[0]) setThumbnail(values[0]) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [failed, player, status, thumbnail])

  if (thumbnail) return <Image source={thumbnail} contentFit="contain" style={StyleSheet.absoluteFill} transition={100} />
  return <View style={[styles.center, { backgroundColor: '#090a0b' }]}>{failed ? <File size={22} color={colors.muted} /> : <ActivityIndicator color="white" />}</View>
}

function MediaViewer({ files, initialId, onClose }: { files: AgentFile[]; initialId: string; onClose: () => void }) {
  const colors = usePalette()
  const [index, setIndex] = useState(Math.max(0, files.findIndex(file => file.id === initialId)))
  useEffect(() => { setIndex(Math.max(0, files.findIndex(file => file.id === initialId))) }, [files, initialId])
  const file = files[index]
  return (
    <SafeAreaView style={[styles.viewer, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.viewerTop}>
        <IconButton icon={ChevronLeft} onPress={onClose} label="Back" />
        <Text style={[styles.viewerTitle, { color: colors.text }]} numberOfLines={1}>{file?.title || file?.filename}</Text>
        <IconButton icon={Download} onPress={() => file && void downloadAndShare(file)} label="Download" />
      </View>
      <View style={styles.viewerBody}>
        {file && isImage(file) ? <Image source={{ uri: client.fileURL(file.id), headers: client.authHeaders() }} contentFit="contain" style={StyleSheet.absoluteFill} /> : file ? <RemoteVideo key={file.id} file={file} /> : <ActivityIndicator />}
        {files.length > 1 ? <>
          <Pressable disabled={index === 0} onPress={() => setIndex(value => Math.max(0, value - 1))} style={[styles.nav, styles.navLeft, index === 0 && styles.disabled]}><ChevronLeft size={30} color="white" /></Pressable>
          <Pressable disabled={index === files.length - 1} onPress={() => setIndex(value => Math.min(files.length - 1, value + 1))} style={[styles.nav, styles.navRight, index === files.length - 1 && styles.disabled]}><ChevronRight size={30} color="white" /></Pressable>
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

function mediaColumns(width: number, count: number): number {
  if (count <= 1) return 1
  if (width >= 760) return Math.min(4, count)
  if (width >= 500) return Math.min(3, count)
  if (width >= 270) return Math.min(2, count)
  return 1
}

async function downloadAndShare(file: AgentFile): Promise<void> {
  try {
    const destination = `${FileSystem.cacheDirectory}${safeFilename(file.filename)}`
    const result = await FileSystem.downloadAsync(client.fileURL(file.id), destination, { headers: client.authHeaders() })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri, { mimeType: file.content_type ?? undefined, dialogTitle: file.title || file.filename })
    else await Share.share({ url: result.uri, title: file.title || file.filename })
  } catch { /* media failures stay local to the invoked action */ }
}
function safeFilename(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'download' }

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  tile: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  preview: { width: '100%', aspectRatio: 16 / 9, position: 'relative', backgroundColor: '#090a0b' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playBadge: { position: 'absolute', left: '50%', top: '50%', marginLeft: -19, marginTop: -19, width: 38, height: 38, borderRadius: 19, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  hiddenBadge: { position: 'absolute', right: 7, bottom: 7, minWidth: 34, height: 25, borderRadius: 13, paddingHorizontal: 8, backgroundColor: '#000000bb', alignItems: 'center', justifyContent: 'center' },
  hiddenText: { color: 'white', fontSize: 12, fontWeight: '800' },
  caption: { paddingHorizontal: 9, paddingTop: 7, minHeight: 48 },
  fileTitle: { fontSize: 12, fontWeight: '700' },
  fileMeta: { fontSize: 10, marginTop: 2 },
  tileActions: { height: 32, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2 },
  fileList: { gap: 6 },
  fileRow: { minHeight: 48, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  fileIcon: { width: 32, height: 32, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  fileIdentity: { flex: 1, minWidth: 0, paddingVertical: 7 },
  fileRowTitle: { fontSize: 11.5, fontWeight: '700' },
  moreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  moreButton: { minHeight: 34, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  moreText: { fontSize: 11, fontWeight: '700' },
  viewer: { flex: 1 },
  viewerTop: { height: 58, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewerTitle: { flex: 1, fontSize: 14, fontWeight: '700' },
  viewerBody: { flex: 1, minHeight: 0, position: 'relative', backgroundColor: '#050506' },
  viewerCount: { textAlign: 'center', paddingVertical: 12 },
  nav: { position: 'absolute', top: '45%', width: 46, height: 58, borderRadius: 7, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center' },
  navLeft: { left: 10 },
  navRight: { right: 10 },
  disabled: { opacity: 0.25 },
})
