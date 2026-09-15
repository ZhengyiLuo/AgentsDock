import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { client, useAppStore } from '../store/useAppStore'
import { localSessionImportCapability, localSessionImportKey, localSessionImportListLimit, parseBulkImportSessionResultsResponse } from '../lib/local-session-import'
import type { BulkImportSessionResult, LocalSessionCandidate, Session } from '../types'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { SheetCloseButton } from './ui'
import { dismissAppKeyboard } from '../lib/app-keyboard'

type ImportState = ReturnType<typeof useAppStore.getState>
export function importChatScopeKey(state: ImportState): string {
  return JSON.stringify([state.activeProfileId, state.profileGeneration, state.selectedSessionId,
    state.connected, state.connecting, state.switchingProfileId, state.workspaceAdopting,
    client.isValidated, client.validationRevision, state.health?.server_identity, state.health?.server_instance_id,
    Boolean(localSessionImportCapability(state.health))])
}
export function importChatAvailable(state: ImportState): boolean {
  return Boolean(state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting
    && client.isValidated && localSessionImportCapability(state.health))
}
export function existingProviderChats(sessions: readonly Session[], candidate: LocalSessionCandidate): Session[] {
  return sessions.filter(session => session.backend === candidate.backend && (
    session.session_id === candidate.provider_session_id
    || (candidate.backend === 'codex' ? session.codex_thread_id : session.claude_session_id) === candidate.provider_session_id
  ))
}

/** A fresh mounted scope owns every request; closing or reconnecting retires its callbacks. */
export function ImportChatDialog({ visible, onClose, onOpened }: { visible: boolean; onClose(): void; onOpened(): void }) {
  const scopeKey = useAppStore(importChatScopeKey)
  return visible ? <ImportChatContent key={scopeKey} scopeKey={scopeKey} onClose={onClose} onOpened={onOpened} /> : null
}

