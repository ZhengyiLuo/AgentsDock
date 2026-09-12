// Localized display strings use semantic catalog keys.
import { getLocale } from '@shared/i18n'
import { localeOptions } from '@shared/locales'
import { useLocale } from '../lib/i18n'
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Command, Copy, Download, ExternalLink, FileText, FolderOpen, GitFork, Import, KeyRound, Laptop, LoaderCircle, Network, RefreshCw, RotateCcw, Search, Server, Sparkles, X } from 'lucide-react'
import type { AppUpdateStatus, AppUpdateTrack, Backend, BulkImportSessionItem, BulkImportSessionResult, ChatReference, ChatReferenceAction, CreateJobInput, Health, Job, JobContextMode, JobScheduleKind, LocalSessionCandidate, ServerRestartBlockerSnapshot, ServerSetupCapabilities, ServerSetupProgress, ServerUpdateStatus, ServerUpdateTrack, Session, TeamReference, UpdateJobInput, WorkspaceProfileScope } from '@shared/types'
import { localSessionImportKey, localSessionImportSupported } from '@shared/local-session-import'
import { cursorBackendAvailable, cursorBackendUnavailableReason, runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeEffortOptions, runtimeSelectionError, selectableChatBackends } from '@shared/runtime-catalog'
import { isLoopbackHostname } from '@shared/team-hub-url'
import { trackEvent } from '../lib/analytics'
import { readAppearance, setAppearanceMode, type AppearanceMode } from '../lib/appearance'
import { t, useLanguagePreference, type LanguagePreference } from '../lib/i18n'
import { canonicalizeLocalRouteHints, chatMentionTrigger, chatReferenceDisplayText, currentRouteHintReference, insertChatReference, parseStoredChatReferences, reconcileChatReferences, routeHintMentionsAvailable, supportedCrossChatTargetBackends, validChatReferences, type ChatMentionTrigger } from '../lib/chat-references'
import { atomicComposerReferenceCaret, atomicComposerReferenceDeletion, atomicComposerReferenceNavigation, insertTeamReference, orderedComposerReferenceSpans, parseStoredTeamReferences, reconcileTeamReferences, teamMentionTrigger, teamMessagesAvailable, teamReferenceText, validComposerReferences, validTeamReferences, type TeamMentionTrigger } from '../lib/team-references'
import { backendLabel, formatTime, runtimeLabel } from '../lib/format'
import { useProfileSearch } from '../lib/profile-search'
import { historyResultsBySession, openSessionHistoryResult, useSessionHistorySearch } from '../lib/session-history-search'
import { effectiveScheduleKind, formatScheduleWallTime, jobLoopsForever, parseScheduleWallTime, supportedTimezones, validateJobSchedule } from '../lib/job-schedule'
import { digestTargetSections, orderedActiveSessions, rankSessionsForSearch, sessionNameMatchRank } from '../lib/sessions'
import { useTransientClose } from '../lib/transient-close'
import { captureWorkspaceScope } from '../lib/workspace-preferences'
import { saveNewChatDefaults, useAppStore, waitForWorkspaceReady } from '../store/app-store'
import { BackendMark } from './BackendMark'
import { ChatShareDialog } from './ChatShareDialog'
import { CodexServerSettings } from './CodexServerSettings'
import { RuntimeHealthPanel } from './RuntimeHealth'
import { ServerManagement } from './ServerManagement'
import { ShortcutKey } from './ShortcutTooltip'
import { WorkingDirectoryInput } from './WorkingDirectoryInput'
import { ADD_SERVER_EVENT, MANAGE_SERVERS_EVENT } from './ServerSelector'
import { TeamMentionPalette, type TeamMentionCandidate } from './Composer'
import { parseServerUpdateIntents, serverUpdateIntentKey, serverUpdateIntentResolved, serverUpdateIntentHealthResolved, serverUpdateStartErrorIsAmbiguous, type ServerUpdateIntent } from '../lib/server-update-intent'

const AGENTS_SERVER_SETUP_GUIDE_URL = 'https://github.com/ZhengyiLuo/AgentsServer/tree/v0.1.20#guided-setup'
const DEFERRED_SERVER_UPDATES_STORAGE_KEY = 'agentsdock:deferred-server-updates:v1'
const SUBMITTED_SERVER_UPDATES_STORAGE_KEY = 'agentsdock:submitted-server-updates:v1'
const UNKNOWN_SERVER_UPDATE_MESSAGE = 'Update outcome is not confirmed. AgentsDock will check status while Settings is open; it will not submit another update.'

function readSubmittedServerUpdates(): Record<string, ServerUpdateIntent> {
  try { return parseServerUpdateIntents(window.localStorage.getItem(SUBMITTED_SERVER_UPDATES_STORAGE_KEY)) } catch { return {} }
}
const ACTIVE_SERVER_UPDATE_PHASES = new Set<ServerUpdateStatus['phase']>([
  'pending',
  'starting',
  'checking',
  'downloading',
  'verifying',
  'installing',
  'restarting'
])
const PENDING_SERVER_UPDATE_USABILITY_MESSAGE = 'AgentsDock remains usable while this update is pending. Starting new work can defer installation until the server is idle again.'

type ServerSetupIntent = 'setup' | 'update-beta' | 'host-team-network'

interface TeamNetworkHostOrigin {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  serverName: string
}

interface DeferredServerUpdate {
  profileId: string
  serverIdentity: string | null
  serverUrl: string | null
  track: ServerUpdateTrack
  version: string
  queuedAt: string
  /** Compatibility gate for older servers that reject durable queued turns. */
  waitForQueuedTurns: boolean
}

type DeferredServerUpdates = Record<string, DeferredServerUpdate>
type DeferredServerUpdateAttempt = {
  profileId: string
  phase: 'checking' | 'starting'
}

interface ServerRestartTarget {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  serverInstanceId: string
  profileName: string
  serverUrl: string
}

interface PendingServerUpdateReservation {
  scheduleId: string
  targetVersion: string
  track: ServerUpdateTrack
  restartMode: 'verified-legacy' | 'schedule-bound'
}

type RestartAfterUpdateTarget = Pick<
  ServerRestartTarget,
  'profileId' | 'serverIdentity' | 'profileName' | 'serverUrl'
>

const SERVER_RESTART_COUNT_LIMIT = 1_000_000
const SERVER_RESTART_REVISION_PATTERN = /^[0-9a-f]{64}$/
const SERVER_UPDATE_SCHEDULE_ID_PATTERN = /^[0-9a-f]{32}$/
const SCOPED_SERVER_UPDATE_CAPABILITY_VERSION = 9

function readDeferredServerUpdates(): DeferredServerUpdates {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEFERRED_SERVER_UPDATES_STORAGE_KEY) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const updates: DeferredServerUpdates = {}
    for (const [profileId, candidate] of Object.entries(parsed)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const value = candidate as Partial<DeferredServerUpdate>
      if (
        value.profileId !== profileId
        || (value.track !== 'stable' && value.track !== 'beta')
        || typeof value.version !== 'string'
        || !value.version.trim()
      ) continue
      updates[profileId] = {
        profileId,
        serverIdentity: typeof value.serverIdentity === 'string' ? value.serverIdentity : null,
        serverUrl: typeof value.serverUrl === 'string' ? value.serverUrl : null,
        track: value.track,
        version: value.version.trim(),
        queuedAt: typeof value.queuedAt === 'string' ? value.queuedAt : new Date().toISOString(),
        waitForQueuedTurns: value.waitForQueuedTurns === true
      }
    }
    return updates
  } catch {
    return {}
  }
}

function writeDeferredServerUpdates(updates: DeferredServerUpdates): void {
  try {
    if (Object.keys(updates).length === 0) window.localStorage.removeItem(DEFERRED_SERVER_UPDATES_STORAGE_KEY)
    else window.localStorage.setItem(DEFERRED_SERVER_UPDATES_STORAGE_KEY, JSON.stringify(updates))
  } catch {
    // A denied localStorage write should not prevent a same-process update.
  }
}

function serverUpdateIsActive(status: ServerUpdateStatus | null | undefined): boolean {
  return Boolean(status && ACTIVE_SERVER_UPDATE_PHASES.has(status.phase))
}

function serverUpdateHasStarted(status: ServerUpdateStatus | null | undefined): boolean {
  return Boolean(status && status.phase !== 'pending' && serverUpdateIsActive(status))
}

function serverTrackForStatus(status: ServerUpdateStatus): ServerUpdateTrack {
  if (status.track) return status.track
  return status.current_version.split('+', 1)[0].includes('-') ? 'beta' : 'stable'
}

function serverUpdateCapabilityVersion(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const version = (value as { version?: unknown }).version
  return typeof version === 'number' && Number.isFinite(version) ? version : 0
}

function serverSupportsPassiveUpdateReservation(health: Health | null | undefined): boolean {
  return serverUpdateCapabilityVersion(health?.capabilities?.server_updates) >= 7
}

function supportsLegacyLoopbackServerUpdate(health: Health | null | undefined, serverUrl: string | null | undefined): boolean {
  const capability = health?.capabilities?.server_updates
  const capabilityVersion = serverUpdateCapabilityVersion(capability)
  if (capabilityVersion < 2 || capabilityVersion >= SCOPED_SERVER_UPDATE_CAPABILITY_VERSION || !serverUrl) return false
  if (!capability || typeof capability !== 'object' || Array.isArray(capability) || (capability as { available?: unknown }).available !== true) return false
  try {
    const parsed = new URL(serverUrl)
    return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

function serverUpdateStartWasAccepted(
  status: ServerUpdateStatus,
  requestedVersion?: string,
  requestedTrack?: ServerUpdateTrack
): boolean {
  if (!requestedVersion) return false
  if (requestedTrack && status.track && status.track !== requestedTrack) return false
  if (serverUpdateIsActive(status)) return status.target_version === requestedVersion
  if (status.phase === 'complete' || status.phase === 'current') {
    return status.current_version === requestedVersion || status.target_version === requestedVersion
  }
  return false
}

function serverWorkCounts(health: Health | null | undefined): { active: number; queued: number } {
  const active = Math.max(
    health?.active_sessions?.length || 0,
    health?.active?.length || 0,
    health?.active_runs?.length || 0
  )
  const queued = Object.values(health?.queued || {}).reduce((total, count) => (
    total + (typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0)
  ), 0)
  return { active, queued }
}

function serverUpdateBlockingQueuedTurns(health: Health | null | undefined): number {
  const advertised = health?.update_blocking_queued_count
  const queueSafeUpdates = serverUpdateCapabilityVersion(health?.capabilities?.server_updates) >= 3
  return queueSafeUpdates
    && typeof advertised === 'number'
    && Number.isInteger(advertised)
    && advertised >= 0
    ? advertised
    : serverWorkCounts(health).queued
}

function serverWorkDescription(active: number, queued: number): string {
  return [
    active > 0 ? `${active} active ${active === 1 ? 'turn' : 'turns'}` : '',
    queued > 0 ? `${queued} queued ${queued === 1 ? 'turn' : 'turns'}` : ''
  ].filter(Boolean).join(' and ')
}

function boundedServerRestartCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value)
    ? Math.min(SERVER_RESTART_COUNT_LIMIT, Math.max(0, Math.floor(value)))
    : 0
}

function validatedServerRestartBlockerSnapshot(value: unknown): ServerRestartBlockerSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<ServerRestartBlockerSnapshot>
  if (
    raw.version !== 2
    || typeof raw.revision !== 'string'
    || !SERVER_RESTART_REVISION_PATTERN.test(raw.revision)
    || typeof raw.has_forceable_blockers !== 'boolean'
    || typeof raw.has_safety_blockers !== 'boolean'
    || typeof raw.has_blockers !== 'boolean'
    || typeof raw.tmux_server_in_service_cgroup !== 'boolean'
    || typeof raw.tmux_server_cgroup_unknown !== 'boolean'
  ) return null
  const snapshot: ServerRestartBlockerSnapshot = {
    version: 2,
    revision: raw.revision,
    active_count: boundedServerRestartCount(raw.active_count),
    restart_blocking_queued_count: boundedServerRestartCount(raw.restart_blocking_queued_count),
    provider_background_count: boundedServerRestartCount(raw.provider_background_count),
    tmux_server_in_service_cgroup: raw.tmux_server_in_service_cgroup,
    tmux_server_cgroup_unknown: raw.tmux_server_cgroup_unknown,
    server_maintenance_count: boundedServerRestartCount(raw.server_maintenance_count),
    mutation_count: boundedServerRestartCount(raw.mutation_count),
    deleting_session_count: boundedServerRestartCount(raw.deleting_session_count),
    codex_goals_reconfiguring: raw.codex_goals_reconfiguring === true,
    has_forceable_blockers: raw.has_forceable_blockers,
    has_safety_blockers: raw.has_safety_blockers,
    has_blockers: raw.has_blockers
  }
  const hasForceable = snapshot.active_count > 0
    || snapshot.restart_blocking_queued_count > 0
    || snapshot.provider_background_count > 0
    || snapshot.tmux_server_in_service_cgroup
    || snapshot.tmux_server_cgroup_unknown
  const hasSafety = snapshot.server_maintenance_count > 0
    || snapshot.mutation_count > 0
    || snapshot.deleting_session_count > 0
    || snapshot.codex_goals_reconfiguring
  if (
    snapshot.has_forceable_blockers !== hasForceable
    || snapshot.has_safety_blockers !== hasSafety
    || snapshot.has_blockers !== (hasForceable || hasSafety)
  ) return null
  // AgentsServer 0.1.26-beta.30+ advertises that a forced restart overrides
  // every blocker in the snapshot (including safety blockers) and marks
  // best-effort snapshots taken while an admission lock was wedged.
  if (raw.force_restart_available === true) snapshot.force_restart_available = true
  if (raw.snapshot_degraded === true) snapshot.snapshot_degraded = true
  return snapshot
}

/** Whether the server has said Force Restart overrides safety-critical work too. */
function forceRestartOverridesSafety(snapshot: ServerRestartBlockerSnapshot | null | undefined): boolean {
  return snapshot?.force_restart_available === true
}

/**
 * Whether the "Review force restart" path should be offered for a blocker
 * snapshot. Servers that override safety-critical work (beta.30+) allow it for
 * any blocker; older servers only when every blocker is forceable.
 */
function forceRestartReviewAvailable(snapshot: ServerRestartBlockerSnapshot | null | undefined): boolean {
  // beta.30+ makes Force Restart an always-available recovery path. A wedged
  // admission lock can make the bounded status snapshot report no counted
  // blockers even though the ordinary restart just failed, so do not gate the
  // recovery control on has_blockers for that contract.
  if (forceRestartOverridesSafety(snapshot)) return true
  if (!snapshot?.has_blockers) return false
  return snapshot.has_forceable_blockers && !snapshot.has_safety_blockers
}

function serverRestartBlockerDescriptions(snapshot: ServerRestartBlockerSnapshot): string[] {
  const count = (value: number) => value.toLocaleString('en-US')
  return [
    snapshot.active_count > 0
      ? `${count(snapshot.active_count)} active ${snapshot.active_count === 1 ? 'turn' : 'turns'}`
      : '',
    snapshot.restart_blocking_queued_count > 0
      ? `${count(snapshot.restart_blocking_queued_count)} non-durable queued ${snapshot.restart_blocking_queued_count === 1 ? 'turn' : 'turns'}`
      : '',
    snapshot.provider_background_count > 0
      ? `${count(snapshot.provider_background_count)} provider background ${snapshot.provider_background_count === 1 ? 'task' : 'tasks'}`
      : '',
    snapshot.tmux_server_in_service_cgroup
      ? t("ui.Dialogs.serverRestartBlockerDescriptions.tmux_server_is_inside_agents_server_servic_0329fec")
      : '',
    snapshot.tmux_server_cgroup_unknown
      ? t("ui.Dialogs.serverRestartBlockerDescriptions.tmux_server_isolation_could_not_be_verifie_93cfdc6")
      : '',
    snapshot.server_maintenance_count > 0
      ? `${count(snapshot.server_maintenance_count)} server maintenance ${snapshot.server_maintenance_count === 1 ? 'operation' : 'operations'}`
      : '',
    snapshot.mutation_count > 0
      ? `${count(snapshot.mutation_count)} in-flight control ${snapshot.mutation_count === 1 ? 'request' : 'requests'}`
      : '',
    snapshot.deleting_session_count > 0
      ? `${count(snapshot.deleting_session_count)} session ${snapshot.deleting_session_count === 1 ? 'deletion' : 'deletions'}`
      : '',
    snapshot.codex_goals_reconfiguring ? t("ui.Dialogs.serverRestartBlockerDescriptions.codex_goal_reconfiguration_cf6e1ec") : '',
    snapshot.snapshot_degraded
      ? t("ui.Dialogs.serverRestartBlockerDescriptions.blocker_snapshot_was_degraded_some_active__50a6160")
      : ''
  ].filter(Boolean)
}

function deferredServerUpdateMessage(
  version: string,
  track: ServerUpdateTrack,
  active: number,
  queued: number
): string {
  const work = serverWorkDescription(active, queued)
  const verb = active + queued === 1 ? 'finishes' : 'finish'
  const channel = track === 'beta' ? 'Beta' : 'Stable'
  return work
    ? `Waiting to install the latest ${channel} (currently ${version}) after ${work} ${verb}. No work will be stopped. ${PENDING_SERVER_UPDATE_USABILITY_MESSAGE}`
    : t("ui.Dialogs.deferredServerUpdateMessage.installing_the_latest_as_soon_as_the_serve_8417e12", { "channel": String(channel), "usability": String(PENDING_SERVER_UPDATE_USABILITY_MESSAGE) })
}

function serverUpdateMessage(
  status: ServerUpdateStatus | null | undefined,
  health: Health | null | undefined
): string | null {
  if (status?.phase === 'current') return t("ui.Dialogs.serverUpdateMessage.this_is_the_latest_one_0791214")
  const statusMessage = status?.message?.trim() || null
  if (status?.phase !== 'pending') return statusMessage
  const blockerMessage = serverUpdateBlockerMessage(status)
  const usabilityMessage = serverSupportsPassiveUpdateReservation(health)
    && !(statusMessage && /\b(?:remains usable|work remains available|new work can defer)\b/i.test(statusMessage))
    ? PENDING_SERVER_UPDATE_USABILITY_MESSAGE
    : null
  return [statusMessage, blockerMessage, usabilityMessage].filter(Boolean).join(' ') || null
}

function updateCheckedAtLabel(value: string | undefined): string | null {
  if (!value) return null
  const checkedAt = new Date(value)
  if (Number.isNaN(checkedAt.getTime())) return null
  return t("ui.Dialogs.updateCheckedAtLabel.checked_06d1e85", { "time": String(checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })) })
}

function serverUpdateBlockerMessage(status: ServerUpdateStatus | null | undefined): string | null {
  const counts = status?.blocker_counts
  if (!counts) return null
  const item = (count: number, singular: string, plural = `${singular}s`) => (
    `${count} ${count === 1 ? singular : plural}`
  )
  return `Blockers: ${[
    item(counts.active_runs, 'active run'),
    item(counts.queued_turns, 'queued turn'),
    item(counts.provider_background_tasks, 'provider background task'),
    item(counts.in_flight_server_changes, 'in-flight server change')
  ].join(' · ')}.`
}

function guidedServerSetupBlockedMessage(active: number, queued: number): string {
  return `Guided server setup cannot restart while ${serverWorkDescription(active, queued)} are running. Finish that work, then retry.`
}

function serverUpdateWasDeferred(error: unknown): boolean {
  return !serverUpdateStartErrorIsAmbiguous(error)
    && /server update deferred|active agent runs?|queued turns?/i.test(message(error))
}

