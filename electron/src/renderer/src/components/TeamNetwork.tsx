import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  Pencil,
  RadioTower,
  RefreshCw,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
  UserRound,
  Users,
  UserPlus,
  X
} from 'lucide-react'
import type {
  TeamHubDeviceSession,
  TeamHubForgetBindingInput,
  TeamHubInvitationSummary,
  TeamHubMembership,
  TeamHubScope,
  TeamHubStatus,
  TeamHubTeamDetails,
  TeamHubWorkspace
} from '@shared/team-hub'
import type {
  TeamNetworkBulletinPost,
  TeamNetworkCapabilities,
  TeamNetworkMailboxEntry,
  TeamNetworkMailboxAddress,
  TeamNetworkProjection,
  TeamNetworkProjectionPage,
  TeamNetworkServer,
  TeamMessageSummary,
  TeamMessagesCapability
} from '@shared/team-network'
import type { TeamReference } from '@shared/types'
import { SecurePeerPanel } from './SecurePeerPanel'
import { startTeamFeedInitialLoad, TeamMessagesBoard, type TeamFeedInitialLoad, type TeamMailRouteTarget, type TeamMessageAddress } from './TeamMessagesBoard'
import { buildTeamMailBundles, type TeamMailBundle } from '../lib/team-mail-board'
import { validTeamReferences } from '../lib/team-references'
import { escapeTeamMessageLinkLabel, teamMessageLinkURL } from '../lib/team-message-links'
import { teamMailDisplayTitle } from '../lib/team-message-title'
import {
  invalidateTeamNetworkSnapshot,
  loadTeamNetworkCore,
  loadTeamNetworkWorkspace,
  peekTeamNetworkOpeningSnapshot,
  peekTeamNetworkCore,
  peekTeamNetworkWorkspace,
  teamNetworkSnapshotKey,
  type TeamNetworkCoreSnapshot
} from '../lib/team-network-snapshot-cache'
import { selectMailHintPending, selectBulletinHintPending, useAppStore } from '../store/app-store'
import { t, useLocale } from '../lib/i18n'

export type TeamNetworkSection = 'feed' | 'mail' | 'skills' | 'directory'

const NETWORK_INITIAL_SCAN_MAX_PAGES = 256
const NETWORK_ROSTER_MAX_SERVERS = 25_600
const NETWORK_ROSTER_MAX_AGENTS = 262_144
const DIRECTORY_ADMIN_MAX_ITEMS = 2_000

type NetworkCopy = string | { key: string; params?: Record<string, NetworkCopy | number> }
function copy(key: string, params?: Record<string, NetworkCopy | number>): NetworkCopy { return { key, params } }
function displayCopy(value: NetworkCopy | null): string | null {
  if (value === null || typeof value === 'string') return value
  const params = value.params && Object.fromEntries(Object.entries(value.params)
    .map(([key, item]) => [key, typeof item === 'number' ? item : displayCopy(item) ?? '']))
  return t(value.key, params)
}
class NetworkError extends Error {
  constructor(readonly copy: NetworkCopy) { super(displayCopy(copy) ?? '') }
}
function roleLabel(role: string): string {
  return ['owner', 'admin', 'member', 'guest', 'automation'].includes(role) ? t(`teamNetwork.shell.role.${role}`) : role
}
function memberStatusLabel(status: string): string {
  return ['active', 'suspended', 'revoked'].includes(status) ? t(`teamNetwork.shell.status.${status}`) : status
}

export interface PendingSecurePeerInvite {
  id: number
  invite: string
}

export interface TeamNetworkMailboxTarget {
  teamId: string
  address: TeamNetworkMailboxAddress
}

export interface TeamNetworkMessageTarget {
  teamId: string
  messageId: string
  mailboxBox?: 'inbox' | 'sent'
}

