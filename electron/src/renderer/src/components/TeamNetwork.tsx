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
import { useAppStore } from '../store/app-store'

export type TeamNetworkSection = 'feed' | 'mail' | 'skills' | 'directory'

const NETWORK_INITIAL_SCAN_MAX_PAGES = 256
const NETWORK_ROSTER_MAX_SERVERS = 25_600
const NETWORK_ROSTER_MAX_AGENTS = 262_144
const DIRECTORY_ADMIN_MAX_ITEMS = 2_000

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
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const localChatSessions = useAppStore(state => state.sessions)
  const currentChatSessionId = useAppStore(state => state.selectedSessionId)
  const lifecycleEpoch = useRef(0)
  const dataEpoch = useRef(0)
  const mutationEpoch = useRef(0)
  const mailboxAddressRef = useRef<TeamNetworkMailboxAddress | null>(null)
  const receiptInFlight = useRef(new Set<string>())
  const serverRemovalRequest = useRef(0)
  const serverRemovalInFlight = useRef(false)
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
      label: session.title || 'Untitled chat',
      current: session.id === currentChatSessionId
    })), [currentChatSessionId, localChatSessions])
  const routeMailToChat = useCallback(async (message: TeamMessageSummary, sessionId: string) => {
    const app = useAppStore.getState()
    const target = app.sessions.find(session => session.id === sessionId && !session.archived)
    if (!target) {
      setError('That chat is no longer available.')
      return
    }
    await app.selectSession(sessionId)
    const selected = useAppStore.getState()
    if (selected.selectedSessionId !== sessionId || selected.activeProfileId !== app.activeProfileId
      || selected.profileGeneration !== app.profileGeneration) {
      setError('The selected chat could not be opened.')
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
      : (message.title || message.preview || 'Team message').replace(/[\[\]\\\r\n]/g, ' ').slice(0,120)
    const prefix = `Read [${label}](${link}) from `
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
        throw new Error('The server returned data for a different team.')
      }
      validateUniqueDirectoryPage(nextDetails.members, member => member.principal_id, 'Team members')
      validateUniqueDirectoryPage(nextDetails.nodes, node => node.id, 'Team nodes')
      validateUniqueDirectoryPage(nextDetails.channels, channel => channel.id, 'Team channels')
      validateDirectoryContinuation(
        Boolean(nextDetails.membersHasMore),
        nextDetails.membersNextCursor ?? null,
        null,
        memberPageCursors.current,
        'Team members'
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
          if (errorMessage(cause).includes('does not support Team Messages yet')) return null
          throw cause
        })
        : Promise.resolve(null)
      // Prefetch only the visible Bulletin. Opening Mail or Directory must
      // not also fetch an unrelated feed.
      const initialFeedLoad: TeamFeedInitialLoad = teamMessagesRequest.then(nextCapability => (
        nextCapability && sectionRef.current === 'feed'
          ? startTeamFeedInitialLoad(scope, teamId)
          : { state: 'unavailable' as const }
      )).catch(cause => ({ state: 'error' as const, message: errorMessage(cause) }))
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
        if (!cursor || cursors.has(cursor)) throw new Error('Team Network returned a stalled continuation.')
        if (pageCount >= NETWORK_INITIAL_SCAN_MAX_PAGES) throw new Error('Team Network ownership scan exceeded the safe page limit.')
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
      setError('This message’s Team Network is no longer available to this server.')
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
      validateUniqueDirectoryPage(sessions.sessions, session => session.id, 'Device sessions')
      validateUniqueDirectoryPage(invitations.invitations, invitation => invitation.id, 'Pending invitations')
      validateDirectoryContinuation(
        sessions.has_more, sessions.next_cursor, null, deviceSessionPageCursors.current, 'Device sessions'
      )
      validateDirectoryContinuation(
        invitations.has_more, invitations.next_cursor, null, invitationPageCursors.current, 'Pending invitations'
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
        page.has_more, page.next_cursor, cursor, memberPageCursors.current, 'Team members'
      )
      const mergedMembers = mergeDirectoryPage(
        details.members,
        page.members,
        member => member.principal_id,
        'Team members'
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
        page.has_more, page.next_cursor, cursor, invitationPageCursors.current, 'Pending invitations'
      )
      const mergedInvitations = mergeDirectoryPage(
        pendingInvitations,
        page.invitations,
        invitation => invitation.id,
        'Pending invitations'
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
        page.has_more, page.next_cursor, cursor, deviceSessionPageCursors.current, 'Device sessions'
      )
      const mergedSessions = mergeDirectoryPage(
        deviceSessions,
        page.sessions,
        session => session.id,
        'Device sessions'
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
      setNotice(`${session.device_label} was signed out.`)
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
      setNotice(`The invitation for ${invitation.invitee_email} was revoked.`)
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
      setNotice(`${member.display_name}'s team access was updated.`)
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
          if (lifecycleEpoch.current === request) setNotice(`Team Network refresh failed: ${errorMessage(cause)}`)
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
        ? `Disconnected locally. Automatic connection is paused; the Teamspace on ${status.serverName || 'this server'} and its data are unchanged.`
        : 'Disconnected and signed out. The local binding remains saved; reopening Team Network may rediscover its availability, but cannot restore the cleared credential.'))
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
        ? `Forgot this app's cached Teamspace connection. The Teamspace on ${status.serverName || 'the server'} and its data were not changed.`
        : 'The saved local Team Network was forgotten.'))
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
      setError('This post is too large for the network.')
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
        throw new Error(matching.length
          ? 'More than one active secure connection matches this server. Refresh its connection details before removing it.'
          : 'This server no longer has active secure access. Refresh Team Network to update the roster.')
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
      setNotice(`${server.display_name} was removed from this Team Network. Its history is preserved; reconnecting requires a new invite.`)
      return true
    } catch (cause) {
      if (serverRemovalRequest.current === request && dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setError(errorMessage(cause))
      return false
    } finally {
      if (serverRemovalRequest.current === request) serverRemovalInFlight.current = false
      if (serverRemovalRequest.current === request && dataEpoch.current === epoch && context === teamContextKey(status, teamId)) setBusy(null)
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
  const bindingManagerLabel = status?.serverManaged ? 'Manage connection' : 'Manage network'
  const localBindingAction = hasManageableLocalBinding
    ? <button ref={bindingManagerTriggerRef} type="button" className="quiet-button network-manage-binding-action" aria-label={bindingManagerLabel} disabled={Boolean(busy)} onClick={openBindingManager}><Settings2 size={14} />{bindingManagerLabel}</button>
    : status && !status.serverManaged && status.transport !== 'secure_peer' && (localBindingWasStopped || canStartLocalConnection)
      ? <button type="button" className="quiet-button network-manage-binding-action" aria-label="Connect network" disabled={Boolean(busy)} onClick={() => void reconnectNetwork()}><RefreshCw size={14} />Connect network</button>
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
          title: 'Teamspace connection is paused',
          description: `${status.serverName || 'The selected AgentsServer'} still owns the Teamspace and all of its data. Reconnect restores only this app's local connection.`
        }
      : {
          title: `Connecting to ${status.serverName || 'this server'} Teamspace`,
          description: 'This Teamspace belongs to the selected AgentsServer. This app will retry the server connection automatically.'
        }
    : localBindingWasStopped && !status?.canForgetBinding
      ? {
          title: 'The local Team Network was forgotten',
          description: 'Nothing will reconnect automatically. Connect again only when you want to set up or join a network.'
        }
      : status?.canForgetBinding && status.connectionState === 'disconnected'
        ? {
            title: 'Your local Team Network is disconnected',
            description: 'The saved local network is still here. Reconnect it when you are ready, or forget it to start clean.'
          }
        : status?.connectionState === 'signed-out' && status.transport !== 'secure_peer'
          ? {
              title: 'Connect to your Team Network',
              description: 'Reconnect this server to restore access to its team.'
            }
          : status?.designatedHost
          ? {
              title: 'Create your Team Network',
              description: 'Set up the host once, then invite each server with a secure link.'
            }
          : {
              title: 'Set up Team Network',
              description: 'Start a new network on this server, or connect it to one you already have.'
            }

  const reconnectProfileKey = status ? teamHubProfileKey(status) : ''
  const startHostSetup = () => {
    if (!status?.serverIdentity) {
      setError('AgentsDock has not verified this server identity yet. Retry Team Network after the server reconnects.')
      return
    }
    const origin = {
      profileId: status.profileId,
      profileGeneration: status.profileGeneration,
      serverIdentity: status.serverIdentity,
      serverName: status.serverName?.trim() || 'Selected AgentsServer'
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
    <div className="teamspace-empty">{pendingInviteNotice}{error ? <><strong>{error}</strong><button className="primary-button" onClick={() => void loadStatus()}>Retry</button></> : <><LoaderCircle className="spin" size={18} />Opening team network…</>}</div>
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
          <div className="teamspace-kicker"><Server size={15} /> Team Network</div>
          <h1>Teamspace could not be loaded</h1>
          <p>{error || 'The server authenticated this app, but its Teamspace workspace is unavailable.'}</p>
          <button type="button" className="primary-button" onClick={() => void loadStatus()}>Retry Teamspace</button>
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
          <div className="teamspace-kicker"><Server size={15} /> Team Network</div>
          <h1>{onboardingCopy.title}</h1>
          <p>{onboardingCopy.description}</p>
        </div>
        <ServerIdentity status={status} />
        {pendingInviteNotice}
        {!status.serverManaged && status.designatedHost && status.connectionState === 'needs-bootstrap' && <CreateNetworkForm busy={busy} onSubmit={createNetwork} />}
        {!status.serverManaged && status.designatedHost && status.connectionState === 'signed-out' && <><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void reconnectNetwork()}>Reconnect server</button><details className="network-more"><summary>Legacy account access</summary><UseInvitationForm busy={busy} onSubmit={useInvitation} /><RecoverDeviceForm busy={busy} onSubmit={recoverDevice} /></details></>}
        {!status.serverManaged && !status.designatedHost && <><button type="button" className="network-create-host" disabled={Boolean(busy) || !status.serverIdentity} onClick={startHostSetup}>
          <span className="network-create-host-icon"><RadioTower size={19} /></span>
          <span><strong>Start a new Team Network here</strong><small>Make {status.serverName || 'this server'} the main host.</small></span>
          <ChevronRight size={17} />
        </button><div className="network-onboarding-divider"><span>or join an existing network</span></div><SecurePeerPanel
          status={status}
          networkError={error ?? status.error}
          initialInvite={pendingSecurePeerInvite?.invite}
          initialInviteRequestId={pendingSecurePeerInvite?.id}
          onInitialInviteHandled={onSecurePeerInviteHandled}
          onConnectionChanged={loadStatus}
          onActivated={connectNetwork}
          onRetryConnection={reconnectNetwork}
          connectionAttemptInFlight={busy === 'connect'}
        />{status.connectionState === 'signed-out' && status.transport !== 'secure_peer' && <details className="network-more"><summary>Legacy account access</summary><UseInvitationForm busy={busy} onSubmit={useInvitation} /><RecoverDeviceForm busy={busy} onSubmit={recoverDevice} /></details>}</>}
        {status.serverManaged && <div className="teamspace-host-help"><strong>{status.availabilityMessage || status.error || `Waiting for ${status.serverName || 'the selected server'}…`}</strong><button className="primary-button" onClick={() => void reconnectNetwork()}>{status.backgroundReconnectAllowed === false ? 'Reconnect' : 'Retry now'}</button></div>}
        {!status.serverManaged && status.designatedHost && ['offline', 'unavailable', 'error'].includes(status.connectionState) && <div className="teamspace-host-help"><strong>{status.availabilityMessage || status.error || 'This server is unavailable.'}</strong><button className="primary-button" onClick={() => void reconnectNetwork()}>Retry</button></div>}
        {status.designatedHost && error && <div className="teamspace-error" role="alert">{error}</div>}
      </div>
    </div>
    {localBindingManager}
  </NetworkShell>

  return <NetworkShell status={status} onClose={onClose} actions={<>
    {projection && <div className="network-header-summary" aria-label={`${projection.servers.length}${projectionHasMore ? ' or more' : ''} ${projection.servers.length === 1 && !projectionHasMore ? 'server' : 'servers'}`}>
      <span><Server size={13} /><strong>{projection.servers.length}{projectionHasMore && '+'}</strong>{projection.servers.length === 1 && !projectionHasMore ? 'server' : 'servers'}</span>
    </div>}
    {localBindingAction}
    {(canInvite || !status.serverManaged) && <Dialog.Root open={inviteOpen} onOpenChange={setInviteOpen}>
      <Dialog.Trigger asChild><button className="quiet-button network-invite-action" aria-label={status.designatedHost ? 'Invite' : 'Connect server'}>{status.designatedHost ? <UserPlus size={14} /> : <KeyRound size={14} />}{status.designatedHost ? 'Invite' : 'Connect server'}{status.designatedHost && pendingApprovals > 0 && <b className="network-nav-badge" aria-label={`${pendingApprovals} waiting`}>{pendingApprovals}</b>}</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="network-invite-backdrop">
          <Dialog.Content className="network-invite-sheet" onOpenAutoFocus={event => {
            event.preventDefault()
            inviteCloseButtonRef.current?.focus()
          }}>
            <header>
              <Dialog.Title className="sr-only">Invite and connect servers</Dialog.Title>
              <div><strong>{status.designatedHost ? 'Invite to your team' : 'Server connection'}</strong><Dialog.Description asChild><span>{status.serverName}</span></Dialog.Description></div>
              <Dialog.Close asChild><button ref={inviteCloseButtonRef} type="button" className="icon-button" aria-label="Close invite"><X size={16} /></button></Dialog.Close>
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
    <button className="icon-button" aria-label="Refresh team network" title="Refresh Team Network. Updates load on demand." disabled={Boolean(busy)} onClick={() => void loadStatus(status)}><RefreshCw className={busy === 'team' || busy === 'team-refresh' ? 'spin' : ''} size={15} /></button>
  </>}>
    <div className="teamspace-body network-body team-network-body">
      <nav className="teamspace-nav team-network-nav" aria-label="Team Network sections">
        <div className="team-network-nav-heading"><span>Workspace</span><strong>{details?.team.display_name || workspace.teams.find(team => team.id === selectedTeamId)?.display_name || 'Team Network'}</strong></div>
        {workspace.teams.length > 1 && <label className="teamspace-team-picker">Team<select value={selectedTeamId ?? ''} onChange={event => event.target.value && void loadTeamData(status, workspace, event.target.value)}>{workspace.teams.map(team => <option key={team.id} value={team.id}>{team.display_name}</option>)}</select></label>}
        <button
          className={section === 'mail' ? 'active' : ''}
          aria-label="Mail"
          aria-describedby={unreadMailboxCount || teamMessageUnreadOverflow ? 'team-network-mailbox-unread' : undefined}
          onClick={() => setSection('mail')}
        ><Inbox size={15} />Mail{(unreadMailboxCount > 0 || teamMessageUnreadOverflow) && <b className="network-nav-badge" aria-hidden="true">{unreadMailboxLabel}</b>}</button>
        {(unreadMailboxCount > 0 || teamMessageUnreadOverflow) && <span id="team-network-mailbox-unread" className="sr-only">{unreadMailboxLabel} unread {unreadMailboxCount === 1 && !teamMessageUnreadOverflow ? 'item' : 'items'}</span>}
        <button className={section === 'feed' ? 'active' : ''} title="Broadcast to everyone" onClick={() => setSection('feed')}><RadioTower size={15} />Bulletin</button>
        <button className={section === 'directory' ? 'active' : ''} onClick={() => setSection('directory')}><Server size={15} />{humanDirectory ? 'Servers & People' : 'Servers'}</button>
        <div className="teamspace-nav-spacer" />
        <article className="team-network-nav-footer">
          <span className="team-network-nav-server-icon"><Server size={16} /></span>
          <div><strong>{status.serverName || 'AgentsServer'}</strong><small>{status.designatedHost ? 'Network host' : 'Connected server'} · {details?.membership.role || 'member'}</small></div>
          <i className={`teamspace-status-dot ${status.connectionState}`} />
        </article>
      </nav>
      <main className="teamspace-content network-content team-network-content">
        {!inviteOpen && pendingInviteNotice}
        {busy === 'team' && <div className="teamspace-empty"><LoaderCircle className="spin" size={18} />Loading…</div>}
        {!busy && (!details || !projection || !capabilities) && <div className="teamspace-empty"><strong>Team data is unavailable.</strong><button className="primary-button" onClick={() => selectedTeamId && void loadTeamData(status, workspace, selectedTeamId)}>Retry</button></div>}
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
          onRouteMessage={(message, sessionId) => void routeMailToChat(message, sessionId)}
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
    {notice && <div className="teamspace-notice teamspace-error-toast" role="status">{notice}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
    {error && <div className="teamspace-error teamspace-error-toast" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
  </NetworkShell>
}

function NetworkShell({ status, onClose, actions, children }: { status: TeamHubStatus | null; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode }) {
  return <section className="teamspace" aria-label="Team Network">
    <header className="teamspace-header">
      <button className="icon-button" aria-label="Back to chats" title="Back to chats" onClick={onClose}><ArrowLeft size={17} /></button>
      <div><strong>Team Network <small className="team-network-beta">Beta</small></strong><span><i className={`teamspace-status-dot ${status?.connectionState ?? 'connecting'}`} />{status?.serverName || 'Active AgentsServer'}</span></div>
      <div className="teamspace-header-actions">{actions}</div>
    </header>
    {children}
  </section>
}

function TeamNetworkOpeningShell({ onClose, section }: { onClose: () => void; section: TeamNetworkSection }) {
  const active = section === 'skills' ? 'feed' : section
  const title = active === 'mail' ? 'Mail Board' : active === 'feed' ? 'Bulletin' : 'Servers & People'
  return <NetworkShell status={null} onClose={onClose}>
    <div className="teamspace-body network-body team-network-body" aria-busy="true">
      <nav className="teamspace-nav team-network-nav" aria-label="Team Network sections">
        <div className="team-network-nav-heading"><span>Workspace</span><strong>Team Network</strong></div>
        <button className={active === 'mail' ? 'active' : ''} disabled><Inbox size={15} />Mail</button>
        <button className={active === 'feed' ? 'active' : ''} disabled><RadioTower size={15} />Bulletin</button>
        <button className={active === 'directory' ? 'active' : ''} disabled><Bot size={15} />Servers &amp; People</button>
      </nav>
      <main className="teamspace-content network-content team-network-content">
        <section className="network-v2-surface"><header className="network-v2-header"><div><h1>{title}</h1><p>Checking current access…</p></div></header></section>
      </main>
    </div>
  </NetworkShell>
}

function ServerIdentity({ status }: { status: TeamHubStatus }) {
  const identity = status.serverIdentity
  const shortIdentity = identity ? `${identity.slice(0, 6)}…${identity.slice(-6)}` : 'Checking identity…'
  const ownershipLabel = status.serverManaged ? 'Teamspace host' : status.designatedHost ? 'Host' : 'This server'
  return <article className="network-server-identity"><span className="network-server-icon"><Server size={20} /></span><div><strong>{status.serverName || 'AgentsServer'}</strong><span title={identity || undefined}>Server identity · {shortIdentity}</span></div><b>{ownershipLabel}</b></article>
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
  const saved = Boolean(status.serverIdentity && status.savedHubIdentity && status.canForgetBinding)
  const connected = status.authenticated
  const serverManaged = status.serverManaged === true
  const canReconnect = !connected && (
    ['disconnected', 'offline', 'unavailable', 'error'].includes(status.connectionState)
    || (serverManaged && status.connectionState === 'signed-out')
  )
  const stateLabel = connected
    ? 'Connected'
    : status.connectionState === 'signed-out'
      ? 'Signed out'
      : status.connectionState === 'needs-bootstrap'
        ? 'Setup required'
        : saved
          ? 'Disconnected'
          : 'Not saved'
  const description = status.error || (serverManaged
    ? connected
      ? `This app is connected to the Teamspace owned by ${status.serverName || 'the selected AgentsServer'}.`
      : saved
        ? `Automatic connection is paused locally. Reconnect restores it; the Teamspace on ${status.serverName || 'the server'} is unchanged.`
        : `This app has no cached Teamspace connection. The Teamspace on ${status.serverName || 'the server'} is unchanged.`
    : connected
      ? 'This server is using its saved local Team Network binding.'
      : status.connectionState === 'signed-out'
        ? 'The local network is verified, but this server needs a person to sign in or recover the device.'
        : status.connectionState === 'needs-bootstrap'
          ? 'The local network is verified and waiting for its first owner.'
          : saved
            ? 'This server is signed out and its local binding remains saved. Reconnect re-verifies Hub availability; access still requires sign-in or device recovery.'
            : 'No local Team Network binding is saved for this server.')
  return <div className="network-invite-backdrop" role="presentation" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
    <aside className="network-invite-sheet network-binding-sheet" role="dialog" aria-modal="true" aria-label={serverManaged ? 'Manage Teamspace connection' : 'Manage local network'}>
      <header><div><strong>{serverManaged ? 'Teamspace connection' : 'Local network connection'}</strong><span>{status.serverName || 'AgentsServer'}</span></div><button type="button" className="icon-button" aria-label={serverManaged ? 'Close Teamspace connection manager' : 'Close local network manager'} disabled={busy} autoFocus onClick={onClose}><X size={16} /></button></header>
      <div>
        <section className="network-connect-panel" aria-label={serverManaged ? 'Teamspace connection' : 'Local Team Network binding'}>
          <header className="teamspace-section-heading network-connect-heading">
            <Settings2 size={18} />
            <div><h2>{serverManaged ? 'Manage connection' : 'Manage this server'}</h2><span>{serverManaged
              ? 'Disconnect pauses this app’s automatic connection. Forget clears only the local cached connection and preference; the server-owned Teamspace and its data stay intact.'
              : 'Disconnect signs this server out and clears its saved sign-in credential while preserving the local network identity. Forget removes that saved local binding.'}</span></div>
          </header>
          <article className={`network-connection-state ${connected ? 'is-connected' : 'needs-attention'}`} role="status">
            <span className="network-state-icon">{connected ? <ShieldCheck size={24} /> : <Unplug size={24} />}</span>
            <div className="network-state-copy"><span className="network-state-label">{stateLabel}</span><h3>{status.serverName || 'AgentsServer'}</h3><p>{description}</p></div>
            <div className="network-state-actions">
              {connected && saved && <button type="button" className="quiet-button" disabled={busy} onClick={onDisconnect}><Unplug size={15} />{serverManaged ? 'Disconnect' : 'Disconnect & sign out'}</button>}
              {canReconnect && <button type="button" className="primary-button" disabled={busy} onClick={onReconnect}><RefreshCw className={busy ? 'spin' : ''} size={15} />{saved ? 'Reconnect' : 'Connect again'}</button>}
              {saved && <button type="button" className="quiet-button danger" disabled={busy} onClick={onRequestForget}><Trash2 size={15} />{serverManaged ? 'Forget connection…' : 'Forget local network…'}</button>}
            </div>
            {confirmingForget && saved && <div className="secure-peer-destructive-confirm network-forget-confirm network-binding-forget-confirm">
              <span>{serverManaged
                ? `Clear this app's locally cached Teamspace connection and automatic-connect preference? The Teamspace on ${status.serverName || 'the server'} and its data will not be changed.`
                : <>{connected ? 'Disconnect this server, revoke its local session when possible, and delete the saved local Team Network binding?' : 'Delete the saved local Team Network binding from this server?'} You will need to set up or join the network again.</>}</span>
              <button type="button" className="quiet-button danger" disabled={busy} onClick={onForget}>Confirm forget</button>
              <button type="button" className="quiet-button" disabled={busy} onClick={onCancelForget}>{serverManaged ? 'Keep connection' : 'Keep network'}</button>
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
  const [body, setBody] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = body.trim()
    if (value && await onPost(value)) setBody('')
  }
  return <section className="network-surface network-bulletin" aria-label="Bulletin">
    <header className="network-surface-header"><span className="network-surface-icon"><RadioTower size={20} /></span><div><h1>Bulletin</h1><p>Broadcast to everyone.</p></div></header>
    <div className="network-scroll-region network-feed">
      {!posts.length && <div className="network-empty-state"><span className="network-empty-state-icon"><RadioTower size={22} /></span><h2>Nothing broadcast yet</h2><p>Messages shared with everyone will appear here.</p></div>}
      {posts.map(post => <article className="network-feed-item" key={post.id}><header><strong>{post.author.display_name}</strong><span>{new Date(post.created_at).toLocaleString()}</span></header><p>{post.body}</p>{post.reply_to_post_id && <small>Reply</small>}</article>)}
    </div>
    {canPost && <div className="network-composer-dock"><form className="network-simple-composer" onSubmit={submit}><label><span>New announcement</span><textarea aria-label="Bulletin post" rows={2} value={body} onChange={event => setBody(event.target.value)} placeholder="Share an update…" /></label><div><span>Text only on this server.</span><button className="primary-button" disabled={busy || !body.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}Post</button></div></form></div>}
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

  return <section className="network-surface network-mailbox" aria-label="Mail Board">
    <header className="network-surface-header">
      <span className="network-surface-icon"><Inbox size={20} /></span>
      <div><h1>Mail Board</h1><p>{unreadCount} unread · Use <code>/mail server &lt;name&gt; &lt;message&gt;</code> in Chat.</p></div>
      <label className="network-mailbox-switcher"><span>Receiving as</span><select aria-label="Receiving mailbox" value={address ? addressKey(address) : ''} onChange={event => chooseAddress(event.target.value)} disabled={!owned.length}><option value="" disabled>Choose mailbox</option>{owned.map(option => <option key={addressKey(option.address)} value={addressKey(option.address)}>{option.label}</option>)}</select></label>
    </header>
    {selectedBundle ? <MailBundleDetail bundle={selectedBundle} onBack={closeBundle} /> : <div className="network-scroll-region network-mail-board">
      {!address && <div className="network-empty-state"><span className="network-empty-state-icon"><Inbox size={22} /></span><h2>Choose a mailbox</h2><p>Select a local server or agent to view received mail.</p></div>}
      {address && !bundles.length && <div className="network-empty-state"><span className="network-empty-state-icon"><Mail size={22} /></span><h2>Nothing here yet</h2><p>Messages sent to this address will appear here, grouped by sender.</p></div>}
      {address && bundles.length > 0 && <div className="network-mail-board-grid" role="region" aria-label="Received mail bundles">{bundles.map(bundle => <button
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
        aria-label={`${bundle.sender.display_name}, ${bundle.entries.length} ${bundle.entries.length === 1 ? 'item' : 'items'}${bundle.unreadCount ? `, ${bundle.unreadCount} unread` : ''}`}
      >
        <span className="network-mail-bundle-card-header"><span className="network-mail-bundle-icon">{mailSenderIcon(bundle.sender.kind)}</span><span><strong>{bundle.sender.display_name}</strong><small>{mailAddressKind(bundle.sender.kind)}</small></span><time>{new Date(bundle.latest.item.created_at).toLocaleString()}</time></span>
        <span className="network-mail-bundle-preview">{bundle.latest.item.body}</span>
        <span className="network-mail-bundle-card-footer"><span>{bundle.entries.length} {bundle.entries.length === 1 ? 'item' : 'items'}</span>{bundle.unreadCount > 0 && <b>{bundle.unreadCount} new</b>}<ChevronRight size={15} /></span>
      </button>)}</div>}
    </div>}
  </section>
}

function MailBundleDetail({ bundle, onBack }: { bundle: TeamMailBundle; onBack: () => void }) {
  return <section className="network-mail-bundle-detail" aria-label={`Mail from ${bundle.sender.display_name}`}>
    <header><button type="button" className="quiet-button" aria-label="Back to mail board" autoFocus onClick={onBack}><ArrowLeft size={14} />Back</button><div><span className="network-mail-bundle-icon">{mailSenderIcon(bundle.sender.kind)}</span><div><h2>{bundle.sender.display_name}</h2><p>{bundle.entries.length} received {bundle.entries.length === 1 ? 'item' : 'items'} · read-only history</p></div></div></header>
    <div className="network-scroll-region network-mail-bundle-items">{bundle.entries.map(entry => {
      const unread = entry.delivery.state !== 'read'
      return <article key={entry.item.id} className={`network-mail-bundle-item ${unread ? 'unread' : ''}`} aria-label={`${unread ? 'Unread ' : ''}${mailKindLabel(entry.item.kind).toLowerCase()}`}>
        <header><span><strong>{mailKindLabel(entry.item.kind)}</strong><small>to {entry.item.to.display_name}</small></span><time>{new Date(entry.item.created_at).toLocaleString()}</time></header>
        <p>{entry.item.body}</p>
        <footer>{unread ? 'Unread' : 'Read'}{entry.item.request_id ? ' · Request history' : ''}</footer>
      </article>
    })}</div>
  </section>
}

function mailSenderIcon(kind: TeamNetworkMailboxEntry['item']['from']['kind']) {
  return kind === 'server' ? <Server size={17} /> : kind === 'agent' ? <Bot size={17} /> : <UserRound size={17} />
}

function mailAddressKind(kind: TeamNetworkMailboxEntry['item']['from']['kind']): string {
  return kind === 'server' ? 'Server' : kind === 'agent' ? 'Agent' : 'Person'
}

function mailKindLabel(kind: TeamNetworkMailboxEntry['item']['kind']): string {
  return kind === 'request' ? 'Request' : kind === 'reply' ? 'Reply' : 'Message'
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

function Directory({ projection, members, currentPrincipalId, busy, loadingMore, hasMore, canRemoveServers, removingServerId, onRemove, onOpenInbox, onLoadMore, administration }: { projection: TeamNetworkProjection; members: TeamHubTeamDetails['members']; currentPrincipalId: string | null; busy: boolean; loadingMore: boolean; hasMore: boolean; canRemoveServers: boolean; removingServerId: string | null; onRemove: (server: TeamNetworkServer) => Promise<boolean>; onOpenInbox: (server: TeamNetworkServer) => void; onLoadMore: () => void; administration: DirectoryAdministration }) {
  const showInvitations = administration.owner && (
    administration.pendingInvitations.length > 0 || administration.invitationsHasMore
  )
  const showDevices = administration.human && (
    administration.deviceSessions.length > 0 || administration.deviceSessionsHasMore
  )
  return <section className="network-surface network-agents" aria-label={administration.human ? 'Servers and people' : 'Servers'}>
    <header className="network-surface-header network-directory-header"><span className="network-surface-icon">{administration.human ? <Users size={20} /> : <Server size={20} />}</span><div><h1>{administration.human ? 'Servers & People' : 'Servers'}</h1><p>{administration.human ? 'Team members and connected servers.' : 'Servers connected to this team.'}</p></div>{administration.canInvite && <button
      type="button"
      className="primary-button network-directory-invite-action"
      onClick={administration.onInvite}
    ><UserPlus size={14} />Invite</button>}</header>
    <div className="network-scroll-region network-roster-list">
      {projection.servers.map(server => <ServerRow
        key={server.id}
        server={server}
        canRemove={canRemoveServers && !server.is_host && !server.owned_by_caller}
        canOpenInbox={server.owned_by_caller && server.status === 'active'}
        disabled={busy}
        removing={removingServerId === server.id}
        onRemove={onRemove}
        onOpenInbox={onOpenInbox}
      />)}
      {!projection.servers.length && <div className="network-empty-state"><span className="network-empty-state-icon"><Server size={22} /></span><h2>No connected servers</h2><p>Use Connect Servers to securely link another server. It will appear here automatically.</p></div>}
      {hasMore && <button type="button" className="quiet-button network-load-more" disabled={loadingMore || busy} onClick={onLoadMore}>{loadingMore && <LoaderCircle className="spin" size={14} />}Load more servers</button>}
      {administration.human && <section className="network-people-directory" aria-label="People"><header><UserRound size={15} /><strong>People</strong></header><div>{members.map(member => <MemberRow
        key={member.principal_id}
        member={member}
        current={member.principal_id === currentPrincipalId}
        canManage={administration.owner}
        disabled={busy || administration.loading}
        onUpdate={administration.onUpdateMember}
      />)}{!members.length && <p>No people are visible in this team.</p>}</div>{administration.membersHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreMembers}>Load more people</button>}</section>}
      {(showInvitations || showDevices) && <details className="network-more network-access-management">
        <summary>Manage access</summary>
        <div>
          {showInvitations && <section className="network-people-directory network-admin-list" aria-label="Pending invitations"><header><UserPlus size={15} /><strong>Pending invitations</strong></header><div>{administration.pendingInvitations.map(invitation => <InvitationRow key={invitation.id} invitation={invitation} disabled={busy || administration.loading} onRevoke={administration.onRevokeInvitation} />)}</div>{administration.invitationsHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreInvitations}>Load more invitations</button>}</section>}
          {showDevices && <section className="network-people-directory network-admin-list" aria-label="Signed-in devices"><header><ShieldCheck size={15} /><strong>Signed-in devices</strong></header><div>{administration.deviceSessions.map(session => <DeviceSessionRow key={session.id} session={session} disabled={busy || administration.loading} onRevoke={administration.onRevokeDeviceSession} />)}</div>{administration.deviceSessionsHasMore && <button type="button" className="quiet-button network-load-more" disabled={busy || administration.loading} onClick={administration.onLoadMoreDeviceSessions}>Load more devices</button>}</section>}
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
  const [pending, setPending] = useState<{ role: 'admin' | 'member' | 'guest' } | { status: 'active' | 'suspended' | 'revoked' } | null>(null)
  const manageable = canManage && !current && !['owner', 'automation'].includes(member.role)
  const apply = async () => {
    if (pending && await onUpdate(member, pending)) setPending(null)
  }
  const pendingLabel = pending && ('role' in pending
    ? `Change ${member.display_name}'s role to ${pending.role}?`
    : pending.status === 'revoked'
      ? `Permanently remove ${member.display_name} from this team?`
      : `${pending.status === 'active' ? 'Restore' : 'Suspend'} ${member.display_name}'s team access?`)
  return <article className="network-admin-row">
    <span className="network-mail-bundle-icon"><UserRound size={15} /></span>
    <div><strong>{member.display_name}{current ? ' (you)' : ''}</strong><small>{member.role} · {member.status}</small></div>
    {manageable && <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="icon-button network-person-menu" aria-label={`Manage ${member.display_name}`} disabled={disabled}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
      {(['admin', 'member', 'guest'] as const).filter(role => role !== member.role).map(role => <DropdownMenu.Item key={role} className="menu-item" disabled={member.status !== 'active'} onSelect={() => setPending({ role })}>Make {role}</DropdownMenu.Item>)}
      {member.status === 'active' && <DropdownMenu.Item className="menu-item" onSelect={() => setPending({ status: 'suspended' })}>Suspend access…</DropdownMenu.Item>}
      {member.status === 'suspended' && <DropdownMenu.Item className="menu-item" onSelect={() => setPending({ status: 'active' })}>Restore access…</DropdownMenu.Item>}
      <DropdownMenu.Item className="menu-item danger" onSelect={() => setPending({ status: 'revoked' })}><Trash2 size={14} />Remove from team…</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    {pending && <div className="network-admin-confirm" role="group" aria-label={`Confirm change for ${member.display_name}`}><span>{pendingLabel}</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void apply()}>Confirm</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setPending(null)}>Cancel</button></div>}
  </article>
}

function InvitationRow({ invitation, disabled, onRevoke }: { invitation: TeamHubInvitationSummary; disabled: boolean; onRevoke: DirectoryAdministration['onRevokeInvitation'] }) {
  const [confirming, setConfirming] = useState(false)
  const revoke = async () => { if (await onRevoke(invitation)) setConfirming(false) }
  return <article className="network-admin-row"><span className="network-mail-bundle-icon"><Mail size={15} /></span><div><strong>{invitation.invitee_email}</strong><small>{invitation.role} · expires {new Date(invitation.expires_at).toLocaleString()}</small></div><button type="button" className="quiet-button danger" disabled={disabled} onClick={() => setConfirming(true)}>Revoke…</button>{confirming && <div className="network-admin-confirm" role="group" aria-label={`Revoke invitation for ${invitation.invitee_email}`}><span>This invitation will stop working immediately.</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void revoke()}>Revoke invitation</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setConfirming(false)}>Keep invitation</button></div>}</article>
}

function DeviceSessionRow({ session, disabled, onRevoke }: { session: TeamHubDeviceSession; disabled: boolean; onRevoke: DirectoryAdministration['onRevokeDeviceSession'] }) {
  const [confirming, setConfirming] = useState(false)
  const revoke = async () => { if (await onRevoke(session)) setConfirming(false) }
  return <article className="network-admin-row"><span className="network-mail-bundle-icon"><ShieldCheck size={15} /></span><div><strong>{session.device_label}{session.current ? ' (this device)' : ''}</strong><small>Last seen {new Date(session.last_seen_at).toLocaleString()} · expires {new Date(session.expires_at).toLocaleDateString()}</small></div>{session.current ? <b>Current</b> : <button type="button" className="quiet-button danger" disabled={disabled} onClick={() => setConfirming(true)}>Sign out…</button>}{confirming && !session.current && <div className="network-admin-confirm" role="group" aria-label={`Sign out ${session.device_label}`}><span>Revoke this device session? It will need a new recovery proof to sign in again.</span><button type="button" className="danger-button" disabled={disabled} onClick={() => void revoke()}>Sign out device</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => setConfirming(false)}>Keep signed in</button></div>}</article>
}

