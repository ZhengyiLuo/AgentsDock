import { useEffect, useState } from 'react'
import { StyleSheet, Switch, View } from 'react-native'
import { ShieldCheck } from 'lucide-react-native'
import { getAndroidAnalyticsEnabled, setAndroidAnalyticsEnabled } from '../lib/analytics'
import { usePalette } from '../theme'
import { Text } from './AppText'

export function AnalyticsSettings({ visible }: { visible: boolean }) {
  const colors = usePalette()
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!visible) return
    let active = true
    void getAndroidAnalyticsEnabled().then(value => {
      if (active) setEnabled(value)
    })
    return () => { active = false }
  }, [visible])

  const changeAnalytics = async (value: boolean) => {
    if (busy) return
    setBusy(true)
    setEnabled(value)
    await setAndroidAnalyticsEnabled(value)
    setBusy(false)
  }

  return <View style={[styles.setting, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <ShieldCheck size={18} color={colors.blue} />
      <View style={styles.copy}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>Usage analytics</Text>
        <Text style={[styles.detail, { color: colors.muted }]}>{enabled ? 'On. Sends ID-less usage events to Mixpanel—never chat, file, path, server, token, screen-replay, IP-location, or persistent identifier data.' : 'Off. No Mixpanel events are sent.'}</Text>
      </View>
      <Switch testID="settings-analytics-toggle" accessibilityLabel="Share usage analytics" value={enabled} disabled={busy} onValueChange={value => void changeAnalytics(value)} />
    </View>
}

const styles = StyleSheet.create({
  setting: { minHeight: 74, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 9 },
  copy: { flex: 1, gap: 3 },
  detail: { fontSize: 10, lineHeight: 14 },
})
