import { useState } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { ExternalLink } from 'lucide-react-native'
import { typography, usePalette } from '../theme'
import { Text } from './AppText'

export function AppleUpdateSettings() {
  const colors = usePalette()
  const [error, setError] = useState<string | null>(null)
  const open = async (url: string, fallback?: string) => {
    setError(null)
    try { await Linking.openURL(url) }
    catch {
      try {
        if (!fallback) throw new Error('Could not open the store. Try again.')
        await Linking.openURL(fallback)
      } catch { setError('Could not open the store. Try again.') }
    }
  }
  return <View testID="ios-update-settings">
    <Pressable testID="ios-update-app-store" accessibilityRole="link" accessibilityLabel="Open App Store" onPress={() => void open('https://apps.apple.com/app/id6769275751')} style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[typography.body, styles.label, { color: colors.text }]} localize>App Store</Text><ExternalLink size={19} color={colors.muted} />
    </Pressable>
    <Pressable testID="ios-update-testflight" accessibilityRole="link" accessibilityLabel="Open TestFlight" onPress={() => void open('itms-beta://', 'https://apps.apple.com/app/id899247664')} style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[typography.body, styles.label, { color: colors.text }]}>TestFlight</Text><ExternalLink size={19} color={colors.muted} />
    </Pressable>
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: colors.red }]} localize>{error}</Text> : null}
  </View>
}

const styles = StyleSheet.create({ row: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 12 }, label: { flex: 1 } })
