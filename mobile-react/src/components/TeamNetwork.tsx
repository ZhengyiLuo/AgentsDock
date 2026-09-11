import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { ArrowLeft, Bot, BookOpen, Inbox, RadioTower, RefreshCw, Send, Server, Users, X } from 'lucide-react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentServerClient } from '../api/AgentServerClient'
import { teamNetworkIdempotencyKey, teamNetworkProxyRoute, type TeamNetworkProxyRoute } from '../lib/team-network'
import { TeamNetworkRequests, type TeamNetworkRequest } from '../lib/team-network-requests'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { MarkdownContent } from './MarkdownContent'
import { EmptyState, IconButton } from './ui'

type TeamSection = 'feed' | 'mail' | 'directory'
type MailBox = 'inbox' | 'sent'

interface Team {
  id: string
  display_name: string
  role: string
  status: string
}

interface TeamSessionResponse {
  principal?: { id: string; display_name: string; kind?: string }
  teams: Team[]
}

interface NetworkServer {
  id: string
  server_identity: string
  display_name: string
  status: string
  is_host: boolean
  owned_by_caller: boolean
}

interface NetworkAgent {
  id: string
  server_id: string
  external_agent_id: string
  backend: string
  display_name: string
  status: string
}

interface NetworkProjection {
  network: { id: string; display_name: string }
  servers: NetworkServer[]
  agents: NetworkAgent[]
}

interface TeamMember {
  principal_id: string
  role: string
  status: string
  display_name: string
  email?: string | null
}

interface TeamMessageSummary {
  id: string
  sequence: number
  kind: 'message' | 'skill' | string
  title: string | null
  preview: string
  body_format: 'plain' | 'markdown'
  sender: { kind: string; id: string; display_name: string }
  recipients: Array<{ kind: string; id?: string | null; display_name: string; state: string }>
  delivery?: { kind: string; id?: string | null; display_name: string; state: string } | null
  attachments?: Array<{ id: string; file_name: string; media_type: string; byte_size: number }>
  created_at: string
}

interface TeamMessage extends Omit<TeamMessageSummary, 'preview'> {
  body: string
  preview?: string
}

interface TeamNetworkScope {
  connection: AgentServerClient
  profileId: string | null
  profileGeneration: number
  validationRevision: number
  serverIdentity: string | null
  serverInstanceId: string | null
  route: TeamNetworkProxyRoute
}

function captureScope(route: TeamNetworkProxyRoute): TeamNetworkScope {
  const state = useAppStore.getState()
  return {
    connection: client,
    profileId: state.activeProfileId,
    profileGeneration: state.profileGeneration,
    validationRevision: client.validationRevision,
    serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
    serverInstanceId: state.health?.server_instance_id?.trim() || null,
    route,
  }
}

function scopeCurrent(scope: TeamNetworkScope): boolean {
  const state = useAppStore.getState()
  const currentRoute = teamNetworkProxyRoute(state.health)
  return client === scope.connection
    && scope.connection.validationRevision === scope.validationRevision
    && !scope.connection.isDisposed
    && scope.connection.isValidated
    && state.activeProfileId === scope.profileId
    && state.profileGeneration === scope.profileGeneration
    && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === scope.serverIdentity
    && (state.health?.server_instance_id?.trim() || null) === scope.serverInstanceId
    && currentRoute?.basePath === scope.route.basePath
    && currentRoute.sessionPath === scope.route.sessionPath
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
}

function rows<T>(value: unknown, key: string): T[] {
  if (!value || typeof value !== 'object') return []
  const candidate = (value as Record<string, unknown>)[key]
  return Array.isArray(candidate) ? candidate as T[] : []
}

function messagePreview(message: TeamMessageSummary): string {
  return message.preview?.trim() || message.title?.trim() || 'Open message'
}