export function TeamNetwork({
  onClose,
  initialMailboxTarget = null,
  initialMessageTarget = null,
  onInitialMessageConsumed,
  initialMailboxRequestId = 0,
  initialSection = 'mail',
  pendingSecurePeerInvite = null,
  onSecurePeerInviteHandled
}: {
  onClose: () => void
  initialMailboxTarget?: TeamNetworkMailboxTarget | null
  initialMessageTarget?: TeamNetworkMessageTarget | null
  onInitialMessageConsumed?: () => void
  initialMailboxRequestId?: number
  initialSection?: TeamNetworkSection
  pendingSecurePeerInvite?: PendingSecurePeerInvite | null
  onSecurePeerInviteHandled?: (requestId: number) => void
}) {
  const locale = useLocale()
  const [openingSnapshot] = useState(() => {
    const app = useAppStore.getState()
    const profile = app.profiles.find(candidate => candidate.id === app.activeProfileId)
    if (!app.activeProfileId || !profile?.serverIdentity) return null
    return peekTeamNetworkOpeningSnapshot({
      profileId: app.activeProfileId,
      profileGeneration: app.profileGeneration,
      serverIdentity: profile.serverIdentity
    }, initialMailboxTarget?.teamId)
  })
  const [status, setStatus] = useState<TeamHubStatus | null>(null)
  const [workspace, setWorkspace] = useState<TeamHubWorkspace | null>(null)
  const [details, setDetails] = useState<TeamHubTeamDetails | null>(null)
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<TeamNetworkCapabilities | null>(null)
  const [teamMessagesCapability, setTeamMessagesCapability] = useState<TeamMessagesCapability | null>(null)
  const [teamMessagesInitialFeedLoad, setTeamMessagesInitialFeedLoad] = useState<TeamFeedInitialLoad | null>(null)
  const [teamMessageUnreadCount, setTeamMessageUnreadCount] = useState(0)
  const [teamMessageUnreadOverflow, setTeamMessageUnreadOverflow] = useState(false)
  const [projection, setProjectionState] = useState<TeamNetworkProjection | null>(null)
  const projectionRef = useRef<TeamNetworkProjection | null>(null)
  const replaceProjection = useCallback((next: TeamNetworkProjection | null): void => {
    projectionRef.current = next
    setProjectionState(next)
  }, [])
  const updateProjection = useCallback((update: (current: TeamNetworkProjection) => TeamNetworkProjection): TeamNetworkProjection | null => {
    const current = projectionRef.current
    if (!current) return null
    const next = update(current)
    projectionRef.current = next
    setProjectionState(next)
    return next
  }, [])
  const [projectionAfterServerId, setProjectionAfterServerId] = useState<string | null>(null)
  const [projectionHasMore, setProjectionHasMore] = useState(false)
  const [bulletinPosts, setBulletinPosts] = useState<TeamNetworkBulletinPost[]>([])
  const [mailboxAddress, setMailboxAddress] = useState<TeamNetworkMailboxAddress | null>(null)
  const [mailboxEntries, setMailboxEntries] = useState<TeamNetworkMailboxEntry[]>([])
  const [deviceSessions, setDeviceSessions] = useState<TeamHubDeviceSession[]>([])
  const [deviceSessionsCursor, setDeviceSessionsCursor] = useState<string | null>(null)
  const [deviceSessionsHasMore, setDeviceSessionsHasMore] = useState(false)
  const [pendingInvitations, setPendingInvitations] = useState<TeamHubInvitationSummary[]>([])
  const [invitationsCursor, setInvitationsCursor] = useState<string | null>(null)
  const [invitationsHasMore, setInvitationsHasMore] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [section, setSection] = useState<TeamNetworkSection>(initialSection === 'skills' ? 'feed' : initialSection)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [bindingManagerOpen, setBindingManagerOpen] = useState(false)
  const [confirmForgetBinding, setConfirmForgetBinding] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [busy, setBusy] = useState<string | null>('opening')
  const [errorCopy, setError] = useState<NetworkCopy | null>(null)
  const [noticeCopy, setNotice] = useState<NetworkCopy | null>(null)
  const error = displayCopy(errorCopy)
  const notice = displayCopy(noticeCopy)
  const localChatSessions = useAppStore(state => state.sessions)
  const newMailArrivals = useAppStore(state => selectMailHintPending(state) && state.mailHints?.state?.scope.teamId === selectedTeamId)
  const newBulletinUpdates = useAppStore(state => selectBulletinHintPending(state) && state.mailHints?.bulletin?.scope.teamId === selectedTeamId)
  const currentChatSessionId = useAppStore(state => state.selectedSessionId)
  const lifecycleEpoch = useRef(0)
  const dataEpoch = useRef(0)
  const mutationEpoch = useRef(0)
  const mailboxAddressRef = useRef<TeamNetworkMailboxAddress | null>(null)
  const receiptInFlight = useRef(new Set<string>())
  const serverRemovalRequest = useRef(0)
  const serverRemovalInFlight = useRef(false)
  const hostRenameInFlight = useRef(false)
  const connectAttempt = useRef<string | null>(null)
  const bindingManagerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const inviteCloseButtonRef = useRef<HTMLButtonElement | null>(null)
  // This guard is intentionally scoped to the open Team Network surface. A
  // later explicit reopen may rediscover a published local Hub, but the main
  // process has already deleted its refresh credential, so discovery cannot
  // silently restore the forgotten authenticated session.
  const suppressAutoConnectForProfile = useRef<string | null>(null)
  const selectedTeamIdRef = useRef<string | null>(null)
  const messageNavigationRequest = useRef<number | null>(null)
  const messageTargetRef = useRef(initialMessageTarget)
  messageTargetRef.current = initialMessageTarget
  const consumedMailboxRequestId = useRef<number | null>(null)
  const memberPageCursors = useRef(new Set<string>())
  const invitationPageCursors = useRef(new Set<string>())
  const deviceSessionPageCursors = useRef(new Set<string>())
  const initialOpenRef = useRef(true)
  const sectionRef = useRef(section)

  useEffect(() => { sectionRef.current = section }, [section])
  useEffect(() => { selectedTeamIdRef.current = selectedTeamId }, [selectedTeamId])
  useEffect(() => { mailboxAddressRef.current = mailboxAddress }, [mailboxAddress])
  const selectMailboxAddress = useCallback((next: TeamNetworkMailboxAddress) => {
    if (sameAddress(mailboxAddressRef.current, next)) return
    // Fence an in-flight response from the prior mailbox before React commits
    // the address change. Old entries must never render or receive receipts in
    // the context of the newly selected receiver.
    mailboxAddressRef.current = next
    setMailboxEntries([])
    setMailboxAddress(next)
  }, [])
  const consumeInitialFeedLoad = useCallback((load: TeamFeedInitialLoad) => {
    setTeamMessagesInitialFeedLoad(current => current === load ? null : current)
  }, [])
  const mailRouteTargets = useMemo<TeamMailRouteTarget[]>(() => localChatSessions
    .filter(session => !session.archived)
    .sort((left, right) => Number(right.id === currentChatSessionId) - Number(left.id === currentChatSessionId))
    .map(session => ({
      id: session.id,
      label: session.title || t('teamNetwork.shell.untitledChat'),
      current: session.id === currentChatSessionId
    })), [currentChatSessionId, localChatSessions, locale])
  const routeMailToChat = useCallback(async (message: TeamMessageSummary, sessionId: string, intent: 'read' | 'reply' = 'read') => {
    const app = useAppStore.getState()
    const target = app.sessions.find(session => session.id === sessionId && !session.archived)
    if (!target) {
      setError(copy('teamNetwork.shell.chatUnavailable'))
      return
    }
    await app.selectSession(sessionId)
    const selected = useAppStore.getState()
    if (selected.selectedSessionId !== sessionId || selected.activeProfileId !== app.activeProfileId
      || selected.profileGeneration !== app.profileGeneration) {
      setError(copy('teamNetwork.shell.chatOpenFailed'))
      return
    }
    const existing = selected.drafts[sessionId] ?? ''
    const separator = existing ? '\n\n' : ''
    const bulletin = message.destination !== 'all_servers' && message.recipients.some(recipient => recipient.kind === 'all')
    const sentByThisServer = projection && status && ownedAddresses(projection, status)
      .some(option => sameAddress(option.address, message.sender))
    const link = teamMessageLinkURL({
      section: bulletin ? 'feed' : 'mail',
      teamId: message.team_id,
      messageId: message.id,
      ...(!bulletin ? { mailboxBox: sentByThisServer ? 'sent' as const : 'inbox' as const } : {}),
      ...(status?.serverIdentity ? { serverIdentity: status.serverIdentity } : {})
    })
    const label = !bulletin && message.kind === 'message'
      ? escapeTeamMessageLinkLabel(teamMailDisplayTitle(message))
      : (message.title || message.preview || t('teamNetwork.shell.teamMessage')).replace(/[\[\]\\\r\n]/g, ' ').slice(0,120)
    const prefix = t(intent === 'reply' ? 'teamNetwork.shell.routeReply' : 'teamNetwork.shell.routeRead', { label, link })
    const prompt = `${prefix}@@${message.sender.display_name}`
    const nextDraft = `${existing}${separator}${prompt}`
    const sourceTextStart = existing.length + separator.length + prefix.length
    const reference: TeamReference = {
      kind: 'recipient',
      recipient_kind: message.sender.kind,
      team_id: message.team_id,
      target_id: message.sender.id,
      display_name_snapshot: message.sender.display_name,
      source_text_start: sourceTextStart,
      source_text_end: sourceTextStart + `@@${message.sender.display_name}`.length,
      grant_intent: true
    }
    selected.setDraftForSession(sessionId, nextDraft)
    selected.setTeamReferencesForSession(sessionId, validTeamReferences(nextDraft, [
      ...(selected.teamReferencesBySession[sessionId] ?? []),
      reference
    ]))
    onClose()
  }, [onClose, projection, status])
  useEffect(() => {
    // A prefetched page is only an initial Bulletin handoff. If this lifecycle
    // opens on Mail or Directory, discard it so a later Bulletin visit reads a
    // fresh page rather than replaying an old promise.
    if (section !== 'feed') setTeamMessagesInitialFeedLoad(null)
  }, [section, teamMessagesInitialFeedLoad])
  useEffect(() => {
    // Teamspace can already be open when a global Inbox notice is clicked.
    // Treat a new explicit entry target as navigation, not only an initializer.
    setSection(initialSection === 'skills' ? 'feed' : initialSection)
  }, [initialMailboxRequestId, initialMailboxTarget?.address.id, initialMailboxTarget?.address.kind, initialMailboxTarget?.teamId, initialSection])

  useEffect(() => {
    if (!status || !pendingSecurePeerInvite) return
    if (status.serverManaged || status.designatedHost) return
    if (status.authenticated && workspace) setInviteOpen(true)
  }, [pendingSecurePeerInvite, status, workspace])

  const clearTeamData = useCallback(() => {
    dataEpoch.current += 1
    receiptInFlight.current.clear()
    setDetails(null)
    setCapabilities(null)
    setTeamMessagesCapability(null)
    setTeamMessagesInitialFeedLoad(null)
    setTeamMessageUnreadCount(0)
    setTeamMessageUnreadOverflow(false)
    replaceProjection(null)
    setProjectionAfterServerId(null)
    setProjectionHasMore(false)
    setBulletinPosts([])
    setMailboxAddress(null)
    setMailboxEntries([])
    setDeviceSessions([])
    setDeviceSessionsCursor(null)
    setDeviceSessionsHasMore(false)
    setPendingInvitations([])
    setInvitationsCursor(null)
    setInvitationsHasMore(false)
    setDirectoryLoading(false)
    memberPageCursors.current.clear()
    invitationPageCursors.current.clear()
    deviceSessionPageCursors.current.clear()
    consumedMailboxRequestId.current = null
  }, [replaceProjection])

  const loadTeamData = useCallback(async (
    nextStatus: TeamHubStatus,
    nextWorkspace: TeamHubWorkspace,
    teamId: string,
    options: { visibleRefresh?: boolean } = {}
  ) => {
    const request = ++dataEpoch.current
    const mutation = mutationEpoch.current
    const context = teamContextKey(nextStatus, teamId)
    const cached = peekTeamNetworkCore(nextStatus, teamId)
    setBusy(cached ? (options.visibleRefresh ? 'team-refresh' : null) : 'team')
    setError(null)
    setNotice(null)
    setSelectedTeamId(teamId)
    const applySnapshot = (
      snapshot: TeamNetworkCoreSnapshot,
      nextProjection: TeamNetworkProjection,
      lastProjectionPage: TeamNetworkProjectionPage,
      initialFeedLoad: TeamFeedInitialLoad | null,
      publishInitialFeedLoad = true
    ) => {
      const nextDetails = snapshot.details
      if (nextDetails.team.id !== teamId || nextProjection.network.id !== teamId) {
        throw new NetworkError(copy('teamNetwork.shell.differentTeam'))
      }
      validateUniqueDirectoryPage(nextDetails.members, member => member.principal_id, copy('teamNetwork.shell.teamMembers'))
      validateUniqueDirectoryPage(nextDetails.nodes, node => node.id, copy('teamNetwork.shell.teamNodes'))
      validateUniqueDirectoryPage(nextDetails.channels, channel => channel.id, copy('teamNetwork.shell.teamChannels'))
      validateDirectoryContinuation(
        Boolean(nextDetails.membersHasMore),
        nextDetails.membersNextCursor ?? null,
        null,
        memberPageCursors.current,
        copy('teamNetwork.shell.teamMembers')
      )
      if (nextDetails.membersHasMore === false) {
        validateCompleteMemberDirectory(nextDetails, nextStatus, nextDetails.members)
      }
      setDetails(nextDetails)
      setCapabilities(snapshot.capabilities)
      setTeamMessagesCapability(snapshot.teamMessagesCapability)
      if (publishInitialFeedLoad) {
        setTeamMessagesInitialFeedLoad(snapshot.teamMessagesCapability ? initialFeedLoad : null)
      }
      replaceProjection(nextProjection)
      setProjectionAfterServerId(lastProjectionPage.next_after_server_id)
      setProjectionHasMore(lastProjectionPage.has_more)
      setBulletinPosts(snapshot.legacyBulletin.posts)
      setMailboxAddress(current => ownedAddress(nextProjection, nextStatus, current))
    }
    if (cached) {
      try {
        applySnapshot(cached, projectionFromPage(cached.projectionPage), cached.projectionPage, null)
      } catch {
        invalidateTeamNetworkSnapshot(nextStatus, teamId)
      }
    } else {
      setDetails(null)
      setCapabilities(null)
      setTeamMessagesCapability(null)
      setTeamMessagesInitialFeedLoad(null)
      setTeamMessageUnreadCount(0)
      setTeamMessageUnreadOverflow(false)
      replaceProjection(null)
      setProjectionAfterServerId(null)
      setProjectionHasMore(false)
      setBulletinPosts([])
      setMailboxEntries([])
      setDeviceSessions([])
      setDeviceSessionsCursor(null)
      setDeviceSessionsHasMore(false)
      setPendingInvitations([])
      setInvitationsCursor(null)
      setInvitationsHasMore(false)
      memberPageCursors.current.clear()
      invitationPageCursors.current.clear()
      deviceSessionPageCursors.current.clear()
    }
    try {
      const scope = scopeFrom(nextStatus)
      const teamMessagesRequest = typeof window.agentsDock.teamHub.teamMessagesCapabilities === 'function'
        ? window.agentsDock.teamHub.teamMessagesCapabilities(scope).catch(cause => {
          if (cause instanceof Error && cause.message.includes('does not support Team Messages yet')) return null
          throw cause
        })
        : Promise.resolve(null)
      // Prefetch only the visible Bulletin. Opening Mail or Directory must
      // not also fetch an unrelated feed.
      const initialFeedLoad: TeamFeedInitialLoad = teamMessagesRequest.then(nextCapability => (
        nextCapability && sectionRef.current === 'feed'
          ? startTeamFeedInitialLoad(scope, teamId)
          : { state: 'unavailable' as const }
      )).catch(cause => ({ state: 'error' as const, message: displayCopy(errorMessage(cause)) ?? '' }))
      const snapshot = await loadTeamNetworkCore(nextStatus, teamId, {
        force: Boolean(cached),
        teamMessagesRequest
      })
      if (dataEpoch.current !== request || mutationEpoch.current !== mutation || context !== teamContextKey(nextWorkspace.status, teamId)) return
      let nextProjection = projectionFromPage(snapshot.projectionPage)
      let lastProjectionPage = snapshot.projectionPage
      // The first page, details, and feed are already authoritative. Publish
      // them before a potentially long pagination scan for the caller-owned
      // mailbox instead of holding the entire surface behind "Loading…".
      applySnapshot(snapshot, nextProjection, lastProjectionPage, initialFeedLoad)
      const ownershipScanRequired = !nextProjection.servers.some(server => server.owned_by_caller) && lastProjectionPage.has_more
      if (!cached && ownershipScanRequired) setBusy('team-ownership')
      const cursors = new Set<string>()
      let pageCount = 1
      while (ownershipScanRequired && !nextProjection.servers.some(server => server.owned_by_caller) && lastProjectionPage.has_more) {
        const cursor = lastProjectionPage.next_after_server_id
        if (!cursor || cursors.has(cursor)) throw new NetworkError(copy('teamNetwork.shell.stalledNetwork'))
        if (pageCount >= NETWORK_INITIAL_SCAN_MAX_PAGES) throw new NetworkError(copy('teamNetwork.shell.ownershipScanLimit'))
        cursors.add(cursor)
        const page = await window.agentsDock.teamHub.network(scope, {
          teamId,
          afterServerId: cursor,
          limit: snapshot.capabilities.max_page_items
        })
        if (dataEpoch.current !== request || mutationEpoch.current !== mutation || context !== teamContextKey(nextWorkspace.status, teamId)) return
        nextProjection = mergeNetworkProjection(nextProjection, page)
        lastProjectionPage = page
        pageCount += 1
      }
      if (pageCount > 1) applySnapshot(snapshot, nextProjection, lastProjectionPage, initialFeedLoad, false)
    } catch (cause) {
      if (dataEpoch.current === request) setError(errorMessage(cause))
    } finally {
      if (dataEpoch.current === request) setBusy(null)
    }
  }, [replaceProjection])

  useEffect(() => {
    if (!initialMessageTarget || !status?.authenticated || !workspace
      || messageNavigationRequest.current === initialMailboxRequestId) return
    messageNavigationRequest.current = initialMailboxRequestId
    if (!workspace.teams.some(team => team.id === initialMessageTarget.teamId)) {
      setError(copy('teamNetwork.shell.messageNetworkUnavailable'))
      return
    }
    if (selectedTeamId !== initialMessageTarget.teamId) {
      void loadTeamData(status, workspace, initialMessageTarget.teamId)
    }
  }, [initialMessageTarget?.teamId, initialMailboxRequestId, selectedTeamId, status, workspace, loadTeamData])

  useEffect(() => {
    if (
      initialSection !== 'mail'
      || !initialMailboxTarget
      || !status?.authenticated
      || !workspace
      || consumedMailboxRequestId.current === initialMailboxRequestId
    ) return
    if (selectedTeamId !== initialMailboxTarget.teamId) {
      if (workspace.teams.some(team => team.id === initialMailboxTarget.teamId)) {
        void loadTeamData(status, workspace, initialMailboxTarget.teamId)
      }
      return
    }
    if (!projection) return
    const target = ownedAddresses(projection, status)
      .find(option => sameAddress(option.address, initialMailboxTarget.address))?.address
    if (!target) return
    consumedMailboxRequestId.current = initialMailboxRequestId
    if (sameAddress(mailboxAddress, target)) return
    // Clear the old mailbox in the same state batch as the address switch.
    // Otherwise the read-receipt effect can briefly pair old entries with the
    // newly requested address when a notice targets this already-open team.
    selectMailboxAddress(target)
  }, [
    initialMailboxTarget?.address.id,
    initialMailboxTarget?.address.kind,
    initialMailboxTarget?.teamId,
    initialMailboxRequestId,
    initialSection,
    mailboxAddress?.id,
    mailboxAddress?.kind,
    projection,
    selectedTeamId,
    selectMailboxAddress,
    status,
    workspace
  ])

  useEffect(() => {
    const human = status?.authenticated
      && status.authenticationMode === 'human'
      && !status.serverManaged
    const owner = human && details?.membership.role === 'owner'
    if (section !== 'directory' || !human || !status || !selectedTeamId || !details) return
    const epoch = dataEpoch.current
    const context = teamContextKey(status, selectedTeamId)
    let active = true
    invitationPageCursors.current.clear()
    deviceSessionPageCursors.current.clear()
    setDirectoryLoading(true)
    setError(null)
    void Promise.all([
      window.agentsDock.teamHub.deviceSessions(scopeFrom(status)),
      owner
        ? window.agentsDock.teamHub.invitations(scopeFrom(status), selectedTeamId)
        : Promise.resolve({ invitations: [], has_more: false, next_cursor: null })
    ]).then(([sessions, invitations]) => {
      if (!active || dataEpoch.current !== epoch || context !== teamContextKey(status, selectedTeamId)) return
      validateUniqueDirectoryPage(sessions.sessions, session => session.id, copy('teamNetwork.shell.deviceSessions'))
      validateUniqueDirectoryPage(invitations.invitations, invitation => invitation.id, copy('teamNetwork.shell.pendingInvitations'))
      validateDirectoryContinuation(
        sessions.has_more, sessions.next_cursor, null, deviceSessionPageCursors.current, copy('teamNetwork.shell.deviceSessions')
      )
      validateDirectoryContinuation(
        invitations.has_more, invitations.next_cursor, null, invitationPageCursors.current, copy('teamNetwork.shell.pendingInvitations')
      )
      if (!sessions.has_more) validateCompleteDeviceSessions(nextStatusSessionId(status), sessions.sessions)
      setDeviceSessions(sessions.sessions)
      setDeviceSessionsCursor(sessions.next_cursor)
      setDeviceSessionsHasMore(sessions.has_more)
      setPendingInvitations(invitations.invitations)
      setInvitationsCursor(invitations.next_cursor)
      setInvitationsHasMore(invitations.has_more)
    }).catch(cause => {
      if (active && dataEpoch.current === epoch && context === teamContextKey(status, selectedTeamId)) {
        setError(errorMessage(cause))
      }
    }).finally(() => {
      if (active && dataEpoch.current === epoch && context === teamContextKey(status, selectedTeamId)) {
        setDirectoryLoading(false)
      }
    })
    return () => { active = false }
  }, [
    details?.membership.role,
    details?.team.id,
    section,
    selectedTeamId,
    status?.authenticationMode,
    status?.generation,
    status?.profileGeneration,
    status?.profileId,
    status?.serverManaged
  ])

  const loadMoreServers = async () => {
    if (
      !status || !selectedTeamId || !capabilities || !projection
      || !projectionHasMore || !projectionAfterServerId || busy
    ) return
    const teamId = selectedTeamId
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    const cursor = projectionAfterServerId
    setBusy('network-page')
    setError(null)
    try {
      const page = await window.agentsDock.teamHub.network(scopeFrom(status), {
        teamId,
        afterServerId: cursor,
        limit: capabilities.max_page_items
      })
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return
      // Merge against the synchronously maintained latest projection while
      // still inside this try/catch. React may defer state-updater execution;
      // throwing from a functional updater would otherwise escape here and
      // could crash the subtree after a concurrent roster mutation.
      if (!updateProjection(current => mergeNetworkProjection(current, page))) return
      setProjectionAfterServerId(page.next_after_server_id)
      setProjectionHasMore(page.has_more)
    } catch (cause) {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
    } finally {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const loadMoreMembers = async () => {
    if (!status || !selectedTeamId || !details?.membersHasMore || !details.membersNextCursor || busy || directoryLoading) return
    const teamId = selectedTeamId
    const cursor = details.membersNextCursor
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    setBusy('members-page')
    setError(null)
    try {
      const page = await window.agentsDock.teamHub.members(scopeFrom(status), teamId, cursor)
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return
      validateDirectoryContinuation(
        page.has_more, page.next_cursor, cursor, memberPageCursors.current, copy('teamNetwork.shell.teamMembers')
      )
      const mergedMembers = mergeDirectoryPage(
        details.members,
        page.members,
        member => member.principal_id,
        copy('teamNetwork.shell.teamMembers')
      )
      if (!page.has_more) validateCompleteMemberDirectory(details, status, mergedMembers)
      memberPageCursors.current.add(cursor)
      setDetails(current => current ? {
        ...current,
        members: mergedMembers,
        membersHasMore: page.has_more,
        membersNextCursor: page.next_cursor
      } : current)
    } catch (cause) {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
    } finally {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const loadMoreInvitations = async () => {
    if (!status || !selectedTeamId || !invitationsHasMore || !invitationsCursor || busy || directoryLoading) return
    const teamId = selectedTeamId
    const cursor = invitationsCursor
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    setBusy('invitations-page')
    setError(null)
    try {
      const page = await window.agentsDock.teamHub.invitations(scopeFrom(status), teamId, cursor)
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return
      validateDirectoryContinuation(
        page.has_more, page.next_cursor, cursor, invitationPageCursors.current, copy('teamNetwork.shell.pendingInvitations')
      )
      const mergedInvitations = mergeDirectoryPage(
        pendingInvitations,
        page.invitations,
        invitation => invitation.id,
        copy('teamNetwork.shell.pendingInvitations')
      )
      invitationPageCursors.current.add(cursor)
      setPendingInvitations(mergedInvitations)
      setInvitationsCursor(page.next_cursor)
      setInvitationsHasMore(page.has_more)
    } catch (cause) {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
    } finally {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const loadMoreDeviceSessions = async () => {
    if (!status || !deviceSessionsHasMore || !deviceSessionsCursor || busy || directoryLoading) return
    const cursor = deviceSessionsCursor
    const epoch = dataEpoch.current
    const context = selectedTeamId ? teamContextKey(status, selectedTeamId) : null
    setBusy('device-sessions-page')
    setError(null)
    try {
      const page = await window.agentsDock.teamHub.deviceSessions(scopeFrom(status), cursor)
      if (dataEpoch.current !== epoch || !selectedTeamId || context !== teamContextKey(status, selectedTeamId)) return
      validateDirectoryContinuation(
        page.has_more, page.next_cursor, cursor, deviceSessionPageCursors.current, copy('teamNetwork.shell.deviceSessions')
      )
      const mergedSessions = mergeDirectoryPage(
        deviceSessions,
        page.sessions,
        session => session.id,
        copy('teamNetwork.shell.deviceSessions')
      )
      if (!page.has_more) validateCompleteDeviceSessions(nextStatusSessionId(status), mergedSessions)
      deviceSessionPageCursors.current.add(cursor)
      setDeviceSessions(mergedSessions)
      setDeviceSessionsCursor(page.next_cursor)
      setDeviceSessionsHasMore(page.has_more)
    } catch (cause) {
      if (dataEpoch.current === epoch) setError(errorMessage(cause))
    } finally {
      if (dataEpoch.current === epoch) setBusy(null)
    }
  }

  const revokeDeviceSession = async (session: TeamHubDeviceSession): Promise<boolean> => {
    if (!status || session.current || busy || directoryLoading) return false
    const epoch = dataEpoch.current
    setBusy(`revoke-session:${session.id}`)
    setError(null)
    try {
      await window.agentsDock.teamHub.revokeDeviceSession(scopeFrom(status), session.id)
      if (dataEpoch.current !== epoch) return false
      setDeviceSessions(current => current.filter(candidate => candidate.id !== session.id))
      setNotice(copy('teamNetwork.shell.deviceSignedOut', { device: session.device_label }))
      return true
    } catch (cause) {
      if (dataEpoch.current === epoch) setError(errorMessage(cause))
      return false
    } finally {
      if (dataEpoch.current === epoch) setBusy(null)
    }
  }

  const revokeInvitation = async (invitation: TeamHubInvitationSummary): Promise<boolean> => {
    if (!status || !selectedTeamId || busy || directoryLoading) return false
    const teamId = selectedTeamId
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    setBusy(`revoke-invitation:${invitation.id}`)
    setError(null)
    try {
      await window.agentsDock.teamHub.revokeInvitation(scopeFrom(status), teamId, invitation.id)
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return false
      setPendingInvitations(current => current.filter(candidate => candidate.id !== invitation.id))
      setNotice(copy('teamNetwork.shell.invitationRevoked', { email: invitation.invitee_email }))
      return true
    } catch (cause) {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
      return false
    } finally {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const updateMember = async (
    member: TeamHubMembership,
    patch: { role: 'admin' | 'member' | 'guest' } | { status: 'active' | 'suspended' | 'revoked' }
  ): Promise<boolean> => {
    if (!status || !selectedTeamId || busy || directoryLoading) return false
    const teamId = selectedTeamId
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    setBusy(`update-member:${member.principal_id}`)
    setError(null)
    try {
      const updated = await window.agentsDock.teamHub.updateMember(scopeFrom(status), {
        teamId, principalId: member.principal_id, patch
      })
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return false
      setDetails(current => current ? {
        ...current,
        members: updated.status === 'revoked'
          ? current.members.filter(candidate => candidate.principal_id !== updated.principal_id)
          : current.members.map(candidate => candidate.principal_id === updated.principal_id ? updated : candidate)
      } : current)
      mutationEpoch.current += 1
      invalidateTeamNetworkSnapshot(status, teamId)
      setNotice(copy('teamNetwork.shell.memberUpdated', { name: member.display_name }))
      return true
    } catch (cause) {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
      return false
    } finally {
      if (dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const adoptWorkspace = useCallback((next: TeamHubWorkspace, preferredTeamId?: string | null) => {
    setStatus(next.status)
    setWorkspace(next)
    const teamId = preferredTeamId && next.teams.some(team => team.id === preferredTeamId)
      ? preferredTeamId
      : next.teams[0]?.id ?? null
    if (teamId) void loadTeamData(next.status, next, teamId)
    else {
      clearTeamData()
      setSelectedTeamId(null)
      setBusy(null)
    }
  }, [clearTeamData, loadTeamData])

  const loadStatus = useCallback(async (refreshFrom?: TeamHubStatus) => {
    const request = ++lifecycleEpoch.current
    dataEpoch.current += 1
    const mayUseOpeningSnapshot = initialOpenRef.current
    initialOpenRef.current = false
    setBusy(refreshFrom?.authenticated ? 'team-refresh' : 'opening')
    setError(null)
    setNotice(null)
    let statusResolved = false
    try {
      const nextStatus = await window.agentsDock.teamHub.status()
      if (lifecycleEpoch.current !== request) return
      statusResolved = true
      setStatus(nextStatus)
      if (!nextStatus.authenticated) {
        setWorkspace(null)
        setSelectedTeamId(null)
        clearTeamData()
        setBusy(null)
        return
      }
      const cachedWorkspace = mayUseOpeningSnapshot ? peekTeamNetworkWorkspace(nextStatus) : null
      if (cachedWorkspace) {
        // A freshly checked local status proves the exact authority lifecycle.
        // Paint that lifecycle's prior snapshot immediately and revalidate the
        // workspace in the background; the core loader does the same below.
        adoptWorkspace(cachedWorkspace, messageTargetRef.current?.teamId ?? initialMailboxTarget?.teamId ?? selectedTeamIdRef.current)
        void loadTeamNetworkWorkspace(nextStatus, { force: true }).then(refreshed => {
          if (lifecycleEpoch.current !== request) return
          if (workspaceRevision(refreshed) !== workspaceRevision(cachedWorkspace)) {
            adoptWorkspace(refreshed, messageTargetRef.current?.teamId ?? initialMailboxTarget?.teamId ?? selectedTeamIdRef.current)
          }
        }).catch(cause => {
          if (lifecycleEpoch.current === request) setNotice(copy('teamNetwork.shell.refreshFailed', { error: errorMessage(cause) }))
        })
        return
      }
      // A manual refresh keeps the current view only while the freshly
      // authenticated scope is identical. Changed/revoked scopes still clear
      // immediately; a refresh must never display another session's cache.
      const sameRefreshScope = refreshFrom?.authenticated
        && teamNetworkSnapshotKey(refreshFrom) === teamNetworkSnapshotKey(nextStatus)
      if (!sameRefreshScope) {
        setWorkspace(null)
        setSelectedTeamId(null)
        clearTeamData()
        setBusy('opening')
      }
      const nextWorkspace = await loadTeamNetworkWorkspace(nextStatus, { force: !mayUseOpeningSnapshot })
      if (lifecycleEpoch.current !== request) return
      adoptWorkspace(nextWorkspace, messageTargetRef.current?.teamId ?? initialMailboxTarget?.teamId ?? selectedTeamIdRef.current)
    } catch (cause) {
      if (lifecycleEpoch.current === request) {
        // Until status resolves, cached data is only an optimistic local
        // paint. A failed authority check must remove it immediately.
        if (!statusResolved) {
          setStatus(null)
          setWorkspace(null)
          setSelectedTeamId(null)
          clearTeamData()
        }
        setBusy(null)
        setError(errorMessage(cause))
      }
    }
  }, [adoptWorkspace, clearTeamData, initialMailboxTarget?.teamId, openingSnapshot])

  useEffect(() => {
    void loadStatus()
    return () => {
      lifecycleEpoch.current += 1
      dataEpoch.current += 1
    }
  }, [loadStatus])

  const connectNetwork = useCallback(async (
    reconnectStatus?: TeamHubStatus,
    reconnectMode: 'background' | 'surface' = 'background'
  ) => {
    const request = ++lifecycleEpoch.current
    setBusy('connect')
    setError(null)
    try {
      const reconnectScope = reconnectStatus?.serverIdentity
        ? {
            profileId: reconnectStatus.profileId,
            profileGeneration: reconnectStatus.profileGeneration,
            serverIdentity: reconnectStatus.serverIdentity,
            generation: reconnectStatus.generation
          }
        : null
      const nextStatus = reconnectScope
        ? await window.agentsDock.teamHub.connect(reconnectMode === 'surface'
          ? { surfaceReconnect: reconnectScope }
          : { backgroundReconnect: reconnectScope })
        : await window.agentsDock.teamHub.connect()
      if (lifecycleEpoch.current !== request) return false
      setStatus(nextStatus)
      setWorkspace(null)
      setSelectedTeamId(null)
      clearTeamData()
      if (!nextStatus.authenticated) {
        setBusy(null)
        if (nextStatus.error) setError(nextStatus.error)
        return false
      }
      const nextWorkspace = await window.agentsDock.teamHub.workspace(scopeFrom(nextStatus))
      if (lifecycleEpoch.current !== request) return false
      adoptWorkspace(nextWorkspace)
      return true
    } catch (cause) {
      if (lifecycleEpoch.current === request) {
        setBusy(null)
        setError(errorMessage(cause))
      }
      return false
    }
  }, [adoptWorkspace, clearTeamData])

  const reconnectNetwork = useCallback(async () => {
    // Only a direct user action clears the guard for this open surface and
    // asks discovery to verify the currently advertised Hub again.
    suppressAutoConnectForProfile.current = null
    setError(null)
    setNotice(null)
    return connectNetwork()
  }, [connectNetwork])

  const disconnectLocalBinding = useCallback(async () => {
    if (!status?.authenticated || !status.canForgetBinding || status.transport === 'secure_peer') return
    const request = ++lifecycleEpoch.current
    setBusy('disconnect-network')
    setError(null)
    setNotice(null)
    invalidateTeamNetworkSnapshot(status)
    try {
      const nextStatus = await window.agentsDock.teamHub.disconnect(scopeFrom(status))
      if (lifecycleEpoch.current !== request) return
      suppressAutoConnectForProfile.current = teamHubProfileKey(nextStatus)
      connectAttempt.current = teamHubLifecycleKey(nextStatus)
      setStatus(nextStatus)
      setWorkspace(null)
      setSelectedTeamId(null)
      clearTeamData()
      setNotice(nextStatus.error || (status.serverManaged
        ? copy('teamNetwork.shell.managedDisconnected', { server: status.serverName || copy('teamNetwork.shell.thisServerLower') })
        : copy('teamNetwork.shell.disconnectedSignedOut')))
    } catch (cause) {
      if (lifecycleEpoch.current === request) setError(errorMessage(cause))
    } finally {
      if (lifecycleEpoch.current === request) setBusy(null)
    }
  }, [clearTeamData, status])

  const forgetLocalBinding = useCallback(async () => {
    if (!status?.serverIdentity || !status.savedHubIdentity || !status.canForgetBinding || status.transport === 'secure_peer') return
    const request = ++lifecycleEpoch.current
    let bindingIdentity = forgetBindingInputFromStatus(status)
    setBusy('forget-network')
    setError(null)
    setNotice(null)
    invalidateTeamNetworkSnapshot(status)
    try {
      let disconnectWarning: string | null = null
      if (status.authenticated) {
        const disconnected = await window.agentsDock.teamHub.disconnect(scopeFrom(status))
        if (lifecycleEpoch.current !== request) return
        disconnectWarning = disconnected.error
        suppressAutoConnectForProfile.current = teamHubProfileKey(disconnected)
        connectAttempt.current = teamHubLifecycleKey(disconnected)
        setStatus(disconnected)
        setWorkspace(null)
        setSelectedTeamId(null)
        clearTeamData()
        bindingIdentity = forgetBindingInputFromStatus(disconnected)
      }
      const nextStatus = await window.agentsDock.teamHub.forgetBinding(bindingIdentity)
      if (lifecycleEpoch.current !== request) return
      // Do not let the ordinary disconnected-state bootstrap immediately
      // rediscover and save the binding that the user just removed.
      suppressAutoConnectForProfile.current = teamHubProfileKey(nextStatus)
      connectAttempt.current = teamHubLifecycleKey(nextStatus)
      setStatus(nextStatus)
      setWorkspace(null)
      setSelectedTeamId(null)
      clearTeamData()
      setConfirmForgetBinding(false)
      setNotice(disconnectWarning || (status.serverManaged
        ? copy('teamNetwork.shell.managedForgotten', { server: status.serverName || copy('teamNetwork.shell.theServer') })
        : copy('teamNetwork.shell.forgotLocal')))
    } catch (cause) {
      if (lifecycleEpoch.current === request) setError(errorMessage(cause))
    } finally {
      if (lifecycleEpoch.current === request) setBusy(null)
    }
  }, [clearTeamData, status])

  useEffect(() => {
    if (!status || status.authenticated || status.backgroundReconnectAllowed !== true || busy) return
    const reconnectable = status.serverManaged
      ? ['disconnected', 'offline', 'unavailable', 'error', 'signed-out'].includes(status.connectionState)
      : status.connectionState === 'disconnected'
    if (!reconnectable) return
    const profileKey = teamHubProfileKey(status)
    if (suppressAutoConnectForProfile.current === profileKey || connectAttempt.current === profileKey) return
    // Opening this surface permits one scoped attempt. Failure stays visible
    // until Retry; no timer may turn Team Network into background app work.
    connectAttempt.current = profileKey
    void connectNetwork(status, 'surface')
  }, [busy, connectNetwork, status])

  useEffect(() => {
    if (status?.transport !== 'secure_peer' && status?.serverIdentity) return
    setBindingManagerOpen(false)
    setConfirmForgetBinding(false)
  }, [status?.serverIdentity, status?.transport])

  useEffect(() => {
    setConfirmForgetBinding(false)
  }, [status?.profileId, status?.profileGeneration, status?.serverIdentity, status?.generation, status?.savedHubIdentity])

  useEffect(() => {
    setTeamMessageUnreadCount(0)
    setTeamMessageUnreadOverflow(false)
  }, [selectedTeamId, status?.profileGeneration, status?.profileId, status?.serverIdentity])

  const updateUnreadSnapshot = useCallback((count: number, hasMore: boolean) => {
    setTeamMessageUnreadCount(count)
    setTeamMessageUnreadOverflow(hasMore)
  }, [])

  useEffect(() => {
    if (!bindingManagerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy === 'connect' || busy === 'disconnect-network' || busy === 'forget-network') return
      event.preventDefault()
      setConfirmForgetBinding(false)
      setBindingManagerOpen(false)
      queueMicrotask(() => bindingManagerTriggerRef.current?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [bindingManagerOpen, busy])

  useEffect(() => {
    setPendingApprovals(0)
  }, [status?.profileGeneration, status?.profileId, status?.serverIdentity])

  const replaceDelivery = useCallback((delivery: TeamNetworkMailboxEntry['delivery']) => {
    setMailboxEntries(current => current.map(entry => entry.delivery.id === delivery.id ? { ...entry, delivery } : entry))
  }, [])

  const recordMailboxReceipt = useCallback(async (entry: TeamNetworkMailboxEntry, shouldRead: boolean, context: string, epoch: number) => {
    if (!status || !selectedTeamId || entry.delivery.state === 'read' || receiptInFlight.current.has(entry.delivery.id)) return
    receiptInFlight.current.add(entry.delivery.id)
    let state: TeamNetworkMailboxEntry['delivery']['state'] = entry.delivery.state
    try {
      if (state === 'available') {
        const delivered = await window.agentsDock.teamHub.recordDeliveryReceipt(scopeFrom(status), {
          teamId: selectedTeamId,
          deliveryId: entry.delivery.id,
          state: 'delivered',
          idempotencyKey: crypto.randomUUID()
        })
        if (dataEpoch.current !== epoch || context !== mailboxContextKey(status, selectedTeamId, mailboxAddress)) return
        state = delivered.state
        replaceDelivery(delivered)
      }
      if (shouldRead && state === 'delivered') {
        const read = await window.agentsDock.teamHub.recordDeliveryReceipt(scopeFrom(status), {
          teamId: selectedTeamId,
          deliveryId: entry.delivery.id,
          state: 'read',
          idempotencyKey: crypto.randomUUID()
        })
        if (dataEpoch.current !== epoch || context !== mailboxContextKey(status, selectedTeamId, mailboxAddress)) return
        replaceDelivery(read)
        window.dispatchEvent(new CustomEvent('agentsdock:team-network-mail-read', { detail: { deliveryId: read.id } }))
      }
    } catch (cause) {
      if (dataEpoch.current === epoch && context === mailboxContextKey(status, selectedTeamId, mailboxAddress)) setError(errorMessage(cause))
    } finally { receiptInFlight.current.delete(entry.delivery.id) }
  }, [mailboxAddress, replaceDelivery, selectedTeamId, status])

  const recordMailboxBundleRead = useCallback((entries: readonly TeamNetworkMailboxEntry[]) => {
    if (!status || !selectedTeamId || !mailboxAddress) return
    const epoch = dataEpoch.current
    const context = mailboxContextKey(status, selectedTeamId, mailboxAddress)
    for (const entry of entries) void recordMailboxReceipt(entry, true, context, epoch)
  }, [mailboxAddress, recordMailboxReceipt, selectedTeamId, status])

  useEffect(() => {
    if (teamMessagesCapability || !status?.authenticated || !selectedTeamId || !mailboxAddress) {
      setMailboxEntries([])
      return
    }
    const teamId = selectedTeamId
    const address = mailboxAddress
    const scope = scopeFrom(status)
    const epoch = dataEpoch.current
    const context = mailboxContextKey(status, teamId, address)
    let active = true
    let inFlight = false
    setMailboxEntries([])
    const poll = async (afterSequence: number) => {
      if (!active || inFlight) return
      inFlight = true
      try {
        const page = await window.agentsDock.teamHub.mailbox(scope, { teamId, address, afterSequence })
        if (
          !active
          || dataEpoch.current !== epoch
          || !sameAddress(mailboxAddressRef.current, address)
          || context !== mailboxContextKey(status, teamId, address)
        ) return
        setMailboxEntries(current => mergeMailbox(current, page.items))
        for (const entry of page.items) void recordMailboxReceipt(entry, false, context, epoch)
      } catch (cause) {
        if (active && dataEpoch.current === epoch && context === mailboxContextKey(status, teamId, address)) setError(errorMessage(cause))
      } finally { inFlight = false }
    }
    // Initial/manual loads only. The server owns queued mail; the renderer
    // must not keep requesting it on a recurring timer.
    void poll(0)
    return () => { active = false }
  }, [mailboxAddress?.id, mailboxAddress?.kind, recordMailboxReceipt, selectedTeamId, status, teamMessagesCapability])

  const createNetwork = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!status || busy) return
    const form = new FormData(event.currentTarget)
    const teamName = formValue(form, 'teamName')
    if (!teamName) return
    const request = ++lifecycleEpoch.current
    setBusy('create')
    setError(null)
    try {
      const created = await window.agentsDock.teamHub.bootstrap({ profileScope: profileScope(status), teamName })
      if (lifecycleEpoch.current === request) adoptWorkspace(created)
    } catch (cause) {
      if (lifecycleEpoch.current === request) { setError(errorMessage(cause)); setBusy(null) }
    }
  }

  const useInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy('invitation')
    setError(null)
    try {
      adoptWorkspace(await window.agentsDock.teamHub.join({
        email: formValue(form, 'email'),
        displayName: formValue(form, 'displayName'),
        deviceLabel: formValue(form, 'deviceLabel')
      }))
    } catch (cause) { setError(errorMessage(cause)); setBusy(null) }
  }

  const recoverDevice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const request = ++lifecycleEpoch.current
    setBusy('recovery')
    setError(null)
    try {
      const recovered = await window.agentsDock.teamHub.recoverDevice({
        deviceLabel: formValue(form, 'deviceLabel')
      })
      if (lifecycleEpoch.current !== request) return
      adoptWorkspace(recovered)
    } catch (cause) {
      if (lifecycleEpoch.current === request) {
        setError(errorMessage(cause))
        setBusy(null)
      }
    }
  }

  const postBulletin = async (body: string): Promise<boolean> => {
    if (!status || !selectedTeamId || !capabilities || bodyBytes(body) > capabilities.max_body_bytes) {
      setError(copy('teamNetwork.shell.postTooLarge'))
      return false
    }
    const teamId = selectedTeamId
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    setBusy('post-bulletin')
    setError(null)
    try {
      const post = await window.agentsDock.teamHub.postBulletin(scopeFrom(status), {
        teamId,
        body,
        bodyFormat: 'plain',
        idempotencyKey: crypto.randomUUID()
      })
      if (dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return false
      setBulletinPosts(current => mergeBulletin(current, [post]))
      mutationEpoch.current += 1
      invalidateTeamNetworkSnapshot(status, teamId)
      // A newly-created post can be ahead of unseen pages. Only list responses
      // advance the contiguous fetch cursor; polling will later deduplicate it.
      return true
    } catch (cause) { if (dataEpoch.current === epoch) setError(errorMessage(cause)); return false }
    finally { if (dataEpoch.current === epoch) setBusy(null) }
  }

  const removeNetworkServer = async (server: TeamNetworkServer): Promise<boolean> => {
    if (
      busy || serverRemovalInFlight.current
      || !status?.designatedHost || !selectedTeamId || !details
      || !canManageNetworkServers(status, details)
      || server.is_host || server.owned_by_caller || server.server_identity === status.serverIdentity
    ) return false
    const teamId = selectedTeamId
    const request = ++serverRemovalRequest.current
    const epoch = dataEpoch.current
    const context = teamContextKey(status, teamId)
    serverRemovalInFlight.current = true
    setBusy(`remove-server:${server.id}`)
    setError(null)
    setNotice(null)
    try {
      const pairings = await window.agentsDock.teamHub.securePeers(scopeFrom(status), teamId)
      if (serverRemovalRequest.current !== request || dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return false
      const matching = pairings.filter(pairing => (
        pairing.direction === 'incoming'
        && pairing.peerServerIdentity === server.server_identity
        && pairing.trustState === 'approved'
        && ['approved', 'connected'].includes(pairing.status)
        && pairing.connectionId
        && pairing.certificateFingerprint
      ))
      if (matching.length !== 1) {
        throw new NetworkError(matching.length
          ? copy('teamNetwork.shell.multipleSecureConnections')
          : copy('teamNetwork.shell.noSecureConnection'))
      }
      const pairing = matching[0]
      await window.agentsDock.teamHub.revokeSecurePeer(scopeFrom(status), teamId, {
        peerId: pairing.connectionId!,
        expectedCertificateFingerprint: pairing.certificateFingerprint!,
        idempotencyKey: crypto.randomUUID()
      })
      if (serverRemovalRequest.current !== request || dataEpoch.current !== epoch || context !== teamContextKey(status, teamId)) return false
      updateProjection(current => ({
        ...current,
        servers: current.servers.filter(candidate => candidate.id !== server.id),
        agents: current.agents.filter(candidate => candidate.server_id !== server.id)
      }))
      mutationEpoch.current += 1
      invalidateTeamNetworkSnapshot(status, teamId)
      setNotice(copy('teamNetwork.shell.serverRemoved', { server: server.display_name }))
      return true
    } catch (cause) {
      if (serverRemovalRequest.current === request && dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
      return false
    } finally {
      if (serverRemovalRequest.current === request) serverRemovalInFlight.current = false
      if (serverRemovalRequest.current === request && dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
    }
  }

  const renameHostServer = async (server: TeamNetworkServer, rawName: string): Promise<boolean> => {
    if (busy || hostRenameInFlight.current || !status || !details || !workspace || !selectedTeamId
      || !canRenameOwnHost(status, details, server)) return false
    const name = rawName.trim()
    if (!name || bodyBytes(name) > 160 || /[\u0000-\u001f\u007f]/.test(name)) return false
    const teamId = selectedTeamId
    const teamName = details.team.display_name
    const epoch = lifecycleEpoch.current
    const active = () => {
      const app = useAppStore.getState()
      const profile = app.profiles.find(item => item.id === app.activeProfileId)
      return lifecycleEpoch.current === epoch && selectedTeamIdRef.current === teamId
        && app.activeProfileId === status.profileId && app.profileGeneration === status.profileGeneration
        && !app.switchingProfileId && profile?.serverIdentity === status.serverIdentity
    }
    if (!active()) { setError(copy('teamNetwork.shell.renameServerChanged')); return false }
    hostRenameInFlight.current = true
    setBusy('rename-host')
    setError(null)
    setNotice(null)
    try {
      const fresh = await window.agentsDock.teamHub.status()
      const owned = projectionRef.current?.servers.find(item => item.id === server.id)
      if (!active() || teamContextKey(fresh, teamId) !== teamContextKey(status, teamId)
        || !owned || !canRenameOwnHost(fresh, details, owned)) throw new NetworkError(copy('teamNetwork.shell.renameHostChanged'))
      const next = await window.agentsDock.teamHub.configureServerRole(profileScope(fresh), {
        role: 'host', serverName: name, renameOnly: true
      })
      if (!active()) return false
      if (teamHubProfileKey(next) !== teamHubProfileKey(status) || next.hubIdentity !== status.hubIdentity
        || next.serverName !== name || !canRenameOwnHost(next, details, owned)) {
        throw new NetworkError(copy('teamNetwork.shell.renameUnconfirmed'))
      }
      mutationEpoch.current += 1
      invalidateTeamNetworkSnapshot(status, teamId)
      invalidateTeamNetworkSnapshot(next, teamId)
      const nextWorkspace = { ...workspace, status: next }
      setStatus(next)
      setWorkspace(nextWorkspace)
      await loadTeamData(next, nextWorkspace, teamId, { visibleRefresh: true })
      if (active()) setNotice(copy('teamNetwork.shell.hostRenamed', { name, team: teamName }))
      return true
    } catch (cause) {
      if (active()) setError(errorMessage(cause))
      return false
    } finally {
      hostRenameInFlight.current = false
      if (active()) setBusy(null)
    }
  }

  const openBindingManager = () => {
    setConfirmForgetBinding(false)
    setError(null)
    setNotice(null)
    setBindingManagerOpen(true)
  }
  const closeBindingManager = () => {
    if (busy === 'connect' || busy === 'disconnect-network' || busy === 'forget-network') return
    setConfirmForgetBinding(false)
    setBindingManagerOpen(false)
    queueMicrotask(() => bindingManagerTriggerRef.current?.focus())
  }
  const localBindingWasStopped = Boolean(
    status
    && status.serverIdentity
    && status.transport !== 'secure_peer'
    && suppressAutoConnectForProfile.current === teamHubProfileKey(status)
  )
  const unreadMailboxCount = teamMessagesCapability
    ? teamMessageUnreadCount
    : mailboxEntries.filter(entry => entry.delivery.state !== 'read').length
  const unreadMailboxLabel = teamMessagesCapability && teamMessageUnreadOverflow
    ? (unreadMailboxCount ? `${unreadMailboxCount}+` : '…')
    : String(unreadMailboxCount)
  const activeTeamScope = useMemo(() => (
    status?.authenticated && status.serverIdentity ? scopeFrom(status) : null
  ), [
    status?.authenticated,
    status?.connectionId,
    status?.generation,
    status?.hostServerIdentity,
    status?.hubIdentity,
    status?.profileGeneration,
    status?.profileId,
    status?.serverIdentity
  ])
  const canInvite = Boolean(status?.designatedHost && status.serverIdentity)
  const humanDirectory = status?.authenticationMode === 'human' && !status.serverManaged
  const teamMessageAddresses = useMemo(() => (
    projection && status ? ownedTeamMessageAddresses(projection, status) : []
  ), [projection, status])
  const hasManageableLocalBinding = Boolean(
    status?.serverIdentity
    && status.savedHubIdentity
    && status.canForgetBinding
    && status.transport !== 'secure_peer'
  )
  const canStartLocalConnection = Boolean(
    status?.serverIdentity
    && !status.authenticated
    && status.connectionState === 'disconnected'
    && !status.savedHubIdentity
    && !status.canForgetBinding
    && status.transport !== 'secure_peer'
  )
  const bindingManagerLabel = status?.serverManaged ? t('teamNetwork.shell.manageConnection') : t('teamNetwork.shell.manageNetwork')
  const localBindingAction = hasManageableLocalBinding
    ? <button ref={bindingManagerTriggerRef} type="button" className="quiet-button network-manage-binding-action" aria-label={bindingManagerLabel} disabled={Boolean(busy)} onClick={openBindingManager}><Settings2 size={14} />{bindingManagerLabel}</button>
    : status && !status.serverManaged && status.transport !== 'secure_peer' && (localBindingWasStopped || canStartLocalConnection)
      ? <button type="button" className="quiet-button network-manage-binding-action" aria-label={t('teamNetwork.shell.connectNetwork')} disabled={Boolean(busy)} onClick={() => void reconnectNetwork()}><RefreshCw size={14} />{t('teamNetwork.shell.connectNetwork')}</button>
      : null
  const bindingLifecycleBusy = busy === 'connect' || busy === 'disconnect-network' || busy === 'forget-network'
  const localBindingManager = status && bindingManagerOpen && status.transport !== 'secure_peer'
    ? <LocalBindingManager
        status={status}
        busy={bindingLifecycleBusy}
        confirmingForget={confirmForgetBinding}
        error={error}
        notice={notice}
        onClose={closeBindingManager}
        onDisconnect={() => void disconnectLocalBinding()}
        onReconnect={() => void reconnectNetwork()}
        onRequestForget={() => setConfirmForgetBinding(true)}
        onCancelForget={() => setConfirmForgetBinding(false)}
        onForget={() => void forgetLocalBinding()}
      />
    : null
  const onboardingCopy = status?.serverManaged
    ? status.backgroundReconnectAllowed === false
      ? {
          title: t('teamNetwork.shell.teamspacePaused'),
          description: t('teamNetwork.shell.pausedDescription', { server: status.serverName || t('teamNetwork.shell.selectedAgentsServer') })
        }
      : {
          title: t('teamNetwork.shell.connectingTeamspace', { server: status.serverName || t('teamNetwork.shell.thisServerLower') }),
          description: t('teamNetwork.shell.teamspaceRetryDescription')
        }
    : localBindingWasStopped && !status?.canForgetBinding
      ? {
          title: t('teamNetwork.shell.localForgotten'),
          description: t('teamNetwork.shell.noAutomaticReconnect')
        }
      : status?.canForgetBinding && status.connectionState === 'disconnected'
        ? {
            title: t('teamNetwork.shell.localDisconnected'),
            description: t('teamNetwork.shell.savedNetworkDescription')
          }
        : status?.connectionState === 'signed-out' && status.transport !== 'secure_peer'
          ? {
              title: t('teamNetwork.shell.connectYourNetwork'),
              description: t('teamNetwork.shell.reconnectTeamDescription')
            }
          : status?.designatedHost
          ? {
              title: t('teamNetwork.shell.createYourNetwork'),
              description: t('teamNetwork.shell.hostSetupDescription')
            }
          : {
              title: t('teamNetwork.shell.setupNetwork'),
              description: t('teamNetwork.shell.setupNetworkDescription')
            }

  const reconnectProfileKey = status ? teamHubProfileKey(status) : ''
  const startHostSetup = () => {
    if (!status?.serverIdentity) {
      setError(copy('teamNetwork.shell.identityNotVerified'))
      return
    }
    const origin = {
      profileId: status.profileId,
      profileGeneration: status.profileGeneration,
      serverIdentity: status.serverIdentity,
      serverName: status.serverName?.trim() || t('teamNetwork.shell.selectedServerName')
    }
    onClose()
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('agentsdock:server-setup', {
      detail: { mode: 'configure-active', intent: 'host-team-network', origin }
    })))
  }
  const pendingInviteNotice = pendingSecurePeerInvite ? <PendingInviteNotice
    status={status}
    onCancel={() => onSecurePeerInviteHandled?.(pendingSecurePeerInvite.id)}
  /> : null
  const passiveConnectionOpening = Boolean(
    status
    && !status.authenticated
    && status.backgroundReconnectAllowed === true
    && suppressAutoConnectForProfile.current !== reconnectProfileKey
    && status.connectionState === 'connecting'
  )

  // A reconnect is not a terminal onboarding/error state. Keep the surface in
  // its truthful loading view while Team Hub authentication and the matching
  // workspace are still being adopted; otherwise an ordinary in-flight
  // reconnect can briefly flash "connection incomplete" or "could not be
  // loaded" before succeeding on its own.
  if (!status && openingSnapshot && busy === 'opening' && !error && !pendingSecurePeerInvite) return <TeamNetworkOpeningShell onClose={onClose} section={section} />

  if (!status || busy === 'opening' || busy === 'connect' || passiveConnectionOpening) return <NetworkShell status={status} onClose={onClose}>
    <div className="teamspace-empty">{pendingInviteNotice}{error ? <><strong>{error}</strong><button className="primary-button" onClick={() => void loadStatus()}>{t('teamNetwork.shell.retry')}</button></> : <><LoaderCircle className="spin" size={18} />{t('teamNetwork.shell.opening')}</>}</div>
    {status && passiveConnectionOpening && !status.serverManaged && !status.designatedHost && <div hidden aria-hidden="true"><SecurePeerPanel
      status={status}
      networkError={error ?? status.error}
      onActivated={connectNetwork}
      connectionAttemptInFlight={busy === 'connect'}
    /></div>}
  </NetworkShell>

  if (status.authenticated && !workspace) return <NetworkShell status={status} onClose={onClose} actions={localBindingAction}>
    <div className="teamspace-onboarding">
      <div className="teamspace-onboarding-card network-onboarding-card">
        <div className="network-onboarding-hero" role="alert">
          <div className="teamspace-kicker"><Server size={15} /> {t('teamNetwork.shell.title')}</div>
          <h1>{t('teamNetwork.shell.workspaceLoadFailed')}</h1>
          <p>{error || t('teamNetwork.shell.workspaceUnavailable')}</p>
          <button type="button" className="primary-button" onClick={() => void loadStatus()}>{t('teamNetwork.shell.retryTeamspace')}</button>
        </div>
        <ServerIdentity status={status} />
        {pendingInviteNotice}
      </div>
    </div>
  </NetworkShell>

  if (!status.authenticated || !workspace) return <NetworkShell status={status} onClose={onClose} actions={localBindingAction}>
    <div className="teamspace-onboarding">
      <div className="teamspace-onboarding-card network-onboarding-card">
        <div className="network-onboarding-hero">
          <div className="teamspace-kicker"><Server size={15} /> {t('teamNetwork.shell.title')}</div>
          <h1>{onboardingCopy.title}</h1>
          <p>{onboardingCopy.description}</p>
        </div>
        <ServerIdentity status={status} />
        {pendingInviteNotice}
        {!status.serverManaged && status.designatedHost && status.connectionState === 'needs-bootstrap' && <CreateNetworkForm busy={busy} onSubmit={createNetwork} />}
        {!status.serverManaged && status.designatedHost && status.connectionState === 'signed-out' && <><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void reconnectNetwork()}>{t('teamNetwork.shell.reconnectServer')}</button><details className="network-more"><summary>{t('teamNetwork.shell.legacyAccount')}</summary><UseInvitationForm busy={busy} onSubmit={useInvitation} /><RecoverDeviceForm busy={busy} onSubmit={recoverDevice} /></details></>}
        {!status.serverManaged && !status.designatedHost && <><button type="button" className="network-create-host" disabled={Boolean(busy) || !status.serverIdentity} onClick={startHostSetup}>
          <span className="network-create-host-icon"><RadioTower size={19} /></span>
          <span><strong>{t('teamNetwork.shell.startHere')}</strong><small>{t('teamNetwork.shell.makeHost', { server: status.serverName || t('teamNetwork.shell.thisServerLower') })}</small></span>
          <ChevronRight size={17} />
        </button><div className="network-onboarding-divider"><span>{t('teamNetwork.shell.joinExisting')}</span></div><SecurePeerPanel
          status={status}
          networkError={error ?? status.error}
          initialInvite={pendingSecurePeerInvite?.invite}
          initialInviteRequestId={pendingSecurePeerInvite?.id}
          onInitialInviteHandled={onSecurePeerInviteHandled}
          onConnectionChanged={loadStatus}
          onActivated={connectNetwork}
          onRetryConnection={reconnectNetwork}
          connectionAttemptInFlight={busy === 'connect'}
        />{status.connectionState === 'signed-out' && status.transport !== 'secure_peer' && <details className="network-more"><summary>{t('teamNetwork.shell.legacyAccount')}</summary><UseInvitationForm busy={busy} onSubmit={useInvitation} /><RecoverDeviceForm busy={busy} onSubmit={recoverDevice} /></details>}</>}
        {status.serverManaged && <div className="teamspace-host-help"><strong>{status.availabilityMessage || status.error || t('teamNetwork.shell.waitingServer', { server: status.serverName || t('teamNetwork.shell.selectedServerLower') })}</strong><button className="primary-button" onClick={() => void reconnectNetwork()}>{status.backgroundReconnectAllowed === false ? t('teamNetwork.shell.reconnect') : t('teamNetwork.shell.retryNow')}</button></div>}
        {!status.serverManaged && status.designatedHost && ['offline', 'unavailable', 'error'].includes(status.connectionState) && <div className="teamspace-host-help"><strong>{status.availabilityMessage || status.error || t('teamNetwork.shell.serverUnavailable')}</strong><button className="primary-button" onClick={() => void reconnectNetwork()}>{t('teamNetwork.shell.retry')}</button></div>}
        {status.designatedHost && error && <div className="teamspace-error" role="alert">{error}</div>}
      </div>
    </div>
    {localBindingManager}
  </NetworkShell>

  return <NetworkShell status={status} onClose={onClose} actions={<>
    {projection && <div className="network-header-summary" aria-label={t(projectionHasMore ? 'teamNetwork.shell.serverCountMore' : projection.servers.length === 1 ? 'teamNetwork.shell.serverCountOne' : 'teamNetwork.shell.serverCountOther', { count: projection.servers.length })}>
      <span><Server size={13} /><strong>{projection.servers.length}{projectionHasMore && '+'}</strong>{projection.servers.length === 1 && !projectionHasMore ? t('teamNetwork.shell.serverSingular') : t('teamNetwork.shell.serverPlural')}</span>
    </div>}
    {localBindingAction}
    {(canInvite || !status.serverManaged) && <Dialog.Root open={inviteOpen} onOpenChange={setInviteOpen}>
      <Dialog.Trigger asChild><button className="quiet-button network-invite-action" aria-label={status.designatedHost ? t('teamNetwork.shell.invite') : t('teamNetwork.shell.connectServer')}>{status.designatedHost ? <UserPlus size={14} /> : <KeyRound size={14} />}{status.designatedHost ? t('teamNetwork.shell.invite') : t('teamNetwork.shell.connectServer')}{status.designatedHost && pendingApprovals > 0 && <b className="network-nav-badge" aria-label={t('teamNetwork.shell.waitingCount', { count: pendingApprovals })}>{pendingApprovals}</b>}</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="network-invite-backdrop">
          <Dialog.Content className="network-invite-sheet" onOpenAutoFocus={event => {
            event.preventDefault()
            inviteCloseButtonRef.current?.focus()
          }}>
            <header>
              <Dialog.Title className="sr-only">{t('teamNetwork.shell.inviteConnectServers')}</Dialog.Title>
              <div><strong>{status.designatedHost ? t('teamNetwork.shell.inviteYourTeam') : t('teamNetwork.shell.serverConnection')}</strong><Dialog.Description asChild><span>{status.serverName}</span></Dialog.Description></div>
              <Dialog.Close asChild><button ref={inviteCloseButtonRef} type="button" className="icon-button" aria-label={t('teamNetwork.shell.closeInvite')}><X size={16} /></button></Dialog.Close>
            </header>
            <div>{pendingInviteNotice}<SecurePeerPanel
              status={status}
              details={details}
              workspace={workspace}
              initialInvite={status.designatedHost ? null : pendingSecurePeerInvite?.invite}
              initialInviteRequestId={status.designatedHost ? undefined : pendingSecurePeerInvite?.id}
              onInitialInviteHandled={onSecurePeerInviteHandled}
              onConnectionChanged={loadStatus}
              onActivated={connectNetwork}
              connectionAttemptInFlight={busy === 'connect'}
              onPendingCountChange={setPendingApprovals}
            /></div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>}
    <button className="icon-button" aria-label={t('teamNetwork.shell.refresh')} title={t('teamNetwork.shell.refreshDescription')} disabled={Boolean(busy)} onClick={() => void loadStatus(status)}><RefreshCw className={busy === 'team' || busy === 'team-refresh' ? 'spin' : ''} size={15} /></button>
  </>}>
    <div className="teamspace-body network-body team-network-body">
      <nav className="teamspace-nav team-network-nav" aria-label={t('teamNetwork.shell.sections')}>
        <div className="team-network-nav-heading"><span>{t('teamNetwork.shell.workspace')}</span><strong>{details?.team.display_name || workspace.teams.find(team => team.id === selectedTeamId)?.display_name || t('teamNetwork.shell.title')}</strong></div>
        {workspace.teams.length > 1 && <label className="teamspace-team-picker">{t('teamNetwork.shell.team')}<select value={selectedTeamId ?? ''} onChange={event => event.target.value && void loadTeamData(status, workspace, event.target.value)}>{workspace.teams.map(team => <option key={team.id} value={team.id}>{team.display_name}</option>)}</select></label>}
        <button
          className={section === 'mail' ? 'active' : ''}
          aria-label={t('teamNetwork.shell.mail')}
          aria-describedby={[unreadMailboxCount || teamMessageUnreadOverflow ? 'team-network-mailbox-unread' : '', newMailArrivals ? 'team-network-new-mail-arrivals' : ''].filter(Boolean).join(' ') || undefined}
          onClick={() => setSection('mail')}
        ><Inbox size={15} />{t('teamNetwork.shell.mail')}{newMailArrivals && <span className="status-dot" aria-hidden="true" />}{(unreadMailboxCount > 0 || teamMessageUnreadOverflow) && <b className="network-nav-badge" aria-hidden="true">{unreadMailboxLabel}</b>}</button>
        {newMailArrivals && <span id="team-network-new-mail-arrivals" className="sr-only">{t('teamNetwork.shell.newMailNotice')}</span>}
        {(unreadMailboxCount > 0 || teamMessageUnreadOverflow) && <span id="team-network-mailbox-unread" className="sr-only">{t(unreadMailboxCount === 1 && !teamMessageUnreadOverflow ? 'teamNetwork.shell.unreadOne' : 'teamNetwork.shell.unreadOther', { count: unreadMailboxLabel })}</span>}
        <button className={section === 'feed' ? 'active' : ''} title={t('teamNetwork.shell.broadcast')} aria-describedby={newBulletinUpdates ? 'team-network-new-bulletin-updates' : undefined} onClick={() => setSection('feed')}><RadioTower size={15} />{t('teamNetwork.shell.bulletin')}{newBulletinUpdates && <span className="status-dot" aria-hidden="true" />}</button>
        {newBulletinUpdates && <span id="team-network-new-bulletin-updates" className="sr-only">{t('teamNetwork.shell.newBulletinNotice')}</span>}
        <button className={section === 'directory' ? 'active' : ''} onClick={() => setSection('directory')}><Server size={15} />{humanDirectory ? t('teamNetwork.shell.serversPeople') : t('teamNetwork.shell.servers')}</button>
        <div className="teamspace-nav-spacer" />
        <article className="team-network-nav-footer">
          <span className="team-network-nav-server-icon"><Server size={16} /></span>
          <div><strong>{status.serverName || 'AgentsServer'}</strong><small>{status.designatedHost ? t('teamNetwork.shell.networkHost') : t('teamNetwork.shell.connectedServer')} · {roleLabel(details?.membership.role || 'member')}</small></div>
          <i className={`teamspace-status-dot ${status.connectionState}`} />
        </article>
      </nav>
      <main className="teamspace-content network-content team-network-content">
        {!inviteOpen && pendingInviteNotice}
        {busy === 'team' && <div className="teamspace-empty"><LoaderCircle className="spin" size={18} />{t('teamNetwork.shell.loading')}</div>}
        {!busy && (!details || !projection || !capabilities) && <div className="teamspace-empty"><strong>{t('teamNetwork.shell.teamDataUnavailable')}</strong><button className="primary-button" onClick={() => selectedTeamId && void loadTeamData(status, workspace, selectedTeamId)}>{t('teamNetwork.shell.retry')}</button></div>}
        {details && projection && capabilities && selectedTeamId && details.team.id === selectedTeamId
          && projection.network.id === selectedTeamId && activeTeamScope && teamMessagesCapability && section !== 'directory' && <TeamMessagesBoard
          section={section}
          scope={activeTeamScope}
          teamId={selectedTeamId}
          capability={teamMessagesCapability}
          addresses={teamMessageAddresses}
          principalId={status.principal?.id ?? null}
          callerPostingKind={status.authenticationMode === 'human' ? 'human'
            : status.authenticationMode === 'server' || status.authenticationMode === 'paired_node' ? 'server' : null}
          canWrite={canWrite(details)}
          canManageMessages={details.membership.status === 'active' && ['owner', 'admin'].includes(details.membership.role)}
          canHostDelete={teamMessagesCapability.host_content_deletion === true
            && status.serverManaged === true && status.authenticationMode === 'server' && status.principal?.kind === 'service'
            && canManageNetworkServers(status, details)}
          draftIdentity={status.principal?.id ?? `${status.authenticationMode ?? 'unknown'}:${status.serverIdentity}`}
          initialAddress={teamMessageAddresses.find(address => mailboxAddress && address.kind === mailboxAddress.kind && address.id === mailboxAddress.id) ?? null}
          mailboxRequestId={initialMailboxRequestId}
          initialMessageId={initialMessageTarget?.teamId === selectedTeamId ? initialMessageTarget.messageId : null}
          initialMailboxBox={initialMessageTarget?.teamId === selectedTeamId ? initialMessageTarget.mailboxBox : undefined}
          onInitialMessageConsumed={onInitialMessageConsumed}
          onAddressChange={selectMailboxAddress}
          onUnreadSnapshot={updateUnreadSnapshot}
          initialFeedLoad={teamMessagesInitialFeedLoad}
          onInitialFeedLoadConsumed={consumeInitialFeedLoad}
          lifecycleCacheKey={teamNetworkSnapshotKey(status)}
          legacyBulletinPosts={bulletinPosts}
          routeTargets={mailRouteTargets}
          onRouteMessage={(message, sessionId, intent) => void routeMailToChat(message, sessionId, intent)}
        />}
        {details && projection && capabilities && !teamMessagesCapability && section === 'feed' && <Bulletin
          posts={bulletinPosts}
          canPost={canWrite(details)}
          busy={busy === 'post-bulletin'}
          onPost={postBulletin}
        />}
        {details && projection && capabilities && !teamMessagesCapability && section === 'mail' && <Mailbox
          status={status}
          projection={projection}
          address={mailboxAddress}
          entries={mailboxEntries}
          onAddressChange={selectMailboxAddress}
          onOpenBundle={recordMailboxBundleRead}
        />}
        {details && projection && capabilities && section === 'directory' && <Directory
          projection={projection}
          members={details.members}
          currentPrincipalId={status.principal?.id ?? null}
          busy={Boolean(busy)}
          canRemoveServers={canManageNetworkServers(status, details)}
          renameHostId={projection.servers.find(server => canRenameOwnHost(status, details, server))?.id ?? null}
          onRename={renameHostServer}
          removingServerId={busy?.startsWith('remove-server:') ? busy.slice('remove-server:'.length) : null}
          loadingMore={busy === 'network-page'}
          hasMore={projectionHasMore}
          onRemove={removeNetworkServer}
          onOpenInbox={server => {
            if (!server.owned_by_caller || server.status !== 'active') return
            selectMailboxAddress({ kind: 'server', id: server.id })
            setSection('mail')
          }}
          onLoadMore={() => void loadMoreServers()}
          administration={{
            human: humanDirectory,
            owner: humanDirectory && details.membership.role === 'owner',
            canInvite,
            loading: directoryLoading,
            membersHasMore: details.membersHasMore ?? false,
            pendingInvitations,
            invitationsHasMore,
            deviceSessions,
            deviceSessionsHasMore,
            onLoadMoreMembers: () => void loadMoreMembers(),
            onInvite: () => setInviteOpen(true),
            onLoadMoreInvitations: () => void loadMoreInvitations(),
            onLoadMoreDeviceSessions: () => void loadMoreDeviceSessions(),
            onRevokeInvitation: revokeInvitation,
            onRevokeDeviceSession: revokeDeviceSession,
            onUpdateMember: updateMember
          }}
        />}
      </main>
    </div>
    {localBindingManager}
    {notice && <div className="teamspace-notice teamspace-error-toast" role="status">{notice}<button onClick={() => setNotice(null)}>{t('teamNetwork.shell.dismiss')}</button></div>}
    {error && <div className="teamspace-error teamspace-error-toast" role="alert">{error}<button onClick={() => setError(null)}>{t('teamNetwork.shell.dismiss')}</button></div>}
  </NetworkShell>
}

function NetworkShell({ status, onClose, actions, children }: { status: TeamHubStatus | null; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode }) {
  useLocale()
  return <section className="teamspace" aria-label={t('teamNetwork.shell.title')}>
    <header className="teamspace-header">
      <button className="icon-button" aria-label={t('teamNetwork.shell.backToChats')} title={t('teamNetwork.shell.backToChats')} onClick={onClose}><ArrowLeft size={17} /></button>
      <div><strong>{t('teamNetwork.shell.title')} <small className="team-network-beta">{t('teamNetwork.shell.beta')}</small></strong><span><i className={`teamspace-status-dot ${status?.connectionState ?? 'connecting'}`} />{status?.serverName || t('teamNetwork.shell.activeAgentsServer')}</span></div>
      <div className="teamspace-header-actions">{actions}</div>
    </header>
    {children}
  </section>
}

function TeamNetworkOpeningShell({ onClose, section }: { onClose: () => void; section: TeamNetworkSection }) {
  useLocale()
  const active = section === 'skills' ? 'feed' : section
  const title = active === 'mail' ? t('teamNetwork.shell.mailBoard') : active === 'feed' ? t('teamNetwork.shell.bulletin') : t('teamNetwork.shell.serversPeople')
  return <NetworkShell status={null} onClose={onClose}>
    <div className="teamspace-body network-body team-network-body" aria-busy="true">
      <nav className="teamspace-nav team-network-nav" aria-label={t('teamNetwork.shell.sections')}>
        <div className="team-network-nav-heading"><span>{t('teamNetwork.shell.workspace')}</span><strong>{t('teamNetwork.shell.title')}</strong></div>
        <button className={active === 'mail' ? 'active' : ''} disabled><Inbox size={15} />{t('teamNetwork.shell.mail')}</button>
        <button className={active === 'feed' ? 'active' : ''} disabled><RadioTower size={15} />{t('teamNetwork.shell.bulletin')}</button>
        <button className={active === 'directory' ? 'active' : ''} disabled><Bot size={15} />{t('teamNetwork.shell.serversPeople')}</button>
      </nav>
      <main className="teamspace-content network-content team-network-content">
        <section className="network-v2-surface"><header className="network-v2-header"><div><h1>{title}</h1><p>{t('teamNetwork.shell.checkingAccess')}</p></div></header></section>
      </main>
    </div>
  </NetworkShell>
}

function ServerIdentity({ status }: { status: TeamHubStatus }) {
  useLocale()
  const identity = status.serverIdentity
  const shortIdentity = identity ? `${identity.slice(0, 6)}…${identity.slice(-6)}` : t('teamNetwork.shell.checkingIdentity')
  const ownershipLabel = status.serverManaged ? t('teamNetwork.shell.teamspaceHost') : status.designatedHost ? t('teamNetwork.shell.host') : t('teamNetwork.shell.thisServer')
  return <article className="network-server-identity"><span className="network-server-icon"><Server size={20} /></span><div><strong>{status.serverName || 'AgentsServer'}</strong><span title={identity || undefined}>{t('teamNetwork.shell.serverIdentity', { identity: shortIdentity })}</span></div><b>{ownershipLabel}</b></article>
}

function LocalBindingManager({ status, busy, confirmingForget, error, notice, onClose, onDisconnect, onReconnect, onRequestForget, onCancelForget, onForget }: {
  status: TeamHubStatus
  busy: boolean
  confirmingForget: boolean
  error: string | null
  notice: string | null
  onClose: () => void
  onDisconnect: () => void
  onReconnect: () => void
  onRequestForget: () => void
  onCancelForget: () => void
  onForget: () => void
}) {
  useLocale()
  const saved = Boolean(status.serverIdentity && status.savedHubIdentity && status.canForgetBinding)
  const connected = status.authenticated
  const serverManaged = status.serverManaged === true
  const canReconnect = !connected && (
    ['disconnected', 'offline', 'unavailable', 'error'].includes(status.connectionState)
    || (serverManaged && status.connectionState === 'signed-out')
  )
  const stateLabel = connected
    ? t('teamNetwork.shell.connected')
    : status.connectionState === 'signed-out'
      ? t('teamNetwork.shell.signedOut')
      : status.connectionState === 'needs-bootstrap'
        ? t('teamNetwork.shell.setupRequired')
        : saved
          ? t('teamNetwork.shell.disconnected')
          : t('teamNetwork.shell.notSaved')
  const description = status.error || (serverManaged
    ? connected
      ? t('teamNetwork.shell.managedConnectedDescription', { server: status.serverName || t('teamNetwork.shell.selectedAgentsServerLower') })
      : saved
        ? t('teamNetwork.shell.managedPausedDescription', { server: status.serverName || t('teamNetwork.shell.theServer') })
        : t('teamNetwork.shell.managedNoCacheDescription', { server: status.serverName || t('teamNetwork.shell.theServer') })
    : connected
      ? t('teamNetwork.shell.usingLocalBinding')
      : status.connectionState === 'signed-out'
        ? t('teamNetwork.shell.needsPersonLogin')
        : status.connectionState === 'needs-bootstrap'
          ? t('teamNetwork.shell.waitingFirstOwner')
          : saved
            ? t('teamNetwork.shell.signedOutSaved')
            : t('teamNetwork.shell.noLocalBinding'))
  return <div className="network-invite-backdrop" role="presentation" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
    <aside className="network-invite-sheet network-binding-sheet" role="dialog" aria-modal="true" aria-label={serverManaged ? t('teamNetwork.shell.manageTeamspaceConnection') : t('teamNetwork.shell.manageLocalNetwork')}>
      <header><div><strong>{serverManaged ? t('teamNetwork.shell.teamspaceConnection') : t('teamNetwork.shell.localNetworkConnection')}</strong><span>{status.serverName || 'AgentsServer'}</span></div><button type="button" className="icon-button" aria-label={serverManaged ? t('teamNetwork.shell.closeTeamspaceManager') : t('teamNetwork.shell.closeLocalManager')} disabled={busy} autoFocus onClick={onClose}><X size={16} /></button></header>
      <div>
        <section className="network-connect-panel" aria-label={serverManaged ? t('teamNetwork.shell.teamspaceConnection') : t('teamNetwork.shell.localBinding')}>
          <header className="teamspace-section-heading network-connect-heading">
            <Settings2 size={18} />
            <div><h2>{serverManaged ? t('teamNetwork.shell.manageConnection') : t('teamNetwork.shell.manageServer')}</h2><span>{serverManaged
              ? t('teamNetwork.shell.managedBindingDescription')
              : t('teamNetwork.shell.localBindingDescription')}</span></div>
          </header>
          <article className={`network-connection-state ${connected ? 'is-connected' : 'needs-attention'}`} role="status">
            <span className="network-state-icon">{connected ? <ShieldCheck size={24} /> : <Unplug size={24} />}</span>
            <div className="network-state-copy"><span className="network-state-label">{stateLabel}</span><h3>{status.serverName || 'AgentsServer'}</h3><p>{description}</p></div>
            <div className="network-state-actions">
              {connected && saved && <button type="button" className="quiet-button" disabled={busy} onClick={onDisconnect}><Unplug size={15} />{serverManaged ? t('teamNetwork.shell.disconnect') : t('teamNetwork.shell.disconnectSignOut')}</button>}
              {canReconnect && <button type="button" className="primary-button" disabled={busy} onClick={onReconnect}><RefreshCw className={busy ? 'spin' : ''} size={15} />{saved ? t('teamNetwork.shell.reconnect') : t('teamNetwork.shell.connectAgain')}</button>}
              {saved && <button type="button" className="quiet-button danger" disabled={busy} onClick={onRequestForget}><Trash2 size={15} />{serverManaged ? t('teamNetwork.shell.forgetConnection') : t('teamNetwork.shell.forgetNetwork')}</button>}
            </div>
            {confirmingForget && saved && <div className="secure-peer-destructive-confirm network-forget-confirm network-binding-forget-confirm">
              <span>{serverManaged
                ? t('teamNetwork.shell.managedForgetConfirm', { server: status.serverName || t('teamNetwork.shell.theServer') })
                : <>{connected ? t('teamNetwork.shell.forgetConnectedConfirm') : t('teamNetwork.shell.forgetDisconnectedConfirm')} {t('teamNetwork.shell.setupAgain')}</>}</span>
              <button type="button" className="quiet-button danger" disabled={busy} onClick={onForget}>{t('teamNetwork.shell.confirmForget')}</button>
              <button type="button" className="quiet-button" disabled={busy} onClick={onCancelForget}>{serverManaged ? t('teamNetwork.shell.keepConnection') : t('teamNetwork.shell.keepNetwork')}</button>
            </div>}
          </article>
          {notice && <div className="teamspace-notice" role="status">{notice}</div>}
          {error && <div className="teamspace-error network-panel-error" role="alert"><span>{error}</span></div>}
        </section>
      </div>
    </aside>
  </div>
}

function Bulletin({ posts, canPost, busy, onPost }: { posts: TeamNetworkBulletinPost[]; canPost: boolean; busy: boolean; onPost: (body: string) => Promise<boolean> }) {
  const locale = useLocale()
  const [body, setBody] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = body.trim()
    if (value && await onPost(value)) setBody('')
  }
  return <section className="network-surface network-bulletin" aria-label={t('teamNetwork.shell.bulletin')}>
    <header className="network-surface-header"><span className="network-surface-icon"><RadioTower size={20} /></span><div><h1>{t('teamNetwork.shell.bulletin')}</h1><p>{t('teamNetwork.shell.broadcastDescription')}</p></div></header>
    <div className="network-scroll-region network-feed">
      {!posts.length && <div className="network-empty-state"><span className="network-empty-state-icon"><RadioTower size={22} /></span><h2>{t('teamNetwork.shell.noBroadcast')}</h2><p>{t('teamNetwork.shell.broadcastEmpty')}</p></div>}
      {posts.map(post => <article className="network-feed-item" key={post.id}><header><strong>{post.author.display_name}</strong><span>{new Date(post.created_at).toLocaleString(locale)}</span></header><p>{post.body}</p>{post.reply_to_post_id && <small>{t('teamNetwork.shell.reply')}</small>}</article>)}
    </div>
    {canPost && <div className="network-composer-dock"><form className="network-simple-composer" onSubmit={submit}><label><span>{t('teamNetwork.shell.newAnnouncement')}</span><textarea aria-label={t('teamNetwork.shell.bulletinPost')} rows={2} value={body} onChange={event => setBody(event.target.value)} placeholder={t('teamNetwork.shell.shareUpdate')} /></label><div><span>{t('teamNetwork.shell.plainTextOnly')}</span><button className="primary-button" disabled={busy || !body.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{t('teamNetwork.shell.post')}</button></div></form></div>}
  </section>
}

function Mailbox({ status, projection, address, entries, onAddressChange, onOpenBundle }: {
  status: TeamHubStatus
  projection: TeamNetworkProjection
  address: TeamNetworkMailboxAddress | null
  entries: TeamNetworkMailboxEntry[]
  onAddressChange: (address: TeamNetworkMailboxAddress) => void
  onOpenBundle: (entries: readonly TeamNetworkMailboxEntry[]) => void
}) {
  const locale = useLocale()
  const owned = ownedAddresses(projection, status)
  const bundles = buildTeamMailBundles(address, entries)
  const unreadCount = entries.filter(entry => entry.delivery.state !== 'read').length
  const [selectedBundleKey, setSelectedBundleKey] = useState<string | null>(null)
  const restoreBundleFocus = useRef(false)
  const returnBundleKey = useRef<string | null>(null)
  const bundleTrigger = useRef<HTMLButtonElement | null>(null)
  const selectedBundle = bundles.find(bundle => bundle.key === selectedBundleKey) ?? null
  const selectedVersion = selectedBundle?.entries.map(entry => `${entry.delivery.id}:${entry.delivery.state}`).join('|') ?? ''

  useEffect(() => { setSelectedBundleKey(null) }, [address?.id, address?.kind])
  useEffect(() => {
    if (selectedBundle) onOpenBundle(selectedBundle.entries)
  }, [onOpenBundle, selectedBundleKey, selectedVersion])

  const closeBundle = useCallback(() => {
    restoreBundleFocus.current = true
    setSelectedBundleKey(null)
  }, [])

  useEffect(() => {
    if (selectedBundleKey !== null || !restoreBundleFocus.current) return
    restoreBundleFocus.current = false
    bundleTrigger.current?.focus()
  }, [selectedBundleKey])

  useEffect(() => {
    if (!selectedBundleKey) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeBundle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeBundle, selectedBundleKey])

  const chooseAddress = (key: string) => {
    const next = owned.find(option => addressKey(option.address) === key)
    if (next) onAddressChange(next.address)
  }

  return <section className="network-surface network-mailbox" aria-label={t('teamNetwork.shell.mailBoard')}>
    <header className="network-surface-header">
      <span className="network-surface-icon"><Inbox size={20} /></span>
      <div><h1>{t('teamNetwork.shell.mailBoard')}</h1><p>{t('teamNetwork.shell.mailCommandBefore', { count: unreadCount })}<code>/mail server &lt;name&gt; &lt;message&gt;</code>{t('teamNetwork.shell.mailCommandAfter')}</p></div>
      <label className="network-mailbox-switcher"><span>{t('teamNetwork.shell.receivingAs')}</span><select aria-label={t('teamNetwork.shell.receivingMailbox')} value={address ? addressKey(address) : ''} onChange={event => chooseAddress(event.target.value)} disabled={!owned.length}><option value="" disabled>{t('teamNetwork.shell.chooseMailboxOption')}</option>{owned.map(option => <option key={addressKey(option.address)} value={addressKey(option.address)}>{option.label}</option>)}</select></label>
    </header>
    {selectedBundle ? <MailBundleDetail bundle={selectedBundle} onBack={closeBundle} /> : <div className="network-scroll-region network-mail-board">
      {!address && <div className="network-empty-state"><span className="network-empty-state-icon"><Inbox size={22} /></span><h2>{t('teamNetwork.shell.chooseMailbox')}</h2><p>{t('teamNetwork.shell.chooseMailboxDescription')}</p></div>}
      {address && !bundles.length && <div className="network-empty-state"><span className="network-empty-state-icon"><Mail size={22} /></span><h2>{t('teamNetwork.shell.mailEmptyTitle')}</h2><p>{t('teamNetwork.shell.mailEmptyDescription')}</p></div>}
      {address && bundles.length > 0 && <div className="network-mail-board-grid" role="region" aria-label={t('teamNetwork.shell.receivedBundles')}>{bundles.map(bundle => <button
        type="button"
        key={bundle.key}
        ref={element => {
          if (returnBundleKey.current === bundle.key) bundleTrigger.current = element
        }}
        className={`network-mail-bundle-card ${bundle.unreadCount ? 'unread' : ''}`}
        onClick={event => {
          returnBundleKey.current = bundle.key
          bundleTrigger.current = event.currentTarget
          setSelectedBundleKey(bundle.key)
        }}
        aria-label={`${bundle.sender.display_name}, ${t(bundle.entries.length === 1 ? 'teamNetwork.shell.itemsOne' : 'teamNetwork.shell.itemsOther', { count: bundle.entries.length })}${bundle.unreadCount ? `, ${t('teamNetwork.shell.unreadCount', { count: bundle.unreadCount })}` : ''}`}
      >
        <span className="network-mail-bundle-card-header"><span className="network-mail-bundle-icon">{mailSenderIcon(bundle.sender.kind)}</span><span><strong>{bundle.sender.display_name}</strong><small>{mailAddressKind(bundle.sender.kind)}</small></span><time>{new Date(bundle.latest.item.created_at).toLocaleString(locale)}</time></span>
        <span className="network-mail-bundle-preview">{bundle.latest.item.body}</span>
        <span className="network-mail-bundle-card-footer"><span>{t(bundle.entries.length === 1 ? 'teamNetwork.shell.itemsOne' : 'teamNetwork.shell.itemsOther', { count: bundle.entries.length })}</span>{bundle.unreadCount > 0 && <b>{t('teamNetwork.shell.newCount', { count: bundle.unreadCount })}</b>}<ChevronRight size={15} /></span>
      </button>)}</div>}
    </div>}
  </section>
}

function MailBundleDetail({ bundle, onBack }: { bundle: TeamMailBundle; onBack: () => void }) {
  const locale = useLocale()
  return <section className="network-mail-bundle-detail" aria-label={t('teamNetwork.shell.mailFrom', { name: bundle.sender.display_name })}>
    <header><button type="button" className="quiet-button" aria-label={t('teamNetwork.shell.backToMail')} autoFocus onClick={onBack}><ArrowLeft size={14} />{t('teamNetwork.shell.back')}</button><div><span className="network-mail-bundle-icon">{mailSenderIcon(bundle.sender.kind)}</span><div><h2>{bundle.sender.display_name}</h2><p>{t(bundle.entries.length === 1 ? 'teamNetwork.shell.receivedOne' : 'teamNetwork.shell.receivedOther', { count: bundle.entries.length })}</p></div></div></header>
    <div className="network-scroll-region network-mail-bundle-items">{bundle.entries.map(entry => {
      const unread = entry.delivery.state !== 'read'
      return <article key={entry.item.id} className={`network-mail-bundle-item ${unread ? 'unread' : ''}`} aria-label={unread ? t('teamNetwork.shell.unreadKind', { kind: mailKindLabel(entry.item.kind).toLowerCase() }) : mailKindLabel(entry.item.kind).toLowerCase()}>
        <header><span><strong>{mailKindLabel(entry.item.kind)}</strong><small>{t('teamNetwork.shell.toRecipient', { name: entry.item.to.display_name })}</small></span><time>{new Date(entry.item.created_at).toLocaleString(locale)}</time></header>
        <p>{entry.item.body}</p>
        <footer>{unread ? t('teamNetwork.shell.unread') : t('teamNetwork.shell.read')}{entry.item.request_id ? t('teamNetwork.shell.requestHistorySuffix') : ''}</footer>
      </article>
    })}</div>
  </section>
}

function mailSenderIcon(kind: TeamNetworkMailboxEntry['item']['from']['kind']) {
  return kind === 'server' ? <Server size={17} /> : kind === 'agent' ? <Bot size={17} /> : <UserRound size={17} />
}

function mailAddressKind(kind: TeamNetworkMailboxEntry['item']['from']['kind']): string {
  return kind === 'server' ? t('teamNetwork.shell.server') : kind === 'agent' ? t('teamNetwork.shell.agent') : t('teamNetwork.shell.person')
}

function mailKindLabel(kind: TeamNetworkMailboxEntry['item']['kind']): string {
  return kind === 'request' ? t('teamNetwork.shell.request') : kind === 'reply' ? t('teamNetwork.shell.reply') : t('teamNetwork.shell.message')
}

interface DirectoryAdministration {
  human: boolean
  owner: boolean
  canInvite: boolean
  loading: boolean
  membersHasMore: boolean
  pendingInvitations: TeamHubInvitationSummary[]
  invitationsHasMore: boolean
  deviceSessions: TeamHubDeviceSession[]
  deviceSessionsHasMore: boolean
  onLoadMoreMembers: () => void
  onInvite: () => void
  onLoadMoreInvitations: () => void
  onLoadMoreDeviceSessions: () => void
  onRevokeInvitation: (invitation: TeamHubInvitationSummary) => Promise<boolean>
  onRevokeDeviceSession: (session: TeamHubDeviceSession) => Promise<boolean>
  onUpdateMember: (
    member: TeamHubMembership,
    patch: { role: 'admin' | 'member' | 'guest' } | { status: 'active' | 'suspended' | 'revoked' }
  ) => Promise<boolean>
}

function Directory({ projection, members, currentPrincipalId, busy, loadingMore, hasMore, canRemoveServers, removingServerId, renameHostId, onRename, onRemove, onOpenInbox, onLoadMore, administration }: { projection: TeamNetworkProjection; members: TeamHubTeamDetails['members']; currentPrincipalId: string | null; busy: boolean; loadingMore: boolean; hasMore: boolean; canRemoveServers: boolean; removingServerId: string | null; renameHostId: string | null; onRename: (server: TeamNetworkServer, name: string) => Promise<boolean>; onRemove: (server: TeamNetworkServer) => Promise<boolean>; onOpenInbox: (server: TeamNetworkServer) => void; onLoadMore: () => void; administration: DirectoryAdministration }) {
  useLocale()
  const showInvitations = administration.owner && (
    administration.pendingInvitations.length > 0 || administration.invitationsHasMore
  )
  const showDevices = administration.human && (
    administration.deviceSessions.length > 0 || administration.deviceSessionsHasMore
  )
  return <section className="network-surface network-agents" aria-label={administration.human ? t('teamNetwork.shell.serversPeopleLabel') : t('teamNetwork.shell.servers')}>
    <header className="network-surface-header network-directory-header"><span className="network-surface-icon">{administration.human ? <Users size={20} /> : <Server size={20} />}</span><div><h1>{administration.human ? t('teamNetwork.shell.serversPeople') : t('teamNetwork.shell.servers')}</h1><p>{administration.human ? t('teamNetwork.shell.humanDirectoryDescription') : t('teamNetwork.shell.serverDirectoryDescription')}</p></div>{administration.canInvite && <button
      type="button"
      className="primary-button network-directory-invite-action"
      onClick={administration.onInvite}
    ><UserPlus size={14} />{t('teamNetwork.shell.invite')}</button>}</header>
    <div className="network-scroll-region network-roster-list">
      {projection.servers.map(server => <ServerRow
        key={server.id}
        server={server}
        canRemove={canRemoveServers && !server.is_host && !server.owned_by_caller}
        canRename={renameHostId === server.id}
        onRename={onRename}
        canOpenInbox={server.owned_by_caller && server.status === 'active'}
        disabled={busy}
        removing={removingServerId === server.id}
        onRemove={onRemove}
        onOpenInbox={onOpenInbox}
      />)}
      {!projection.servers.length && <div className="network-empty-state"><span className="network-empty-state-icon"><Server size={22} /></span><h2>{t('teamNetwork.shell.noServers')}</h2><p>{t('teamNetwork.shell.noServersDescription')}</p></div>}
      {hasMore && <button type="button" className="quiet-button network-load-more" disabled={loadingMore || busy} onClick={onLoadMore}>{loadingMore && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.loadServers')}</button>}
      {administration.human && <section className="network-people-directory" aria-label={t('teamNetwork.shell.people')}><header><UserRound size={15} /><strong>{t('teamNetwork.shell.people')}</strong></header><div>{members.map(member => <MemberRow
        key={member.principal_id}
        member={member}
        current={member.principal_id === currentPrincipalId}
        canManage={administration.owner}
        disabled={busy || administration.loading}
        onUpdate={administration.onUpdateMember}
      />)}{!members.length && <p>{t('teamNetwork.shell.noPeople')}</p>}</div>{administration.membersHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreMembers}>{t('teamNetwork.shell.loadPeople')}</button>}</section>}
      {(showInvitations || showDevices) && <details className="network-more network-access-management">
        <summary>{t('teamNetwork.shell.manageAccess')}</summary>
        <div>
          {showInvitations && <section className="network-people-directory network-admin-list" aria-label={t('teamNetwork.shell.pendingInvitations')}><header><UserPlus size={15} /><strong>{t('teamNetwork.shell.pendingInvitations')}</strong></header><div>{administration.pendingInvitations.map(invitation => <InvitationRow key={invitation.id} invitation={invitation} disabled={busy || administration.loading} onRevoke={administration.onRevokeInvitation} />)}</div>{administration.invitationsHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreInvitations}>{t('teamNetwork.shell.loadInvitations')}</button>}</section>}
          {showDevices && <section className="network-people-directory network-admin-list" aria-label={t('teamNetwork.shell.signedInDevices')}><header><ShieldCheck size={15} /><strong>{t('teamNetwork.shell.signedInDevices')}</strong></header><div>{administration.deviceSessions.map(session => <DeviceSessionRow key={session.id} session={session} disabled={busy || administration.loading} onRevoke={administration.onRevokeDeviceSession} />)}</div>{administration.deviceSessionsHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreDeviceSessions}>{t('teamNetwork.shell.loadDevices')}</button>}</section>}
        </div>
      </details>}
    </div>
  </section>
}

function MemberRow({ member, current, canManage, disabled, onUpdate }: {
  member: TeamHubMembership
  current: boolean
  canManage: boolean
  disabled: boolean
  onUpdate: DirectoryAdministration['onUpdateMember']
}) {
  useLocale()
  const [pending, setPending] = useState<{ role: 'admin' | 'member' | 'guest' } | { status: 'active' | 'suspended' | 'revoked' } | null>(null)
  const manageable = canManage && !current && !['owner', 'automation'].includes(member.role)
  const apply = async () => {
    if (pending && await onUpdate(member, pending)) setPending(null)
  }
  const pendingLabel = pending && ('role' in pending
    ? t('teamNetwork.shell.roleChange', { name: member.display_name, role: roleLabel(pending.role) })
    : pending.status === 'revoked'
      ? t('teamNetwork.shell.removeMemberConfirm', { name: member.display_name })
      : t(pending.status === 'active' ? 'teamNetwork.shell.restoreMemberConfirm' : 'teamNetwork.shell.suspendMemberConfirm', { name: member.display_name }))
  return <article className="network-admin-row">
    <span className="network-mail-bundle-icon"><UserRound size={15} /></span>
    <div><strong>{member.display_name}{current ? t('teamNetwork.shell.youSuffix') : ''}</strong><small>{roleLabel(member.role)} · {memberStatusLabel(member.status)}</small></div>
    {manageable && <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="icon-button network-person-menu" aria-label={t('teamNetwork.shell.manageNamed', { name: member.display_name })} disabled={disabled}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
      {(['admin', 'member', 'guest'] as const).filter(role => role !== member.role).map(role => <DropdownMenu.Item key={role} className="menu-item" disabled={member.status !== 'active'} onSelect={() => setPending({ role })}>{t('teamNetwork.shell.makeRole', { role: roleLabel(role) })}</DropdownMenu.Item>)}
      {member.status === 'active' && <DropdownMenu.Item className="menu-item" onSelect={() => setPending({ status: 'suspended' })}>{t('teamNetwork.shell.suspendAccess')}</DropdownMenu.Item>}
      {member.status === 'suspended' && <DropdownMenu.Item className="menu-item" onSelect={() => setPending({ status: 'active' })}>{t('teamNetwork.shell.restoreAccess')}</DropdownMenu.Item>}
      <DropdownMenu.Item className="menu-item danger" onSelect={() => setPending({ status: 'revoked' })}><Trash2 size={14} />{t('teamNetwork.shell.removeTeam')}</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    {pending && <div className="network-admin-confirm" role="group" aria-label={t('teamNetwork.shell.confirmMemberChange', { name: member.display_name })}><span>{pendingLabel}</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void apply()}>{t('teamNetwork.shell.confirm')}</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setPending(null)}>{t('teamNetwork.shell.cancel')}</button></div>}
  </article>
}

function InvitationRow({ invitation, disabled, onRevoke }: { invitation: TeamHubInvitationSummary; disabled: boolean; onRevoke: DirectoryAdministration['onRevokeInvitation'] }) {
  const locale = useLocale()
  const [confirming, setConfirming] = useState(false)
  const revoke = async () => { if (await onRevoke(invitation)) setConfirming(false) }
  return <article className="network-admin-row"><span className="network-mail-bundle-icon"><Mail size={15} /></span><div><strong>{invitation.invitee_email}</strong><small>{t('teamNetwork.shell.invitationExpiry', { role: roleLabel(invitation.role), date: new Date(invitation.expires_at).toLocaleString(locale) })}</small></div><button type="button" className="quiet-button danger" disabled={disabled} onClick={() => setConfirming(true)}>{t('teamNetwork.shell.revoke')}</button>{confirming && <div className="network-admin-confirm" role="group" aria-label={t('teamNetwork.shell.revokeNamedInvitation', { email: invitation.invitee_email })}><span>{t('teamNetwork.shell.invitationStops')}</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void revoke()}>{t('teamNetwork.shell.revokeInvitation')}</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setConfirming(false)}>{t('teamNetwork.shell.keepInvitation')}</button></div>}</article>
}

function DeviceSessionRow({ session, disabled, onRevoke }: { session: TeamHubDeviceSession; disabled: boolean; onRevoke: DirectoryAdministration['onRevokeDeviceSession'] }) {
  const locale = useLocale()
  const [confirming, setConfirming] = useState(false)
  const revoke = async () => { if (await onRevoke(session)) setConfirming(false) }
  return <article className="network-admin-row"><span className="network-mail-bundle-icon"><ShieldCheck size={15} /></span><div><strong>{session.device_label}{session.current ? t('teamNetwork.shell.thisDeviceSuffix') : ''}</strong><small>{t('teamNetwork.shell.deviceLastSeen', { lastSeen: new Date(session.last_seen_at).toLocaleString(locale), expires: new Date(session.expires_at).toLocaleDateString(locale) })}</small></div>{session.current ? <b>{t('teamNetwork.shell.current')}</b> : <button type="button" className="quiet-button danger" disabled={disabled} onClick={() => setConfirming(true)}>{t('teamNetwork.shell.signOut')}</button>}{confirming && !session.current && <div className="network-admin-confirm" role="group" aria-label={t('teamNetwork.shell.signOutNamed', { device: session.device_label })}><span>{t('teamNetwork.shell.revokeDeviceConfirm')}</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void revoke()}>{t('teamNetwork.shell.signOutDevice')}</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setConfirming(false)}>{t('teamNetwork.shell.keepSignedIn')}</button></div>}</article>
}

function ServerRow({ server, canOpenInbox, canRemove, canRename, disabled, removing, onRename, onRemove, onOpenInbox }: { server: TeamNetworkServer; canOpenInbox: boolean; canRemove: boolean; canRename: boolean; disabled: boolean; removing: boolean; onRename: (server: TeamNetworkServer, name: string) => Promise<boolean>; onRemove: (server: TeamNetworkServer) => Promise<boolean>; onOpenInbox: (server: TeamNetworkServer) => void }) {
  useLocale()
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(server.display_name)
  useEffect(() => { if (!canRename) setRenaming(false) }, [canRename])
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!confirming) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || removing) return
      event.preventDefault()
      setConfirming(false)
      queueMicrotask(() => menuTrigger.current?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirming, removing])
  const remove = async () => {
    if (await onRemove(server)) setConfirming(false)
  }
  return <article className="network-roster-server">
    <header><Server size={18} /><div><strong title={server.server_identity}>{server.display_name}</strong><span className={server.status}>{logicalServerStatus(server)}</span></div><div className="network-roster-server-meta">{canOpenInbox && <button type="button" className="quiet-button network-roster-inbox" disabled={disabled} onClick={() => onOpenInbox(server)}><Inbox size={14} />{t('teamNetwork.shell.inbox')}</button>}{(canRemove || canRename) && <DropdownMenu.Root><DropdownMenu.Trigger asChild><button ref={menuTrigger} type="button" className="icon-button network-roster-server-menu" aria-label={t('teamNetwork.shell.manageNamed', { name: server.display_name })} disabled={disabled}>{removing ? <LoaderCircle className="spin" size={15} /> : <MoreHorizontal size={16} />}</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">{canRename && <DropdownMenu.Item className="menu-item" onSelect={() => { setName(server.display_name); setRenaming(true) }}><Pencil size={14} />{t('teamNetwork.shell.rename')}</DropdownMenu.Item>}{canRemove && <DropdownMenu.Item className="menu-item danger" onSelect={() => setConfirming(true)}><Trash2 size={14} />{t('teamNetwork.shell.removeNetwork')}</DropdownMenu.Item>}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}</div></header>
    {renaming && canRename && <form className="teamspace-form" aria-label={t('teamNetwork.shell.renameHost')} onSubmit={event => { event.preventDefault(); void onRename(server, name).then(saved => { if (saved) setRenaming(false) }) }}>
      <label>{t('teamNetwork.shell.serverName')}<input aria-label={t('teamNetwork.shell.serverName')} autoFocus value={name} maxLength={160} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
      <div><button type="submit" className="primary-button" disabled={disabled || !name.trim() || bodyBytes(name.trim()) > 160 || /[\u0000-\u001f\u007f]/.test(name)}>{disabled && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.save')}</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => { setRenaming(false); queueMicrotask(() => menuTrigger.current?.focus()) }}>{t('teamNetwork.shell.cancel')}</button></div>
    </form>}
    {confirming && <div className="network-server-remove-confirm" role="group" aria-label={t('teamNetwork.shell.removeNamed', { server: server.display_name })}><div><strong>{t('teamNetwork.shell.removeNamedConfirm', { server: server.display_name })}</strong><span>{t('teamNetwork.shell.removeServerDescription')}</span></div><div><button type="button" className="danger-button" disabled={disabled} onClick={() => void remove()}>{removing && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.removeServer')}</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => { setConfirming(false); queueMicrotask(() => menuTrigger.current?.focus()) }}>{t('teamNetwork.shell.keepServer')}</button></div></div>}
  </article>
}

function CreateNetworkForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  useLocale()
  return <form className="teamspace-form teamspace-enrollment-form" onSubmit={onSubmit}><label>{t('teamNetwork.shell.teamName')}<input required name="teamName" maxLength={120} placeholder={t('teamNetwork.shell.myTeam')} /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'create' && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.createNetwork')}</button></form>
}

function PendingInviteNotice({ status, onCancel }: { status: TeamHubStatus | null; onCancel: () => void }) {
  useLocale()
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const [errorCopy, setError] = useState<NetworkCopy | null>(null)
  const error = displayCopy(errorCopy)
  const selectServer = async (profileId: string) => {
    setError(null)
    try {
      if (!await useAppStore.getState().switchServer(profileId)) setError(copy('teamNetwork.shell.selectServerFailed'))
    } catch (cause) { setError(errorMessage(cause)) }
  }
  return <aside className="teamspace-host-help" aria-label={t('teamNetwork.shell.pendingInvite')}>
    <strong>{status?.designatedHost ? t('teamNetwork.shell.chooseOtherServer') : t('teamNetwork.shell.chooseConnectServer')}</strong>
    <span>{status?.designatedHost ? t('teamNetwork.shell.inviteOnHostDescription') : t('teamNetwork.shell.inviteKeptDescription')}</span>
    {profiles.length > 1 ? <label className="teamspace-team-picker">{t('teamNetwork.shell.serverToConnect')}<select value={activeProfileId ?? ''} disabled={Boolean(switchingProfileId)} onChange={event => void selectServer(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label> : <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('settings', true)}>{t('teamNetwork.shell.addServerSettings')}</button>}
    <button type="button" className="quiet-button" onClick={onCancel}>{t('teamNetwork.shell.cancelInvite')}</button>
    {error && <span role="alert">{error}</span>}
  </aside>
}

function UseInvitationForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  useLocale()
  return <form className="teamspace-form teamspace-enrollment-form" onSubmit={onSubmit}><div className="teamspace-section-heading"><KeyRound size={16} /><div><strong>{t('teamNetwork.shell.useInvitationFile')}</strong><span>{t('teamNetwork.shell.personSignIn')}</span></div></div><label>{t('teamNetwork.shell.email')}<input required name="email" type="email" /></label><label>{t('teamNetwork.shell.yourName')}<input required name="displayName" /></label><label>{t('teamNetwork.shell.deviceName')}<input required name="deviceLabel" defaultValue="AgentsDock Desktop" /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'invitation' && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.chooseFile')}</button></form>
}

function RecoverDeviceForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  useLocale()
  return <form className="teamspace-form teamspace-enrollment-form" aria-label={t('teamNetwork.shell.recoverSignedOut')} onSubmit={onSubmit}><div className="teamspace-section-heading"><ShieldCheck size={16} /><div><strong>{t('teamNetwork.shell.recoverPerson')}</strong><span>{t('teamNetwork.shell.recoveryDescription')}</span></div></div><label>{t('teamNetwork.shell.recoveryDeviceName')}<input required name="deviceLabel" defaultValue="AgentsDock Desktop" /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'recovery' && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.shell.chooseRecovery')}</button></form>
}

function ownedAddress(projection: TeamNetworkProjection, status: TeamHubStatus, current: TeamNetworkMailboxAddress | null): TeamNetworkMailboxAddress | null {
  const options = ownedAddresses(projection, status)
  return options.find(option => sameAddress(option.address, current))?.address ?? options[0]?.address ?? null
}

function ownedAddresses(projection: TeamNetworkProjection, _status: TeamHubStatus): Array<{ address: TeamNetworkMailboxAddress; label: string }> {
  const servers = projection.servers.filter(server => server.status === 'active' && server.owned_by_caller)
  return servers.map(server => ({ address: { kind: 'server' as const, id: server.id }, label: server.display_name }))
}

function ownedTeamMessageAddresses(projection: TeamNetworkProjection, _status: TeamHubStatus): TeamMessageAddress[] {
  return projection.servers
    .filter(server => server.status === 'active' && server.owned_by_caller)
    .map(server => ({ kind: 'server' as const, id: server.id, label: server.display_name }))
}

function sameAddress(left: TeamNetworkMailboxAddress | null, right: TeamNetworkMailboxAddress | null): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id)
}

function addressKey(address: TeamNetworkMailboxAddress): string { return `${address.kind}:${address.id}` }

function projectionFromPage(page: TeamNetworkProjectionPage): TeamNetworkProjection {
  return mergeNetworkProjection({ network: page.network, servers: [], agents: [] }, page)
}

function mergeNetworkProjection(current: TeamNetworkProjection, page: TeamNetworkProjectionPage): TeamNetworkProjection {
  if (
    current.network.id !== page.network.id
    || current.network.hub_id !== page.network.hub_id
    || current.network.display_name !== page.network.display_name
  ) throw new NetworkError(copy('teamNetwork.shell.differentNetwork'))
  if (
    current.servers.length + page.servers.length > NETWORK_ROSTER_MAX_SERVERS
    || current.agents.length + page.agents.length > NETWORK_ROSTER_MAX_AGENTS
  ) throw new NetworkError(copy('teamNetwork.shell.rosterLimit'))
  const lastPageServerId = page.servers.at(-1)?.id ?? null
  if (
    (lastPageServerId === null && (page.next_after_server_id !== null || page.has_more))
    || (lastPageServerId !== null && page.next_after_server_id !== lastPageServerId)
  ) throw new NetworkError(copy('teamNetwork.shell.invalidContinuation'))

  const serverIds = new Set(current.servers.map(server => server.id))
  const serverIdentities = new Set(current.servers.map(server => server.server_identity))
  let previousServerId = current.servers.at(-1)?.id ?? null
  for (const server of page.servers) {
    if (
      (previousServerId !== null && server.id <= previousServerId)
      || serverIds.has(server.id)
      || serverIdentities.has(server.server_identity)
    ) throw new NetworkError(copy('teamNetwork.shell.overlappingServers'))
    previousServerId = server.id
    serverIds.add(server.id)
    serverIdentities.add(server.server_identity)
  }

  const pageServerIds = new Set(page.servers.map(server => server.id))
  const agentIds = new Set(current.agents.map(agent => agent.id))
  const externalAgentIds = new Set(current.agents.map(agent => `${agent.server_id}\u0000${agent.external_agent_id}`))
  for (const agent of page.agents) {
    const externalKey = `${agent.server_id}\u0000${agent.external_agent_id}`
    if (!pageServerIds.has(agent.server_id) || agentIds.has(agent.id) || externalAgentIds.has(externalKey)) {
      throw new NetworkError(copy('teamNetwork.shell.overlappingAgents'))
    }
    agentIds.add(agent.id)
    externalAgentIds.add(externalKey)
  }
  return {
    network: current.network,
    servers: [...current.servers, ...page.servers],
    agents: [...current.agents, ...page.agents]
  }
}

function mergeBulletin(current: TeamNetworkBulletinPost[], incoming: TeamNetworkBulletinPost[]): TeamNetworkBulletinPost[] {
  if (incoming.length === 0) return current
  const merged = new Map(current.map(post => [post.id, post]))
  for (const post of incoming) merged.set(post.id, post)
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

function mergeMailbox(current: TeamNetworkMailboxEntry[], incoming: TeamNetworkMailboxEntry[]): TeamNetworkMailboxEntry[] {
  if (incoming.length === 0) return current
  const merged = new Map(current.map(entry => [entry.item.id, entry]))
  for (const entry of incoming) merged.set(entry.item.id, entry)
  return [...merged.values()].sort((left, right) => left.item.sequence - right.item.sequence || left.item.id.localeCompare(right.item.id))
}

function mergeDirectoryItems<T>(current: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const merged = new Map(current.map(item => [key(item), item]))
  for (const item of incoming) merged.set(key(item), item)
  if (merged.size > DIRECTORY_ADMIN_MAX_ITEMS) throw new NetworkError(copy('teamNetwork.shell.directoryLimit'))
  return [...merged.values()]
}

function mergeDirectoryPage<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
  label: NetworkCopy
): T[] {
  const currentKeys = new Set(current.map(key))
  if (currentKeys.size !== current.length) {
    throw new NetworkError(copy('teamNetwork.shell.directoryExistingDuplicates', { label }))
  }
  const incomingKeys = new Set<string>()
  for (const item of incoming) {
    const id = key(item)
    if (currentKeys.has(id) || incomingKeys.has(id)) {
      throw new NetworkError(copy('teamNetwork.shell.directoryPageDuplicate', { label }))
    }
    incomingKeys.add(id)
  }
  return mergeDirectoryItems(current, incoming, key)
}

function validateUniqueDirectoryPage<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: NetworkCopy
): void {
  const keys = new Set(items.map(key))
  if (keys.size !== items.length) throw new NetworkError(copy('teamNetwork.shell.directoryDuplicates', { label }))
}