function ServerRow({ server, canOpenInbox, canRemove, disabled, removing, onRemove, onOpenInbox }: { server: TeamNetworkServer; canOpenInbox: boolean; canRemove: boolean; disabled: boolean; removing: boolean; onRemove: (server: TeamNetworkServer) => Promise<boolean>; onOpenInbox: (server: TeamNetworkServer) => void }) {
  const [confirming, setConfirming] = useState(false)
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
    <header><Server size={18} /><div><strong title={server.server_identity}>{server.display_name}</strong><span className={server.status}>{logicalServerStatus(server)}</span></div><div className="network-roster-server-meta">{canOpenInbox && <button type="button" className="quiet-button network-roster-inbox" disabled={disabled} onClick={() => onOpenInbox(server)}><Inbox size={14} />Inbox</button>}{canRemove && <DropdownMenu.Root><DropdownMenu.Trigger asChild><button ref={menuTrigger} type="button" className="icon-button network-roster-server-menu" aria-label={`Manage ${server.display_name}`} disabled={disabled}>{removing ? <LoaderCircle className="spin" size={15} /> : <MoreHorizontal size={16} />}</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end"><DropdownMenu.Item className="menu-item danger" onSelect={() => setConfirming(true)}><Trash2 size={14} />Remove from network…</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}</div></header>
    {confirming && <div className="network-server-remove-confirm" role="group" aria-label={`Remove ${server.display_name}`}><div><strong>Remove “{server.display_name}” from this Team Network?</strong><span>Its secure access will be revoked and its optional directory entries will disappear here. Existing history remains. Reconnecting requires a new invite.</span></div><div><button type="button" className="danger-button" disabled={disabled} onClick={() => void remove()}>{removing && <LoaderCircle className="spin" size={14} />}Remove server</button><button type="button" className="quiet-button" disabled={disabled} onClick={() => { setConfirming(false); queueMicrotask(() => menuTrigger.current?.focus()) }}>Keep server</button></div></div>}
  </article>
}

function CreateNetworkForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="teamspace-form teamspace-enrollment-form" onSubmit={onSubmit}><label>Team name<input required name="teamName" maxLength={120} placeholder="My team" /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'create' && <LoaderCircle className="spin" size={14} />}Create team network</button></form>
}