export function TeamNetwork({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const health = useAppStore(state => state.health)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const activeProfile = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId) ?? null)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const route = teamNetworkProxyRoute(health)
  const [section, setSection] = useState<TeamSection>('mail')
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState('')
  const [projection, setProjection] = useState<NetworkProjection | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [feed, setFeed] = useState<TeamMessageSummary[]>([])
  const [mail, setMail] = useState<TeamMessageSummary[]>([])
  const [mailBox, setMailBox] = useState<MailBox>('inbox')
  const [selectedMessage, setSelectedMessage] = useState<TeamMessage | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const draftsByTeam = useRef(new Map<string, string>())
  const [posting, setPosting] = useState(false)
  const [agentForm, setAgentForm] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [agentName, setAgentName] = useState('')
  const [agentBackend, setAgentBackend] = useState<'codex' | 'claude' | 'other'>('codex')
  const [agentBusy, setAgentBusy] = useState(false)
  const requests = useRef(new TeamNetworkRequests())
  const postKey = useRef(teamNetworkIdempotencyKey())
  const postFingerprint = useRef('')
  const agentKey = useRef(teamNetworkIdempotencyKey())
  const agentFingerprint = useRef('')

  const selectedTeam = teams.find(team => team.id === teamId) ?? null
  const ownedServer = projection?.servers.find(server => server.owned_by_caller && server.status === 'active') ?? null
  const canWrite = Boolean(selectedTeam && selectedTeam.status === 'active' && selectedTeam.role !== 'guest')
  const unread = useMemo(() => mail.filter(message => message.delivery?.state !== 'read').length, [mail])
  const serverName = activeProfile?.name?.trim() || 'Active AgentsServer'
  const networkStatus = route && connected ? 'Team Network connected' : connecting ? 'Connecting to server' : connected ? 'Team Network not connected' : 'Server unavailable'
  const networkStatusColor = route && connected && !loading ? colors.green : connected || connecting ? colors.orange : colors.muted

  const clearTeamContent = (nextTeamId = '') => {
    setProjection(null)
    setMembers([])
    setFeed([])
    setMail([])
    setSelectedMessage(null)
    setDraft(draftsByTeam.current.get(nextTeamId) ?? '')
    setAgentForm(false)
    setAgentId('')
    setAgentName('')
    postFingerprint.current = ''
    agentFingerprint.current = ''
  }

  const updateDraft = (value: string) => {
    if (teamId) draftsByTeam.current.set(teamId, value)
    setDraft(value)
  }

  const cancelMessageLoad = () => {
    requests.current.cancel('detail')
    setSelectedMessage(null)
    setDetailLoading(false)
  }

  const loadMail = async (scope: TeamNetworkScope, currentTeamId: string, box: MailBox, server: NetworkServer | null, expectedRequest: TeamNetworkRequest) => {
    if (box === 'inbox' && !server) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setMail([])
      return
    }
    const query = new URLSearchParams({ box, limit: '50' })
    if (box === 'inbox' && server) {
      query.set('address_kind', 'server')
      query.set('address_id', server.id)
    }
    const page = await scopeClient(scope).teamNetworkGet<unknown>(scope.route.basePath, `/v1/teams/${encodeURIComponent(currentTeamId)}/network/messages?${query}`)
    if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setMail(rows<TeamMessageSummary>(page, 'messages'))
  }

  const loadWorkspace = async (preferredTeamId?: string) => {
    requests.current.reset()
    setDetailLoading(false)
    setPosting(false)
    setAgentBusy(false)
    const currentRoute = teamNetworkProxyRoute(useAppStore.getState().health)
    if (!currentRoute || !useAppStore.getState().connected) {
      setLoading(false)
      setError('')
      setTeams([])
      setTeamId('')
      clearTeamContent()
      return
    }
    const scope = captureScope(currentRoute)
    const expectedRequest = requests.current.begin('workspace')
    setLoading(true)
    setError('')
    setSelectedMessage(null)
    try {
      const session = await scopeClient(scope).teamNetworkGet<TeamSessionResponse>(currentRoute.basePath, currentRoute.sessionPath)
      if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
      const nextTeams = Array.isArray(session.teams) ? session.teams.filter(team => team?.id && team.status === 'active') : []
      const nextTeam = nextTeams.find(team => team.id === (preferredTeamId || teamId)) ?? nextTeams[0]
      setTeams(nextTeams)
      if (!nextTeam) {
        setTeamId('')
        clearTeamContent()
        return
      }
      if (nextTeam.id !== teamId) clearTeamContent(nextTeam.id)
      setTeamId(nextTeam.id)
      const teamPath = `/v1/teams/${encodeURIComponent(nextTeam.id)}`
      const [projectionValue, feedValue, memberValue] = await Promise.all([
        scopeClient(scope).teamNetworkGet<NetworkProjection>(currentRoute.basePath, `${teamPath}/network?limit=100`),
        scopeClient(scope).teamNetworkGet<unknown>(currentRoute.basePath, `${teamPath}/network/messages?box=feed&limit=50`),
        scopeClient(scope).teamNetworkGet<unknown>(currentRoute.basePath, `${teamPath}/members`),
      ])
      if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
      if (projectionValue.network?.id !== nextTeam.id) throw new Error('Teamspace returned a different team.')
      const nextProjection: NetworkProjection = {
        network: projectionValue.network,
        servers: Array.isArray(projectionValue.servers) ? projectionValue.servers : [],
        agents: Array.isArray(projectionValue.agents) ? projectionValue.agents : [],
      }
      setProjection(nextProjection)
      setFeed(rows<TeamMessageSummary>(feedValue, 'messages'))
      setMembers(rows<TeamMember>(memberValue, 'members'))
      await loadMail(scope, nextTeam.id, mailBox, nextProjection.servers.find(server => server.owned_by_caller && server.status === 'active') ?? null, expectedRequest)
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setLoading(false)
    }
  }

  useEffect(() => {
    if (!visible) {
      requests.current.reset()
      setSelectedMessage(null)
      setAgentForm(false)
      setLoading(false)
      setDetailLoading(false)
      setPosting(false)
      setAgentBusy(false)
      return
    }
    void loadWorkspace()
    return () => requests.current.reset()
    // A profile generation is an immutable server-workspace boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileGeneration, visible, route?.basePath, route?.sessionPath, health?.server_instance_id, connected])

  const changeMailbox = async (box: MailBox) => {
    if (loading) return
    cancelMessageLoad()
    setMailBox(box)
    setMail([])
    setError('')
    if (!route || !teamId) return
    const scope = captureScope(route)
    const expectedRequest = requests.current.begin('mail')
    setLoading(true)
    try {
      await loadMail(scope, teamId, box, ownedServer, expectedRequest)
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setLoading(false)
    }
  }

  const openMessage = async (summary: TeamMessageSummary) => {
    if (!route || !teamId || loading || detailLoading) return
    const scope = captureScope(route)
    const expectedRequest = requests.current.begin('detail')
    setDetailLoading(true)
    setError('')
    try {
      const response = await scopeClient(scope).teamNetworkGet<{ message: TeamMessage }>(route.basePath, `/v1/teams/${encodeURIComponent(teamId)}/network/messages/${encodeURIComponent(summary.id)}`)
      if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
      if (!response.message || response.message.id !== summary.id) throw new Error('Teamspace returned the wrong message.')
      setSelectedMessage(response.message)
      if (section === 'mail' && mailBox === 'inbox' && summary.delivery?.state !== 'read') {
        const receipt = await scopeClient(scope).teamNetworkPost<{ recipients?: TeamMessageSummary['recipients'] }>(route.basePath, `/v1/teams/${encodeURIComponent(teamId)}/network/messages/${encodeURIComponent(summary.id)}/receipts`, {
          state: 'read',
          idempotency_key: teamNetworkIdempotencyKey(),
        })
        if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
        setMail(current => current.map(message => message.id === summary.id ? {
          ...message,
          recipients: Array.isArray(receipt.recipients) ? receipt.recipients : message.recipients,
          delivery: message.delivery ? { ...message.delivery, state: 'read' } : message.delivery,
        } : message))
      }
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setDetailLoading(false)
    }
  }

  const postFeed = async () => {
    const body = draft.trim()
    if (!route || !teamId || !body || posting || loading || !canWrite || projection?.network.id !== teamId) return
    const scope = captureScope(route)
    const expectedRequest = requests.current.begin('post')
    const fingerprint = JSON.stringify([teamId, body])
    if (postFingerprint.current !== fingerprint) {
      postFingerprint.current = fingerprint
      postKey.current = teamNetworkIdempotencyKey()
    }
    setPosting(true)
    setError('')
    try {
      const response = await scopeClient(scope).teamNetworkPost<{ message: TeamMessage }>(route.basePath, `/v1/teams/${encodeURIComponent(teamId)}/network/messages`, {
        kind: 'message',
        body,
        body_format: 'markdown',
        recipients: [{ kind: 'all' }],
        attachment_ids: [],
        idempotency_key: postKey.current,
      })
      if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
      const created = response.message
      setFeed(current => [{ ...created, preview: created.body.slice(0, 600) }, ...current.filter(message => message.id !== created.id)])
      draftsByTeam.current.delete(teamId)
      setDraft('')
      postKey.current = teamNetworkIdempotencyKey()
      postFingerprint.current = ''
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setPosting(false)
    }
  }

  const registerAgent = async () => {
    const externalAgentId = agentId.trim()
    const displayName = agentName.trim()
    if (!route || !teamId || !externalAgentId || !displayName || agentBusy || loading || !canWrite || !ownedServer || projection?.network.id !== teamId) return
    const scope = captureScope(route)
    const expectedRequest = requests.current.begin('agent')
    const fingerprint = JSON.stringify([teamId, externalAgentId, displayName, agentBackend])
    if (agentFingerprint.current !== fingerprint) {
      agentFingerprint.current = fingerprint
      agentKey.current = teamNetworkIdempotencyKey()
    }
    setAgentBusy(true)
    setError('')
    try {
      const response = await scopeClient(scope).teamNetworkPost<{ agent: NetworkAgent }>(route.basePath, `/v1/teams/${encodeURIComponent(teamId)}/network/agents`, {
        external_agent_id: externalAgentId,
        backend: agentBackend,
        display_name: displayName,
        idempotency_key: agentKey.current,
      })
      if (!requests.current.isCurrent(expectedRequest) || !scopeCurrent(scope)) return
      setProjection(current => current ? { ...current, agents: [...current.agents.filter(agent => agent.id !== response.agent.id), response.agent] } : current)
      setAgentId('')
      setAgentName('')
      setAgentForm(false)
      agentFingerprint.current = ''
      agentKey.current = teamNetworkIdempotencyKey()
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest) && scopeCurrent(scope)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setAgentBusy(false)
    }
  }

  const backFromDetail = () => {
    cancelMessageLoad()
  }

  const changeSection = (next: TeamSection) => {
    cancelMessageLoad()
    setSection(next)
  }

  const refreshWorkspace = async () => {
    if (loading || posting || agentBusy) return
    cancelMessageLoad()
    const expectedRequest = requests.current.begin('workspace')
    setLoading(true)
    try {
      const state = useAppStore.getState()
      if (state.connected) await state.refreshSessions(profileGeneration)
      else await state.reconnect()
      if (!requests.current.isCurrent(expectedRequest)) return
      await loadWorkspace(teamId)
    } catch (cause) {
      if (requests.current.isCurrent(expectedRequest)) setError(cleanError(cause))
    } finally {
      if (requests.current.isCurrent(expectedRequest)) setLoading(false)
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background, paddingTop: insets.top }]} edges={['bottom']}><KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {selectedMessage
          ? <IconButton icon={ArrowLeft} label="Back to Team Network" testID="team-network-back" onPress={backFromDetail} />
          : <IconButton icon={ArrowLeft} label="Back to chats" testID="team-network-close" onPress={onClose} />}
        <View style={styles.headerTitle}><Text style={[styles.title, { color: colors.text }]}>Team Network</Text><View accessible accessibilityLabel={`${serverName}. ${networkStatus}`} style={styles.subtitleRow}><View style={[styles.statusDot, { backgroundColor: networkStatusColor }]} /><Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>{serverName}</Text></View></View>
        <IconButton icon={RefreshCw} label="Refresh Team Network" testID="team-network-refresh" disabled={loading || posting || agentBusy || Boolean(selectedMessage)} onPress={() => void refreshWorkspace()} />
      </View>
      {route && selectedTeam && projection && !selectedMessage ? <>
        {teams.length > 1 ? <ScrollView style={[styles.teamPickerScroller, { borderColor: colors.border }]} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.teamPicker}>{teams.map(team => <TabButton key={team.id} label={team.display_name} selected={team.id === teamId} disabled={loading || posting || agentBusy} onPress={() => { if (team.id !== teamId) void loadWorkspace(team.id) }} />)}</ScrollView> : null}
        <ScrollView style={[styles.tabScroller, { backgroundColor: colors.surface, borderColor: colors.border }]} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          <TabButton icon={Inbox} label={unread ? `Mail ${unread}` : 'Mail'} selected={section === 'mail'} onPress={() => changeSection('mail')} />
          <TabButton icon={RadioTower} label="Bulletin" selected={section === 'feed'} onPress={() => changeSection('feed')} />
          <TabButton icon={Bot} label="Servers & People" selected={section === 'directory'} onPress={() => changeSection('directory')} />
        </ScrollView>
      </> : null}
      {route && selectedTeam && projection && error ? <View accessibilityRole="alert" style={[styles.error, { backgroundColor: `${colors.red}14`, borderColor: colors.red }]}><Text selectable style={[styles.errorText, { color: colors.red }]}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Dismiss Team Network error" onPress={() => setError('')} style={styles.dismiss}><X size={16} color={colors.red} /></Pressable></View> : null}
      {!route ? <UnavailableState loading={loading} onRetry={() => void refreshWorkspace()} />
        : loading && !projection ? <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Loading Teamspace…</Text></View>
          : !selectedTeam || !projection ? <UnavailableState title="Teamspace could not be loaded" body={error || 'Set up or join a Teamspace from the desktop app, then retry here.'} loading={loading} onRetry={() => void refreshWorkspace()} />
            : selectedMessage ? <MessageDetail message={selectedMessage} />
              : <View style={styles.fill}>
                  {section === 'feed' ? <Bulletin messages={feed} onOpen={openMessage} /> : null}
                  {section === 'mail' ? <Mail messages={mail} box={mailBox} hasAddress={Boolean(ownedServer)} loading={loading} onBox={box => void changeMailbox(box)} onOpen={openMessage} /> : null}
                  {section === 'directory' ? <Directory projection={projection} members={members} canRegister={Boolean(ownedServer) && canWrite} form={agentForm} agentId={agentId} agentName={agentName} backend={agentBackend} busy={agentBusy || loading} onToggleForm={() => setAgentForm(value => !value)} onAgentId={setAgentId} onAgentName={setAgentName} onBackend={setAgentBackend} onRegister={() => void registerAgent()} /> : null}
                  {section === 'feed' && canWrite ? <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}><TextInput testID="team-feed-composer" accessibilityLabel="Share with the team" value={draft} onChangeText={updateDraft} multiline maxLength={49_152} editable={!posting && !loading} placeholder="Share an update with everyone…" placeholderTextColor={colors.muted} style={[styles.composerInput, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /><Pressable testID="team-feed-send" accessibilityRole="button" accessibilityLabel={posting ? 'Posting update' : 'Post update'} accessibilityState={{ disabled: posting || loading || !draft.trim() }} disabled={posting || loading || !draft.trim()} onPress={() => void postFeed()} style={({ pressed }) => [styles.send, { backgroundColor: colors.blue, opacity: posting || loading || !draft.trim() ? 0.35 : pressed ? 0.68 : 1 }]}>{posting ? <ActivityIndicator color="white" /> : <Send size={18} color="white" />}</Pressable></View> : null}
                </View>}
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>
}

function scopeClient(scope: TeamNetworkScope) {
  if (!scopeCurrent(scope)) throw new Error('The active server changed. Reopen Team Network and try again.')
  return scope.connection
}

function UnavailableState({ title = 'Team Network isn’t connected', body = "This AgentsServer isn't connected to your Team Network. Connect it from the desktop app, then retry here.", loading, onRetry }: { title?: string; body?: string; loading: boolean; onRetry: () => void }) {
  const colors = usePalette()
  return <View style={styles.unavailablePage}><View style={[styles.unavailableCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.unavailableIcon, { backgroundColor: `${colors.blue}16` }]}><Server size={19} color={colors.blue} /></View><Text style={[styles.unavailableKicker, { color: colors.blue }]}>TEAMSPACE</Text><Text style={[styles.unavailableTitle, { color: colors.text }]}>{title}</Text><Text selectable style={[styles.unavailableBody, { color: colors.muted }]}>{body}</Text><Pressable testID="team-network-retry" accessibilityRole="button" accessibilityLabel="Retry Teamspace" accessibilityState={{ disabled: loading, busy: loading }} disabled={loading} onPress={onRetry} style={({ pressed }) => [styles.unavailableRetry, { backgroundColor: colors.blue, opacity: loading ? 0.45 : pressed ? 0.7 : 1 }]}>{loading ? <ActivityIndicator size="small" color="white" /> : <RefreshCw size={15} color="white" />}<Text style={styles.unavailableRetryText}>{loading ? 'Retrying…' : 'Retry Teamspace'}</Text></Pressable></View></View>
}

function TabButton({ icon: Icon, label, selected, disabled = false, onPress }: { icon?: typeof Users; label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.tab, { backgroundColor: selected ? `${colors.blue}1C` : colors.raised, borderColor: selected ? colors.blue : colors.border, opacity: disabled ? 0.45 : pressed ? 0.68 : 1 }]}>{Icon ? <Icon size={15} color={selected ? colors.blue : colors.muted} /> : null}<Text style={[styles.tabText, { color: selected ? colors.blue : colors.text }]}>{label}</Text></Pressable>
}