function serverUpdateRecoveryWarning(
  error: unknown,
  status?: ServerUpdateStatus | null
): string | null {
  const code = status?.error_code
  if (
    status?.retryable === true
    || code === 'unsafe_update_tmux_cgroup'
    || code === 'unsafe_update_service_cgroup'
  ) {
    return [status?.message?.trim(), status?.error_action?.trim()].filter(Boolean).join(' ') || message(error)
  }
  const legacy = message(error)
  return /unsafe_update_(?:tmux|service)_cgroup|detached tmux server is inside agents-server\.service|default tmux server outside agents-server\.service|verify the detached tmux server(?:'s|’s) cgroup|separate user scope|untracked process(?:es)? remain(?:s)? inside agents-server\.service|verify that its service cgroup is free of child processes/i.test(legacy)
    ? legacy
    : null
}

function serverUpdateStartErrorMessage(error: unknown, status?: ServerUpdateStatus | null): string {
  if (status && (serverUpdateIsActive(status) || status.phase === 'failed')) {
    return status.message?.trim() || message(error)
  }
  return message(error)
}

function serverUpdateRejectedQueuedTurns(error: unknown): boolean {
  return /queued turns?/i.test(message(error))
}

function serverUpdateNeedsLegacyQueuedTurnWait(
  health: Health | null | undefined,
  error: unknown
): boolean {
  return serverUpdateRejectedQueuedTurns(error)
    && serverUpdateCapabilityVersion(health?.capabilities?.server_updates) < 3
}

export function Dialogs() {
  useLocale()
  return <>
    <ServerOnboardingDialog />
    <SettingsDialog />
    <SessionDialog mode="newChat" />
    <SessionDialog mode="resume" />
    <ImportChatsDialog />
    <FolderDialog />
    <SearchDialog />
    <DigestDialog />
    <JobDialog />
    <RenameChatDialog />
    <ChatShareDialog />
    <ConfirmDeleteDialog />
  </>
}

type AppSettingsSection = 'general' | 'appearance' | 'server' | 'updates'

export function AppSettingsDialog({ serverSettings, serverUpdates }: { serverSettings?: ReactNode; serverUpdates?: ReactNode } = {}) {
  useLocale()
  const language = useLanguagePreference()
  const appSettingsOpen = Boolean(useAppStore(state => state.modals.appSettings))
  const legacyServerSettingsOpen = Boolean(useAppStore(state => state.modals.settings))
  const health = useAppStore(state => state.health)
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const open = appSettingsOpen || legacyServerSettingsOpen
  const [section, setSection] = useState<AppSettingsSection>('general')
  const [appearance, setAppearance] = useState<AppearanceMode>('system')
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null)
  const [updateTrackBusy, setUpdateTrackBusy] = useState(false)
  const activeSectionRef = useRef<HTMLButtonElement | null>(null)

  const closeSettings = () => {
    const store = useAppStore.getState()
    store.setModal('settings', false)
    store.setModal('appSettings', false)
  }

  useTransientClose(open, closeSettings)
  useEffect(() => {
    const selectSection = (event: Event) => {
      const next = (event as CustomEvent<AppSettingsSection>).detail
      if (next === 'general' || next === 'appearance' || next === 'server' || next === 'updates') setSection(next)
    }
    window.addEventListener('agentsdock:app-settings-section', selectSection)
    return () => window.removeEventListener('agentsdock:app-settings-section', selectSection)
  }, [])
  useEffect(() => {
    if (legacyServerSettingsOpen) setSection('server')
  }, [legacyServerSettingsOpen])
  useEffect(() => {
    if (!open) return
    let active = true
    setAppearance(readAppearance())
    const unsubscribe = window.agentsDock.events.on('app:update', status => {
      if (active) setUpdate(status)
    })
    void Promise.resolve(window.agentsDock.updates.check()).then(status => {
      if (active && status) setUpdate(status)
    }).catch(error => {
      if (active) useAppStore.getState().setError(message(error))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [open])

  const chooseAppearance = (mode: AppearanceMode) => {
    setAppearance(mode)
    setAppearanceMode(mode)
  }
  const chooseUpdateTrack = async (track: AppUpdateTrack) => {
    if (!update || update.track === track) return
    setUpdateTrackBusy(true)
    try { setUpdate(await window.agentsDock.updates.setTrack(track)) }
    catch (error) { useAppStore.getState().setError(message(error)) }
    finally { setUpdateTrackBusy(false) }
  }
  const checkForUpdates = async () => {
    try { setUpdate(await window.agentsDock.updates.check()) }
    catch (error) { useAppStore.getState().setError(message(error)) }
  }
  const installUpdate = async () => {
    try { await window.agentsDock.updates.install() }
    catch (error) { useAppStore.getState().setError(message(error)) }
  }
  const updateBusy = Boolean(update && (
    update.state === 'checking'
    || (update.channel === 'direct' && ['available', 'downloading'].includes(update.state))
  ))
  const updateTrackLocked = Boolean(update && (
    update.state === 'checking'
    || (update.channel === 'direct' && ['available', 'downloading', 'downloaded', 'installing'].includes(update.state))
  ))
  const developmentUpdateCheckEnabled = update?.channel === 'development' && update.state !== 'disabled'
  const appUpdateCheckedAt = updateCheckedAtLabel(update?.checkedAt)
  const serverVersion = health?.server_version || profiles.find(profile => profile.id === activeProfileId)?.serverVersion

  return <Dialog.Root open={open} onOpenChange={value => { if (!value) closeSettings() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay app-settings-overlay" />
      <Dialog.Content className="app-settings-dialog" onOpenAutoFocus={event => {
        event.preventDefault()
        activeSectionRef.current?.focus()
      }}>
        <Dialog.Description className="sr-only">{t('settings.description')}</Dialog.Description>
        <button type="button" className="icon-button app-settings-close" aria-label={t('settings.close')} onClick={closeSettings}><X size={17} /></button>
        <aside className="app-settings-sidebar">
          <Dialog.Title>{t('settings.title')}</Dialog.Title>
          <nav aria-label={t('settings.sections')}>
            <button ref={section === 'general' ? activeSectionRef : undefined} type="button" className={section === 'general' ? 'active' : ''} aria-current={section === 'general' ? 'page' : undefined} onClick={() => setSection('general')}><span>{t('settings.general')}</span></button>
            <button ref={section === 'appearance' ? activeSectionRef : undefined} type="button" className={section === 'appearance' ? 'active' : ''} aria-current={section === 'appearance' ? 'page' : undefined} onClick={() => setSection('appearance')}><span>{t('settings.appearance')}</span></button>
            <button ref={section === 'server' ? activeSectionRef : undefined} type="button" className={section === 'server' ? 'active' : ''} aria-current={section === 'server' ? 'page' : undefined} onClick={() => setSection('server')}><span>{t('settings.server')}</span></button>
            <button ref={section === 'updates' ? activeSectionRef : undefined} type="button" className={section === 'updates' ? 'active' : ''} aria-current={section === 'updates' ? 'page' : undefined} onClick={() => setSection('updates')}><span>{t('settings.updates')}</span></button>
          </nav>
        </aside>
        <div className="app-settings-content">
          {section === 'general' && <section className="app-settings-section" aria-labelledby="app-settings-general-title">
            <header><h2 id="app-settings-general-title">{t('settings.general')}</h2></header>
            <div className="app-settings-list">
              <label className="app-settings-row">
                <strong className="app-settings-row-title">{t('language.label')}</strong>
                <select className="app-settings-select" aria-label={t('language.label')} value={language.preference} onChange={event => void language.setPreference(event.currentTarget.value as LanguagePreference)}>
                  <option value="system">{t('language.system')}</option>
                  {localeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              {language.saveFailed && <p role="status">{t('language.saveFailed')}</p>}
              <div className="app-settings-row">
                <strong className="app-settings-row-title">AgentsDock</strong>
                <span className="app-settings-value">{update?.currentVersion ? t('settings.version', { version: update.currentVersion }) : t('settings.versionUnavailable')}</span>
              </div>
              <div className="app-settings-row">
                <strong className="app-settings-row-title">AgentsServer</strong>
                <span className="app-settings-value">{serverVersion ? t('settings.version', { version: serverVersion }) : t('settings.versionUnavailable')}</span>
              </div>
            </div>
          </section>}
          {section === 'appearance' && <section className="app-settings-section" aria-labelledby="app-settings-appearance-title">
            <header><h2 id="app-settings-appearance-title">{t('settings.appearance')}</h2></header>
            <div className="app-settings-list">
              <label className="app-settings-row">
                <strong className="app-settings-row-title">{t('settings.theme')}</strong>
                <select className="app-settings-select" aria-label={t('settings.appTheme')} value={appearance} onChange={event => chooseAppearance(event.currentTarget.value as AppearanceMode)}>
                  <option value="system">{t('settings.systemTheme')}</option>
                  <option value="light">{t('settings.lightTheme')}</option>
                  <option value="dark">{t('settings.darkTheme')}</option>
                </select>
              </label>
            </div>
          </section>}
          {section === 'server' && <section className="app-settings-section" aria-labelledby="app-settings-server-title">
            <header><h2 id="app-settings-server-title">{t('settings.server')}</h2></header>
            {serverSettings}
          </section>}
          {section === 'updates' && <section className="app-settings-section" aria-labelledby="app-settings-updates-title">
            <header><h2 id="app-settings-updates-title">{t('settings.updates')}</h2></header>
            <div className="app-settings-list">
              <div className="app-settings-row app-settings-update-row">
                <div className="app-settings-row-copy"><strong>AgentsDock {update?.currentVersion ? <small>v{update.currentVersion}</small> : null}</strong><span role="status" aria-live="polite">{[update?.state === 'not-available' ? t("ui.Dialogs.AppSettingsDialog.this_is_the_latest_one_0791214") : update?.message || t("ui.Dialogs.AppSettingsDialog.checking_for_updates_497a199"), appUpdateCheckedAt].filter(Boolean).join(' · ')}</span></div>
                <div className="app-settings-actions">
                  {(update?.channel === 'direct' || update?.channel === 'development') && <div className="segmented update-track-picker" role="group" aria-label={t("ui.Dialogs.AppSettingsDialog.app_update_channel_95487e7")}>
                    <button type="button" className={update.track === 'stable' ? 'active' : ''} disabled={updateTrackBusy || updateTrackLocked} onClick={() => void chooseUpdateTrack('stable')}>{t("ui.Dialogs.AppSettingsDialog.stable_90ee305")}</button>
                    <button type="button" className={update.track === 'beta' ? 'active' : ''} disabled={updateTrackBusy || updateTrackLocked} onClick={() => void chooseUpdateTrack('beta')}>{t("ui.Dialogs.AppSettingsDialog.beta_7033903")}</button>
                  </div>}
                  {update?.channel === 'app-store' && <span className="app-settings-value">App Store</span>}
                  {update?.channel === 'development' && <button type="button" className="quiet-button" disabled={!developmentUpdateCheckEnabled || updateBusy || updateTrackBusy} title={developmentUpdateCheckEnabled ? undefined : update.message || t("ui.Dialogs.AppSettingsDialog.app_update_checks_are_unavailable_for_this_86d2da7")} onClick={() => void checkForUpdates()}>{updateBusy || updateTrackBusy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{updateBusy || updateTrackBusy ? t("ui.Dialogs.AppSettingsDialog.checking_ec963ff") : t("ui.Dialogs.AppSettingsDialog.check_for_updates_f26f327")}</button>}
                  {update?.channel === 'direct' && update.state !== 'downloaded' && update.state !== 'installing' && <button type="button" className="quiet-button" disabled={updateBusy} onClick={() => void checkForUpdates()}>{updateBusy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{t("ui.Dialogs.AppSettingsDialog.check_for_updates_f26f327")}</button>}
                  {update?.channel === 'direct' && update.state === 'downloaded' && <button type="button" className="primary-button" onClick={() => void installUpdate()}><RotateCcw size={13} />{t("ui.Dialogs.AppSettingsDialog.restart_to_update_451d3a7")}</button>}
                  {update?.channel === 'direct' && update.state === 'installing' && <span className="app-settings-value"><LoaderCircle className="spin" size={13} />{t("ui.Dialogs.AppSettingsDialog.restarting_75d0f14")}</span>}
                </div>
              </div>
              {update?.state === 'downloading' && <div className="app-settings-update-progress" role="progressbar" aria-label={t("ui.Dialogs.AppSettingsDialog.update_download_1c20b42")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.progress ?? 0)}><span style={{ width: `${update.progress ?? 0}%` }} /></div>}
            </div>
            {serverUpdates}
          </section>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function ServerOnboardingDialog() {
  useLocale()
  const connected = useAppStore(state => state.connected)
  const [mode, setMode] = useState<'configure-active' | 'add'>('configure-active')
  const [intent, setIntent] = useState<ServerSetupIntent>('setup')
  const [open, setOpen] = useState(false)
  const [url, setURL] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'setup' | 'manual'>('setup')
  const [target, setTarget] = useState<'ssh' | 'local'>('ssh')
  const [sshHost, setSSHHost] = useState('')
  const [port, setPort] = useState('7850')
  const [teamHubHost, setTeamHubHost] = useState(true)
  const [hostOrigin, setHostOrigin] = useState<TeamNetworkHostOrigin | null>(null)
  const [teamNetworkServerName, setTeamNetworkServerName] = useState('')
  const [installing, setInstalling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<ServerSetupProgress[]>([])
  const [setupError, setSetupError] = useState<string | null>(null)
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null)
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [capabilities, setCapabilities] = useState<ServerSetupCapabilities | null>(null)
  const cancelRequestedRef = useRef(false)
  const roleChangeInFlightRef = useRef(false)

  useEffect(() => {
    let active = true
    void Promise.all([window.agentsDock.settings.get(), window.agentsDock.setup.capabilities()]).then(([settings, setup]) => {
      if (!active) return
      setURL(settings.serverUrl)
      setCapabilities(setup)
      if (!setup.available) setView('manual')
      setOpen(!settings.serverSetupComplete && !useAppStore.getState().connected)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (connected && mode === 'configure-active' && intent === 'setup' && !installing) setOpen(false)
  }, [connected, installing, intent, mode])
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{
        mode?: 'configure-active' | 'add'
        intent?: ServerSetupIntent
        origin?: TeamNetworkHostOrigin
      }>).detail
      const nextIntent: ServerSetupIntent = detail?.intent === 'update-beta'
        ? 'update-beta'
        : detail?.intent === 'host-team-network'
          ? 'host-team-network'
          : 'setup'
      setMode(nextIntent === 'host-team-network' ? 'configure-active' : detail?.mode === 'add' ? 'add' : 'configure-active')
      setIntent(nextIntent)
      setTeamHubHost(nextIntent !== 'update-beta')
      setProgress([])
      setSetupError(null)
      setDiagnosticNotice(null)
      setInstallStartedAt(null)
      setElapsedSeconds(0)
      setTarget('ssh')
      setSSHHost('')
      setPort('7850')
      if (nextIntent === 'host-team-network') {
        const origin = detail?.origin
        const validOrigin = origin
          && typeof origin.profileId === 'string' && Boolean(origin.profileId.trim())
          && Number.isSafeInteger(origin.profileGeneration) && origin.profileGeneration >= 0
          && typeof origin.serverIdentity === 'string' && Boolean(origin.serverIdentity.trim())
          && typeof origin.serverName === 'string' && Boolean(origin.serverName.trim())
        setHostOrigin(validOrigin ? { ...origin } : null)
        setTeamNetworkServerName(validOrigin ? origin.serverName : '')
        if (!validOrigin) setSetupError('The selected server changed. Close this dialog and try again from Team Network.')
      } else {
        setHostOrigin(null)
        setTeamNetworkServerName('')
      }
      setView(nextIntent === 'host-team-network' ? 'setup' : capabilities?.available === false ? 'manual' : 'setup')
      setOpen(true)
    }
    window.addEventListener('agentsdock:server-setup', show)
    return () => window.removeEventListener('agentsdock:server-setup', show)
  }, [capabilities?.available])
  useEffect(() => window.agentsDock.events.on('server:setup-progress', value => {
    setProgress(current => [...current.slice(-49), value])
  }), [])
  useEffect(() => {
    if (!installing || installStartedAt === null) return
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - installStartedAt) / 1000)))
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [installStartedAt, installing])

  const applyConnection = async (profileId: string | null, profileGeneration: number, serverUrl: string, accessToken: string) => {
    const current = useAppStore.getState()
    if (!profileId || current.switchingProfileId || current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) {
      throw new Error('The active server changed while setup was running. The installed server was not bound to a different profile; review the connection details and try Connect again.')
    }
    let health: Health
    try {
      health = await window.agentsDock.servers.testConnection({ serverUrl, accessToken })
    } catch (error) {
      throw new Error(`Could not connect to AgentsServer at ${serverUrl}: ${message(error)}`)
    }
    const latest = useAppStore.getState()
    if (latest.switchingProfileId || latest.activeProfileId !== profileId || latest.profileGeneration !== profileGeneration) {
      throw new Error(mode === 'add'
        ? 'The active server changed while setup was finishing. The new server was not added automatically.'
        : 'The active server changed while setup was finishing. The installed server was not bound to a different profile; review the connection details and try Connect again.')
    }
    let targetProfileId = profileId
    if (mode === 'add') {
      const duplicate = health.server_identity
        ? latest.profiles.find(profile => profile.serverIdentity === health.server_identity)
        : null
      if (duplicate) throw new Error(`This server is already saved as “${duplicate.name}”. Activate or edit that profile instead.`)
      const added = await window.agentsDock.servers.add({
        serverUrl,
        accessToken,
        serverIdentity: health.server_identity ?? null,
        serverSetupComplete: true
      })
      const profiles = await window.agentsDock.servers.list()
      useAppStore.setState({ profiles })
      targetProfileId = added.id
    }
    const switched = mode === 'add'
      ? await latest.switchServer(targetProfileId)
      : await latest.switchServer(profileId, true, {
          serverUrl,
          accessToken,
          resetServerIdentity: true,
          serverSetupComplete: true
        })
    const reopened = useAppStore.getState()
    if (!switched || reopened.activeProfileId !== targetProfileId || reopened.profileGeneration <= profileGeneration) {
      throw new Error('AgentsDock could not reopen the configured server safely.')
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const initiating = useAppStore.getState()
    setSaving(true)
    try {
      await applyConnection(initiating.activeProfileId, initiating.profileGeneration, url.trim(), token)
      setOpen(false)
    } catch (error) {
      useAppStore.getState().setError(message(error))
    } finally {
      setSaving(false)
    }
  }

  const install = async () => {
    const initiating = useAppStore.getState()
    cancelRequestedRef.current = false
    setInstalling(true)
    setCancelling(false)
    setProgress([])
    setSetupError(null)
    setDiagnosticNotice(null)
    setInstallStartedAt(Date.now())
    setElapsedSeconds(0)
    try {
      const result = await window.agentsDock.setup.run({
        target,
        sshHost: target === 'ssh' ? sshHost.trim() : undefined,
        port: Number(port),
        track: intent === 'update-beta' ? 'beta' : 'stable',
        ...(intent === 'update-beta' && !teamHubHost ? {} : { teamHubHost })
      })
      if (cancelRequestedRef.current) throw new Error('AgentsServer setup was cancelled.')
      setURL(result.serverUrl)
      setToken(result.accessToken)
      setProgress(current => [...current.slice(-49), { phase: 'complete', message: 'Connecting AgentsDock…' }])
      await applyConnection(initiating.activeProfileId, initiating.profileGeneration, result.serverUrl, result.accessToken)
      setOpen(false)
    } catch (error) {
      setSetupError(cancelRequestedRef.current ? 'Setup cancelled. You can retry without losing existing chats.' : message(error))
    } finally {
      setInstalling(false)
      setCancelling(false)
    }
  }

  const configureTeamNetworkServer = async () => {
    if (!hostOrigin || roleChangeInFlightRef.current) return
    const origin = { ...hostOrigin }
    const serverName = teamNetworkServerName.trim()
    if (!serverName || new TextEncoder().encode(serverName).byteLength > 160) return
    roleChangeInFlightRef.current = true
    setInstalling(true)
    setSetupError(null)
    try {
      const status = await window.agentsDock.teamHub.configureServerRole({
        profileId: origin.profileId,
        profileGeneration: origin.profileGeneration,
        serverIdentity: origin.serverIdentity
      }, {
        role: 'host',
        serverName,
        networkName: serverName
      })
      if (
        status.profileId !== origin.profileId
        || status.profileGeneration !== origin.profileGeneration
        || status.serverIdentity !== origin.serverIdentity
        || status.designatedHost !== true
      ) throw new Error('The selected server did not apply the requested Team Network role.')
      if (status.bootstrapRequired || status.connectionState === 'needs-bootstrap') {
        throw new Error('The host was enabled, but the Team Network was not created. Update this AgentsServer and retry.')
      }
      setOpen(false)
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace')))
    } catch (error) {
      setSetupError(message(error))
    } finally {
      roleChangeInFlightRef.current = false
      setInstalling(false)
    }
  }

  const cancelInstall = async () => {
    cancelRequestedRef.current = true
    setCancelling(true)
    setDiagnosticNotice(null)
    try {
      const cancelled = await window.agentsDock.setup.cancel()
      if (!cancelled) {
        cancelRequestedRef.current = false
        setSetupError(t("ui.Dialogs.cancelInstall.agentsdock_could_not_find_the_active_setup_a69cd06"))
        setCancelling(false)
      }
    } catch (error) {
      cancelRequestedRef.current = false
      setSetupError(t("ui.Dialogs.cancelInstall.could_not_cancel_setup_63a0a5b", { "detail": String(message(error)) }))
      setCancelling(false)
    }
  }

  const copySetupDiagnostics = async () => {
    setDiagnosticNotice(null)
    try {
      const diagnostics = await window.agentsDock.setup.diagnostics()
      const report = [
        'AgentsDock AgentsServer setup diagnostics',
        `State: ${diagnostics.state}`,
        diagnostics.target ? `Target: ${diagnostics.target}` : '',
        diagnostics.startedAt ? `Started: ${diagnostics.startedAt}` : '',
        diagnostics.updatedAt ? `Updated: ${diagnostics.updatedAt}` : '',
        `Elapsed: ${formatElapsed(elapsedSeconds)}`,
        setupError ? `Error: ${setupError}` : '',
        diagnostics.logPath ? `Log: ${diagnostics.logPath}` : '',
        diagnostics.tail.length > 0 ? `Recent output:\n${diagnostics.tail.join('\n')}` : ''
      ].filter(Boolean).join('\n')
      await window.agentsDock.native.writeClipboard(report)
      setDiagnosticNotice(t("ui.Dialogs.copySetupDiagnostics.diagnostics_copied_71c9986"))
    } catch (error) {
      setDiagnosticNotice(t("ui.Dialogs.copySetupDiagnostics.could_not_copy_diagnostics_ed7e222", { "detail": String(message(error)) }))
    }
  }

  const openSetupLog = async () => {
    setDiagnosticNotice(null)
    try {
      await window.agentsDock.setup.openLog()
      setDiagnosticNotice(t("ui.Dialogs.openSetupLog.opened_the_setup_log_606f440"))
    } catch (error) {
      setDiagnosticNotice(t("ui.Dialogs.openSetupLog.could_not_open_the_setup_log_c91a6ac", { "detail": String(message(error)) }))
    }
  }

  const currentProgress = progress.at(-1)

  const betaUpdate = intent === 'update-beta'
  const hostSetup = intent === 'host-team-network'
  const validTeamNetworkServerName = Boolean(teamNetworkServerName.trim())
    && new TextEncoder().encode(teamNetworkServerName.trim()).byteLength <= 160
    && !/[\u0000-\u001f\u007f]/.test(teamNetworkServerName.trim())
  const numericPort = Number(port)
  const validServerPort = /^\d+$/.test(port) && Number.isInteger(numericPort) && numericPort >= 1024 && numericPort <= 65535
  const dialogTitle = hostSetup ? t('teamNetwork.setup.title') : betaUpdate ? t('mergeDialogs.setup.betaTitle') : mode === 'add' ? t('mergeDialogs.setup.addTitle') : t('mergeDialogs.setup.title')
  const dialogDescription = hostSetup
    ? t('teamNetwork.setup.description')
    : betaUpdate
      ? t('mergeDialogs.setup.betaDescription')
      : mode === 'add'
        ? t('mergeDialogs.setup.addDescription')
        : t('mergeDialogs.setup.description')
  const primaryActionLabel = installing
    ? betaUpdate ? t('ui.Dialogs.ServerOnboardingDialog.updating_dfe40ef') : t('ui.Dialogs.ServerOnboardingDialog.setting_up_c894bba')
    : setupError
      ? t('ui.Dialogs.ServerOnboardingDialog.retry_setup_8e08720')
      : betaUpdate
          ? target === 'ssh' ? t('ui.Dialogs.ServerOnboardingDialog.update_over_ssh_66bafb0') : t('ui.Dialogs.ServerOnboardingDialog.update_this_computer_3f5f0b1')
          : target === 'ssh' ? t('ui.Dialogs.ServerOnboardingDialog.install_over_ssh_bc9dd1e') : t('ui.Dialogs.ServerOnboardingDialog.install_here_6066729')

  if (hostSetup) return <Shell open={open} onOpenChange={value => { if (!installing) setOpen(value) }} title={dialogTitle} description={dialogDescription} className="server-onboarding-dialog" closeDisabled={installing}>
    <div className="server-setup-body">
      <div className="server-setup-flow">
        <section className="server-setup-intro">
          <span><Server size={13} /> {t('teamNetwork.setup.selectedServer')}</span>
          <h3>{hostOrigin?.serverName || t('teamNetwork.setup.unavailable')}</h3>
          <p>{t('teamNetwork.setup.liveRole')}</p>
        </section>
        <div className="server-setup-fields server-role-fields">
          <label><span>{t('teamNetwork.setup.serverName')}</span><input autoFocus required value={teamNetworkServerName} disabled={installing} onChange={event => setTeamNetworkServerName(event.target.value)} aria-invalid={teamNetworkServerName.length > 0 && !validTeamNetworkServerName} /></label>
        </div>
        <p className="server-setup-help">{t('teamNetwork.setup.hostHint')}</p>
        {setupError && <div className="server-setup-error" role="alert">
          <CircleAlert size={17} />
          <div><strong>{t('teamNetwork.setup.failed')}</strong><p>{setupError}</p></div>
        </div>}
        <footer>
          <button type="button" className="quiet-button" disabled={installing} onClick={() => setOpen(false)}>{t('teamNetwork.cancel')}</button>
          <button type="button" className="primary-button" disabled={installing || !hostOrigin || !validTeamNetworkServerName} onClick={() => void configureTeamNetworkServer()}>
            {installing ? <LoaderCircle className="spin" size={14} /> : setupError ? <RefreshCw size={14} /> : <Server size={14} />}
            {installing ? t('teamNetwork.setup.creating') : setupError ? t('teamNetwork.retry') : t('teamNetwork.setup.create')}
          </button>
        </footer>
      </div>
    </div>
  </Shell>

  return <Shell open={open} onOpenChange={value => { if (!installing) setOpen(value) }} title={dialogTitle} description={dialogDescription} className="server-onboarding-dialog" closeDisabled={installing}>
    <div className="server-setup-body">
      <div className="server-setup-tabs segmented">
        <button type="button" className={view === 'setup' ? 'active' : ''} disabled={!capabilities?.available || installing} onClick={() => setView('setup')}>{t("ui.Dialogs.ServerOnboardingDialog.guided_setup_8ef7823")}</button>
        <button type="button" className={view === 'manual' ? 'active' : ''} disabled={installing} onClick={() => setView('manual')}>{t("ui.Dialogs.ServerOnboardingDialog.connect_manually_978e5f8")}</button>
      </div>
      {view === 'setup' ? <div className="server-setup-flow">
        <section className="server-setup-intro">
          <span><Sparkles size={13} /> {betaUpdate ? t("ui.Dialogs.ServerOnboardingDialog.signed_beta_update_0664ad0") : t("ui.Dialogs.ServerOnboardingDialog.one_command_handled_for_you_49543ac")}</span>
          <h3>{betaUpdate ? t("ui.Dialogs.ServerOnboardingDialog.where_is_this_server_running_cba67ef") : t("ui.Dialogs.ServerOnboardingDialog.where_should_your_agents_run_a20926f")}</h3>
          <p>{betaUpdate ? t("ui.Dialogs.ServerOnboardingDialog.agentsdock_installs_the_verified_beta_pinn_d42fc02") : t("ui.Dialogs.ServerOnboardingDialog.agentsdock_installs_or_updates_agentsserve_18bd75e")}</p>
        </section>
        <div className="server-setup-targets">
          <button type="button" className={target === 'ssh' ? 'active' : ''} aria-pressed={target === 'ssh'} disabled={installing} onClick={() => setTarget('ssh')}>
            <span className="server-target-icon"><Network size={19} /></span><span><strong>{t("ui.Dialogs.ServerOnboardingDialog.remote_machine_d9dd1af")}</strong><small>{t("ui.Dialogs.ServerOnboardingDialog.use_a_server_terminal_or_existing_ssh_acce_bf48cdb")}</small></span>{target === 'ssh' && <span className="server-target-check"><Check size={13} /></span>}
          </button>
          <button type="button" className={target === 'local' ? 'active' : ''} aria-pressed={target === 'local'} disabled={installing} onClick={() => setTarget('local')}>
            <span className="server-target-icon"><Laptop size={19} /></span><span><strong>{t("ui.Dialogs.ServerOnboardingDialog.this_computer_26f9f95")}</strong><small>{t("ui.Dialogs.ServerOnboardingDialog.run_agents_alongside_agentsdock_4f38761")}</small></span>{target === 'local' && <span className="server-target-check"><Check size={13} /></span>}
          </button>
        </div>
          {target === 'ssh' && !betaUpdate && <>
          <button type="button" className="server-setup-guide prominent" disabled={installing} onClick={() => {
            setView('manual')
            void window.agentsDock.native.openExternal(AGENTS_SERVER_SETUP_GUIDE_URL)
          }}>
            <span className="server-setup-icon"><Command size={19} /></span>
            <span><strong>{t("ui.Dialogs.ServerOnboardingDialog.no_ssh_key_install_from_the_server_termina_63b67eb")}</strong><small>{t("ui.Dialogs.ServerOnboardingDialog.use_password_ssh_a_cloud_console_or_a_loca_88a81ce")}</small></span>
            <span className="server-setup-guide-action">{t("ui.Dialogs.ServerOnboardingDialog.open_guide_befbd50")}{" "}<ExternalLink size={13} /></span>
          </button>
          <div className="server-setup-divider"><span>{t("ui.Dialogs.ServerOnboardingDialog.or_install_automatically_with_existing_ssh_f08f261")}</span></div>
        </>}
        <div className={`server-setup-fields ${target === 'local' ? 'local' : ''}`}>
          {target === 'ssh' && <label><span>{t("ui.Dialogs.ServerOnboardingDialog.ssh_host_7e873f3")}</span><div className="input-with-icon"><KeyRound size={15} /><input autoFocus value={sshHost} disabled={installing} onChange={event => setSSHHost(event.target.value)} placeholder={t("ui.Dialogs.ServerOnboardingDialog.user_server_or_ssh_alias_86bea1d")} autoCapitalize="none" autoCorrect="off" /></div></label>}
          <label className="server-port-field"><span>{t("ui.Dialogs.ServerOnboardingDialog.agentsserver_port_93ea882")}</span><input name="agentsdock-server-http-port" autoComplete="off" inputMode="numeric" min={1024} max={65535} aria-invalid={port.length > 0 && !validServerPort} value={port} disabled={installing} onChange={event => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} /></label>
        </div>
        <p className="server-setup-help">{target === 'ssh' ? t("ui.Dialogs.ServerOnboardingDialog.ssh_host_key_and_connection_port_come_from_25c52e3") : t("ui.Dialogs.ServerOnboardingDialog.agentsserver_http_api_port_default_7850_po_9ba1d3d")}</p>
        <label className="server-setup-team-hub"><input type="checkbox" checked={teamHubHost} disabled={installing} onChange={event => setTeamHubHost(event.target.checked)} /><span><strong>{t('teamNetwork.setup.start')}</strong><small>{betaUpdate ? t('teamNetwork.setup.preserveRole') : t('teamNetwork.setup.privateHost')}</small></span></label>
        {installStartedAt !== null && <div className={`server-setup-status ${setupError ? 'failed' : installing ? 'running' : 'stopped'}`} role="status" aria-live="polite">
          <span className="server-setup-status-icon">{setupError ? <CircleAlert size={15} /> : installing ? <LoaderCircle className="spin" size={15} /> : <Clock3 size={15} />}</span>
          <span><strong>{setupError ? t("ui.Dialogs.ServerOnboardingDialog.setup_needs_attention_39d845b") : installing ? setupPhaseLabel(currentProgress?.phase) : t("ui.Dialogs.ServerOnboardingDialog.setup_stopped_2b28514")}</strong><small>{currentProgress?.message || t("ui.Dialogs.ServerOnboardingDialog.preparing_setup_305121e")}</small></span>
          <time>{formatElapsed(elapsedSeconds)}</time>
        </div>}
        {progress.length > 0 && <div className="server-setup-progress" aria-label={t("ui.Dialogs.ServerOnboardingDialog.setup_progress_e9b4495")}>
          {progress.slice(-12).map((item, index, visible) => <div key={`${item.phase}-${progress.length - visible.length + index}`} className={item.phase === 'complete' ? 'complete' : ''}>{item.phase === 'complete' || index < visible.length - 1 ? <Check size={13} /> : installing ? <LoaderCircle className="spin" size={13} /> : <Clock3 size={13} />}<span>{item.message}</span></div>)}
        </div>}
        {installStartedAt !== null && !setupError && <div className="server-setup-live-actions">
          <button type="button" className="quiet-button" onClick={() => void copySetupDiagnostics()}><Copy size={12} />{" "}{t("ui.Dialogs.ServerOnboardingDialog.copy_diagnostics_46fa69e")}</button>
          <button type="button" className="quiet-button" onClick={() => void openSetupLog()}><FileText size={12} />{" "}{t("ui.Dialogs.ServerOnboardingDialog.open_log_7230e6f")}</button>
          {diagnosticNotice && <small aria-live="polite">{diagnosticNotice}</small>}
        </div>}
        {setupError && <div className="server-setup-error" role="alert">
          <CircleAlert size={17} />
          <div><strong>{t("ui.Dialogs.ServerOnboardingDialog.setup_did_not_finish_0aa2be2")}</strong><p>{setupError}</p>
            <div className="server-setup-diagnostic-actions">
              <button type="button" className="quiet-button" onClick={() => void copySetupDiagnostics()}><Copy size={12} />{" "}{t("ui.Dialogs.ServerOnboardingDialog.copy_diagnostics_46fa69e")}</button>
              <button type="button" className="quiet-button" onClick={() => void openSetupLog()}><FileText size={12} />{" "}{t("ui.Dialogs.ServerOnboardingDialog.open_log_7230e6f")}</button>
            </div>
            {diagnosticNotice && <small aria-live="polite">{diagnosticNotice}</small>}
          </div>
        </div>}
        <div className="server-setup-note"><Server size={16} /><span>{t('ui.setup.historyBefore')}<code>~/.agentsdock</code>{t('ui.setup.historyAfter')}</span></div>
        <footer><button type="button" className="quiet-button" disabled={installing} onClick={() => setOpen(false)}>{t("ui.Dialogs.ServerOnboardingDialog.not_now_a0e63d7")}</button><div className="server-setup-footer-actions">{installing && <button type="button" className="quiet-button danger" disabled={cancelling} onClick={() => void cancelInstall()}>{cancelling ? <LoaderCircle className="spin" size={13} /> : <X size={13} />} {cancelling ? t("ui.Dialogs.ServerOnboardingDialog.cancelling_91b104d") : t("ui.Dialogs.ServerOnboardingDialog.cancel_setup_c17bac1")}</button>}<button type="button" className="primary-button" disabled={installing || !validServerPort || (target === 'ssh' && !sshHost.trim())} onClick={() => void install()}>{installing ? <LoaderCircle className="spin" size={14} /> : setupError ? <RefreshCw size={14} /> : <Download size={14} />} {primaryActionLabel}</button></div></footer>
      </div> : <form onSubmit={submit} className="dialog-form server-setup-manual">
        {capabilities?.reason && <div className="server-setup-note"><Server size={15} /><span>{capabilities.reason}</span></div>}
        <button type="button" className="server-setup-guide" onClick={() => void window.agentsDock.native.openExternal(AGENTS_SERVER_SETUP_GUIDE_URL)}>
          <span className="server-setup-icon"><Server size={19} /></span>
          <span><strong>{t("ui.Dialogs.ServerOnboardingDialog.open_setup_guide_8d9f188")}</strong><small>{t("ui.Dialogs.ServerOnboardingDialog.manual_installation_tailscale_and_cli_auth_87a6a7d")}</small></span>
          <ExternalLink size={15} />
        </button>
        <label><span>{t("ui.Dialogs.ServerOnboardingDialog.server_url_22f5ebc")}</span><div className="input-with-icon"><Server size={14} /><input autoFocus value={url} onChange={event => setURL(event.target.value)} placeholder="127.0.0.1:7850" autoCapitalize="none" autoCorrect="off" /></div></label>
        <label><span>{t("ui.Dialogs.ServerOnboardingDialog.access_token_9a911b0")}</span><input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t("ui.Dialogs.ServerOnboardingDialog.token_from_the_server_configuration_f33cbe7")} autoComplete="off" /></label>
        <footer><button type="button" className="quiet-button" onClick={() => setOpen(false)}>{t("ui.Dialogs.ServerOnboardingDialog.not_now_a0e63d7")}</button><button className="primary-button" disabled={!url.trim() || saving}>{saving && <LoaderCircle className="spin" size={14} />}{" "}{t("ui.Dialogs.ServerOnboardingDialog.connect_1a2303e")}</button></footer>
      </form>}
    </div>
  </Shell>
}

function FolderDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.folder)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) return
    const existing = new Set([...folderOrder, ...sessions.map(session => session.folder?.trim() || 'General')].map(folder => folder.toLocaleLowerCase()))
    if (existing.has(clean.toLocaleLowerCase())) {
      useAppStore.getState().setError(`Folder “${clean}” already exists.`)
      return
    }
    useAppStore.getState().setFolderOrder([...folderOrder, clean])
    useAppStore.getState().setModal('folder', false)
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('folder', value)} title={t("ui.Dialogs.FolderDialog.new_folder_cf28f49")} description={t("ui.Dialogs.FolderDialog.create_an_empty_chat_folder_then_drag_or_m_b438439")}>
    <form onSubmit={submit} className="dialog-form">
      <label><span>{t("ui.Dialogs.FolderDialog.folder_name_14d34ed")}</span><input autoFocus value={name} onChange={event => setName(event.target.value)} /></label>
      <footer><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('folder', false)}>{t("ui.Dialogs.FolderDialog.cancel_19766ed")}</button><button className="primary-button" disabled={!name.trim()}>{t("ui.Dialogs.FolderDialog.create_folder_82b9e1e")}</button></footer>
    </form>
  </Shell>
}