function PendingInviteNotice({ status, onCancel }: { status: TeamHubStatus | null; onCancel: () => void }) {
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const [error, setError] = useState<string | null>(null)
  const selectServer = async (profileId: string) => {
    setError(null)
    try {
      if (!await useAppStore.getState().switchServer(profileId)) setError('The server could not be selected. Your invite is still saved.')
    } catch (cause) { setError(errorMessage(cause)) }
  }
  return <aside className="teamspace-host-help" aria-label="Pending team invite">
    <strong>{status?.designatedHost ? 'Choose another server to use this invite' : 'Choose the server you want to connect'}</strong>
    <span>{status?.designatedHost ? 'This server already hosts a team. Your invite will stay here while you choose another server.' : 'The invite is kept until you send a connection request or cancel it.'}</span>
    {profiles.length > 1 ? <label className="teamspace-team-picker">Server to connect<select value={activeProfileId ?? ''} disabled={Boolean(switchingProfileId)} onChange={event => void selectServer(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label> : <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('settings', true)}>Add another server in Settings</button>}
    <button type="button" className="quiet-button" onClick={onCancel}>Cancel invite</button>
    {error && <span role="alert">{error}</span>}
  </aside>
}

function UseInvitationForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="teamspace-form teamspace-enrollment-form" onSubmit={onSubmit}><div className="teamspace-section-heading"><KeyRound size={16} /><div><strong>Use your invitation file</strong><span>For a person signing in on this server.</span></div></div><label>Email<input required name="email" type="email" /></label><label>Your name<input required name="displayName" /></label><label>Device name<input required name="deviceLabel" defaultValue="AgentsDock Desktop" /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'invitation' && <LoaderCircle className="spin" size={14} />}Choose file</button></form>
}

