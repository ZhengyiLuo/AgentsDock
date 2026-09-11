import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Switch, View } from 'react-native'
import { Goal, RefreshCw } from 'lucide-react-native'
import { ServerError, type AgentServerClient } from '../api/AgentServerClient'
import { announceCodexGoalsConfigurationChanged } from '../lib/codex-goals-configuration'
import { codexControlsCapability } from '../lib/codex-controls'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { CodexGoalsConfiguration } from '../types'
import { Text } from './AppText'
import { IconButton } from './ui'

export function CodexServerSettings({ visible }: { visible: boolean }) {
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const ready = useAppStore(state => state.connected && !state.connecting && !state.workspaceAdopting && !state.switchingProfileId)
  const health = useAppStore(state => state.health)
  if (!visible || !profileId || !codexControlsCapability(health)) return null
  return <ScopedGoalSettings key={`${profileId}:${generation}`} connection={client} profileId={profileId} generation={generation} ready={ready} />
}

function ScopedGoalSettings({ connection, profileId, generation, ready }: {
  connection: AgentServerClient
  profileId: string
  generation: number
  ready: boolean
}) {
  const colors = usePalette()
  const [configuration, setConfiguration] = useState<CodexGoalsConfiguration | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const savingRef = useRef(false)
  const confirmingRef = useRef(false)
  const current = () => {
    const state = useAppStore.getState()
    return mounted.current && client === connection && connection.isValidated
      && state.activeProfileId === profileId && state.profileGeneration === generation
      && state.connected && !state.connecting && !state.workspaceAdopting && !state.switchingProfileId
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; epoch.current += 1 }
  }, [])

  useEffect(() => {
    const request = ++epoch.current
    savingRef.current = false
    confirmingRef.current = false
    setSaving(false)
    setConfiguration(null)
    setError(null)
    if (!ready || !current()) { setLoading(false); return }
    setLoading(true)
    void connection.codexServerGoals().then(next => {
      if (request !== epoch.current || !current()) return
      setConfiguration(next)
      announceCodexGoalsConfigurationChanged(profileId, generation, next.enabled)
    }).catch(cause => {
      if (request !== epoch.current || !current()) return
      if (unsupported(cause)) setConfiguration({
        enabled: true, configurable: false,
        message: 'This connection cannot change the server-wide goal setting. Individual goal controls remain in the chat.',
      })
      else setError(message(cause))
    }).finally(() => {
      if (request === epoch.current && mounted.current) setLoading(false)
    })
    return () => { epoch.current += 1 }
  }, [connection, profileId, generation, ready, reload])

  const save = async (enabled: boolean) => {
    if (!current() || savingRef.current || !configuration?.configurable) return
    savingRef.current = true
    const request = ++epoch.current
    setSaving(true)
    setError(null)
    try {
      const next = await connection.setCodexServerGoals(enabled)
      if (request !== epoch.current || !current()) return
      setConfiguration(next)
      announceCodexGoalsConfigurationChanged(profileId, generation, next.enabled)
    } catch (cause) {
      if (request === epoch.current && current()) setError(message(cause))
    } finally {
      if (request === epoch.current) {
        savingRef.current = false
        if (mounted.current) setSaving(false)
      }
    }
  }

  const change = (enabled: boolean) => {
    if (!current() || savingRef.current || confirmingRef.current || !configuration?.configurable) return
    if (enabled) { void save(true); return }
    confirmingRef.current = true
    const request = epoch.current
    Alert.alert('Disable goals on this server?', 'This pauses existing goals across all chats and disables automatic goal continuation.', [
      { text: 'Cancel', style: 'cancel', onPress: () => { confirmingRef.current = false } },
      { text: 'Disable goals', style: 'destructive', onPress: () => {
        confirmingRef.current = false
        if (request === epoch.current) void save(false)
      } },
    ], { cancelable: true, onDismiss: () => { confirmingRef.current = false } })
  }

  const detail = !ready ? 'Connect to view the server-wide goal setting.'
    : error ?? (configuration?.configurable === false ? configuration.message
      : configuration?.enabled === false ? 'Disabled server-wide. Enable goals here, then resume a paused goal in its chat.'
        : 'Allow persistent goals on this server. Pause or resume each goal from its chat.')
  return <View testID="codex-server-goals" style={[styles.card, { backgroundColor: colors.raised, borderColor: colors.border }]}>
    <View style={styles.header}>
      <Goal size={18} color={colors.blue} />
      <Text style={[styles.title, { color: colors.text }]}>Persistent Codex goals</Text>
      {loading ? <ActivityIndicator accessibilityLabel="Loading goal setting" color={colors.blue} />
        : <Switch testID="codex-server-goals-toggle" accessibilityLabel="Allow persistent Codex goals on this server"
          disabled={!ready || saving || !configuration?.configurable} value={configuration?.enabled ?? false} onValueChange={change} />}
    </View>
    <Text accessibilityRole={error ? 'alert' : undefined} style={[styles.detail, { color: error ? colors.red : colors.muted }]}>{saving ? 'Saving goal setting…' : detail}</Text>
    {error ? <IconButton testID="codex-server-goals-retry" label="Retry goal setting" icon={RefreshCw} disabled={saving || loading} onPress={() => setReload(value => value + 1)} /> : null}
  </View>
}

function unsupported(cause: unknown): boolean {
  return cause instanceof ServerError && [403, 404, 405, 501].includes(cause.status)
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700' },
  detail: { fontSize: 12, lineHeight: 18 },
})