function ConfirmDeleteDialog() {
  useLocale()
  const [session, setSession] = useState<Session | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    const open = (event: Event) => setSession((event as CustomEvent<Session>).detail)
    window.addEventListener('agentsdock:confirm-delete', open)
    return () => window.removeEventListener('agentsdock:confirm-delete', open)
  }, [])
  const remove = async () => {
    if (!session) return; setDeleting(true)
    const removed = await useAppStore.getState().deleteSession(session.id)
    setDeleting(false)
    if (removed) setSession(null)
  }
  return <Shell open={Boolean(session)} onOpenChange={open => { if (!open) setSession(null) }} title={t("ui.Dialogs.ConfirmDeleteDialog.delete_chat_80aaa1b")} description={session ? t("ui.Dialogs.ConfirmDeleteDialog.and_its_agentsdock_history_will_be_removed_19e5a63", { "chat": String(session.title) }) : ''} className="confirm-dialog"><div className="confirm-actions"><button type="button" className="quiet-button" onClick={() => setSession(null)}>{t("ui.Dialogs.ConfirmDeleteDialog.cancel_19766ed")}</button><button type="button" className="danger-button" disabled={deleting} onClick={() => void remove()}>{deleting && <LoaderCircle className="spin" size={13} />}{" "}{t("ui.Dialogs.ConfirmDeleteDialog.delete_chat_93291d9")}</button></div></Shell>
}

export function RenameChatDialog() {
  useLocale()
  const [session, setSession] = useState<Session | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  useEffect(() => {
    const open = (event: Event) => {
      if (savingRef.current) return
      const next = (event as CustomEvent<Session>).detail
      setSession(next)
      setTitle(next.title)
      savingRef.current = false
      setSaving(false)
    }
    window.addEventListener('agentsdock:rename-chat', open)
    return () => window.removeEventListener('agentsdock:rename-chat', open)
  }, [])
  const close = () => {
    if (savingRef.current) return
    setSession(null)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!session || savingRef.current) return
    const clean = title.trim()
    if (!clean) return
    if (clean === session.title) {
      setSession(null)
      return
    }
    savingRef.current = true
    setSaving(true)
    await useAppStore.getState().updateSession(session.id, { title: clean })
    const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
    savingRef.current = false
    setSaving(false)
    if (updated?.title === clean) setSession(null)
  }
  return <Shell open={Boolean(session)} onOpenChange={open => { if (!open) close() }} title={t("ui.Dialogs.RenameChatDialog.rename_chat_2607624")} description={t("ui.Dialogs.RenameChatDialog.choose_a_clear_name_for_this_conversation_a448152")} closeDisabled={saving}>
    <form onSubmit={event => void submit(event)} className="dialog-form">
      <label><span>{t("ui.Dialogs.RenameChatDialog.chat_name_09c3e4c")}</span><input autoFocus disabled={saving} value={title} onChange={event => setTitle(event.target.value)} onFocus={event => event.currentTarget.select()} /></label>
      <footer><button type="button" className="quiet-button" disabled={saving} onClick={close}>{t("ui.Dialogs.RenameChatDialog.cancel_19766ed")}</button><button className="primary-button" disabled={saving || !title.trim()}>{saving && <LoaderCircle className="spin" size={14} />}{" "}{t("ui.Dialogs.RenameChatDialog.rename_3064d79")}</button></footer>
    </form>
  </Shell>
}