function ImportChatContent({ scopeKey, onClose, onOpened }: { scopeKey: string; onClose(): void; onOpened(): void }) {
  const colors = usePalette(), connection = client
  const sessions = useAppStore(state => state.sessions)
  const available = useAppStore(importChatAvailable)
  const generation = useAppStore(state => state.profileGeneration)
  const [candidates, setCandidates] = useState<LocalSessionCandidate[]>([])
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<LocalSessionCandidate | null>(null)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [receipt, setReceipt] = useState<BulkImportSessionResult | null>(null)
  const [freshSessions, setFreshSessions] = useState<Session[] | null>(null)
  const live = useRef(true), request = useRef(0), operation = useRef<symbol | null>(null)
  const selectedRef = useRef<string | null>(null)
  const selectedCandidate = useRef<LocalSessionCandidate | null>(null)
  const acceptedReceipt = useRef<BulkImportSessionResult | null>(null)
  const receipts = useRef(new Map<string, BulkImportSessionResult>())
  const current = () => live.current && client === connection && importChatScopeKey(useAppStore.getState()) === scopeKey && importChatAvailable(useAppStore.getState())
  const close = () => { live.current = false; request.current++; onClose() }
  const load = async () => {
    if (!current() || operation.current) return
    const capability = localSessionImportCapability(useAppStore.getState().health)
    if (!capability) return
    const epoch = ++request.current
    setLoading(true); setError('')
    try {
      const result = await connection.listLocalSessions(localSessionImportListLimit(capability))
      if (!current() || request.current !== epoch) return
      setCandidates(result)
      const refreshedSelection = result.find(value => localSessionImportKey(value.backend, value.provider_session_id) === selectedRef.current)
      if (refreshedSelection) { selectedCandidate.current = refreshedSelection; setSelected(refreshedSelection) }
      if (selectedRef.current && !result.some(value => localSessionImportKey(value.backend, value.provider_session_id) === selectedRef.current)) {
        selectedRef.current = null; selectedCandidate.current = null; acceptedReceipt.current = null; setSelected(null); setReceipt(null)
      }
    } catch (cause) {
      if (current() && request.current === epoch) setError(cause instanceof Error ? cause.message : 'Could not load provider chats.')
    } finally {
      if (current() && request.current === epoch) setLoading(false)
    }
  }
  useEffect(() => {
    live.current = true
    void load()
    return () => { live.current = false; request.current++; operation.current = null }
  }, [])
  const choose = (candidate: LocalSessionCandidate) => {
    if (!current() || operation.current || loading) return
    selectedRef.current = localSessionImportKey(candidate.backend, candidate.provider_session_id)
    selectedCandidate.current = candidate; acceptedReceipt.current = receipts.current.get(selectedRef.current) ?? null
    setSelected(candidate); setReceipt(acceptedReceipt.current); setError(''); dismissAppKeyboard()
  }
  const actOnCandidate = async (kind: 'import' | 'open', targetId?: string) => {
    if (!selected || !current() || operation.current || loading) return
    const key = localSessionImportKey(selected.backend, selected.provider_session_id)
    if (selectedRef.current !== key || selectedCandidate.current !== selected || !candidates.some(value => localSessionImportKey(value.backend, value.provider_session_id) === key)) return
    // An accepted receipt must never repeat the import, even if refreshing the chat list failed.
    if (kind === 'import' && acceptedReceipt.current?.ok) return
    const token = Symbol(); operation.current = token; setBusy(true); setError('')
    dismissAppKeyboard()
    const owns = () => current() && operation.current === token && selectedRef.current === key && selectedCandidate.current === selected
    try {
      // Refreshing the store can swallow transport failures; require this exact successful
      // read before deciding that an existing provider chat is absent.
      const latest = await connection.sessions()
      if (!owns()) return
      setFreshSessions(latest)
      const matches = existingProviderChats(latest, selected)
      if (kind === 'import') {
        if (matches.length) { setError('This provider chat is already linked. Choose an existing chat below.'); return }
        const items = [{ provider_session_id: selected.provider_session_id, backend: selected.backend, cwd: selected.cwd }]
        const result = parseBulkImportSessionResultsResponse({ results: await connection.bulkImportSessions(items) }, items)[0]
        if (!owns()) return
        if (result.ok) receipts.current.set(key, result)
        acceptedReceipt.current = result; setReceipt(result)
        if (!result.ok) setError(result.error || result.code || 'This chat was not imported.')
        return
      }
      const acceptedTarget = acceptedReceipt.current?.ok && acceptedReceipt.current.session_id === targetId
      if (!targetId || !(acceptedTarget ? latest.some(value => value.id === targetId && value.backend === selected.backend) : matches.some(value => value.id === targetId))) {
        setError('That chat is no longer available. Reload the list before opening it.'); return
      }
      await useAppStore.getState().refreshSessions(generation)
      if (!owns()) return
      if (!useAppStore.getState().sessions.some(value => value.id === targetId)) {
        setError(useAppStore.getState().error || 'The chat list has not refreshed yet. Retry Open; this will not import again.'); return
      }
      // selectSession publishes the selected ID synchronously. Retire this dialog before
      // its own selection changes the scope; no timeline message is sent by this action.
      const selection = useAppStore.getState().selectSession(targetId, generation)
      if (client === connection && useAppStore.getState().selectedSessionId === targetId) {
        live.current = false; onOpened()
      }
      await selection
    } catch (cause) {
      if (owns()) setError(cause instanceof Error ? cause.message : 'Could not complete this import action.')
    } finally {
      if (operation.current === token) { operation.current = null; if (current()) setBusy(false) }
    }
  }
  const filter = query.trim().toLocaleLowerCase()
  const filtered = candidates.filter(value => [value.label, value.backend, value.provider_session_id, value.cwd].some(field => field?.toLocaleLowerCase().includes(filter)))
  const matches = selected ? existingProviderChats(freshSessions ?? sessions, selected) : []
  const disabled = busy || loading || !available
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView testID="import-chat-dialog" style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
      <KeyboardAvoidingView testID="import-chat-keyboard-safe" behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheet}>
      <View style={styles.header}><Text style={[styles.title, { color: colors.text }]}>Import chat</Text><SheetCloseButton label="Close import chat" onPress={close} /></View>
      <Text style={{ color: colors.muted, fontSize: 13 }}>Browse Codex and Claude history on this server. Importing does not send a message.</Text>
      {!available ? <Text testID="import-chat-unavailable" accessibilityRole="alert" style={{ color: colors.orange }}>Reconnect to an AgentsServer with local session import support.</Text> : <>
        <View style={styles.header}><TextInput testID="import-chat-filter" accessibilityLabel="Filter provider chats" placeholder="Filter by title, provider, ID or folder" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} editable={!busy} autoCapitalize="none" autoCorrect={false} style={[styles.filter, { color: colors.text, borderColor: colors.border }]} /><Pressable testID="import-chat-reload" accessibilityRole="button" accessibilityLabel="Reload provider chats" disabled={disabled} onPress={() => void load()} style={styles.button}><Text style={{ color: colors.blue }}>Reload</Text></Pressable></View>
        {loading || busy ? <ActivityIndicator testID="import-chat-loading" color={colors.blue} /> : null}
        <ScrollView testID="import-chat-list" style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {!loading && !candidates.length ? <Text style={[styles.message, { color: colors.muted }]}>No local provider chats found.</Text> : !filtered.length ? <Text style={[styles.message, { color: colors.muted }]}>No matching provider chats.</Text> : null}
          {filtered.map(candidate => { const key = localSessionImportKey(candidate.backend, candidate.provider_session_id); const chosen = selectedRef.current === key; return <Pressable key={key} testID={`import-chat-candidate-${candidate.backend}-${candidate.provider_session_id}`} accessibilityRole="button" accessibilityLabel={`${candidate.backend}: ${candidate.label}`} accessibilityState={{ selected: chosen, disabled }} disabled={disabled} onPress={() => choose(candidate)} style={[styles.candidate, { borderColor: chosen ? colors.blue : colors.border, backgroundColor: chosen ? colors.raised : colors.surface }]}><Text numberOfLines={2} style={{ color: colors.text }}>{candidate.label}</Text><Text numberOfLines={2} style={{ color: colors.muted, fontSize: 11 }}>{candidate.backend} · {candidate.provider_session_id}{candidate.cwd ? `\n${candidate.cwd}` : ''}</Text></Pressable> })}
        </ScrollView>
        <ScrollView testID="import-chat-actions" style={styles.actions} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {selected ? <Text testID="import-chat-selected" numberOfLines={2} style={{ color: colors.text, fontSize: 13 }}>{selected.backend}: {selected.label}</Text> : null}
          {error ? <Text testID="import-chat-error" accessibilityRole="alert" selectable style={[styles.message, { color: colors.red }]}>{error}</Text> : null}
          {receipt?.ok ? <><Text testID="import-chat-receipt" accessibilityLiveRegion="polite" style={[styles.message, { color: colors.green }]}>Imported {receipt.imported} history item{receipt.imported === 1 ? '' : 's'}. No message sent.</Text><Pressable testID="import-chat-open-imported" accessibilityRole="button" disabled={disabled} onPress={() => void actOnCandidate('open', receipt.session_id!)} style={[styles.button, { backgroundColor: colors.raised }]}><Text style={{ color: colors.blue }}>Open imported chat</Text></Pressable></> : selected ? matches.length ? <><Text style={[styles.message, { color: colors.muted }]}>{matches.length > 1 ? 'Several chats use this provider ID. Choose which one to open.' : 'This provider chat is already linked.'}</Text>{matches.map(session => <Pressable key={session.id} testID={`import-chat-open-${session.id}`} accessibilityRole="button" accessibilityLabel={`Open existing chat ${session.title}`} disabled={disabled} onPress={() => void actOnCandidate('open', session.id)} style={[styles.candidate, { borderColor: colors.border }]}><Text numberOfLines={2} style={{ color: colors.blue }}>Open {session.title}</Text><Text numberOfLines={2} style={{ color: colors.muted, fontSize: 11 }}>{session.id}{session.cwd ? ` · ${session.cwd}` : ''}</Text></Pressable>)}</> : <Pressable testID="import-chat-import" accessibilityRole="button" accessibilityLabel="Import selected provider chat" accessibilityState={{ busy, disabled }} disabled={disabled} onPress={() => void actOnCandidate('import')} style={[styles.button, { backgroundColor: colors.blue, opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: 'white' }}>{busy ? 'Importing…' : 'Import selected chat'}</Text></Pressable> : <Text style={[styles.message, { color: colors.muted }]}>Select a provider chat to import or open it.</Text>}
        </ScrollView>
      </>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}
const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 14, gap: 10 }, header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  title: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '600' }, filter: { flex: 1, minWidth: 0, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 8 },
  list: { flex: 1, minHeight: 44, maxHeight: 440 }, actions: { flexGrow: 0, flexShrink: 1, maxHeight: 200 },
  candidate: { minHeight: 48, padding: 10, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginBottom: 6 },
  button: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingHorizontal: 10 },
  message: { paddingVertical: 8, fontSize: 13 },
})
