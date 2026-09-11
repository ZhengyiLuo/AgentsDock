import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { formatBytes } from '../../lib/format'
import { isFileTransferBusy, type FileTransferState } from '../../lib/file-transfer'
import { usePalette } from '../../theme'
import { Text } from '../AppText'

export function FileTransferNotice({ state, onCancel, onDismiss }: { state: FileTransferState | null; onCancel: () => void; onDismiss: () => void }) {
  const colors = usePalette()
  if (!state) return null
  const busy = isFileTransferBusy(state)
  const cancellable = state.phase === 'downloading'
  const fraction = state.totalBytes && state.bytesWritten != null ? Math.min(1, state.bytesWritten / state.totalBytes) : null
  const title = state.message || (state.phase === 'choosing' ? 'Choose a folder to save this file.'
    : state.phase === 'saving' ? `Saving ${state.filename} to the selected folder…`
      : state.phase === 'sharing' ? 'Choose an app in the share sheet.'
        : `Downloading ${state.filename}…`)
  const progress = state.phase === 'downloading'
    ? fraction == null ? `${formatBytes(state.bytesWritten ?? 0) || '0 B'} downloaded` : `${Math.floor(fraction * 100)}% · ${formatBytes(state.bytesWritten ?? 0) || '0 B'} of ${formatBytes(state.totalBytes)}`
    : ''
  return <View testID="file-transfer-notice" accessibilityRole={state.phase === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.surface, borderColor: state.phase === 'error' ? colors.red : colors.border }]}>
    {busy ? <ActivityIndicator size="small" color={colors.blue} /> : null}
    <View style={styles.body}>
      <Text style={{ color: state.phase === 'error' ? colors.red : colors.text, fontSize: 12 }}>{title}</Text>
      {progress ? <Text testID="file-transfer-progress" style={{ color: colors.muted, fontSize: 11 }}>{progress}</Text> : null}
      {fraction != null && state.phase === 'downloading' ? <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.floor(fraction * 100) }} style={[styles.track, { backgroundColor: colors.raised }]}><View style={[styles.fill, { backgroundColor: colors.blue, width: `${fraction * 100}%` }]} /></View> : null}
    </View>
    {cancellable || !busy ? <Pressable accessibilityRole="button" accessibilityLabel={cancellable ? 'Cancel download' : 'Dismiss download status'} testID={cancellable ? 'file-transfer-cancel' : 'file-transfer-dismiss'} onPress={cancellable ? onCancel : onDismiss} style={styles.action}><Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700' }}>{cancellable ? 'Cancel' : 'Dismiss'}</Text></Pressable> : null}
  </View>
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingLeft: 10, paddingRight: 4, paddingVertical: 4 },
  body: { flex: 1, gap: 4, paddingVertical: 4 },
  action: { minWidth: 60, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3 },
})