function RecoverDeviceForm({ busy, onSubmit }: { busy: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="teamspace-form teamspace-enrollment-form" aria-label="Recover signed-out device" onSubmit={onSubmit}><div className="teamspace-section-heading"><ShieldCheck size={16} /><div><strong>Recover an existing person</strong><span>Choose the ten-minute recovery proof created on the Teamspace host. The proof stays in the main process.</span></div></div><label>Recovery device name<input required name="deviceLabel" defaultValue="AgentsDock Desktop" /></label><button className="primary-button" disabled={Boolean(busy)}>{busy === 'recovery' && <LoaderCircle className="spin" size={14} />}Choose recovery proof</button></form>
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
  ) throw new Error('Team Network returned a page for a different network.')
  if (
    current.servers.length + page.servers.length > NETWORK_ROSTER_MAX_SERVERS
    || current.agents.length + page.agents.length > NETWORK_ROSTER_MAX_AGENTS
  ) throw new Error('Team Network roster exceeded the safe display limit.')
  const lastPageServerId = page.servers.at(-1)?.id ?? null
  if (
    (lastPageServerId === null && (page.next_after_server_id !== null || page.has_more))
    || (lastPageServerId !== null && page.next_after_server_id !== lastPageServerId)
  ) throw new Error('Team Network returned an invalid continuation.')

  const serverIds = new Set(current.servers.map(server => server.id))
  const serverIdentities = new Set(current.servers.map(server => server.server_identity))
  let previousServerId = current.servers.at(-1)?.id ?? null
  for (const server of page.servers) {
    if (
      (previousServerId !== null && server.id <= previousServerId)
      || serverIds.has(server.id)
      || serverIdentities.has(server.server_identity)
    ) throw new Error('Team Network returned an overlapping server page.')
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
      throw new Error('Team Network returned an overlapping agent page.')
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
  if (merged.size > DIRECTORY_ADMIN_MAX_ITEMS) throw new Error('This directory exceeds the desktop safety limit.')
  return [...merged.values()]
}

function mergeDirectoryPage<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
  label: string
): T[] {
  const currentKeys = new Set(current.map(key))
  if (currentKeys.size !== current.length) {
    throw new Error(`${label} contains duplicate existing items.`)
  }
  const incomingKeys = new Set<string>()
  for (const item of incoming) {
    const id = key(item)
    if (currentKeys.has(id) || incomingKeys.has(id)) {
      throw new Error(`${label} returned a duplicate item across pages.`)
    }
    incomingKeys.add(id)
  }
  return mergeDirectoryItems(current, incoming, key)
}