function validateDirectoryContinuation(
  hasMore: boolean,
  nextCursor: string | null,
  requestedCursor: string | null,
  consumedCursors: ReadonlySet<string>,
  label: NetworkCopy
): void {
  if (!hasMore) {
    if (nextCursor !== null) throw new NetworkError(copy('teamNetwork.shell.directoryInvalidFinal', { label }))
    return
  }
  if (
    !nextCursor
    || nextCursor === requestedCursor
    || consumedCursors.has(nextCursor)
  ) throw new NetworkError(copy('teamNetwork.shell.directoryStalled', { label }))
}

function validateCompleteMemberDirectory(
  details: TeamHubTeamDetails,
  status: TeamHubStatus,
  members: readonly TeamHubMembership[]
): void {
  const ids = new Set(members.map(member => member.principal_id))
  if (details.channels.some(channel => channel.participants.some(participant => !ids.has(participant)))) {
    throw new NetworkError(copy('teamNetwork.shell.membersMissingParticipants'))
  }
  const principalId = status.principal?.id
  const own = principalId ? members.find(member => member.principal_id === principalId) : null
  if (
    !own
    || own.role !== details.membership.role
    || own.status !== details.membership.status
  ) {
    throw new NetworkError(copy('teamNetwork.shell.membershipMissing'))
  }
}

