import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, ChevronDown, Shield } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import {
  CLAUDE_PERMISSION_MODE_HELP,
  CLAUDE_PERMISSION_MODE_LABELS,
  CLAUDE_PERMISSION_MODES,
} from '../lib/claude-permission-copy'
import {
  claudePermissionScopeKey,
  queueClaudePermissionUpdate,
  type ClaudePermissionUpdateScope,
} from '../lib/claude-permission-updates'
import { COMPOSER_PERMISSION_FACE_SIZE, COMPOSER_TOOLBAR_TOUCH_SIZE } from '../lib/composer-toolbar-layout'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { ClaudePermissionMode, ClaudeRuntimePolicy, Session } from '../types'
import { Text } from './AppText'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { SheetCloseButton } from './ui'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function ClaudePermissionMenu({ sessionId, compact }: { sessionId: string; compact: boolean }) {
  const colors = usePalette()
  const { runtime, supported, mutating } = useClaudeRuntime()
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const running = useAppStore(state => state.activeSessionIds.has(sessionId))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]))
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [open, setOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<ClaudePermissionMode>(() => permissionMode(session, runtime?.policy))
  const modeRef = useRef(mode)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const scope: ClaudePermissionUpdateScope = {
    profileId: activeProfileId ?? '',
    profileGeneration,
    sessionId,
  }
  const scopeKey = claudePermissionScopeKey(scope)
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const featureSupported = runtime?.features?.permission_mode_control === true
  const supportedModes = (runtime?.permission_modes ?? []).filter(candidate => CLAUDE_PERMISSION_MODES.includes(candidate))
  const modesResolved = supportedModes.length > 0
  const policyResolved = (session?.claude_permission_mode ?? runtime?.policy?.permission_mode) != null
  const modeSupported = supportedModes.includes(mode)
  const available = Boolean(session && activeProfileId && supported && featureSupported && modesResolved && policyResolved && modeSupported)
  const turnActive = running || runtime?.status?.type === 'active'
  const controlsDisabled = turnActive || admitting || mutating || saveState === 'saving'
  const label = CLAUDE_PERMISSION_MODE_LABELS[mode]
  const accessibleLabel = !supported
    ? 'Claude permissions unavailable; update AgentsServer and use Claude Agent SDK'
    : !runtime || !policyResolved
      ? 'Claude permissions loading'
      : !featureSupported || !modesResolved || !modeSupported
        ? 'Claude permission modes unavailable; update AgentsServer'
        : `Claude permissions: ${label}`

  useEffect(() => {
    saveEpoch.current += 1
    setOpen(false)
    setSaveState('idle')
    setSaveError(null)
    const next = permissionMode(session, runtime?.policy)
    modeRef.current = next
    setMode(next)
  }, [scopeKey])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saveEpoch.current += 1
    }
  }, [])

  useEffect(() => {
    if (saveState === 'saving') return
    const next = permissionMode(session, runtime?.policy)
    modeRef.current = next
    setMode(next)
  }, [runtime?.policy?.permission_mode, saveState, session?.claude_permission_mode])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = setTimeout(() => setSaveState('idle'), 1_400)
    return () => clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (available || !open) return
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [available, open])

  if (!session || session.backend !== 'claude') return null

  const close = () => {
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }

  const apply = (next: ClaudePermissionMode) => {
    if (!available || controlsDisabled || !activeProfileId || next === modeRef.current) return
    const expectedScope = { ...scope, profileId: activeProfileId }
    const expectedScopeKey = claudePermissionScopeKey(expectedScope)
    const epoch = ++saveEpoch.current
    modeRef.current = next
    setMode(next)
    setSaveState('saving')
    setSaveError(null)
    void queueClaudePermissionUpdate(expectedScope, async () => {
      const saved = await useAppStore.getState().updateSession(
        session.id,
        { claude_permission_mode: next },
        profileGeneration,
      )
      const current = useAppStore.getState()
      const updated = current.sessions.find(candidate => candidate.id === session.id)
      if (!saved || updated?.claude_permission_mode !== next) {
        throw new Error(current.error || 'Could not update Claude permissions.')
      }
    }).then(() => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      setSaveState('saved')
    }).catch(cause => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
      const fallback = permissionMode(updated ?? session, runtime?.policy)
      modeRef.current = fallback
      setMode(fallback)
      setSaveState('error')
      setSaveError(errorMessage(cause))
    })
  }

  return <>
    <Pressable
      testID="claude-permissions"
      accessibilityRole="button"
      accessibilityLabel={accessibleLabel}
      accessibilityState={{ disabled: !available, expanded: open }}
      disabled={!available}
      onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }}
      style={({ pressed }) => [
        styles.trigger,
        compact ? styles.triggerCompact : styles.triggerWide,
        {
          backgroundColor: compact ? 'transparent' : colors.raised,
          borderColor: compact ? 'transparent' : colors.border,
          opacity: !available ? 0.38 : pressed ? 0.64 : 1,
        },
      ]}
    >
      {compact
        ? <View style={[styles.triggerCompactFace, { backgroundColor: colors.raised }]}>
            <Shield size={16} color={colors.muted} />
            {mode === 'bypassPermissions' ? <View style={[styles.triggerWarningDot, { backgroundColor: colors.orange }]} /> : null}
          </View>
        : <>
            <Shield size={17} color={colors.muted} />
            <Text style={[styles.triggerText, { color: colors.text }]} numberOfLines={1}>{label}</Text>
            <ChevronDown size={13} color={colors.muted} />
          </>}
    </Pressable>
    {open ? <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
      <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={[styles.headerMark, { backgroundColor: colors.raised }]}><Shield size={19} color={colors.blue} /></View>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>Claude permissions</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Applies to future interactive Claude SDK turns.</Text>
          </View>
          <View accessibilityLiveRegion="polite" style={styles.saveStatus}>
            {saveState === 'saving' ? <ActivityIndicator size="small" color={colors.blue} /> : null}
            <Text style={[styles.saveStatusText, { color: saveState === 'error' ? colors.red : colors.muted }]}>
              {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
            </Text>
          </View>
          <SheetCloseButton label="Close Claude permissions" testID="claude-permissions-close" onPress={close} />
        </View>
        <ScrollView
          testID="claude-permissions-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          <Text style={[styles.label, { color: colors.muted }]}>Permission mode</Text>
          <View style={[styles.options, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {supportedModes.map(value => <Pressable
              key={value}
              testID={`claude-permission-option-${value}`}
              accessibilityRole="button"
              accessibilityLabel={CLAUDE_PERMISSION_MODE_LABELS[value]}
              accessibilityHint={CLAUDE_PERMISSION_MODE_HELP[value]}
              accessibilityState={{ disabled: controlsDisabled, selected: value === mode }}
              disabled={controlsDisabled}
              onPress={() => { if (value !== mode) apply(value) }}
              style={({ pressed }) => [styles.option, {
                backgroundColor: value === mode ? colors.raised : 'transparent',
                opacity: controlsDisabled ? 0.48 : pressed ? 0.65 : 1,
              }]}
            >
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>{CLAUDE_PERMISSION_MODE_LABELS[value]}</Text>
                <Text style={[styles.optionHelp, { color: colors.muted }]}>{CLAUDE_PERMISSION_MODE_HELP[value]}</Text>
              </View>
              {value === mode ? <Check size={17} color={colors.blue} /> : null}
            </Pressable>)}
          </View>
          {turnActive ? <Text style={[styles.hint, { color: colors.muted }]}>Stop or wait for this Claude turn before changing access.</Text> : null}
          {saveError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{saveError}</Text> : null}
          {mode === 'bypassPermissions' ? <Text style={[styles.warning, { color: colors.orange, borderColor: colors.orange }]}>Bypass permissions is enabled for this chat. Explicit deny rules and AgentsDock hooks can still block tools.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>
}

function permissionMode(session: Session | null, runtimePolicy?: ClaudeRuntimePolicy | null): ClaudePermissionMode {
  return session?.claude_permission_mode ?? runtimePolicy?.permission_mode ?? 'default'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const styles = StyleSheet.create({
  trigger: { height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  triggerCompact: { width: COMPOSER_TOOLBAR_TOUCH_SIZE },
  triggerWide: { minWidth: COMPOSER_TOOLBAR_TOUCH_SIZE, maxWidth: 160, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9 },
  triggerCompactFace: { width: COMPOSER_PERMISSION_FACE_SIZE, height: COMPOSER_PERMISSION_FACE_SIZE, position: 'relative', borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  triggerWarningDot: { width: 5, height: 5, position: 'absolute', top: 3, right: 3, borderRadius: 3 },
  triggerText: { minWidth: 0, flexShrink: 1, fontSize: 10.5, fontWeight: '800' },
  sheet: { flex: 1 },
  header: { minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerMark: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '900' },
  subtitle: { marginTop: 2, fontSize: 10.5 },
  saveStatus: { minWidth: 58, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  saveStatusText: { fontSize: 10.5, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 14, paddingBottom: 44, gap: 10 },
  label: { fontSize: 10.5, fontWeight: '800' },
  options: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 5, gap: 2 },
  option: { minHeight: 58, borderRadius: 7, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 9 },
  optionCopy: { minWidth: 0, flex: 1, gap: 2 },
  optionTitle: { fontSize: 13, fontWeight: '800' },
  optionHelp: { fontSize: 10.5, lineHeight: 15 },
  hint: { fontSize: 10.5, lineHeight: 15 },
  error: { fontSize: 11, lineHeight: 16 },
  warning: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 16 },
})
