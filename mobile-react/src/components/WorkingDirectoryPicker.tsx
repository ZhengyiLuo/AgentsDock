import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ArrowUp, ChevronRight, Folder, RefreshCw } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import type { WorkingDirectoryCompletion } from '../types'
import { Text, TextInput } from './AppText'
import { SheetCloseButton } from './ui'
import { usePalette } from '../theme'
import { dismissAppKeyboard } from '../lib/app-keyboard'

/** Server-side folder discovery. Opening or navigating never changes the chat. */
export function WorkingDirectoryPicker({ visible, sessionId, initialPath, onChoose, onClose }: {
  visible: boolean; sessionId: string; initialPath: string; onChoose(path: string): Promise<boolean>; onClose(): void
}) {
  const colors = usePalette()
  const connection = client
  const scopeKey = useAppStore(state => workingDirectoryScopeKey(state, sessionId))
  const available = useAppStore(state => state.health?.capabilities?.working_directory_completion?.available === true)
  const [path, setPath] = useState(initialPath)
  const [completion, setCompletion] = useState<WorkingDirectoryCompletion | null>(null)
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const request = useRef(0), savingRef = useRef<symbol | null>(null)
  const live = useRef({ visible, scopeKey, path })
  live.current = { visible, scopeKey, path }
  const current = () => live.current.visible && live.current.scopeKey === scopeKey
    && client === connection && workingDirectoryScopeKey(useAppStore.getState(), sessionId) === scopeKey
    && workingDirectoryConnected(sessionId) && useAppStore.getState().health?.capabilities?.working_directory_completion?.available === true
  useEffect(() => {
    request.current++; savingRef.current = null
    setPath(initialPath); setCompletion(null); setError(''); setLoading(false); setSaving(false)
  }, [visible, scopeKey])
  useEffect(() => {
    const epoch = ++request.current
    if (!visible || !available || !current()) return
    setCompletion(null); setError(''); setLoading(true)
    const timer = setTimeout(() => {
      void connection.completeWorkingDirectory(path.trim(), 50).then(result => {
        if (request.current !== epoch || !current() || live.current.path !== path) return
        if (!result || result.input?.trim() !== path.trim() || typeof result.exists !== 'boolean'
          || typeof result.resolved_path !== 'string' || typeof result.base_path !== 'string'
          || !Array.isArray(result.suggestions) || result.suggestions.length > 50
          || result.suggestions.some(value => typeof value.name !== 'string' || typeof value.path !== 'string' || !value.path.trim())) {
          throw new Error('The server returned an invalid folder listing. Retry before choosing a folder.')
        }
        setCompletion(result)
      }).catch(cause => {
        if (request.current === epoch && current()) setError(cause instanceof Error ? cause.message : 'Could not load folders.')
      }).finally(() => {
        if (request.current === epoch && current()) setLoading(false)
      })
    }, 120)
    return () => { clearTimeout(timer); request.current++ }
  }, [visible, scopeKey, available, path, retry])
  const navigate = (value: string, dismissKeyboard = false) => {
    if (!current() || savingRef.current) return
    request.current++; setCompletion(null); setError(''); setPath(value)
    if (dismissKeyboard) dismissAppKeyboard()
  }
  const choose = async () => {
    if (!current() || savingRef.current || loading || !available || !completion?.exists
      || completion.input.trim() !== live.current.path.trim()) return
    const target = completion.resolved_path.trim()
    if (!target) return
    const token = Symbol(); savingRef.current = token; setSaving(true); setError('')
    dismissAppKeyboard()
    try {
      const saved = await onChoose(target)
      if (!current() || savingRef.current !== token) return
      if (saved) onClose()
      else setError(useAppStore.getState().error || 'The working directory was not saved. Retry when connected.')
    } catch (cause) {
      if (current() && savingRef.current === token) setError(cause instanceof Error ? cause.message : 'The working directory was not saved.')
    } finally {
      if (savingRef.current === token) { savingRef.current = null; if (current()) setSaving(false) }
    }
  }
  const resolved = completion?.resolved_path || completion?.base_path || ''
  const parent = parentDirectory(resolved)
  const ready = available && workingDirectoryConnected(sessionId)
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView testID="working-directory-picker" style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
      <KeyboardAvoidingView testID="working-directory-keyboard-safe" behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheet}>
      <View style={styles.header}><Text style={[styles.title, { color: colors.text }]}>Working directory</Text><SheetCloseButton label="Close folder picker" onPress={onClose} /></View>
      {!ready ? <Text testID="working-directory-unavailable" accessibilityRole="alert" style={[styles.message, { color: colors.orange }]}>{available ? 'Reconnect this server to browse folders.' : 'Folder browsing requires a newer AgentsServer.'}</Text> : <>
        <View style={styles.pathRow}>
          <Pressable testID="working-directory-parent" accessibilityRole="button" accessibilityLabel="Go to parent folder" disabled={loading || saving || !parent || parent === resolved} onPress={() => navigate(parent, true)} style={styles.icon}><ArrowUp size={18} color={colors.muted} /></Pressable>
          <TextInput testID="working-directory-path" accessibilityLabel="Folder path" value={path} editable={!saving} autoCapitalize="none" autoCorrect={false} onChangeText={navigate} onSubmitEditing={() => void choose()} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
        </View>
        {loading ? <ActivityIndicator testID="working-directory-loading" color={colors.blue} /> : null}
        {error ? <View style={styles.error}><Text testID="working-directory-error" accessibilityRole="alert" selectable style={{ flex: 1, color: colors.red }}>{error}</Text><Pressable testID="working-directory-retry" accessibilityRole="button" accessibilityLabel="Retry loading folders" onPress={() => { if (current() && !savingRef.current) setRetry(value => value + 1) }} style={styles.icon}><RefreshCw size={18} color={colors.blue} /></Pressable></View> : null}
        <ScrollView testID="working-directory-list" style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {completion?.suggestions.map(folder => <Pressable key={folder.path} testID={`working-directory-open-${folder.path}`} accessibilityRole="button" accessibilityLabel={`Open ${folder.name}`} disabled={saving} onPress={() => navigate(folder.path, true)} style={[styles.folder, { borderBottomColor: colors.border }]}><Folder size={18} color={colors.muted} /><Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: colors.text }}>{folder.name}</Text><ChevronRight size={16} color={colors.muted} /></Pressable>)}
          {!loading && !error && completion && !completion.suggestions.length ? <Text style={[styles.message, { color: colors.muted }]}>{completion.exists ? 'No folders inside this directory.' : completion.message || 'Folder not found. Edit the path or choose a suggested folder.'}</Text> : null}
          {completion?.truncated ? <Text style={[styles.message, { color: colors.muted }]}>More folders available. Refine the path to narrow this list.</Text> : null}
        </ScrollView>
        <Pressable testID="working-directory-choose" accessibilityRole="button" accessibilityLabel="Choose working directory" accessibilityState={{ busy: saving, disabled: loading || saving || !completion?.exists }} disabled={loading || saving || !completion?.exists} onPress={() => void choose()} style={[styles.choose, { backgroundColor: colors.blue, opacity: loading || saving || !completion?.exists ? 0.45 : 1 }]}><Text style={{ color: 'white' }}>{saving ? 'Saving…' : 'Choose folder'}</Text></Pressable>
      </>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}

type WorkflowState = ReturnType<typeof useAppStore.getState>
export function workingDirectoryScopeKey(state: WorkflowState, sessionId: string): string {
  return JSON.stringify([state.activeProfileId, state.profileGeneration, sessionId, state.selectedSessionId,
    state.connected, state.connecting, state.switchingProfileId, state.workspaceAdopting,
    client.isValidated, client.validationRevision, state.health?.server_identity, state.health?.server_instance_id])
}
export function workingDirectoryConnected(sessionId: string): boolean {
  const state = useAppStore.getState()
  return Boolean(state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting
    && state.selectedSessionId === sessionId && client.isValidated)
}
function parentDirectory(path: string): string {
  const clean = path.replace(/\/+$/u, '')
  const slash = clean.lastIndexOf('/')
  return slash <= 0 ? '/' : clean.slice(0, slash)
}
const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 14, gap: 10 }, header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  title: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '600' }, pathRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  icon: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, minWidth: 0, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10 },
  list: { flex: 1, maxHeight: 440 }, folder: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  message: { padding: 12, fontSize: 13 }, error: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  choose: { minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
})