function nextStatusSessionId(status: TeamHubStatus): string {
  const sessionId = status.session?.id?.trim()
  if (!sessionId) throw new NetworkError(copy('teamNetwork.shell.deviceSessionMismatch'))
  return sessionId
}

function validateCompleteDeviceSessions(
  authenticatedSessionId: string,
  sessions: readonly TeamHubDeviceSession[]
): void {
  const current = sessions.filter(session => session.current)
  if (current.length !== 1 || current[0]?.id !== authenticatedSessionId) {
    throw new NetworkError(copy('teamNetwork.shell.deviceSessionMissing'))
  }
}

function canWrite(details: TeamHubTeamDetails): boolean { return ['owner', 'admin', 'member', 'automation'].includes(details.membership.role) }

function canManageNetworkServers(status: TeamHubStatus | null, details: TeamHubTeamDetails | null): boolean {
  if (
    !status?.authenticated
    || !status.designatedHost
    || !details
    || details.team.status !== 'active'
    || details.membership.status !== 'active'
  ) return false
  if (status.authenticationMode === 'human' && ['owner', 'admin'].includes(details.membership.role)) return true
  // Automation membership alone is never removal authority. The main process
  // exposes this mode only after validating the exact server-managed actor.
  return status.serverManaged === true
    && status.authenticationMode === 'server'
    && status.principal?.kind === 'service'
    && details.team.role === 'automation'
    && details.membership.role === 'automation'
    && details.membership.principal_id === status.principal.id
}

