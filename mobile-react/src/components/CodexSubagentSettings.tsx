import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { ServerError, type AgentServerClient } from '../api/AgentServerClient'
import { codexControlsCapability } from '../lib/codex-controls'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { CodexSubagentsConfiguration } from '../types'
import { Text, TextInput } from './AppText'

export function CodexSubagentSettings({ visible }: { visible: boolean }) {
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const health = useAppStore(state => state.health)
  const ready = useAppStore(state => state.connected && !state.connecting && !state.workspaceAdopting && !state.switchingProfileId)
  if (!visible || !profileId || !codexControlsCapability(health)) return null
  const scope = { profileId, generation, identity: health?.server_identity, instance: health?.server_instance_id,
    validation: client.validationRevision }
  return <ScopedSettings key={JSON.stringify(scope)} connection={client} scope={scope} ready={ready} />
}

interface Scope { profileId: string; generation: number; identity?: string; instance?: string; validation: number }
function ScopedSettings({ connection, scope, ready }: { connection: AgentServerClient; scope: Scope; ready: boolean }) {
  const colors = usePalette()
  const [configuration, setConfiguration] = useState<CodexSubagentsConfiguration | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'loading' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const saving = useRef(false)
  const current = () => {
    const state = useAppStore.getState()
    return mounted.current && client === connection && connection.isValidated
      && connection.validationRevision === scope.validation
      && state.activeProfileId === scope.profileId && state.profileGeneration === scope.generation
      && state.health?.server_identity === scope.identity && state.health?.server_instance_id === scope.instance
      && Boolean(codexControlsCapability(state.health))
      && state.connected && !state.connecting && !state.workspaceAdopting && !state.switchingProfileId
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++ } }, [])
  useEffect(() => {
    const request = ++epoch.current
    saving.current = false
    setConfiguration(null)
    setValue('')
    setError(null)
    if (!ready || !current()) { setBusy(null); return }
    setBusy('loading')
    void connection.codexServerSubagents().then(next => {
      if (!current() || request !== epoch.current) return
      setConfiguration(next)
      setValue(next.max_concurrent_threads_per_session == null ? '' : String(next.max_concurrent_threads_per_session))
    }).catch(cause => { if (current() && request === epoch.current) setError(settingsError(cause)) })
      .finally(() => { if (mounted.current && request === epoch.current) setBusy(null) })
    return () => { epoch.current++ }
  }, [connection, ready, reload])

  const save = async (next: number | null) => {
    if (!current() || saving.current || busy || !configuration?.configurable) return
    saving.current = true
    const request = ++epoch.current
    setBusy('saving')
    setError(null)
    try {
      const confirmed = await connection.setCodexServerSubagents(next)
      if (!current() || request !== epoch.current) return
      setConfiguration(confirmed)
      setValue(confirmed.max_concurrent_threads_per_session == null ? '' : String(confirmed.max_concurrent_threads_per_session))
    } catch (cause) { if (current() && request === epoch.current) setError(settingsError(cause)) }
    finally { if (mounted.current && request === epoch.current) { saving.current = false; setBusy(null) } }
  }
  const parsed = value.trim() === '' ? null : /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  const invalid = parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 1)
  const disabled = !ready || Boolean(busy) || !configuration?.configurable
  const action = (id: string, label: string, onPress: () => void, blocked = false) => <Pressable testID={id}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || blocked }}
    disabled={disabled || blocked} onPress={onPress}
    style={[styles.button, { borderColor: colors.border, opacity: disabled || blocked ? 0.4 : 1 }]}>
    <Text style={{ color: colors.blue, fontWeight: '600' }}>{label}</Text>
  </Pressable>
  return <View testID="codex-server-subagents" style={[styles.card, { backgroundColor: colors.raised, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.text }]}>Codex subagent concurrency</Text>
    <Text style={[styles.detail, { color: colors.muted }]}>Maximum concurrent native subagent threads per chat. Applies to new or reloaded threads; existing chat overrides take precedence.</Text>
    <TextInput testID="codex-subagents-limit" accessibilityLabel="Concurrent subagent limit" keyboardType="number-pad"
      editable={!disabled} value={value} onChangeText={setValue} placeholder="Codex default" placeholderTextColor={colors.muted}
      style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
    {invalid ? <Text accessibilityRole="alert" style={{ color: colors.red }}>Enter a positive whole number, or leave blank for Codex default.</Text> : null}
    <View style={styles.row}>
      {action('codex-subagents-save', 'Save limit', () => { if (!invalid) void save(parsed) }, invalid || parsed === configuration?.max_concurrent_threads_per_session)}
      {action('codex-subagents-reset', 'Use Codex default', () => { void save(null) }, configuration?.max_concurrent_threads_per_session === null)}
    </View>
    {busy ? <View style={styles.row}><ActivityIndicator accessibilityLabel={busy === 'loading' ? 'Loading subagent limit' : 'Saving subagent limit'} color={colors.blue} /><Text style={{ color: colors.muted }}>{busy === 'loading' ? 'Loading…' : 'Saving…'}</Text></View> : null}
    <Text accessibilityRole={error ? 'alert' : undefined} style={[styles.detail, { color: error ? colors.red : colors.muted }]}>{!ready ? 'Connect to view this server setting.' : error ?? (configuration?.configurable === false ? configuration.message : 'Codex default clears the server override. It does not mean unlimited.')}</Text>
    {error ? <Pressable testID="codex-subagents-retry" accessibilityRole="button" accessibilityLabel="Retry subagent setting"
      disabled={!ready || Boolean(busy)} onPress={() => { if (current()) setReload(number => number + 1) }} style={styles.button}>
      <Text style={{ color: colors.blue }}>Retry</Text>
    </Pressable> : null}
  </View>
}

function settingsError(cause: unknown): string {
  if (cause instanceof ServerError) {
    if ([404, 405, 501].includes(cause.status)) return 'Update AgentsServer to configure native Codex subagents.'
    if ([401, 403].includes(cause.status)) return 'This connection is not authorized to change server-wide subagent settings.'
  }
  return cause instanceof Error ? cause.message : String(cause)
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, gap: 8 },
  title: { fontSize: 14, fontWeight: '700' }, detail: { fontSize: 12, lineHeight: 18 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 10, minHeight: 44 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
})
