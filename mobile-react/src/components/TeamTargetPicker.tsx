import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Mail, Search } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import { loadTeamMentionCandidates, teamAllServersAliasAvailable, teamBulletinAliasAvailable, teamMessagesAvailable, type TeamMentionCandidate } from '../lib/team-references'
import { teamNetworkProxyRoute } from '../lib/team-network'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { SheetCloseButton } from './ui'

export function TeamTargetPicker({ visible, width, query, sourceSessionId, referenceLimitReached, onQueryChange, onSelect, onClose, onDidDismiss }: {
  visible: boolean
  width: number
  query: string
  sourceSessionId: string
  referenceLimitReached: boolean
  onQueryChange: (query: string) => void
  onSelect: (candidate: TeamMentionCandidate) => boolean
  onClose: () => void
  onDidDismiss: () => void
}) {
  const colors = usePalette()
  const health = useAppStore(state => state.health)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switching = useAppStore(state => Boolean(state.switchingProfileId) || state.workspaceAdopting)
  const [candidates, setCandidates] = useState<TeamMentionCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const search = useRef<TextInput>(null)
  const selectionCurrent = useRef<(() => boolean) | null>(null)
  const currentCandidates = useRef<TeamMentionCandidate[]>([])
  const selected = useRef(false)
  const route = teamNetworkProxyRoute(health)
  const connection = client
  const validationRevision = connection.validationRevision
  const available = teamMessagesAvailable(health)
  const bulletinAvailable = teamBulletinAliasAvailable(health)
  const allServersAvailable = teamAllServersAliasAvailable(health)
  const routeKey = `${route?.basePath ?? ''}:${route?.sessionPath ?? ''}:${health?.server_identity ?? ''}:${health?.server_instance_id ?? ''}:${health?.capabilities?.team_hub_v1?.hub_id ?? ''}`

  useEffect(() => {
    let live = true
    selected.current = false
    selectionCurrent.current = null
    currentCandidates.current = []
    setCandidates([])
    setError('')
    setLoading(false)
    if (!visible) return
    if (!connected || connecting || switching || !client.isValidated) {
      setError('Connect to the active server to choose a Team Network recipient.')
      return
    }
    if (!health || !available || !route) {
      setError('This server does not have an available Team Network connection for @@ messages.')
      return
    }
    const current = () => {
      const state = useAppStore.getState()
      const currentRoute = teamNetworkProxyRoute(state.health)
      return live && client === connection && connection.isValidated && !connection.isDisposed
        && connection.validationRevision === validationRevision
        && state.activeProfileId === profileId && state.profileGeneration === generation
        && state.selectedSessionId === sourceSessionId && state.connected && !state.connecting
        && !state.switchingProfileId && !state.workspaceAdopting && teamMessagesAvailable(state.health)
        && teamBulletinAliasAvailable(state.health) === bulletinAvailable
        && teamAllServersAliasAvailable(state.health) === allServersAvailable
        && state.health?.server_identity === health.server_identity
        && state.health?.server_instance_id === health.server_instance_id
        && state.health?.capabilities?.team_hub_v1?.hub_id === health.capabilities?.team_hub_v1?.hub_id
        && currentRoute?.basePath === route.basePath && currentRoute?.sessionPath === route.sessionPath
    }
    selectionCurrent.current = current
    setLoading(true)
    void loadTeamMentionCandidates(connection, health, current).then(values => {
      if (current()) { currentCandidates.current = values; setCandidates(values) }
    }).catch(reason => {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false; selectionCurrent.current = null; currentCandidates.current = [] }
  }, [visible, profileId, generation, sourceSessionId, connected, connecting, switching, available, bulletinAvailable, allServersAvailable, routeKey, connection, validationRevision, retry])

  const needle = query.trim().toLocaleLowerCase()
  const targets = candidates.filter(candidate => !needle || [candidate.label, candidate.teamName, candidate.target.target_id, candidate.code ?? ''].some(value => value.toLocaleLowerCase().includes(needle)))
  const choose = (candidate: TeamMentionCandidate) => {
    if (selected.current || loading || error || referenceLimitReached || !selectionCurrent.current?.()) return
    if (!currentCandidates.current.includes(candidate)) return
    selected.current = onSelect(candidate)
  }
  return <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? width >= 720 ? 'formSheet' : 'pageSheet' : 'fullScreen'} allowSwipeDismissal onShow={() => search.current?.focus()} onRequestClose={onClose} onDismiss={onDidDismiss}>
    {visible ? <SafeAreaView edges={Platform.OS === 'ios' ? ['bottom'] : ['top', 'bottom']} style={[styles.safe, { backgroundColor: colors.background }]} onAccessibilityEscape={onClose}>
      <View style={[styles.header, { borderColor: colors.border }]}><View style={styles.heading}><Text style={[styles.title, { color: colors.text }]}>Team Network recipient</Text><Text style={[styles.subtitle, { color: colors.muted }]}>Choose a server inbox{bulletinAvailable || allServersAvailable ? ', Bulletin, or supported Team broadcast' : ''} for this agent to contact.</Text></View><SheetCloseButton onPress={onClose} label="Close Team Network recipient picker" testID="team-target-picker-close" /></View>
      <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}><Search size={17} color={colors.muted} /><TextInput ref={search} testID="team-target-search" accessibilityLabel="Search Team Network recipients" value={query} onChangeText={onQueryChange} placeholder="Search servers" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text }]} autoCorrect={false} returnKeyType="search" onSubmitEditing={dismissAppKeyboard} /></View>
      {loading ? <View style={styles.notice} testID="team-target-loading"><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Loading recipients…</Text></View> : null}
      {error ? <View style={styles.notice} accessibilityRole="alert"><Text testID="team-target-error" style={{ color: colors.red }}>{error}</Text><Pressable accessibilityRole="button" testID="team-target-retry" onPress={() => { selectionCurrent.current = null; setCandidates([]); setRetry(value => value + 1) }} style={styles.retry}><Text style={{ color: colors.blue }}>Retry</Text></Pressable></View> : null}
      {referenceLimitReached ? <Text accessibilityRole="alert" style={[styles.notice, { color: colors.red }]}>Remove a recipient before adding another.</Text> : null}
      <FlatList testID="team-target-list" data={loading || error ? [] : targets} keyExtractor={candidate => candidate.id} keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag" onScrollBeginDrag={dismissAppKeyboard} contentContainerStyle={styles.list} ListEmptyComponent={!loading && !error ? <View style={{ gap: 8 }}><Text style={{ color: colors.muted }}>No matching recipients. Try another name or refresh Team Network.</Text><Pressable testID="team-target-refresh" accessibilityRole="button" accessibilityLabel="Refresh Team Network recipients" onPress={() => { selectionCurrent.current = null; setCandidates([]); setRetry(value => value + 1) }} style={styles.retry}><Text style={{ color: colors.blue }}>Refresh</Text></Pressable></View> : null} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Reference ${item.label} in ${item.teamName}`} accessibilityState={{ disabled: referenceLimitReached }} disabled={referenceLimitReached} onPress={() => choose(item)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.raised : colors.surface, borderColor: colors.border, opacity: referenceLimitReached ? 0.45 : 1 }]}><Mail size={22} color={colors.blue} /><View style={styles.heading}><Text style={[styles.name, { color: colors.text }]}>{item.label}</Text><Text style={[styles.subtitle, { color: colors.muted }]}>{item.teamName} · {item.target.recipient_kind === 'all' ? 'Bulletin' : item.target.recipient_kind === 'all_servers' ? 'All server inboxes' : 'Server inbox'}</Text>{item.hint ? <Text style={[styles.subtitle, { color: colors.muted }]}>{item.hint}</Text> : null}{item.code ? <Text style={[styles.subtitle, { color: colors.blue }]}>{item.code}</Text> : null}</View></Pressable>} />
    </SafeAreaView> : null}
  </Modal>
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingTop: 18 }, header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth }, heading: { flex: 1 }, title: { fontSize: 20, fontWeight: '700' }, subtitle: { fontSize: 12, marginTop: 4 }, search: { margin: 16, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }, input: { flex: 1, minHeight: 44, fontSize: 16 }, notice: { padding: 16, gap: 10 }, retry: { minHeight: 44, justifyContent: 'center' }, list: { padding: 16, gap: 10 }, row: { minHeight: 66, padding: 14, gap: 12, flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth }, name: { fontSize: 16, fontWeight: '600' },
})
