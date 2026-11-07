import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, Shield } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { backendLabel } from '../lib/format'
import { optionalPermissionModes, permissionLabels, queueOptionalPermissionUpdate, type OptionalPermission } from '../lib/optional-agent-permissions'
import { client, useAppStore } from '../store/useAppStore'
import { radius, spacing, typography, usePalette } from '../theme'
import type { GeminiPermissionMode, OpenCodePermissionMode } from '../types'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

export function OptionalAgentPermissionMenu({ sessionId }: { sessionId: string }) {
  const generation = useAppStore(state => state.profileGeneration)
  const profile = useAppStore(state => state.activeProfileId)
  return <ScopedPermissionMenu key={`${profile}:${generation}:${sessionId}`} sessionId={sessionId} />
}

function ScopedPermissionMenu({ sessionId }: { sessionId: string }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(item => item.id === sessionId))
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const running = useAppStore(state => state.activeSessionIds.has(sessionId) || Boolean(state.turnAdmissionTokens[sessionId]))
  const connected = useAppStore(state => state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const [runtimeModes, setRuntimeModes] = useState<GeminiPermissionMode[] | null>(null)
  const [confirm, setConfirm] = useState<OptionalPermission | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!open || !connected || session?.backend !== 'gemini') return
    let cancelled = false
    const connection = client
    const state = useAppStore.getState()
    void connection.geminiRuntime(sessionId).then(value => {
      const latest = useAppStore.getState()
      if (!cancelled && mounted.current && client === connection && state.profileGeneration === latest.profileGeneration && latest.selectedSessionId === sessionId) {
        setRuntimeModes(value.permission_modes ?? null)
      }
    }).catch(() => { /* Keep the server-advertised baseline if runtime discovery fails. */ })
    return () => { cancelled = true }
  }, [open, connected, session?.backend, sessionId])
  if (!session || (session.backend !== 'gemini' && session.backend !== 'opencode')) return null
  const backend = session.backend
  const name = backendLabel(backend)
  const field = backend === 'gemini' ? 'gemini_permission_mode' : 'opencode_permission_mode'
  const mode = session[field] ?? 'default'
  const modes = optionalPermissionModes(runtimeModes ? { ...session, gemini_permission_modes: runtimeModes } : session, health, runtime)
  const available = connected && health?.capabilities?.[`${backend}_backend`]?.available === true
    && (backend !== 'gemini' || health.capabilities.gemini_backend?.features?.permission_mode_control === true)
  const disabled = !available || busy || running
  const close = () => { setOpen(false); setConfirm(null); dismissAppKeyboard() }
  const apply = async (next: OptionalPermission) => {
    if (disabled || inFlight.current || !modes.includes(next) || next === mode) return
    const state = useAppStore.getState()
    const scope = { profileId: state.activeProfileId ?? '', profileGeneration: state.profileGeneration, sessionId }
    const current = () => {
      const s = useAppStore.getState()
      return mounted.current && s.activeProfileId === scope.profileId && s.profileGeneration === scope.profileGeneration && s.selectedSessionId === sessionId
    }
    inFlight.current = true; setBusy(true); setError(null); setConfirm(null)
    try {
      await queueOptionalPermissionUpdate(scope, async () => {
        if (!current()) throw new Error('Chat changed. Try again.')
        const patch = backend === 'gemini' ? { gemini_permission_mode: next as GeminiPermissionMode } : { opencode_permission_mode: next as OpenCodePermissionMode }
        if (!await useAppStore.getState().updateSession(sessionId, patch, scope.profileGeneration)) throw new Error(useAppStore.getState().error || 'Could not update permissions.')
      })
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { inFlight.current = false; if (current()) setBusy(false) }
  }
  return <>
    <Pressable testID={`${backend}-permissions`} accessibilityRole="button" accessibilityLabel={`${name} permissions: ${permissionLabels[mode]}`} disabled={!available} onPress={() => { dismissAppKeyboard(); setOpen(true) }} style={[styles.trigger, { opacity: available ? 1 : 0.4 }]}>
      <View style={[styles.face, { backgroundColor: colors.raised }]}><Shield size={16} color={colors.muted} /></View>
    </Pressable>
    <Modal visible={open && available} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
        <View style={styles.header}><Text style={[typography.title, styles.label, { color: colors.text }]}>{name}</Text>{busy ? <ActivityIndicator /> : null}<SheetCloseButton testID={`${backend}-permissions-close`} label={`Close ${name} permissions`} onPress={close} /></View>
        <ScrollView contentContainerStyle={styles.content}>
          {backend === 'opencode' ? <Text style={[typography.caption, { color: colors.muted }]} localize>Changing permissions starts a new OpenCode context. Chat history is kept.</Text> : null}
          {modes.map(value => <Pressable key={value} testID={`${backend}-permission-option-${value}`} accessibilityRole="button" accessibilityState={{ selected: mode === value, disabled }} disabled={disabled} onPress={() => value === mode ? undefined : value === 'yolo' || value === 'full_access' ? setConfirm(value) : void apply(value)} style={[styles.row, { borderColor: colors.border, opacity: disabled ? 0.5 : 1 }]}>
            <Text style={[typography.body, styles.label, { color: colors.text }]} localize>{permissionLabels[value]}</Text>{mode === value ? <Check size={18} color={colors.blue} /> : null}
          </Pressable>)}
          {confirm ? <View accessibilityRole="alert"><Text style={[typography.body, { color: colors.text }]} localize>Allow tools to run without asking for approval?</Text>
            <View style={styles.header}><Pressable testID={`${backend}-permission-cancel`} onPress={() => setConfirm(null)} style={styles.row}><Text localize>Cancel</Text></Pressable><Pressable testID={`${backend}-permission-confirm`} disabled={disabled} onPress={() => void apply(confirm)} style={styles.row}><Text style={{ color: colors.red }} localize>Confirm</Text></Pressable></View>
          </View> : null}
          {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: colors.red }]}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>
}

const styles = StyleSheet.create({ fill: { flex: 1 }, trigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, face: { width: 30, height: 30, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, header: { minHeight: 56, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, label: { flex: 1 }, content: { padding: spacing.md, gap: spacing.sm }, row: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm } })
