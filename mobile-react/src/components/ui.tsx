import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { usePalette } from '../theme'

export function IconButton({ icon: Icon, onPress, disabled, selected, size = 18, touchSize = 40, label, testID }: { icon: LucideIcon; onPress: () => void; disabled?: boolean; selected?: boolean; size?: number; touchSize?: number; label?: string; testID?: string }) {
  const colors = usePalette()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(selected) }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { width: touchSize, height: touchSize, backgroundColor: selected ? colors.raised : 'transparent', opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
    >
      <Icon size={size} color={selected ? colors.blue : colors.muted} strokeWidth={1.8} />
    </Pressable>
  )
}

export function SectionHeader({ title, trailing }: { title: string; trailing?: ReactNode }) {
  const colors = usePalette()
  return <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: colors.muted }]}>{title}</Text>{trailing}</View>
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'orange' | 'yellow' }) {
  const colors = usePalette()
  const foreground = tone === 'blue' ? colors.blue : tone === 'green' ? colors.green : tone === 'orange' ? colors.orange : tone === 'yellow' ? colors.yellow : colors.muted
  return <View style={[styles.pill, { backgroundColor: colors.raised }]}><Text style={[styles.pillText, { color: foreground }]} numberOfLines={1}>{children}</Text></View>
}

export function Loading({ label }: { label?: string }) {
  const colors = usePalette()
  return <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>{label}</Text></View>
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  const colors = usePalette()
  return <View style={styles.empty}><Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>{body ? <Text style={[styles.emptyBody, { color: colors.muted }]}>{body}</Text> : null}</View>
}

const styles = StyleSheet.create({
  iconButton: { alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  sectionHeader: { minHeight: 28, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  pill: { minHeight: 24, minWidth: 0, maxWidth: 190, flexShrink: 1, borderRadius: 6, paddingHorizontal: 8, justifyContent: 'center' },
  pillText: { fontSize: 12, fontWeight: '600' },
  loading: { flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: 10 },
  empty: { flex: 1, minHeight: 180, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyBody: { fontSize: 14, textAlign: 'center', maxWidth: 320 },
})
