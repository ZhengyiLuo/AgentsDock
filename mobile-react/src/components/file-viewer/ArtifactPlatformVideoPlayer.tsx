import { Pressable, StyleSheet, View } from 'react-native'
import { Download, X } from 'lucide-react-native'
import type { MobileFileViewerLayout } from '../../lib/file-viewer'
import { Text } from '../AppText'

export interface ArtifactPlatformVideoSource {
  readonly uri: string
  readonly headers?: Record<string, string>
  readonly contentType?: 'progressive'
}

export interface ArtifactPlatformVideoPlayerProps {
  source: ArtifactPlatformVideoSource
  layout: MobileFileViewerLayout
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}

/** Desktop/web fallback. Metro substitutes the Android implementation. */
export function ArtifactPlatformVideoPlayer({ onDownload, onClose }: ArtifactPlatformVideoPlayerProps) {
  return <View accessibilityRole="alert" style={styles.root}>
    <Text style={styles.title}>Video playback is unavailable here</Text>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" onPress={onDownload} style={styles.button}><Download size={16} color="white" /><Text style={styles.label}>Download</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><X size={16} color="white" /><Text style={styles.label}>Close</Text></Pressable>
    </View>
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: '#050506' },
  title: { color: 'white', fontSize: 15, lineHeight: 20, fontWeight: '800', textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
  button: { minWidth: 112, minHeight: 44, borderRadius: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#23262b' },
  label: { color: 'white', fontSize: 12, fontWeight: '800' },
})