function Shell({ open, onOpenChange, onEscapeKeyDown, title, description, children, className = '', closeDisabled = false, initialFocusRef, localizeChrome = true }: {
  open: boolean; onOpenChange: (open: boolean) => void; onEscapeKeyDown?: (event: globalThis.KeyboardEvent) => void; title: string; description?: string; children: React.ReactNode; className?: string; closeDisabled?: boolean; initialFocusRef?: { current: HTMLElement | null }; localizeChrome?: boolean
}) {
  useLocale()
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  useTransientClose(open, () => onOpenChange(false))
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`form-dialog ${className}`} aria-busy={Boolean(switchingProfileId)} onEscapeKeyDown={onEscapeKeyDown} onOpenAutoFocus={event => {
    if (!initialFocusRef?.current) return
    event.preventDefault()
    initialFocusRef.current.focus()
  }}><header><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><button type="button" className="icon-button" aria-label={localizeChrome ? t("ui.Dialogs.Shell.close_31a8910", { "name": String(title) }) : `Close ${title}`} disabled={closeDisabled} title={closeDisabled ? localizeChrome ? t("ui.Dialogs.Shell.wait_for_setup_to_finish_before_closing_848c88c") : 'Wait for setup to finish before closing' : undefined} onClick={() => onOpenChange(false)}><X size={16} /></button></header><div className="form-dialog-body" inert={switchingProfileId ? true : undefined}>{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function SettingsDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.settings)
  const appSettingsOpen = Boolean(useAppStore(state => state.modals.appSettings))
  const connected = useAppStore(state => state.connected)
  const health = useAppStore(state => state.health)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const activeProfile = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId) || null)
  const activeProfileServerUrl = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverUrl || null)
  const activeConnectionState = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.connectionState)
  const degraded = connected && activeConnectionState === 'degraded'
  const { active: activeServerTurns, queued: queuedServerTurns } = serverWorkCounts(health)
  const queuedServerUpdateBlockers = serverUpdateBlockingQueuedTurns(health)
  const serverRestartBlocked = activeServerTurns > 0 || queuedServerUpdateBlockers > 0
  const [serverUpdate, setServerUpdate] = useState<ServerUpdateStatus | null>(null)
  const [serverUpdateTrack, setServerUpdateTrack] = useState<ServerUpdateTrack>('stable')
  const [serverUpdateBusy, setServerUpdateBusy] = useState(false)
  const [serverUpdateWarning, setServerUpdateWarning] = useState<string | null>(null)
  const [submittedServerUpdates, setSubmittedServerUpdates] = useState(readSubmittedServerUpdates)
  const submittedServerUpdatesRef = useRef(submittedServerUpdates)
  const submittedUpdateChecksRef = useRef(new Set<string>())
  const [submittedUpdateChecking, setSubmittedUpdateChecking] = useState(false)
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false)
  const [restartConfirmationMode, setRestartConfirmationMode] = useState<'safe' | 'force'>('safe')
  const [restartTarget, setRestartTarget] = useState<ServerRestartTarget | null>(null)
  const [restartBlockerSnapshot, setRestartBlockerSnapshot] = useState<ServerRestartBlockerSnapshot | null>(null)
  const [restartDialogError, setRestartDialogError] = useState<string | null>(null)
  const [restartInspectionBusy, setRestartInspectionBusy] = useState(false)
  const [updateNowConfirmationOpen, setUpdateNowConfirmationOpen] = useState(false)
  const [updateNowTarget, setUpdateNowTarget] = useState<ServerRestartTarget | null>(null)
  const [updateNowReservation, setUpdateNowReservation] = useState<PendingServerUpdateReservation | null>(null)
  const [updateNowBlockerSnapshot, setUpdateNowBlockerSnapshot] = useState<ServerRestartBlockerSnapshot | null>(null)
  const [updateNowDialogError, setUpdateNowDialogError] = useState<string | null>(null)
  const [updateNowInspectionBusy, setUpdateNowInspectionBusy] = useState(false)
  const [restartingServer, setRestartingServer] = useState(false)
  const [restartNotice, setRestartNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [restartAfterUpdateTarget, setRestartAfterUpdateTarget] = useState<RestartAfterUpdateTarget | null>(null)
  const [restartAfterUpdateRetry, setRestartAfterUpdateRetry] = useState(0)
  const [deferredServerUpdates, setDeferredServerUpdates] = useState<DeferredServerUpdates>(readDeferredServerUpdates)
  const [deferredServerUpdateRetry, setDeferredServerUpdateRetry] = useState(0)
  const [deferredServerUpdateAttempt, setDeferredServerUpdateAttempt] = useState<DeferredServerUpdateAttempt | null>(null)
  const [addServerRequest, setAddServerRequest] = useState(0)
  const [manageServersRequest, setManageServersRequest] = useState(0)
  const serverUpdateRequestRef = useRef(0)
  const serverUpdatePollRef = useRef(0)
  const deferredServerUpdateAttemptRef = useRef<string | null>(null)
  const deferredServerUpdateGenerationRef = useRef(0)
  const deferredServerUpdateRetryTimerRef = useRef<number | null>(null)
  const restartCancelRef = useRef<HTMLButtonElement | null>(null)
  const restartInspectionRef = useRef(0)
  const updateNowCancelRef = useRef<HTMLButtonElement | null>(null)
  const updateNowInspectionRef = useRef(0)
  const restartAfterUpdateAttemptRef = useRef<string | null>(null)
  const restartAfterUpdateRetryTimerRef = useRef<number | null>(null)
  const restartDecisionRef = useRef(false)
  const serverUpdateOperationsRef = useRef<Set<Promise<void>>>(new Set())
  const updateSurfaceOpen = open || appSettingsOpen
  const serverUpdateScopeId = activeProfileId || ''
  const updateBindingIdentity = activeProfile?.serverIdentity || health?.server_identity || ''
  const submittedUpdateKey = serverUpdateIntentKey(serverUpdateScopeId, updateBindingIdentity, activeProfileServerUrl || '')
  const submittedServerUpdate = submittedServerUpdates[submittedUpdateKey] || null
  const deferredServerUpdate = serverUpdateScopeId ? deferredServerUpdates[serverUpdateScopeId] || null : null
  const deferredQueuedServerUpdateBlockers = deferredServerUpdate?.waitForQueuedTurns
    && serverUpdateCapabilityVersion(health?.capabilities?.server_updates) < 3
    ? queuedServerTurns
    : queuedServerUpdateBlockers
  const activeDeferredServerUpdateAttempt = deferredServerUpdateAttempt?.profileId === serverUpdateScopeId
    ? deferredServerUpdateAttempt
    : null
  const trackServerUpdateOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation()
    const settled = pending.then(() => undefined, () => undefined)
    serverUpdateOperationsRef.current.add(settled)
    void settled.finally(() => serverUpdateOperationsRef.current.delete(settled))
    return pending
  }
  const writeSubmittedServerUpdates = (next: Record<string, ServerUpdateIntent>) => {
    // A lost durable latch must never make a second start look safe after a
    // window closes. Refuse the mutation if persistence is unavailable.
    const serialized = JSON.stringify(next)
    window.localStorage.setItem(SUBMITTED_SERVER_UPDATES_STORAGE_KEY, serialized)
    if (window.localStorage.getItem(SUBMITTED_SERVER_UPDATES_STORAGE_KEY) !== serialized) {
      throw new Error('AgentsDock could not preserve the update request safely. No update was submitted.')
    }
    submittedServerUpdatesRef.current = next
    setSubmittedServerUpdates(next)
  }
  const submittedUpdateIsCurrent = (intent: ServerUpdateIntent, generation = profileGeneration) => {
    const state = useAppStore.getState()
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
    return state.activeProfileId === intent.profileId
      && state.profileGeneration === generation
      && !state.switchingProfileId
      && profile?.serverUrl === intent.serverUrl
      && (profile.serverIdentity || state.health?.server_identity) === intent.serverIdentity
      && (!state.health?.server_identity || state.health.server_identity === intent.serverIdentity)
      && submittedServerUpdatesRef.current[serverUpdateIntentKey(intent.profileId, intent.serverIdentity, intent.serverUrl)]?.attemptId === intent.attemptId
  }
  const clearSubmittedServerUpdate = (intent: ServerUpdateIntent) => {
    const key = serverUpdateIntentKey(intent.profileId, intent.serverIdentity, intent.serverUrl)
    if (submittedServerUpdatesRef.current[key]?.attemptId !== intent.attemptId) return
    const next = { ...submittedServerUpdatesRef.current }
    delete next[key]
    try { writeSubmittedServerUpdates(next) } catch {
      setServerUpdateWarning('AgentsDock could not save the verified update outcome. Check status again before submitting another update.')
    }
  }
  const beginSubmittedServerUpdate = (version: string, track: ServerUpdateTrack, baseline: ServerUpdateStatus | null) => {
    const state = useAppStore.getState()
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
    const identity = state.health?.server_identity?.trim()
    if (!profile || !identity || (profile.serverIdentity && profile.serverIdentity !== identity)) {
      throw new Error('AgentsDock must verify the server profile identity before submitting an update.')
    }
    const key = serverUpdateIntentKey(profile.id, identity, profile.serverUrl)
    const current = { ...readSubmittedServerUpdates(), ...submittedServerUpdatesRef.current }
    if (current[key]) throw new Error(UNKNOWN_SERVER_UPDATE_MESSAGE)
    const baselineTimestamp = [baseline?.checked_at, baseline?.updated_at, baseline?.finished_at, baseline?.started_at, baseline?.pending_at]
      .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    const intent: ServerUpdateIntent = {
      attemptId: crypto.randomUUID(), profileId: profile.id, serverIdentity: identity,
      serverUrl: profile.serverUrl, version, track, submittedAt: Date.now(),
      startingVersion: state.health?.server_version || baseline?.current_version || '',
      ...(baseline?.update_id ? { baselineUpdateId: baseline.update_id } : {}),
      ...(baseline?.schedule_id ? { baselineScheduleId: baseline.schedule_id } : {}),
      ...(baselineTimestamp ? { baselineTimestamp } : {})
    }
    writeSubmittedServerUpdates({ ...current, [key]: intent })
    return intent
  }
  const applySubmittedUpdateStatus = (intent: ServerUpdateIntent, status: ServerUpdateStatus | null | undefined) => {
    const state = useAppStore.getState()
    if (!status || !(state.modals.settings || state.modals.appSettings) || !submittedUpdateIsCurrent(intent)
      || (status.server_identity && status.server_identity !== intent.serverIdentity)) return false
    setServerUpdate(status)
    if (!serverUpdateIntentResolved(intent, status)) return false
    clearSubmittedServerUpdate(intent)
    const deferred = readDeferredServerUpdates()[intent.profileId]
    if (deferred?.serverIdentity === intent.serverIdentity && deferred.serverUrl === intent.serverUrl && deferred.track === intent.track) {
      clearDeferredServerUpdate(intent.profileId)
    }
    setServerUpdateWarning(null)
    return true
  }
  const checkSubmittedUpdateStatus = async (intent: ServerUpdateIntent, isCurrent: () => boolean) => {
    const state = useAppStore.getState()
    if (!state.connected || !(state.modals.settings || state.modals.appSettings) || !submittedUpdateIsCurrent(intent) || submittedUpdateChecksRef.current.has(intent.attemptId)) return
    submittedUpdateChecksRef.current.add(intent.attemptId)
    setSubmittedUpdateChecking(true)
    try {
      const status = await window.agentsDock.serverUpdates.status()
      if (isCurrent() && submittedUpdateIsCurrent(intent)) applySubmittedUpdateStatus(intent, status)
    } catch {
      // Losing a status response proves neither acceptance nor failure.
    } finally {
      submittedUpdateChecksRef.current.delete(intent.attemptId)
      if (isCurrent()) setSubmittedUpdateChecking(false)
    }
  }
  const settleServerUpdateOperations = async () => {
    while (serverUpdateOperationsRef.current.size > 0) {
      await Promise.all([...serverUpdateOperationsRef.current])
    }
  }
  const serverUpdateStatusWarning = serverUpdate?.retryable === true
    ? [serverUpdate.message?.trim(), serverUpdate.error_action?.trim()].filter(Boolean).join(' ')
    : null
  const serverRequestIsCurrent = (requestId: number) => {
    const state = useAppStore.getState()
    return (
      serverUpdateRequestRef.current === requestId
      && state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && !state.switchingProfileId
    )
  }
  const serverPollIsCurrent = (requestId: number) => {
    const state = useAppStore.getState()
    return (
      serverUpdatePollRef.current === requestId
      && state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && !state.switchingProfileId
    )
  }
  const restartTargetIsCurrent = (target: ServerRestartTarget): boolean => {
    const state = useAppStore.getState()
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
    return state.activeProfileId === target.profileId
      && state.profileGeneration === target.profileGeneration
      && !state.switchingProfileId
      && profile?.serverIdentity === target.serverIdentity
      && profile.serverUrl === target.serverUrl
      && state.health?.server_identity === target.serverIdentity
      && state.health?.server_instance_id === target.serverInstanceId
  }
  const closeRestartConfirmation = () => {
    restartInspectionRef.current += 1
    setRestartConfirmationOpen(false)
    setRestartConfirmationMode('safe')
    setRestartTarget(null)
    setRestartBlockerSnapshot(null)
    setRestartDialogError(null)
    setRestartInspectionBusy(false)
  }
  const closeUpdateNowConfirmation = () => {
    updateNowInspectionRef.current += 1
    setUpdateNowConfirmationOpen(false)
    setUpdateNowTarget(null)
    setUpdateNowReservation(null)
    setUpdateNowBlockerSnapshot(null)
    setUpdateNowDialogError(null)
    setUpdateNowInspectionBusy(false)
  }
  const inspectRestartBlockers = async (
    target: ServerRestartTarget,
    fallbackMessage?: string,
    allowIdleForce = false
  ): Promise<boolean> => {
    const requestId = ++restartInspectionRef.current
    setRestartInspectionBusy(true)
    setRestartDialogError(null)
    try {
      const scope: WorkspaceProfileScope = {
        profileId: target.profileId,
        profileGeneration: target.profileGeneration,
        serverIdentity: target.serverIdentity
      }
      const status = await window.agentsDock.servers.restartStatus(scope)
      if (restartInspectionRef.current !== requestId || !restartTargetIsCurrent(target)) return false
      if (
        status.server_identity !== target.serverIdentity
        || status.server_instance_id !== target.serverInstanceId
      ) throw new Error('The active AgentsServer changed while restart blockers were being checked. Reopen Settings and try again.')
      if (status.phase === 'accepted' || status.phase === 'signaling') {
        throw new Error(status.message || 'AgentsServer is already restarting.')
      }
      const currentCapability = useAppStore.getState().health?.capabilities?.server_restart
      const snapshot = validatedServerRestartBlockerSnapshot(status.blocker_snapshot)
      const forceSupported = serverUpdateCapabilityVersion(currentCapability) >= 2
        && currentCapability?.available === true
        && currentCapability.force_restart === true
        && currentCapability.force_confirmation_required === true
      // beta.30+ servers override every blocker on force; older servers only
      // the forceable ones. Either way the snapshot is shown for review.
      const forceAllowed = forceSupported && (
        forceRestartOverridesSafety(snapshot)
          ? true
          : Boolean(snapshot && (allowIdleForce || snapshot.has_forceable_blockers)) && !snapshot?.has_safety_blockers
      )
      if (!forceAllowed) {
        setRestartBlockerSnapshot(snapshot)
        setRestartDialogError(
          fallbackMessage
          || status.message
          || (
            snapshot?.has_safety_blockers && !forceRestartOverridesSafety(snapshot)
              ? 'AgentsServer reports safety-critical work that Force Restart cannot bypass.'
              : 'AgentsServer no longer reports forceable restart blockers. Use the normal Restart server action.'
          )
        )
        return false
      }
      setRestartBlockerSnapshot(snapshot)
      setRestartConfirmationMode('force')
      setRestartDialogError(fallbackMessage || null)
      return true
    } catch (error) {
      if (restartInspectionRef.current === requestId && restartTargetIsCurrent(target)) {
        setRestartBlockerSnapshot(null)
        setRestartDialogError(fallbackMessage || message(error))
      }
      return false
    } finally {
      if (restartInspectionRef.current === requestId) setRestartInspectionBusy(false)
    }
  }
  const updateDeferredServerUpdates = (mutate: (current: DeferredServerUpdates) => DeferredServerUpdates) => {
    setDeferredServerUpdates(current => {
      const next = mutate(current)
      writeDeferredServerUpdates(next)
      return next
    })
  }
  const clearDeferredServerUpdate = (scopeId = serverUpdateScopeId) => {
    if (scopeId === serverUpdateScopeId) {
      deferredServerUpdateGenerationRef.current += 1
      if (deferredServerUpdateRetryTimerRef.current !== null) {
        window.clearTimeout(deferredServerUpdateRetryTimerRef.current)
        deferredServerUpdateRetryTimerRef.current = null
      }
      setDeferredServerUpdateRetry(0)
    }
    updateDeferredServerUpdates(current => {
      if (!current[scopeId]) return current
      const next = { ...current }
      delete next[scopeId]
      return next
    })
  }
  const queueDeferredServerUpdate = (
    version: string,
    track: ServerUpdateTrack,
    waitForQueuedTurns = false
  ) => {
    if (!serverUpdateScopeId) {
      useAppStore.getState().setError('The active server profile is still loading. Retry in a moment.')
      return
    }
    if (deferredServerUpdateRetryTimerRef.current !== null) {
      window.clearTimeout(deferredServerUpdateRetryTimerRef.current)
      deferredServerUpdateRetryTimerRef.current = null
    }
    setDeferredServerUpdateRetry(0)
    const next: DeferredServerUpdate = {
      profileId: serverUpdateScopeId,
      serverIdentity: health?.server_identity?.trim() || null,
      serverUrl: activeProfileServerUrl,
      track,
      version,
      queuedAt: new Date().toISOString(),
      waitForQueuedTurns
    }
    updateDeferredServerUpdates(current => ({ ...current, [serverUpdateScopeId]: next }))
    setServerUpdateTrack(track)
  }
  const scheduleDeferredServerUpdateRetry = (minimumDelayMs = 5_000) => {
    if (deferredServerUpdateRetryTimerRef.current !== null) window.clearTimeout(deferredServerUpdateRetryTimerRef.current)
    const backoffMs = Math.min(60_000, 5_000 * (2 ** Math.min(deferredServerUpdateRetry, 4)))
    deferredServerUpdateRetryTimerRef.current = window.setTimeout(() => {
      deferredServerUpdateRetryTimerRef.current = null
      setDeferredServerUpdateRetry(value => value + 1)
    }, Math.max(minimumDelayMs, backoffMs))
  }
  const clearRestartAfterUpdateRetry = (resetAttempts = true) => {
    if (restartAfterUpdateRetryTimerRef.current !== null) {
      window.clearTimeout(restartAfterUpdateRetryTimerRef.current)
      restartAfterUpdateRetryTimerRef.current = null
    }
    if (resetAttempts) setRestartAfterUpdateRetry(0)
  }
  const scheduleRestartAfterUpdateRetry = () => {
    if (restartAfterUpdateRetryTimerRef.current !== null) return
    const backoffMs = Math.min(60_000, 5_000 * (2 ** Math.min(restartAfterUpdateRetry, 4)))
    restartAfterUpdateRetryTimerRef.current = window.setTimeout(() => {
      restartAfterUpdateRetryTimerRef.current = null
      restartAfterUpdateAttemptRef.current = null
      setRestartAfterUpdateRetry(value => value + 1)
    }, backoffMs)
  }
  useEffect(() => {
    const add = () => {
      setAddServerRequest(value => value + 1)
    }
    const manage = () => {
      setManageServersRequest(value => value + 1)
    }
    window.addEventListener(ADD_SERVER_EVENT, add)
    window.addEventListener(MANAGE_SERVERS_EVENT, manage)
    return () => {
      window.removeEventListener(ADD_SERVER_EVENT, add)
      window.removeEventListener(MANAGE_SERVERS_EVENT, manage)
    }
  }, [])
  useEffect(() => {
    if (updateSurfaceOpen) {
      closeRestartConfirmation()
      closeUpdateNowConfirmation()
      setRestartNotice(null)
    }
  }, [updateSurfaceOpen])
  useEffect(() => {
    restartInspectionRef.current += 1
    updateNowInspectionRef.current += 1
    setRestartConfirmationOpen(false)
    setRestartConfirmationMode('safe')
    setRestartTarget(null)
    setRestartBlockerSnapshot(null)
    setRestartDialogError(null)
    setRestartInspectionBusy(false)
    setUpdateNowConfirmationOpen(false)
    setUpdateNowTarget(null)
    setUpdateNowReservation(null)
    setUpdateNowBlockerSnapshot(null)
    setUpdateNowDialogError(null)
    setUpdateNowInspectionBusy(false)
  }, [activeProfileId, activeProfile?.serverIdentity, activeProfileServerUrl, profileGeneration, health?.server_instance_id])
  useEffect(() => {
    setRestartNotice(null)
  }, [activeProfileId, activeProfile?.serverIdentity, activeProfileServerUrl])
  useEffect(() => {
    if (restartConfirmationOpen && restartConfirmationMode === 'force' && !restartingServer && !restartInspectionBusy) {
      restartCancelRef.current?.focus({ preventScroll: true })
    }
  }, [restartConfirmationMode, restartConfirmationOpen, restartInspectionBusy, restartingServer])
  useEffect(() => {
    if (!updateSurfaceOpen) return
    const requestId = ++serverUpdateRequestRef.current
    const deferredGeneration = deferredServerUpdateGenerationRef.current
    setServerUpdate(null)
    setServerUpdateWarning(null)
    setServerUpdateTrack(String(health?.server_version || '').split('+', 1)[0].includes('-') ? 'beta' : 'stable')
    const unresolved = submittedServerUpdatesRef.current[submittedUpdateKey]
    if (unresolved) {
      setServerUpdateTrack(unresolved.track)
      setServerUpdateBusy(false)
      return
    }
    setServerUpdateBusy(Boolean(health?.managed_updates))
    if (health?.managed_updates) void trackServerUpdateOperation(async () => {
      const status = await window.agentsDock.serverUpdates.status()
      if (
        !serverRequestIsCurrent(requestId)
        || deferredServerUpdateAttemptRef.current
        || deferredServerUpdateGenerationRef.current !== deferredGeneration
      ) return
      setServerUpdate(status)
      const track = serverTrackForStatus(status)
      setServerUpdateTrack(track)
      if (serverUpdateIsActive(status) || deferredServerUpdate || submittedServerUpdatesRef.current[submittedUpdateKey]) return
      try {
        const checked = await window.agentsDock.serverUpdates.check(track)
        if (
          !serverRequestIsCurrent(requestId)
          || deferredServerUpdateAttemptRef.current
          || deferredServerUpdateGenerationRef.current !== deferredGeneration
        ) return
        if (!checked) return
        setServerUpdate(checked)
        setServerUpdateTrack(serverTrackForStatus(checked))
        setServerUpdateWarning(null)
      } catch (error) {
        if (
          serverRequestIsCurrent(requestId)
          && !deferredServerUpdateAttemptRef.current
          && deferredServerUpdateGenerationRef.current === deferredGeneration
        ) setServerUpdateWarning(`Could not check for updates: ${message(error)}`)
      }
    })
      .catch(() => {
        if (
          !serverRequestIsCurrent(requestId)
          || deferredServerUpdateAttemptRef.current
          || deferredServerUpdateGenerationRef.current !== deferredGeneration
        ) return
        setServerUpdate(null)
        setServerUpdateWarning('Could not load update status. Choose a channel or Check server to retry.')
      })
      .finally(() => {
        if (serverRequestIsCurrent(requestId)) setServerUpdateBusy(false)
      })
    return () => {
      if (serverUpdateRequestRef.current === requestId) serverUpdateRequestRef.current += 1
    }
  }, [activeProfileId, activeProfileServerUrl, updateBindingIdentity, updateSurfaceOpen, health?.managed_updates, profileGeneration])
  useEffect(() => {
    setSubmittedUpdateChecking(false)
  }, [activeProfileId, activeProfileServerUrl, updateBindingIdentity, profileGeneration, updateSurfaceOpen])
  useEffect(() => {
    const intent = submittedServerUpdate
    if (!updateSurfaceOpen || !intent || !submittedUpdateIsCurrent(intent)) return
    if (serverUpdateIntentHealthResolved(intent, health, connected)) {
      clearSubmittedServerUpdate(intent)
      setServerUpdate({ phase: 'current', current_version: intent.version, track: intent.track, update_available: false })
      setServerUpdateWarning(null)
    }
  }, [submittedServerUpdate?.attemptId, updateSurfaceOpen, connected, health?.server_identity, health?.server_version, activeProfileServerUrl, profileGeneration])
  useEffect(() => () => {
    if (deferredServerUpdateRetryTimerRef.current !== null) {
      window.clearTimeout(deferredServerUpdateRetryTimerRef.current)
      deferredServerUpdateRetryTimerRef.current = null
    }
    if (restartAfterUpdateRetryTimerRef.current !== null) {
      window.clearTimeout(restartAfterUpdateRetryTimerRef.current)
      restartAfterUpdateRetryTimerRef.current = null
    }
  }, [])
  useEffect(() => {
    if (!deferredServerUpdate || switchingProfileId) return
    const identityChanged = Boolean(
      deferredServerUpdate.serverIdentity
      && health?.server_identity
      && deferredServerUpdate.serverIdentity !== health.server_identity
    )
    const identityUnavailableAndURLChanged = Boolean(
      !deferredServerUpdate.serverIdentity
      && deferredServerUpdate.serverUrl
      && activeProfileServerUrl
      && deferredServerUpdate.serverUrl !== activeProfileServerUrl
    )
    const updateHasNoServerBinding = !deferredServerUpdate.serverIdentity && !deferredServerUpdate.serverUrl
    if (identityChanged || identityUnavailableAndURLChanged || updateHasNoServerBinding) {
      clearDeferredServerUpdate(serverUpdateScopeId)
    }
  }, [
    activeProfileServerUrl,
    deferredServerUpdate?.serverIdentity,
    deferredServerUpdate?.serverUrl,
    health?.server_identity,
    serverUpdateScopeId,
    switchingProfileId
  ])
  useEffect(() => {
    const durableReservation = serverSupportsPassiveUpdateReservation(health)
    if (
      !deferredServerUpdate
      || submittedServerUpdatesRef.current[submittedUpdateKey]
      || !connected
      || Boolean(switchingProfileId)
      || restartingServer
      || restartDecisionRef.current
      || (!durableReservation && activeServerTurns > 0)
      || (!durableReservation && deferredQueuedServerUpdateBlockers > 0)
      || (
        deferredServerUpdate.serverIdentity
        && deferredServerUpdate.serverIdentity !== health?.server_identity
      )
      || (
        !deferredServerUpdate.serverIdentity
        && deferredServerUpdate.serverUrl
        && deferredServerUpdate.serverUrl !== activeProfileServerUrl
      )
      || (!deferredServerUpdate.serverIdentity && !deferredServerUpdate.serverUrl)
    ) return
    const attemptKey = [
      serverUpdateScopeId,
      profileGeneration,
      deferredServerUpdate.track,
      deferredServerUpdate.version,
      deferredServerUpdateRetry
    ].join(':')
    if (deferredServerUpdateAttemptRef.current === attemptKey) return
    serverUpdateRequestRef.current += 1
    deferredServerUpdateGenerationRef.current += 1
    const attemptGeneration = deferredServerUpdateGenerationRef.current
    deferredServerUpdateAttemptRef.current = attemptKey
    setDeferredServerUpdateAttempt({ profileId: serverUpdateScopeId, phase: 'checking' })
    let cancelled = false
    const attemptWasCancelled = () => (
      cancelled
      || deferredServerUpdateGenerationRef.current !== attemptGeneration
    )
    let requestedVersion = deferredServerUpdate.version
    let startAttempted = false
    let submittedIntent: ServerUpdateIntent | null = null
    const run = async () => {
      try {
        // Re-check the signed channel at execution time so a queued request
        // never installs a release that has since been superseded.
        const checked = await window.agentsDock.serverUpdates.check(deferredServerUpdate.track)
        if (attemptWasCancelled()) return
        const state = useAppStore.getState()
        if (state.activeProfileId !== activeProfileId || state.profileGeneration !== profileGeneration || state.switchingProfileId) return
        setServerUpdate(checked)
        setServerUpdateTrack(serverTrackForStatus(checked))
        const legacyStableMatch = (
          deferredServerUpdate.track === 'stable'
          && !checked.track
          && serverTrackForStatus(checked) === 'stable'
        )
        if (checked.track !== deferredServerUpdate.track && !legacyStableMatch) {
          clearDeferredServerUpdate(serverUpdateScopeId)
          useAppStore.getState().setError('This AgentsServer version cannot switch update channels in place. Open guided server setup after current work finishes.')
          return
        }
        if (checked.phase === 'current' || checked.current_version === checked.latest_version) {
          clearDeferredServerUpdate(serverUpdateScopeId)
          return
        }
        if (!checked.update_available || !checked.latest_version) {
          useAppStore.getState().setError(checked.message || 'The signed server release is temporarily unavailable. AgentsDock will retry.')
          scheduleDeferredServerUpdateRetry(30_000)
          return
        }
        requestedVersion = checked.latest_version
        setDeferredServerUpdateAttempt({ profileId: serverUpdateScopeId, phase: 'starting' })
        submittedIntent = beginSubmittedServerUpdate(requestedVersion, deferredServerUpdate.track, checked)
        startAttempted = true
        const next = durableReservation
          ? await window.agentsDock.serverUpdates.start(
              requestedVersion,
              deferredServerUpdate.track,
              true
            )
          : await window.agentsDock.serverUpdates.start(
              requestedVersion,
              deferredServerUpdate.track
            )
        if (attemptWasCancelled()) return
        if (!submittedUpdateIsCurrent(submittedIntent)) return
        clearDeferredServerUpdate(serverUpdateScopeId)
        applySubmittedUpdateStatus(submittedIntent, next)
      } catch (error) {
        if (attemptWasCancelled()) return
        if (startAttempted && submittedIntent) {
          if (!submittedUpdateIsCurrent(submittedIntent)) return
          if (serverUpdateWasDeferred(error)) {
            clearSubmittedServerUpdate(submittedIntent)
            if (serverUpdateNeedsLegacyQueuedTurnWait(useAppStore.getState().health, error) && !deferredServerUpdate.waitForQueuedTurns) {
              updateDeferredServerUpdates(current => {
                const pending = current[serverUpdateScopeId]
                return pending ? { ...current, [serverUpdateScopeId]: { ...pending, waitForQueuedTurns: true } } : current
              })
            }
            scheduleDeferredServerUpdateRetry()
          } else {
            // Once submitted, an unacknowledged legacy attempt is no longer a
            // request to retry. Preserve only its durable, status-only intent.
            clearDeferredServerUpdate(serverUpdateScopeId)
            if (!serverUpdateStartErrorIsAmbiguous(error)) {
              clearSubmittedServerUpdate(submittedIntent)
              const warning = serverUpdateRecoveryWarning(error)
              if (warning) setServerUpdateWarning(warning)
              else useAppStore.getState().setError(message(error))
            }
          }
          return
        }
        let reconciled: ServerUpdateStatus | null = null
        try {
          reconciled = await window.agentsDock.serverUpdates.status()
          if (!attemptWasCancelled()) setServerUpdate(reconciled)
        } catch {
          // A restart can temporarily make status unavailable. Keep the
          // queued intent and reconcile again after health reconnects.
        }
        if (attemptWasCancelled()) return
        if (!startAttempted) {
          scheduleDeferredServerUpdateRetry()
          return
        }
        if (reconciled && serverUpdateStartWasAccepted(
          reconciled,
          requestedVersion,
          deferredServerUpdate.track
        )) {
          clearDeferredServerUpdate(serverUpdateScopeId)
          return
        }
        if (serverUpdateWasDeferred(error) || (reconciled && serverUpdateIsActive(reconciled))) {
          if (
            serverUpdateNeedsLegacyQueuedTurnWait(useAppStore.getState().health, error)
            && !deferredServerUpdate.waitForQueuedTurns
          ) {
            updateDeferredServerUpdates(current => {
              const pending = current[serverUpdateScopeId]
              return pending
                ? { ...current, [serverUpdateScopeId]: { ...pending, waitForQueuedTurns: true } }
                : current
            })
          }
          scheduleDeferredServerUpdateRetry()
          return
        }
        const recoveryWarning = serverUpdateRecoveryWarning(error, reconciled)
        if (recoveryWarning) {
          clearDeferredServerUpdate(serverUpdateScopeId)
          setServerUpdateWarning(recoveryWarning)
          return
        }
        if (!reconciled) {
          scheduleDeferredServerUpdateRetry()
          return
        }
        if (reconciled.phase === 'failed' || reconciled.phase === 'available' || reconciled.phase === 'current' || reconciled.phase === 'unavailable') {
          clearDeferredServerUpdate(serverUpdateScopeId)
          useAppStore.getState().setError(reconciled.message || message(error))
          return
        }
        scheduleDeferredServerUpdateRetry()
      } finally {
        if (deferredServerUpdateAttemptRef.current === attemptKey) {
          deferredServerUpdateAttemptRef.current = null
          deferredServerUpdateGenerationRef.current += 1
        }
        setDeferredServerUpdateAttempt(current => current?.profileId === serverUpdateScopeId ? null : current)
      }
    }
    void trackServerUpdateOperation(run)
    return () => { cancelled = true }
  }, [
    activeProfileId,
    activeProfileServerUrl,
    activeServerTurns,
    connected,
    deferredServerUpdate?.queuedAt,
    deferredServerUpdate?.serverIdentity,
    deferredServerUpdate?.serverUrl,
    deferredServerUpdate?.track,
    deferredServerUpdate?.version,
    deferredServerUpdate?.waitForQueuedTurns,
    deferredServerUpdateRetry,
    health?.server_identity,
    health?.capabilities?.server_updates,
    profileGeneration,
    restartingServer,
    deferredQueuedServerUpdateBlockers,
    serverUpdateScopeId,
    switchingProfileId
  ])
  useEffect(() => {
    if (submittedServerUpdate) {
      if (!updateSurfaceOpen || !connected || serverUpdateBusy || activeDeferredServerUpdateAttempt || !submittedUpdateIsCurrent(submittedServerUpdate)) return
      const intent = submittedServerUpdate
      const requestId = ++serverUpdatePollRef.current
      let cancelled = false
      let timer: number | undefined
      const isCurrent = () => !cancelled && serverPollIsCurrent(requestId)
      const poll = async () => {
        if (!isCurrent()) return
        await checkSubmittedUpdateStatus(intent, isCurrent)
        if (isCurrent() && submittedUpdateIsCurrent(intent)) timer = window.setTimeout(() => void poll(), 5_000)
      }
      timer = window.setTimeout(() => void poll(), 1_500)
      return () => {
        cancelled = true
        if (timer !== undefined) window.clearTimeout(timer)
        if (serverUpdatePollRef.current === requestId) serverUpdatePollRef.current += 1
      }
    }
    if ((!updateSurfaceOpen && !restartAfterUpdateTarget) || !serverUpdateIsActive(serverUpdate)) return
    const requestId = ++serverUpdatePollRef.current
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await window.agentsDock.serverUpdates.status()
        if (cancelled || !serverPollIsCurrent(requestId)) return
        setServerUpdate(next)
        setServerUpdateTrack(serverTrackForStatus(next))
        if (serverUpdateIsActive(next)) timer = window.setTimeout(() => void poll(), 1_500)
      } catch {
        if (cancelled || !serverPollIsCurrent(requestId)) return
        setServerUpdate(current => current ? { ...current, phase: 'restarting', message: 'AgentsServer is restarting; reconnecting…' } : current)
        timer = window.setTimeout(() => void poll(), 3_000)
      }
    }
    timer = window.setTimeout(() => void poll(), 1_500)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      if (serverUpdatePollRef.current === requestId) serverUpdatePollRef.current += 1
    }
  }, [activeProfileId, activeProfileServerUrl, updateBindingIdentity, connected, updateSurfaceOpen, profileGeneration, restartAfterUpdateTarget, serverUpdate?.phase, submittedServerUpdate?.attemptId, serverUpdateBusy, activeDeferredServerUpdateAttempt])
  const openServerSetup = (intent: ServerSetupIntent = 'setup') => {
    const store = useAppStore.getState()
    store.setModal('settings', false)
    store.setModal('appSettings', false)
    window.dispatchEvent(new CustomEvent('agentsdock:server-setup', { detail: { intent } }))
  }
  const openServerSetupWhenSafe = (intent: ServerSetupIntent = 'setup') => {
    const { active, queued } = serverWorkCounts(useAppStore.getState().health)
    if (active > 0 || queued > 0) {
      useAppStore.getState().setError(guidedServerSetupBlockedMessage(active, queued))
      return false
    }
    openServerSetup(intent)
    return true
  }
  const applyCheckedServerUpdate = (next: ServerUpdateStatus, track: ServerUpdateTrack) => {
    setServerUpdateWarning(null)
    setServerUpdate(next)
    const legacyStableCurrent = (
      track === 'stable'
      && !next.track
      && serverTrackForStatus(next) === 'stable'
    )
    if (next.track === track || legacyStableCurrent) {
      setServerUpdateTrack(track)
      return
    }
    // Older AgentsServer releases ignore the additive track field and can
    // discover stable releases only. Take the user directly to the signed
    // guided installer instead of leaving a channel button that appears active.
    setServerUpdateTrack(serverTrackForStatus(next))
    useAppStore.getState().setError('This AgentsServer version cannot switch channels in place yet. Use guided setup to install the signed channel-aware beta without deleting chats, then choose Stable or Beta here.')
    openServerSetupWhenSafe(track === 'beta' ? 'update-beta' : 'setup')
  }
  const checkServerUpdate = (track: ServerUpdateTrack = serverUpdateTrack) => trackServerUpdateOperation(async () => {
    const requestId = ++serverUpdateRequestRef.current
    setServerUpdateBusy(true)
    try {
      const next = await window.agentsDock.serverUpdates.check(track)
      if (serverRequestIsCurrent(requestId)) applyCheckedServerUpdate(next, track)
    }
    catch (error) {
      if (serverRequestIsCurrent(requestId)) useAppStore.getState().setError(message(error))
    }
    finally {
      if (serverRequestIsCurrent(requestId)) setServerUpdateBusy(false)
    }
  })
  const chooseServerUpdateTrack = (track: ServerUpdateTrack) => trackServerUpdateOperation(async () => {
    if (track === serverUpdateTrack && serverUpdate?.track === track) return
    const requestId = ++serverUpdateRequestRef.current
    setServerUpdateBusy(true)
    try {
      const next = await window.agentsDock.serverUpdates.check(track)
      if (serverRequestIsCurrent(requestId)) applyCheckedServerUpdate(next, track)
    } catch (error) {
      if (serverRequestIsCurrent(requestId)) useAppStore.getState().setError(message(error))
    } finally {
      if (serverRequestIsCurrent(requestId)) setServerUpdateBusy(false)
    }
  })
  const installServerUpdate = () => trackServerUpdateOperation(async () => {
    if (serverUpdateBusy || submittedServerUpdatesRef.current[submittedUpdateKey]) return
    const requestId = ++serverUpdateRequestRef.current
    setServerUpdateBusy(true)
    const requestedVersion = serverUpdate?.latest_version
    if (!requestedVersion) {
      setServerUpdateBusy(false)
      return
    }
    const currentHealth = useAppStore.getState().health
    if (
      serverUpdateCapabilityVersion(currentHealth?.capabilities?.server_updates) < SCOPED_SERVER_UPDATE_CAPABILITY_VERSION
      && !supportsLegacyLoopbackServerUpdate(currentHealth, activeProfileServerUrl)
    ) {
      setServerUpdateBusy(false)
      openServerSetupWhenSafe(serverUpdateTrack === 'beta' ? 'update-beta' : 'setup')
      return
    }
    const durableReservation = serverSupportsPassiveUpdateReservation(currentHealth)
    const work = serverWorkCounts(currentHealth)
    const blockingQueued = serverUpdateBlockingQueuedTurns(currentHealth)
    if (!durableReservation && (work.active > 0 || blockingQueued > 0)) {
      queueDeferredServerUpdate(
        requestedVersion,
        serverUpdateTrack,
        blockingQueued > 0
          && serverUpdateCapabilityVersion(currentHealth?.capabilities?.server_updates) < 3
      )
      setServerUpdateBusy(false)
      return
    }
    let intent: ServerUpdateIntent | null = null
    try {
      setServerUpdateWarning(null)
      intent = beginSubmittedServerUpdate(requestedVersion, serverUpdateTrack, serverUpdate)
      const next = durableReservation
        ? await window.agentsDock.serverUpdates.start(
            requestedVersion,
            serverUpdateTrack,
            true
          )
        : await window.agentsDock.serverUpdates.start(
            requestedVersion,
            serverUpdateTrack
          )
      if (serverRequestIsCurrent(requestId) && submittedUpdateIsCurrent(intent)) applySubmittedUpdateStatus(intent, next)
    }
    catch (error) {
      if (!intent) {
        if (serverRequestIsCurrent(requestId)) useAppStore.getState().setError(message(error))
        return
      }
      if (!serverRequestIsCurrent(requestId) || !submittedUpdateIsCurrent(intent)) return
      let reconciled: ServerUpdateStatus | null = null
      const state = useAppStore.getState()
      if (state.connected && (state.modals.settings || state.modals.appSettings)) {
        try {
          reconciled = await window.agentsDock.serverUpdates.status()
          if (serverRequestIsCurrent(requestId) && submittedUpdateIsCurrent(intent)) {
            if (applySubmittedUpdateStatus(intent, reconciled)) return
          }
        } catch {
          // Keep the durable latch. A temporarily unavailable status endpoint
          // cannot establish whether the start was accepted.
        }
      }
      if (serverRequestIsCurrent(requestId) && submittedUpdateIsCurrent(intent)) {
        if (serverUpdateWasDeferred(error)) {
          clearSubmittedServerUpdate(intent)
          queueDeferredServerUpdate(
            requestedVersion,
            serverUpdateTrack,
            serverUpdateNeedsLegacyQueuedTurnWait(useAppStore.getState().health, error)
          )
        }
        else if (!serverUpdateStartErrorIsAmbiguous(error)) {
          clearSubmittedServerUpdate(intent)
          const recoveryWarning = serverUpdateRecoveryWarning(error, reconciled)
          if (recoveryWarning) setServerUpdateWarning(recoveryWarning)
          else useAppStore.getState().setError(serverUpdateStartErrorMessage(error, reconciled))
        }
      }
    }
    finally {
      if (serverRequestIsCurrent(requestId)) setServerUpdateBusy(false)
    }
  })
  const cancelPendingServerUpdate = () => trackServerUpdateOperation(async () => {
    const scheduleId = serverUpdate?.phase === 'pending'
      ? serverUpdate.schedule_id?.trim()
      : ''
    if (!scheduleId) {
      useAppStore.getState().setError('The queued server update changed. Refresh its status before cancelling.')
      return
    }
    const requestId = ++serverUpdateRequestRef.current
    setServerUpdateBusy(true)
    try {
      const next = await window.agentsDock.serverUpdates.cancel(scheduleId)
      if (serverRequestIsCurrent(requestId)) setServerUpdate(next)
    } catch (error) {
      if (serverRequestIsCurrent(requestId)) {
        try {
          setServerUpdate(await window.agentsDock.serverUpdates.status())
        } catch {
          // Keep the exact cancellation error when status cannot be reconciled.
        }
        useAppStore.getState().setError(message(error))
      }
    } finally {
      if (serverRequestIsCurrent(requestId)) setServerUpdateBusy(false)
    }
  })
  const restartCapability = health?.capabilities?.server_restart
  const restartCapabilityVersion = restartCapability && typeof restartCapability.version === 'number'
    && Number.isFinite(restartCapability.version)
    ? restartCapability.version
    : 0
  const restartAdvertised = restartCapabilityVersion >= 1
  const forceRestartAdvertised = restartCapabilityVersion >= 2
    && restartCapability?.available === true
    && restartCapability.force_restart === true
    && restartCapability.force_confirmation_required === true
  const advertisedRestartBlockers = validatedServerRestartBlockerSnapshot(restartCapability?.blocker_snapshot)
  const activeServerIdentity = health?.server_identity?.trim() || null
  const activeServerInstanceId = health?.server_instance_id?.trim() || null
  const serverControlBusy = restartingServer || restartInspectionBusy || updateNowInspectionBusy || Boolean(switchingProfileId)
  const serverUpdateControlsBusy = serverControlBusy || restartConfirmationOpen || updateNowConfirmationOpen
  const guidedServerUpdateRequired = serverUpdateCapabilityVersion(health?.capabilities?.server_updates) < SCOPED_SERVER_UPDATE_CAPABILITY_VERSION
    && !supportsLegacyLoopbackServerUpdate(health, activeProfileServerUrl)
  const restartDisabledReason = !restartCapability?.available
    ? restartCapability?.message || 'Managed restart is unavailable on this server.'
    : !connected
      ? 'Reconnect to this server before restarting it.'
      : serverControlBusy
        ? 'AgentsDock is already changing the server connection.'
        : !activeServerIdentity || activeProfile?.serverIdentity !== activeServerIdentity
          ? 'AgentsDock must verify this server profile identity before restarting.'
          : !activeServerInstanceId
            ? 'AgentsDock could not verify this server instance. Refresh Settings and try again.'
            : null
  const pendingUpdateScheduleId = serverUpdate?.phase === 'pending'
    ? serverUpdate.schedule_id?.trim() || ''
    : ''
  const pendingUpdateTargetVersion = serverUpdate?.phase === 'pending'
    ? serverUpdate.target_version?.trim() || ''
    : ''
  const serverUpdatesCapabilityVersion = serverUpdateCapabilityVersion(health?.capabilities?.server_updates)
  const updateNowRestartMode = serverUpdatesCapabilityVersion >= 11
    ? 'schedule-bound'
    : serverUpdatesCapabilityVersion === 10
      ? 'verified-legacy'
      : null
  const updateNowDisabledReason = !updateNowRestartMode
    ? t('mergeDialogs.update.verifiedUpdateRequired')
    : !forceRestartAdvertised
      ? 'This AgentsServer does not support an audited force restart.'
      : restartDisabledReason
        || (serverUpdateBusy ? 'AgentsDock is still reconciling the queued update.' : null)
        || (!SERVER_UPDATE_SCHEDULE_ID_PATTERN.test(pendingUpdateScheduleId) ? 'AgentsDock could not verify the exact queued update reservation.' : null)
        || (!pendingUpdateTargetVersion ? 'AgentsDock could not verify the queued update target.' : null)
  useEffect(() => {
    const target = restartAfterUpdateTarget
    if (!target) return
    const state = useAppStore.getState()
    const profile = state.profiles.find(candidate => candidate.id === target.profileId)
    const currentIdentity = state.health?.server_identity?.trim() || null
    if (
      !profile
      || state.activeProfileId !== target.profileId
      || profile.serverUrl !== target.serverUrl
      || (currentIdentity && currentIdentity !== target.serverIdentity)
    ) {
      clearRestartAfterUpdateRetry()
      restartAfterUpdateAttemptRef.current = null
      setRestartAfterUpdateTarget(null)
      setRestartNotice({
        kind: 'error',
        message: 'The queued restart was canceled because the active server profile changed.'
      })
      return
    }
    if (
      !connected
      || switchingProfileId
      || restartingServer
      || restartConfirmationOpen
      || restartInspectionBusy
      || serverUpdateBusy
      || activeDeferredServerUpdateAttempt
      || serverUpdateHasStarted(serverUpdate)
      || serverUpdate?.phase === 'pending'
    ) return
    const cachedInstanceId = state.health?.server_instance_id?.trim() || ''
    if (!cachedInstanceId) return
    const attemptKey = `${target.profileId}:${state.profileGeneration}:${cachedInstanceId}`
    if (
      restartAfterUpdateAttemptRef.current === attemptKey
      || restartAfterUpdateAttemptRef.current?.startsWith(`blocked:${target.profileId}:`)
    ) return

    restartAfterUpdateAttemptRef.current = attemptKey
    let restartRequestAttempted = false
    let preRequestFailureIsRetryable = true
    setRestartingServer(true)
    setRestartNotice({
      kind: 'success',
      message: 'The server update finished. Verifying the new server instance before restarting…'
    })
    void (async () => {
      const generation = state.profileGeneration
      const payload = await window.agentsDock.servers.refresh(target.profileId, generation)
      const current = useAppStore.getState()
      const refreshedProfile = payload.profiles.find(candidate => candidate.id === target.profileId)
      const refreshedIdentity = payload.health?.server_identity?.trim()
        || refreshedProfile?.serverIdentity?.trim()
        || null
      if (
        current.activeProfileId !== target.profileId
        || current.profileGeneration !== generation
        || current.switchingProfileId
        || payload.activeProfileId !== target.profileId
        || payload.profileGeneration !== generation
        || refreshedProfile?.serverUrl !== target.serverUrl
        || refreshedIdentity !== target.serverIdentity
      ) {
        preRequestFailureIsRetryable = false
        throw new Error('The queued restart was canceled because the active server profile changed.')
      }
      const instanceId = payload.health?.server_instance_id?.trim() || ''
      if (!instanceId) {
        throw new Error('AgentsDock could not verify the updated server instance yet.')
      }
      // A refresh emits the same authoritative health to the renderer. Record
      // that identity now so the resulting connection update cannot schedule a
      // second restart attempt for the same instance.
      restartAfterUpdateAttemptRef.current = `${target.profileId}:${generation}:${instanceId}`
      restartRequestAttempted = true
      const restarted = await current.restartServer(instanceId)
      if (!restarted) {
        throw new Error('The queued restart could not be confirmed.')
      }
      clearRestartAfterUpdateRetry()
      restartAfterUpdateAttemptRef.current = null
      setRestartAfterUpdateTarget(null)
      setRestartNotice({ kind: 'success', message: 'AgentsServer restarted and reconnected.' })
    })()
      .catch(error => {
        const current = useAppStore.getState()
        const profileStillMatches = current.activeProfileId === target.profileId
          && current.profiles.some(candidate => (
            candidate.id === target.profileId
            && candidate.serverIdentity === target.serverIdentity
            && candidate.serverUrl === target.serverUrl
          ))
        if (!profileStillMatches || !preRequestFailureIsRetryable) {
          clearRestartAfterUpdateRetry()
          restartAfterUpdateAttemptRef.current = null
          setRestartAfterUpdateTarget(null)
          setRestartNotice({
            kind: 'error',
            message: 'The queued restart was canceled because the active server profile changed.'
          })
          return
        }
        if (restartRequestAttempted) {
          // A rejected or disconnected restart request can still have taken
          // effect. Keep the user's intent visible, but never auto-submit a
          // second restart against the replacement instance.
          clearRestartAfterUpdateRetry()
          restartAfterUpdateAttemptRef.current = `blocked:${target.profileId}:${Date.now()}`
        } else {
          scheduleRestartAfterUpdateRetry()
        }
        setRestartNotice({
          kind: 'error',
          message: restartRequestAttempted
            ? `Restart is still queued. ${message(error)} Use Restart server to retry.`
            : `Restart is still queued. ${message(error)} AgentsDock will retry automatically.`
        })
      })
      .finally(() => {
        setRestartingServer(false)
      })
  }, [
    activeDeferredServerUpdateAttempt,
    connected,
    restartAfterUpdateTarget,
    restartAfterUpdateRetry,
    restartConfirmationOpen,
    restartInspectionBusy,
    restartingServer,
    activeServerInstanceId,
    serverUpdate?.phase,
    serverUpdateBusy,
    switchingProfileId
  ])
  const openRestartConfirmation = (mode: 'safe' | 'force' = 'safe') => {
    if (
      restartDisabledReason
      || (mode === 'force' && !forceRestartAdvertised)
      || !activeProfileId
      || !activeProfile
      || !activeServerIdentity
      || !activeServerInstanceId
    ) return
    restartInspectionRef.current += 1
    const target: ServerRestartTarget = {
      profileId: activeProfileId,
      profileGeneration,
      serverIdentity: activeServerIdentity,
      serverInstanceId: activeServerInstanceId,
      profileName: activeProfile.name,
      serverUrl: activeProfile.serverUrl
    }
    setRestartTarget(target)
    setRestartConfirmationMode(mode)
    setRestartBlockerSnapshot(advertisedRestartBlockers)
    setRestartDialogError(null)
    setRestartNotice(null)
    setRestartConfirmationOpen(true)
    // Pre-beta.30 force APIs require a matching revision. Refresh only on the
    // user's click; modern recovery must not wait on a possibly wedged status.
    if (mode === 'force' && !forceRestartOverridesSafety(advertisedRestartBlockers)) {
      void inspectRestartBlockers(target, undefined, true)
    }
  }
  // Capability v2 also covers older APIs that require an exact revision. Only
  // a proven emergency contract may proceed without a status snapshot.
  const forceRestartDisabledReason = restartDisabledReason
    || (!forceRestartAdvertised ? 'This AgentsServer does not support force restart.' : null)
    || (forceRestartOverridesSafety(restartBlockerSnapshot) || (!restartBlockerSnapshot && forceRestartOverridesSafety(advertisedRestartBlockers))
      ? null
      : !restartBlockerSnapshot
        ? 'AgentsDock could not verify restart information for this server.'
        : restartBlockerSnapshot.has_safety_blockers
          ? 'Force restart cannot bypass server maintenance, in-flight control requests, session deletion, or Codex goal reconfiguration.'
          : null)
  const updateNowForceDisabledReason = updateNowInspectionBusy
    ? 'AgentsDock is checking current restart blockers.'
    : updateNowDialogError
      || (!updateNowBlockerSnapshot
        ? 'AgentsDock could not verify a fresh restart blocker snapshot.'
        : !forceRestartReviewAvailable(updateNowBlockerSnapshot)
          ? 'AgentsServer does not currently permit a force restart for this blocker snapshot.'
          : null)
  const openUpdateNowConfirmation = async () => {
    if (
      updateNowDisabledReason
      || !updateNowRestartMode
      || serverUpdate?.phase !== 'pending'
      || !activeProfileId
      || !activeProfile
      || !activeServerIdentity
      || !activeServerInstanceId
      || !pendingUpdateScheduleId
      || !pendingUpdateTargetVersion
    ) return

    const target: ServerRestartTarget = {
      profileId: activeProfileId,
      profileGeneration,
      serverIdentity: activeServerIdentity,
      serverInstanceId: activeServerInstanceId,
      profileName: activeProfile.name,
      serverUrl: activeProfile.serverUrl
    }
    const reservation: PendingServerUpdateReservation = {
      scheduleId: pendingUpdateScheduleId,
      targetVersion: pendingUpdateTargetVersion,
      track: serverTrackForStatus(serverUpdate),
      restartMode: updateNowRestartMode
    }
    const requestId = ++updateNowInspectionRef.current
    setUpdateNowTarget(target)
    setUpdateNowReservation(reservation)
    setUpdateNowBlockerSnapshot(null)
    setUpdateNowDialogError(null)
    setRestartNotice(null)
    setUpdateNowInspectionBusy(true)
    setUpdateNowConfirmationOpen(true)

    try {
      const scope: WorkspaceProfileScope = {
        profileId: target.profileId,
        profileGeneration: target.profileGeneration,
        serverIdentity: target.serverIdentity
      }
      const status = await window.agentsDock.servers.restartStatus(scope)
      if (updateNowInspectionRef.current !== requestId || !restartTargetIsCurrent(target)) return
      if (
        status.server_identity !== target.serverIdentity
        || status.server_instance_id !== target.serverInstanceId
      ) throw new Error('The active AgentsServer changed while restart blockers were being checked. Close this confirmation and try again.')
      if (status.phase === 'accepted' || status.phase === 'signaling') {
        throw new Error(status.message || 'AgentsServer is already restarting.')
      }
      const snapshot = validatedServerRestartBlockerSnapshot(status.blocker_snapshot)
      if (!snapshot || !forceRestartReviewAvailable(snapshot)) {
        throw new Error(
          status.message
          || 'AgentsServer did not provide a force-restart blocker snapshot that can be explicitly confirmed.'
        )
      }
      setUpdateNowBlockerSnapshot(snapshot)
    } catch (error) {
      if (updateNowInspectionRef.current === requestId && restartTargetIsCurrent(target)) {
        setUpdateNowBlockerSnapshot(null)
        setUpdateNowDialogError(message(error))
      }
    } finally {
      if (updateNowInspectionRef.current === requestId) setUpdateNowInspectionBusy(false)
    }
  }
  const confirmPendingUpdateNow = async () => {
    const target = updateNowTarget
    const reservation = updateNowReservation
    const snapshot = updateNowBlockerSnapshot
    if (
      !target
      || !reservation
      || !snapshot
      || updateNowForceDisabledReason
      || !restartTargetIsCurrent(target)
    ) return

    setRestartNotice({
      kind: 'success',
      message: `Restarting AgentsServer for ${reservation.targetVersion}. The queued update remains reserved; reconnecting…`
    })
    setUpdateNowDialogError(null)
    setRestartingServer(true)
    let restartAttempted = false
    try {
      await settleServerUpdateOperations()
      if (!restartTargetIsCurrent(target)) {
        throw new Error('The active AgentsServer changed while the queued update was being verified.')
      }

      const reconciled = await window.agentsDock.serverUpdates.status()
      setServerUpdate(reconciled)
      setServerUpdateTrack(serverTrackForStatus(reconciled))
      if (!restartTargetIsCurrent(target)) {
        throw new Error('The active AgentsServer changed while the queued update was being verified.')
      }
      if (
        serverUpdateHasStarted(reconciled)
        && reconciled.target_version?.trim() === reservation.targetVersion
      ) {
        closeUpdateNowConfirmation()
        setRestartNotice({
          kind: 'success',
          message: `${reservation.targetVersion} started before the restart was sent. AgentsDock is following its install and reconnect progress.`
        })
        return
      }
      const reconciledScheduleId = reconciled.phase === 'pending'
        ? reconciled.schedule_id?.trim() || ''
        : ''
      const reconciledTargetVersion = reconciled.target_version?.trim() || ''
      const reconciledTrack = reconciled.track || reservation.track
      if (
        reconciled.phase !== 'pending'
        || reconciledScheduleId !== reservation.scheduleId
        || reconciledTargetVersion !== reservation.targetVersion
        || reconciledTrack !== reservation.track
      ) {
        throw new Error('The queued update reservation changed before restart. Review the current update status and try again.')
      }

      const currentState = useAppStore.getState()
      const currentUpdateCapabilityVersion = serverUpdateCapabilityVersion(
        currentState.health?.capabilities?.server_updates
      )
      const currentRestartMode = currentUpdateCapabilityVersion >= 11
        ? 'schedule-bound'
        : currentUpdateCapabilityVersion === 10
          ? 'verified-legacy'
          : null
      if (!currentState.connected || currentRestartMode !== reservation.restartMode) {
        throw new Error(t('mergeDialogs.update.capabilityChanged'))
      }

      // Deliberately preserve the exact pending reservation: unlike the normal
      // Restart server workflow, Update now never calls serverUpdates.cancel.
      // v11+ binds that reservation inside restart admission. v10 predates the
      // additive field, so send its supported blocker revision only after the
      // exact schedule, target, and track have been reconciled immediately above.
      restartAttempted = true
      const restarted = await useAppStore.getState().restartServer(target.serverInstanceId, {
        force: true,
        forceConfirmed: true,
        expectedBlockerRevision: snapshot.revision,
        ...(reservation.restartMode === 'schedule-bound'
          ? { expectedUpdateScheduleId: reservation.scheduleId }
          : {})
      })
      if (!restarted) throw new Error('The force restart request could not be confirmed.')
      closeUpdateNowConfirmation()
      setRestartNotice({
        kind: 'success',
        message: `AgentsServer restarted and reconnected. The preserved ${reservation.targetVersion} update will install automatically.`
      })
    } catch (error) {
      const detail = message(error)
      if (restartAttempted || !restartTargetIsCurrent(target)) {
        closeUpdateNowConfirmation()
        setRestartNotice({
          kind: 'error',
          message: `${detail} AgentsDock did not cancel the queued update. Check server update status before retrying.`
        })
      } else {
        setUpdateNowDialogError(detail)
        setRestartNotice({ kind: 'error', message: detail })
      }
    } finally {
      setRestartingServer(false)
    }
  }
  const confirmServerRestart = async () => {
    const target = restartTarget
    if (restartDisabledReason || !target || !restartTargetIsCurrent(target)) {
      closeRestartConfirmation()
      return
    }
    restartDecisionRef.current = true
    setRestartNotice(null)
    setRestartDialogError(null)
    setRestartingServer(true)
    let restartAttempted = false
    try {
      // A visible busy flag is not an ordering primitive. Settle the exact
      // check/start/cancel promises first, then ask AgentsServer for fresh
      // updater state before choosing cancel, queue-after-update, or restart.
      await settleServerUpdateOperations()
      if (!restartTargetIsCurrent(target)) {
        throw new Error('The active AgentsServer changed while update state was being reconciled. Reopen Settings and try again.')
      }

      const currentDeferredUpdate = readDeferredServerUpdates()[target.profileId] || null
      if (currentDeferredUpdate) clearDeferredServerUpdate(target.profileId)
      let reconciledUpdate: ServerUpdateStatus | null = null
      if (useAppStore.getState().health?.managed_updates) {
        reconciledUpdate = await window.agentsDock.serverUpdates.status()
        if (!reconciledUpdate) {
          throw new Error('AgentsDock could not verify the current server update state. Retry Restart server in a moment.')
        }
        if (!restartTargetIsCurrent(target)) {
          throw new Error('The active AgentsServer changed while update state was being reconciled. Reopen Settings and try again.')
        }
        setServerUpdate(reconciledUpdate)
        setServerUpdateTrack(serverTrackForStatus(reconciledUpdate))
      }

      if (serverUpdateHasStarted(reconciledUpdate)) {
        clearRestartAfterUpdateRetry()
        setRestartAfterUpdateTarget({
          profileId: target.profileId,
          serverIdentity: target.serverIdentity,
          profileName: target.profileName,
          serverUrl: target.serverUrl
        })
        restartAfterUpdateAttemptRef.current = null
        closeRestartConfirmation()
        setRestartNotice({
          kind: 'success',
          message: 'Restart queued. It will run as soon as the active server update reaches a safe terminal state.'
        })
        return
      }

      if (reconciledUpdate?.phase === 'pending') {
        const scheduleId = reconciledUpdate.schedule_id?.trim() || ''
        if (reconciledUpdate.cancelable !== true || !scheduleId) {
          throw new Error('The scheduled update cannot be canceled safely. Refresh its status, then retry Restart server.')
        }
        const next = await trackServerUpdateOperation(
          () => window.agentsDock.serverUpdates.cancel(scheduleId)
        )
        setServerUpdate(next)
        if (next.phase === 'pending') {
          throw new Error('The scheduled update is still pending. Refresh its status before restarting the server.')
        }
        if (serverUpdateHasStarted(next)) {
          clearRestartAfterUpdateRetry()
          setRestartAfterUpdateTarget({
            profileId: target.profileId,
            serverIdentity: target.serverIdentity,
            profileName: target.profileName,
            serverUrl: target.serverUrl
          })
          restartAfterUpdateAttemptRef.current = null
          closeRestartConfirmation()
          setRestartNotice({
            kind: 'success',
            message: 'The update started before cancellation completed. Restart is queued for its next safe terminal state.'
          })
          return
        }
      }
      restartAttempted = true
      const restarted = await useAppStore.getState().restartServer(target.serverInstanceId)
      if (!restarted) {
        throw new Error('The restart request could not be confirmed.')
      }
      clearRestartAfterUpdateRetry()
      restartAfterUpdateAttemptRef.current = null
      setRestartAfterUpdateTarget(null)
      closeRestartConfirmation()
      setRestartNotice({ kind: 'success', message: 'AgentsServer restarted and reconnected.' })
    } catch (error) {
      const detail = message(error)
      const offeredForceRestart = restartAttempted && restartTargetIsCurrent(target)
        ? await inspectRestartBlockers(target, detail)
        : false
      if (!restartTargetIsCurrent(target)) {
        closeRestartConfirmation()
        setRestartNotice({ kind: 'error', message: detail })
      } else if (!offeredForceRestart) {
        setRestartDialogError(detail)
        setRestartNotice({ kind: 'error', message: detail })
      }
    } finally {
      restartDecisionRef.current = false
      setRestartingServer(false)
    }
  }
  const reviewForceRestart = async () => {
    const target = restartTarget
    if (!target || !restartTargetIsCurrent(target)) {
      closeRestartConfirmation()
      return
    }
    await inspectRestartBlockers(target)
  }
  const confirmForceRestart = async () => {
    const target = restartTarget
    const snapshot = restartBlockerSnapshot
    if (
      !target
      || restartingServer
      || restartInspectionBusy
      || forceRestartDisabledReason
      || !restartTargetIsCurrent(target)
    ) return
    setRestartNotice(null)
    setRestartDialogError(null)
    setRestartingServer(true)
    // This explicit recovery replaces an earlier queued restart intent, even
    // if its response is ambiguous. Never restart the replacement boot again.
    // The queued update itself remains untouched.
    clearRestartAfterUpdateRetry()
    restartAfterUpdateAttemptRef.current = null
    setRestartAfterUpdateTarget(null)
    try {
      const restarted = await useAppStore.getState().restartServer(target.serverInstanceId, {
        force: true,
        forceConfirmed: true,
        // Null when the server could not serve a snapshot; beta.30+ audits the
        // omission instead of refusing the emergency restart.
        expectedBlockerRevision: snapshot?.revision ?? null
      })
      if (!restarted) throw new Error('The force restart request could not be confirmed.')
      closeRestartConfirmation()
      setRestartNotice({ kind: 'success', message: 'AgentsServer force restarted and reconnected. Active work was interrupted.' })
    } catch (error) {
      closeRestartConfirmation()
      setRestartNotice({ kind: 'error', message: message(error) })
    } finally {
      setRestartingServer(false)
    }
  }
  const restartBlockerDescriptions = restartBlockerSnapshot
    ? serverRestartBlockerDescriptions(restartBlockerSnapshot)
    : []
  const updateNowBlockerDescriptions = updateNowBlockerSnapshot
    ? serverRestartBlockerDescriptions(updateNowBlockerSnapshot)
    : []
  const restartUpdateExplanation = serverUpdateHasStarted(serverUpdate) || activeDeferredServerUpdateAttempt?.phase === 'starting'
    ? 'A server update is already active. Confirming will queue this restart and run it as soon as the updater reaches a safe terminal state.'
    : serverUpdate?.phase === 'pending'
      ? 'The scheduled idle update will be canceled first, then AgentsServer will restart now.'
      : deferredServerUpdate
        ? 'The locally queued idle update will be canceled first, then AgentsServer will restart now.'
        : restartAfterUpdateTarget
          ? 'A restart is already queued for the end of the active server update.'
          : null
  const serverUpdateCheckedAt = updateCheckedAtLabel(serverUpdate?.checked_at)
  const retryFailedServerUpdate = serverUpdate?.phase === 'failed'
    && serverUpdate.update_available === true
    && Boolean(serverUpdate.latest_version?.trim())
  const showServerUpdateControls = Boolean(health?.managed_updates || serverUpdate || deferredServerUpdate || submittedServerUpdate)
  // Updates exposes recovery directly, without first trying a safe restart or
  // cancelling an idle update. Never pretend legacy safe-only APIs can force.
  const restartServerButton = (force = false) => restartAdvertised && <button type="button" className="quiet-button server-restart-button" disabled={Boolean(restartDisabledReason)} title={restartDisabledReason || (force ? `Force restart ${activeProfile?.name || 'the active server'}. Active work will be interrupted.` : t("ui.Dialogs.SettingsDialog.safely_restart_2340480", { "server": String(activeProfile?.name || 'the active server') }))} onClick={() => openRestartConfirmation(force ? 'force' : 'safe')}>{serverControlBusy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} {restartingServer ? t("ui.Dialogs.SettingsDialog.restarting_75d0f14") : force ? 'Force restart server' : t("ui.Dialogs.SettingsDialog.restart_server_51cd293")}</button>
  const serverUpdatesContent = <div className="app-settings-server-updates">
    {(showServerUpdateControls || restartAdvertised) && <div className="app-settings-row app-settings-update-row server-update-panel">
      <div className="app-settings-row-copy"><strong>AgentsServer <small>{serverUpdate?.current_version || String(health?.server_version || t("ui.Dialogs.SettingsDialog.version_unknown_ff5a99f"))}</small></strong><span className={restartNotice
        ? `server-restart-notice ${restartNotice.kind}`
        : submittedServerUpdate || serverUpdateWarning || serverUpdateStatusWarning
          ? 'server-update-warning'
          : serverUpdate?.phase === 'pending'
            ? 'server-update-pending'
            : undefined} role={restartNotice?.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{restartNotice?.message || (submittedServerUpdate ? `${submittedServerUpdate.version}: ${UNKNOWN_SERVER_UPDATE_MESSAGE}` : null) || serverUpdateWarning || serverUpdateStatusWarning || (deferredServerUpdate
        ? deferredServerUpdateMessage(
            deferredServerUpdate.version,
            deferredServerUpdate.track,
            activeServerTurns,
            deferredQueuedServerUpdateBlockers
          )
        : [serverUpdateMessage(serverUpdate, health) || (showServerUpdateControls ? 'Ready to check' : restartCapability?.message), serverUpdateCheckedAt].filter(Boolean).join(' · '))}</span></div>
      <div className="app-settings-actions">
        {showServerUpdateControls && <>
        <div className="segmented update-track-picker" role="group" aria-label={t("ui.Dialogs.SettingsDialog.server_update_channel_e0e5ffe")}>
          <button type="button" className={serverUpdateTrack === 'stable' ? 'active' : ''} disabled={serverUpdateControlsBusy || serverUpdateBusy || serverUpdateIsActive(serverUpdate) || Boolean(deferredServerUpdate) || Boolean(submittedServerUpdate)} onClick={() => void chooseServerUpdateTrack('stable')}>{t("ui.Dialogs.SettingsDialog.stable_90ee305")}</button>
          <button type="button" className={serverUpdateTrack === 'beta' ? 'active' : ''} disabled={serverUpdateControlsBusy || serverUpdateBusy || serverUpdateIsActive(serverUpdate) || Boolean(deferredServerUpdate) || Boolean(submittedServerUpdate)} onClick={() => void chooseServerUpdateTrack('beta')}>{t("ui.Dialogs.SettingsDialog.beta_7033903")}</button>
        </div>
        {submittedServerUpdate
          ? <button type="button" className="quiet-button" disabled={serverUpdateControlsBusy || serverUpdateBusy || submittedUpdateChecking || !connected} onClick={() => void checkSubmittedUpdateStatus(submittedServerUpdate, () => submittedUpdateIsCurrent(submittedServerUpdate) && Boolean(useAppStore.getState().modals.settings || useAppStore.getState().modals.appSettings))}>{submittedUpdateChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Check status</button>
          : <button type="button" className="quiet-button" disabled={serverUpdateControlsBusy || serverUpdateBusy || serverUpdateIsActive(serverUpdate) || Boolean(deferredServerUpdate)} onClick={() => void checkServerUpdate()}>{serverUpdateBusy || serverUpdateIsActive(serverUpdate) ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} {serverUpdateBusy ? 'Checking server…' : t("ui.Dialogs.SettingsDialog.check_server_7ff0135")}</button>}
        </>}
        {restartServerButton(forceRestartAdvertised)}
        {submittedServerUpdate
          ? null
          : deferredServerUpdate
          ? activeDeferredServerUpdateAttempt
            ? <button type="button" className="quiet-button" disabled><LoaderCircle className="spin" size={13} /> {activeDeferredServerUpdateAttempt.phase === 'starting' ? t("ui.Dialogs.SettingsDialog.starting_update_ca9f052") : t("ui.Dialogs.SettingsDialog.checking_update_e152bb6")}</button>
            : <button type="button" className="quiet-button" disabled={serverUpdateControlsBusy} onClick={() => clearDeferredServerUpdate()}><X size={13} />{" "}{t("ui.Dialogs.SettingsDialog.cancel_queued_update_babd18f")}</button>
          : serverUpdate?.phase === 'pending'
          ? <div className="server-update-actions">
            <button type="button" className="danger-button compact" disabled={Boolean(updateNowDisabledReason) || updateNowConfirmationOpen} title={updateNowDisabledReason || t("ui.Dialogs.SettingsDialog.interrupt_current_work_and_install_now_86b0006", { "version": String(pendingUpdateTargetVersion) })} onClick={() => void openUpdateNowConfirmation()}>{updateNowInspectionBusy || restartingServer ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />} {updateNowInspectionBusy ? t("ui.Dialogs.SettingsDialog.checking_blockers_72d4294") : restartingServer ? t("ui.Dialogs.SettingsDialog.updating_now_efb6c62") : 'Update now'}</button>
            <button type="button" className="quiet-button" disabled={serverUpdateControlsBusy || serverUpdateBusy || serverUpdate.cancelable !== true || !serverUpdate.schedule_id} onClick={() => void cancelPendingServerUpdate()}>{serverUpdateBusy ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}{" "}{t("ui.Dialogs.SettingsDialog.cancel_queued_update_babd18f")}</button>
          </div>
          : serverUpdate?.phase === 'available' || retryFailedServerUpdate
          ? <button type="button" className="primary-button" disabled={serverUpdateControlsBusy || serverUpdateBusy} onClick={() => void installServerUpdate()}>{serverUpdateBusy ? <LoaderCircle className="spin" size={13} /> : guidedServerUpdateRequired ? <ArrowRight size={13} /> : serverRestartBlocked ? <Clock3 size={13} /> : <Download size={13} />} {guidedServerUpdateRequired ? t("ui.Dialogs.SettingsDialog.open_guided_update_d9b2001", { "target": String(serverUpdateTrack === 'beta' ? t("ui.Dialogs.SettingsDialog.beta_7033903") : t("ui.Dialogs.SettingsDialog.stable_90ee305")) }) : retryFailedServerUpdate ? t(serverRestartBlocked ? 'serverUpdate.retryWhenIdle' : 'serverUpdate.retry', { version: String(serverUpdate?.latest_version) }) : serverRestartBlocked ? t("ui.Dialogs.SettingsDialog.install_latest_when_idle_dab442a", { "target": String(serverUpdateTrack === 'beta' ? t("ui.Dialogs.SettingsDialog.beta_7033903") : t("ui.Dialogs.SettingsDialog.stable_90ee305")) }) : t('serverUpdate.install', { version: String(serverUpdate?.latest_version) })}</button>
          : null}
      </div>
    </div>}
    <div className="app-settings-server-actions">
      {restartNotice && !showServerUpdateControls && !restartAdvertised && <div className={`app-settings-server-notice ${restartNotice.kind}`} role={restartNotice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{restartNotice.message}</div>}
      <button type="button" className="server-setup-guide compact" disabled={serverUpdateControlsBusy || Boolean(submittedServerUpdate)} onClick={() => openServerSetup()}>
        <span className="server-setup-icon"><Server size={18} /></span>
        <span><strong>{t("ui.Dialogs.SettingsDialog.install_or_update_agentsserver_d76fdc0")}</strong></span>
        <ArrowRight size={15} />
      </button>
    </div>
  </div>
  const closeSettings = () => {
    const store = useAppStore.getState()
    store.setModal('settings', false)
    store.setModal('appSettings', false)
  }
  const serverSettingsContent = <div className="dialog-form settings-dialog-body app-settings-server-page">
    <ServerManagement addRequest={addServerRequest} manageRequest={manageServersRequest} />
    <div className={`server-health ${connected ? degraded ? 'degraded' : 'online' : 'offline'}`}><span /><div className="server-health-copy"><strong>{connected ? degraded ? t("ui.Dialogs.SettingsDialog.connected_limited_a6733ca") : t("ui.Dialogs.SettingsDialog.connected_2296556") : t("ui.Dialogs.SettingsDialog.offline_a179478")}</strong><small>{health?.server_identity || t("ui.Dialogs.SettingsDialog.connection_settings_are_stored_on_this_mac_7348bfb")}</small>{restartNotice && <small className={`server-restart-notice ${restartNotice.kind}`} role={restartNotice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{restartNotice.message}</small>}</div>{restartServerButton()}</div>
    <RuntimeHealthPanel />
    <CodexServerSettings
      connected={connected}
      profileId={activeProfileId}
      profileGeneration={profileGeneration}
    />
    <footer><button type="button" className="primary-button" onClick={closeSettings}>{t("ui.Dialogs.SettingsDialog.done_11a6767")}</button></footer>
  </div>
  return <>
  <AppSettingsDialog serverSettings={serverSettingsContent} serverUpdates={serverUpdatesContent} />
  <Shell
    open={updateNowConfirmationOpen}
    onOpenChange={value => { if (!value && !restartingServer) closeUpdateNowConfirmation() }}
    title={t("ui.Dialogs.SettingsDialog.update_agentsserver_now_caba87a")}
    description={updateNowTarget && updateNowReservation
      ? t("ui.Dialogs.SettingsDialog.install_on_at_2fb6b22", { "version": String(updateNowReservation.targetVersion), "profile": String(updateNowTarget.profileName), "url": String(updateNowTarget.serverUrl) })
      : t("ui.Dialogs.SettingsDialog.install_the_queued_agentsserver_update_now_944121e")}
    className="confirm-dialog"
    closeDisabled={restartingServer}
    initialFocusRef={updateNowCancelRef}
  >
    <div className="server-restart-confirmation">
      <p><strong>{t("ui.Dialogs.SettingsDialog.update_now_force_restarts_agentsserver_and_d6058b4")}</strong>{t('ui.update.forceWarning')}</p>
      <p className="server-restart-update-note" role="status">{t(updateNowReservation?.restartMode === 'verified-legacy' ? 'mergeDialogs.update.verifiedReservation' : 'mergeDialogs.update.atomicReservation', { version: updateNowReservation?.targetVersion || t("ui.Dialogs.SettingsDialog.the_selected_release_074a7dd") })}</p>
      {updateNowInspectionBusy && <p role="status"><LoaderCircle className="spin" size={13} />{" "}{t("ui.Dialogs.SettingsDialog.checking_a_fresh_identity_bound_blocker_sn_c4b2031")}</p>}
      {updateNowBlockerSnapshot && <div className="server-restart-blockers" role="status">
        <strong>{t("ui.Dialogs.SettingsDialog.fresh_blocker_snapshot_e35dd71")}</strong>
        {updateNowBlockerDescriptions.length > 0
          ? <ul>{updateNowBlockerDescriptions.map(item => <li key={item}>{item}</li>)}</ul>
          : <p>{t("ui.Dialogs.SettingsDialog.no_blockers_were_counted_force_restart_can_7879740")}</p>}
      </div>}
      {updateNowDialogError && <p className="server-restart-dialog-error" role="alert">{updateNowDialogError}</p>}
      <div className="confirm-actions">
        <button ref={updateNowCancelRef} type="button" className="quiet-button" disabled={restartingServer} onClick={closeUpdateNowConfirmation}>{t("ui.Dialogs.SettingsDialog.cancel_19766ed")}</button>
        <button type="button" className="danger-button" title={updateNowForceDisabledReason || t("ui.Dialogs.SettingsDialog.interrupt_work_and_install_1ba2a06", { "version": String(updateNowReservation?.targetVersion || 'the queued update') })} disabled={Boolean(updateNowForceDisabledReason) || restartingServer} onClick={() => void confirmPendingUpdateNow()}>{restartingServer ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />} {restartingServer ? t("ui.Dialogs.SettingsDialog.restarting_for_update_fba3b52") : t("ui.Dialogs.SettingsDialog.interrupt_work_and_update_now_4a6311b")}</button>
      </div>
    </div>
  </Shell>
  <Shell
    open={restartConfirmationOpen}
    onOpenChange={value => { if (!value && !restartingServer) closeRestartConfirmation() }}
    title={restartConfirmationMode === 'force' ? t("ui.Dialogs.SettingsDialog.force_restart_agentsserver_d12d70b") : t("ui.Dialogs.SettingsDialog.restart_agentsserver_19f4139")}
    description={restartTarget
      ? t("ui.Dialogs.SettingsDialog.at_ec50d54", { "action": String(restartConfirmationMode === 'force' ? 'Force restart' : t("ui.Dialogs.SettingsDialog.restart_6b983a8")), "profile": String(restartTarget.profileName), "url": String(restartTarget.serverUrl) })
      : t("ui.Dialogs.SettingsDialog.restart_the_active_agentsserver_99f571d")}
    className="confirm-dialog"
    closeDisabled={restartingServer}
    initialFocusRef={restartCancelRef}
  >
    <div className="server-restart-confirmation">
      {restartConfirmationMode === 'safe'
        ? <>
          <p>{t("ui.Dialogs.SettingsDialog.all_connected_clients_will_briefly_go_offl_82baed8")}</p>
          {restartUpdateExplanation && <p className="server-restart-update-note" role="status">{restartUpdateExplanation}</p>}
          {restartBlockerSnapshot?.has_blockers && <div className="server-restart-blockers" role="status">
            <strong>{t("ui.Dialogs.SettingsDialog.agentsserver_currently_reports_cc2ee46")}</strong>
            <ul>{restartBlockerDescriptions.map(item => <li key={item}>{item}</li>)}</ul>
          </div>}
          {restartBlockerSnapshot?.has_safety_blockers && !forceRestartOverridesSafety(restartBlockerSnapshot) && <p className="server-restart-dialog-error" role="alert">{t("ui.Dialogs.SettingsDialog.force_restart_is_unavailable_while_safety__e15d497")}</p>}
          {restartDialogError && <p className="server-restart-dialog-error" role="alert">{restartDialogError}</p>}
          <div className="confirm-actions">
            <button ref={restartCancelRef} type="button" className="quiet-button" disabled={restartingServer} onClick={closeRestartConfirmation}>{t("ui.Dialogs.SettingsDialog.cancel_19766ed")}</button>
            {forceRestartAdvertised && forceRestartReviewAvailable(restartBlockerSnapshot) && <button type="button" className="danger-button" disabled={restartingServer || restartInspectionBusy} onClick={() => void reviewForceRestart()}>{restartInspectionBusy ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />}{" "}{t("ui.Dialogs.SettingsDialog.review_force_restart_399b57f")}</button>}
            <button type="button" className="primary-button" disabled={Boolean(restartDisabledReason) || restartingServer || restartInspectionBusy} onClick={() => void confirmServerRestart()}>{restartingServer ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} {restartingServer ? t("ui.Dialogs.SettingsDialog.restarting_75d0f14") : t("ui.Dialogs.SettingsDialog.restart_server_51cd293")}</button>
          </div>
        </>
        : <>
          <p><strong>{t("ui.Dialogs.SettingsDialog.force_restart_stops_agentsserver_even_whil_16ec26e")}</strong>{t('ui.restart.forceWarning', { name: restartTarget?.profileName ?? '', url: restartTarget?.serverUrl ?? '' })}</p>
          {restartBlockerSnapshot && <div className="server-restart-blockers" role="status">
            <strong>{t("ui.Dialogs.SettingsDialog.agentsserver_currently_reports_cc2ee46")}</strong>
            <ul>{restartBlockerDescriptions.map(item => <li key={item}>{item}</li>)}</ul>
          </div>}
          {restartBlockerSnapshot?.has_safety_blockers && !forceRestartOverridesSafety(restartBlockerSnapshot) && <p className="server-restart-dialog-error" role="alert">{t("ui.Dialogs.SettingsDialog.force_restart_cannot_bypass_safety_critica_087f3db")}</p>}
          {restartDialogError && <p className="server-restart-dialog-error" role="alert">{restartDialogError}</p>}
          <div className="confirm-actions">
            <button ref={restartCancelRef} type="button" className="quiet-button" disabled={restartingServer} onClick={closeRestartConfirmation}>{t("ui.Dialogs.SettingsDialog.cancel_19766ed")}</button>
            <button type="button" className="danger-button" title={forceRestartDisabledReason || `Force restart ${restartTarget?.profileName || 'the active server'}`} disabled={Boolean(forceRestartDisabledReason) || restartingServer || restartInspectionBusy} onClick={() => void confirmForceRestart()}>{restartingServer ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />} {restartingServer ? t("ui.Dialogs.SettingsDialog.force_restarting_d5fea99") : 'Force Restart'}</button>
          </div>
        </>}
    </div>
  </Shell>
  </>
}

export function SessionDialog({ mode }: { mode: 'newChat' | 'resume' }) {
  useLocale()
  const open = useAppStore(state => state.modals[mode])
  const catalog = useAppStore(state => state.runtimeCatalog)
  const health = useAppStore(state => state.health)
  const defaultCwd = useAppStore(state => state.health?.default_cwd?.trim() || '')
  const directoryCompletionAvailable = useAppStore(state => state.health?.capabilities?.working_directory_completion?.available === true)
  const importSupported = useAppStore(state => localSessionImportSupported(state.health))
  const sessions = useAppStore(state => state.sessions)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('General')
  const [cwd, setCwd] = useState('')
  const [providerId, setProviderId] = useState('')
  const [backend, setBackend] = useState<Backend>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const folders = useMemo(() => [...new Set(sessions.map(session => session.folder || 'General'))].sort(), [sessions])
  const backendOptions = useMemo(() => selectableChatBackends(health, catalog), [catalog, health])
  useEffect(() => {
    if (!open) return
    setTitle(mode === 'newChat' ? 'New chat' : 'Resumed chat')
    setProviderId('')
    setModel('')
    setEffort('')
    setSystemPrompt('')
    setCwd(defaultCwd)
  }, [defaultCwd, mode, open])
  useEffect(() => {
    if (!open || backendOptions.includes(backend)) return
    setBackend('codex')
    setModel('')
    setEffort('')
  }, [backend, backendOptions, open])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    try {
      const state = useAppStore.getState()
      const preferenceScope = captureWorkspaceScope(state)
      if (!selectableChatBackends(state.health, state.runtimeCatalog).includes(backend)) throw new Error(`${backendLabel(backend)} is unavailable on this AgentsServer.`)
      const runtimeError = runtimeSelectionError(state.health, state.runtimeCatalog, backend, model)
      if (runtimeError) throw new Error(runtimeError)
      const input = { title: title.trim() || 'New chat', folder: folder.trim() || 'General', cwd: cwd.trim(), backend, model: model || null, effort: effort || null, system_prompt: systemPrompt.trim() || null, cursor_permission_mode: backend === 'cursor' ? 'default' as const : null }
      const session = mode === 'resume' ? await window.agentsDock.sessions.resume({ ...input, providerId: providerId.trim() }) : await window.agentsDock.sessions.create(input)
      if (mode === 'newChat') {
        trackEvent('chat_created')
        await saveNewChatDefaults(preferenceScope, input).catch(() => undefined)
      }
      await useAppStore.getState().refreshSessions(); useAppStore.getState().setModal(mode, false); await useAppStore.getState().selectSession(session.id)
    } catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  const modelOptions = runtimeCatalogOptions(catalog, backend, 'models', model)
  const effortOptions = runtimeEffortOptions(catalog, backend, model, effort)
  const hasReasoning = backend !== 'cursor' && effortOptions.some(option => Boolean(option.value))
  const selectModel = (value: string) => {
    setModel(value)
    setEffort(runtimeEffortAfterModelChange(catalog, backend, value || null, effort) || '')
  }
  const runtimeError = runtimeSelectionError(health, catalog, backend, model)
  const cursorAvailable = cursorBackendAvailable(health, catalog)
  const cursorUnavailableReason = cursorBackendUnavailableReason(health, catalog)
  const resumeDescription = backend === 'cursor'
    ? 'Continue an existing Cursor provider session. Earlier provider messages stay in Cursor and are not imported into this timeline.'
    : 'Import a rough transcript and continue from an existing Claude or Codex provider session.'
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal(mode, value)} title={mode === 'newChat' ? t("ui.Dialogs.SessionDialog.new_chat_db18382") : t("ui.Dialogs.SessionDialog.resume_a_provider_session_424066b")} description={mode === 'resume' ? resumeDescription : t("ui.Dialogs.SessionDialog.choose_the_workspace_and_runtime_for_this__0b9283f")}>
    <form onSubmit={submit} className="dialog-form two-column-form">
      {importSupported && <button type="button" className="import-chats-entry span-two" onClick={() => { const store = useAppStore.getState(); store.setModal(mode, false); store.setModal('importChats', true) }}>
        <Import size={16} aria-hidden="true" />
        <span className="import-chats-entry-copy"><strong>{t("ui.Dialogs.SessionDialog.import_an_existing_chat_from_your_computer_d8901ee")}</strong><small>{mode === 'resume' ? t("ui.Dialogs.SessionDialog.pick_from_your_local_claude_code_codex_his_15e10b3") : t("ui.Dialogs.SessionDialog.bring_in_your_local_claude_code_codex_hist_9108394")}</small></span>
        <ArrowRight size={14} aria-hidden="true" />
      </button>}
      {mode === 'resume' && <label className="span-two"><span>{backendOptions.includes('cursor') ? t("ui.Dialogs.SessionDialog.claude_session_codex_thread_or_cursor_sess_d3b661c") : t("ui.Dialogs.SessionDialog.claude_session_or_codex_thread_id_55530f4")}</span><input value={providerId} onChange={event => setProviderId(event.target.value)} placeholder={t("ui.Dialogs.SessionDialog.session_id_cb9ac5c")} required /></label>}
      <label className="span-two"><span>{t("ui.Dialogs.SessionDialog.chat_name_09c3e4c")}</span><input value={title} onChange={event => setTitle(event.target.value)} autoFocus /></label>
      <label><span>{t("ui.Dialogs.SessionDialog.folder_74ccd43")}</span><input value={folder} onChange={event => setFolder(event.target.value)} list="folder-list" /><datalist id="folder-list">{folders.map(item => <option key={item}>{item}</option>)}</datalist></label>
      <WorkingDirectoryInput value={cwd} onChange={setCwd} defaultCwd={defaultCwd} available={directoryCompletionAvailable} showBrowseButton />
      <fieldset className="span-two"><legend>{t("ui.Dialogs.SessionDialog.backend_2fb4019")}</legend><div className="segmented">{backendOptions.map(value => {
        const unavailable = value === 'cursor' && !cursorAvailable
        return <button type="button" className={backend === value ? 'active' : ''} key={value} aria-pressed={backend === value} title={unavailable ? cursorUnavailableReason ?? undefined : undefined} onClick={() => { setBackend(value); setModel(''); setEffort('') }}><BackendMark backend={value} size={16} />{backendLabel(value)}{unavailable ? t("ui.Dialogs.unavailable_77649d6") : ''}</button>
      })}</div></fieldset>
      <label className={hasReasoning ? undefined : 'span-two'}><span>{t("ui.Dialogs.SessionDialog.model_5e2c614")}</span><select value={model} onChange={event => selectModel(event.target.value)}>{modelOptions.map(option => <option value={option.value} key={option.value || 'default'} disabled={option.locked} title={option.locked ? option.locked_reason ?? undefined : undefined}>{option.label}{option.locked ? t("ui.Dialogs.upgrade_required_d38f0e0") : ''}</option>)}</select></label>
      {hasReasoning && <label><span>Reasoning</span><select value={effort} onChange={event => setEffort(event.target.value)}>{effortOptions.map(option => <option value={option.value} key={option.value || 'default'}>{option.label}</option>)}</select></label>}
      {runtimeError && <small className="span-two schedule-validation error" role="alert">{runtimeError}</small>}
      <label className="span-two"><span>{t("ui.Dialogs.SessionDialog.system_prompt_561257c")}</span><textarea rows={4} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder={t("ui.Dialogs.SessionDialog.optional_per_chat_instructions_454671b")} /></label>
      <footer className="span-two"><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal(mode, false)}>{t("ui.Dialogs.SessionDialog.cancel_19766ed")}</button><button className="primary-button" disabled={saving || Boolean(runtimeError) || mode === 'resume' && !providerId.trim()}>{saving && <LoaderCircle className="spin" size={14} />}{mode === 'newChat' ? t("ui.Dialogs.SessionDialog.create_chat_35e51d6") : t("ui.Dialogs.SessionDialog.resume_chat_790e1b9")}</button></footer>
    </form>
  </Shell>
}

interface ImportDialogScope {
  activeProfileId: string | null
  profileGeneration: number
  serverIdentity: string | null
}

function currentImportDialogScope(origin: ImportDialogScope, epoch: number, currentEpoch: number): boolean {
  if (epoch !== currentEpoch) return false
  const state = useAppStore.getState()
  const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
  return state.modals.importChats
    && state.activeProfileId === origin.activeProfileId
    && state.profileGeneration === origin.profileGeneration
    && serverIdentity === origin.serverIdentity
}

function currentImportDialogRequest(origin: ImportDialogScope, epoch: number, currentEpoch: number): boolean {
  return currentImportDialogScope(origin, epoch, currentEpoch)
    && localSessionImportSupported(useAppStore.getState().health)
}

function importDialogRequestContextKey(state: ReturnType<typeof useAppStore.getState>): string {
  const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
  return JSON.stringify([
    state.modals.importChats,
    localSessionImportSupported(state.health),
    state.activeProfileId,
    state.profileGeneration,
    serverIdentity
  ])
}

function importFolderName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() || cwd
}

