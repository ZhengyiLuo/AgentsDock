import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, ChevronDown, Shield } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import {
  CURSOR_PERMISSION_MODE_HELP,
  CURSOR_PERMISSION_MODE_LABELS,
  CURSOR_PERMISSION_MODES,
  supportedCursorPermissionModes,
} from '../lib/cursor-permission-copy'
import { cursorBackendAvailable } from '../lib/runtime-catalog'
import {
  cursorPermissionScopeKey,
  queueCursorPermissionUpdate,
  type CursorPermissionUpdateScope,
} from '../lib/cursor-permission-updates'
import { COMPOSER_PERMISSION_FACE_SIZE, COMPOSER_TOOLBAR_TOUCH_SIZE } from '../lib/composer-toolbar-layout'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { CursorPermissionMode, Session } from '../types'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function CursorPermissionMenu({ sessionId, compact }: { sessionId: string; compact: boolean }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const running = useAppStore(state => state.activeSessionIds.has(sessionId))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]))
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const [open, setOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<CursorPermissionMode>(() => permissionMode(session))
  const modeRef = useRef(mode)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const scope: CursorPermissionUpdateScope = {
    profileId: activeProfileId ?? '',
    profileGeneration,
    sessionId,
  }
  const scopeKey = cursorPermissionScopeKey(scope)
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const modes = supportedCursorPermissionModes(health?.capabilities?.cursor_backend?.permission_modes)
  const available = Boolean(session && activeProfileId && cursorBackendAvailable(health, runtime))
  const controlsDisabled = running || admitting || saveState === 'saving'
  const label = CURSOR_PERMISSION_MODE_LABELS[mode]
  const accessibleLabel = `Cursor permissions: ${label}`

  useEffect(() => {
    saveEpoch.current += 1
    setOpen(false)
    setSaveState('idle')
    setSaveError(null)
    const next = permissionMode(session)
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
    const next = permissionMode(session)
    modeRef.current = next
    setMode(next)
  }, [saveState, session?.cursor_permission_mode])

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

  if (!session || session.backend !== 'cursor') return null

  const close = () => {
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }

  const apply = (next: CursorPermissionMode) => {
    if (!available || controlsDisabled || !activeProfileId || next === modeRef.current) return
    const expectedScope = { ...scope, profileId: activeProfileId }
    const expectedScopeKey = cursorPermissionScopeKey(expectedScope)
    const epoch = ++saveEpoch.current
    modeRef.current = next
    setMode(next)
    setSaveState('saving')
    setSaveError(null)
    void queueCursorPermissionUpdate(expectedScope, async () => {
      const saved = await useAppStore.getState().updateSession(
        session.id,
        { cursor_permission_mode: next },
        profileGeneration,
      )
      const current = useAppStore.getState()
      const updated = current.sessions.find(candidate => candidate.id === session.id)
      if (!saved || updated?.cursor_permission_mode !== next) {
        throw new Error(current.error || 'Could not update Cursor permissions.')
      }
    }).then(() => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      setSaveState('saved')
    }).catch(cause => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
      const fallback = permissionMode(updated ?? session)
      modeRef.current = fallback
      setMode(fallback)
      setSaveState('error')
      setSaveError(errorMessage(cause))
    })
  }

  return <>
    <Pressable
      testID="cursor-permissions"
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
            <Text style={[styles.title, { color: colors.text }]}>Cursor permissions</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Applies to future turns in this chat.</Text>
          </View>
          <View accessibilityLiveRegion="polite" style={styles.saveStatus}>
            {saveState === 'saving' ? <ActivityIndicator size="small" color={colors.blue} /> : null}
            <Text style={[styles.saveStatusText, { color: saveState === 'error' ? colors.red : colors.muted }]}>
              {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
            </Text>
          </View>
          <SheetCloseButton label="Close Cursor permissions" testID="cursor-permissions-close" onPress={close} />
        </View>
        <ScrollView
          testID="cursor-permissions-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          <Text style={[styles.label, { color: colors.muted }]}>Permission mode</Text>
          <View style={[styles.options, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {modes.map(value => <Pressable
              key={value}
              testID={`cursor-permission-option-${value}`}
              accessibilityRole="button"
              accessibilityLabel={CURSOR_PERMISSION_MODE_LABELS[value]}
              accessibilityHint={CURSOR_PERMISSION_MODE_HELP[value]}
              accessibilityState={{ disabled: controlsDisabled, selected: value === mode }}
              disabled={controlsDisabled}
              onPress={() => { if (value !== mode) apply(value) }}
              style={({ pressed }) => [styles.option, {
                backgroundColor: value === mode ? colors.raised : 'transparent',
                opacity: controlsDisabled ? 0.48 : pressed ? 0.65 : 1,
              }]}
            >
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: colors.text }]}>{CURSOR_PERMISSION_MODE_LABELS[value]}</Text>
                <Text style={[styles.optionHelp, { color: colors.muted }]}>{CURSOR_PERMISSION_MODE_HELP[value]}</Text>
              </View>
              {value === mode ? <Check size={17} color={colors.blue} /> : null}
            </Pressable>)}
          </View>
          {running ? <Text style={[styles.hint, { color: colors.muted }]}>Stop or wait for this Cursor turn before changing access.</Text> : null}
          {saveError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{saveError}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>
}

function permissionMode(session: Session | null): CursorPermissionMode {
  const value = session?.cursor_permission_mode
  return value && CURSOR_PERMISSION_MODES.includes(value) ? value : 'default'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const styles = StyleSheet.create({
  trigger: { height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  triggerCompact: { width: COMPOSER_TOOLBAR_TOUCH_SIZE },
  triggerWide: { minWidth: COMPOSER_TOOLBAR_TOUCH_SIZE, maxWidth: 160, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9 },
  triggerCompactFace: { width: COMPOSER_PERMISSION_FACE_SIZE, height: COMPOSER_PERMISSION_FACE_SIZE, position: 'relative', borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
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
})