function Bulletin({ messages, onOpen }: { messages: TeamMessageSummary[]; onOpen: (message: TeamMessageSummary) => void }) {
  return <CardList emptyTitle="Nothing shared yet" emptyBody="Messages and skills shared with everyone will collect here.">{messages.map(message => <MessageCard key={message.id} message={message} onOpen={() => onOpen(message)} />)}</CardList>
}

function Mail({ messages, box, hasAddress, loading, onBox, onOpen }: { messages: TeamMessageSummary[]; box: MailBox; hasAddress: boolean; loading: boolean; onBox: (box: MailBox) => void; onOpen: (message: TeamMessageSummary) => void }) {
  const colors = usePalette()
  return <View style={styles.fill}><View style={styles.mailToolbar}><TabButton label="Inbox" selected={box === 'inbox'} disabled={loading} onPress={() => onBox('inbox')} /><TabButton label="Sent" selected={box === 'sent'} disabled={loading} onPress={() => onBox('sent')} /></View>{box === 'inbox' && !hasAddress ? <EmptyState title="No mailbox on this server" body="Connect this server to the Teamspace to receive passive team mail." /> : <CardList emptyTitle={box === 'inbox' ? 'Inbox is empty' : 'Nothing sent yet'} emptyBody={box === 'inbox' ? 'Agent mail waits here without waking or steering an agent.' : 'Messages sent by this server will appear here.'}>{messages.map(message => <MessageCard key={message.id} message={message} unread={box === 'inbox' && message.delivery?.state !== 'read'} onOpen={() => onOpen(message)} />)}</CardList>}<Text style={[styles.passiveNote, { color: colors.muted }]}>Mail is passive: opening it here never wakes or steers an agent.</Text></View>
}