function validateUniqueDirectoryPage<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string
): void {
  const keys = new Set(items.map(key))
  if (keys.size !== items.length) throw new Error(`${label} returned duplicate items.`)
}

function validateDirectoryContinuation(
  hasMore: boolean,
  nextCursor: string | null,
  requestedCursor: string | null,
  consumedCursors: ReadonlySet<string>,
  label: string
): void {
  if (!hasMore) {
    if (nextCursor !== null) throw new Error(`${label} returned an invalid final continuation.`)
    return
  }
  if (
    !nextCursor
    || nextCursor === requestedCursor
    || consumedCursors.has(nextCursor)
  ) throw new Error(`${label} returned a stalled continuation.`)
}

function validateCompleteMemberDirectory(
  details: TeamHubTeamDetails,
  status: TeamHubStatus,
  members: readonly TeamHubMembership[]
): void {
  const ids = new Set(members.map(member => member.principal_id))
  if (details.channels.some(channel => channel.participants.some(participant => !ids.has(participant)))) {
    throw new Error('Team members did not include every channel participant after the final page.')
  }
  const principalId = status.principal?.id
  const own = principalId ? members.find(member => member.principal_id === principalId) : null
  if (
    !own
    || own.role !== details.membership.role
    || own.status !== details.membership.status
  ) {
    throw new Error('Team members did not include your authoritative membership after the final page.')
  }
}