interface ResumeByIdMatch {
  key: string
  kind: 'existing' | 'candidate'
  backend: Backend
  providerId: string
  label: string
  cwd: string | null
  sessionId?: string
}

function sessionProviderIds(session: Session): string[] {
  return [session.session_id, session.claude_session_id, session.codex_thread_id, session.cursor_session_id]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
}

export function ImportChatsDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.importChats)
  const health = useAppStore(state => state.health)
  const sessions = useAppStore(state => state.sessions)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const supported = localSessionImportSupported(health)
  const dialogScope = useMemo(() => ({ activeProfileId, profileGeneration, serverIdentity }), [activeProfileId, profileGeneration, serverIdentity])
  const requestEpoch = useRef(0)
  const activeOperationEpoch = useRef<number | null>(null)
  const requestContextKey = useRef(importDialogRequestContextKey(useAppStore.getState()))
  const [candidates, setCandidates] = useState<LocalSessionCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [results, setResults] = useState<BulkImportSessionResult[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [resumeId, setResumeId] = useState('')
  const [resumeBackend, setResumeBackend] = useState<Backend>('codex')
  const [resumeCwd, setResumeCwd] = useState('')
  const [resumeNeedsDetails, setResumeNeedsDetails] = useState(false)
  const [resumeNeedsChoice, setResumeNeedsChoice] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumingById, setResumingById] = useState(false)

  useEffect(() => useAppStore.subscribe(state => {
    const next = importDialogRequestContextKey(state)
    if (next === requestContextKey.current) return
    requestContextKey.current = next
    requestEpoch.current += 1
  }), [])

  useEffect(() => {
    const epoch = ++requestEpoch.current
    activeOperationEpoch.current = null
    setSelected(new Set())
    setResults([])
    setLoadError(null)
    setCandidates([])
    setImporting(false)
    setLoading(false)
    setCollapsed(new Set())
    setResumeId('')
    setResumeNeedsDetails(false)
    setResumeNeedsChoice(false)
    setResumeError(null)
    setResumingById(false)
    if (!open) return () => { requestEpoch.current += 1 }
    const state = useAppStore.getState()
    const seed = state.sessions.find(session => session.id === state.selectedSessionId && !session.archived)
    const availableBackends = selectableChatBackends(state.health, state.runtimeCatalog)
    setResumeBackend(seed && availableBackends.includes(seed.backend) ? seed.backend : availableBackends.includes('codex') ? 'codex' : availableBackends[0] ?? 'codex')
    setResumeCwd(seed?.cwd?.trim() || state.health?.default_cwd?.trim() || '')
    if (!supported) {
      setLoadError('Import Chat requires AgentsServer API 15 with local session import support.')
      return () => { requestEpoch.current += 1 }
    }
    setLoading(true)
    window.agentsDock.sessions.listLocal()
      .then(list => {
        if (currentImportDialogRequest(dialogScope, epoch, requestEpoch.current)) setCandidates(list)
      })
      .catch((error: unknown) => {
        if (currentImportDialogRequest(dialogScope, epoch, requestEpoch.current)) setLoadError(message(error))
      })
      .finally(() => {
        if (currentImportDialogRequest(dialogScope, epoch, requestEpoch.current)) setLoading(false)
      })
    return () => { requestEpoch.current += 1 }
  }, [dialogScope, open, supported])

  const toggle = (key: string) => {
    if (activeOperationEpoch.current !== null) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const resultFor = (candidate: LocalSessionCandidate) => results.find(result => (
    result.provider_session_id === candidate.provider_session_id && result.backend === candidate.backend
  ))

  const resumeMatches = useMemo<ResumeByIdMatch[]>(() => {
    const providerId = resumeId.trim()
    if (!providerId) return []
    const exactSession = sessions.find(session => session.id === providerId)
    if (exactSession) return [{
      key: `existing:${exactSession.id}`,
      kind: 'existing',
      backend: exactSession.backend,
      providerId,
      label: exactSession.title,
      cwd: exactSession.cwd ?? null,
      sessionId: exactSession.id
    }]
    const matches: ResumeByIdMatch[] = sessions
      .filter(session => sessionProviderIds(session).includes(providerId))
      .map(session => ({
        key: `existing:${session.id}`,
        kind: 'existing',
        backend: session.backend,
        providerId,
        label: session.title,
        cwd: session.cwd ?? null,
        sessionId: session.id
      }))
    const existingKeys = new Set(matches.map(match => localSessionImportKey(match.backend, match.providerId)))
    for (const candidate of candidates) {
      const key = localSessionImportKey(candidate.backend, candidate.provider_session_id)
      if (candidate.provider_session_id !== providerId || existingKeys.has(key)) continue
      matches.push({
        key: `candidate:${key}`,
        kind: 'candidate',
        backend: candidate.backend,
        providerId,
        label: candidate.label,
        cwd: candidate.cwd
      })
    }
    return matches
  }, [candidates, resumeId, sessions])

  // Local Claude/Codex transcripts have no AgentsDock "folder"; their only
  // folder-like grouping is the working directory (cwd) the session ran in,
  // which is exactly how Claude Code lays them out on disk. Group by cwd,
  // preserving the updated_at ordering so the most recent project leads.
  const groups = useMemo(() => {
    const byCwd = new Map<string, { cwd: string | null; items: LocalSessionCandidate[] }>()
    for (const candidate of candidates) {
      const key = candidate.cwd ?? '\0'
      const existing = byCwd.get(key)
      if (existing) existing.items.push(candidate)
      else byCwd.set(key, { cwd: candidate.cwd, items: [candidate] })
    }
    return [...byCwd.values()]
  }, [candidates])
  // Show the folder headers whenever at least one real working directory is
  // present, so the "we sorted these into folders" structure is obvious even
  // when everything happens to sit in one project.
  const showGroupHeaders = groups.some(group => group.cwd)
  const folderCount = groups.filter(group => group.cwd).length

  // Collapse folders by default so the folder structure is the first thing
  // users see — they expand the ones they want. Only when there are real
  // folders to expand (a flat, folderless list must stay visible).
  useEffect(() => {
    if (!candidates.some(candidate => candidate.cwd)) return
    setCollapsed(new Set(candidates.map(candidate => candidate.cwd ?? '__none__')))
  }, [candidates])

  const submit = async () => {
    if (activeOperationEpoch.current !== null) return
    const items: BulkImportSessionItem[] = candidates
      .filter(candidate => selected.has(localSessionImportKey(candidate.backend, candidate.provider_session_id)))
      .map(candidate => ({ provider_session_id: candidate.provider_session_id, backend: candidate.backend, cwd: candidate.cwd }))
    if (!items.length) return
    const epoch = ++requestEpoch.current
    const origin = dialogScope
    if (!currentImportDialogRequest(origin, epoch, requestEpoch.current)) return
    activeOperationEpoch.current = epoch
    setImporting(true)
    try {
      const outcome = await window.agentsDock.sessions.bulkImport(items)
      if (!currentImportDialogRequest(origin, epoch, requestEpoch.current)) return
      setResults(outcome)
      if (outcome.some(result => result.ok)) trackEvent('chats_bulk_imported', { success: true })
      if (outcome.every(result => result.ok)) {
        setImporting(false)
        useAppStore.getState().setModal('importChats', false)
      } else {
        const importedKeys = new Set(outcome.filter(result => result.ok).map(result => localSessionImportKey(result.backend, result.provider_session_id)))
        try {
          const refreshed = await window.agentsDock.sessions.listLocal()
          if (!currentImportDialogRequest(origin, epoch, requestEpoch.current)) return
          const remaining = refreshed.filter(candidate => !importedKeys.has(localSessionImportKey(candidate.backend, candidate.provider_session_id)))
          const retryableKeys = new Set(remaining.map(candidate => localSessionImportKey(candidate.backend, candidate.provider_session_id)))
          setCandidates(remaining)
          setResults(outcome.filter(result => result.code !== 'client_status_unknown' || !retryableKeys.has(localSessionImportKey(result.backend, result.provider_session_id))))
        } catch {
          if (!currentImportDialogRequest(origin, epoch, requestEpoch.current)) return
          setCandidates(prev => prev.filter(candidate => !importedKeys.has(localSessionImportKey(candidate.backend, candidate.provider_session_id))))
        }
        if (!currentImportDialogRequest(origin, epoch, requestEpoch.current)) return
        setSelected(new Set())
      }
    } catch (error) {
      if (currentImportDialogRequest(origin, epoch, requestEpoch.current)) useAppStore.getState().setError(message(error))
    } finally {
      if (currentImportDialogRequest(origin, epoch, requestEpoch.current)) setImporting(false)
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
    }
  }

  const finishResumeById = async (sessionId: string, origin: ImportDialogScope, epoch: number) => {
    await useAppStore.getState().refreshSessions()
    if (!currentImportDialogScope(origin, epoch, requestEpoch.current)) return
    setResumingById(false)
    useAppStore.getState().setModal('importChats', false)
    await useAppStore.getState().selectSession(sessionId)
  }

  const resumeMatch = async (match: ResumeByIdMatch) => {
    if (activeOperationEpoch.current !== null) return
    const epoch = ++requestEpoch.current
    const origin = dialogScope
    if (!currentImportDialogScope(origin, epoch, requestEpoch.current)) return
    activeOperationEpoch.current = epoch
    setResumeError(null)
    setResumingById(true)
    try {
      if (match.kind === 'existing' && match.sessionId) {
        setResumingById(false)
        useAppStore.getState().setModal('importChats', false)
        await useAppStore.getState().selectSession(match.sessionId)
        return
      }
      const outcome = await window.agentsDock.sessions.bulkImport([{
        provider_session_id: match.providerId,
        backend: match.backend,
        cwd: match.cwd
      }])
      if (!currentImportDialogScope(origin, epoch, requestEpoch.current)) return
      const result = outcome[0]
      if (!result?.ok || !result.session_id) throw new Error(result?.error || 'The selected provider session could not be resumed.')
      trackEvent('chats_bulk_imported', { success: true })
      await finishResumeById(result.session_id, origin, epoch)
    } catch (error) {
      if (currentImportDialogScope(origin, epoch, requestEpoch.current)) setResumeError(message(error))
    } finally {
      if (currentImportDialogScope(origin, epoch, requestEpoch.current)) setResumingById(false)
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
    }
  }

  const submitResumeById = async (event: FormEvent) => {
    event.preventDefault()
    const providerId = resumeId.trim()
    if (!providerId || activeOperationEpoch.current !== null) return
    setResumeError(null)
    if (resumeMatches.length === 1) {
      await resumeMatch(resumeMatches[0])
      return
    }
    if (resumeMatches.length > 1) {
      setResumeNeedsChoice(true)
      setResumeNeedsDetails(false)
      return
    }
    if (!resumeNeedsDetails) {
      setResumeNeedsDetails(true)
      setResumeNeedsChoice(false)
      return
    }
    const state = useAppStore.getState()
    const runtimeError = runtimeSelectionError(state.health, state.runtimeCatalog, resumeBackend, null)
    if (runtimeError) {
      setResumeError(runtimeError)
      return
    }
    const epoch = ++requestEpoch.current
    const origin = dialogScope
    if (!currentImportDialogScope(origin, epoch, requestEpoch.current)) return
    activeOperationEpoch.current = epoch
    setResumingById(true)
    try {
      const seed = state.sessions.find(session => session.id === selectedSessionId && !session.archived)
      const session = await window.agentsDock.sessions.resume({
        title: `Resumed ${backendLabel(resumeBackend)} ${providerId.slice(0, 8)}`,
        folder: seed?.folder?.trim() || 'General',
        cwd: resumeCwd.trim() || state.health?.default_cwd?.trim() || '',
        backend: resumeBackend,
        model: null,
        effort: null,
        system_prompt: null,
        cursor_permission_mode: resumeBackend === 'cursor' ? 'default' : null,
        providerId
      })
      if (!currentImportDialogScope(origin, epoch, requestEpoch.current)) return
      await finishResumeById(session.id, origin, epoch)
    } catch (error) {
      if (currentImportDialogScope(origin, epoch, requestEpoch.current)) setResumeError(message(error))
    } finally {
      if (currentImportDialogScope(origin, epoch, requestEpoch.current)) setResumingById(false)
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
    }
  }

  const operationBusy = importing || resumingById

  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('importChats', value)} title={t("ui.Dialogs.ImportChatsDialog.import_chat_ed32942")} description={t("ui.Dialogs.ImportChatsDialog.bring_in_your_local_claude_code_and_codex__0ffcba9")}>
    <div className="dialog-form import-chats-dialog">
      <form className="import-chats-resume" onSubmit={event => void submitResumeById(event)}>
        <div className="import-chats-resume-heading">
          <KeyRound size={15} aria-hidden="true" />
          <span><strong>{t("ui.Dialogs.ImportChatsDialog.resume_by_session_id_33d3af1")}</strong><small>{t("ui.Dialogs.ImportChatsDialog.detected_chats_reuse_their_original_agent__ba332c1")}</small></span>
        </div>
        <div className="import-chats-resume-controls">
          <input
            value={resumeId}
            disabled={operationBusy}
            onChange={event => {
              setResumeId(event.target.value)
              setResumeNeedsDetails(false)
              setResumeNeedsChoice(false)
              setResumeError(null)
            }}
            aria-label={t("ui.Dialogs.ImportChatsDialog.session_id_cb9ac5c")}
            placeholder={t("ui.Dialogs.ImportChatsDialog.paste_a_claude_codex_or_cursor_session_id_70d374e")}
            maxLength={256}
          />
          <button type="submit" className="primary-button" disabled={!resumeId.trim() || operationBusy || loading}>
            {resumingById && <LoaderCircle className="spin" size={13} />}
            {resumingById ? t("ui.Dialogs.ImportChatsDialog.resuming_c494e3c") : t("ui.Dialogs.ImportChatsDialog.resume_d640c74")}
          </button>
        </div>
        {resumeNeedsChoice && resumeMatches.length > 1 && <div className="import-chats-resume-matches" role="group" aria-label={t("ui.Dialogs.ImportChatsDialog.matching_sessions_467df30")}>
          <small>{t("ui.Dialogs.ImportChatsDialog.choose_the_matching_agent_b4392a9")}</small>
          {resumeMatches.map(match => <button type="button" key={match.key} disabled={operationBusy} onClick={() => void resumeMatch(match)}>
            <BackendMark backend={match.backend} size={14} />
            <span><strong>{backendLabel(match.backend)} · {match.label}</strong><small>{match.kind === 'existing' ? t("ui.Dialogs.already_in_agentsdock_0094bb3") : match.cwd || t("ui.Dialogs.default_working_directory_6a5868b")}</small></span>
            <ArrowRight size={13} aria-hidden="true" />
          </button>)}
        </div>}
        {resumeNeedsDetails && resumeMatches.length === 0 && <div className="import-chats-resume-details">
          <small>{t("ui.Dialogs.ImportChatsDialog.this_id_was_not_found_in_local_history_con_dca866c")}</small>
          <label><span>Agent</span><select aria-label="Agent" value={resumeBackend} disabled={operationBusy} onChange={event => setResumeBackend(event.target.value as Backend)}>{selectableChatBackends(health, useAppStore.getState().runtimeCatalog).map(backend => <option value={backend} key={backend}>{backendLabel(backend)}</option>)}</select></label>
          <label><span>{t("ui.Dialogs.ImportChatsDialog.working_directory_865e85c")}</span><input aria-label={t("ui.Dialogs.ImportChatsDialog.working_directory_865e85c")} value={resumeCwd} disabled={operationBusy} onChange={event => setResumeCwd(event.target.value)} placeholder={health?.default_cwd || '/path/to/project'} /></label>
        </div>}
        {resumeError && <small className="import-chats-resume-error" role="alert">{resumeError}</small>}
      </form>
      <div className="import-chats-resume-heading"><Import size={15} aria-hidden="true" /><strong>{t('ui.import.localHistory')}</strong></div>
      {loading && <p className="import-chats-status"><LoaderCircle className="spin" size={14} />{" "}{t("ui.Dialogs.ImportChatsDialog.scanning_local_chat_history_9b94771")}</p>}
      {!loading && loadError && <p className="import-chats-status" role="alert">{loadError}</p>}
      {!loading && !loadError && candidates.length === 0 && <p className="import-chats-status">{t("ui.Dialogs.ImportChatsDialog.no_un_imported_local_chats_found_93e16e7")}</p>}
      {!loading && !loadError && candidates.length > 0 && <>
        <div className="import-chats-toolbar">
          <span>{showGroupHeaders
            ? t('ui.import.groupedCounts', { count: candidates.length, chats: candidates.length === 1 ? 'chat' : 'chats', folders: folderCount, folderLabel: folderCount === 1 ? 'folder' : 'folders', selected: selected.size })
            : t('ui.import.selectedCounts', { selected: selected.size, count: candidates.length })}</span>
          <div>
            {showGroupHeaders && groups.length > 1 && <button type="button" className="quiet-button" disabled={operationBusy} onClick={() => setCollapsed(prev => prev.size ? new Set() : new Set(groups.map(group => group.cwd ?? '__none__')))}>{collapsed.size ? t("ui.Dialogs.ImportChatsDialog.expand_all_a3e586b") : t("ui.Dialogs.ImportChatsDialog.collapse_all_25f7b37")}</button>}
            <button type="button" className="quiet-button" disabled={operationBusy} onClick={() => setSelected(new Set(candidates
              .filter(candidate => resultFor(candidate)?.code !== 'client_status_unknown')
              .map(candidate => localSessionImportKey(candidate.backend, candidate.provider_session_id))))}>{t("ui.Dialogs.ImportChatsDialog.select_all_1fc9a38")}</button>
            <button type="button" className="quiet-button" disabled={operationBusy} onClick={() => setSelected(new Set())}>{t("ui.Dialogs.ImportChatsDialog.select_none_41afe0e")}</button>
          </div>
        </div>
        <div className="import-chats-groups">
          {groups.map(group => {
            const groupKey = group.cwd ?? '__none__'
            const isCollapsed = collapsed.has(groupKey)
            const groupSelected = group.items.filter(candidate => selected.has(localSessionImportKey(candidate.backend, candidate.provider_session_id))).length
            const groupSelectable = group.items.filter(candidate => resultFor(candidate)?.code !== 'client_status_unknown')
            const allSelected = groupSelectable.length > 0 && groupSelectable.every(candidate => selected.has(localSessionImportKey(candidate.backend, candidate.provider_session_id)))
            return <div className={`import-chats-group${isCollapsed ? ' collapsed' : ''}`} key={groupKey}>
              {showGroupHeaders && <div className="import-chats-group-header">
                <button type="button" className="import-chats-group-title" aria-expanded={!isCollapsed} onClick={() => setCollapsed(prev => { const next = new Set(prev); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next })}>
                  {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  <FolderOpen size={13} aria-hidden="true" />
                  <span className="import-chats-group-name" title={group.cwd ?? undefined}>{group.cwd ? importFolderName(group.cwd) : t("ui.Dialogs.other_f97e9da")}</span>
                  <span className="import-chats-group-count">{groupSelected ? `${groupSelected}/` : ''}{group.items.length}</span>
                </button>
                <button type="button" className="import-chats-group-toggle" disabled={importing || resumingById || groupSelectable.length === 0} onClick={() => setSelected(prev => {
                  const next = new Set(prev)
                  for (const candidate of groupSelectable) {
                    const key = localSessionImportKey(candidate.backend, candidate.provider_session_id)
                    if (allSelected) next.delete(key); else next.add(key)
                  }
                  return next
                })}>{allSelected ? t("ui.Dialogs.deselect_142174c") : t("ui.Dialogs.select_2a78025")}</button>
              </div>}
              {!isCollapsed && <ul className="import-chats-list">
                {group.items.map(candidate => {
                  const key = localSessionImportKey(candidate.backend, candidate.provider_session_id)
                  const result = resultFor(candidate)
                  const retryBlocked = result?.code === 'client_status_unknown'
                  return <li key={key} className="import-chats-item">
                    <label>
                      <input type="checkbox" checked={selected.has(key)} disabled={operationBusy || retryBlocked} onChange={() => toggle(key)} />
                      <BackendMark backend={candidate.backend} size={14} />
                      <span className="import-chats-item-copy">
                        <strong>{candidate.label}</strong>
                        <small>{formatTime(candidate.updated_at)}</small>
                      </span>
                    </label>
                    {result && (result.ok
                      ? <span className="import-chats-item-result ok"><Check size={13} /></span>
                      : <span className="import-chats-item-result error" title={result.error}><CircleAlert size={13} /></span>)}
                  </li>
                })}
              </ul>}
            </div>
          })}
        </div>
      </>}
      <footer className="span-two">
        <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('importChats', false)}>{t("ui.Dialogs.ImportChatsDialog.close_7d9eb7a")}</button>
        <button type="button" className="primary-button" disabled={operationBusy || selected.size === 0} onClick={() => void submit()}>
          {importing && <LoaderCircle className="spin" size={14} />}
          {importing ? t("ui.Dialogs.ImportChatsDialog.importing_c01c432") : selected.size ? t('mergeDialogs.import.count', { count: selected.size }) : t('mergeDialogs.import.action')}
        </button>
      </footer>
    </div>
  </Shell>
}

