import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native'
import { t } from '../i18n'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { runtimeOptionLabel } from '../lib/runtime-catalog'
import { useLanguageStore } from '../store/useLanguageStore'
import { radius, spacing, typography, usePalette } from '../theme'
import type { RuntimeOption } from '../types'
import { Text } from './AppText'

export function ModelDropdown({ value, options, onChange, testID }: {
  value: string
  options: RuntimeOption[]
  onChange: (value: string) => void
  testID: string
}) {
  const colors = usePalette()
  useLanguageStore(state => state.locale)
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  const choices = options.filter((option, index) => !option.locked
    && options.findIndex(candidate => candidate.value === option.value) === index)
  const label = selected ? runtimeOptionLabel(selected, t) : value || t('Default')
  const Chevron = open ? ChevronUp : ChevronDown

  return <View style={styles.root}>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${t('Model')}: ${label}`}
      accessibilityState={{ expanded: open }} onPress={() => { dismissAppKeyboard(); setOpen(current => !current) }}
      style={[styles.trigger, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text numberOfLines={1} style={[typography.caption, styles.label, { color: colors.text }]}>{label}</Text>
      <Chevron size={16} color={colors.muted} />
    </Pressable>
    {open ? <View testID={`${testID}-options`} style={[styles.menu, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" style={styles.scroll}>
        {choices.length ? choices.map(option => <Pressable key={option.value || '__default'}
          testID={`${testID}-option-${option.value || 'default'}`} accessibilityRole="button"
          accessibilityLabel={runtimeOptionLabel(option, t)} accessibilityState={{ selected: option.value === value }}
          onPress={() => { if (option.locked) return; setOpen(false); onChange(option.value) }}
          style={({ pressed }) => [styles.option, { backgroundColor: pressed || option.value === value ? colors.raised : 'transparent' }]}>
          <Text style={[typography.caption, styles.label, { color: colors.text }]}>{runtimeOptionLabel(option, t)}</Text>
          {option.value === value ? <Check size={16} color={colors.blue} /> : <View style={styles.checkSpace} />}
        </Pressable>) : <Text style={[typography.caption, styles.empty, { color: colors.muted }]} localize>No selectable models.</Text>}
      </ScrollView>
    </View> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { gap: spacing.xs },
  trigger: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { flex: 1, minWidth: 0 },
  menu: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  scroll: { maxHeight: 240 },
  option: { minHeight: 44, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkSpace: { width: 16 },
  empty: { padding: spacing.md },
})