function canRenameOwnHost(status: TeamHubStatus | null, details: TeamHubTeamDetails | null, server: TeamNetworkServer): boolean {
  return Boolean(status?.serverManaged && status.authenticationMode === 'server'
    && canManageNetworkServers(status, details) && server.is_host && server.owned_by_caller
    && server.status === 'active' && server.server_identity === status.serverIdentity)
}

function logicalServerStatus(server: TeamNetworkServer): string {
  if (server.is_host) return server.owned_by_caller ? t('teamNetwork.shell.hostThisServer') : t('teamNetwork.shell.host')
  if (server.status === 'active') return server.owned_by_caller ? t('teamNetwork.shell.linkedThisServer') : t('teamNetwork.shell.linked')
  return server.status === 'offline' ? t('teamNetwork.shell.offline') : t('teamNetwork.shell.suspended')
}

function scopeFrom(status: TeamHubStatus): TeamHubScope {
  if (!status.serverIdentity) throw new NetworkError(copy('teamNetwork.shell.activeIdentityUnavailable'))
  return {
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity,
    generation: status.generation,
    hubIdentity: status.hubIdentity,
    ...(status.connectionId ? { connectionId: status.connectionId } : {}),
    ...(status.hostServerIdentity ? { hostServerIdentity: status.hostServerIdentity } : {})
  }
}