function nextStatusSessionId(status: TeamHubStatus): string {
  const sessionId = status.session?.id?.trim()
  if (!sessionId) throw new Error('Device sessions could not be matched to the authenticated session.')
  return sessionId
}

function validateCompleteDeviceSessions(
  authenticatedSessionId: string,
  sessions: readonly TeamHubDeviceSession[]
): void {
  const current = sessions.filter(session => session.current)
  if (current.length !== 1 || current[0]?.id !== authenticatedSessionId) {
    throw new Error('Device sessions did not include exactly one matching current session after the final page.')
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

function logicalServerStatus(server: TeamNetworkServer): string {
  if (server.is_host) return server.owned_by_caller ? 'Host · this server' : 'Host'
  if (server.status === 'active') return server.owned_by_caller ? 'Linked · this server' : 'Linked'
  return server.status === 'offline' ? 'Offline' : 'Suspended'
}

function scopeFrom(status: TeamHubStatus): TeamHubScope {
  if (!status.serverIdentity) throw new Error('The active AgentsServer identity is unavailable.')
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
  if (!status.serverIdentity) throw new Error('The active AgentsServer identity is unavailable.')
  return { profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity }
}

function forgetBindingInputFromStatus(status: TeamHubStatus): TeamHubForgetBindingInput {
  if (!status.serverIdentity || !status.savedHubIdentity) {
    throw new Error('The saved local Team Network identity is unavailable.')
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
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : 'Team network request failed.' }
