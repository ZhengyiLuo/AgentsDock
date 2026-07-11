import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Copy, X } from 'lucide-react-native'
import { client } from '../store/useAppStore'
import { usePalette } from '../theme'
import { IconButton, Loading } from './ui'

interface DiffFile { path: string; lines: string[]; additions: number; deletions: number }

export function CodeReview({ sessionId, runId, onClose }: { sessionId: string; runId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  useEffect(() => {
    if (!runId) return
    setLoading(true); setDiff(''); setSelected(0)
    void client.codeDiff(sessionId, runId).then(setDiff).finally(() => setLoading(false))
  }, [runId, sessionId])
  const files = useMemo(() => parseDiff(diff), [diff])
  const file = files[selected]
  return <Modal visible={Boolean(runId)} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderColor: colors.border }]}><Text style={[styles.title, { color: colors.text }]}>Review</Text><Text style={{ color: colors.green }}>+{files.reduce((sum, value) => sum + value.additions, 0)}</Text><Text style={{ color: colors.red }}>-{files.reduce((sum, value) => sum + value.deletions, 0)}</Text><View style={{ flex: 1 }} /><IconButton icon={Copy} onPress={() => void Clipboard.setStringAsync(diff)} label="Copy diff" /><IconButton icon={X} onPress={onClose} label="Close" /></View>
      {loading ? <Loading label="Loading complete diff" /> : <View style={styles.workspace}>
        <ScrollView style={[styles.files, { borderColor: colors.border }]} contentContainerStyle={{ padding: 6 }}>{files.map((value, index) => <Pressable key={`${value.path}:${index}`} onPress={() => setSelected(index)} style={[styles.file, { backgroundColor: index === selected ? colors.raised : 'transparent' }]}><Text style={{ flex: 1, color: colors.text, fontSize: 11, fontFamily: 'Menlo' }} numberOfLines={2}>{value.path}</Text><Text style={{ color: colors.green, fontSize: 10 }}>+{value.additions}</Text><Text style={{ color: colors.red, fontSize: 10 }}>-{value.deletions}</Text></Pressable>)}</ScrollView>
        <ScrollView style={styles.diff} horizontal contentContainerStyle={{ minWidth: '100%' }}><ScrollView contentContainerStyle={{ paddingVertical: 8 }}>{file?.lines.map((line, index) => <View key={index} style={[styles.line, line.startsWith('+') && !line.startsWith('+++') ? { backgroundColor: '#123c25' } : line.startsWith('-') && !line.startsWith('---') ? { backgroundColor: '#421d20' } : undefined]}><Text selectable style={[styles.lineNumber, { color: colors.muted }]}>{index + 1}</Text><Text selectable style={[styles.code, { color: line.startsWith('+') ? '#68e393' : line.startsWith('-') ? '#ff858b' : colors.text }]}>{line || ' '}</Text></View>)}</ScrollView></ScrollView>
      </View>}
    </View>
  </Modal>
}

function parseDiff(value: string): DiffFile[] {
  const result: DiffFile[] = []
  let current: DiffFile | null = null
  for (const line of value.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) result.push(current)
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = { path: match?.[2] ?? line.slice(11), lines: [line], additions: 0, deletions: 0 }
    } else if (current) {
      current.lines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
      if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
    }
  }
  if (current) result.push(current)
  if (!result.length && value) result.push({ path: 'Changes', lines: value.split('\n'), additions: 0, deletions: 0 })
  return result
}

const styles = StyleSheet.create({
  root: { flex: 1 }, header: { height: 54, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }, title: { fontSize: 15, fontWeight: '800' },
  workspace: { flex: 1, flexDirection: 'row' }, files: { width: 260, maxWidth: '34%', borderRightWidth: StyleSheet.hairlineWidth }, file: { minHeight: 54, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  diff: { flex: 1 }, line: { minHeight: 20, flexDirection: 'row' }, lineNumber: { width: 52, paddingRight: 10, textAlign: 'right', fontFamily: 'Menlo', fontSize: 11 }, code: { fontFamily: 'Menlo', fontSize: 11.5, paddingRight: 20 },
})