function CardList({ emptyTitle, emptyBody, children }: { emptyTitle: string; emptyBody: string; children: React.ReactNode }) {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0
  if (!count) return <EmptyState title={emptyTitle} body={emptyBody} />
  return <ScrollView style={styles.fill} contentContainerStyle={styles.cardList} keyboardShouldPersistTaps="handled">{children}</ScrollView>
}

function MessageCard({ message, unread = false, onOpen }: { message: TeamMessageSummary; unread?: boolean; onOpen: () => void }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${message.title || `message from ${message.sender.display_name}`}`} onPress={onOpen} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: unread ? colors.blue : colors.border, opacity: pressed ? 0.72 : 1 }]}><View style={styles.cardTop}><View style={[styles.avatar, { backgroundColor: colors.raised }]}>{message.kind === 'skill' ? <BookOpen size={16} color={colors.blue} /> : <Server size={16} color={colors.blue} />}</View><View style={styles.cardHeading}><Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>{message.title || message.sender.display_name}</Text><Text style={[styles.cardMeta, { color: colors.muted }]} numberOfLines={1}>{message.kind === 'skill' ? 'Skill' : message.sender.display_name} · {new Date(message.created_at).toLocaleString()}</Text></View>{unread ? <View style={[styles.unreadDot, { backgroundColor: colors.blue }]} /> : null}</View><Text style={[styles.cardBody, { color: colors.text }]} numberOfLines={5}>{messagePreview(message)}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{message.recipients.some(recipient => recipient.kind === 'all') ? 'Everyone' : message.recipients.map(recipient => recipient.display_name).join(', ') || 'Private mail'}{message.attachments?.length ? ` · ${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}` : ''}</Text></Pressable>
}

function MessageDetail({ message }: { message: TeamMessage }) {
  const colors = usePalette()
  return <ScrollView style={styles.fill} contentContainerStyle={styles.detailPage}><Text style={[styles.detailTitle, { color: colors.text }]}>{message.title || `Message from ${message.sender.display_name}`}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{message.sender.display_name} · {new Date(message.created_at).toLocaleString()}</Text><View style={[styles.detailBody, { backgroundColor: colors.surface, borderColor: colors.border }]}>{message.body_format === 'markdown' ? <MarkdownContent value={message.body} /> : <Text selectable style={[styles.plainBody, { color: colors.text }]}>{message.body}</Text>}</View>{message.attachments?.length ? <View style={[styles.detailBody, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.cardTitle, { color: colors.text }]}>Attachments</Text>{message.attachments.map(file => <Text key={file.id} style={[styles.cardBody, { color: colors.muted }]}>{file.file_name} · {Math.ceil(file.byte_size / 1024).toLocaleString()} KB</Text>)}</View> : null}<Text style={[styles.cardMeta, { color: colors.muted }]}>Immutable team message #{message.sequence}</Text></ScrollView>
}

function Directory({ projection, members, canRegister, form, agentId, agentName, backend, busy, onToggleForm, onAgentId, onAgentName, onBackend, onRegister }: { projection: NetworkProjection | null; members: TeamMember[]; canRegister: boolean; form: boolean; agentId: string; agentName: string; backend: 'codex' | 'claude' | 'other'; busy: boolean; onToggleForm: () => void; onAgentId: (value: string) => void; onAgentName: (value: string) => void; onBackend: (value: 'codex' | 'claude' | 'other') => void; onRegister: () => void }) {
  const colors = usePalette()
  if (!projection) return <EmptyState title="Directory unavailable" body="Refresh Team Network to load servers and people." />
  return <ScrollView style={styles.fill} contentContainerStyle={styles.directory} keyboardShouldPersistTaps="handled"><View style={styles.sectionTitleRow}><Text style={[styles.sectionTitle, { color: colors.text }]}>Servers & People</Text>{canRegister ? <ActionButton icon={Bot} label={form ? 'Cancel' : 'Add agent'} disabled={busy} onPress={onToggleForm} /> : null}</View>{form ? <View style={[styles.agentForm, { backgroundColor: colors.surface, borderColor: colors.border }]}><TextInput accessibilityLabel="Agent ID" value={agentId} onChangeText={onAgentId} autoCapitalize="none" autoCorrect={false} placeholder="Stable agent ID" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /><TextInput accessibilityLabel="Agent display name" value={agentName} onChangeText={onAgentName} placeholder="Display name" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /><View style={styles.backendRow}>{(['codex', 'claude', 'other'] as const).map(value => <TabButton key={value} label={value} selected={backend === value} onPress={() => onBackend(value)} />)}</View><ActionButton icon={Bot} label={busy ? 'Adding…' : 'Add agent'} disabled={busy || !agentId.trim() || !agentName.trim()} onPress={onRegister} /></View> : null}{projection.servers.map(server => <View key={server.id} style={[styles.directoryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.cardTop}><Server size={18} color={colors.blue} /><View style={styles.cardHeading}><Text style={[styles.cardTitle, { color: colors.text }]}>{server.display_name}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{server.is_host ? 'Network host' : server.owned_by_caller ? 'This server' : 'Linked server'} · {server.status}</Text></View></View>{projection.agents.filter(agent => agent.server_id === server.id).map(agent => <View key={agent.id} style={styles.directoryRow}><Bot size={14} color={colors.muted} /><Text style={[styles.directoryName, { color: colors.text }]}>{agent.display_name}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{agent.backend} · {agent.status}</Text></View>)}</View>)}{members.length ? <View style={[styles.directoryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.cardTop}><Users size={18} color={colors.blue} /><Text style={[styles.cardTitle, { color: colors.text }]}>People</Text></View>{members.map(member => <View key={member.principal_id} style={styles.directoryRow}><Text style={[styles.directoryName, { color: colors.text }]}>{member.display_name}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{member.role} · {member.status}</Text></View>)}</View> : null}</ScrollView>
}

function ActionButton({ icon: Icon, label, disabled = false, onPress }: { icon: typeof Bot; label: string; disabled?: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: colors.raised, borderColor: colors.border, opacity: disabled ? 0.4 : pressed ? 0.68 : 1 }]}><Icon size={14} color={colors.blue} /><Text style={[styles.actionText, { color: colors.text }]}>{label}</Text></Pressable>
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { minHeight: 58, paddingHorizontal: 6, paddingVertical: Platform.OS === 'android' ? 5 : 4, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 2 },
  headerTitle: { flex: 1, minWidth: 0, gap: 1 }, title: { fontSize: 16, fontWeight: '800' }, subtitleRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }, statusDot: { width: 6, height: 6, flexShrink: 0, borderRadius: 3 }, subtitle: { flexShrink: 1, fontSize: 10.5 },
  teamPickerScroller: { flexGrow: 0, flexShrink: 0, maxHeight: 54, borderBottomWidth: StyleSheet.hairlineWidth },
  teamPicker: { minHeight: 54, paddingHorizontal: 10, paddingVertical: 5, gap: 6, alignItems: 'center' },
  tabScroller: { flexGrow: 0, flexShrink: 0, height: 58, borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { minHeight: 58, paddingHorizontal: 10, paddingVertical: 7, gap: 7, alignItems: 'center' },
  tab: { minHeight: 44, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, tabText: { fontSize: 11.5, fontWeight: '800' },
  error: { marginHorizontal: 10, marginTop: 8, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingLeft: 11, flexDirection: 'row', alignItems: 'center', gap: 4 }, errorText: { flex: 1, fontSize: 11, lineHeight: 15 }, dismiss: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  unavailablePage: { flex: 1, paddingHorizontal: 22, paddingTop: 32, alignItems: 'center' },
  unavailableCard: { width: '100%', maxWidth: 420, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 22, paddingVertical: 24, alignItems: 'center', gap: 7 },
  unavailableIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  unavailableKicker: { fontSize: 9.5, lineHeight: 13, fontWeight: '800', letterSpacing: 1.1 },
  unavailableTitle: { fontSize: 17, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  unavailableBody: { maxWidth: 310, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  unavailableRetry: { minWidth: 148, minHeight: 44, marginTop: 8, borderRadius: 10, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  unavailableRetryText: { color: 'white', fontSize: 12, fontWeight: '800' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 9 },
  cardList: { padding: 12, paddingBottom: 24, gap: 9 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, gap: 8 }, cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 }, avatar: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, cardHeading: { flex: 1, minWidth: 0, gap: 2 }, cardTitle: { fontSize: 12.5, lineHeight: 17, fontWeight: '800' }, cardMeta: { fontSize: 9.5, lineHeight: 13 }, cardBody: { fontSize: 12, lineHeight: 17 }, unreadDot: { width: 8, height: 8, borderRadius: 4 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 9, flexDirection: 'row', alignItems: 'flex-end', gap: 7 }, composerInput: { flex: 1, minHeight: 44, maxHeight: 130, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13 }, send: { width: 46, height: 46, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  mailToolbar: { minHeight: 58, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 }, passiveNote: { paddingHorizontal: 12, paddingBottom: 8, fontSize: 9.5, lineHeight: 13 },
  detailPage: { padding: 15, paddingBottom: 36, gap: 11 }, detailTitle: { fontSize: 21, lineHeight: 27, fontWeight: '800' }, detailBody: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 12 }, plainBody: { fontSize: 14, lineHeight: 21 }, detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  action: { minHeight: 44, alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, actionText: { fontSize: 11, fontWeight: '800' },
  directory: { padding: 12, paddingBottom: 32, gap: 10 }, sectionTitleRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }, sectionTitle: { flex: 1, fontSize: 17, fontWeight: '800' }, directoryCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, gap: 7 }, directoryRow: { minHeight: 40, paddingLeft: 25, flexDirection: 'row', alignItems: 'center', gap: 7 }, directoryName: { flex: 1, fontSize: 11.5, fontWeight: '700' },
  agentForm: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 10, gap: 8 }, input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 }, backendRow: { flexDirection: 'row', gap: 6 },
})