function profileScope(status: TeamHubStatus) {
  if (!status.serverIdentity) throw new NetworkError(copy('teamNetwork.shell.activeIdentityUnavailable'))
  return { profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity }
}

function forgetBindingInputFromStatus(status: TeamHubStatus): TeamHubForgetBindingInput {
  if (!status.serverIdentity || !status.savedHubIdentity) {
    throw new NetworkError(copy('teamNetwork.shell.savedIdentityUnavailable'))
  }
  return {
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity,
    expectedGeneration: status.generation,
    expectedHubIdentity: status.savedHubIdentity
  }
}

function teamHubProfileKey(status: TeamHubStatus): string {
  return JSON.stringify([status.profileId, status.profileGeneration, status.serverIdentity])
}

function teamHubLifecycleKey(status: TeamHubStatus): string {
  return JSON.stringify([teamHubProfileKey(status), status.generation])
}


function workspaceRevision(workspace: TeamHubWorkspace): string {
  return JSON.stringify(workspace.teams.map(team => [
    team.id,
    team.display_name,
    team.role,
    team.status
  ]))
}


function teamContextKey(status: TeamHubStatus, teamId: string): string {
  return JSON.stringify([status.profileId, status.profileGeneration, status.serverIdentity, status.generation, status.hubIdentity, teamId])
}

function mailboxContextKey(status: TeamHubStatus, teamId: string, address: TeamNetworkMailboxAddress | null): string {
  return JSON.stringify([teamContextKey(status, teamId), address?.kind ?? null, address?.id ?? null])
}

function formValue(form: FormData, name: string): string { return String(form.get(name) ?? '').trim() }
function bodyBytes(body: string): number { return new TextEncoder().encode(body).byteLength }
function errorMessage(cause: unknown): NetworkCopy {
  return cause instanceof NetworkError ? cause.copy : cause instanceof Error ? cause.message : copy('teamNetwork.shell.requestFailed')
}
