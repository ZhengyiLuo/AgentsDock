import { AlertTriangle, CircleCheck, CircleHelp, CircleX, RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Backend, RuntimeDiagnostic } from '../types'
import { runtimeDiagnosticFor, runtimeLabel, runtimeNeedsAttention } from '../lib/runtime'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'

export function RuntimeHealthNotice({ backend }: { backend: Backend }) {
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const diagnostic = runtimeDiagnosticFor(health, runtime, backend)
  if (!runtimeNeedsAttention(diagnostic)) return null
  return <RuntimeRow backend={backend} diagnostic={diagnostic} compact />
}

export function RuntimeHealthPanel() {
  const colors = usePalette()
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const connected = useAppStore(state => state.connected)
  const refresh = useAppStore(state => state.refreshRuntime)
  return <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.raised }]}>
    <View style={styles.header}>
      <View style={{ flex: 1 }}><Text style={[styles.heading, { color: colors.text }]}>Agent runtimes</Text><Text style={[styles.caption, { color: colors.muted }]}>Provider readiness is separate from server connectivity.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh runtime status" disabled={!connected} onPress={() => void refresh()} style={[styles.refresh, { backgroundColor: colors.surface, opacity: connected ? 1 : 0.45 }]}><RefreshCw size={14} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Refresh</Text></Pressable>
    </View>
    <RuntimeRow backend="claude" diagnostic={runtimeDiagnosticFor(health, runtime, 'claude')} />
    <RuntimeRow backend="codex" diagnostic={runtimeDiagnosticFor(health, runtime, 'codex')} />
  </View>
}

function RuntimeRow({ backend, diagnostic, compact = false }: { backend: Backend; diagnostic: RuntimeDiagnostic | null; compact?: boolean }) {
  const colors = usePalette()
  const tone = diagnostic?.status === 'ready' ? (diagnostic.last_error ? 'warning' : 'ready') : diagnostic?.status === 'unknown' || !diagnostic ? 'unknown' : 'error'
  const color = tone === 'ready' ? colors.green : tone === 'warning' ? colors.orange : tone === 'error' ? colors.red : colors.muted
  const Icon = tone === 'ready' ? CircleCheck : tone === 'warning' ? AlertTriangle : tone === 'error' ? CircleX : CircleHelp
  const provider = backend === 'claude' ? 'Claude Code' : 'Codex'
  const detail = diagnostic?.last_error || diagnostic?.message || `${provider} has not been checked yet.`
  return <View accessibilityRole={tone === 'error' ? 'alert' : 'text'} style={[styles.row, compact && styles.compact, { borderColor: tone === 'error' || tone === 'warning' ? color : colors.border, backgroundColor: colors.surface }]}>
    <Icon size={compact ? 15 : 17} color={color} />
    <View style={{ flex: 1, minWidth: 0 }}><Text style={[styles.title, { color: colors.text }]}>{provider} <Text style={{ color }}>{runtimeLabel(diagnostic)}</Text></Text><Text style={[styles.detail, { color: colors.muted }]} numberOfLines={compact ? 2 : undefined}>{detail}</Text>{!compact && diagnostic?.action ? <Text style={[styles.action, { color: colors.text }]}>{diagnostic.action}</Text> : null}</View>
    {!compact && diagnostic?.version ? <Text style={[styles.version, { color: colors.muted }]} numberOfLines={1}>{diagnostic.version}</Text> : null}
  </View>
}

const styles = StyleSheet.create({
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 9, gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 }, heading: { fontSize: 12, fontWeight: '800' }, caption: { fontSize: 10, marginTop: 1 },
  refresh: { minHeight: 32, borderRadius: 5, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 8, flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  compact: { marginHorizontal: 10, marginTop: 6, paddingVertical: 7 }, title: { fontSize: 11, fontWeight: '800' }, detail: { fontSize: 10, lineHeight: 14, marginTop: 2 }, action: { fontSize: 10, lineHeight: 14, marginTop: 3 }, version: { maxWidth: 100, fontSize: 9 },
})