export function SearchDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.search)
  const sessions = useAppStore(state => state.sessions)
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const [query, setQuery] = useState('')
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])
  const searchWasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !searchWasOpenRef.current) trackEvent('search_opened')
    searchWasOpenRef.current = open
  }, [open])
  const historySearch = useSessionHistorySearch(query)
  const profileSearch = useProfileSearch(query)
  const historyResults = useMemo(() => historyResultsBySession(historySearch.results), [historySearch.results])
  const filtered = useMemo(() => {
    const currentProfile = profiles.find(profile => profile.id === activeProfileId)
    const cached = new Map(profileSearch.results.map(result => [`${result.profileId}\u0000${result.session.id}`, result]))
    const current = rankSessionsForSearch(sessions, query, new Set(historyResults.keys())).map(session => {
      const global = activeProfileId ? cached.get(`${activeProfileId}\u0000${session.id}`) : undefined
      return {
        key: `${activeProfileId ?? 'active'}\u0000${session.id}`,
        profileId: activeProfileId,
        profileName: currentProfile?.name ?? 'Current server',
        serverIdentity: currentProfile?.serverIdentity ?? null,
        session,
        match: sessionNameMatchRank(session, query) == null ? historyResults.get(session.id) ?? global?.history : undefined
      }
    })
    const seen = new Set(current.map(result => result.key))
    const additional = profileSearch.results.flatMap(result => {
      const key = `${result.profileId}\u0000${result.session.id}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ key, profileId: result.profileId, profileName: result.profileName, serverIdentity: result.serverIdentity ?? null, session: result.session, match: result.history }]
    })
    return [...current, ...additional].slice(0, 18)
  }, [activeProfileId, historyResults, profileSearch.results, profiles, query, sessions, getLocale()])
  const selectedIndex = Math.max(0, selectedResultKey ? filtered.findIndex(result => result.key === selectedResultKey) : 0)
  useEffect(() => { if (open) { setQuery(''); setSelectedResultKey(null) } }, [open])
  useEffect(() => {
    const focusSearch = () => {
      if (open) searchInputRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('agentsdock:focus-chat-switcher', focusSearch)
    return () => window.removeEventListener('agentsdock:focus-chat-switcher', focusSearch)
  }, [open])
  useEffect(() => {
    if (!filtered.length) { setSelectedResultKey(null); return }
    if (!selectedResultKey || !filtered.some(result => result.key === selectedResultKey)) setSelectedResultKey(filtered[0].key)
  }, [filtered, selectedResultKey])
  useEffect(() => {
    resultRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])
  const openSession = (result: (typeof filtered)[number]) => {
    void (async () => {
      try {
        const state = useAppStore.getState()
        const target = result.profileId ? state.profiles.find(profile => profile.id === result.profileId) : null
        const crossProfile = Boolean(result.profileId && result.profileId !== state.activeProfileId)
        const startingIdentity = target?.serverIdentity ?? null
        if (result.profileId && (crossProfile && !target || target && (target.serverIdentity ?? null) !== result.serverIdentity)) {
          throw new Error(`The identity for “${result.profileName}” changed after this search result was loaded. Search again before opening it.`)
        }
        if (result.profileId && result.profileId !== state.activeProfileId && !await state.switchServer(result.profileId)) {
          throw new Error(`Could not switch to ${result.profileName}. The cached chat was not opened.`)
        }
        if (useAppStore.getState().switchingProfileId || crossProfile && startingIdentity == null) await waitForWorkspaceReady()
        const current = useAppStore.getState()
        const currentTarget = result.profileId ? current.profiles.find(profile => profile.id === result.profileId) : null
        const currentIdentity = currentTarget?.serverIdentity ?? null
        const adoptedCanonicalIdentity = result.serverIdentity == null && startingIdentity == null && currentIdentity != null
        const identityChanged = Boolean(currentTarget && currentIdentity !== result.serverIdentity && !adoptedCanonicalIdentity)
        if (result.profileId && (current.activeProfileId !== result.profileId || crossProfile && !currentTarget || current.switchingProfileId || identityChanged)) {
          throw new Error(`Could not safely open the cached result from ${result.profileName}. Search again and retry.`)
        }
        if (!current.sessions.some(session => session.id === result.session.id)) {
          throw new Error(`That chat is no longer available in ${result.profileName}.`)
        }
        if (!await openSessionHistoryResult(result.session.id, result.match)) {
          throw new Error(`The server workspace changed before “${result.session.title}” could be opened.`)
        }
        useAppStore.getState().setModal('search', false)
      } catch (error) {
        useAppStore.getState().setError(message(error))
      }
    })()
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('search', value)} title={t("ui.Dialogs.SearchDialog.search_chats_02a39c4")} className="command-dialog">
    <label className="command-search">{historySearch.loading || profileSearch.loading ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}<input ref={searchInputRef} autoFocus role="combobox" aria-autocomplete="list" aria-controls="command-search-results" aria-activedescendant={filtered.length ? `command-search-option-${selectedIndex}` : undefined} aria-expanded={open} value={query} onChange={event => { setQuery(event.target.value); setSelectedResultKey(null) }} onKeyDown={event => {
      if (!filtered.length) return
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedResultKey(filtered[(selectedIndex + 1) % filtered.length].key) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedResultKey(filtered[(selectedIndex - 1 + filtered.length) % filtered.length].key) }
      else if (event.key === 'Home') { event.preventDefault(); setSelectedResultKey(filtered[0].key) }
      else if (event.key === 'End') { event.preventDefault(); setSelectedResultKey(filtered.at(-1)!.key) }
      else if (event.key === 'Enter') { event.preventDefault(); openSession(filtered[selectedIndex] ?? filtered[0]) }
    }} placeholder={t("ui.Dialogs.SearchDialog.search_chats_and_projects_efc21e5")} /></label>
    <div className="command-results" id="command-search-results" role="listbox" aria-label={t("ui.Dialogs.SearchDialog.chats_and_message_matches_9a4e17e")}>{filtered.map((result, index) => {
      const otherProfile = Boolean(result.profileId && result.profileId !== activeProfileId)
      return <button ref={element => { resultRefs.current[index] = element }} id={`command-search-option-${index}`} role="option" aria-selected={index === selectedIndex} className={index === selectedIndex ? 'selected' : ''} key={result.key} onMouseEnter={() => setSelectedResultKey(result.key)} onPointerDown={event => { if (event.button === 0) { setSelectedResultKey(result.key); event.currentTarget.setPointerCapture?.(event.pointerId) } }} onClick={() => openSession(result)}><BackendMark backend={result.session.backend} size={18} /><span><strong>{result.session.title}{otherProfile && <em>{result.profileName}</em>}</strong><small>{result.session.folder || 'General'}{otherProfile ? ` · ${result.profileName}` : ` · ${runtimeLabel(result.session, useAppStore.getState().runtimeCatalog)}`}</small>{result.match && <small className="history-match">{result.match.snippet}</small>}</span></button>
    })}{!filtered.length && <p>{historySearch.loading || profileSearch.loading ? t("ui.Dialogs.SearchDialog.searching_cached_servers_8073967") : t("ui.Dialogs.SearchDialog.no_matching_chats_5e89d87")}</p>}</div>
    <div className="command-hint"><ShortcutKey shortcut="findChat" />{" "}{t("ui.Dialogs.SearchDialog.searches_selects_return_opens_control_tab__d5cdf92")}</div>
  </Shell>
}

export function DigestDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.digest)
  const sessions = useAppStore(state => state.sessions)
  const sourceId = useAppStore(state => state.selectedSessionId)
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('normal')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [targetQuery, setTargetQuery] = useState('')
  const [phase, setPhase] = useState<'idle' | 'preview' | 'send'>('idle')
  const [status, setStatus] = useState('')
  const folderOrder = useAppStore(state => state.folderOrder)
  const source = sessions.find(session => session.id === sourceId) ?? null
  const allSections = useMemo(() => digestTargetSections(sessions, folderOrder, sourceId), [folderOrder, sessions, sourceId, getLocale()])
  const allChoices = useMemo(() => allSections.flatMap(section => section.sessions), [allSections])
  const targetSections = useMemo(
    () => digestTargetSections(sessions, folderOrder, sourceId, targetQuery),
    [folderOrder, sessions, sourceId, targetQuery, getLocale()]
  )
  const resolvedTarget = allChoices.some(session => session.id === target) ? target : allChoices[0]?.id ?? ''
  const targetSession = allChoices.find(session => session.id === resolvedTarget) ?? null
  const busy = phase !== 'idle'
  const digestWasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !digestWasOpenRef.current) trackEvent('digest_opened')
    digestWasOpenRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    setDetail('normal')
    setPrompt('')
    setPreview('')
    setTargetQuery('')
    setStatus('')
    setPhase('idle')
  }, [open, sourceId])

  useEffect(() => {
    if (!open) return
    if (!allChoices.some(session => session.id === target)) setTarget(allChoices[0]?.id ?? '')
  }, [allChoices, open, target])

  const previewDigest = async () => {
    if (!sourceId || !resolvedTarget) return
    setPhase('preview'); setStatus(t("ui.Dialogs.previewDigest.summarizing_source_chat_with_the_llm_e19f273"))
    try {
      const result = await window.agentsDock.digest.preview({ sourceSessionId: sourceId, targetSessionId: resolvedTarget, detail, userPrompt: prompt.trim() })
      setPreview(result)
      setStatus(t("ui.Dialogs.previewDigest.character_preview_86d4394", { "count": String(result.length.toLocaleString()) }))
    } catch (error) {
      setStatus(message(error))
    } finally {
      setPhase('idle')
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!sourceId || !resolvedTarget) return
    setPhase('send'); setStatus(t("ui.Dialogs.submit.starting_digest_in_the_source_chat_c6fc56d"))
    try {
      const accepted = await window.agentsDock.digest.send({ sourceSessionId: sourceId, targetSessionId: resolvedTarget, detail, userPrompt: prompt.trim() })
      if (!accepted) throw new Error('The server did not accept the digest request.')
      useAppStore.getState().setModal('digest', false)
    } catch (error) {
      setStatus(message(error))
    } finally {
      setPhase('idle')
    }
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('digest', value)} title={t("ui.Dialogs.DigestDialog.create_context_digest_b30ae4d")} description={t("ui.Dialogs.DigestDialog.the_source_chat_agent_creates_one_focused__22208de")} className="digest-dialog">
    <form onSubmit={submit} className="dialog-form digest-form">
      <section className="digest-route" aria-label={t("ui.Dialogs.DigestDialog.digest_route_1d434d4")}>
        <div className="digest-route-chat source"><small>{t("ui.Dialogs.DigestDialog.source_0e570ca")}</small><span><BackendMark backend={source?.backend || 'codex'} size={18} /><strong>{source?.title || t("ui.Dialogs.DigestDialog.no_source_chat_988609d")}</strong></span><em>{source ? runtimeLabel(source, useAppStore.getState().runtimeCatalog) : t("ui.Dialogs.DigestDialog.select_a_chat_first_780f37f")}</em></div>
        <ArrowRight size={18} />
        <div className={`digest-route-chat target ${targetSession ? 'selected' : ''}`}><small>{t("ui.Dialogs.DigestDialog.target_978354d")}</small><span>{targetSession ? <BackendMark backend={targetSession.backend} size={18} /> : <GitFork size={18} />}<strong>{targetSession?.title || t("ui.Dialogs.DigestDialog.choose_a_chat_71a5855")}</strong></span><em>{targetSession ? `${targetSession.folder || 'General'} · ${runtimeLabel(targetSession, useAppStore.getState().runtimeCatalog)}` : t("ui.Dialogs.DigestDialog.no_active_target_available_4159b4c")}</em></div>
      </section>

      <div className="digest-workspace">
        <section className="digest-target-browser">
          <header><strong>{t("ui.Dialogs.DigestDialog.target_chat_2968cca")}</strong><small>{allChoices.length}{" "}{t("ui.Dialogs.DigestDialog.available_ddd9818")}</small></header>
          <label className="digest-target-search"><Search size={14} /><input value={targetQuery} onChange={event => setTargetQuery(event.target.value)} placeholder={t("ui.Dialogs.DigestDialog.filter_chats_a7edc4b")} aria-label={t("ui.Dialogs.DigestDialog.filter_target_chats_ff2b27b")} /></label>
          <div className="digest-target-list" role="listbox" aria-label={t("ui.Dialogs.DigestDialog.digest_target_chat_e4c5827")}>
            {targetSections.map(section => <section key={section.id}><h3>{section.title}</h3>{section.sessions.map(session => <button type="button" role="option" aria-selected={resolvedTarget === session.id} className={resolvedTarget === session.id ? 'selected' : ''} key={session.id} onClick={() => setTarget(session.id)}><BackendMark backend={session.backend} size={17} /><span><strong>{session.title}</strong><small>{runtimeLabel(session, useAppStore.getState().runtimeCatalog)}</small></span>{resolvedTarget === session.id && <Check size={15} />}</button>)}</section>)}
            {!targetSections.length && <p>{t("ui.Dialogs.DigestDialog.no_matching_active_chats_4b0e386")}</p>}
          </div>
        </section>

        <section className="digest-builder">
          <fieldset className="digest-detail"><legend>{t("ui.Dialogs.DigestDialog.detail_fb5f27d")}</legend><div className="segmented">{[
            ['short', t("ui.Dialogs.DigestDialog.short_f5d61ea")], ['normal', t("ui.Dialogs.DigestDialog.normal_a7248ee")], ['deep', t("ui.Dialogs.DigestDialog.deep_c54e362")]
          ].map(([value, label]) => <button type="button" className={detail === value ? 'active' : ''} key={value} onClick={() => { setDetail(value); setPreview(''); setStatus('') }}>{label}</button>)}</div></fieldset>
          <label><span>{t("ui.Dialogs.DigestDialog.prompt_for_target_agent_2a56d9c")}</span><textarea value={prompt} onChange={event => { setPrompt(event.target.value); if (preview) setStatus('Prompt changed · refresh preview before sending') }} rows={5} placeholder={t("ui.Dialogs.DigestDialog.what_should_the_target_agent_focus_on_1deceef")} /></label>
          <section className={`digest-preview ${preview ? 'has-content' : ''}`}>
            <header><span><FileText size={14} /><strong>{t("ui.Dialogs.DigestDialog.preview_324b134")}</strong></span>{preview && <small>{t('ui.digest.characters', { count: preview.length.toLocaleString(getLocale()) })}</small>}</header>
            {preview ? <pre>{preview}</pre> : <div className="digest-preview-empty"><Sparkles size={22} /><strong>{t("ui.Dialogs.DigestDialog.no_preview_yet_67e6061")}</strong><span>{t("ui.Dialogs.DigestDialog.preview_runs_the_llm_without_sending_the_h_067f0e5")}</span></div>}
          </section>
        </section>
      </div>

      <footer className="digest-footer">
        <div className={`digest-status ${status && !busy && !preview ? 'error' : ''}`}>{busy && <LoaderCircle className="spin" size={14} />}<span>{status || t("ui.Dialogs.DigestDialog.ready_5fa7aac")}</span></div>
        <span className="dialog-spacer" />
        <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('digest', false)}>{t("ui.Dialogs.DigestDialog.cancel_19766ed")}</button>
        <button type="button" className="quiet-button" disabled={busy || !sourceId || !resolvedTarget} onClick={() => void previewDigest()}>{phase === 'preview' && <LoaderCircle className="spin" size={14} />}{" "}{t("ui.Dialogs.DigestDialog.preview_324b134")}</button>
        <button className="primary-button" disabled={!sourceId || !resolvedTarget || busy}>{phase === 'send' && <LoaderCircle className="spin" size={14} />}{" "}{t("ui.Dialogs.DigestDialog.send_to_chat_6798b9b")}</button>
      </footer>
    </form>
  </Shell>
}

function scheduledJobChatReferencesAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.scheduled_jobs
  return capability?.available === true
    && Number(capability.version ?? 1) >= 3
    && capability.features?.chat_references === true
}

function scheduledJobChatReferenceActionAvailable(
  health: Health | null | undefined,
  action: ChatReferenceAction
): boolean {
  if (action !== 'route' || !scheduledJobChatReferencesAvailable(health)) return false
  const capability = health?.capabilities?.scheduled_jobs
  return routeHintMentionsAvailable(health)
    && Number(capability?.version ?? 1) >= 5
    && capability?.features?.route_hint_mentions === true
}

function scheduledJobMentionActionsAvailable(health: Health | null | undefined): boolean {
  return scheduledJobChatReferenceActionAvailable(health, 'route')
}

const MAX_SCHEDULED_CHAT_REFERENCES = 16
const MAX_SCHEDULED_CHAT_REFERENCES_MESSAGE = 'Maximum 16 chats can be selected for a scheduled job.'

function sameServerScheduledChatReferences(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId: string
): ChatReference[] {
  return validChatReferences(text, references, sourceSessionId)
    .filter(reference => reference.target_kind !== 'secure_peer')
    // A scheduled job owns an independent exact route grant. Never carry the
    // ordinary composer's durable source-chat grant intent into job storage.
    .map(reference => {
      const scheduledReference = { ...reference }
      delete scheduledReference.grant_intent
      return scheduledReference
    })
    .slice(0, MAX_SCHEDULED_CHAT_REFERENCES)
}

function canonicalScheduledReferences(
  text: string,
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[],
  sourceSessionId: string
): { text: string; chatReferences: ChatReference[]; teamReferences: TeamReference[] } {
  const valid = validComposerReferences(
    text,
    sameServerScheduledChatReferences(text, chatReferences, sourceSessionId),
    teamReferences,
    (value, candidates) => validChatReferences(value, candidates, sourceSessionId)
  )
  const canonical = canonicalizeLocalRouteHints(text, valid.chatReferences, sourceSessionId)
  const shiftedTeamReferences = reconcileTeamReferences(text, canonical.text, valid.teamReferences)
  const final = validComposerReferences(
    canonical.text,
    canonical.references,
    shiftedTeamReferences,
    (value, candidates) => sameServerScheduledChatReferences(value, candidates, sourceSessionId)
  )
  return {
    text: canonical.text,
    chatReferences: final.chatReferences,
    teamReferences: final.teamReferences
  }
}

function JobPromptEditor({
  sourceSession,
  health,
  sessions,
  folderOrder,
  chatSupported,
  teamSupported,
  value,
  chatReferences,
  teamReferences,
  onChange,
  onPaletteOpenChange
}: {
  sourceSession: Session
  health: Health | null | undefined
  sessions: Session[]
  folderOrder: string[]
  chatSupported: boolean
  teamSupported: boolean
  value: string
  chatReferences: ChatReference[]
  teamReferences: TeamReference[]
  onChange: (value: string, chatReferences: ChatReference[], teamReferences: TeamReference[]) => void
  onPaletteOpenChange: (open: boolean) => void
}) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const [mention, setMention] = useState<ChatMentionTrigger | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [teamMention, setTeamMention] = useState<TeamMentionTrigger | null>(null)
  const [teamMentionCandidates, setTeamMentionCandidates] = useState<TeamMentionCandidate[]>([])
  const [teamMentionIndex, setTeamMentionIndex] = useState(0)
  const selectedSameServerCount = chatReferences.filter(reference => reference.target_kind !== 'secure_peer').length
  const maximumChatsSelected = selectedSameServerCount >= MAX_SCHEDULED_CHAT_REFERENCES
  const supportedBackends = supportedCrossChatTargetBackends(health)
  const routeHintsSupported = chatSupported && scheduledJobChatReferenceActionAvailable(health, 'route')
  const candidates = useMemo(() => {
    if (!mention || !chatSupported) return []
    const active = orderedActiveSessions(sessions, folderOrder).filter(candidate => (
      candidate.id !== sourceSession.id
      && !candidate.archived
      && supportedBackends.includes(candidate.backend)
    ))
    return rankSessionsForSearch(active, mention.query, new Set())
  }, [chatSupported, folderOrder, mention, sessions, sourceSession.id, supportedBackends])

  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, Math.max(0, candidates.length - 1))))
  }, [candidates.length])

  useEffect(() => () => onPaletteOpenChange(false), [onPaletteOpenChange])

  useEffect(() => {
    if (!mention && !teamMention) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && editorRef.current?.contains(target)) return
      setMention(null)
      setTeamMention(null)
      setTeamMentionCandidates([])
      onPaletteOpenChange(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [mention, onPaletteOpenChange, teamMention])

  useLayoutEffect(() => {
    syncJobPromptEditorScroll(textareaRef.current, mirrorRef.current)
  }, [chatReferences, teamReferences, value])

  const closeMentions = () => {
    setMention(null)
    setTeamMention(null)
    setTeamMentionCandidates([])
    onPaletteOpenChange(false)
  }
  const openMentionAt = (
    text: string,
    caret: number,
    currentChatReferences: ChatReference[],
    currentTeamReferences: TeamReference[]
  ) => {
    // @@ is a distinct authority namespace and must win before the @Chat parser.
    const nextTeamMention = teamSupported
      ? teamMentionTrigger(text, caret, currentChatReferences, currentTeamReferences)
      : null
    const nextMention = nextTeamMention || !routeHintsSupported
      ? null
      : chatMentionTrigger(text, caret, currentChatReferences)
    setTeamMention(nextTeamMention)
    setTeamMentionCandidates([])
    setTeamMentionIndex(0)
    setMention(nextMention)
    onPaletteOpenChange(Boolean(nextTeamMention || nextMention))
    setSelectedIndex(0)
  }

  const updateText = (nextValue: string, caret: number) => {
    const nextReferences = validComposerReferences(
      nextValue,
      reconcileChatReferences(value, nextValue, chatReferences),
      reconcileTeamReferences(value, nextValue, teamReferences),
      (text, references) => validChatReferences(text, references, sourceSession.id)
    )
    onChange(nextValue, nextReferences.chatReferences, nextReferences.teamReferences)
    openMentionAt(nextValue, caret, nextReferences.chatReferences, nextReferences.teamReferences)
  }
  const chooseTarget = (target: Session) => {
    if (!mention || !routeHintsSupported) return
    const action: ChatReferenceAction = 'route'
    if (!scheduledJobChatReferenceActionAvailable(health, action)) {
      useAppStore.getState().setError('Update AgentsServer to use @Chat route hints in scheduled jobs.')
      closeMentions()
      return
    }
    if (chatReferences.some(reference => reference.session_id === target.id && reference.action === action)) {
      useAppStore.getState().setError(`A route hint for ${target.title} is already selected.`)
      closeMentions()
      return
    }
    if (maximumChatsSelected) {
      useAppStore.getState().setError(MAX_SCHEDULED_CHAT_REFERENCES_MESSAGE)
      return
    }
    let inserted: ReturnType<typeof insertChatReference>
    try {
      inserted = insertChatReference(value, mention, target, action)
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      closeMentions()
      return
    }
    const nextReferences = validComposerReferences(
      inserted.text,
      [...reconcileChatReferences(value, inserted.text, chatReferences), inserted.reference],
      reconcileTeamReferences(value, inserted.text, teamReferences),
      (text, references) => validChatReferences(text, references, sourceSession.id)
    )
    onChange(inserted.text, nextReferences.chatReferences, nextReferences.teamReferences)
    closeMentions()
    setSelectedIndex(0)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const chooseTeamTarget = (candidate: TeamMentionCandidate) => {
    if (!teamMention || !teamSupported) return
    const duplicate = teamReferences.some(reference => (
      reference.kind === candidate.target.kind
      && (candidate.target.kind !== 'recipient'
        || (reference.kind === 'recipient' && reference.recipient_kind === candidate.target.recipient_kind))
      && reference.team_id === candidate.target.team_id
      && reference.target_id === candidate.target.target_id
    ))
    if (duplicate) {
      useAppStore.getState().setError(`${candidate.label} is already selected.`)
      closeMentions()
      return
    }
    try {
      const inserted = insertTeamReference(value, teamMention, candidate.target)
      const nextReferences = validComposerReferences(
        inserted.text,
        reconcileChatReferences(value, inserted.text, chatReferences),
        [...reconcileTeamReferences(value, inserted.text, teamReferences), inserted.reference],
        (text, references) => validChatReferences(text, references, sourceSession.id)
      )
      onChange(inserted.text, nextReferences.chatReferences, nextReferences.teamReferences)
      closeMentions()
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
      })
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      closeMentions()
    }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
      const edit = atomicComposerReferenceDeletion(
        value,
        orderedComposerReferenceSpans(chatReferences, teamReferences),
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        event.key
      )
      if (edit) {
        event.preventDefault()
        updateText(edit.text, edit.caret)
        window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(edit.caret, edit.caret))
        return
      }
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const start = event.currentTarget.selectionStart ?? 0
      const end = event.currentTarget.selectionEnd ?? start
      if (start === end) {
        const caret = atomicComposerReferenceNavigation(
          start,
          orderedComposerReferenceSpans(chatReferences, teamReferences),
          event.key
        )
        if (caret !== null) {
          event.preventDefault()
          event.currentTarget.setSelectionRange(caret, caret)
          return
        }
      }
    }
    if (teamMention) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMentions()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        if (teamMentionCandidates.length) setTeamMentionIndex(index => (
          index + direction + teamMentionCandidates.length
        ) % teamMentionCandidates.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const candidate = teamMentionCandidates[teamMentionIndex]
        if (candidate) chooseTeamTarget(candidate)
        return
      }
    }
    if (!mention) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMentions()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSelectedIndex(index => candidates.length ? (index + direction + candidates.length) % candidates.length : 0)
      return
    }
    if (event.key === 'Tab' && maximumChatsSelected) return
    if ((event.key === 'Enter' || event.key === 'Tab') && candidates[selectedIndex]) {
      event.preventDefault()
      chooseTarget(candidates[selectedIndex])
    }
  }
  const referenceSupported = (reference: ChatReference) => {
    const target = sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      routeHintsSupported
      && currentRouteHintReference(value, reference)
      && target
      && !target.archived
      && supportedBackends.includes(target.backend)
    )
  }

  return <div ref={editorRef} className="job-prompt-editor">
    <label><span>Prompt</span><div className="job-reference-editor">
      <JobPromptMirror
        ref={mirrorRef}
        text={value}
        chatReferences={chatReferences}
        teamReferences={teamReferences}
        referenceSupported={referenceSupported}
        teamReferencesSupported={teamSupported}
      />
      <textarea
        ref={textareaRef}
        aria-label="Prompt"
        rows={10}
        value={value}
        onChange={event => updateText(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onKeyDown={handleKeyDown}
        onFocus={event => openMentionAt(value, event.currentTarget.selectionStart ?? value.length, chatReferences, teamReferences)}
        onClick={event => {
          const rawCaret = event.currentTarget.selectionStart ?? value.length
          const caret = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ? atomicComposerReferenceCaret(rawCaret, orderedComposerReferenceSpans(chatReferences, teamReferences))
            : rawCaret
          if (caret !== rawCaret) event.currentTarget.setSelectionRange(caret, caret)
          openMentionAt(value, caret, chatReferences, teamReferences)
        }}
        onBlur={closeMentions}
        onScroll={event => syncJobPromptEditorScroll(event.currentTarget, mirrorRef.current)}
        aria-autocomplete="list"
        aria-expanded={Boolean(teamMention || mention)}
        aria-controls={teamMention ? 'job-team-mention-palette' : mention ? 'job-chat-mention-palette' : undefined}
        aria-activedescendant={teamMention && teamMentionCandidates[teamMentionIndex]
          ? `job-team-mention-palette-${teamMentionCandidates[teamMentionIndex].id}`
          : mention && candidates[selectedIndex]
            ? `job-chat-target-${selectedIndex}`
            : undefined}
        required
      />
    </div></label>
    {teamMention && <TeamMentionPalette
      id="job-team-mention-palette"
      sourceSessionId={sourceSession.id}
      mention={teamMention}
      selectedIndex={teamMentionIndex}
      supported={teamSupported}
      profileId={activeProfileId}
      profileGeneration={profileGeneration}
      serverIdentity={serverIdentity}
      onCandidates={setTeamMentionCandidates}
      onHighlight={setTeamMentionIndex}
      onSelect={chooseTeamTarget}
    />}
    {mention && <div id="job-chat-mention-palette" className="chat-mention-palette job-chat-mention-palette" role="listbox" aria-label={t("ui.Dialogs.JobPromptEditor.scheduled_job_chats_6d03bc7")}>
      {maximumChatsSelected && <div className="chat-mention-empty" role="status"><span><strong>{t("ui.Dialogs.JobPromptEditor.maximum_16_chats_daacd7c")}</strong><small>{t("ui.Dialogs.JobPromptEditor.remove_a_scheduled_target_before_selecting_c81f62b")}</small></span></div>}
      {candidates.length
        ? candidates.map((candidate, index) => <button
          id={`job-chat-target-${index}`}
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          disabled={maximumChatsSelected}
          className={index === selectedIndex ? 'selected' : ''}
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => setSelectedIndex(index)}
          onClick={() => chooseTarget(candidate)}
        ><BackendMark backend={candidate.backend} size={15} /><span><strong>{candidate.title}</strong><small>{candidate.folder || 'General'} · {backendLabel(candidate.backend)}</small></span><code>{candidate.id.slice(-8)}</code></button>)
        : <div className="chat-mention-empty"><span><strong>{t("ui.Dialogs.JobPromptEditor.no_matching_chats_27e7713")}</strong><small>{t("ui.Dialogs.JobPromptEditor.try_a_title_folder_or_session_id_50d6f13")}</small></span></div>}
    </div>}
    <small className="job-chat-target-hint">
      {routeHintsSupported
        ? t("ui.Dialogs.JobPromptEditor.chat_gives_the_scheduled_agent_that_route__1146d61")
        : t("ui.Dialogs.JobPromptEditor.update_agentsserver_to_add_scheduled_chat__01e862a")}
      {' '}
      {teamSupported
        ? t('teamNetwork.reference.scheduledHint')
        : t('teamNetwork.reference.updateScheduled')}
    </small>
  </div>
}

const JobPromptMirror = forwardRef<HTMLDivElement, {
  text: string
  chatReferences: readonly ChatReference[]
  teamReferences: readonly TeamReference[]
  referenceSupported: (reference: ChatReference) => boolean
  teamReferencesSupported: boolean
}>(function JobPromptMirror({ text, chatReferences, teamReferences, referenceSupported, teamReferencesSupported }, ref) {
  useLocale()
  const valid = validComposerReferences(
    text,
    chatReferences,
    teamReferences,
    (value, references) => validChatReferences(value, references)
  )
  const entries = [
    ...valid.chatReferences.map(reference => ({ kind: 'chat' as const, reference })),
    ...valid.teamReferences.map(reference => ({ kind: 'team' as const, reference }))
  ].sort((left, right) => left.reference.source_text_start - right.reference.source_text_start)
  const content: ReactNode[] = []
  let offset = 0
  for (const entry of entries) {
    const { reference } = entry
    if (reference.source_text_start > offset) content.push(text.slice(offset, reference.source_text_start))
    content.push(<span
      key={entry.kind === 'chat'
        ? `chat:${entry.reference.session_id}:${reference.source_text_start}:${entry.reference.action}`
        : `team:${entry.reference.team_id}:${entry.reference.target_id}:${reference.source_text_start}`}
      className={entry.kind === 'chat'
        ? `composer-inline-reference action-${entry.reference.action}${referenceSupported(entry.reference) ? '' : ' unsupported'}`
        : `composer-inline-reference action-route team-reference${teamReferencesSupported ? '' : ' unsupported'}`}
      data-team-reference-kind={entry.kind === 'team' ? entry.reference.kind : undefined}
      title={entry.kind === 'chat'
        ? `${chatReferenceDisplayText(text, entry.reference)} · ${entry.reference.action === 'route' ? 'Route hint' : 'Legacy reference'}`
        : `${teamReferenceText(entry.reference)} · ${scheduledTeamReferenceLabel(entry.reference)}`}
    >{text.slice(reference.source_text_start, reference.source_text_end)}</span>)
    offset = reference.source_text_end
  }
  if (offset < text.length) content.push(text.slice(offset))
  return <div ref={ref} className="job-reference-editor-mirror" aria-hidden="true">{content}</div>
})

function scheduledTeamReferenceLabel(reference: TeamReference): string {
  if (reference.kind === 'skill') return t('teamNetwork.reference.skill')
  if (reference.recipient_kind === 'all') return t('teamNetwork.bulletin')
  if (reference.recipient_kind === 'all_servers') return t('teamNetwork.reference.allInboxes')
  return t(reference.recipient_kind === 'server' ? 'teamNetwork.reference.server' : 'teamNetwork.reference.member')
}

function syncJobPromptEditorScroll(textarea: HTMLTextAreaElement | null, mirror: HTMLDivElement | null): void {
  if (!textarea || !mirror) return
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
}

type JobStartMode = 'keep' | 'immediate' | 'interval' | 'time'

export function JobDialog() {
  useLocale()
  const open = useAppStore(state => state.modals.job)
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const supportedContextModes = useAppStore(state => state.health?.capabilities?.scheduled_jobs?.context_modes)
  const [editing, setEditing] = useState<Job | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [chatReferences, setChatReferences] = useState<ChatReference[]>([])
  const [teamReferences, setTeamReferences] = useState<TeamReference[]>([])
  const [interval, setIntervalValue] = useState(3600)
  const [scheduleKind, setScheduleKind] = useState<JobScheduleKind>('interval')
  const [cronExpression, setCronExpression] = useState('0 * * * *')
  const [rrule, setRRule] = useState('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [startMode, setStartMode] = useState<JobStartMode>('interval')
  const [firstRun, setFirstRun] = useState('')
  const [loop, setLoop] = useState(true)
  const [maxRuns, setMaxRuns] = useState(1)
  const [enabled, setEnabled] = useState(true)
  const [contextMode, setContextMode] = useState<JobContextMode>('chat')
  const [backend, setBackend] = useState<Backend>('codex')
  const [promptPaletteOpen, setPromptPaletteOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const timezones = useMemo(supportedTimezones, [])
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) trackEvent('job_schedule_opened')
    wasOpenRef.current = open
  }, [open])
  const supportsIndependentRuns = supportedContextModes?.includes('standalone') === true || editing?.context_mode === 'standalone'
  const preservesChatReferences = scheduledJobChatReferencesAvailable(health)
    || Boolean(editing?.chat_references?.length)
    || chatReferences.length > 0
  const preservesTeamReferences = teamMessagesAvailable(health)
    || Boolean(editing?.team_references?.length)
    || teamReferences.length > 0
  const availableBackends = selectableChatBackends(health, catalog)
  const cursorUnavailableReason = cursorBackendUnavailableReason(health, catalog)
  const selectableBackends: Backend[] = contextMode === 'standalone'
    ? availableBackends.includes(backend) ? availableBackends : [...availableBackends, backend]
    : [session?.backend ?? backend]
  useEffect(() => {
    const edit = (event: Event) => { const job = (event as CustomEvent<Job>).detail; setEditing(job); fill(job); useAppStore.getState().setModal('job', true) }
    window.addEventListener('agentsdock:edit-job', edit)
    return () => window.removeEventListener('agentsdock:edit-job', edit)
  }, [])
  useEffect(() => {
    if (!open || editing) return
    setTitle('')
    const state = useAppStore.getState()
    const draft = session ? state.drafts[session.id] ?? '' : ''
    const initial = session
      ? canonicalScheduledReferences(
        draft,
        scheduledJobChatReferencesAvailable(state.health) ? state.chatReferencesBySession[session.id] ?? [] : [],
        teamMessagesAvailable(state.health) ? state.teamReferencesBySession[session.id] ?? [] : [],
        session.id
      )
      : { text: draft, chatReferences: [], teamReferences: [] }
    setPrompt(initial.text)
    setChatReferences(initial.chatReferences)
    setTeamReferences(initial.teamReferences)
    setIntervalValue(3600)
    setScheduleKind('interval')
    setCronExpression('0 * * * *')
    setRRule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    setStartMode('interval')
    setFirstRun('')
    setLoop(true)
    setMaxRuns(1)
    setEnabled(true)
    setContextMode('chat')
    setBackend(session?.backend ?? 'codex')
  }, [open, editing, session?.id])
  const fill = (job: Job) => {
    const parentBackend = useAppStore.getState().sessions.find(candidate => candidate.id === job.session_id)?.backend ?? 'codex'
    setTitle(job.title)
    const initial = canonicalScheduledReferences(
      job.prompt,
      parseStoredChatReferences(job.chat_references, job.prompt, job.session_id),
      parseStoredTeamReferences(job.team_references, job.prompt),
      job.session_id
    )
    setPrompt(initial.text)
    setChatReferences(initial.chatReferences)
    setTeamReferences(initial.teamReferences)
    setIntervalValue(job.interval_seconds || 3600)
    setScheduleKind(effectiveScheduleKind(job))
    setCronExpression(job.cron_expression || '0 * * * *')
    setRRule(job.rrule || 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
    setTimezone(job.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    const kind = effectiveScheduleKind(job)
    setFirstRun(formatScheduleWallTime(job.next_run_at_iso || job.next_run_at, kind, job.timezone))
    setStartMode('keep')
    setLoop(jobLoopsForever(job))
    setMaxRuns(job.max_runs || 1)
    setEnabled(job.enabled !== false)
    const jobContextMode = job.context_mode ?? 'chat'
    setContextMode(jobContextMode)
    setBackend(jobContextMode === 'standalone' ? (job.backend || parentBackend) : parentBackend)
  }
  const selectStartMode = (value: JobStartMode) => {
    setStartMode(value)
    if (value === 'time' && !parseScheduleWallTime(firstRun, scheduleKind)) {
      const defaultRun = new Date(Date.now() + 5 * 60 * 1000)
      defaultRun.setSeconds(0, 0)
      setFirstRun(formatScheduleWallTime(defaultRun.toISOString(), scheduleKind, timezone))
    }
    if (value !== 'keep') setEnabled(true)
  }
  const selectContextMode = (value: JobContextMode) => {
    setContextMode(value)
    if (value === 'chat' && session) setBackend(session.backend)
  }
  const close = () => { setPromptPaletteOpen(false); setEditing(null); useAppStore.getState().setModal('job', false) }
  const scheduleError = validateJobSchedule(scheduleKind, { intervalSeconds: interval, cronExpression, rrule, timezone })
  const nextRunError = startMode === 'time' && !parseScheduleWallTime(firstRun, scheduleKind)
    ? 'Choose a valid date and time.'
    : editing && startMode !== 'keep' && !enabled
      ? 'Enable the job to change its next run.'
      : !editing && (startMode === 'time' || startMode === 'immediate') && !enabled
        ? 'Enable the job to use an exact first run time.'
        : null
  const selectedBackend = contextMode === 'chat' ? session?.backend ?? backend : backend
  const runtimeError = runtimeSelectionError(
    health,
    catalog,
    selectedBackend,
    selectedBackend === session?.backend ? session?.model : null
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!session || scheduleError || nextRunError) return; setSaving(true)
    const cleanInterval = Math.max(10, Number.isFinite(interval) ? interval : 3600)
    const nextInterval = scheduleKind === 'interval' ? cleanInterval : null
    const nextCron = scheduleKind === 'cron' ? cronExpression.trim() : null
    const nextRRule = scheduleKind === 'rrule' ? rrule.trim() : null
    const nextTimezone = scheduleKind === 'interval' ? null : timezone.trim()
    const scheduledTime = startMode === 'immediate' ? new Date().toISOString() : startMode === 'time' ? parseScheduleWallTime(firstRun, scheduleKind) : null
    const currentState = useAppStore.getState()
    const currentSession = currentState.sessions.find(candidate => candidate.id === session.id)
    if (!currentSession) {
      currentState.setError('The chat for this scheduled job is no longer available.')
      setSaving(false)
      return
    }
    const selectedBackend = contextMode === 'chat' ? currentSession.backend : backend
    const currentRuntimeError = runtimeSelectionError(
      currentState.health,
      currentState.runtimeCatalog,
      selectedBackend,
      selectedBackend === currentSession.backend ? currentSession.model : null
    )
    if (enabled && currentRuntimeError) {
      currentState.setError(currentRuntimeError)
      setSaving(false)
      return
    }
    const leadingWhitespace = prompt.length - prompt.trimStart().length
    const cleanPrompt = prompt.trim()
    const sameServerChatReferences = chatReferences.filter(reference => reference.target_kind !== 'secure_peer')
    if (preservesChatReferences && sameServerChatReferences.length > MAX_SCHEDULED_CHAT_REFERENCES) {
      useAppStore.getState().setError(MAX_SCHEDULED_CHAT_REFERENCES_MESSAGE)
      setSaving(false)
      return
    }
    if (sameServerChatReferences.length > 0 && !scheduledJobChatReferenceActionAvailable(currentState.health, 'route')) {
      useAppStore.getState().setError('Update AgentsServer before saving scheduled @Chat route hints.')
      setSaving(false)
      return
    }
    if (teamReferences.length > 0 && !teamMessagesAvailable(currentState.health)) {
      useAppStore.getState().setError('Update AgentsServer before saving scheduled @@ Team Network hints.')
      setSaving(false)
      return
    }
    const invalidRouteHint = sameServerChatReferences.find(reference => !currentRouteHintReference(prompt, reference))
    if (invalidRouteHint) {
      useAppStore.getState().setError('Scheduled jobs accept only current @Chat route hints. Remove the legacy reference and select @Chat again.')
      setSaving(false)
      return
    }
    const shiftedChatReferences = sameServerChatReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace
    }))
    const shiftedTeamReferences = teamReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace
    }))
    const normalizedReferences = validComposerReferences(
      cleanPrompt,
      preservesChatReferences
        ? sameServerScheduledChatReferences(cleanPrompt, shiftedChatReferences, session.id)
        : [],
      preservesTeamReferences
        ? validTeamReferences(cleanPrompt, shiftedTeamReferences)
        : [],
      (value, references) => sameServerScheduledChatReferences(value, references, session.id)
    )
    const normalizedChatReferences = normalizedReferences.chatReferences
    const normalizedTeamReferences = normalizedReferences.teamReferences
    if (preservesChatReferences && normalizedChatReferences.length !== sameServerChatReferences.length) {
      useAppStore.getState().setError('A scheduled @Chat route hint was edited. Remove it and select the chat again.')
      setSaving(false)
      return
    }
    if (preservesTeamReferences && normalizedTeamReferences.length !== teamReferences.length) {
      useAppStore.getState().setError('A scheduled @@ Team Network hint was edited. Remove it and select the recipient or skill again.')
      setSaving(false)
      return
    }
    try {
      if (editing) {
        const patch: UpdateJobInput = {}
        if (title.trim() !== editing.title) patch.title = title.trim()
        const promptChanged = cleanPrompt !== editing.prompt
        if (promptChanged) patch.prompt = cleanPrompt
        if (preservesChatReferences) {
          const previousReferences = parseStoredChatReferences(editing.chat_references, editing.prompt, editing.session_id)
          if (promptChanged || JSON.stringify(normalizedChatReferences) !== JSON.stringify(previousReferences)) {
            patch.chat_references = normalizedChatReferences
          }
        }
        if (preservesTeamReferences) {
          const previousReferences = parseStoredTeamReferences(editing.team_references, editing.prompt)
          if (promptChanged || JSON.stringify(normalizedTeamReferences) !== JSON.stringify(previousReferences)) {
            patch.team_references = normalizedTeamReferences
          }
        }
        const scheduleKindChanged = scheduleKind !== effectiveScheduleKind(editing)
        if (scheduleKindChanged) patch.schedule_kind = scheduleKind
        if (nextInterval !== editing.interval_seconds) patch.interval_seconds = nextInterval
        if (nextCron !== (editing.cron_expression ?? null)) patch.cron_expression = nextCron
        if (nextRRule !== (editing.rrule ?? null)) patch.rrule = nextRRule
        const currentTimezone = effectiveScheduleKind(editing) === 'interval' ? null : (editing.timezone ?? null)
        if (nextTimezone !== currentTimezone) patch.timezone = nextTimezone
        if (scheduleKind === 'interval' && (scheduleKindChanged || loop !== Boolean(editing.loop))) patch.loop = loop
        if ((loop ? null : Math.max(1, maxRuns)) !== (editing.max_runs ?? null)) patch.max_runs = loop ? null : Math.max(1, maxRuns)
        if (enabled !== (editing.enabled !== false)) patch.enabled = enabled
        if (supportsIndependentRuns && contextMode !== (editing.context_mode ?? 'chat')) patch.context_mode = contextMode
        if (selectedBackend !== (editing.backend || session.backend)) patch.backend = selectedBackend
        if (startMode === 'immediate' || startMode === 'time') patch.next_run_at = scheduledTime
        else if (startMode === 'interval' && scheduleKind === 'interval') patch.next_run_at = new Date(Date.now() + cleanInterval * 1000).toISOString()
        else if (startMode === 'interval') {
          // Omitted means preserve the current occurrence; explicit null means
          // discard an override and recompute the next cron/RRULE match.
          patch.next_run_at = null
          // Older calendar-capable servers use this as their recompute signal.
          patch.enabled = true
        }
        await window.agentsDock.jobs.update(editing.id, patch)
      } else {
        const input: CreateJobInput = {
          session_id: session.id, title: title.trim(), prompt: cleanPrompt, schedule_kind: scheduleKind,
          ...(preservesChatReferences ? { chat_references: normalizedChatReferences } : {}),
          ...(preservesTeamReferences ? { team_references: normalizedTeamReferences } : {}),
          interval_seconds: nextInterval, cron_expression: nextCron, rrule: nextRRule, timezone: nextTimezone,
          first_run_at: scheduledTime, loop, max_runs: loop ? null : Math.max(1, maxRuns), enabled,
          ...(supportsIndependentRuns ? { context_mode: contextMode } : {}),
          backend: selectedBackend
        }
        await window.agentsDock.jobs.create(input)
      }
      close()
    }
    catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  return <Shell open={open} onOpenChange={value => { if (!value) close() }} onEscapeKeyDown={event => {
    if (promptPaletteOpen) event.preventDefault()
  }} title={editing ? t("ui.Dialogs.JobDialog.edit_scheduled_job_457a92b") : t("ui.Dialogs.JobDialog.schedule_a_job_53f5ca4")} description={t("ui.Dialogs.JobDialog.run_a_prompt_in_this_chat_on_your_schedule_f34b88d")}>
    <form onSubmit={submit} className="dialog-form job-form">
      <label><span>{t("ui.Dialogs.JobDialog.title_7e8cd20")}</span><input value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <fieldset><legend>{t("ui.Dialogs.JobDialog.backend_2fb4019")}</legend><div className="segmented">{selectableBackends.map(value => {
        const unavailable = value === 'cursor' && !cursorBackendAvailable(health, catalog)
        return <button type="button" key={value} className={backend === value ? 'active' : ''} aria-pressed={backend === value} aria-describedby={unavailable ? 'job-cursor-runtime-help' : undefined} disabled={unavailable} title={unavailable ? cursorUnavailableReason ?? undefined : undefined} onClick={() => setBackend(value)}><BackendMark backend={value} size={14} />{backendLabel(value)}{unavailable ? t("ui.Dialogs.unavailable_77649d6") : ''}</button>
      })}</div>{selectableBackends.includes('cursor') && !cursorBackendAvailable(health, catalog) && cursorUnavailableReason
        ? <small id="job-cursor-runtime-help" className="runtime-option-help">{cursorUnavailableReason}</small>
        : null}</fieldset>
      <fieldset className="job-context-fieldset"><legend>{t("ui.Dialogs.JobDialog.run_context_20887b3")}</legend><div className={`job-context-picker${supportsIndependentRuns ? '' : ' single'}`} role="group" aria-label={t("ui.Dialogs.JobDialog.run_context_20887b3")}>
        <button type="button" className={contextMode === 'chat' ? 'active' : ''} aria-pressed={contextMode === 'chat'} onClick={() => selectContextMode('chat')}><strong>{t("ui.Dialogs.JobDialog.continue_in_this_chat_eed3ae3")}</strong><small>{t("ui.Dialogs.JobDialog.use_this_chat_s_existing_context_and_add_e_d7db2e4")}</small></button>
        {supportsIndependentRuns && <button type="button" className={contextMode === 'standalone' ? 'active' : ''} aria-pressed={contextMode === 'standalone'} onClick={() => selectContextMode('standalone')}><strong>{t("ui.Dialogs.JobDialog.independent_runs_3d32d40")}</strong><small>{t('ui.job.independentHelp', { backend: backendLabel(backend) })}</small></button>}
      </div>{!supportsIndependentRuns && <small className="job-context-unavailable">{t("ui.Dialogs.JobDialog.update_agentsserver_to_add_independent_run_6138641")}</small>}</fieldset>
      {runtimeError && <small className="schedule-validation error" role="alert">{runtimeError}{enabled ? t("ui.Dialogs.JobDialog.pause_this_job_or_choose_an_available_runt_1d574aa") : ''}</small>}
      <fieldset className="schedule-builder"><legend>{t("ui.Dialogs.JobDialog.schedule_f4830a1")}</legend><div className="segmented schedule-kind">{(['interval', 'cron', 'rrule'] as JobScheduleKind[]).map(kind => <button type="button" key={kind} className={scheduleKind === kind ? 'active' : ''} aria-pressed={scheduleKind === kind} onClick={() => setScheduleKind(kind)}>{kind === 'rrule' ? 'RRULE' : kind[0].toUpperCase() + kind.slice(1)}</button>)}</div>
        {scheduleKind === 'interval' && <div className="form-row"><label><span>{t("ui.Dialogs.JobDialog.interval_6f45b00")}</span><select value={interval} onChange={event => setIntervalValue(Number(event.target.value))}><option value={60}>{t("ui.Dialogs.JobDialog.1_minute_e67b6f6")}</option><option value={300}>{t("ui.Dialogs.JobDialog.5_minutes_3170543")}</option><option value={900}>{t("ui.Dialogs.JobDialog.15_minutes_2f18bc2")}</option><option value={1800}>{t("ui.Dialogs.JobDialog.30_minutes_f01a042")}</option><option value={3600}>{t("ui.Dialogs.JobDialog.1_hour_f8b8883")}</option><option value={7200}>{t("ui.Dialogs.JobDialog.2_hours_9808e0e")}</option><option value={14400}>{t("ui.Dialogs.JobDialog.4_hours_e5bc992")}</option><option value={28800}>{t("ui.Dialogs.JobDialog.8_hours_1ee36a4")}</option><option value={43200}>{t("ui.Dialogs.JobDialog.12_hours_ff62720")}</option><option value={86400}>{t("ui.Dialogs.JobDialog.24_hours_f0514e8")}</option><option value={604800}>{t("ui.Dialogs.JobDialog.1_week_c8cc522")}</option></select></label><label><span>{t("ui.Dialogs.JobDialog.seconds_381a8e9")}</span><input aria-label={t("ui.Dialogs.JobDialog.interval_seconds_5f0f5b8")} type="number" min={10} value={interval} onChange={event => setIntervalValue(Number(event.target.value))} /></label></div>}
        {scheduleKind === 'cron' && <label><span>{t("ui.Dialogs.JobDialog.cron_expression_9e6e7de")}</span><input aria-label={t("ui.Dialogs.JobDialog.cron_expression_9e6e7de")} className="schedule-expression" value={cronExpression} onChange={event => setCronExpression(event.target.value)} placeholder="0 9 * * 1-5" spellCheck={false} /><small>{t("ui.Dialogs.JobDialog.standard_5_field_unix_cron_optional_6_7_fi_779d620")}</small></label>}
        {scheduleKind === 'rrule' && <label><span>RRULE</span><textarea aria-label="RRULE" className="schedule-expression" rows={3} value={rrule} onChange={event => setRRule(event.target.value)} placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0" spellCheck={false} /><small>{t("ui.Dialogs.JobDialog.rfc_5545_recurrence_rule_rrule_prefix_is_o_6af4e55")}</small></label>}
        {scheduleKind !== 'interval' && <label><span>{t("ui.Dialogs.JobDialog.timezone_4ceca1d")}</span><input aria-label={t("ui.Dialogs.JobDialog.timezone_4ceca1d")} list="job-timezones" value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/Los_Angeles" spellCheck={false} /><datalist id="job-timezones">{timezones.map(zone => <option key={zone} value={zone} />)}</datalist></label>}
        <small className={scheduleError ? 'schedule-validation error' : 'schedule-validation'}>{scheduleError || (scheduleKind === 'interval' ? t("ui.Dialogs.JobDialog.runs_relative_to_the_previous_scheduled_ti_7bacf5f") : t("ui.Dialogs.JobDialog.server_validates_full_syntax_when_you_save_1837506"))}</small>
      </fieldset>
      <fieldset><legend>{editing ? t("ui.Dialogs.JobDialog.next_run_b3c0ab9") : t("ui.Dialogs.JobDialog.first_run_4f35f7e")}</legend><div className="segmented">{editing && <button type="button" className={startMode === 'keep' ? 'active' : ''} onClick={() => selectStartMode('keep')}>{t("ui.Dialogs.JobDialog.keep_current_1c215e3")}</button>}<button type="button" className={startMode === 'immediate' ? 'active' : ''} onClick={() => selectStartMode('immediate')}>{scheduleKind === 'interval' ? 'Now' : t("ui.Dialogs.JobDialog.now_then_schedule_af0bc66")}</button><button type="button" className={startMode === 'interval' ? 'active' : ''} onClick={() => selectStartMode('interval')}>{scheduleKind === 'interval' ? t("ui.Dialogs.JobDialog.after_interval_23bcefd") : t("ui.Dialogs.JobDialog.next_match_825e5ab")}</button><button type="button" className={startMode === 'time' ? 'active' : ''} onClick={() => selectStartMode('time')}>{scheduleKind === 'interval' ? t("ui.Dialogs.JobDialog.at_a_time_d9e68a2") : t("ui.Dialogs.JobDialog.at_a_time_then_schedule_c224828")}</button></div>{startMode === 'time' && <input aria-label={editing ? t("ui.Dialogs.JobDialog.next_run_time_09a9f41") : t("ui.Dialogs.JobDialog.first_run_time_8c872d6")} type="datetime-local" value={firstRun} onChange={event => setFirstRun(event.target.value)} />}{nextRunError && <small className="schedule-validation error" role="alert">{nextRunError}</small>}</fieldset>
      <fieldset><legend>{t("ui.Dialogs.JobDialog.mode_5e23ec6")}</legend><div className="segmented"><button type="button" className={!loop ? 'active' : ''} onClick={() => setLoop(false)}>{scheduleKind === 'interval' ? t("ui.Dialogs.JobDialog.run_fixed_times_60c342d") : t("ui.Dialogs.JobDialog.limit_total_runs_3c85864")}</button><button type="button" className={loop ? 'active' : ''} onClick={() => setLoop(true)}>{scheduleKind === 'interval' ? t("ui.Dialogs.JobDialog.loop_forever_beba352") : t("ui.Dialogs.JobDialog.no_extra_run_limit_706ba59")}</button></div>{!loop && <label className="run-count"><span>{t("ui.Dialogs.JobDialog.runs_848f54e")}</span><input type="number" min={1} max={999} value={maxRuns} onChange={event => setMaxRuns(Number(event.target.value))} /></label>}</fieldset>
      <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t("ui.Dialogs.JobDialog.enabled_92c1cdf")}</label>
      {session && <JobPromptEditor
        sourceSession={session}
        health={health}
        sessions={sessions}
        folderOrder={folderOrder}
        chatSupported={scheduledJobMentionActionsAvailable(health)}
        teamSupported={teamMessagesAvailable(health)}
        value={prompt}
        chatReferences={chatReferences}
        teamReferences={teamReferences}
        onChange={(nextPrompt, nextChatReferences, nextTeamReferences) => {
          setPrompt(nextPrompt)
          setChatReferences(nextChatReferences)
          setTeamReferences(nextTeamReferences)
        }}
        onPaletteOpenChange={setPromptPaletteOpen}
      />}
      <footer><button type="button" className="quiet-button" onClick={close}>{t("ui.Dialogs.JobDialog.cancel_19766ed")}</button><button className="primary-button" disabled={saving || !title.trim() || !prompt.trim() || Boolean(scheduleError) || Boolean(nextRunError) || Boolean(enabled && runtimeError)}>{saving && <LoaderCircle className="spin" size={14} />}{" "}{t("ui.Dialogs.JobDialog.save_job_f4b557c")}</button></footer>
    </form>
  </Shell>
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? t("ui.Dialogs.formatElapsed.m_s_c452161", { "minutes": String(minutes), "seconds": String(String(seconds).padStart(2, '0')) }) : t("ui.Dialogs.formatElapsed.s_5307d20", { "seconds": String(seconds) })
}

function setupPhaseLabel(phase?: ServerSetupProgress['phase']): string {
  switch (phase) {
    case 'connect': return t("ui.Dialogs.setupPhaseLabel.connecting_d403c68")
    case 'download': return t("ui.Dialogs.setupPhaseLabel.downloading_agentsserver_209ea56")
    case 'runtime': return t("ui.Dialogs.setupPhaseLabel.checking_prerequisites_bed2352")
    case 'install': return t("ui.Dialogs.setupPhaseLabel.installing_agentsserver_e99819b")
    case 'service': return t("ui.Dialogs.setupPhaseLabel.starting_the_service_3a368ed")
    case 'health': return t("ui.Dialogs.setupPhaseLabel.checking_server_health_c74b02f")
    case 'diagnostics': return t("ui.Dialogs.setupPhaseLabel.collecting_diagnostics_d13658a")
    case 'complete': return t("ui.Dialogs.setupPhaseLabel.finishing_setup_af7a407")
    default: return t("ui.Dialogs.setupPhaseLabel.preparing_setup_805898a")
  }
}
