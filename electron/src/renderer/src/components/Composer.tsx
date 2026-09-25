// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { isSharedChatCollaborator } from '@shared/chat-shares'
import { useLocale } from '../lib/i18n'
import { forwardRef, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, CheckCircle2, ChevronDown, Columns2, CornerDownRight, File, FolderOpen, Gauge, GitFork, Goal, GripVertical, Import, Info, ListOrdered, LoaderCircle, Mail, MessageSquarePlus, MessageSquareShare, MoreHorizontal, Network, Paperclip, Pencil, Plus, RadioTower, RotateCw, Send, Settings, Shield, Sparkles, Square, Trash2, X } from 'lucide-react'
import { effectiveFileContentType } from '@shared/file-content-type'
import { localSessionImportSupported } from '@shared/local-session-import'
import type { AgentCrossChatRoute, AgentTeamMailRoute, AgentTeamMailRoutesSnapshot, AgentFile, ChatReference, ChatReferenceAction, ClaudePermissionMode, Event as AgentEvent, Health, NativeFileRef, ProviderCommand, ProviderCommandSelection, ProviderCommandsSnapshot, QueuedTurn, RuntimeCatalog, Session, TeamReference } from '@shared/types'
import { teamAllServersAliasAvailable, teamBulletinAliasAvailable, type TeamNetworkServer } from '@shared/team-network'
import { chatBackendChoice, chatBackendSelection, codexCustomProviderAvailable, cursorBackendAvailable, cursorBackendUnavailableReason, runtimeCatalogOptions, runtimeDiagnosticFor, runtimeEffortAfterModelChange, runtimeEffortOptions, runtimeSelectionError, selectableChatBackendChoices } from '@shared/runtime-catalog'
import { trackEvent } from '../lib/analytics'
import { backendLabel, formatBytes, runtimeLabel } from '../lib/format'
import { CodexModelDiscovery } from './CodexModelDiscovery'
import { cancelComposerEditorLayout, composerTextCanUseMirror, observeComposerEditorWidth, scheduleComposerEditorLayout, syncComposerEditorMirror } from '../lib/composer-editor-layout'
import { awaitAllClaudePermissionUpdates, awaitClaudePermissionUpdates } from '../lib/claude-permission-updates'
import { supportedClaudePermissionModes } from '../lib/claude-permission-copy'
import { awaitAllCodexPermissionUpdates, awaitCodexPermissionUpdates } from '../lib/codex-permission-updates'
import { awaitAllCursorPermissionUpdates, awaitCursorPermissionUpdates } from '../lib/cursor-permission-updates'
import { nativeFileRefsFromFiles } from '../lib/native-files'
import { profileSessionKey } from '../lib/profile-scope'
import { orderedActiveSessions, rankSessionsForSearch } from '../lib/sessions'
import {
  assertTeamNetworkExpectedIdentity,
  loadTeamNetworkServers as loadCachedTeamNetworkServers,
  loadTeamNetworkWorkspace,
  peekTeamNetworkOpeningSnapshot,
  peekTeamNetworkServers,
  peekTeamNetworkWorkspace,
  teamNetworkCacheRevision,
  teamNetworkScope,
  teamNetworkSnapshotKey
} from '../lib/team-network-snapshot-cache'
import {
  filterComposerCommands,
  composerCommandTrigger,
  groupComposerCommandsByCategory,
  matchComposerCommands,
  type ComposerCommandCategory,
  type ComposerCommandMetadata,
  type ComposerCommandTrigger
} from '../lib/composer-commands'
import { getWorkspacePreference, setWorkspacePreference } from '../lib/workspace-preferences'
import {
  canonicalizeLocalRouteHints,
  chatMentionTrigger,
  chatReferenceDisplayText,
  chatReferenceLabel,
  currentRouteHintReference,
  exactQueuedDeliverySkipAvailable,
  exactQueuedPeerDeliverySkipAvailable,
  insertChatReference,
  MAX_CHAT_REFERENCES,
  parseStoredChatReferences,
  reconcileChatReferences,
  routeHintMentionsAvailable,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences,
  type ChatMentionTrigger
} from '../lib/chat-references'
import {
  activeInboundDelivery as detectActiveInboundDelivery,
  asyncQueuedMessageControlsAvailable,
  exactQueuedDeliveryReorderAvailable,
  firstBlockingCrossChatDelivery,
  isImmutableQueuedTurn,
  isAsyncAgentQueuedTurn,
  isQueuedDeliveryBarrier,
  isReorderableQueuedTurn,
  isScheduledJobQueuedTurn,
  isSecurePeerDeliveryQueuedTurn,
  isSteeringCancellation,
  isSteeringPending,
  isUserQueuedTurn,
  isVisibleQueuedTurn,
  queuedMoveCrossesCrossChatDelivery,
  queuedTurnCrossChatFence,
  queuedTurnsInPositionOrder,
  steerFirstQueuedTurn,
  steerQueuedTurn,
  subscribeSteeringPending,
  type ActiveInboundDeliveryKind,
  type ActiveInboundDelivery,
  type QueuedTurnCrossChatFence,
  type SteeringScope
} from '../lib/queue-actions'
import {
  atomicComposerReferenceCaret,
  atomicComposerReferenceDeletion,
  atomicComposerReferenceNavigation,
  insertTeamReference,
  orderedComposerReferenceSpans,
  parseStoredTeamReferences,
  reconcileTeamReferences,
  teamMentionTrigger,
  teamMessagesAvailable,
  teamReferenceText,
  validComposerReferences,
  validTeamReferences,
  type TeamMentionTrigger,
  type TeamReferenceTarget
} from '../lib/team-references'
import { interactiveClientCapabilities, useAppStore, type PendingTurnSubmission } from '../store/app-store'
import { useTransientClose } from '../lib/transient-close'
import { openTeamMessageLink } from '../lib/team-message-links'
import { applyTeamMessageComposerEdit, composerDisplayToSource, composerSourceToDisplay, projectTeamMessageComposer, type ComposerMessageLink, type ComposerNativeEditSelection } from '../lib/team-message-composer'
import { BackendMark } from './BackendMark'
import { CodexContextIndicator, CodexGoalBar } from './CodexControls'
import { useCodexRuntime } from './CodexRuntimeContext'
import { ClaudeContextIndicator } from './ClaudeContextIndicator'
import { ClaudePermissionMenu } from './ClaudePermissionMenu'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { ClaudeMcpDialog, claudeMcpCapabilityAdvertised, claudeMcpCapabilitySupported } from './ClaudeMcpDialog'
import { ClaudeGoalControls, useClaudeGoalsAvailable } from './ClaudeGoalControls'
import { CodexPermissionMenu } from './CodexPermissionMenu'
import { CursorPermissionMenu } from './CursorPermissionMenu'
import { OpenCodePermissionMenu } from './OpenCodePermissionMenu'
import { openCodeProviderCommandsAvailable } from '@shared/opencode'
import { opencodeBackendAvailable, opencodeBackendUnavailableReason } from '@shared/runtime-catalog'
import { awaitAllOpenCodePermissionUpdates, awaitOpenCodePermissionUpdates } from '../lib/opencode-permission-updates'
import { RuntimeHealthNotice } from './RuntimeHealth'
import { ShortcutTooltip } from './ShortcutTooltip'
import { WorkingDirectoryInput } from './WorkingDirectoryInput'
import { WorkingDirectoryPopover } from './WorkingDirectoryPopover'

const EMPTY_UPLOADS: AgentFile[] = []
const EMPTY_UPLOAD_PATHS: NativeFileRef[] = []
const EMPTY_QUEUED_TURNS: QueuedTurn[] = []
const EMPTY_EVENTS: AgentEvent[] = []
const EMPTY_CHAT_REFERENCES: ChatReference[] = []
const EMPTY_TEAM_REFERENCES: TeamReference[] = []
const EMPTY_AGENT_ROUTES: AgentCrossChatRoute[] = []
const allServersNativeUpdateRequired = () => t('teamNetwork.mention.allNativeUpdate')

/**
 * Health snapshots also carry volatile activity/queue telemetry. Composer
 * behavior depends only on these contracts, so heartbeat churn must not make
 * the entire input surface render again.
 */
interface ComposerHealthContractRevisions {
  composer: string
  queueShelf: string
}

const EMPTY_COMPOSER_HEALTH_REVISIONS: ComposerHealthContractRevisions = {
  composer: 'no-health',
  queueShelf: 'no-health'
}
const composerHealthContractRevisionCache = new WeakMap<Health, ComposerHealthContractRevisions>()

function composerHealthContractRevisions(health: Health | null): ComposerHealthContractRevisions {
  if (!health) return EMPTY_COMPOSER_HEALTH_REVISIONS
  const cached = composerHealthContractRevisionCache.get(health)
  if (cached) return cached
  const capabilities = health?.capabilities
  const revisions = {
    composer: JSON.stringify([
      health.ok === true,
      health.api_contract_version ?? null,
      health.server_instance_id ?? null,
      capabilities?.cross_chat_handoffs_v1 ?? null,
      capabilities?.agent_team_messages_v1 ?? null,
      capabilities?.team_bulletin_alias_v1 ?? null,
      capabilities?.team_all_servers_alias_v1 ?? null,
      capabilities?.agent_team_mail_v1 ?? null,
      capabilities?.codex_controls ?? null,
      capabilities?.codex_provider_v1 ?? null,
      capabilities?.claude_controls ?? null,
      capabilities?.cursor_backend ?? null,
      capabilities?.opencode_backend ?? null,
      capabilities?.local_provider_commands_v1 ?? null,
      health.runtimes?.opencode ?? null,
      capabilities?.scheduled_jobs ?? null,
      capabilities?.local_session_import_v1 ?? null,
      health.runtimes?.cursor ?? null
    ]),
    queueShelf: JSON.stringify([
      capabilities?.codex_provider_v1 ?? null,
      capabilities?.cross_chat_handoffs_v1 ?? null,
      capabilities?.team_all_servers_alias_v1 ?? null,
      capabilities?.cursor_backend ?? null,
      capabilities?.opencode_backend ?? null,
      health.runtimes?.opencode ?? null,
      health.runtimes?.cursor ?? null
    ])
  }
  composerHealthContractRevisionCache.set(health, revisions)
  return revisions
}

function composerHealthContractRevision(health: Health | null): string {
  return composerHealthContractRevisions(health).composer
}

function queueShelfHealthContractRevision(health: Health | null): string {
  return composerHealthContractRevisions(health).queueShelf
}

function shallowReferenceArraysEqual<T extends ChatReference | TeamReference>(
  current: readonly T[],
  next: readonly T[]
): boolean {
  if (current === next) return true
  if (current.length !== next.length) return false
  return current.every((entry, index) => {
    const candidate = next[index]
    if (entry === candidate) return true
    const entryRecord = entry as unknown as Record<string, unknown>
    const candidateRecord = candidate as unknown as Record<string, unknown>
    const keys = Object.keys(entryRecord)
    return keys.length === Object.keys(candidateRecord).length
      && keys.every(key => entryRecord[key] === candidateRecord[key])
  })
}

/** Publish a persisted composer snapshot as one store transaction. */
function commitComposerSnapshot(
  sessionId: string,
  text: string,
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[]
): void {
  useAppStore.setState(state => {
    const draftChanged = state.drafts[sessionId] !== text
    const chatReferencesChanged = !shallowReferenceArraysEqual(
      state.chatReferencesBySession[sessionId] ?? EMPTY_CHAT_REFERENCES,
      chatReferences
    )
    const teamReferencesChanged = !shallowReferenceArraysEqual(
      state.teamReferencesBySession[sessionId] ?? EMPTY_TEAM_REFERENCES,
      teamReferences
    )
    if (!draftChanged && !chatReferencesChanged && !teamReferencesChanged) return state
    return {
      drafts: draftChanged ? { ...state.drafts, [sessionId]: text } : state.drafts,
      chatReferencesBySession: chatReferencesChanged
        ? { ...state.chatReferencesBySession, [sessionId]: [...chatReferences] }
        : state.chatReferencesBySession,
      teamReferencesBySession: teamReferencesChanged
        ? { ...state.teamReferencesBySession, [sessionId]: [...teamReferences] }
        : state.teamReferencesBySession
    }
  })
}

type ChatMentionCandidate = { kind: 'local'; id: string; session: Session }

const remoteAgentRouteUnavailable = () => t('teamNetwork.mention.remoteRouteUnavailable')

function queuedTurnHasRemoteAgentRoute(turn: Pick<QueuedTurn, 'chat_references'>): boolean {
  return Boolean(turn.chat_references?.some(reference => reference.target_kind === 'secure_peer'))
}

const TEAM_MENTION_TARGET_CACHE_TTL_MS = 30_000
const TEAM_MENTION_TARGET_CACHE_MAX_ENTRIES = 8
const teamMentionTargetCache = new Map<string, { expiresAt: number; candidates: TeamMentionCandidate[] }>()
const teamMentionTargetInFlight = new Map<string, Promise<TeamMentionCandidate[]>>()
const teamMentionLatestByExpected = new Map<string, TeamMentionCandidate[]>()

export interface TeamMentionCandidate {
  id: string
  label: string
  hint?: string
  code: string
  target: TeamReferenceTarget
  /** Authored display copy only; canonical labels and reference data stay unchanged. */
  presentation?: { labelKey?: string; hintKey?: string; params?: { teamName: string } }
}

class TeamMentionUIError extends Error {
  constructor(readonly localeKey: string) { super(t(localeKey)) }
}

interface ProviderComposerCommandDetails {
  command: ProviderCommand
  selection: ProviderCommandSelection
}

interface ComposerCommand extends ComposerCommandMetadata {
  id: string
  provider?: ProviderComposerCommandDetails
  meta?: string
}

const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { id: 'attach', get label() { return t("ui.Composer.copy.attach_files_e697cc1") }, get description() { return t("ui.Composer.copy.choose_files_for_this_message_96040d5") }, keywords: ['upload', 'file'], category: 'agentsdock' },
  { id: 'chat', get label() { return t("ui.Composer.copy.contact_another_chat_45bd9fd") }, get description() { return t("ui.Composer.copy.name_any_chat_this_agent_can_contact_5bca269") }, keywords: ['handoff', 'mention', 'cross-chat', 'route'], category: 'agentsdock' },
  { id: 'digest', get label() { return t("ui.Composer.copy.create_digest_8b04e01") }, get description() { return t("ui.Composer.copy.summarize_this_chat_for_a_handoff_eb96a08") }, keywords: ['handoff', 'summary'], category: 'agentsdock' },
  { id: 'feedback', get label() { return t("ui.Composer.copy.send_feedback_8235980") }, get description() { return t("ui.Composer.copy.open_the_public_agentsdock_issue_form_7cb3c3a") }, keywords: ['issue', 'bug'], category: 'agentsdock' },
  { id: 'goal', get label() { return t("ui.Composer.copy.goal_cdbf697") }, get description() { return t("ui.Composer.copy.set_or_manage_a_persistent_codex_goal_ea4f0b3") }, keywords: ['objective', 'long-running'], category: 'agentsdock' },
  { id: 'mail', get label() { return t('teamNetwork.mention.mailCommand') }, get description() { return t('teamNetwork.mention.mailCommandHint') }, keywords: ['inbox', 'message', 'agent', 'server'], category: 'agentsdock' },
  { id: 'mcp', get label() { return t("ui.Composer.copy.mcp_servers_22a7559") }, get description() { return t("ui.Composer.copy.view_and_control_claude_mcp_connections_ed0b999") }, keywords: ['tools', 'connections', 'servers'], category: 'agentsdock' },
  { id: 'model', get label() { return t("ui.Composer.copy.model_5e2c614") }, get description() { return t("ui.Composer.copy.choose_the_model_for_this_chat_9edb622") }, keywords: ['runtime'], category: 'agentsdock' },
  { id: 'new', get label() { return t("ui.Composer.copy.new_chat_db18382") }, get description() { return t("ui.Composer.copy.create_another_chat_cbc42a6") }, keywords: ['create'], category: 'agentsdock' },
  { id: 'permissions', get label() { return t("ui.Composer.copy.permissions_abccc78") }, get description() { return t("ui.Composer.copy.control_this_provider_s_access_b10033f") }, keywords: ['approval', 'sandbox', 'access'], category: 'agentsdock' },
  { id: 'plan', get label() { return t("ui.Composer.copy.plan_mode_3ca7d84") }, get description() { return t("ui.Composer.copy.open_claude_permissions_to_choose_plan_mod_1e9ad59") }, keywords: ['planning', 'permission'], category: 'agentsdock' },
  { id: 'reasoning', label: 'Reasoning', get description() { return t("ui.Composer.copy.choose_the_reasoning_effort_for_this_chat_248ba75") }, keywords: ['effort', 'thinking'], category: 'agentsdock' },
  { id: 'schedule', get label() { return t("ui.Composer.copy.schedule_f4830a1") }, get description() { return t("ui.Composer.copy.create_a_scheduled_job_for_this_chat_7ad3abb") }, keywords: ['job', 'cron', 'automation'], category: 'agentsdock' },
  { id: 'settings', get label() { return t("ui.Composer.copy.settings_74a883a") }, get description() { return t("ui.Composer.copy.open_agentsdock_settings_9e90b52") }, keywords: ['server', 'appearance', 'update'], category: 'agentsdock' },
  { id: 'split', get label() { return t("ui.Composer.copy.split_chat_cb0026c") }, get description() { return t("ui.Composer.copy.open_another_chat_beside_this_one_869fbb4") }, keywords: ['pane', 'side-by-side'], category: 'agentsdock' },
  { id: 'status', get label() { return t("ui.Composer.copy.status_920e413") }, get description() { return t("ui.Composer.copy.show_chat_and_runtime_details_ed895b9") }, keywords: ['context', 'connection', 'session'], category: 'agentsdock' },
  { id: 'workdir', get label() { return t("ui.Composer.copy.working_directory_865e85c") }, get description() { return t("ui.Composer.copy.choose_the_folder_used_by_this_chat_28c7132") }, keywords: ['cwd', 'directory', 'folder', 'project'], category: 'agentsdock' },
  { id: 'import', get label() { return t("ui.Composer.copy.import_chat_ed32942") }, get description() { return t("ui.Composer.copy.bring_in_your_claude_code_codex_history_fa549bd") }, keywords: ['bulk', 'resume', 'session'], category: 'agentsdock' }
]

/** Display order + heading for each command category, top to bottom in the palette. */
const COMPOSER_COMMAND_CATEGORIES: readonly ComposerCommandCategory[] = [
  { id: 'agentsdock', heading: 'AgentsDock' },
  { id: 'skills', get heading() { return t('composer.providerCommands.skillsHeading') } },
  { id: 'claude-commands', get heading() { return t('composer.providerCommands.claudeHeading') } }
]

const PROVIDER_COMMAND_CACHE_TTL_MS = 30_000
const PROVIDER_COMMAND_CACHE_MAX_ENTRIES = 32
const providerCommandCache = new Map<string, { snapshot: ProviderCommandsSnapshot; expiresAt: number }>()
const providerCommandRequests = new Map<string, Promise<ProviderCommandsSnapshot>>()
const AGENTSDOCK_COMMAND_IDS = new Set(COMPOSER_COMMANDS.map(command => command.id.toLocaleLowerCase()))

interface BoundProviderCommand {
  contextKey: string
  invocation: string
  name: string
  kind: string
  selection: ProviderCommandSelection
}

type ProviderCommandLoadState =
  | { key: string | null; status: 'idle'; snapshot: null }
  | { key: string | null; status: 'loading'; snapshot: ProviderCommandsSnapshot | null }
  | { key: string | null; status: 'ready'; snapshot: ProviderCommandsSnapshot | null }
  | { key: string | null; status: 'error'; snapshot: ProviderCommandsSnapshot | null }

function providerCommandContextKey(
  profileId: string | null,
  profileGeneration: number,
  connectionGeneration: number,
  serverIdentity: string | null,
  session: Session | null | undefined
): string | null {
  if (!session || session.backend === 'cursor') return null
  return [
    profileId ?? 'local',
    profileGeneration,
    connectionGeneration,
    serverIdentity ?? 'unknown-server',
    session.id,
    session.backend,
    session.cwd?.trim() ?? ''
  ].join('\u0000')
}

function cacheProviderCommands(key: string, snapshot: ProviderCommandsSnapshot): void {
  providerCommandCache.delete(key)
  providerCommandCache.set(key, { snapshot, expiresAt: Date.now() + PROVIDER_COMMAND_CACHE_TTL_MS })
  while (providerCommandCache.size > PROVIDER_COMMAND_CACHE_MAX_ENTRIES) {
    const oldest = providerCommandCache.keys().next().value
    if (typeof oldest !== 'string') return
    providerCommandCache.delete(oldest)
  }
}

function providerInvocation(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value !== value.trim()) return null
  const invocation = value
  // An invocation is a single slash token, never a local path or an argument-bearing prompt.
  return /^\/[\p{L}\p{N}_.:-]+$/u.test(invocation) ? invocation : null
}

function providerMetaPart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const part = value.trim()
  if (!part || /^(?:file:|[a-z]:[\\/]|[\\/]{1,2})/iu.test(part)) return null
  return part
}

function providerComposerCommands(snapshot: ProviderCommandsSnapshot | null, backend: Session['backend']): ComposerCommand[] {
  if (!snapshot || snapshot.support?.available !== true || snapshot.backend !== backend || backend === 'cursor' || !Array.isArray(snapshot.commands)) return []
  const seenCommands = new Set<string>()
  return snapshot.commands.flatMap((command, index) => {
    if (!command || typeof command !== 'object') return []
    const invocation = providerInvocation(command.invocation)
    const opaqueId = typeof command.id === 'string' ? command.id.trim() : ''
    const revision = typeof snapshot.revision === 'string' ? snapshot.revision.trim() : ''
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    const kind = typeof command.kind === 'string' ? command.kind.trim() : ''
    if (!invocation || !opaqueId || !revision || !name || !kind) return []
    if (AGENTSDOCK_COMMAND_IDS.has(invocation.slice(1).toLocaleLowerCase())) return []
    const label = typeof command.label === 'string' && command.label.trim() ? command.label.trim() : name
    const description = typeof command.description === 'string' ? command.description.trim() : ''
    const scope = providerMetaPart(command.scope)
    const source = providerMetaPart(command.source)
    const semanticKey = JSON.stringify([name, invocation, label, description, scope, source, kind])
    if (seenCommands.has(semanticKey)) return []
    seenCommands.add(semanticKey)
    const metaParts = [scope, source]
      .filter((value): value is string => Boolean(value))
      .filter((value, partIndex, values) => values.indexOf(value) === partIndex)
    return [{
      id: `provider-${index}`,
      label,
      description,
      keywords: [name, invocation.slice(1), kind, ...metaParts],
      category: backend === 'claude' ? 'claude-commands' : 'skills',
      meta: metaParts.join(' · '),
      provider: {
        command: { ...command, id: opaqueId, name, label, description, kind, invocation },
        selection: { id: opaqueId, revision }
      }
    }]
  })
}

function draftUsesProviderCommand(text: string, binding: BoundProviderCommand): boolean {
  if (!text.startsWith(binding.invocation)) return false
  if (text.length === binding.invocation.length) return true
  // Keep this byte boundary identical to AgentsServer's revalidation rule.
  // Vertical tab and form feed are whitespace to JavaScript, but are not
  // valid provider-command argument separators on the wire.
  return /[\t\n\r ]/u.test(text[binding.invocation.length] ?? '')
}

interface DraftContext {
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  sessionId: string | null
  workspaceKey: string | null
}

interface DraftFlushEventDetail {
  promises?: Promise<unknown>[]
  waitUntil?: (promise: PromiseLike<unknown> | unknown) => void
}

type InboundDeliveryInterruption = 'stop' | 'send_now'

type InboundDeliveryConsent = {
  identity: string | null
}

export function inboundDeliveryInterruptionMessage(
  kind: ActiveInboundDeliveryKind,
  action: InboundDeliveryInterruption
): string {
  if (kind === 'unknown') {
    return action === 'stop'
      ? t("ui.Composer.inboundDeliveryInterruptionMessage.an_active_turn_is_running_while_chat_sync__4e1e87c")
      : t("ui.Composer.inboundDeliveryInterruptionMessage.an_active_turn_is_running_while_chat_sync__1f4ade2")
  }
  if (kind === 'secure_peer') {
    return action === 'stop'
      ? 'An incoming encrypted peer delivery is running. Stopping it may cancel or fail that exchange. Stop anyway?'
      : 'An incoming encrypted peer delivery is running. Sending now will interrupt it and may cancel or fail that exchange. Send now anyway?'
  }
  const delivery = 'chat-to-chat delivery'
  return action === 'stop'
    ? t("ui.Composer.inboundDeliveryInterruptionMessage.an_incoming_is_running_stopping_it_may_can_8f12501", { "delivery": String(delivery) })
    : t("ui.Composer.inboundDeliveryInterruptionMessage.an_incoming_is_running_sending_now_will_in_c9f39ea", { "delivery": String(delivery) })
}

function currentInboundDelivery(sessionId: string): ActiveInboundDelivery | null {
  const state = useAppStore.getState()
  if (!state.activeSessionIds.has(sessionId)) return null
  const syncStatus = state.syncBySession[sessionId]?.status
    ?? (state.selectedSessionId === sessionId ? state.syncStatus : 'idle')
  return detectActiveInboundDelivery(
    state.snapshots[sessionId]?.events ?? EMPTY_EVENTS,
    syncStatus !== 'live'
  )
}

function confirmInboundDeliveryInterruption(
  sessionId: string,
  action: InboundDeliveryInterruption,
  priorConsent?: InboundDeliveryConsent
): InboundDeliveryConsent | null {
  const delivery = currentInboundDelivery(sessionId)
  if (!delivery) return { identity: null }
  if (priorConsent?.identity === delivery.identity) return priorConsent
  return window.confirm(inboundDeliveryInterruptionMessage(delivery.kind, action))
    ? { identity: delivery.identity }
    : null
}

export const Composer = memo(function Composer({ dropActive = false, sessionId, writeDisabled = false }: { dropActive?: boolean; sessionId?: string | null; writeDisabled?: boolean }) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const focusedSessionId = useAppStore(state => state.selectedSessionId)
  const selectedId = sessionId === undefined ? focusedSessionId : sessionId
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === selectedId) ?? null)
  const queuedTurns = useAppStore(state => selectedId ? state.snapshots[selectedId]?.queuedTurns ?? EMPTY_QUEUED_TURNS : EMPTY_QUEUED_TURNS)
  const visibleQueuedTurns = useMemo(() => queuedTurns.filter(isVisibleQueuedTurn), [queuedTurns])
  const storedDraft = useAppStore(state => selectedId ? state.drafts[selectedId] ?? '' : '')
  const storedReferences = useAppStore(state => selectedId ? state.chatReferencesBySession[selectedId] ?? EMPTY_CHAT_REFERENCES : EMPTY_CHAT_REFERENCES)
  const storedTeamReferences = useAppStore(state => selectedId ? state.teamReferencesBySession[selectedId] ?? EMPTY_TEAM_REFERENCES : EMPTY_TEAM_REFERENCES)
  const uploads = useAppStore(state => selectedId ? state.uploadsBySession[selectedId] ?? EMPTY_UPLOADS : EMPTY_UPLOADS)
  const uploadPaths = useAppStore(state => selectedId ? state.uploadPathsBySession[selectedId] ?? EMPTY_UPLOAD_PATHS : EMPTY_UPLOAD_PATHS)
  const running = useAppStore(state => selectedId ? state.activeSessionIds.has(selectedId) : false)
  const admitting = useAppStore(state => selectedId ? Boolean(state.turnAdmissionTokens[selectedId]) : false)
  const pendingSubmission = useAppStore(state => selectedId ? state.pendingTurnSubmissions[selectedId] : undefined)
  const pendingSubmissionMode = pendingSubmission?.mode
  const stopping = useAppStore(state => selectedId ? state.stoppingSessionIds.has(selectedId) : false)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const healthRevision = useAppStore(state => composerHealthContractRevision(state.health))
  const health = useMemo(() => useAppStore.getState().health, [healthRevision])
  const connected = useAppStore(state => state.connected)
  const connectionGeneration = useAppStore(state => state.connectionGeneration)
  const serverInstanceId = health?.server_instance_id ?? null
  // Subscribe to the tiny warning value, not the selected chat's entire event
  // array. Live timeline batches must never rerender the composer while the
  // user is typing unless the inbound-delivery warning itself changes.
  const activeInboundDeliveryKind = useAppStore(state => {
    if (!selectedId || !state.activeSessionIds.has(selectedId)) return null
    const syncStatus = state.syncBySession[selectedId]?.status
      ?? (state.selectedSessionId === selectedId ? state.syncStatus : 'idle')
    return detectActiveInboundDelivery(
      state.snapshots[selectedId]?.events ?? EMPTY_EVENTS,
      syncStatus !== 'live'
    )?.kind ?? null
  })
  const agentRouteSnapshot = useAppStore(state => selectedId ? state.agentRoutesBySession[selectedId] ?? null : null)
  const grantedRoutes = agentRouteSnapshot?.routes ?? EMPTY_AGENT_ROUTES
  const grantsLoading = useAppStore(state => selectedId ? state.agentRouteLoadingSessionIds.has(selectedId) : false)
  const grantsError = useAppStore(state => selectedId ? state.agentRouteErrorsBySession[selectedId] ?? null : null)
  const revokingAgentRouteIds = useAppStore(state => state.revokingAgentRouteIds)
  const splitOpen = useAppStore(state => Boolean(state.chatPanes.primary && state.chatPanes.secondary))
  const codexRuntime = useCodexRuntime()
  const activeCodexGoal = session?.backend === 'codex'
    && (codexRuntime.runtime ? codexRuntime.runtime.goal : session.codex_goal)?.status === 'active'
  const claudeRuntime = useClaudeRuntime()
  const claudeGoalsAvailable = useClaudeGoalsAvailable()
  const workspaceKey = selectedId ? profileSessionKey(activeProfileId, selectedId, serverIdentity) : null
  const steeringScope = useMemo<SteeringScope | null>(() => selectedId ? {
    profileId: activeProfileId,
    profileGeneration,
    serverIdentity,
    sessionId: selectedId
  } : null, [activeProfileId, profileGeneration, selectedId, serverIdentity])
  const providerCommandsKey = useMemo(() => providerCommandContextKey(
    activeProfileId,
    profileGeneration,
    connectionGeneration,
    serverIdentity,
    session
  ), [activeProfileId, connectionGeneration, profileGeneration, serverIdentity, session?.backend, session?.cwd, session?.id])
  const draftRef = useRef(storedDraft)
  const draftDirtyRef = useRef(false)
  const referencesRef = useRef<ChatReference[]>(storedReferences)
  const referencesDirtyRef = useRef(false)
  const teamReferencesRef = useRef<TeamReference[]>(storedTeamReferences)
  const teamReferencesDirtyRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const editorMirrorRef = useRef<HTMLDivElement | null>(null)
  const editorMirrorAlignedRef = useRef(true)
  const editorLayoutFrameRef = useRef<number | null>(null)
  const paletteBlurTimerRef = useRef<number | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const pendingSelectionRef = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null>(null)
  const nativeEditSelectionRef = useRef<ComposerNativeEditSelection | null>(null)
  const providerCommandBindingRef = useRef<BoundProviderCommand | null>(null)
  const providerCommandRequestRef = useRef(0)
  const providerCommandPaletteOpenRef = useRef(false)
  const providerCommandsKeyRef = useRef(providerCommandsKey)
  providerCommandsKeyRef.current = providerCommandsKey
  const mountedRef = useRef(true)
  const mentionPaletteId = `chat-mention-${useId().replace(/:/g, '')}`
  const teamMentionPaletteId = `team-mention-${useId().replace(/:/g, '')}`
  const commandPaletteId = `composer-command-${useId().replace(/:/g, '')}`
  const draftContextRef = useRef<DraftContext>({ profileId: activeProfileId, profileGeneration, serverIdentity, sessionId: selectedId, workspaceKey })
  const [draft, setDraft] = useState(storedDraft)
  const [references, setReferences] = useState<ChatReference[]>(storedReferences)
  const [teamReferences, setTeamReferences] = useState<TeamReference[]>(storedTeamReferences)
  const [mention, setMention] = useState<ChatMentionTrigger | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionCandidates, setMentionCandidates] = useState<ChatMentionCandidate[]>([])
  const [teamMention, setTeamMention] = useState<TeamMentionTrigger | null>(null)
  const [teamMentionIndex, setTeamMentionIndex] = useState(0)
  const [teamMentionCandidates, setTeamMentionCandidates] = useState<TeamMentionCandidate[]>([])
  const [editorMirrorAligned, setEditorMirrorAligned] = useState(true)
  const [commandTrigger, setCommandTrigger] = useState<ComposerCommandTrigger | null>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const [providerCommandState, setProviderCommandState] = useState<ProviderCommandLoadState>({
    key: providerCommandsKey,
    status: 'idle',
    snapshot: null
  })
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false)
  const [runtimeMenuSection, setRuntimeMenuSection] = useState<'model' | 'reasoning' | null>(null)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [claudeGoalOpen, setClaudeGoalOpen] = useState(false)
  const [workingDirectoryOpen, setWorkingDirectoryOpen] = useState(false)
  useEffect(() => {
    providerCommandRequestRef.current += 1
    providerCommandBindingRef.current = null
    setProviderCommandState({ key: providerCommandsKey, status: 'idle', snapshot: null })
  }, [providerCommandsKey])

  const loadProviderCommands = useCallback(async (refresh = false, discardSnapshot = false) => {
    const key = providerCommandsKey
    const list = window.agentsDock.providerCommands?.list
    if (!key || !selectedId || !session || session.backend === 'cursor' || !connected || typeof list !== 'function') return
    if (session.backend === 'opencode' && !openCodeProviderCommandsAvailable(useAppStore.getState().health)) return
    if (!refresh) {
      const cached = providerCommandCache.get(key)
      if (cached && cached.expiresAt > Date.now()) {
        providerCommandCache.delete(key)
        providerCommandCache.set(key, cached)
        setProviderCommandState({ key, status: 'ready', snapshot: cached.snapshot })
        return
      }
      if (cached) providerCommandCache.delete(key)
    }
    const requestId = ++providerCommandRequestRef.current
    setProviderCommandState(previous => ({
      key,
      status: 'loading',
      snapshot: !discardSnapshot && previous.key === key ? previous.snapshot : null
    }))
    const inFlightKey = `${key}\u0000${refresh ? 'refresh' : 'load'}`
    let request = providerCommandRequests.get(inFlightKey)
    if (!request) {
      request = list(selectedId, refresh)
      providerCommandRequests.set(inFlightKey, request)
      void request.finally(() => {
        if (providerCommandRequests.get(inFlightKey) === request) providerCommandRequests.delete(inFlightKey)
      }).catch(() => undefined)
    }
    try {
      const snapshot = await request
      if (!mountedRef.current || providerCommandRequestRef.current !== requestId || providerCommandsKeyRef.current !== key) return
      cacheProviderCommands(key, snapshot)
      setProviderCommandState({ key, status: 'ready', snapshot })
    } catch {
      if (!mountedRef.current || providerCommandRequestRef.current !== requestId || providerCommandsKeyRef.current !== key) return
      setProviderCommandState(previous => ({
        key,
        status: 'error',
        snapshot: previous.key === key ? previous.snapshot : null
      }))
    }
  }, [connected, providerCommandsKey, selectedId, session])

  useEffect(() => {
    const opened = Boolean(commandTrigger)
    const wasOpen = providerCommandPaletteOpenRef.current
    providerCommandPaletteOpenRef.current = opened
    if (!opened || !providerCommandsKey || providerCommandState.key !== providerCommandsKey) return
    if (wasOpen && providerCommandState.status !== 'idle') return
    const cached = providerCommandCache.get(providerCommandsKey)
    if (cached && cached.expiresAt <= Date.now()) {
      void loadProviderCommands(true)
    } else if (providerCommandState.status === 'idle' || !cached) {
      void loadProviderCommands()
    }
  }, [commandTrigger, loadProviderCommands, providerCommandState.key, providerCommandState.status, providerCommandsKey])
  // A textarea and a mirror div do not wrap every pasted token identically in
  // Chromium. Native text remains authoritative; the mirror paints only chip
  // decorations when its geometry is safe.
  const inlineReferenceSet = useMemo(() => validComposerReferences(
    draft,
    references,
    teamReferences,
    (text, candidates) => validChatReferences(text, candidates, selectedId)
  ), [draft, references, selectedId, teamReferences])
  const inlineReferenceSpans = useMemo(
    () => orderedComposerReferenceSpans(inlineReferenceSet.chatReferences, inlineReferenceSet.teamReferences),
    [inlineReferenceSet]
  )
  const messageProjection = useMemo(() => projectTeamMessageComposer(draft), [draft])
  const displayedReferenceSet = useMemo(() => {
    const project = <T extends ChatReference | TeamReference,>(reference: T): T => ({
      ...reference,
      source_text_start: composerSourceToDisplay(messageProjection, reference.source_text_start),
      source_text_end: composerSourceToDisplay(messageProjection, reference.source_text_end)
    })
    return {
      chatReferences: inlineReferenceSet.chatReferences.map(project),
      teamReferences: inlineReferenceSet.teamReferences.map(project)
    }
  }, [inlineReferenceSet, messageProjection])
  const displayedReferenceSpans = useMemo(() => orderedComposerReferenceSpans(
    displayedReferenceSet.chatReferences, displayedReferenceSet.teamReferences
  ), [displayedReferenceSet])
  const hasMessageLinks = messageProjection.links.length > 0
  const hasStructuredReferences = inlineReferenceSpans.length > 0
  const hasInlineReferences = hasStructuredReferences && composerTextCanUseMirror(messageProjection.text, displayedReferenceSpans)
  const hasReferenceFallback = hasStructuredReferences && (!hasInlineReferences || !editorMirrorAligned)
  const supportedChatActions = useMemo(() => supportedCrossChatActions(health), [healthRevision])
  const supportedTargetBackends = useMemo(() => supportedCrossChatTargetBackends(health), [healthRevision])
  const routeHintsSupported = session?.backend !== 'opencode' && routeHintMentionsAvailable(health)
  const teamMentionsSupported = teamMessagesAvailable(health)
  const teamAllServersSupported = teamAllServersAliasAvailable(health)
  const teamMessagesAdvertised = health?.capabilities?.agent_team_messages_v1?.available === true
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && Boolean(session && supportedTargetBackends.includes(session.backend))
  const crossChatSupported = routeHintsSupported
    && supportedChatActions.includes('route')
    && supportedTargetBackends.length > 0
  const grantedTargetIds = useMemo(
    () => new Set(grantedRoutes.map(route => route.target_session_id)),
    [grantedRoutes]
  )
  const pendingGrantTargetIds = useMemo(
    () => new Set(references.filter(reference => (
      reference.target_kind !== 'secure_peer'
      && reference.action === 'route'
      && reference.grant_intent === true
      && !grantedTargetIds.has(reference.session_id)
    )).map(reference => reference.session_id)),
    [grantedTargetIds, references]
  )
  const remainingNewRouteCapacity = agentRouteSnapshot && agentRouteSnapshot.max_routes !== null
    ? Math.max(0, agentRouteSnapshot.max_routes - grantedRoutes.length - pendingGrantTargetIds.size)
    : null
  const referenceTargetsRevision = useAppStore(state => references.map(reference => {
    if (reference.target_kind === 'secure_peer') {
      return `secure:${reference.target_server_identity}:${reference.target_connection_id}:${reference.target_route_id}:${reference.target_route_revision}:unsupported`
    }
    const target = state.sessions.find(candidate => candidate.id === reference.session_id)
    return `${reference.session_id}:${target?.backend ?? 'missing'}:${target?.archived ? 'archived' : 'active'}`
  }).join('|'))
  const referenceSupported = useCallback((reference: ChatReference): boolean => {
    if (reference.target_kind === 'secure_peer') return false
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      crossChatSupported
      && currentRouteHintReference(draft, reference)
      && target
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  // The primitive revision subscribes only to referenced targets without
  // rerendering the composer for unrelated activity across hundreds of chats.
  }, [crossChatSupported, draft, referenceTargetsRevision, supportedTargetBackends])
  const chatReferencesSupported = references.length === 0 || references.every(referenceSupported)
  const hasRemoteAgentReference = references.some(reference => reference.target_kind === 'secure_peer')
  const unsupportedAllServersReference = !teamAllServersSupported && hasAllServersReference(teamReferences)
  const composerTeamReferencesSupported = (teamReferences.length === 0 || teamMentionsSupported) && !unsupportedAllServersReference
  const referencesSupported = chatReferencesSupported && composerTeamReferencesSupported
  const selectedRuntimeError = sessionRuntimeAdmissionError(session, health, catalog)
  const canSend = !writeDisabled && !selectedRuntimeError && !admitting && uploadPaths.length === 0 && referencesSupported && (Boolean(draft.trim()) || uploads.length > 0)
  const codexControls = health?.capabilities?.codex_controls
  const claudeControls = health?.capabilities?.claude_controls
  const claudeMcpAvailable = claudeMcpCapabilitySupported(claudeControls)
  const claudePermissionMode = session?.claude_permission_mode ?? claudeRuntime.runtime?.policy?.permission_mode
  const claudePermissionModes = useMemo(
    () => supportedClaudePermissionModes(claudeRuntime.runtime?.permission_modes),
    [claudeRuntime.runtime?.permission_modes]
  )
  const codexPermissionsAvailable = Boolean(
    session?.backend === 'codex'
    && codexControls?.available === true
    && codexControls.features?.approvals !== false
    && codexRuntime.supported
    && (session.codex_approval_policy ?? codexRuntime.runtime?.policy?.approval_policy) != null
    && (session.codex_sandbox_mode ?? codexRuntime.runtime?.policy?.sandbox_mode) != null
    && (session.codex_approvals_reviewer ?? codexRuntime.runtime?.policy?.approvals_reviewer) != null
  )
  const claudePermissionsAvailable = Boolean(
    session?.backend === 'claude'
    && claudeControls?.available === true
    && claudeControls.features?.permission_mode_control === true
    && claudeRuntime.supported
    && claudeRuntime.runtime?.features?.permission_mode_control === true
    && claudePermissionMode != null
    && claudePermissionModes.includes(claudePermissionMode)
  )
  const cursorPermissionsAvailable = Boolean(
    session?.backend === 'cursor'
    && cursorBackendAvailable(health, catalog)
  )
  const codexGoalsAvailable = session?.backend === 'codex'
    && codexControls?.available === true
    && codexControls.features?.goals !== false
    && codexRuntime.supported
    && codexRuntime.runtime?.goals_enabled !== false
  const goalControlsAvailable = !window.agentsDock.sharedChat && (codexGoalsAvailable || claudeGoalsAvailable)
  const goalTitle = t(session?.backend === 'claude' ? 'claudeGoal.title' : 'codexGoal.title')
  const openGoalControls = () => {
    if (session?.backend === 'claude') setClaudeGoalOpen(true)
    else if (session?.backend === 'codex') window.dispatchEvent(new CustomEvent('agentsdock:open-codex-controls', {
      detail: { sessionId: session.id, focus: 'goal' }
    }))
  }
  const commandAvailable = useCallback((command: ComposerCommand): boolean => {
    if (!session) return false
    if (window.agentsDock.sharedChat && !['goal', 'permissions', 'reasoning', 'model', 'plan', 'schedule', 'attach'].includes(command.id)) return false
    if (command.provider) return command.provider.command.kind.length > 0
      && (session.backend !== 'opencode' || openCodeProviderCommandsAvailable(health))
    if (command.id === 'chat') return crossChatSupported
    if (command.id === 'mail') return !teamMessagesAdvertised
    if (command.id === 'goal') {
      if (session.backend === 'claude') return claudeGoalsAvailable
      return codexGoalsAvailable
    }
    if (command.id === 'permissions') return codexPermissionsAvailable || claudePermissionsAvailable || cursorPermissionsAvailable || session.backend === 'opencode' && opencodeBackendAvailable(health, catalog)
    if (command.id === 'reasoning') {
      return session.backend !== 'cursor' && session.backend !== 'opencode'
        && runtimeEffortOptions(catalog, session.backend, session.model, session.effort, session.codex_provider, session.codex_provider_catalog)
        .some(option => Boolean(option.value))
    }
    if (command.id === 'mcp') return session.backend === 'claude' && claudeMcpAvailable
    if (command.id === 'plan') {
      return session.backend === 'claude'
        && claudePermissionsAvailable
        && Boolean(claudeControls?.permission_modes?.includes('plan'))
        && claudePermissionModes.includes('plan')
    }
    if (command.id === 'schedule') return health?.capabilities?.scheduled_jobs?.available === true
    if (command.id === 'import') return localSessionImportSupported(health)
    if (command.id === 'split') return !splitOpen
    return true
  }, [catalog, claudeControls?.permission_modes, claudeGoalsAvailable, claudeMcpAvailable, claudePermissionModes, claudePermissionsAvailable, codexGoalsAvailable, codexPermissionsAvailable, crossChatSupported, cursorPermissionsAvailable, healthRevision, session, splitOpen, teamMessagesAdvertised])
  const activeProviderCommandState: ProviderCommandLoadState = providerCommandState.key === providerCommandsKey
    ? providerCommandState
    : { key: providerCommandsKey, status: 'idle', snapshot: null }
  const dynamicComposerCommands = useMemo(
    () => providerComposerCommands(activeProviderCommandState.snapshot, session?.backend ?? 'cursor'),
    [activeProviderCommandState.snapshot, session?.backend]
  )
  const allComposerCommands = useMemo(
    () => [...COMPOSER_COMMANDS.map(command => command.id === 'goal' && session?.backend === 'claude'
      ? { ...command, description: t('claudeGoal.commandDescription') } : command), ...dynamicComposerCommands],
    [dynamicComposerCommands, getLocale(), session?.backend]
  )
  const commandCandidates = useMemo(
    () => commandTrigger ? filterComposerCommands(allComposerCommands, commandTrigger.query, commandAvailable) : [],
    [allComposerCommands, commandAvailable, commandTrigger]
  )
  const commandPaletteVisible = Boolean(commandTrigger && (
    commandCandidates.length > 0
    || activeProviderCommandState.status === 'loading'
    || activeProviderCommandState.status === 'error'
  ))
  const steeringPending = useSyncExternalStore(
    subscribeSteeringPending,
    () => isSteeringPending(steeringScope),
    () => false
  )
  useTransientClose(commandPaletteVisible, () => setCommandTrigger(null))
  useTransientClose(runtimeMenuOpen, () => {
    setRuntimeMenuOpen(false)
    setRuntimeMenuSection(null)
  })
  useTransientClose(permissionMenuOpen, () => setPermissionMenuOpen(false))
  useTransientClose(workingDirectoryOpen, () => setWorkingDirectoryOpen(false))

  useEffect(() => {
    if (!connected || !selectedId || !routeHintsSupported) return
    void useAppStore.getState().refreshAgentRoutes(selectedId)
  }, [activeProfileId, connected, connectionGeneration, profileGeneration, routeHintsSupported, selectedId, serverIdentity, serverInstanceId])

  useEffect(() => {
    const invalidate = () => {
      teamMentionTargetCache.clear()
      teamMentionTargetInFlight.clear()
      teamMentionLatestByExpected.clear()
    }
    window.addEventListener('agentsdock:team-network-cache-invalidated', invalidate)
    return () => window.removeEventListener('agentsdock:team-network-cache-invalidated', invalidate)
  }, [])

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { referencesRef.current = references }, [references])
  useEffect(() => { teamReferencesRef.current = teamReferences }, [teamReferences])
  useEffect(() => {
    setCommandIndex(index => Math.max(0, Math.min(index, Math.max(0, commandCandidates.length - 1))))
  }, [commandCandidates.length])
  useEffect(() => {
    setTeamMentionIndex(index => Math.max(0, Math.min(index, Math.max(0, teamMentionCandidates.length - 1))))
  }, [teamMentionCandidates.length])
  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current
    if (selection) {
      pendingSelectionRef.current = null
      textareaRef.current?.setSelectionRange(
        composerSourceToDisplay(messageProjection, selection.start),
        composerSourceToDisplay(messageProjection, selection.end), selection.direction
      )
    }
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    textareaRef.current?.focus()
    const displayCaret = composerSourceToDisplay(messageProjection, caret)
    textareaRef.current?.setSelectionRange(displayCaret, displayCaret)
  }, [draft, messageProjection])
  const recordEditorMirrorAlignment = useCallback((aligned: boolean | null) => {
    if (aligned === null || editorMirrorAlignedRef.current === aligned) return
    editorMirrorAlignedRef.current = aligned
    setEditorMirrorAligned(aligned)
  }, [])
  const scheduleEditorLayout = useCallback(() => {
    scheduleComposerEditorLayout(textareaRef.current, editorMirrorRef.current, editorLayoutFrameRef, recordEditorMirrorAlignment)
  }, [recordEditorMirrorAlignment])
  useEffect(() => {
    scheduleEditorLayout()
  }, [draft, inlineReferenceSpans, scheduleEditorLayout])
  useEffect(() => observeComposerEditorWidth(textareaRef.current, scheduleEditorLayout), [scheduleEditorLayout, selectedId])
  useEffect(() => () => cancelComposerEditorLayout(textareaRef.current, editorLayoutFrameRef), [])
  const acceptMentionCandidates = useCallback((next: ChatMentionCandidate[]) => setMentionCandidates(next), [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (paletteBlurTimerRef.current !== null) window.clearTimeout(paletteBlurTimerRef.current)
      const context = draftContextRef.current
      const current = useAppStore.getState()
      if (!context.sessionId || current.activeProfileId !== context.profileId || current.profileGeneration !== context.profileGeneration || activeIdentity(current) !== context.serverIdentity) return
      const text = draftRef.current
      const validated = validComposerReferences(
        text,
        referencesRef.current,
        teamReferencesRef.current,
        (value, candidates) => validChatReferences(value, candidates, context.sessionId)
      )
      useAppStore.getState().setDraftForSession(context.sessionId, text)
      useAppStore.getState().setChatReferencesForSession(context.sessionId, validated.chatReferences)
      useAppStore.getState().setTeamReferencesForSession(context.sessionId, validated.teamReferences)
      const writes = [setWorkspacePreference(draftPreferenceScope(context), `draft:${context.sessionId}`, text)]
      if (validated.chatReferences.length || referencesDirtyRef.current) {
        writes.push(setWorkspacePreference(draftPreferenceScope(context), chatReferencesPreferenceKey(context.sessionId), validated.chatReferences))
      }
      if (validated.teamReferences.length || teamReferencesDirtyRef.current) {
        writes.push(setWorkspacePreference(draftPreferenceScope(context), teamReferencesPreferenceKey(context.sessionId), validated.teamReferences))
      }
      void Promise.all(writes).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const previous = draftContextRef.current
    if (previous.sessionId && previous.profileId === activeProfileId && previous.profileGeneration === profileGeneration && previous.serverIdentity === serverIdentity && previous.workspaceKey !== workspaceKey) {
      const previousDraft = draftRef.current
      const previousReferences = validComposerReferences(
        previousDraft,
        referencesRef.current,
        teamReferencesRef.current,
        (value, candidates) => validChatReferences(value, candidates, previous.sessionId)
      )
      useAppStore.getState().setDraftForSession(previous.sessionId, previousDraft)
      useAppStore.getState().setChatReferencesForSession(previous.sessionId, previousReferences.chatReferences)
      useAppStore.getState().setTeamReferencesForSession(previous.sessionId, previousReferences.teamReferences)
      const writes = [setWorkspacePreference(draftPreferenceScope(previous), `draft:${previous.sessionId}`, previousDraft)]
      if (previousReferences.chatReferences.length || referencesDirtyRef.current) {
        writes.push(setWorkspacePreference(draftPreferenceScope(previous), chatReferencesPreferenceKey(previous.sessionId), previousReferences.chatReferences))
      }
      if (previousReferences.teamReferences.length || teamReferencesDirtyRef.current) {
        writes.push(setWorkspacePreference(draftPreferenceScope(previous), teamReferencesPreferenceKey(previous.sessionId), previousReferences.teamReferences))
      }
      void Promise.all(writes).catch(() => undefined)
    }
    draftContextRef.current = { profileId: activeProfileId, profileGeneration, serverIdentity, sessionId: selectedId, workspaceKey }
    setMention(null)
    setMentionCandidates([])
    setTeamMention(null)
    setTeamMentionCandidates([])
    setCommandTrigger(null)
    setRuntimeMenuOpen(false)
    setRuntimeMenuSection(null)
    setPermissionMenuOpen(false)
    setMcpDialogOpen(false)
    setClaudeGoalOpen(false)
    setWorkingDirectoryOpen(false)
    if (!selectedId) {
      draftRef.current = ''
      draftDirtyRef.current = false
      referencesRef.current = []
      referencesDirtyRef.current = false
      teamReferencesRef.current = []
      teamReferencesDirtyRef.current = false
      setDraft('')
      setReferences([])
      setTeamReferences([])
      return
    }
    const state = useAppStore.getState()
    const immediate = state.drafts[selectedId] ?? ''
    const hasImmediateDraftState = Object.prototype.hasOwnProperty.call(state.drafts, selectedId)
    const hasImmediateReferenceState = Object.prototype.hasOwnProperty.call(state.chatReferencesBySession, selectedId)
    const hasImmediateTeamReferenceState = Object.prototype.hasOwnProperty.call(state.teamReferencesBySession, selectedId)
    const parsedImmediateReferences = parseStoredChatReferences(state.chatReferencesBySession[selectedId], immediate, selectedId)
    const parsedImmediateTeamReferences = parseStoredTeamReferences(state.teamReferencesBySession[selectedId], immediate)
    const immediateState = canonicalizeComposerReferences(
      immediate,
      parsedImmediateReferences,
      parsedImmediateTeamReferences,
      selectedId,
      routeHintsSupported
    )
    const immediateWasCanonicalized = immediateState.text !== immediate
      || immediateState.chatReferences.some((reference, index) => reference.action !== parsedImmediateReferences[index]?.action)
    draftRef.current = immediateState.text
    draftDirtyRef.current = false
    referencesRef.current = immediateState.chatReferences
    teamReferencesRef.current = immediateState.teamReferences
    referencesDirtyRef.current = immediateWasCanonicalized
    teamReferencesDirtyRef.current = false
    setDraft(immediateState.text)
    setReferences(immediateState.chatReferences)
    setTeamReferences(immediateState.teamReferences)
    if (immediateWasCanonicalized) {
      state.setDraftForSession(selectedId, immediateState.text)
      state.setChatReferencesForSession(selectedId, immediateState.chatReferences)
      state.setTeamReferencesForSession(selectedId, immediateState.teamReferences)
    }
    if (!hasImmediateDraftState || !hasImmediateReferenceState || !hasImmediateTeamReferenceState) void getWorkspacePreference(
      draftPreferenceScope(draftContextRef.current),
      `draft:${selectedId}`,
      ''
    ).then(async storedText => {
      const current = useAppStore.getState()
      if (!mountedRef.current || current.activeProfileId !== activeProfileId || current.profileGeneration !== profileGeneration || activeIdentity(current) !== serverIdentity || draftContextRef.current.sessionId !== selectedId) return
      // An explicit draft entry, including an empty string, is authoritative.
      // Sending publishes an empty entry synchronously; a preference read that
      // started before the send must never resurrect the consumed message.
      const liveHasDraftState = Object.prototype.hasOwnProperty.call(current.drafts, selectedId)
      const text = draftDirtyRef.current
        ? draftRef.current
        : draftRef.current || (liveHasDraftState ? current.drafts[selectedId] ?? '' : storedText)
      if (!liveHasDraftState && !draftDirtyRef.current && !draftRef.current && storedText) {
        draftRef.current = storedText
        draftDirtyRef.current = false
        setDraft(storedText)
        current.setDraftForSession(selectedId, storedText)
      }
      if ((!hasImmediateReferenceState || !hasImmediateTeamReferenceState) && text.includes('@')) {
        const [storedChatReferences, storedTeamReferences] = await Promise.all([
          getWorkspacePreference<unknown>(
            draftPreferenceScope(draftContextRef.current),
            chatReferencesPreferenceKey(selectedId),
            []
          ),
          getWorkspacePreference<unknown>(
            draftPreferenceScope(draftContextRef.current),
            teamReferencesPreferenceKey(selectedId),
            []
          )
        ])
        const latest = useAppStore.getState()
        if (!mountedRef.current || latest.activeProfileId !== activeProfileId || latest.profileGeneration !== profileGeneration || activeIdentity(latest) !== serverIdentity || draftContextRef.current.sessionId !== selectedId) return
        // An explicit empty array is a tombstone: the user removed the
        // authority while this read was in flight or during a quick
        // away-and-back chat switch. Never resurrect it from stale disk state.
        const liveHasChatReferences = Object.prototype.hasOwnProperty.call(latest.chatReferencesBySession, selectedId)
        const liveHasTeamReferences = Object.prototype.hasOwnProperty.call(latest.teamReferencesBySession, selectedId)
        if (liveHasChatReferences && liveHasTeamReferences) return
        const parsed = liveHasChatReferences
          ? parseStoredChatReferences(latest.chatReferencesBySession[selectedId], text, selectedId)
          : parseStoredChatReferences(storedChatReferences, text, selectedId)
        const parsedTeam = liveHasTeamReferences
          ? parseStoredTeamReferences(latest.teamReferencesBySession[selectedId], text)
          : parseStoredTeamReferences(storedTeamReferences, text)
        const restored = canonicalizeComposerReferences(text, parsed, parsedTeam, selectedId, routeHintsSupported)
        const wasCanonicalized = restored.text !== text
          || restored.chatReferences.some((reference, index) => reference.action !== parsed[index]?.action)
        draftRef.current = restored.text
        referencesRef.current = restored.chatReferences
        teamReferencesRef.current = restored.teamReferences
        referencesDirtyRef.current = wasCanonicalized
        teamReferencesDirtyRef.current = false
        setDraft(restored.text)
        setReferences(restored.chatReferences)
        setTeamReferences(restored.teamReferences)
        latest.setDraftForSession(selectedId, restored.text)
        latest.setChatReferencesForSession(selectedId, restored.chatReferences)
        latest.setTeamReferencesForSession(selectedId, restored.teamReferences)
      }
    }).catch(() => undefined)
  }, [activeProfileId, profileGeneration, routeHintsSupported, selectedId, serverIdentity, workspaceKey])

  useEffect(() => {
    const flush = (event: Event) => {
      const context = draftContextRef.current
      const state = useAppStore.getState()
      if (!context.sessionId || state.activeProfileId !== context.profileId || state.profileGeneration !== context.profileGeneration || activeIdentity(state) !== context.serverIdentity) return
      const contextSessionId = context.sessionId
      const text = draftRef.current
      const validated = validComposerReferences(
        text,
        referencesRef.current,
        teamReferencesRef.current,
        (value, candidates) => validChatReferences(value, candidates, contextSessionId)
      )
      state.setDraftForSession(contextSessionId, text)
      state.setChatReferencesForSession(contextSessionId, validated.chatReferences)
      state.setTeamReferencesForSession(contextSessionId, validated.teamReferences)
      const persistence = Promise.all([
        Promise.resolve().then(() => setWorkspacePreference(draftPreferenceScope(context), `draft:${contextSessionId}`, text)),
        ...(validated.chatReferences.length || referencesDirtyRef.current
          ? [Promise.resolve().then(() => setWorkspacePreference(draftPreferenceScope(context), chatReferencesPreferenceKey(contextSessionId), validated.chatReferences))]
          : []),
        ...(validated.teamReferences.length || teamReferencesDirtyRef.current
          ? [Promise.resolve().then(() => setWorkspacePreference(draftPreferenceScope(context), teamReferencesPreferenceKey(contextSessionId), validated.teamReferences))]
          : []),
        awaitAllClaudePermissionUpdates(),
        awaitAllCodexPermissionUpdates(),
        awaitAllOpenCodePermissionUpdates(),
        awaitAllCursorPermissionUpdates()
      ]).then(() => {
        referencesDirtyRef.current = false
        teamReferencesDirtyRef.current = false
      })
      const detail = (event as CustomEvent<DraftFlushEventDetail>).detail
      if (Array.isArray(detail?.promises)) detail.promises.push(persistence)
      else detail?.waitUntil?.(persistence)
    }
    window.addEventListener('agentsdock:flush-draft', flush)
    return () => window.removeEventListener('agentsdock:flush-draft', flush)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const timer = window.setTimeout(() => {
      const current = useAppStore.getState()
      if (!mountedRef.current || current.activeProfileId !== activeProfileId || current.profileGeneration !== profileGeneration || activeIdentity(current) !== serverIdentity || draftContextRef.current.sessionId !== selectedId || current.switchingProfileId) return
      // A send can consume the composer before React runs this effect's
      // cleanup. Do not let that expired snapshot republish the sent message.
      if (draftRef.current !== draft || referencesRef.current !== references || teamReferencesRef.current !== teamReferences) return
      const validated = validComposerReferences(
        draft,
        references,
        teamReferences,
        (value, candidates) => validChatReferences(value, candidates, selectedId)
      )
      commitComposerSnapshot(selectedId, draft, validated.chatReferences, validated.teamReferences)
      const writes = [setWorkspacePreference({ profileId: activeProfileId!, profileGeneration, serverIdentity }, `draft:${selectedId}`, draft)]
      if (validated.chatReferences.length || referencesDirtyRef.current) {
        writes.push(setWorkspacePreference({ profileId: activeProfileId!, profileGeneration, serverIdentity }, chatReferencesPreferenceKey(selectedId), validated.chatReferences))
      }
      if (validated.teamReferences.length || teamReferencesDirtyRef.current) {
        writes.push(setWorkspacePreference({ profileId: activeProfileId!, profileGeneration, serverIdentity }, teamReferencesPreferenceKey(selectedId), validated.teamReferences))
      }
      void Promise.all(writes).then(() => {
        if (draftRef.current === draft) draftDirtyRef.current = false
        referencesDirtyRef.current = false
        teamReferencesDirtyRef.current = false
      }).catch(() => undefined)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [activeProfileId, draft, profileGeneration, references, selectedId, serverIdentity, teamReferences])

  useEffect(() => {
    const current = useAppStore.getState()
    if (storedDraft && !draft && !draftDirtyRef.current && mountedRef.current && activeProfileId === current.activeProfileId && profileGeneration === current.profileGeneration && serverIdentity === activeIdentity(current) && selectedId === draftContextRef.current.sessionId) {
      draftRef.current = storedDraft
      setDraft(storedDraft)
    }
  }, [activeProfileId, draft, profileGeneration, selectedId, serverIdentity, storedDraft])

  useEffect(() => {
    const current = useAppStore.getState()
    if (!selectedId) return
    if (storedReferences.length && !references.length && mountedRef.current && activeProfileId === current.activeProfileId && profileGeneration === current.profileGeneration && serverIdentity === activeIdentity(current) && selectedId === draftContextRef.current.sessionId) {
      const parsed = parseStoredChatReferences(storedReferences, draftRef.current, selectedId)
      const restored = canonicalizeComposerReferences(
        draftRef.current,
        parsed,
        teamReferencesRef.current,
        selectedId,
        routeHintsSupported
      )
      const wasCanonicalized = restored.text !== draftRef.current
        || restored.chatReferences.some((reference, index) => reference.action !== parsed[index]?.action)
      draftRef.current = restored.text
      referencesRef.current = restored.chatReferences
      teamReferencesRef.current = restored.teamReferences
      referencesDirtyRef.current = wasCanonicalized
      setDraft(restored.text)
      setReferences(restored.chatReferences)
      setTeamReferences(restored.teamReferences)
      current.setDraftForSession(selectedId, restored.text)
      current.setChatReferencesForSession(selectedId, restored.chatReferences)
      current.setTeamReferencesForSession(selectedId, restored.teamReferences)
    }
  }, [activeProfileId, profileGeneration, references.length, routeHintsSupported, selectedId, serverIdentity, storedReferences])

  useEffect(() => {
    const current = useAppStore.getState()
    if (!selectedId) return
    if (storedTeamReferences.length && !teamReferences.length && mountedRef.current && activeProfileId === current.activeProfileId && profileGeneration === current.profileGeneration && serverIdentity === activeIdentity(current) && selectedId === draftContextRef.current.sessionId) {
      const restored = canonicalizeComposerReferences(
        draftRef.current,
        referencesRef.current,
        parseStoredTeamReferences(storedTeamReferences, draftRef.current),
        selectedId,
        routeHintsSupported
      )
      draftRef.current = restored.text
      referencesRef.current = restored.chatReferences
      teamReferencesRef.current = restored.teamReferences
      setDraft(restored.text)
      setReferences(restored.chatReferences)
      setTeamReferences(restored.teamReferences)
      current.setDraftForSession(selectedId, restored.text)
      current.setChatReferencesForSession(selectedId, restored.chatReferences)
      current.setTeamReferencesForSession(selectedId, restored.teamReferences)
    }
  }, [activeProfileId, profileGeneration, routeHintsSupported, selectedId, serverIdentity, storedTeamReferences, teamReferences.length])

  const send = async (steer = false, promptOverride?: string, consumeComposer = true) => {
    if (writeDisabled) return
    if (steer && running && session?.backend === 'opencode') { useAppStore.getState().setError(t('opencode.steerUnavailable')); return }
    if (!profileIsActive(activeProfileId, profileGeneration)) return
    let steerConsent: InboundDeliveryConsent | undefined
    if (steer && selectedId) {
      const consent = confirmInboundDeliveryInterruption(selectedId, 'send_now')
      if (!consent) return
      steerConsent = consent
    }
    const liveState = useAppStore.getState()
    const liveSession = liveState.sessions.find(candidate => candidate.id === session?.id) ?? session
    const runtimeError = sessionRuntimeAdmissionError(liveSession, liveState.health, liveState.runtimeCatalog)
    if (runtimeError) {
      liveState.setError(runtimeError)
      return
    }
    const rawOutgoing = promptOverride ?? draft
    const boundProviderCommand = consumeComposer
      && providerCommandBindingRef.current
      && providerCommandBindingRef.current.contextKey === providerCommandsKey
      && draftUsesProviderCommand(rawOutgoing, providerCommandBindingRef.current)
        ? providerCommandBindingRef.current
        : null
    if (consumeComposer && providerCommandBindingRef.current && !boundProviderCommand) {
      providerCommandBindingRef.current = null
    }
    if (consumeComposer && referencesRef.current.length > MAX_CHAT_REFERENCES) {
      liveState.setError(`A message can reference at most ${MAX_CHAT_REFERENCES} chats. Remove a chat reference and try again.`)
      return
    }
    const parsedOutgoingReferences = consumeComposer
      ? validComposerReferences(
          rawOutgoing,
          referencesRef.current,
          teamReferencesRef.current,
          (text, candidates) => validChatReferences(text, candidates, selectedId)
        )
      : { chatReferences: [], teamReferences: [] }
    const canonicalOutgoing = canonicalizeComposerReferences(
      rawOutgoing,
      parsedOutgoingReferences.chatReferences,
      parsedOutgoingReferences.teamReferences,
      selectedId,
      consumeComposer && routeHintsSupported
    )
    const outgoing = canonicalOutgoing.text
    const outgoingReferences = canonicalOutgoing.chatReferences
    const outgoingTeamReferences = canonicalOutgoing.teamReferences
    if (consumeComposer && uploadPaths.length > 0) return
    if (!outgoing.trim() && (!consumeComposer || uploads.length === 0)) return
    if (consumeComposer && outgoing.trim().split(/\s/, 1)[0] === '/mail') {
      const capability = health?.capabilities?.agent_team_mail_v1
      if (
        capability?.available !== true
        || capability.features?.deterministic_server_message_command !== true
      ) {
        useAppStore.getState().setError(
          capability?.available === true
            ? t('teamNetwork.mention.deterministicUpdate')
            : capability?.message || t('teamNetwork.mention.mailUpdate')
        )
        return
      }
      if (!/^\/mail server \S+\s+[\s\S]*\S$/.test(outgoing.trim())) {
        useAppStore.getState().setError('Use /mail server <name> <message>. Server names must be one word and the message cannot be empty.')
        return
      }
    }
    if (consumeComposer && parsedOutgoingReferences.chatReferences.length !== referencesRef.current.length) {
      useAppStore.getState().setError('A chat reference was edited. Remove it and select the chat again.')
      return
    }
    if (consumeComposer && parsedOutgoingReferences.teamReferences.length !== teamReferencesRef.current.length) {
      useAppStore.getState().setError(t('teamNetwork.mention.referenceEdited'))
      return
    }
    if (outgoingReferences.some(reference => reference.target_kind !== 'secure_peer') && !crossChatSupported) {
      useAppStore.getState().setError('Cross-chat handoffs require a newer AgentsServer. Update the active server and try again.')
      return
    }
    if (outgoingReferences.some(reference => (
      reference.target_kind !== 'secure_peer'
      && reference.action === 'route'
      && reference.grant_intent !== true
    ))) {
      useAppStore.getState().setError('This draft contains a legacy route hint. Remove it and select @Chat again before sending.')
      return
    }
    if (outgoingReferences.some(reference => reference.target_kind === 'secure_peer')) {
      useAppStore.getState().setError(remoteAgentRouteUnavailable())
      return
    }
    if (!session) return
    if (consumeComposer && isStandaloneMcpCommand(outgoing) && session.backend !== 'claude') {
      useAppStore.getState().setError('/mcp is available in Claude chats only.')
      return
    }
    const claudeGoalCommand = session.backend === 'claude' && /^\s*\/goal\s*$/iu.test(outgoing)
    if (consumeComposer && session.backend === 'claude' && (isStandaloneMcpCommand(outgoing) || claudeGoalCommand)) {
      draftRef.current = ''
      draftDirtyRef.current = true
      referencesRef.current = []
      referencesDirtyRef.current = false
      teamReferencesRef.current = []
      teamReferencesDirtyRef.current = false
      setDraft('')
      setReferences([])
      setTeamReferences([])
      setCommandTrigger(null)
      setTeamMention(null)
      setTeamMentionCandidates([])
      setMention(null)
      setMentionCandidates([])
      if (selectedId) {
        useAppStore.getState().setDraftForSession(selectedId, '')
        useAppStore.getState().setChatReferencesForSession(selectedId, [])
        useAppStore.getState().setTeamReferencesForSession(selectedId, [])
        void Promise.all([
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), `draft:${selectedId}`, ''),
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), chatReferencesPreferenceKey(selectedId), []),
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), teamReferencesPreferenceKey(selectedId), [])
        ]).catch(() => undefined)
      }
      if (claudeGoalCommand) setClaudeGoalOpen(true)
      else setMcpDialogOpen(true)
      return
    }
    const admissionToken = useAppStore.getState().beginTurnAdmission(session.id)
    if (!admissionToken) return
    const staged = useAppStore.getState().stagePendingTurnSubmission(session.id, admissionToken, {
      prompt: outgoing,
      steer,
      consumeComposer,
      chatReferences: outgoingReferences,
      teamReferences: outgoingTeamReferences
    })
    if (!staged) {
      useAppStore.getState().endTurnAdmission(session.id, admissionToken)
      return
    }
    if (consumeComposer) {
      providerCommandBindingRef.current = null
      draftRef.current = ''
      // Keep the explicit empty draft authoritative until its debounced
      // persistence finishes. This also fences stale store notifications.
      draftDirtyRef.current = true
      referencesRef.current = []
      referencesDirtyRef.current = false
      teamReferencesRef.current = []
      teamReferencesDirtyRef.current = false
      setDraft('')
      setReferences([])
      setTeamReferences([])
      setMention(null)
      setMentionCandidates([])
      setTeamMention(null)
      setTeamMentionCandidates([])
      if (selectedId) {
        void Promise.all([
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), `draft:${selectedId}`, ''),
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), chatReferencesPreferenceKey(selectedId), []),
          setWorkspacePreference(draftPreferenceScope(draftContextRef.current), teamReferencesPreferenceKey(selectedId), [])
        ]).catch(() => undefined)
      }
    }
    let submissionAccepted = false
    try {
      const runtimeSnapshot = useAppStore.getState()
      const diagnostic = runtimeDiagnosticFor(runtimeSnapshot.health, runtimeSnapshot.runtimeCatalog, session.backend, session.codex_provider, session.codex_provider_catalog)
      if (diagnostic && !['ready', 'unknown'].includes(diagnostic.status)) {
        useAppStore.getState().setError([diagnostic.message, diagnostic.action].filter(Boolean).join(' '))
        return
      }
      if (session.backend === 'codex') {
        try {
          await awaitCodexPermissionUpdates(session.id)
        } catch (error) {
          reportActionError(error)
          return
        }
        if (!composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) return
      }
      if (session.backend === 'claude') {
        try {
          await awaitClaudePermissionUpdates(session.id)
        } catch (error) {
          reportActionError(error)
          return
        }
        if (!composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) return
      }
      if (session.backend === 'cursor') {
        try {
          await awaitCursorPermissionUpdates(session.id)
        } catch (error) {
          reportActionError(error)
          return
        }
        if (!composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) return
      }
      if (session.backend === 'opencode') {
        try { await awaitOpenCodePermissionUpdates(session.id) } catch (error) { reportActionError(error); return }
        if (!composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) return
      }
      const currentRuntimeState = useAppStore.getState()
      const currentSession = currentRuntimeState.sessions.find(candidate => candidate.id === session.id)
      const currentRuntimeError = sessionRuntimeAdmissionError(currentSession, currentRuntimeState.health, currentRuntimeState.runtimeCatalog)
      if (currentRuntimeError) {
        currentRuntimeState.setError(currentRuntimeError)
        return
      }
      try {
        await requireAllServersReferenceSupport(outgoingTeamReferences, activeProfileId, profileGeneration, serverIdentity)
      } catch (error) {
        if (composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) reportActionError(error)
        return
      }
      if (!composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, session.id, draftContextRef, mountedRef)) return
      const sent = await useAppStore.getState().sendPromptForSession(session.id, outgoing, steer, {
        consumeComposer,
        admissionToken,
        chatReferences: outgoingReferences,
        teamReferences: outgoingTeamReferences,
        skillSelection: boundProviderCommand?.selection,
        confirmSteer: steer
          ? () => Boolean(confirmInboundDeliveryInterruption(session.id, 'send_now', steerConsent))
          : undefined
      })
      submissionAccepted = sent
      if (sent) {
        trackEvent('message_sent')
        if (boundProviderCommand) {
          trackEvent(boundProviderCommand.kind.toLowerCase() === 'skill' ? 'slash_skill_used' : 'slash_command_used')
        }
        if (outgoingReferences.length > 0) trackEvent('chat_reference_sent')
        if (outgoingTeamReferences.length > 0) trackEvent('team_reference_sent')
      }
    } finally {
      if (!submissionAccepted) {
        useAppStore.getState().rollbackPendingTurnSubmission(session.id, admissionToken)
        const current = useAppStore.getState()
        if (consumeComposer && mountedRef.current && current.activeProfileId === activeProfileId && current.profileGeneration === profileGeneration && activeIdentity(current) === serverIdentity && draftContextRef.current.sessionId === selectedId) {
          // Local composer state is authoritative while a send is in flight.
          // Draft-store synchronization is deliberately debounced so typing
          // never fans out a global Zustand update per key.
          const newerDraft = draftRef.current
          const normalizedOutgoing = outgoing.trim()
          const outgoingLeadingWhitespace = outgoing.length - outgoing.trimStart().length
          const normalizedOutgoingReferences = validChatReferences(normalizedOutgoing, outgoingReferences.map(reference => ({
            ...reference,
            source_text_start: reference.source_text_start - outgoingLeadingWhitespace,
            source_text_end: reference.source_text_end - outgoingLeadingWhitespace
          })), selectedId)
          const normalizedOutgoingTeamReferences = validTeamReferences(normalizedOutgoing, outgoingTeamReferences.map(reference => ({
            ...reference,
            source_text_start: reference.source_text_start - outgoingLeadingWhitespace,
            source_text_end: reference.source_text_end - outgoingLeadingWhitespace
          })))
          const hasNewerDraft = Boolean(newerDraft.trim())
          const sameDraft = hasNewerDraft && newerDraft.trim() === normalizedOutgoing
          const separator = normalizedOutgoing && hasNewerDraft ? '\n\n' : ''
          const restored = sameDraft ? newerDraft : hasNewerDraft
            ? `${normalizedOutgoing}${separator}${newerDraft}`
            : normalizedOutgoing
          const newerReferenceOffset = normalizedOutgoing.length + separator.length
          const newerReferences = validChatReferences(newerDraft, referencesRef.current, selectedId)
          const newerTeamReferences = validTeamReferences(newerDraft, teamReferencesRef.current)
          const restoredReferences = sameDraft ? newerReferences : hasNewerDraft
            ? [
                ...normalizedOutgoingReferences,
                ...newerReferences.map(reference => ({
                  ...reference,
                  source_text_start: reference.source_text_start + newerReferenceOffset,
                  source_text_end: reference.source_text_end + newerReferenceOffset
                }))
              ]
            : normalizedOutgoingReferences
          const restoredTeamReferences = sameDraft ? newerTeamReferences : hasNewerDraft
            ? [
                ...normalizedOutgoingTeamReferences,
                ...newerTeamReferences.map(reference => ({
                  ...reference,
                  source_text_start: reference.source_text_start + newerReferenceOffset,
                  source_text_end: reference.source_text_end + newerReferenceOffset
                }))
              ]
            : normalizedOutgoingTeamReferences
          draftRef.current = restored
          draftDirtyRef.current = false
          referencesRef.current = restoredReferences
          referencesDirtyRef.current = true
          teamReferencesRef.current = restoredTeamReferences
          teamReferencesDirtyRef.current = true
          if (boundProviderCommand) {
            providerCommandCache.delete(boundProviderCommand.contextKey)
            void loadProviderCommands(true, true)
          }
          setDraft(restored)
          setReferences(restoredReferences)
          setTeamReferences(restoredTeamReferences)
          current.setDraftForSession(selectedId!, restored)
          current.setChatReferencesForSession(selectedId!, restoredReferences)
          current.setTeamReferencesForSession(selectedId!, restoredTeamReferences)
        }
      }
      useAppStore.getState().endTurnAdmission(session.id, admissionToken)
    }
  }

  const steerFirstQueued = async () => {
    if (running && session?.backend === 'opencode') { reportActionError(t('opencode.steerUnavailable')); return }
    if (writeDisabled) return
    if (!selectedId || !steeringScope) return
    if (!profileIsActive(activeProfileId, profileGeneration)) return
    const steerConsent = confirmInboundDeliveryInterruption(selectedId, 'send_now')
    if (!steerConsent) return
    try {
      const request = useAppStore.getState().beginQueuedTurnsRequest(selectedId)
      const result = await steerFirstQueuedTurn(steeringScope, turn => {
        if (queuedTurnHasRemoteAgentRoute(turn)) return remoteAgentRouteUnavailable()
        const state = useAppStore.getState()
        const source = state.sessions.find(candidate => candidate.id === selectedId) ?? session
        return queuedTurnRuntimeAdmissionError(turn, source, state.health, state.runtimeCatalog)
      }, () => Boolean(confirmInboundDeliveryInterruption(selectedId, 'send_now', steerConsent)),
      asyncQueuedMessageControlsAvailable(useAppStore.getState().health))
      if (profileIsActive(activeProfileId, profileGeneration)) {
        useAppStore.getState().applyQueuedTurnsResponse(selectedId, request, result.turns)
      }
    } catch (error) {
      if (!isSteeringCancellation(error) && profileIsActive(activeProfileId, profileGeneration)) reportActionError(error)
    }
  }

  const addFiles = async (refs: NativeFileRef[]) => {
    if (selectedId && composerSessionIsCurrent(activeProfileId, profileGeneration, serverIdentity, selectedId, draftContextRef, mountedRef)) {
      await useAppStore.getState().attachPathsForSession(selectedId, refs)
    }
  }
  const chooseFiles = async () => {
    if (writeDisabled) return
    const sessionId = selectedId
    if (!sessionId) return
    try {
      const refs = await window.agentsDock.files.choose()
      if (!composerSessionIsCurrent(
        activeProfileId, profileGeneration, serverIdentity, sessionId, draftContextRef, mountedRef
      )) return
      await useAppStore.getState().attachPathsForSession(sessionId, refs)
    } catch (error) {
      if (composerSessionIsCurrent(
        activeProfileId, profileGeneration, serverIdentity, sessionId, draftContextRef, mountedRef
      )) reportActionError(error)
    }
  }
  const handleFiles = async (files: FileList | File[]) => {
    if (writeDisabled) return
    try {
      const refs = await nativeFileRefsFromFiles(files)
      if (refs.length) await addFiles(refs)
    } catch (error) {
      if (selectedId && composerSessionIsCurrent(
        activeProfileId, profileGeneration, serverIdentity, selectedId, draftContextRef, mountedRef
      )) reportActionError(error)
    }
  }

  useEffect(() => {
    setMentionIndex(index => Math.max(0, Math.min(index, Math.max(0, mentionCandidates.length - 1))))
  }, [mentionCandidates.length])

  const storeReferences = (next: ChatReference[]) => {
    if (shallowReferenceArraysEqual(referencesRef.current, next)) return
    if (referencesRef.current.length > 0 || next.length > 0) referencesDirtyRef.current = true
    referencesRef.current = next
    setReferences(next)
    if (selectedId) useAppStore.getState().setChatReferencesForSession(selectedId, next)
  }
  const storeTeamReferences = (next: TeamReference[]) => {
    if (shallowReferenceArraysEqual(teamReferencesRef.current, next)) return
    if (teamReferencesRef.current.length > 0 || next.length > 0) teamReferencesDirtyRef.current = true
    teamReferencesRef.current = next
    setTeamReferences(next)
    if (selectedId) useAppStore.getState().setTeamReferencesForSession(selectedId, next)
  }
  const updateComposerDraft = (nextText: string, caret: number) => {
    // The overwhelmingly common draft has no structured references. Preserve
    // the stable empty arrays instead of reconciling, validating and sorting
    // fresh arrays for every character.
    const nextReferences = referencesRef.current.length === 0 && teamReferencesRef.current.length === 0
      ? { chatReferences: referencesRef.current, teamReferences: teamReferencesRef.current }
      : validComposerReferences(
        nextText,
        reconcileChatReferences(draftRef.current, nextText, referencesRef.current),
        reconcileTeamReferences(draftRef.current, nextText, teamReferencesRef.current),
        (text, candidates) => validChatReferences(text, candidates, selectedId)
      )
    draftRef.current = nextText
    draftDirtyRef.current = true
    setDraft(nextText)
    storeReferences(nextReferences.chatReferences)
    storeTeamReferences(nextReferences.teamReferences)
    const commandMatch = matchComposerCommands(nextText, caret, allComposerCommands, commandAvailable)
    const rawCommandTrigger = composerCommandTrigger(nextText, caret)
    const waitForProviderCommands = Boolean(
      rawCommandTrigger
      && providerCommandsKey
      && ['idle', 'loading', 'error'].includes(activeProviderCommandState.status)
    )
    const nextCommandTrigger = commandMatch?.trigger ?? (waitForProviderCommands ? rawCommandTrigger : null)
    const binding = providerCommandBindingRef.current
    if (binding && !draftUsesProviderCommand(nextText, binding)) providerCommandBindingRef.current = null
    const nextTeamMention = nextCommandTrigger
      ? null
      : teamMentionTrigger(nextText, caret, nextReferences.chatReferences, nextReferences.teamReferences)
    const nextMention = nextCommandTrigger || nextTeamMention
      ? null
      : chatMentionTrigger(nextText, caret, nextReferences.chatReferences)
    setCommandTrigger(nextCommandTrigger)
    setCommandIndex(0)
    setTeamMention(nextTeamMention)
    setTeamMentionCandidates([])
    setTeamMentionIndex(0)
    setMention(nextMention)
    setMentionCandidates(nextMention && selectedId ? currentMentionCandidates(nextMention, selectedId, supportedTargetBackends, crossChatSupported) : [])
    setMentionIndex(0)
  }
  const focusCommandSession = () => {
    const state = useAppStore.getState()
    const pane = state.chatPanes.primary === session?.id
      ? 'primary'
      : state.chatPanes.secondary === session?.id
        ? 'secondary'
        : null
    if (pane) state.focusChatPane(pane)
  }
  const replaceCommand = (replacement = '', restoreCaret = true) => {
    if (!commandTrigger) return
    const next = `${draftRef.current.slice(0, commandTrigger.start)}${replacement}${draftRef.current.slice(commandTrigger.end)}`
    const caret = commandTrigger.start + replacement.length
    pendingCaretRef.current = restoreCaret ? caret : null
    updateComposerDraft(next, caret)
  }
  const chooseCommand = (command: ComposerCommand) => {
    if (!session || !commandTrigger || !commandAvailable(command)) return
    if (command.provider) {
      const invocation = command.provider.command.invocation
      providerCommandBindingRef.current = {
        contextKey: providerCommandsKey!,
        invocation,
        name: command.provider.command.name,
        kind: command.provider.command.kind,
        selection: command.provider.selection
      }
      // Provider selections must start at byte zero to match the server's
      // revalidation contract. The general slash palette permits indentation,
      // so canonicalize only dynamic provider invocations when selected.
      const replacement = `${invocation} `
      pendingCaretRef.current = replacement.length
      updateComposerDraft(replacement, replacement.length)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    if (command.id === 'chat') {
      replaceCommand('/chat ')
      return
    }
    if (command.id === 'mail') {
      const capability = health?.capabilities?.agent_team_mail_v1
      if (
        capability?.available !== true
        || capability.features?.deterministic_server_message_command !== true
      ) {
        useAppStore.getState().setError(
          capability?.available === true
            ? t('teamNetwork.mention.deterministicUpdate')
            : capability?.message || t('teamNetwork.mention.mailUpdate')
        )
        return
      }
      replaceCommand('/mail server ')
      return
    }
    replaceCommand('', false)
    focusCommandSession()
    if (command.id === 'attach') {
      void chooseFiles()
    } else if (command.id === 'digest') {
      useAppStore.getState().setModal('digest', true)
    } else if (command.id === 'feedback') {
      void window.agentsDock.native.openExternal('https://github.com/ZhengyiLuo/AgentsDock/issues/new').catch(reportActionError)
    } else if (command.id === 'goal') {
      openGoalControls()
    } else if (command.id === 'import') {
      useAppStore.getState().setModal('importChats', true)
    } else if (command.id === 'model' || command.id === 'reasoning') {
      setRuntimeMenuSection(command.id)
      setRuntimeMenuOpen(true)
    } else if (command.id === 'mcp') {
      setMcpDialogOpen(true)
    } else if (command.id === 'new') {
      void useAppStore.getState().requestNewChat()
    } else if (command.id === 'permissions' || command.id === 'plan') {
      setPermissionMenuOpen(true)
    } else if (command.id === 'schedule') {
      useAppStore.getState().setModal('job', true)
    } else if (command.id === 'settings') {
      useAppStore.getState().setModal('appSettings', true)
    } else if (command.id === 'split') {
      window.dispatchEvent(new CustomEvent('agentsdock:open-split-chat-menu', {
        detail: { sessionId: session.id }
      }))
    } else if (command.id === 'status') {
      useAppStore.getState().setInspectorVisible(true)
    } else if (command.id === 'workdir') {
      setWorkingDirectoryOpen(true)
    }
  }
  const chooseMention = (target: ChatMentionCandidate) => {
    if (!mention || !crossChatSupported) return
    const action: ChatReferenceAction = 'route'
    if (!action || !supportedChatActions.includes(action)) {
      useAppStore.getState().setError('Update AgentsServer to use inline @Chat route hints.')
      setMention(null)
      setMentionCandidates([])
      return
    }
    const targetId = target.session.id
    const targetTitle = target.session.title
    if (referencesRef.current.some(reference => reference.session_id === targetId && reference.action === action)) {
      useAppStore.getState().setError(`${chatReferenceLabel(action)} is already selected for ${targetTitle}.`)
      setMention(null)
      setMentionCandidates([])
      return
    }
    if (referencesRef.current.length >= MAX_CHAT_REFERENCES) {
      useAppStore.getState().setError(`A message can reference at most ${MAX_CHAT_REFERENCES} chats. Remove a chat reference before adding another.`)
      setMention(null)
      setMentionCandidates([])
      return
    }
    if (
      !grantedTargetIds.has(target.session.id)
      && !pendingGrantTargetIds.has(target.session.id)
      && remainingNewRouteCapacity !== null
      && remainingNewRouteCapacity < 1
    ) {
      const maximum = agentRouteSnapshot?.max_routes ?? grantedRoutes.length
      useAppStore.getState().setError(`This chat has reached its route access limit (${maximum} ${maximum === 1 ? 'route' : 'routes'} maximum). Revoke a granted route before adding another chat.`)
      setMention(null)
      setMentionCandidates([])
      return
    }
    let inserted: ReturnType<typeof insertChatReference>
    try {
      inserted = insertChatReference(draftRef.current, mention, target.session, action, { grantIntent: true })
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      setMention(null)
      setMentionCandidates([])
      return
    }
    const shifted = reconcileChatReferences(draftRef.current, inserted.text, referencesRef.current)
    const shiftedTeam = reconcileTeamReferences(draftRef.current, inserted.text, teamReferencesRef.current)
    const nextReferences = validComposerReferences(
      inserted.text,
      [...shifted, inserted.reference],
      shiftedTeam,
      (text, candidates) => validChatReferences(text, candidates, selectedId)
    )
    draftRef.current = inserted.text
    pendingCaretRef.current = inserted.caret
    setDraft(inserted.text)
    useAppStore.getState().setDraftForSession(session!.id, inserted.text)
    storeReferences(nextReferences.chatReferences)
    storeTeamReferences(nextReferences.teamReferences)
    setMention(null)
    setMentionCandidates([])
  }
  const chooseTeamMention = (candidate: TeamMentionCandidate) => {
    if (!teamMention || !teamMentionsSupported) return
    const duplicate = teamReferencesRef.current.some(reference => (
      reference.kind === candidate.target.kind
      && (candidate.target.kind !== 'recipient'
        || (reference.kind === 'recipient' && reference.recipient_kind === candidate.target.recipient_kind))
      && reference.team_id === candidate.target.team_id
      && reference.target_id === candidate.target.target_id
    ))
    if (duplicate) {
      useAppStore.getState().setError(`${candidate.label} is already selected.`)
      setTeamMention(null)
      setTeamMentionCandidates([])
      return
    }
    try {
      const inserted = insertTeamReference(draftRef.current, teamMention, candidate.target)
      const shiftedChat = reconcileChatReferences(draftRef.current, inserted.text, referencesRef.current)
      const shiftedTeam = reconcileTeamReferences(draftRef.current, inserted.text, teamReferencesRef.current)
      const validated = validComposerReferences(
        inserted.text,
        shiftedChat,
        [...shiftedTeam, inserted.reference],
        (text, candidates) => validChatReferences(text, candidates, selectedId)
      )
      draftRef.current = inserted.text
      pendingCaretRef.current = inserted.caret
      setDraft(inserted.text)
      useAppStore.getState().setDraftForSession(session!.id, inserted.text)
      storeReferences(validated.chatReferences)
      storeTeamReferences(validated.teamReferences)
      setTeamMention(null)
      setTeamMentionCandidates([])
    } catch (error) {
      reportActionError(error)
      setTeamMention(null)
      setTeamMentionCandidates([])
    }
  }
  if (!session) return <div className="composer disabled"><span>{t("ui.Composer.Composer.select_or_create_a_chat_to_begin_3a0c22a")}</span></div>
  return (
    <div className="composer-dock">
      {!window.agentsDock.sharedChat && <div className="composer-context-row">
        <WorkingDirectoryPopover session={session} />
      </div>}
      <fieldset className="composer-goal-controls" disabled={writeDisabled}><CodexGoalBar /></fieldset>
      <ClaudeGoalControls open={claudeGoalOpen} onOpenChange={setClaudeGoalOpen} disabled={writeDisabled} />
      <div className={`composer ${dropActive ? 'drop-active' : ''}${writeDisabled ? ' write-disabled' : ''}`}>
      <div className="composer-scroll-region">
        <fieldset className="composer-queue-controls" disabled={writeDisabled}>
        <QueueShelf
        profileId={activeProfileId}
        profileGeneration={profileGeneration}
        serverIdentity={serverIdentity}
        sessionId={session.id}
        turns={visibleQueuedTurns}
        queueOrderTurns={queuedTurns}
        pendingSubmission={pendingSubmission?.mode === 'queue' ? pendingSubmission : undefined}
        running={running}
        activeCodexGoal={activeCodexGoal}
        steeringPending={steeringPending}
        sourceSession={session}
        supportedChatActions={supportedChatActions}
        supportedTargetBackends={supportedTargetBackends}
        routeHintsSupported={routeHintsSupported}
        teamMentionsSupported={teamMentionsSupported}
      />
        </fieldset>
      {(uploads.length > 0 || uploadPaths.length > 0) && <AttachmentShelf sessionId={session.id} profileId={activeProfileId} profileGeneration={profileGeneration} files={uploads} pending={uploadPaths} />}
      <RuntimeHealthNotice backend={session.backend} codexProvider={session.codex_provider} sessionId={session.id} />
      {selectedRuntimeError && !(session.backend === 'cursor' && !cursorPermissionsAvailable) && <span className="chat-reference-warning">{selectedRuntimeError}</span>}
      {activeInboundDeliveryKind && <span className={activeInboundDeliveryKind === 'unknown' ? 'composer-sync-status' : 'chat-reference-warning'} role="status">{activeInboundDeliveryKind === 'unknown'
        ? t("ui.Composer.Composer.an_active_turn_is_running_while_chat_sync__2265ac1")
        : activeInboundDeliveryKind === 'secure_peer'
          ? 'An incoming encrypted peer delivery is running. Stop or Send now will interrupt it.'
          : t("ui.Composer.Composer.an_incoming_delivery_is_running_stop_or_se_92e6678", { "delivery": 'chat-to-chat' })}</span>}
      <div className={`composer-editor${hasInlineReferences ? ' has-inline-references' : ''}${hasMessageLinks ? ' has-message-links' : ''}`}>
        {(hasInlineReferences || hasMessageLinks) && <ComposerEditorMirror
          ref={editorMirrorRef}
          text={messageProjection.text}
          chatReferences={hasInlineReferences ? displayedReferenceSet.chatReferences : EMPTY_CHAT_REFERENCES}
          teamReferences={hasInlineReferences ? displayedReferenceSet.teamReferences : EMPTY_TEAM_REFERENCES}
          messageLinks={messageProjection.links}
          onEdit={() => textareaRef.current?.focus()}
          referenceSupported={reference => referenceSupported({
            ...reference,
            source_text_start: composerDisplayToSource(messageProjection, reference.source_text_start),
            source_text_end: composerDisplayToSource(messageProjection, reference.source_text_end)
          })}
          teamReferencesSupported={composerTeamReferencesSupported}
        />}
        <textarea
          ref={textareaRef}
          value={messageProjection.text}
          rows={1}
          placeholder={t("ui.Composer.Composer.message_2f77668")}
          aria-label={sessionId === undefined ? t("ui.Composer.Composer.message_2f77668") : t("ui.Composer.Composer.message_0429845", { "title": String(session.title) })}
          spellCheck
          aria-autocomplete="list"
          aria-expanded={Boolean(commandPaletteVisible || teamMention || mention)}
          aria-controls={commandPaletteVisible ? commandPaletteId : teamMention ? teamMentionPaletteId : mention ? mentionPaletteId : undefined}
          aria-activedescendant={commandCandidates[commandIndex]
            ? `${commandPaletteId}-${commandCandidates[commandIndex].id}`
            : teamMention && teamMentionCandidates[teamMentionIndex]
              ? `${teamMentionPaletteId}-${teamMentionCandidates[teamMentionIndex].id}`
            : mention && mentionCandidates[mentionIndex]
              ? `${mentionPaletteId}-${mentionCandidates[mentionIndex].id}`
              : undefined}
          onChange={event => {
            if (paletteBlurTimerRef.current !== null) {
              window.clearTimeout(paletteBlurTimerRef.current)
              paletteBlurTimerRef.current = null
            }
            const edit = applyTeamMessageComposerEdit(
              projectTeamMessageComposer(draftRef.current), event.target.value,
              event.target.selectionStart, event.target.selectionEnd, nativeEditSelectionRef.current
            )
            nativeEditSelectionRef.current = null
            if (projectTeamMessageComposer(edit.source).text !== event.target.value) {
              pendingSelectionRef.current = {
                start: edit.selectionStart, end: edit.selectionEnd, direction: event.target.selectionDirection
              }
            }
            updateComposerDraft(edit.source, edit.selectionStart)
          }}
          onBeforeInput={event => {
            nativeEditSelectionRef.current = {
              source: draftRef.current, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd
            }
          }}
          onInput={event => {
            // React omits onChange when a selected link is replaced with the
            // same readable title. That native edit still removes its target.
            if (event.currentTarget.value !== messageProjection.text || !nativeEditSelectionRef.current) return
            const edit = applyTeamMessageComposerEdit(
              projectTeamMessageComposer(draftRef.current), event.currentTarget.value,
              event.currentTarget.selectionStart, event.currentTarget.selectionEnd, nativeEditSelectionRef.current
            )
            nativeEditSelectionRef.current = null
            if (edit.source !== draftRef.current) updateComposerDraft(edit.source, edit.selectionStart)
          }}
          onCut={event => {
            nativeEditSelectionRef.current = {
              source: draftRef.current, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd
            }
          }}
          onFocus={() => {
            if (paletteBlurTimerRef.current !== null) {
              window.clearTimeout(paletteBlurTimerRef.current)
              paletteBlurTimerRef.current = null
            }
          }}
          onClick={event => {
            if (paletteBlurTimerRef.current !== null) {
              window.clearTimeout(paletteBlurTimerRef.current)
              paletteBlurTimerRef.current = null
            }
            const rawCaret = event.currentTarget.selectionStart ?? event.currentTarget.value.length
            const projection = projectTeamMessageComposer(draftRef.current)
            const displayCaret = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
              ? atomicComposerReferenceCaret(rawCaret, [
                ...displayedReferenceSpans,
                ...projection.links.map(link => ({ source_text_start: link.displayStart, source_text_end: link.displayEnd }))
              ])
              : rawCaret
            if (displayCaret !== rawCaret) event.currentTarget.setSelectionRange(displayCaret, displayCaret)
            const caret = composerDisplayToSource(projection, displayCaret)
            const commandMatch = matchComposerCommands(draftRef.current, caret, allComposerCommands, commandAvailable)
            const rawCommandTrigger = composerCommandTrigger(draftRef.current, caret)
            const waitForProviderCommands = Boolean(
              rawCommandTrigger
              && providerCommandsKey
              && ['idle', 'loading', 'error'].includes(activeProviderCommandState.status)
            )
            const nextCommandTrigger = commandMatch?.trigger ?? (waitForProviderCommands ? rawCommandTrigger : null)
            const nextTeamMention = nextCommandTrigger
              ? null
              : teamMentionTrigger(draftRef.current, caret, referencesRef.current, teamReferencesRef.current)
            const nextMention = nextCommandTrigger || nextTeamMention
              ? null
              : chatMentionTrigger(draftRef.current, caret, referencesRef.current)
            setCommandTrigger(nextCommandTrigger)
            setCommandIndex(0)
            setTeamMention(nextTeamMention)
            setTeamMentionCandidates([])
            setTeamMentionIndex(0)
            setMention(nextMention)
            setMentionCandidates(nextMention && selectedId ? currentMentionCandidates(nextMention, selectedId, supportedTargetBackends, crossChatSupported) : [])
            setMentionIndex(0)
          }}
          onBlur={() => {
            if (paletteBlurTimerRef.current !== null) window.clearTimeout(paletteBlurTimerRef.current)
            paletteBlurTimerRef.current = window.setTimeout(() => {
              paletteBlurTimerRef.current = null
              setCommandTrigger(null)
              setTeamMention(null)
              setTeamMentionCandidates([])
              setMention(null)
              setMentionCandidates([])
            }, 100)
          }}
          onScroll={event => recordEditorMirrorAlignment(syncComposerEditorMirror(event.currentTarget, editorMirrorRef.current))}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            const projection = projectTeamMessageComposer(draftRef.current)
            const atomicSpans = [
              ...orderedComposerReferenceSpans(referencesRef.current, teamReferencesRef.current),
              ...projection.links.map(link => ({ source_text_start: link.start, source_text_end: link.end }))
            ].sort((left, right) => left.source_text_start - right.source_text_start)
            const collapsed = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            const selectionStart = composerDisplayToSource(projection, event.currentTarget.selectionStart, collapsed ? 'nearest' : 'start')
            const selectionEnd = composerDisplayToSource(projection, event.currentTarget.selectionEnd, collapsed ? 'nearest' : 'end')
            if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
              const edit = atomicComposerReferenceDeletion(
                draftRef.current,
                atomicSpans,
                selectionStart,
                selectionEnd,
                event.key
              )
              if (edit) {
                event.preventDefault()
                pendingCaretRef.current = edit.caret
                updateComposerDraft(edit.text, edit.caret)
                return
              }
            }
            if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
              const start = selectionStart
              const end = selectionEnd
              if (start === end) {
                const caret = atomicComposerReferenceNavigation(
                  start,
                  atomicSpans,
                  event.key
                )
                if (caret !== null) {
                  event.preventDefault()
                  const displayCaret = composerSourceToDisplay(projection, caret)
                  event.currentTarget.setSelectionRange(displayCaret, displayCaret)
                  return
                }
              }
            }
            if (commandPaletteVisible) {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setCommandTrigger(null)
                return
              }
              if (commandCandidates.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setCommandIndex(index => (
                  index + (event.key === 'ArrowDown' ? 1 : -1) + commandCandidates.length
                ) % commandCandidates.length)
                return
              }
              if (commandCandidates.length && (event.key === 'Home' || event.key === 'End')) {
                event.preventDefault()
                setCommandIndex(event.key === 'Home' ? 0 : commandCandidates.length - 1)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const command = commandCandidates[commandIndex]
                if (command) chooseCommand(command)
                return
              }
            }
            if (teamMention) {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setTeamMention(null)
                setTeamMentionCandidates([])
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (teamMentionCandidates.length) setTeamMentionIndex(index => (
                  index + (event.key === 'ArrowDown' ? 1 : -1) + teamMentionCandidates.length
                ) % teamMentionCandidates.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const candidate = teamMentionCandidates[teamMentionIndex]
                if (candidate && teamMentionsSupported) chooseTeamMention(candidate)
                return
              }
            }
            if (mention) {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setMention(null)
                setMentionCandidates([])
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (mentionCandidates.length) setMentionIndex(index => (
                  index + (event.key === 'ArrowDown' ? 1 : -1) + mentionCandidates.length
                ) % mentionCandidates.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const target = mentionCandidates[mentionIndex]
                if (target && crossChatSupported) chooseMention(target)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
              event.preventDefault()
              const forceSend = (event.metaKey || event.ctrlKey) && !steeringPending && session.backend !== 'opencode'
              if (canSend) void send(forceSend)
              else if (
                (event.metaKey || event.ctrlKey)
                && !draft.trim()
                && uploads.length === 0
                && uploadPaths.length === 0
              ) void steerFirstQueued()
            }
          }}
          onPaste={event => {
            if (event.clipboardData.files.length) { event.preventDefault(); void handleFiles(event.clipboardData.files) }
            else nativeEditSelectionRef.current = {
              source: draftRef.current, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd
            }
          }}
        />
      </div>
        {hasReferenceFallback && <ComposerReferenceFallback
          text={draft}
          chatReferences={inlineReferenceSet.chatReferences}
          teamReferences={inlineReferenceSet.teamReferences}
          referenceSupported={referenceSupported}
          teamReferencesSupported={composerTeamReferencesSupported}
        />}
        {!referencesSupported && <span className="chat-reference-warning">{!chatReferencesSupported
          ? hasRemoteAgentReference
            ? remoteAgentRouteUnavailable()
            : t("ui.Composer.Composer.one_or_more_legacy_chat_references_cannot__cb2ccfa")
          : unsupportedAllServersReference
            ? allServersNativeUpdateRequired()
            : t('teamNetwork.mention.referenceInvalid')}</span>}
      </div>
      {commandPaletteVisible && <ComposerCommandPalette
        id={commandPaletteId}
        commands={commandCandidates}
        selectedIndex={commandIndex}
        session={session}
        catalog={catalog}
        claudePermissionMode={claudePermissionMode ?? undefined}
        loadStatus={activeProviderCommandState.status}
        onRefresh={() => void loadProviderCommands(true)}
        onHighlight={setCommandIndex}
        onSelect={chooseCommand}
      />}
      {teamMention && <TeamMentionPalette
        id={teamMentionPaletteId}
        sourceSessionId={selectedId}
        mention={teamMention}
        selectedIndex={teamMentionIndex}
        supported={teamMentionsSupported}
        profileId={activeProfileId}
        profileGeneration={profileGeneration}
        serverIdentity={serverIdentity}
        onCandidates={setTeamMentionCandidates}
        onHighlight={setTeamMentionIndex}
        onSelect={chooseTeamMention}
      />}
      {mention && <ChatMentionPalette
        id={mentionPaletteId}
        mention={mention}
        selectedId={selectedId}
        selectedIndex={mentionIndex}
        supported={crossChatSupported}
        localSupported={crossChatSupported}
        supportedTargetBackends={supportedTargetBackends}
        requestReplySupportedForSource={requestReplySupportedForSource}
        maximumReferencesSelected={references.length >= MAX_CHAT_REFERENCES}
        pendingGrantTargetIds={pendingGrantTargetIds}
        remainingNewRouteCapacity={remainingNewRouteCapacity}
        grantedRoutes={grantedRoutes}
        grantsLoading={grantsLoading}
        grantsError={grantsError}
        revokingRouteIds={revokingAgentRouteIds}
        onCandidates={acceptMentionCandidates}
        onSelect={chooseMention}
        onRevoke={(routeId, revision) => selectedId
          ? useAppStore.getState().revokeAgentRoute(selectedId, routeId, revision)
          : Promise.resolve(false)}
      />}
      <fieldset className="composer-bar composer-write-controls" disabled={writeDisabled}>
        <div className="composer-secondary-controls">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button className="composer-icon composer-add-button" title={t("ui.Composer.Composer.add_9fd728c")} disabled={writeDisabled}><Plus size={18} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="start">
              <DropdownMenu.Item className="menu-item" onSelect={() => void chooseFiles()}><Paperclip size={14} />{" "}{t("ui.Composer.Composer.attach_files_e697cc1")}</DropdownMenu.Item>
              {goalControlsAvailable && <DropdownMenu.Item className="menu-item" onSelect={openGoalControls}><Goal size={14} />{goalTitle}</DropdownMenu.Item>}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Label className="menu-label">{t("ui.Composer.Composer.frequent_phrases_e257acc")}</DropdownMenu.Label>
              {[t("ui.Composer.Composer.status_report_b784026"), t("ui.Composer.Composer.keep_going_8fc6411"), t("ui.Composer.Composer.verify_the_result_carefully_b07a805")].map(phrase => <DropdownMenu.Item key={phrase} className="menu-item" onSelect={() => void send(false, phrase, false)}>{phrase}</DropdownMenu.Item>)}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
          {!window.agentsDock.sharedChat && <BackendMenu session={session} running={running} admitting={admitting} />}
          <RuntimeMenu
            session={session}
            running={running}
            admitting={admitting}
            open={runtimeMenuOpen}
            onOpenChange={open => {
              setRuntimeMenuOpen(open)
              if (!open) setRuntimeMenuSection(null)
            }}
            focusSection={runtimeMenuSection}
          />
          {session.backend === 'codex' && <CodexPermissionMenu session={session} open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen} />}
          {session.backend === 'codex' && <CodexContextIndicator />}
          {session.backend === 'claude' && <ClaudePermissionMenu session={session} running={running} open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen} />}
          {session.backend === 'claude' && <ClaudeContextIndicator />}
          {goalControlsAvailable && <button type="button" className="composer-icon" aria-label={goalTitle} title={goalTitle} onClick={openGoalControls}><Goal size={15} /></button>}
          {session.backend === 'cursor' && <CursorPermissionMenu session={session} running={running} open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen} />}
          {session.backend === 'opencode' && <OpenCodePermissionMenu session={session} running={running} open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen} />}
        </div>
        <div className="composer-actions">
          {(steeringPending || admitting) && <span className="steering-pending" role="status"><span className="activity-ring" /><span className="steering-pending-label">{
            steeringPending || pendingSubmissionMode === 'steer'
              ? running ? t("ui.Composer.Composer.sending_now_2e3b74f") : t("ui.Composer.Composer.starting_bbe5fc3")
              : pendingSubmissionMode === 'queue'
                ? t('timeline.ui.waitingToStart')
                : running
                  ? t('timeline.status.running')
                : t("ui.Composer.Composer.starting_bbe5fc3")
          }</span></span>}
          {running && <button
            type="button"
            className="stop-button"
            aria-label={stopping ? t("ui.Composer.Composer.stopping_bbe8574") : t("ui.Composer.Composer.stop_cae7d57")}
            disabled={writeDisabled || stopping}
            onClick={() => {
              if (!confirmInboundDeliveryInterruption(session.id, 'stop')) return
              void useAppStore.getState().stopTurnForSession(session.id)
            }}
            title={stopping ? t("ui.Composer.Composer.stopping_agent_ec42789") : t("ui.Composer.Composer.stop_f9da57a", { "provider": String(session.title) })}
          ><span className="activity-ring" /><Square size={12} fill="currentColor" /><span className="stop-button-label">{stopping ? t("ui.Composer.Composer.stopping_bbe8574") : t("ui.Composer.Composer.stop_cae7d57")}</span></button>}
          <ShortcutTooltip shortcut={running && session.backend !== 'opencode' ? ['sendMessage', 'steerMessage'] : 'sendMessage'} label={running ? session.backend === 'opencode' ? t("ui.Composer.Composer.queue_message_891d4ef") : activeCodexGoal ? t('composer.queueMessageDuringGoal') : t("ui.Composer.Composer.queue_message_steer_now_eea53cb") : t("ui.Composer.Composer.send_message_93a26b1")}><button className="send-button" aria-label={sessionId === undefined ? (running ? t("ui.Composer.Composer.queue_message_891d4ef") : t("ui.Composer.Composer.send_message_93a26b1")) : t(running ? 'ui.composer.queueFor' : 'ui.composer.sendTo', { title: session.title })} disabled={!canSend} onClick={() => void send()}><Send size={17} /></button></ShortcutTooltip>
        </div>
      </fieldset>
      <div className="drop-overlay" role="status" aria-label={dropActive ? t("ui.Composer.Composer.drop_to_attach_34a7a63") : undefined} aria-live="polite" aria-atomic="true" aria-hidden={!dropActive}>
        <Paperclip size={15} aria-hidden="true" /> <span>{t("ui.Composer.Composer.drop_to_attach_34a7a63")}</span>
      </div>
      {!window.agentsDock.sharedChat && <WorkingDirectoryCommandDialog
        open={workingDirectoryOpen}
        session={session}
        onOpenChange={setWorkingDirectoryOpen}
      />}
      <ClaudeMcpDialog
        open={mcpDialogOpen}
        session={session}
        running={running}
        supported={claudeMcpCapabilityAdvertised(claudeControls)}
        onOpenChange={setMcpDialogOpen}
      />
      </div>
    </div>
  )
})

const ComposerEditorMirror = forwardRef<HTMLDivElement, {
  text: string
  chatReferences: readonly ChatReference[]
  teamReferences: readonly TeamReference[]
  referenceSupported: (reference: ChatReference) => boolean
  teamReferencesSupported: boolean
  messageLinks?: readonly ComposerMessageLink[]
  onEdit?: () => void
}>(function ComposerEditorMirror({ text, chatReferences, teamReferences, referenceSupported, teamReferencesSupported, messageLinks = [], onEdit }, ref) {
  useLocale()
  const valid = validComposerReferences(
    text,
    chatReferences,
    teamReferences,
    (value, candidates) => validChatReferences(value, candidates)
  )
  const entries = [
    ...valid.chatReferences.map(reference => ({ kind: 'chat' as const, reference })),
    ...valid.teamReferences.map(reference => ({ kind: 'team' as const, reference })),
    ...messageLinks.map(link => ({ kind: 'link' as const, reference: {
      ...link, source_text_start: link.displayStart, source_text_end: link.displayEnd
    } }))
  ].sort((left, right) => left.reference.source_text_start - right.reference.source_text_start)
  const content: ReactNode[] = []
  let offset = 0
  for (const entry of entries) {
    const { reference } = entry
    if (reference.source_text_start > offset) content.push(text.slice(offset, reference.source_text_start))
    if (entry.kind === 'link') {
      const link = entry.reference
      content.push(<a
        key={`link:${link.start}`}
        className="composer-inline-message-link"
        href={link.href}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          openTeamMessageLink(link.href)
        }}
      >{link.label}</a>)
      offset = reference.source_text_end
      continue
    }
    content.push(<span
      key={entry.kind === 'chat'
        ? `chat:${entry.reference.session_id}:${reference.source_text_start}:${entry.reference.action}`
        : `team:${entry.reference.team_id}:${entry.reference.target_id}:${reference.source_text_start}`}
      className={entry.kind === 'chat'
        ? `composer-inline-reference action-${entry.reference.action}${referenceSupported(entry.reference) ? '' : ' unsupported'}`
        : `composer-inline-reference action-route team-reference${teamReferencesSupported ? '' : ' unsupported'}`}
      data-chat-reference-action={entry.kind === 'chat' ? entry.reference.action : undefined}
      data-team-reference-kind={entry.kind === 'team' ? entry.reference.kind : undefined}
      title={entry.kind === 'chat'
        ? `${chatReferenceDisplayText(text, entry.reference)} · ${chatReferenceLabel(entry.reference.action)}`
        : `${teamReferenceText(entry.reference)} · ${teamReferenceLabel(entry.reference)}`}
    >{text.slice(reference.source_text_start, reference.source_text_end)}</span>)
    offset = reference.source_text_end
  }
  if (offset < text.length) content.push(text.slice(offset))
  return <div
    ref={ref}
    className="composer-editor-mirror"
    aria-hidden={messageLinks.length ? undefined : true}
    aria-label={messageLinks.length ? t('teamNetwork.mention.messagePreview') : undefined}
    onClick={onEdit}
  >{content}</div>
})

function ComposerReferenceFallback({
  text,
  chatReferences,
  teamReferences,
  referenceSupported,
  teamReferencesSupported
}: {
  text: string
  chatReferences: readonly ChatReference[]
  teamReferences: readonly TeamReference[]
  referenceSupported: (reference: ChatReference) => boolean
  teamReferencesSupported: boolean
}) {
  const locale = useLocale()
  const uiLocale = locale
  const entries = [
    ...chatReferences.map(reference => ({ kind: 'chat' as const, reference })),
    ...teamReferences.map(reference => ({ kind: 'team' as const, reference }))
  ].sort((left, right) => left.reference.source_text_start - right.reference.source_text_start)
  return <div className="composer-reference-fallback" role="group" aria-label={t('merge.composer.selectedReferences', undefined, uiLocale)}>
    <span className="composer-reference-fallback-label">{t('merge.composer.references', undefined, uiLocale)}</span>
    {entries.map(entry => entry.kind === 'chat'
      ? <span
        key={`chat:${entry.reference.session_id}:${entry.reference.source_text_start}:${entry.reference.action}`}
        className={`composer-inline-reference action-${entry.reference.action}${referenceSupported(entry.reference) ? '' : ' unsupported'}`}
        data-chat-reference-action={entry.reference.action}
        title={`${chatReferenceDisplayText(text, entry.reference)} · ${chatReferenceLabel(entry.reference.action)}`}
      >{chatReferenceDisplayText(text, entry.reference)}</span>
      : <span
        key={`team:${entry.reference.team_id}:${entry.reference.target_id}:${entry.reference.source_text_start}`}
        className={`composer-inline-reference action-route team-reference${teamReferencesSupported ? '' : ' unsupported'}`}
        data-team-reference-kind={entry.reference.kind}
        title={`${teamReferenceText(entry.reference)} · ${teamReferenceLabel(entry.reference)}`}
      >{teamReferenceText(entry.reference)}</span>)}
  </div>
}

function composerSessionIsCurrent(
  profileId: string | null,
  profileGeneration: number,
  serverIdentity: string | null,
  sessionId: string,
  draftContext: { current: DraftContext },
  mounted: { current: boolean }
): boolean {
  if (!mounted.current) return false
  const state = useAppStore.getState()
  return state.activeProfileId === profileId
    && state.profileGeneration === profileGeneration
    && activeIdentity(state) === serverIdentity
    && !state.switchingProfileId
    && draftContext.current.sessionId === sessionId
    && (state.chatPanes.primary === sessionId || state.chatPanes.secondary === sessionId || state.selectedSessionId === sessionId)
    && state.sessions.some(session => session.id === sessionId && !session.archived)
}

function currentMentionCandidates(
  mention: ChatMentionTrigger,
  selectedId: string,
  supportedTargetBackends: readonly Session['backend'][],
  localRouteHintsSupported: boolean
): ChatMentionCandidate[] {
  const state = useAppStore.getState()
  const active = orderedActiveSessions(state.sessions, state.folderOrder)
    .filter(candidate => (
      candidate.id !== selectedId
      && !candidate.archived
      && supportedTargetBackends.includes(candidate.backend)
    ))
  return (localRouteHintsSupported ? rankSessionsForSearch(active, mention.query, new Set()) : []).map(session => ({
    kind: 'local' as const,
    id: `local-${session.id}`,
    session
  }))
}

export function TeamMentionPalette({
  id,
  sourceSessionId,
  mention,
  selectedIndex,
  supported,
  profileId,
  profileGeneration,
  serverIdentity,
  onCandidates,
  onHighlight,
  onSelect
}: {
  id: string
  sourceSessionId?: string | null
  mention: TeamMentionTrigger
  selectedIndex: number
  supported: boolean
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  onCandidates: (candidates: TeamMentionCandidate[]) => void
  onHighlight: (index: number) => void
  onSelect: (candidate: TeamMentionCandidate) => void
}) {
  const locale = useLocale()
  const bulletinAliasSupported = useAppStore(state => teamBulletinAliasAvailable(state.health))
  const allServersAliasSupported = useAppStore(state => teamAllServersAliasAvailable(state.health))
  const mailRoutesSupported = useAppStore(state => state.health?.capabilities?.agent_team_mail_routes_v1?.available === true
    && state.health.capabilities.agent_team_mail_routes_v1.version === 1)
  const expectedCacheKey = teamMentionExpectedCacheKey(profileId, profileGeneration, serverIdentity, bulletinAliasSupported, allServersAliasSupported)
  const expectedIdentity = profileId && serverIdentity
    ? { profileId, profileGeneration, serverIdentity }
    : null
  const [targets, setTargets] = useState<TeamMentionCandidate[]>(() => stagedTeamMentionCandidates(expectedCacheKey, bulletinAliasSupported, expectedIdentity))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const targetRequestRef = useRef<{ key: string; request: Promise<TeamMentionCandidate[]> } | null>(null)
  const [mailRoutes, setMailRoutes] = useState<AgentTeamMailRoute[]>([])
  const [mailLoading, setMailLoading] = useState(false)
  const [mailError, setMailError] = useState<unknown>(null)
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set())
  const mailScopeKey = JSON.stringify([profileId, profileGeneration, serverIdentity, sourceSessionId, supported, mailRoutesSupported])
  const mailScopeRef = useRef(mailScopeKey)
  mailScopeRef.current = mailScopeKey
  const mailMountedRef = useRef(true)
  useEffect(() => {
    mailMountedRef.current = true
    return () => { mailMountedRef.current = false }
  }, [])
  const mailRequestRef = useRef<{ key: string; request: Promise<AgentTeamMailRoutesSnapshot> } | null>(null)

  useEffect(() => {
    let cancelled = false
    setMailRoutes([])
    setMailError(null)
    setRevoking(new Set())
    setMailLoading(false)
    if (!supported || !mailRoutesSupported || !profileId || !serverIdentity || !sourceSessionId) return
    setMailLoading(true)
    // A fresh, source-scoped read only on explicit opening. StrictMode reuses
    // this request; typing and ordinary background activity do not reload it.
    if (mailRequestRef.current?.key !== mailScopeKey) mailRequestRef.current = {
      key: mailScopeKey,
      request: window.agentsDock.agentTeamMailRoutes.list({ profileId, profileGeneration, serverIdentity }, sourceSessionId)
    }
    void mailRequestRef.current.request.then(snapshot => {
      if (!cancelled) setMailRoutes(snapshot.routes)
    }).catch(cause => {
      if (!cancelled) setMailError(cause ?? new TeamMentionUIError('teamNetwork.mention.loadGrantsFailed'))
    }).finally(() => { if (!cancelled) setMailLoading(false) })
    return () => { cancelled = true }
  }, [mailScopeKey, mailRoutesSupported, profileGeneration, profileId, serverIdentity, sourceSessionId, supported])

  const revokeMail = async (grant: AgentTeamMailRoute) => {
    if (!profileId || !serverIdentity || !sourceSessionId || revoking.has(grant.route_id)) return
    const key = mailScopeKey
    const current = () => mailMountedRef.current && mailScopeRef.current === key && profileIsActive(profileId, profileGeneration)
      && activeIdentity(useAppStore.getState()) === serverIdentity
    if (!current()) return
    const scope = { profileId, profileGeneration, serverIdentity }
    setRevoking(previous => new Set(previous).add(grant.route_id))
    setMailError(null)
    try {
      const result = await window.agentsDock.agentTeamMailRoutes.remove(scope, sourceSessionId, grant.route_id, grant.revision)
      if (!current()) return
      // Refresh once after the explicit action, including a revision conflict.
      // Never retry a delete using a newer revision without another user click.
      const snapshot = await window.agentsDock.agentTeamMailRoutes.list(scope, sourceSessionId)
      if (!current()) return
      setMailRoutes(snapshot.routes)
      if (result.status === 'revision_conflict') setMailError(new TeamMentionUIError('teamNetwork.mention.grantChanged'))
    } catch (cause) {
      if (current()) setMailError(cause ?? new TeamMentionUIError('teamNetwork.mention.revokeFailed'))
    } finally {
      if (current()) setRevoking(previous => new Set([...previous].filter(id => id !== grant.route_id)))
    }
  }

  useEffect(() => {
    let cancelled = false
    if (!supported || !profileId || !serverIdentity) {
      setTargets([])
      setLoading(false)
      setError(null)
      return () => { cancelled = true }
    }
    const staged = stagedTeamMentionCandidates(expectedCacheKey, bulletinAliasSupported, {
      profileId,
      profileGeneration,
      serverIdentity
    })
    if (staged.length) setTargets(staged)
    else setTargets([])
    setLoading(true)
    setError(null)
    // One load per explicit palette opening/scope, including StrictMode's
    // effect replay. Failure waits for a new user opening, never a retry loop.
    if (targetRequestRef.current?.key !== expectedCacheKey) {
      targetRequestRef.current = {
        key: expectedCacheKey,
        request: loadTeamMentionTargets(profileId, profileGeneration, serverIdentity, bulletinAliasSupported, allServersAliasSupported)
      }
    }
    void targetRequestRef.current.request.then(candidates => {
      if (cancelled) return
      setTargets(candidates)
      putTeamMentionLatest(expectedCacheKey, candidates)
      setLoading(false)
    }).catch(cause => {
      if (cancelled) return
      setLoading(false)
      setError(cause ?? new TeamMentionUIError('teamNetwork.mention.loadRecipientsFailed'))
    })
    return () => { cancelled = true }
  }, [allServersAliasSupported, bulletinAliasSupported, expectedCacheKey, profileGeneration, profileId, serverIdentity, supported])

  const candidates = useMemo(
    () => filterTeamMentionTargets(targets, mention.query),
    [locale, mention.query, targets]
  )
  const mailGrantFor = (candidate: TeamMentionCandidate) => candidate.target.kind === 'recipient' && candidate.target.recipient_kind === 'server'
    ? mailRoutes.find(route => route.team_id === candidate.target.team_id && route.target_id === candidate.target.target_id)
    : undefined
  const detachedMailGrants = mailRoutes.filter(route => !candidates.some(candidate => mailGrantFor(candidate)?.route_id === route.route_id)
    && (!mention.query.trim() || route.display_name.toLocaleLowerCase().includes(mention.query.trim().toLocaleLowerCase())))
  const revokeButton = (grant: AgentTeamMailRoute) => <button type="button" className="chat-mention-revoke"
    aria-label={t('teamNetwork.mention.revokeMail', { name: grant.display_name })} disabled={revoking.has(grant.route_id)}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); void revokeMail(grant) }}
  >{revoking.has(grant.route_id) ? t('teamNetwork.mention.revoking') : t('teamNetwork.mention.revoke')}</button>
  useEffect(() => onCandidates(candidates), [candidates, onCandidates])
  useEffect(() => {
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  return <div id={id} className="chat-mention-palette team-mention-palette" role="listbox" aria-label={t('teamNetwork.mention.destinations')}>
    {!supported
      ? <div className="chat-mention-empty"><AlertTriangle size={14} /><span><strong>{t('teamNetwork.mention.serverUpdate')}</strong><small>{t('teamNetwork.mention.structuredUnavailable')}</small></span></div>
      : <>
        {candidates.map((candidate, index) => <div className="chat-mention-option-row" key={candidate.id}><button
          ref={node => { optionRefs.current[index] = node }}
          id={`${id}-${candidate.id}`}
          key={candidate.id}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === selectedIndex}
          className={`chat-mention-option${index === selectedIndex ? ' selected' : ''}`}
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(candidate)}
        >
          {candidate.target.kind === 'recipient' && candidate.target.recipient_kind === 'all'
            ? <RadioTower size={15} />
            : <Network size={15} />}
          <span><strong>{teamMentionDisplayLabel(candidate)}</strong>{candidate.hint && <small>{teamMentionDisplayHint(candidate)}</small>}
            {mailGrantFor(candidate) && <small>{t('teamNetwork.mention.mailGranted')}{mailGrantFor(candidate)?.available ? '' : ` · ${t('teamNetwork.mention.unavailable')}`}</small>}
          </span>
          <code>{candidate.code}</code>
        </button>{mailGrantFor(candidate) && revokeButton(mailGrantFor(candidate)!)}</div>)}
        {detachedMailGrants.map(grant => <div className="chat-mention-grant-only" key={grant.route_id}>
          <Mail size={15} /><span><strong>{grant.display_name}</strong><small>{t('teamNetwork.mention.mailGranted')} · {grant.available ? t('teamNetwork.mention.available') : t('teamNetwork.mention.unavailable')}</small></span>
          {revokeButton(grant)}
        </div>)}
        {loading && !targets.length && <div className="chat-mention-grant-status"><LoaderCircle className="spin" size={13} />{' '}{t('teamNetwork.mention.loadingNetwork')}</div>}
        {!loading && !error && !candidates.length && !detachedMailGrants.length && <div className="chat-mention-empty"><span><strong>{t('teamNetwork.mention.noDestination')}</strong><small>{t('teamNetwork.mention.searchHint')}</small></span></div>}
        {error != null && <div className="chat-mention-grant-status error"><AlertTriangle size={13} /> {cleanActionError(error)}</div>}
        {mailLoading && <div className="chat-mention-grant-status"><LoaderCircle className="spin" size={13} />{' '}{t('teamNetwork.mention.loadingGrants')}</div>}
        {mailError != null && <div className="chat-mention-grant-status error"><AlertTriangle size={13} /> {cleanActionError(mailError)}</div>}
        {mailRoutes.length > 0 && <div className="chat-mention-grant-note">{t('teamNetwork.mention.revokeHelp')}</div>}
      </>}
  </div>
}

function hasAllServersReference(references: readonly TeamReference[]): boolean {
  return references.some(reference => reference.kind === 'recipient' && reference.recipient_kind === 'all_servers')
}

async function requireAllServersReferenceSupport(
  references: readonly TeamReference[],
  profileId: string | null,
  profileGeneration: number,
  serverIdentity: string | null
): Promise<void> {
  if (!hasAllServersReference(references)) return
  if (!teamAllServersAliasAvailable(useAppStore.getState().health)) {
    throw new Error(allServersNativeUpdateRequired())
  }
  if (!profileId || !serverIdentity) throw new Error(t('teamNetwork.mention.allReconnect'))
  const status = await window.agentsDock.teamHub.status()
  assertTeamNetworkExpectedIdentity(status, { profileId, profileGeneration, serverIdentity })
  if (!status.authenticated || status.connectionState !== 'authenticated') {
    throw new Error(status.error || t('teamNetwork.mention.allConnectNetwork'))
  }
  if (!profileIsActive(profileId, profileGeneration) || activeIdentity(useAppStore.getState()) !== serverIdentity) {
    throw new Error(t('teamNetwork.mention.allServerChanged'))
  }
  const capability = await window.agentsDock.teamHub.teamMessagesCapabilities(teamNetworkScope(status))
  if (capability.available !== true || capability.version !== 1 || capability.all_servers?.available !== true) {
    throw new Error(t('teamNetwork.mention.allHubUpdate'))
  }
  if (!teamAllServersAliasAvailable(useAppStore.getState().health)) throw new Error(allServersNativeUpdateRequired())
}

async function loadTeamMentionTargets(
  profileId: string,
  profileGeneration: number,
  serverIdentity: string,
  bulletinAliasSupported: boolean,
  allServersAliasSupported: boolean
): Promise<TeamMentionCandidate[]> {
  let status = await window.agentsDock.teamHub.status()
  assertTeamNetworkExpectedIdentity(status, { profileId, profileGeneration, serverIdentity })
  if (!status.authenticated && status.serverManaged === true && status.backgroundReconnectAllowed === true
    && ['disconnected', 'offline', 'unavailable', 'error', 'signed-out'].includes(status.connectionState)) {
    // This is the same bounded existing-binding recovery as opening Team
    // Network. Main owns the persisted opt-out and retired-binding fences;
    // unlike unscoped connect(), this cannot rearm an explicit disconnect.
    status = await window.agentsDock.teamHub.connect({ surfaceReconnect: {
      profileId, profileGeneration, serverIdentity, generation: status.generation
    } })
    assertTeamNetworkExpectedIdentity(status, { profileId, profileGeneration, serverIdentity })
  }
  if (!status.authenticated || status.connectionState !== 'authenticated') {
    throw status.error ? new Error(status.error) : new TeamMentionUIError('teamNetwork.mention.connectChoose')
  }
  const scope = teamNetworkScope(status)
  const cacheRevision = teamNetworkCacheRevision()
  const cacheKey = JSON.stringify([
    teamNetworkSnapshotKey(status),
    bulletinAliasSupported,
    allServersAliasSupported,
    cacheRevision
  ])
  const cached = teamMentionTargetCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() && cached.candidates.some(candidate => candidate.target.kind === 'recipient' && candidate.target.recipient_kind === 'server')) return cached.candidates
  if (cached) teamMentionTargetCache.delete(cacheKey)
  const active = teamMentionTargetInFlight.get(cacheKey)
  if (active) return active
  const operation = (async () => {
    // Workspace and the local capability fence begin together. Roster pages
    // are shared with Team Network itself and across every open composer.
    const cachedWorkspace = peekTeamNetworkWorkspace(status)
    const [capability, workspace] = await Promise.all([
      window.agentsDock.teamHub.teamMessagesCapabilities(scope),
      loadTeamNetworkWorkspace(status, { force: Boolean(cachedWorkspace && !cachedWorkspace.teams.some(team => team.status === 'active')) })
    ])
    if (capability.available !== true || capability.version !== 1) {
      throw new TeamMentionUIError('teamNetwork.mention.structuredUnsupported')
    }
    const allServersSupported = allServersAliasSupported && capability.all_servers?.available === true
    const teams = workspace.teams.filter(team => team.status === 'active')
    const projections = await Promise.all(teams.map(async team => {
      const cachedServers = peekTeamNetworkServers(status, team.id)
      return {
        team,
        // A self-only/empty roster may predate an invitation accepted moments
        // ago. Revalidate once on this explicit opening, never on typing or a
        // timer, and retain the shared exact-lifecycle singleflight.
        servers: await loadCachedTeamNetworkServers(status, team.id, {
          force: Boolean(cachedServers && !cachedServers.some(server => teamServerMentionEligible(server, serverIdentity)))
        })
      }
    }))
    const candidates = projections.flatMap(({ team, servers }) => [
      ...(bulletinAliasSupported ? [teamBulletinMentionCandidate(team.id, team.display_name, teams.length > 1)] : []),
      ...(allServersSupported ? [teamAllServersMentionCandidate(team.id, team.display_name, teams.length > 1)] : []),
      ...servers
        .filter(server => teamServerMentionEligible(server, serverIdentity))
        .map(server => teamServerMentionCandidate(team.id, server))
    ])
    if (teamNetworkCacheRevision() !== cacheRevision) {
      throw new TeamMentionUIError('teamNetwork.mention.recipientsChanged')
    }
    teamMentionTargetCache.set(cacheKey, { expiresAt: Date.now() + TEAM_MENTION_TARGET_CACHE_TTL_MS, candidates })
    while (teamMentionTargetCache.size > TEAM_MENTION_TARGET_CACHE_MAX_ENTRIES) {
      const oldest = teamMentionTargetCache.keys().next().value
      if (typeof oldest !== 'string') break
      teamMentionTargetCache.delete(oldest)
    }
    putTeamMentionLatest(
      teamMentionExpectedCacheKey(profileId, profileGeneration, serverIdentity, bulletinAliasSupported, allServersAliasSupported),
      candidates
    )
    return candidates
  })().finally(() => {
    if (teamMentionTargetInFlight.get(cacheKey) === operation) teamMentionTargetInFlight.delete(cacheKey)
  })
  teamMentionTargetInFlight.set(cacheKey, operation)
  return operation
}

function teamBulletinMentionCandidate(teamId: string, teamName: string, includeTeam: boolean): TeamMentionCandidate {
  const label = includeTeam ? `${teamName} Bulletin` : 'Bulletin'
  return {
    id: `bulletin:${teamId}`,
    label,
    hint: includeTeam ? `Post to ${teamName} Bulletin` : 'Post to Bulletin',
    presentation: { labelKey: includeTeam ? 'teamNetwork.mention.teamBulletin' : 'teamNetwork.mention.bulletin',
      hintKey: includeTeam ? 'teamNetwork.mention.postTeamBulletin' : 'teamNetwork.mention.postBulletin', params: { teamName } },
    code: '@@bulletin',
    target: {
      kind: 'recipient',
      recipient_kind: 'all',
      team_id: teamId,
      target_id: 'all',
      display_name_snapshot: 'bulletin'
    }
  }
}

function teamServerMentionCandidate(
  teamId: string,
  server: TeamNetworkServer
): TeamMentionCandidate {
  const recipientName = server.recipient_display_name?.trim() || server.display_name
  return {
    id: `server:${teamId}:${server.id}`,
    label: recipientName,
    code: `@@${recipientName}`,
    ...(server.status === 'offline' ? { hint: 'Offline · inbox available', presentation: { hintKey: 'teamNetwork.mention.offlineInbox' } } : {}),
    target: {
      kind: 'recipient',
      recipient_kind: 'server',
      team_id: teamId,
      target_id: server.id,
      display_name_snapshot: recipientName
    }
  }
}

function teamServerMentionEligible(server: TeamNetworkServer, serverIdentity: string): boolean {
  return (server.status === 'active' || server.status === 'offline')
    && !server.owned_by_caller
    && server.server_identity !== serverIdentity
}

function teamAllServersMentionCandidate(teamId: string, teamName: string, includeTeam: boolean): TeamMentionCandidate {
  return {
    id: `all_servers:${teamId}`,
    label: includeTeam ? `${teamName} — All servers` : 'All servers',
    hint: 'Team Mail to every active server, including offline servers',
    presentation: { labelKey: includeTeam ? 'teamNetwork.mention.teamAllServers' : 'teamNetwork.mention.allServers',
      hintKey: 'teamNetwork.mention.allServersHint', params: { teamName } },
    code: '@@all',
    target: {
      kind: 'recipient',
      recipient_kind: 'all_servers',
      team_id: teamId,
      target_id: 'all_servers',
      display_name_snapshot: 'all'
    }
  }
}

function teamMentionDisplayLabel(candidate: TeamMentionCandidate): string {
  return candidate.presentation?.labelKey ? t(candidate.presentation.labelKey, candidate.presentation.params) : candidate.label
}

function teamMentionDisplayHint(candidate: TeamMentionCandidate): string | undefined {
  return candidate.presentation?.hintKey ? t(candidate.presentation.hintKey, candidate.presentation.params) : candidate.hint
}

function filterTeamMentionTargets(targets: readonly TeamMentionCandidate[], query: string): TeamMentionCandidate[] {
  const needle = query.trim().toLocaleLowerCase()
  return targets
    .filter(candidate => !needle || [candidate.label, candidate.code, teamMentionDisplayLabel(candidate),
      ...(candidate.target.kind === 'recipient' && candidate.target.recipient_kind === 'all' ? [] : [candidate.target.target_id])]
      .some(value => value.toLocaleLowerCase().includes(needle)))
    .sort((left, right) => {
      if (!needle) return teamMentionDisplayLabel(left).localeCompare(teamMentionDisplayLabel(right))
      const leftStarts = teamMentionDisplayLabel(left).toLocaleLowerCase().startsWith(needle) || left.label.toLocaleLowerCase().startsWith(needle) || left.code.toLocaleLowerCase().startsWith(`@@${needle}`)
      const rightStarts = teamMentionDisplayLabel(right).toLocaleLowerCase().startsWith(needle) || right.label.toLocaleLowerCase().startsWith(needle) || right.code.toLocaleLowerCase().startsWith(`@@${needle}`)
      return Number(rightStarts) - Number(leftStarts) || teamMentionDisplayLabel(left).localeCompare(teamMentionDisplayLabel(right))
    })
}

function teamMentionExpectedCacheKey(
  profileId: string | null,
  profileGeneration: number,
  serverIdentity: string | null,
  bulletinAliasSupported: boolean,
  allServersAliasSupported: boolean
): string {
  return JSON.stringify([profileId, profileGeneration, serverIdentity, bulletinAliasSupported, allServersAliasSupported, teamNetworkCacheRevision()])
}

function stagedTeamMentionCandidates(
  _key: string,
  bulletinAliasSupported: boolean,
  expectedIdentity?: { profileId: string; profileGeneration: number; serverIdentity: string } | null
): TeamMentionCandidate[] {
  // A selected AgentsServer identity does not prove that the previous Team
  // Hub principal/session is still authorized. Before fresh status resolves,
  // only the non-private Bulletin affordance may be staged; server recipients
  // are adopted from the exact lifecycle cache after status verification.
  if (!bulletinAliasSupported || !expectedIdentity) return []
  const snapshot = peekTeamNetworkOpeningSnapshot(expectedIdentity)
  if (!snapshot) return []
  const teams = snapshot.workspace.teams.filter(team => team.status === 'active')
  const team = teams.find(candidate => candidate.id === snapshot.teamId)
  return team ? [teamBulletinMentionCandidate(team.id, team.display_name, teams.length > 1)] : []
}

function putTeamMentionLatest(key: string, candidates: TeamMentionCandidate[]): void {
  teamMentionLatestByExpected.delete(key)
  teamMentionLatestByExpected.set(key, candidates)
  while (teamMentionLatestByExpected.size > TEAM_MENTION_TARGET_CACHE_MAX_ENTRIES) {
    const oldest = teamMentionLatestByExpected.keys().next().value
    if (typeof oldest !== 'string') return
    teamMentionLatestByExpected.delete(oldest)
  }
}

function ComposerCommandPalette({
  id,
  commands,
  selectedIndex,
  session,
  catalog,
  claudePermissionMode,
  loadStatus,
  onRefresh,
  onHighlight,
  onSelect
}: {
  id: string
  commands: readonly ComposerCommand[]
  selectedIndex: number
  session: Session
  catalog: RuntimeCatalog | null
  claudePermissionMode?: ClaudePermissionMode
  loadStatus: ProviderCommandLoadState['status']
  onRefresh: () => void
  onHighlight: (index: number) => void
  onSelect: (command: ComposerCommand) => void
}) {
  useLocale()
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  return <div id={id} className="composer-command-palette" role="listbox" aria-label={t("ui.Composer.ComposerCommandPalette.chat_commands_b7e6b93", { "provider": String(backendLabel(session.backend)) })}>
    {groupComposerCommandsByCategory(commands, COMPOSER_COMMAND_CATEGORIES).map(group => <div key={group.id} className="composer-command-group" role="group" aria-label={group.heading}>
      {group.showHeading && <div className="composer-command-section-header" role="presentation">{group.heading}</div>}
      {group.items.map(({ command, index }) => {
        const value = composerCommandValue(command, session, catalog, claudePermissionMode)
        return <button
        ref={node => { optionRefs.current[index] = node }}
        id={`${id}-${command.id}`}
        key={command.id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={index === selectedIndex}
        className={`composer-command-option${index === selectedIndex ? ' selected' : ''}`}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => onHighlight(index)}
        onClick={() => onSelect(command)}
      >
        <span className="composer-command-icon" aria-hidden="true">{composerCommandIcon(command)}</span>
        <span className="composer-command-copy">
          <strong>{command.label}{command.meta && <span className="composer-command-meta">{command.meta}</span>}</strong>
          <small>{command.description}</small>
        </span>
        <code className="composer-command-key" title={value}>{value}</code>
      </button>
      })}
    </div>)}
    {loadStatus === 'loading' && <div className="composer-command-status" role="status">
      <LoaderCircle className="spin" size={13} />{t('composer.providerCommands.loading')}
    </div>}
    {loadStatus === 'error' && <div className="composer-command-status composer-command-error" role="status">
      <span>{t('composer.providerCommands.loadFailed')}</span>
      <button type="button" className="quiet-button" onMouseDown={event => event.preventDefault()} onClick={onRefresh}>
        {t('composer.providerCommands.retry')}
      </button>
    </div>}
    <div className="composer-command-footer" role="presentation" aria-hidden="true">
      <span><kbd>↑↓</kbd> choose</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  </div>
}

function composerCommandValue(
  command: ComposerCommand,
  session: Session,
  catalog: RuntimeCatalog | null,
  claudePermissionMode?: ClaudePermissionMode
): string {
  if (command.provider) return command.provider.command.invocation
  if (command.id === 'model') {
    return runtimeCatalogOptions(catalog, session.backend, 'models', session.model, session.codex_provider, session.codex_provider_catalog)
      .find(option => option.value === (session.model ?? ''))?.label ?? 'Default'
  }
  if (command.id === 'reasoning') {
    return runtimeEffortOptions(catalog, session.backend, session.model, session.effort, session.codex_provider, session.codex_provider_catalog)
      .find(option => option.value === (session.effort ?? ''))?.label ?? 'Default'
  }
  if (command.id === 'plan') return claudePermissionMode === 'plan' ? 'On' : 'Choose'
  if (command.id === 'workdir') {
    const cwd = session.cwd?.trim()
    if (!cwd) return t("ui.Composer.composerCommandValue.server_default_42b9983")
    const parts = cwd.split(/[\\/]/u).filter(Boolean)
    return parts.at(-1) || cwd
  }
  return `/${command.id}`
}

function composerCommandIcon(command: ComposerCommand) {
  if (command.provider) return <Sparkles size={15} />
  switch (command.id) {
    case 'attach': return <Paperclip size={15} />
    case 'chat': return <MessageSquareShare size={15} />
    case 'digest': return <GitFork size={15} />
    case 'feedback': return <Sparkles size={15} />
    case 'goal': return <Goal size={15} />
    case 'import': return <Import size={15} />
    case 'mail': return <Mail size={15} />
    case 'mcp': return <Network size={15} />
    case 'model': return <Gauge size={15} />
    case 'new': return <MessageSquarePlus size={15} />
    case 'permissions': return <Shield size={15} />
    case 'plan': return <ListOrdered size={15} />
    case 'reasoning': return <Sparkles size={15} />
    case 'schedule': return <CalendarClock size={15} />
    case 'settings': return <Settings size={15} />
    case 'split': return <Columns2 size={15} />
    case 'status': return <Gauge size={15} />
    case 'workdir': return <FolderOpen size={15} />
  }
}

function WorkingDirectoryCommandDialog({
  open,
  session,
  onOpenChange
}: {
  open: boolean
  session: Session
  onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const defaultCwd = useAppStore(state => state.health?.default_cwd?.trim() || '')
  const completionAvailable = useAppStore(state => state.health?.capabilities?.working_directory_completion?.available === true)
  const [draft, setDraft] = useState(session.cwd?.trim() || defaultCwd)
  const [saving, setSaving] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) setDraft(session.cwd?.trim() || defaultCwd)
  }, [defaultCwd, open, session.cwd, session.id])

  const save = async () => {
    const cwd = draft.trim()
    if (!cwd || saving) return
    setSaving(true)
    try {
      await useAppStore.getState().updateSession(session.id, { cwd })
      const saved = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
      if (saved?.cwd?.trim() === cwd) onOpenChange(false)
    } catch (error) {
      reportActionError(error)
    } finally {
      setSaving(false)
    }
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content
        ref={contentRef}
        className="form-dialog working-directory-command-dialog"
        onOpenAutoFocus={event => {
          event.preventDefault()
          window.requestAnimationFrame(() => contentRef.current?.querySelector<HTMLInputElement>('input')?.focus())
        }}
      >
        <header>
          <div>
            <Dialog.Title>{t("ui.Composer.WorkingDirectoryCommandDialog.working_directory_865e85c")}</Dialog.Title>
            <Dialog.Description>{t("ui.Composer.WorkingDirectoryCommandDialog.choose_the_folder_this_chat_uses_for_files_be57011")}</Dialog.Description>
          </div>
          <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t("ui.Composer.WorkingDirectoryCommandDialog.close_working_directory_e795e98")}><X size={16} /></button></Dialog.Close>
        </header>
        <div className="form-dialog-body">
          <form className="dialog-form" onSubmit={event => { event.preventDefault(); void save() }}>
            <WorkingDirectoryInput
              value={draft}
              onChange={setDraft}
              defaultCwd={defaultCwd}
              available={completionAvailable}
            />
            <small className="working-directory-hint">{t("ui.Composer.WorkingDirectoryCommandDialog.folder_suggestions_come_from_the_active_ag_fb6c963")}</small>
            {session.backend === 'opencode' && <small className="working-directory-hint">{t('opencode.cwdReset')}</small>}
            <footer>
              <Dialog.Close asChild><button type="button" className="quiet-button">{t("ui.Composer.WorkingDirectoryCommandDialog.cancel_19766ed")}</button></Dialog.Close>
              <button type="submit" className="primary-button" disabled={!draft.trim() || saving}>{saving ? t("ui.Composer.WorkingDirectoryCommandDialog.saving_23e3929") : t("ui.Composer.WorkingDirectoryCommandDialog.use_folder_901c498")}</button>
            </footer>
          </form>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function ChatMentionPalette({
  id,
  mention,
  selectedId,
  selectedIndex,
  supported,
  localSupported,
  supportedTargetBackends,
  requestReplySupportedForSource,
  maximumReferencesSelected,
  pendingGrantTargetIds,
  remainingNewRouteCapacity,
  grantedRoutes,
  grantsLoading,
  grantsError,
  revokingRouteIds,
  onCandidates,
  onSelect,
  onRevoke
}: {
  id: string
  mention: ChatMentionTrigger
  selectedId: string | null
  selectedIndex: number
  supported: boolean
  localSupported: boolean
  supportedTargetBackends: readonly Session['backend'][]
  requestReplySupportedForSource: boolean
  maximumReferencesSelected: boolean
  pendingGrantTargetIds: ReadonlySet<string>
  remainingNewRouteCapacity: number | null
  grantedRoutes: readonly AgentCrossChatRoute[]
  grantsLoading: boolean
  grantsError: string | null
  revokingRouteIds: ReadonlySet<string>
  onCandidates: (sessions: ChatMentionCandidate[]) => void
  onSelect: (session: ChatMentionCandidate) => void
  onRevoke: (routeId: string, expectedRevision: string) => Promise<boolean>
}) {
  useLocale()
  // The global chat/status collections are intentionally subscribed only
  // while discovery is open. Background activity in any of hundreds of chats
  // must not rerender the always-mounted composer.
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const candidates = useMemo(() => {
    if (!selectedId) return []
    // Subscribe above so activity/profile changes refresh the palette; the
    // shared selector then applies identical ranking for keyboard and click.
    void sessions
    void folderOrder
    return currentMentionCandidates(mention, selectedId, supportedTargetBackends, localSupported)
  }, [folderOrder, localSupported, mention, selectedId, sessions, supportedTargetBackends])
  const grantByTarget = useMemo(
    () => new Map(grantedRoutes.map(route => [route.target_session_id, route])),
    [grantedRoutes]
  )
  const candidateTargetIds = useMemo(
    () => new Set(candidates.map(candidate => candidate.session.id)),
    [candidates]
  )
  const query = mention.query.trim().toLocaleLowerCase()
  const detachedGrants = (localSupported ? grantedRoutes : []).filter(route => (
    !candidateTargetIds.has(route.target_session_id)
    && (!query || [route.alias, route.target.title, route.target_session_id]
      .some(value => value?.toLocaleLowerCase().includes(query)))
  ))

  useEffect(() => onCandidates(candidates), [candidates, onCandidates])
  useEffect(() => {
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  return <div id={id} className="chat-mention-palette" role="listbox" aria-label={t("ui.Composer.ChatMentionPalette.chats_ef5b404")}>
    {!supported
      ? <div className="chat-mention-empty"><AlertTriangle size={14} /><span><strong>{t("ui.Composer.ChatMentionPalette.server_update_required_4a5a2af")}</strong><small>{t("ui.Composer.ChatMentionPalette.cross_chat_handoffs_are_unavailable_on_thi_85df9b0")}</small></span></div>
      : <>
        {candidates.map((candidate, index) => {
          const grant = grantByTarget.get(candidate.session.id)
          const targetTitle = candidate.session.title
          const revoking = Boolean(selectedId && grant && revokingRouteIds.has(`${selectedId}:${grant.route_id}`))
          const routeCapacityReached = !grant
            && !pendingGrantTargetIds.has(candidate.session.id)
            && remainingNewRouteCapacity !== null
            && remainingNewRouteCapacity < 1
          const disabled = maximumReferencesSelected || routeCapacityReached
          return <div className="chat-mention-option-row" key={candidate.id}>
            <button
              ref={node => { optionRefs.current[index] = node }}
              id={`${id}-${candidate.id}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              disabled={disabled}
              title={maximumReferencesSelected
                ? t("ui.Composer.a_message_can_reference_at_most_chats_d18596a", { "maximum": String(MAX_CHAT_REFERENCES) })
                : routeCapacityReached
                  ? t("ui.Composer.revoke_a_granted_route_before_adding_anoth_063538c")
                  : undefined}
              className={`chat-mention-option${index === selectedIndex ? ' selected' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => onSelect(candidate)}
            ><BackendMark backend={candidate.session.backend} size={15} /><span><strong>{candidate.session.title}</strong><small>{grant
                ? t("ui.Composer.granted_c214d1f", { "action": String(agentRouteActionLabel(grant)), "folder": String(candidate.session.folder || 'General') })
                : t("ui.Composer.will_grant_when_sent_ae87824", { "action": String(requestReplySupportedForSource ? 'Send + Ask' : 'Send'), "folder": String(candidate.session.folder || 'General') })} </small></span><code>{candidate.session.id.slice(-8)}</code>
            </button>
            {grant && <button
              type="button"
              className="chat-mention-revoke"
              aria-label={t("ui.Composer.revoke_access_to_76e07ac", { "action": String(agentRouteActionLabel(grant)), "title": String(targetTitle) })}
              disabled={revoking}
              onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
              onClick={event => { event.stopPropagation(); void onRevoke(grant.route_id, grant.revision) }}
            >{revoking ? t("ui.Composer.revoking_1a36f21") : t("ui.Composer.revoke_87e6d00")}</button>}
          </div>
        })}
        {detachedGrants.map(grant => {
          const title = grant.target.title?.trim() || grant.alias || grant.target_session_id
          const revoking = Boolean(selectedId && revokingRouteIds.has(`${selectedId}:${grant.route_id}`))
          return <div className="chat-mention-grant-only" key={`grant-${grant.route_id}`}>
            <CheckCircle2 size={15} />
            <span><strong>{title}</strong><small>{t("ui.Composer.granted_17a8252")}{" "}{agentRouteActionLabel(grant)} · {grant.target.available ? 'Available' : t("ui.Composer.target_unavailable_06c6e81")}</small></span>
            <button
              type="button"
              className="chat-mention-revoke"
              aria-label={t("ui.Composer.revoke_access_to_76e07ac", { "action": String(agentRouteActionLabel(grant)), "title": String(title) })}
              disabled={revoking}
              onMouseDown={event => event.preventDefault()}
              onClick={() => void onRevoke(grant.route_id, grant.revision)}
            >{revoking ? t("ui.Composer.revoking_1a36f21") : t("ui.Composer.revoke_87e6d00")}</button>
          </div>
        })}
        {maximumReferencesSelected && <div className="chat-mention-empty" role="status"><span><strong>{t('ui.composer.maximumChats', { count: MAX_CHAT_REFERENCES })}</strong><small>{t("ui.Composer.ChatMentionPalette.remove_a_chat_reference_before_selecting_a_3e5b219")}</small></span></div>}
        {localSupported && remainingNewRouteCapacity === 0 && <div className="chat-mention-empty" role="status"><span><strong>{t("ui.Composer.ChatMentionPalette.route_access_limit_reached_c3ab676")}</strong><small>{t("ui.Composer.ChatMentionPalette.granted_chats_remain_available_revoke_a_ro_d9c4c32")}</small></span></div>}
        {!candidates.length && !detachedGrants.length && !grantsLoading && <div className="chat-mention-empty"><span><strong>{t("ui.Composer.ChatMentionPalette.no_matching_chats_27e7713")}</strong><small>{t("ui.Composer.ChatMentionPalette.try_a_title_folder_or_session_id_50d6f13")}</small></span></div>}
        {localSupported && grantsLoading && <div className="chat-mention-grant-status"><LoaderCircle className="spin" size={13} />{" "}{t("ui.Composer.ChatMentionPalette.refreshing_granted_routes_3e0e5e6")}</div>}
        {localSupported && grantsError && <div className="chat-mention-grant-status error"><AlertTriangle size={13} /> {grantsError}</div>}
        {localSupported && grantedRoutes.length > 0 && <div className="chat-mention-grant-note">{t("ui.Composer.ChatMentionPalette.revoke_removes_this_chat_s_granted_cross_c_53849c4")}</div>}
      </>}
  </div>
}

function agentRouteActionLabel(route: Pick<AgentCrossChatRoute, 'actions'>): string {
  const send = route.actions.includes('instruction')
  const ask = route.actions.includes('request_reply')
  if (send && ask) return t("ui.Composer.agentRouteActionLabel.send_ask_ddaaae5")
  if (send) return t("ui.Composer.agentRouteActionLabel.send_f6f4688")
  if (ask) return t("ui.Composer.agentRouteActionLabel.ask_b8c209c")
  return t("ui.Composer.agentRouteActionLabel.no_actions_219e734")
}

function agentRouteAllowsReference(
  route: Pick<AgentCrossChatRoute, 'target_session_id' | 'actions'>,
  reference: Pick<ChatReference, 'session_id' | 'action' | 'route_action'>
): boolean {
  if (route.target_session_id !== reference.session_id) return false
  const required = reference.action === 'request_reply' || reference.route_action === 'request_reply'
    ? 'request_reply'
    : 'instruction'
  return route.actions.includes(required)
}

function teamReferenceLabel(reference: TeamReference): string {
  if (reference.kind === 'skill') return t('teamNetwork.mention.teamSkill')
  if (reference.recipient_kind === 'all') return t('teamNetwork.mention.bulletin')
  if (reference.recipient_kind === 'all_servers') return t('teamNetwork.mention.allMail')
  return reference.recipient_kind === 'server' ? t('teamNetwork.mention.teamServer') : t('teamNetwork.mention.teamMember')
}

function RuntimeMenu({
  session,
  running,
  admitting,
  open,
  onOpenChange,
  focusSection
}: {
  session: Session
  running: boolean
  admitting: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  focusSection?: 'model' | 'reasoning' | null
}) {
  useLocale()
  const catalog = useAppStore(state => state.runtimeCatalog)
  const codexRuntime = useCodexRuntime()
  const claudeRuntime = useClaudeRuntime()
  const models = runtimeCatalogOptions(catalog, session.backend, 'models', session.model, session.codex_provider, session.codex_provider_catalog)
  const efforts = runtimeEffortOptions(catalog, session.backend, session.model, session.effort, session.codex_provider, session.codex_provider_catalog)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [manualModelOpen, setManualModelOpen] = useState(false)
  const [manualModel, setManualModel] = useState('')
  const isCustomCodex = session.backend === 'codex' && session.codex_provider === 'custom'
  const [reloading, setReloading] = useState(false)
  const [reloadNotice, setReloadNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const reloadNoticeTimer = useRef<number | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const providerName = backendLabel(session.backend)
  const selectedRuntimeLabel = runtimeLabel(session, catalog)
  const providerMutating = session.backend === 'codex' ? codexRuntime.mutating : claudeRuntime.mutating
  const reloadDisabled = running || admitting || reloading || providerMutating

  useEffect(() => { setManualModelOpen(false); setManualModel('') }, [session.id, profileId, profileGeneration])

  useEffect(() => () => {
    if (reloadNoticeTimer.current !== null) window.clearTimeout(reloadNoticeTimer.current)
  }, [])

  useEffect(() => {
    if (!open || !focusSection) return
    const frame = window.requestAnimationFrame(() => {
      const content = contentRef.current
      const selected = content?.querySelector<HTMLElement>(`[data-runtime-section="${focusSection}"][data-state="checked"]`)
      const first = content?.querySelector<HTMLElement>(`[data-runtime-section="${focusSection}"]`)
      ;(selected ?? first)?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusSection, open])

  const selectModel = (value: string) => {
    const model = value || null
    const effort = runtimeEffortAfterModelChange(catalog, session.backend, model, session.effort, session.codex_provider, session.codex_provider_catalog)
    void useAppStore.getState().updateSession(session.id, { model, effort })
  }
  const dismissReloadNotice = () => {
    if (reloadNoticeTimer.current !== null) window.clearTimeout(reloadNoticeTimer.current)
    reloadNoticeTimer.current = null
    setReloadNotice(null)
  }
  const reloadProvider = async () => {
    if (reloadDisabled) return
    dismissReloadNotice()
    setReloading(true)
    try {
      const run = session.backend === 'codex' ? codexRuntime.run : claudeRuntime.run
      const result = await run(() => window.agentsDock.sessions.reloadProvider(session.id))
      setReloadNotice({
        kind: 'success',
        message: result.message?.trim() || `${providerName} reloaded for this chat.`
      })
      reloadNoticeTimer.current = window.setTimeout(() => {
        reloadNoticeTimer.current = null
        setReloadNotice(null)
      }, 4_000)
    } catch (error) {
      setReloadNotice({ kind: 'error', message: cleanActionError(error) })
    } finally {
      setReloading(false)
    }
  }
  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild><button className="runtime-chip" title={selectedRuntimeLabel}><span>{selectedRuntimeLabel}</span><ChevronDown size={13} /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content
          ref={contentRef}
          className="menu-content runtime-menu"
          side="top"
          align="start"
        >
          <DropdownMenu.Label className="menu-label">{t("ui.Composer.RuntimeMenu.model_5e2c614")}</DropdownMenu.Label>
          {models.map(option => <DropdownMenu.CheckboxItem data-runtime-section="model" key={option.value || 'default'} className="menu-item" disabled={option.locked} title={option.locked ? option.locked_reason ?? undefined : undefined} checked={(session.model ?? '') === option.value} onCheckedChange={() => selectModel(option.value)}>{option.label}{option.locked && !isCustomCodex ? <span className="menu-item-locked-hint">{" "}{t("ui.Composer.upgrade_required_838a00a")}</span> : null}</DropdownMenu.CheckboxItem>)}
          {isCustomCodex && <>
            <DropdownMenu.Item className="menu-item" onSelect={() => { setManualModel(session.model ?? ''); setManualModelOpen(true) }}>{t('codexProvider.manualModel')}</DropdownMenu.Item>
            <CodexModelDiscovery menu sessionId={session.id} />
          </>}
          {session.backend !== 'cursor' && session.backend !== 'opencode' && efforts.some(option => Boolean(option.value)) && <>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Label className="menu-label">Reasoning</DropdownMenu.Label>
            {efforts.map(option => <DropdownMenu.CheckboxItem data-runtime-section="reasoning" key={option.value || 'default'} className="menu-item" checked={(session.effort ?? '') === option.value} onCheckedChange={() => void useAppStore.getState().updateSession(session.id, { effort: option.value || null })}>{option.label}</DropdownMenu.CheckboxItem>)}
          </>}
          {!window.agentsDock.sharedChat && session.backend !== 'cursor' && session.backend !== 'opencode' && <>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Label className="menu-label">{t("ui.Composer.RuntimeMenu.agent_process_4dc27ee")}</DropdownMenu.Label>
            <DropdownMenu.Item
              className="menu-item"
              disabled={reloadDisabled}
              title={running ? t("ui.Composer.RuntimeMenu.stop_or_wait_for_the_active_turn_before_re_b3efa9d") : admitting ? t("ui.Composer.RuntimeMenu.wait_for_the_message_to_be_accepted_before_5fb6dc3") : providerMutating ? t("ui.Composer.RuntimeMenu.wait_for_the_current_provider_operation_be_20bddb7") : undefined}
              onSelect={() => void reloadProvider()}
            ><RotateCw size={14} className={reloading ? 'spin' : undefined} /> {reloading ? t("ui.Composer.RuntimeMenu.reloading_4e27298", { "provider": String(providerName) }) : t("ui.Composer.RuntimeMenu.reload_527a546", { "name": String(providerName) })}</DropdownMenu.Item>
          </>}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      {isCustomCodex && <Dialog.Root open={manualModelOpen} onOpenChange={setManualModelOpen}>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog">
          <header><div><Dialog.Title>{t('codexProvider.manualModel')}</Dialog.Title><Dialog.Description>{t('codexProvider.manualModelHelp')}</Dialog.Description></div></header>
          <div className="form-dialog-body"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (manualModel.trim()) { selectModel(manualModel.trim()); setManualModelOpen(false) } }}>
            <label><span>{t('codexAuth.model')}</span><input value={manualModel} maxLength={256} autoComplete="off" spellCheck={false} onChange={event => setManualModel(event.target.value)} /></label>
            <footer><Dialog.Close asChild><button type="button" className="quiet-button">{t('codexAuth.cancel')}</button></Dialog.Close><button type="submit" className="primary-button" disabled={!manualModel.trim()}>{t('codexProvider.useModel')}</button></footer>
          </form></div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>}
      {reloadNotice && <div className={`provider-reload-toast ${reloadNotice.kind}`} role={reloadNotice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
        {reloadNotice.kind === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        <span>{reloadNotice.message}</span>
        <button type="button" aria-label={t("ui.Composer.RuntimeMenu.dismiss_agent_reload_message_3b25a1a")} onClick={dismissReloadNotice}><X size={14} /></button>
      </div>}
    </>
  )
}

function BackendMenu({ session, running, admitting }: { session: Session; running: boolean; admitting: boolean }) {
  useLocale()
  const healthRevision = useAppStore(state => queueShelfHealthContractRevision(state.health))
  const health = useMemo(() => useAppStore.getState().health, [healthRevision])
  const catalog = useAppStore(state => state.runtimeCatalog)
  const cursorAvailable = cursorBackendAvailable(health, catalog)
  const cursorUnavailableReason = cursorBackendUnavailableReason(health, catalog)
  const openCodeAvailable = opencodeBackendAvailable(health, catalog)
  const openCodeUnavailableReason = opencodeBackendUnavailableReason(health, catalog)
  const backends = selectableChatBackendChoices(health, catalog)
  const providerLocked = isBackendLocked(session)
  const disabled = providerLocked || running || admitting
  const title = providerLocked
    ? 'Backend is fixed after the provider session starts'
    : running
      ? 'Wait for the active turn to finish before changing backend'
      : admitting
        ? 'Wait for the message to be accepted before changing backend'
        : t('ui.composer.changeAgent')
  const providerLabel = backendLabel(session.backend, session.codex_provider)
  const compactLabel = session.backend === 'codex' && session.codex_provider === 'custom'
    ? t('codexProvider.compactLabel')
    : providerLabel
  const chip = <button className="backend-chip" title={title} aria-label={providerLabel} disabled={disabled}><BackendMark backend={session.backend} size={17} /><span>{compactLabel}</span>{!disabled && <ChevronDown size={12} />}</button>
  if (disabled) return chip
  return <Tooltip.Provider delayDuration={250}><DropdownMenu.Root><DropdownMenu.Trigger asChild>{chip}</DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="start">{backends.map(choice => {
    const { backend, codex_provider } = chatBackendSelection(choice)
    if (choice === 'codex-custom' && !codexCustomProviderAvailable(health, catalog)) return <DropdownMenu.Item key={choice} className="menu-item" onSelect={() => {
      window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'server' }))
      useAppStore.getState().setModal('appSettings', true)
    }}><BackendMark backend="codex" size={15} />{t('codexProvider.label')}{' '}<span className="menu-item-locked-hint">{t('codexProvider.configure')}</span></DropdownMenu.Item>
    const unavailable = backend === 'cursor' && !cursorAvailable || backend === 'opencode' && !openCodeAvailable
    const unavailableReason = (backend === 'opencode' ? openCodeUnavailableReason : cursorUnavailableReason) || t('ui.Composer.agentUnavailableFallback')
    if (unavailable) return <Tooltip.Root key={backend}>
      <Tooltip.Trigger asChild>
        <DropdownMenu.Item className="menu-item backend-unavailable-item" aria-disabled="true" onSelect={event => event.preventDefault()}>
          <BackendMark backend={backend} size={15} />
          {backendLabel(backend)}
          <span className="menu-item-locked-hint">{t("ui.Composer.unavailable_ca18449")}</span>
          <span className="backend-unavailable-info" aria-hidden="true"><Info size={13} /></span>
        </DropdownMenu.Item>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="shortcut-tooltip backend-unavailable-tooltip" side="right" sideOffset={7}><span>{unavailableReason}</span><Tooltip.Arrow className="shortcut-tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
    return <DropdownMenu.CheckboxItem key={choice} className="menu-item" checked={chatBackendChoice(session) === choice} onCheckedChange={() => void useAppStore.getState().updateSession(session.id, { backend, codex_provider, model: null, effort: null })}><BackendMark backend={backend} size={15} />{backendLabel(backend, codex_provider)}</DropdownMenu.CheckboxItem>
  })}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></Tooltip.Provider>
}

function AttachmentShelf({ sessionId, profileId, profileGeneration, files, pending }: { sessionId: string; profileId: string | null; profileGeneration: number; files: AgentFile[]; pending: NativeFileRef[] }) {
  useLocale()
  return <div className="attachment-shelf">
    {files.map(file => <div className="attachment-chip" key={file.id}>{effectiveFileContentType(file).startsWith('image/') ? <img src={profileId ? window.agentsDock.files.mediaURL(profileId, profileGeneration, sessionId, file.id) : undefined} alt="" /> : <span className="attachment-file-icon" aria-hidden="true"><File size={15} /></span>}<span className="attachment-details"><strong>{file.filename}</strong><small>{formatBytes(file.size)}</small></span><button type="button" aria-label={t("ui.Composer.remove_6f8460e", { "filename": String(file.filename) })} onClick={() => useAppStore.getState().removeUploadForSession(sessionId, file.id)}><X size={13} /></button></div>)}
    {pending.map(file => <div className="attachment-chip pending" role="status" aria-label={t("ui.Composer.uploading_222aa45", { "filename": String(file.name) })} key={file.path}><span className="attachment-file-icon" aria-hidden="true"><File size={15} /></span><span className="attachment-details"><strong>{file.name}</strong><small>{t("ui.Composer.uploading_5ce44dd")}</small></span></div>)}
  </div>
}

const QueueShelf = memo(function QueueShelf({
  profileId,
  profileGeneration,
  serverIdentity,
  sessionId,
  turns,
  queueOrderTurns,
  pendingSubmission,
  running,
  activeCodexGoal,
  steeringPending,
  sourceSession,
  supportedChatActions,
  supportedTargetBackends,
  routeHintsSupported,
  teamMentionsSupported
}: {
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  sessionId: string
  turns: QueuedTurn[]
  queueOrderTurns: QueuedTurn[]
  pendingSubmission?: PendingTurnSubmission
  running: boolean
  activeCodexGoal: boolean
  steeringPending: boolean
  sourceSession: Session
  supportedChatActions: ChatReferenceAction[]
  supportedTargetBackends: Session['backend'][]
  routeHintsSupported: boolean
  teamMentionsSupported: boolean
}) {
  useLocale()
  const queuedTeamMentionPaletteId = `queued-team-mention-${useId().replace(/:/g, '')}`
  const steeringScope = useMemo<SteeringScope>(
    () => ({ profileId, profileGeneration, serverIdentity, sessionId }),
    [profileGeneration, profileId, serverIdentity, sessionId]
  )
  const [editing, setEditing] = useState<QueuedTurn | null>(null)
  const editingAgentMessage = Boolean(editing && isAsyncAgentQueuedTurn(editing))
  const [draft, setDraft] = useState('')
  const [editingReferences, setEditingReferences] = useState<ChatReference[]>([])
  const [editingTeamReferences, setEditingTeamReferences] = useState<TeamReference[]>([])
  const [editMention, setEditMention] = useState<ChatMentionTrigger | null>(null)
  const [editMentionIndex, setEditMentionIndex] = useState(0)
  const [editTeamMention, setEditTeamMention] = useState<TeamMentionTrigger | null>(null)
  const [editTeamMentionIndex, setEditTeamMentionIndex] = useState(0)
  const [editTeamMentionCandidates, setEditTeamMentionCandidates] = useState<TeamMentionCandidate[]>([])
  const [editorMirrorAligned, setEditorMirrorAligned] = useState(true)
  const [savingEdit, setSavingEdit] = useState(false)
  const [drop, setDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const [moving, setMoving] = useState(false)
  const movingRef = useRef(false)
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const queuedSelectionRef = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null>(null)
  const queuedNativeEditSelectionRef = useRef<ComposerNativeEditSelection | null>(null)
  const editorMirrorRef = useRef<HTMLDivElement | null>(null)
  const editorMirrorAlignedRef = useRef(true)
  const editorLayoutFrameRef = useRef<number | null>(null)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const healthRevision = useAppStore(state => queueShelfHealthContractRevision(state.health))
  const health = useMemo(() => useAppStore.getState().health, [healthRevision])
  const teamAllServersSupported = teamAllServersAliasAvailable(health)
  const mixedReorder = exactQueuedDeliveryReorderAvailable(health)
  const asyncControls = asyncQueuedMessageControlsAvailable(health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const grantedRoutes = useAppStore(state => state.agentRoutesBySession[sessionId]?.routes ?? EMPTY_AGENT_ROUTES)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const pausedCount = turns.filter(turn => turn.paused === true).length
  const promotedCount = queueOrderTurns.filter(turn => turn.promoted === true).length
  const firstFencedTurn = queuedTurnsInPositionOrder(turns)
    .find(turn => queuedTurnCrossChatFence(queueOrderTurns, turn.queued_id, mixedReorder, asyncControls).runNow) ?? null
  const blockingDelivery = firstFencedTurn
    ? firstBlockingCrossChatDelivery(queueOrderTurns, firstFencedTurn.queued_id)
    : null
  // Keep the escape on the owner row whenever it is visible in this queue.
  const hiddenBlockingDelivery = blockingDelivery && !isVisibleQueuedTurn(blockingDelivery)
    ? blockingDelivery
    : null
  const referenceTargetsRevision = useAppStore(state => editingReferences.map(reference => {
    if (reference.target_kind === 'secure_peer') {
      return `secure:${reference.target_route_id}:${reference.target_route_revision}:unsupported`
    }
    const target = state.sessions.find(candidate => candidate.id === reference.session_id)
    const grant = state.agentRoutesBySession[sessionId]?.routes.find(route => route.target_session_id === reference.session_id)
    return `${reference.session_id}:${target?.backend ?? 'missing'}:${target?.archived ? 'archived' : 'active'}:${grant?.revision ?? 'ungranted'}`
  }).join('|'))
  const editMentionCandidates = useMemo(() => {
    if (!editMention || !routeHintsSupported) return []
    const grantedTargets = new Set(grantedRoutes
      .filter(route => route.actions.includes('instruction'))
      .map(route => route.target_session_id))
    const active = orderedActiveSessions(sessions, folderOrder).filter(candidate => (
      candidate.id !== sessionId
      && !candidate.archived
      && grantedTargets.has(candidate.id)
      && supportedTargetBackends.includes(candidate.backend)
    ))
    return rankSessionsForSearch(active, editMention.query, new Set())
  }, [editMention, folderOrder, grantedRoutes, routeHintsSupported, sessionId, sessions, supportedTargetBackends])
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && supportedTargetBackends.includes(sourceSession.backend)
  const referenceSupported = (reference: ChatReference): boolean => {
    void referenceTargetsRevision
    if (reference.target_kind === 'secure_peer') return false
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    const granted = grantedRoutes.some(route => agentRouteAllowsReference(route, reference))
    const currentRouteHint = currentRouteHintReference(draft, reference)
    return Boolean(
      (currentRouteHint
        ? routeHintsSupported
        : supportedChatActions.includes(reference.action)
          && (reference.action !== 'request_reply' || requestReplySupportedForSource))
      && target
      && granted
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  }
  const editingChatReferencesSupported = editingReferences.every(referenceSupported)
  const editingHasRemoteAgentReference = editingReferences.some(reference => reference.target_kind === 'secure_peer')
  const editingUnsupportedAllServersReference = !teamAllServersSupported && hasAllServersReference(editingTeamReferences)
  const editingTeamReferencesSupported = (editingTeamReferences.length === 0 || teamMentionsSupported) && !editingUnsupportedAllServersReference
  const editingReferencesSupported = editingChatReferencesSupported && editingTeamReferencesSupported
  // Match the main composer: the native textarea owns glyphs, caret, selection,
  // and spellcheck; the optional mirror paints only inline chip decorations.
  const editingInlineReferences = useMemo(
    () => validComposerReferences(
      draft,
      editingReferences,
      editingTeamReferences,
      (text, candidates) => validChatReferences(text, candidates, sessionId)
    ),
    [draft, editingReferences, editingTeamReferences, sessionId]
  )
  const editingInlineReferenceSpans = useMemo(
    () => orderedComposerReferenceSpans(editingInlineReferences.chatReferences, editingInlineReferences.teamReferences),
    [editingInlineReferences]
  )
  const editingMessageProjection = useMemo(() => projectTeamMessageComposer(draft), [draft])
  const editingDisplayedReferences = useMemo(() => {
    const project = <T extends ChatReference | TeamReference,>(reference: T): T => ({
      ...reference,
      source_text_start: composerSourceToDisplay(editingMessageProjection, reference.source_text_start),
      source_text_end: composerSourceToDisplay(editingMessageProjection, reference.source_text_end)
    })
    return {
      chatReferences: editingInlineReferences.chatReferences.map(project),
      teamReferences: editingInlineReferences.teamReferences.map(project)
    }
  }, [editingInlineReferences, editingMessageProjection])
  const editingDisplayedSpans = useMemo(() => orderedComposerReferenceSpans(
    editingDisplayedReferences.chatReferences, editingDisplayedReferences.teamReferences
  ), [editingDisplayedReferences])
  const hasEditingMessageLinks = editingMessageProjection.links.length > 0
  const hasEditingStructuredReferences = editingInlineReferenceSpans.length > 0
  const hasEditingInlineReferences = hasEditingStructuredReferences && composerTextCanUseMirror(editingMessageProjection.text, editingDisplayedSpans)
  const hasEditingReferenceFallback = hasEditingStructuredReferences && (!hasEditingInlineReferences || !editorMirrorAligned)
  const recordEditingMirrorAlignment = useCallback((aligned: boolean | null) => {
    if (aligned === null || editorMirrorAlignedRef.current === aligned) return
    editorMirrorAlignedRef.current = aligned
    setEditorMirrorAligned(aligned)
  }, [])
  const scheduleEditingLayout = useCallback(() => {
    scheduleComposerEditorLayout(editorTextareaRef.current, editorMirrorRef.current, editorLayoutFrameRef, recordEditingMirrorAlignment)
  }, [recordEditingMirrorAlignment])
  useEffect(() => {
    scheduleEditingLayout()
  }, [draft, editingInlineReferenceSpans, scheduleEditingLayout])
  useEffect(() => observeComposerEditorWidth(editorTextareaRef.current, scheduleEditingLayout), [editing?.queued_id, scheduleEditingLayout])
  useEffect(() => () => cancelComposerEditorLayout(editorTextareaRef.current, editorLayoutFrameRef), [])
  useLayoutEffect(() => {
    const selection = queuedSelectionRef.current
    if (!selection) return
    queuedSelectionRef.current = null
    editorTextareaRef.current?.setSelectionRange(
      composerSourceToDisplay(editingMessageProjection, selection.start),
      composerSourceToDisplay(editingMessageProjection, selection.end), selection.direction
    )
  }, [editingMessageProjection])
  useEffect(() => {
    setEditMentionIndex(index => Math.max(0, Math.min(index, Math.max(0, editMentionCandidates.length - 1))))
  }, [editMentionCandidates.length])
  useEffect(() => {
    setEditTeamMentionIndex(index => Math.max(0, Math.min(index, Math.max(0, editTeamMentionCandidates.length - 1))))
  }, [editTeamMentionCandidates.length])
  useEffect(() => {
    if (!editing) return
    const current = queueOrderTurns.find(turn => turn.queued_id === editing.queued_id)
    if (!current || current.promoted === true) setEditing(null)
  }, [editing, queueOrderTurns])
  if (!turns.length && !pendingSubmission) return null
  const moveTo = async (activeId: string, targetId: string, placement: 'before' | 'after') => {
    if (movingRef.current || !profileIsActive(profileId, profileGeneration)) return
    movingRef.current = true
    setMoving(true)
    try {
      const latestQueue = useAppStore.getState().snapshots[sessionId]?.queuedTurns ?? queueOrderTurns
      const allowMixed = exactQueuedDeliveryReorderAvailable(useAppStore.getState().health)
      if (latestQueue.some(turn => turn.queued_id === activeId && turn.promoted === true)) {
        throw new Error('This queued message is already starting and can no longer be moved.')
      }
      if (latestQueue.some(turn => turn.queued_id === targetId && turn.promoted === true)) return
      if (queuedMoveCrossesCrossChatDelivery(latestQueue, activeId, targetId, placement, allowMixed)) {
        throw new Error('Incoming cross-chat deliveries keep their arrival position.')
      }
      const ordered = queuedTurnsInPositionOrder(latestQueue)
      const from = ordered.findIndex(turn => turn.queued_id === activeId)
      const target = ordered.findIndex(turn => turn.queued_id === targetId)
      if (from < 0 || target < 0) return
      let to = target + (placement === 'after' ? 1 : 0)
      if (from < to) to -= 1
      const direction = from < to ? 'down' : 'up'
      const adjacentIds = (from < to ? ordered.slice(from + 1, to + 1) : ordered.slice(to, from).reverse())
        .map(turn => turn.queued_id)
      let currentQueue = ordered
      for (const adjacentId of adjacentIds) {
        if (!profileIsActive(profileId, profileGeneration)) return
        const state = useAppStore.getState()
        const currentIndex = currentQueue.findIndex(turn => turn.queued_id === activeId)
        const active = currentQueue[currentIndex]
        const adjacent = currentQueue[currentIndex + (direction === 'down' ? 1 : -1)]
        if (!active || adjacent?.queued_id !== adjacentId) throw new Error(t('composer.queueOrderChanged'))
        if (!isReorderableQueuedTurn(active, allowMixed) || !isReorderableQueuedTurn(adjacent, allowMixed)
          || (allowMixed && !exactQueuedDeliveryReorderAvailable(state.health))) {
          throw new Error(t('composer.queueOrderChanged'))
        }
        const request = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
        const next = allowMixed
          ? await window.agentsDock.queue.move(sessionId, activeId, direction, adjacentId)
          : await window.agentsDock.queue.move(sessionId, activeId, direction)
        if (!profileIsActive(profileId, profileGeneration)) return
        // A successful move is already durable. Its streamed reorder event can
        // legitimately supersede this response lease before the IPC call
        // resolves; retain the newer projection but continue the requested
        // adjacent moves until the final placement is reached.
        useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, next)
        // Use the completed operation's authoritative list for the next step:
        // a streamed event may invalidate its lease before its batched display
        // projection lands. The exact-neighbor server guard catches any newer
        // mutation without publishing an optimistic local ordering.
        currentQueue = queuedTurnsInPositionOrder(next)
      }
    } catch (error) {
      if (profileIsActive(profileId, profileGeneration)) {
        // A promotion or concurrent reorder may have won. Refresh without
        // replacing a newer streamed snapshot, then surface the conflict.
        if (window.agentsDock.queue.list) {
          const request = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
          await window.agentsDock.queue.list(sessionId).then(next => {
            if (profileIsActive(profileId, profileGeneration)) useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, next)
          }).catch(() => undefined)
        }
        if (profileIsActive(profileId, profileGeneration)) reportActionError(error)
      }
    } finally {
      movingRef.current = false
      setMoving(false)
    }
  }
  const onDragOver = (event: DragOverEvent) => {
    if (!event.over) return setDrop(null)
    const translated = event.active.rect.current.translated
    const center = translated ? translated.top + translated.height / 2 : 0
    setDrop({ id: String(event.over.id), placement: center < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after' })
  }
  const onDragEnd = (event: DragEndEvent) => {
    const current = drop; setDrop(null)
    if (event.over && current && event.active.id !== event.over.id) void moveTo(String(event.active.id), String(event.over.id), current.placement)
  }
  const updateQueuedDraft = (next: string, caret: number) => {
    if (editingAgentMessage) { setDraft(next); return }
    const reconciledChatReferences = reconcileChatReferences(draft, next, editingReferences)
    const reconciledTeamReferences = reconcileTeamReferences(draft, next, editingTeamReferences)
    const nextReferences = validComposerReferences(
      next,
      reconciledChatReferences,
      reconciledTeamReferences,
      (text, candidates) => validChatReferences(text, candidates, sessionId)
    )
    setEditingReferences(nextReferences.chatReferences)
    setEditingTeamReferences(nextReferences.teamReferences)
    setDraft(next)
    const teamTrigger = teamMentionTrigger(next, caret, nextReferences.chatReferences, nextReferences.teamReferences)
    setEditTeamMention(teamMentionsSupported ? teamTrigger : null)
    setEditTeamMentionCandidates([])
    setEditTeamMentionIndex(0)
    setEditMention(routeHintsSupported && !teamTrigger ? chatMentionTrigger(next, caret, nextReferences.chatReferences) : null)
    setEditMentionIndex(0)
  }
  const chooseQueuedMention = (target: Session) => {
    if (!editMention || !routeHintsSupported) return
    if (!grantedRoutes.some(route => (
      route.target_session_id === target.id
      && route.actions.includes('instruction')
    ))) {
      useAppStore.getState().setError('Queue edits can use only chats already granted Send access. Send a normal @Chat message first.')
      setEditMention(null)
      return
    }
    if (editingReferences.some(reference => reference.target_kind !== 'secure_peer' && reference.session_id === target.id)) {
      useAppStore.getState().setError(`A route hint for ${target.title} is already selected.`)
      setEditMention(null)
      return
    }
    if (editingReferences.length >= MAX_CHAT_REFERENCES) {
      useAppStore.getState().setError(`A queued message can reference at most ${MAX_CHAT_REFERENCES} chats. Remove a chat reference before adding another.`)
      setEditMention(null)
      return
    }
    try {
      const inserted = insertChatReference(draft, editMention, target, 'route', { grantIntent: true })
      const shifted = reconcileChatReferences(draft, inserted.text, editingReferences)
      const shiftedTeam = reconcileTeamReferences(draft, inserted.text, editingTeamReferences)
      const validated = validComposerReferences(
        inserted.text,
        [...shifted, inserted.reference],
        shiftedTeam,
        (text, candidates) => validChatReferences(text, candidates, sessionId)
      )
      setDraft(inserted.text)
      setEditingReferences(validated.chatReferences)
      setEditingTeamReferences(validated.teamReferences)
      setEditMention(null)
      window.requestAnimationFrame(() => {
        editorTextareaRef.current?.focus()
        const caret = composerSourceToDisplay(projectTeamMessageComposer(inserted.text), inserted.caret)
        editorTextareaRef.current?.setSelectionRange(caret, caret)
      })
    } catch (error) {
      reportActionError(error)
      setEditMention(null)
    }
  }
  const chooseQueuedTeamMention = (candidate: TeamMentionCandidate) => {
    if (!editTeamMention || !teamMentionsSupported) return
    const duplicate = editingTeamReferences.some(reference => (
      reference.kind === candidate.target.kind
      && (candidate.target.kind !== 'recipient'
        || (reference.kind === 'recipient' && reference.recipient_kind === candidate.target.recipient_kind))
      && reference.team_id === candidate.target.team_id
      && reference.target_id === candidate.target.target_id
    ))
    if (duplicate) {
      reportActionError(new Error(`${candidate.label} is already selected.`))
      setEditTeamMention(null)
      setEditTeamMentionCandidates([])
      return
    }
    try {
      const inserted = insertTeamReference(draft, editTeamMention, candidate.target)
      const shiftedChat = reconcileChatReferences(draft, inserted.text, editingReferences)
      const shiftedTeam = reconcileTeamReferences(draft, inserted.text, editingTeamReferences)
      const validated = validComposerReferences(
        inserted.text,
        shiftedChat,
        [...shiftedTeam, inserted.reference],
        (text, candidates) => validChatReferences(text, candidates, sessionId)
      )
      setDraft(inserted.text)
      setEditingReferences(validated.chatReferences)
      setEditingTeamReferences(validated.teamReferences)
      setEditTeamMention(null)
      setEditTeamMentionCandidates([])
      window.requestAnimationFrame(() => {
        editorTextareaRef.current?.focus()
        const caret = composerSourceToDisplay(projectTeamMessageComposer(inserted.text), inserted.caret)
        editorTextareaRef.current?.setSelectionRange(caret, caret)
      })
    } catch (error) {
      reportActionError(error)
      setEditTeamMention(null)
      setEditTeamMentionCandidates([])
    }
  }
  const saveEdit = async (steer = false) => {
    if (!editing || savingEdit) return
    if (steer && running && sourceSession?.backend === 'opencode') { reportActionError(t('opencode.steerUnavailable')); return }
    if (!profileIsActive(profileId, profileGeneration)) return
    let steerConsent: InboundDeliveryConsent | undefined
    if (steer) {
      const consent = confirmInboundDeliveryInterruption(sessionId, 'send_now')
      if (!consent) return
      steerConsent = consent
    }
    setSavingEdit(true)
    try {
      if (steer) {
        const state = useAppStore.getState()
        const latestQueue = state.snapshots[sessionId]?.queuedTurns ?? queueOrderTurns
        if (latestQueue.some(turn => turn.promoted === true)) {
          throw new Error('A queued message is already starting. Wait for its provider handoff to finish.')
        }
        const currentSource = state.sessions.find(candidate => candidate.id === sessionId) ?? sourceSession
        const runtimeError = queuedTurnRuntimeAdmissionError(editing, currentSource, state.health, state.runtimeCatalog)
        if (runtimeError) throw new Error(runtimeError)
        if (queuedTurnCrossChatFence(latestQueue, editing.queued_id, mixedReorder, asyncQueuedMessageControlsAvailable(state.health)).runNow) {
          throw new Error('An incoming cross-chat delivery must run before this queued message.')
        }
      }
      if (editingAgentMessage) {
        if (!asyncQueuedMessageControlsAvailable(useAppStore.getState().health) || !Number.isInteger(editing.message_revision)) {
          throw new Error(t('composer.agentQueue.updateRequired'))
        }
        await window.agentsDock.queue.update(sessionId, editing.queued_id, draft, undefined, undefined, undefined, editing.message_revision!)
        if (!profileIsActive(profileId, profileGeneration)) return
        const current = useAppStore.getState().snapshots[sessionId]?.queuedTurns ?? turns
        useAppStore.getState().setQueued(sessionId, current.map(turn => turn.queued_id === editing.queued_id
          && turn.cross_chat_envelope_id === editing.cross_chat_envelope_id
          && (turn.message_revision ?? -1) <= editing.message_revision! ? {
            ...turn, prompt: draft, display_prompt: draft, message_body: draft,
            message_edited_by_user: true, message_revision: editing.message_revision! + 1
          } : turn))
        setEditing(null)
        if (steer) {
          const promotion = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
          const remaining = await steerQueuedTurn(steeringScope, editing.queued_id,
            () => Boolean(confirmInboundDeliveryInterruption(sessionId, 'send_now', steerConsent)))
          if (profileIsActive(profileId, profileGeneration)) useAppStore.getState().applyQueuedTurnsResponse(sessionId, promotion, remaining)
        }
        return
      }
      if (editingReferences.length > MAX_CHAT_REFERENCES) {
        throw new Error(`A queued message can reference at most ${MAX_CHAT_REFERENCES} chats. Remove a chat reference and try again.`)
      }
      const validatedReferences = validComposerReferences(
        draft,
        editingReferences,
        editingTeamReferences,
        (text, candidates) => validChatReferences(text, candidates, sessionId)
      )
      const chatReferences = validatedReferences.chatReferences
      const teamReferences = validatedReferences.teamReferences
      if (sourceSession.backend === 'opencode' && chatReferences.length) throw new Error(t('opencode.crossChatUnavailable'))
      if (chatReferences.length !== editingReferences.length) {
        throw new Error('A queued chat reference was edited or is no longer valid. Remove it or select @Chat again.')
      }
      if (teamReferences.length !== editingTeamReferences.length) {
        throw new Error(t('teamNetwork.mention.queuedReferenceEdited'))
      }
      if (chatReferences.some(reference => reference.target_kind === 'secure_peer')) {
        throw new Error(remoteAgentRouteUnavailable())
      }
      if (!chatReferences.every(referenceSupported)) {
        throw new Error('This server cannot deliver one or more queued cross-chat actions or targets. Change the action or update the server.')
      }
      if (teamReferences.length && !teamMentionsSupported) {
        throw new Error(t('teamNetwork.mention.queuedUnsupported'))
      }
      await requireAllServersReferenceSupport(teamReferences, profileId, profileGeneration, serverIdentity)
      if (!profileIsActive(profileId, profileGeneration) || activeIdentity(useAppStore.getState()) !== serverIdentity) return
      const state = useAppStore.getState()
      const clientCapabilities = interactiveClientCapabilities(sourceSession, state.health)
      if (editing.team_references != null || teamReferences.length) {
        await window.agentsDock.queue.update(
          sessionId,
          editing.queued_id,
          draft,
          chatReferences,
          clientCapabilities,
          teamReferences
        )
      } else {
        await window.agentsDock.queue.update(
          sessionId,
          editing.queued_id,
          draft,
          chatReferences,
          clientCapabilities
        )
      }
      if (!profileIsActive(profileId, profileGeneration)) return
      const current = useAppStore.getState().snapshots[sessionId]?.queuedTurns ?? turns
      useAppStore.getState().setQueued(sessionId, current.map(turn => turn.queued_id === editing.queued_id ? {
        ...turn,
        prompt: draft,
        display_prompt: draft,
        chat_references: chatReferences,
        team_references: teamReferences
      } : turn))
      // The edit is durable once queue.update returns. Close the editor and
      // expose that committed row before treating Send now as a separate,
      // independently-confirmed promotion.
      setEditing(null)
      if (steer) {
        const currentState = useAppStore.getState()
        const currentSource = currentState.sessions.find(candidate => candidate.id === sessionId) ?? sourceSession
        const currentRuntimeError = queuedTurnRuntimeAdmissionError(editing, currentSource, currentState.health, currentState.runtimeCatalog)
        if (currentRuntimeError) throw new Error(currentRuntimeError)
        const request = currentState.beginQueuedTurnsRequest(sessionId)
        const turns = await steerQueuedTurn(
          steeringScope,
          editing.queued_id,
          () => Boolean(confirmInboundDeliveryInterruption(sessionId, 'send_now', steerConsent))
        )
        if (!profileIsActive(profileId, profileGeneration)) return
        useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, turns)
      }
    } catch (error) { if (!isSteeringCancellation(error) && profileIsActive(profileId, profileGeneration)) reportActionError(error) }
    finally { setSavingEdit(false) }
  }
  const displayedCount = turns.length + (pendingSubmission ? 1 : 0)
  return <div className="queue-shelf"><div className="queue-header"><div className="queue-label"><ListOrdered size={13} /><span>{t("ui.Composer.QueueShelf.queued_turns_580e983")}</span><b>{displayedCount}</b>{promotedCount > 0
    ? <small>{promotedCount === 1 ? t("ui.Composer.QueueShelf.1_starting_dc0a211") : t("ui.Composer.QueueShelf.starting_37f2a6b", { "count": String(promotedCount) })}</small>
    : pausedCount > 0 && <small>{pausedCount === displayedCount ? t("ui.Composer.QueueShelf.paused_e159b06") : t("ui.Composer.QueueShelf.paused_c123acb", { "count": String(pausedCount) })}</small>}</div></div><DndContext sensors={sensors} onDragOver={onDragOver} onDragEnd={onDragEnd}>
    <div className="queue-list">{queuedTurnsInPositionOrder(turns).map(turn => <QueuedRow key={turn.queued_id} profileId={profileId} profileGeneration={profileGeneration} steeringScope={steeringScope} turn={turn} sourceSessionTitle={turn.source_session_id && !turn.source_title?.trim() ? sessions.find(session => session.id === turn.source_session_id)?.title : undefined} sessionId={sessionId} running={running} activeCodexGoal={activeCodexGoal} drop={drop} steeringPending={steeringPending} promotionPending={promotedCount > 0} runtimeError={queuedTurnRuntimeAdmissionError(turn, sourceSession, health, catalog)} crossChatFence={queuedTurnCrossChatFence(queueOrderTurns, turn.queued_id, mixedReorder, asyncControls)} blockingDelivery={turn.queued_id === firstFencedTurn?.queued_id ? hiddenBlockingDelivery : null} canSkipExactDelivery={exactQueuedDeliverySkipAvailable(health)} canSkipExactPeerDelivery={exactQueuedPeerDeliverySkipAvailable(health)} asyncControls={asyncControls} reorderable={isReorderableQueuedTurn(turn, mixedReorder)} moving={moving} onMove={direction => {
      const latestQueue = queuedTurnsInPositionOrder(useAppStore.getState().snapshots[sessionId]?.queuedTurns ?? queueOrderTurns)
      const index = latestQueue.findIndex(candidate => candidate.queued_id === turn.queued_id)
      const adjacent = latestQueue[index + (direction === 'down' ? 1 : -1)]
      if (index >= 0 && adjacent) void moveTo(turn.queued_id, adjacent.queued_id, direction === 'down' ? 'after' : 'before')
    }} onEdit={body => {
      const text = body ?? turn.display_prompt ?? turn.prompt
      const canonical = isAsyncAgentQueuedTurn(turn)
        ? { text, chatReferences: [], teamReferences: [] }
        : canonicalizeComposerReferences(
        text,
        turn.chat_references ?? [],
        turn.team_references ?? [],
        sessionId,
        routeHintsSupported
      )
      setEditing(turn)
      setDraft(canonical.text)
      setEditingReferences(canonical.chatReferences)
      setEditingTeamReferences(canonical.teamReferences)
      setEditMention(null)
      setEditTeamMention(null)
      setEditTeamMentionCandidates([])
    }} />)}{pendingSubmission && <PendingQueuedRow submission={pendingSubmission} />}</div>
  </DndContext>
  {editing && <div className="inline-editor">
    {editingAgentMessage ? <>
      <small className="queue-agent-edit-note">{t('composer.agentQueue.editNote')}</small>
      <textarea aria-label={t('composer.agentQueue.editMessage')} value={draft} onChange={event => setDraft(event.target.value)}
        disabled={savingEdit} autoFocus onKeyDown={event => {
          if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveEdit(true) }
        }} />
    </> : <div className={`composer-editor inline-queue-reference-editor${hasEditingInlineReferences ? ' has-inline-references' : ''}${hasEditingMessageLinks ? ' has-message-links' : ''}`}>
      {(hasEditingInlineReferences || hasEditingMessageLinks) && <ComposerEditorMirror
        ref={editorMirrorRef}
        text={editingMessageProjection.text}
        chatReferences={hasEditingInlineReferences ? editingDisplayedReferences.chatReferences : EMPTY_CHAT_REFERENCES}
        teamReferences={hasEditingInlineReferences ? editingDisplayedReferences.teamReferences : EMPTY_TEAM_REFERENCES}
        messageLinks={editingMessageProjection.links}
        onEdit={() => editorTextareaRef.current?.focus()}
        referenceSupported={reference => referenceSupported({
          ...reference,
          source_text_start: composerDisplayToSource(editingMessageProjection, reference.source_text_start),
          source_text_end: composerDisplayToSource(editingMessageProjection, reference.source_text_end)
        })}
        teamReferencesSupported={editingTeamReferencesSupported}
      />}
      <textarea
        ref={editorTextareaRef}
        value={editingMessageProjection.text}
        onChange={event => {
          const edit = applyTeamMessageComposerEdit(editingMessageProjection, event.target.value, event.target.selectionStart, event.target.selectionEnd, queuedNativeEditSelectionRef.current)
          queuedNativeEditSelectionRef.current = null
          if (projectTeamMessageComposer(edit.source).text !== event.target.value) {
            queuedSelectionRef.current = {
              start: edit.selectionStart, end: edit.selectionEnd, direction: event.target.selectionDirection
            }
          }
          updateQueuedDraft(edit.source, edit.selectionStart)
        }}
        onBeforeInput={event => {
          queuedNativeEditSelectionRef.current = { source: draft, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }
        }}
        onInput={event => {
          if (event.currentTarget.value !== editingMessageProjection.text || !queuedNativeEditSelectionRef.current) return
          const edit = applyTeamMessageComposerEdit(
            editingMessageProjection, event.currentTarget.value,
            event.currentTarget.selectionStart, event.currentTarget.selectionEnd, queuedNativeEditSelectionRef.current
          )
          queuedNativeEditSelectionRef.current = null
          if (edit.source !== draft) updateQueuedDraft(edit.source, edit.selectionStart)
        }}
        onPaste={event => {
          queuedNativeEditSelectionRef.current = { source: draft, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }
        }}
        onCut={event => {
          queuedNativeEditSelectionRef.current = { source: draft, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }
        }}
        onFocus={event => {
          const caret = composerDisplayToSource(editingMessageProjection, event.currentTarget.selectionStart)
          const teamTrigger = teamMentionTrigger(draft, caret, editingReferences, editingTeamReferences)
          setEditTeamMention(teamMentionsSupported ? teamTrigger : null)
          setEditMention(routeHintsSupported && !teamTrigger
            ? chatMentionTrigger(draft, caret, editingReferences)
            : null)
        }}
        onClick={event => {
          const rawCaret = event.currentTarget.selectionStart
          const displayCaret = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ? atomicComposerReferenceCaret(rawCaret, [
              ...editingDisplayedSpans,
              ...editingMessageProjection.links.map(link => ({ source_text_start: link.displayStart, source_text_end: link.displayEnd }))
            ])
            : rawCaret
          if (displayCaret !== rawCaret) event.currentTarget.setSelectionRange(displayCaret, displayCaret)
          const caret = composerDisplayToSource(editingMessageProjection, displayCaret)
          const teamTrigger = teamMentionTrigger(draft, caret, editingReferences, editingTeamReferences)
          setEditTeamMention(teamMentionsSupported ? teamTrigger : null)
          setEditTeamMentionCandidates([])
          setEditTeamMentionIndex(0)
          setEditMention(routeHintsSupported && !teamTrigger ? chatMentionTrigger(draft, caret, editingReferences) : null)
          setEditMentionIndex(0)
        }}
        onScroll={event => recordEditingMirrorAlignment(syncComposerEditorMirror(event.currentTarget, editorMirrorRef.current))}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          const atomicSpans = [
            ...orderedComposerReferenceSpans(editingReferences, editingTeamReferences),
            ...editingMessageProjection.links.map(link => ({ source_text_start: link.start, source_text_end: link.end }))
          ].sort((left, right) => left.source_text_start - right.source_text_start)
          const collapsed = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
          const selectionStart = composerDisplayToSource(editingMessageProjection, event.currentTarget.selectionStart, collapsed ? 'nearest' : 'start')
          const selectionEnd = composerDisplayToSource(editingMessageProjection, event.currentTarget.selectionEnd, collapsed ? 'nearest' : 'end')
          if (editTeamMention) {
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditTeamMention(null)
              setEditTeamMentionCandidates([])
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const direction = event.key === 'ArrowDown' ? 1 : -1
              setEditTeamMentionIndex(index => editTeamMentionCandidates.length
                ? (index + direction + editTeamMentionCandidates.length) % editTeamMentionCandidates.length
                : 0)
              return
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && editTeamMentionCandidates[editTeamMentionIndex]) {
              event.preventDefault()
              chooseQueuedTeamMention(editTeamMentionCandidates[editTeamMentionIndex])
              return
            }
          }
          if (editMention) {
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditMention(null)
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const direction = event.key === 'ArrowDown' ? 1 : -1
              setEditMentionIndex(index => editMentionCandidates.length
                ? (index + direction + editMentionCandidates.length) % editMentionCandidates.length
                : 0)
              return
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && editMentionCandidates[editMentionIndex]) {
              event.preventDefault()
              chooseQueuedMention(editMentionCandidates[editMentionIndex])
              return
            }
          }
          if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
            const edit = atomicComposerReferenceDeletion(
              draft,
              atomicSpans,
              selectionStart,
              selectionEnd,
              event.key
            )
            if (edit) {
              event.preventDefault()
              const reconciled = validComposerReferences(
                edit.text,
                reconcileChatReferences(draft, edit.text, editingReferences),
                reconcileTeamReferences(draft, edit.text, editingTeamReferences),
                (text, candidates) => validChatReferences(text, candidates, sessionId)
              )
              setEditingReferences(reconciled.chatReferences)
              setEditingTeamReferences(reconciled.teamReferences)
              setDraft(edit.text)
              queuedSelectionRef.current = { start: edit.caret, end: edit.caret, direction: 'none' }
              return
            }
          }
          if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            const start = selectionStart
            const end = selectionEnd
            if (start === end) {
              const caret = atomicComposerReferenceNavigation(
                start,
                atomicSpans,
                event.key
              )
              if (caret !== null) {
                event.preventDefault()
                const displayCaret = composerSourceToDisplay(editingMessageProjection, caret)
                event.currentTarget.setSelectionRange(displayCaret, displayCaret)
                return
              }
            }
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void saveEdit(true)
          }
        }}
        disabled={savingEdit}
        autoFocus
      />
    </div>
    }
    {hasEditingReferenceFallback && <ComposerReferenceFallback
      text={draft}
      chatReferences={editingInlineReferences.chatReferences}
      teamReferences={editingInlineReferences.teamReferences}
      referenceSupported={referenceSupported}
      teamReferencesSupported={editingTeamReferencesSupported}
    />}
    {editTeamMention && <TeamMentionPalette
      id={queuedTeamMentionPaletteId}
      sourceSessionId={sessionId}
      mention={editTeamMention}
      selectedIndex={editTeamMentionIndex}
      supported={teamMentionsSupported}
      profileId={profileId}
      profileGeneration={profileGeneration}
      serverIdentity={serverIdentity}
      onCandidates={setEditTeamMentionCandidates}
      onHighlight={setEditTeamMentionIndex}
      onSelect={chooseQueuedTeamMention}
    />}
    {editMention && <div className="chat-mention-palette queued-chat-mention-palette" role="listbox" aria-label={t("ui.Composer.QueueShelf.granted_chats_0118275")}>
      {editingReferences.length >= MAX_CHAT_REFERENCES && <div className="chat-mention-empty" role="status"><span><strong>{t('ui.composer.maximumChats', { count: MAX_CHAT_REFERENCES })}</strong><small>{t("ui.Composer.QueueShelf.remove_a_chat_reference_before_selecting_a_3e5b219")}</small></span></div>}
      {editMentionCandidates.length
        ? editMentionCandidates.map((candidate, index) => <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={index === editMentionIndex}
          disabled={editingReferences.length >= MAX_CHAT_REFERENCES}
          className={index === editMentionIndex ? 'selected' : ''}
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => setEditMentionIndex(index)}
          onClick={() => chooseQueuedMention(candidate)}
        ><BackendMark backend={candidate.backend} size={15} /><span><strong>{candidate.title}</strong><small>{t("ui.Composer.granted_17a8252")}{" "}{agentRouteActionLabel(grantedRoutes.find(route => route.target_session_id === candidate.id) ?? { actions: [] })}{t('ui.composer.queueAccess')}</small></span><code>{candidate.id.slice(-8)}</code></button>)
        : <div className="chat-mention-empty"><span><strong>{t("ui.Composer.QueueShelf.no_granted_chats_match_b3d0be7")}</strong><small>{t("ui.Composer.QueueShelf.send_a_normal_chat_message_first_queue_edi_3db69d7")}</small></span></div>}
    </div>}
    {!editingReferencesSupported && <small className="chat-reference-warning">{!editingChatReferencesSupported
      ? editingHasRemoteAgentReference
        ? remoteAgentRouteUnavailable()
        : t("ui.Composer.QueueShelf.one_or_more_legacy_chat_references_cannot__4f81746")
      : editingUnsupportedAllServersReference
        ? allServersNativeUpdateRequired()
        : t('teamNetwork.mention.serverReferenceInvalid')}</small>}
    <div className="inline-editor-actions"><button type="button" disabled={savingEdit} onClick={() => setEditing(null)}>{t("ui.Composer.QueueShelf.cancel_19766ed")}</button><button type="button" className="primary-button" disabled={savingEdit || !editingReferencesSupported} onClick={() => void saveEdit()}>{savingEdit ? t("ui.Composer.QueueShelf.saving_23e3929") : t("ui.Composer.QueueShelf.save_1509f56")}</button></div>
  </div>}
  </div>
})

function PendingQueuedRow({ submission }: { submission: PendingTurnSubmission }) {
  useLocale()
  const prompt = submission.prompt.trim()
  const label = prompt || t('composer.queue.pendingAttachments', { count: submission.files.length })
  return <div className="queued-row local-pending" role="status" aria-label={t('composer.queue.addingMessage', { message: label })}>
    <span className="queue-starting-icon" title={t('composer.queue.adding')}><LoaderCircle className="spin" size={14} /></span>
    <span className="queue-copy">
      <span className="queue-prompt" title={label}>{label}</span>
      <small>{t('composer.queue.adding')}</small>
    </span>
  </div>
}

function QueuedRow({ profileId, profileGeneration, steeringScope, turn, sourceSessionTitle, sessionId, running, activeCodexGoal, drop, steeringPending, promotionPending, runtimeError, crossChatFence, blockingDelivery, canSkipExactDelivery, canSkipExactPeerDelivery, asyncControls, reorderable, moving, onMove, onEdit }: { profileId: string | null; profileGeneration: number; steeringScope: SteeringScope; turn: QueuedTurn; sourceSessionTitle?: string; sessionId: string; running: boolean; activeCodexGoal: boolean; drop: { id: string; placement: 'before' | 'after' } | null; steeringPending: boolean; promotionPending: boolean; runtimeError: string | null; crossChatFence: QueuedTurnCrossChatFence; blockingDelivery: QueuedTurn | null; canSkipExactDelivery: boolean; canSkipExactPeerDelivery: boolean; asyncControls: boolean; reorderable: boolean; moving: boolean; onMove: (direction: 'up' | 'down') => void; onEdit: (body?: string) => void }) {
  useLocale()
  const openCodeSteeringBlocked = useAppStore(state => running && state.sessions.find(session => session.id === sessionId)?.backend === 'opencode')
  const agentMessage = isAsyncAgentQueuedTurn(turn)
  const senderTitle = agentMessage ? turn.source_title?.trim() || sourceSessionTitle?.trim() || t('timeline.ui.unknownAgent') : null
  const securePeerDelivery = isSecurePeerDeliveryQueuedTurn(turn)
  const deliveryBarrier = isQueuedDeliveryBarrier(turn)
  const scheduledJob = isScheduledJobQueuedTurn(turn)
  const immutable = isImmutableQueuedTurn(turn)
  const promoted = turn.promoted === true
  const remoteAgentRoute = queuedTurnHasRemoteAgentRoute(turn)
  const [skippingDelivery, setSkippingDelivery] = useState(false)
  const bodyIdentity = `${profileId}\0${profileGeneration}\0${sessionId}\0${turn.queued_id}\0${turn.cross_chat_envelope_id}\0${turn.message_revision ?? ''}`
  const bodyIdentityRef = useRef(bodyIdentity)
  bodyIdentityRef.current = bodyIdentity
  const bodyMounted = useRef(true)
  useEffect(() => { bodyMounted.current = true; return () => { bodyMounted.current = false } }, [])
  const [loadedBody, setLoadedBody] = useState<{ identity: string; body: string } | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [expandedBody, setExpandedBody] = useState<string | null>(null)
  useEffect(() => { setBodyLoading(false); setBodyError(null); setExpandedBody(null) }, [bodyIdentity])
  const messageBody = agentMessage ? turn.message_body ?? (loadedBody?.identity === bodyIdentity ? loadedBody.body : null) : null
  const canControlAgentMessage = agentMessage && asyncControls && Number.isInteger(turn.message_revision) && turn.message_revision! >= 0
  const drag = useDraggable({ id: turn.queued_id, disabled: !reorderable || moving })
  const target = useDroppable({ id: turn.queued_id, disabled: !reorderable || moving })
  const ref = (node: HTMLElement | null) => { drag.setNodeRef(node); target.setNodeRef(node) }
  const indicator = drop?.id === turn.queued_id ? `drop-${drop.placement}` : ''
  const queuedPrompt = (turn.display_prompt || turn.prompt).trim()
  const prompt = (messageBody ?? (agentMessage && queuedPrompt === 'Agent-authored same-server handoff'
    ? t('composer.agentQueue.messageFrom', { sender: senderTitle ?? '' }) : queuedPrompt)).trim()
  const attachmentCount = turn.file_ids.length
  const label = prompt || `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
  const bodyExpanded = expandedBody === bodyIdentity
  const preview = agentMessage && !bodyExpanded && label.length > 320 ? `${label.slice(0, 320)}…` : label
  const loadMessageBody = async (): Promise<string | null> => {
    if (messageBody != null) return messageBody
    if (!agentMessage || !turn.cross_chat_envelope_id || bodyLoading) return null
    const expectedIdentity = bodyIdentity
    const current = () => bodyMounted.current && bodyIdentityRef.current === expectedIdentity
      && profileIsActive(profileId, profileGeneration) && activeIdentity(useAppStore.getState()) === steeringScope.serverIdentity
    setBodyLoading(true); setBodyError(null)
    try {
      const handoff = await window.agentsDock.handoffs.get(turn.cross_chat_envelope_id)
      if (!current()) return null
      if (handoff.id !== turn.cross_chat_envelope_id || handoff.target_session_id !== sessionId
        || handoff.source_session_id !== turn.source_session_id || handoff.conversation_mode !== 'async_route_v1'
        || handoff.queued_id && handoff.queued_id !== turn.queued_id
        || typeof handoff.body !== 'string') throw new Error(t('composer.agentQueue.messageChanged'))
      if (Number.isInteger(turn.message_revision) && handoff.message_revision !== turn.message_revision
        || (turn.message_edited_by_user || handoff.message_edited_by_user)
          && (!handoff.message_edited_by_user || !Number.isInteger(turn.message_revision) || typeof handoff.target_body !== 'string')) {
        throw new Error(t('composer.agentQueue.messageChanged'))
      }
      const body = handoff.message_edited_by_user ? handoff.target_body! : handoff.body
      setLoadedBody({ identity: expectedIdentity, body })
      return body
    } catch (error) { if (current()) setBodyError(cleanActionError(error)); return null }
    finally { if (current()) setBodyLoading(false) }
  }
  const editAgentMessage = async () => {
    if (!canControlAgentMessage || promoted) return
    const body = await loadMessageBody()
    const current = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(row => row.queued_id === turn.queued_id)
    if (body != null && current && !current.promoted && current.message_revision === turn.message_revision
      && bodyMounted.current && profileIsActive(profileId, profileGeneration)) onEdit(body)
  }
  const viewMessageBody = async () => {
    if (bodyExpanded) { setExpandedBody(null); return }
    if (await loadMessageBody() != null) setExpandedBody(bodyIdentity)
  }
  const pausedLabel = turn.paused !== true
    ? null
    : turn.pause_reason === 'delivery_uncertain'
      ? 'Delivery unconfirmed — review before retrying'
      : turn.pause_reason === 'stopped'
        ? 'Paused after Stop'
        : 'Paused'
  const actionLabel = 'Send now'
  const actionTitle = steeringPending
    ? 'A queued turn action is already in progress'
    : promotionPending
      ? 'A queued message is already starting'
    : runtimeError
      ? runtimeError
    : remoteAgentRoute
      ? remoteAgentRouteUnavailable()
    : crossChatFence.runNow
      ? 'An incoming cross-chat delivery must run before this queued message'
    : activeCodexGoal && running
      ? t('composer.sendNowDuringGoal')
    : running
      ? 'Send this message into the active turn now; other queued messages keep their order (⌘↩ while editing)'
      : turn.pause_reason === 'delivery_uncertain'
        ? 'Delivery was not confirmed. Review the message, then send it again only if needed.'
        : 'Send this queued message now'
  const deliveryToSkip = deliveryBarrier ? turn : blockingDelivery
  const blockingExchangeId = deliveryToSkip?.cross_chat_exchange_id?.trim() || ''
  const blockingExchangeLegId = deliveryToSkip?.cross_chat_exchange_leg_id?.trim() || ''
  const blockingEnvelopeId = deliveryToSkip?.cross_chat_envelope_id?.trim() || ''
  const blockingPeerEnvelopeId = deliveryToSkip?.secure_peer_envelope_id?.trim() || ''
  const canSkipBlockingDelivery = Boolean(
    deliveryToSkip?.queued_id
    && (
      (canSkipExactDelivery
        && deliveryToSkip.purpose === 'cross_chat_handoff_delivery'
        && (blockingEnvelopeId || (blockingExchangeId && blockingExchangeLegId)))
      || (canSkipExactPeerDelivery
        && deliveryToSkip.purpose === 'secure_peer_handoff_delivery'
        && blockingPeerEnvelopeId)
    )
  )
  const skipDeliveryTitle = securePeerDelivery
    ? 'Decline this exact encrypted peer delivery before it starts.'
    : 'Skip this exact incoming delivery before it starts. Its history remains visible in the timeline.'
  const refresh = async () => {
    const request = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
    const turns = await window.agentsDock.queue.list(sessionId)
    if (profileIsActive(profileId, profileGeneration)) {
      useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, turns)
    }
  }
  const runAndRefresh = async (action: () => Promise<unknown>) => {
    if (!profileIsActive(profileId, profileGeneration)) return
    try { await action(); if (profileIsActive(profileId, profileGeneration)) await refresh() }
    catch (error) { if (profileIsActive(profileId, profileGeneration)) reportActionError(error) }
  }
  const steer = async () => {
    if (openCodeSteeringBlocked) { reportActionError(t('opencode.steerUnavailable')); return }
    if (!profileIsActive(profileId, profileGeneration)) return
    const steerConsent = confirmInboundDeliveryInterruption(sessionId, 'send_now')
    if (!steerConsent) return
    try {
      const latestQueue = useAppStore.getState().snapshots[sessionId]?.queuedTurns
      const latestTurn = latestQueue?.find(candidate => candidate.queued_id === turn.queued_id) ?? turn
      if (queuedTurnHasRemoteAgentRoute(latestTurn)) throw new Error(remoteAgentRouteUnavailable())
      const latestFence = latestQueue ? queuedTurnCrossChatFence(latestQueue, turn.queued_id, false, asyncQueuedMessageControlsAvailable(useAppStore.getState().health)) : crossChatFence
      if (latestQueue?.some(candidate => candidate.promoted === true)) {
        throw new Error('A queued message is already starting. Wait for its provider handoff to finish.')
      }
      if (latestFence.runNow) {
        throw new Error('An incoming cross-chat delivery must run before this queued message.')
      }
      const state = useAppStore.getState()
      const source = state.sessions.find(candidate => candidate.id === sessionId)
      const currentRuntimeError = queuedTurnRuntimeAdmissionError(turn, source, state.health, state.runtimeCatalog)
      if (currentRuntimeError) throw new Error(currentRuntimeError)
      const request = state.beginQueuedTurnsRequest(sessionId)
      const turns = await steerQueuedTurn(
        steeringScope,
        turn.queued_id,
        () => Boolean(confirmInboundDeliveryInterruption(sessionId, 'send_now', steerConsent))
      )
      if (profileIsActive(profileId, profileGeneration)) {
        useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, turns)
      }
    }
    catch (error) { if (!isSteeringCancellation(error) && profileIsActive(profileId, profileGeneration)) reportActionError(error) }
  }
  const skipBlockingDelivery = async () => {
    if (!deliveryToSkip || !canSkipBlockingDelivery || skippingDelivery || steeringPending) return
    if (!profileIsActive(profileId, profileGeneration)) return
    setSkippingDelivery(true)
    try {
      await window.agentsDock.queue.skipCrossChatDelivery(
        sessionId,
        deliveryToSkip.queued_id,
        blockingPeerEnvelopeId ? {
          secure_peer_envelope_id: blockingPeerEnvelopeId
        } : {
          cross_chat_envelope_id: blockingEnvelopeId || null,
          cross_chat_exchange_id: blockingExchangeId || null,
          cross_chat_exchange_leg_id: blockingExchangeLegId || null
        }
      )
      // The exact skip is already committed. Stream events normally update
      // the shelf; an immediate list refresh is only a best-effort fast path.
      if (profileIsActive(profileId, profileGeneration)) await refresh().catch(() => undefined)
    } catch (error) {
      // The delivery may have won the race and started. Refresh authoritative
      // ordering before surfacing the conflict so stale FIFO controls vanish.
      if (profileIsActive(profileId, profileGeneration)) {
        await refresh().catch(() => undefined)
        if (profileIsActive(profileId, profileGeneration)) reportActionError(error)
      }
    } finally {
      if (profileIsActive(profileId, profileGeneration)) setSkippingDelivery(false)
    }
  }
  const movementMenu = <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="queue-action" title={t('ui.Composer.QueuedRow.more_queue_actions_77a2245', undefined, securePeerDelivery ? 'en' : undefined)}><MoreHorizontal size={13} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="end">
    {!immutable && <DropdownMenu.Item className="menu-item" onSelect={() => onEdit()}><Pencil size={13} />{' '}{t('ui.Composer.QueuedRow.edit_message_9757ccd')}</DropdownMenu.Item>}
    <DropdownMenu.Item className="menu-item" disabled={!reorderable || moving || crossChatFence.moveEarlier} title={crossChatFence.moveEarlier ? t('ui.Composer.QueuedRow.incoming_cross_chat_deliveries_keep_their__59975a6', undefined, securePeerDelivery ? 'en' : undefined) : undefined} onSelect={() => onMove('up')}><ArrowUp size={13} />{' '}{t('ui.Composer.QueuedRow.move_earlier_736612d', undefined, securePeerDelivery ? 'en' : undefined)}</DropdownMenu.Item>
    <DropdownMenu.Item className="menu-item" disabled={!reorderable || moving || crossChatFence.moveLater} title={crossChatFence.moveLater ? t('ui.Composer.QueuedRow.incoming_cross_chat_deliveries_keep_their__59975a6', undefined, securePeerDelivery ? 'en' : undefined) : undefined} onSelect={() => onMove('down')}><ArrowDown size={13} />{' '}{t('ui.Composer.QueuedRow.move_later_d6e8560', undefined, securePeerDelivery ? 'en' : undefined)}</DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
  return <div
    ref={ref}
    className={`queued-row ${turn.paused ? 'paused' : ''} ${promoted ? 'promoted' : ''} ${deliveryBarrier ? 'cross-chat-delivery' : ''} ${agentMessage ? 'agent-message' : ''} ${securePeerDelivery ? 'secure-peer-delivery' : ''} ${scheduledJob ? 'scheduled-job' : ''} ${indicator} ${drag.isDragging ? 'dragging' : ''}`}
    role={immutable || promoted ? 'status' : undefined}
    aria-label={promoted
      ? securePeerDelivery ? `${label}, starting provider handoff` : t("ui.Composer.QueuedRow.starting_provider_handoff_e476e2a", { "label": String(label) })
      : agentMessage
        ? `${senderTitle}: ${label}`
      : deliveryBarrier
        ? securePeerDelivery ? `${label}, encrypted peer delivery, queue position ${turn.position ?? 'pending'}` : t("ui.Composer.QueuedRow.delivery_queue_position_5d44462", { "label": String(label), "delivery": 'incoming cross-chat', "position": String(turn.position ?? t("ui.Composer.QueuedRow.pending_62a2fed")) })
        : scheduledJob
          ? t('composer.scheduledJobQueued', { title: turn.job_title || t('timeline.minimap.scheduledJob'), position: turn.position ?? t("ui.Composer.QueuedRow.pending_62a2fed") })
          : undefined}
  >
    {promoted
      ? <span className="queue-starting-icon" title={securePeerDelivery ? 'Starting provider handoff' : t("ui.Composer.QueuedRow.starting_provider_handoff_e6a29ff")}><LoaderCircle className="spin" size={14} /></span>
      : reorderable
      ? <button type="button" className="queue-grip" disabled={moving} title={t('ui.Composer.QueuedRow.drag_to_reorder_ef86a0e', undefined, securePeerDelivery ? 'en' : undefined)} {...drag.attributes} {...drag.listeners}><GripVertical size={13} /></button>
      : deliveryBarrier
      ? <span className="queue-delivery-icon" title={securePeerDelivery ? 'Encrypted peer delivery' : t("ui.Composer.QueuedRow.incoming_cross_chat_delivery_5f20f38")}><MessageSquareShare size={14} /></span>
      : scheduledJob
      ? <span className="queue-job-icon" title={t('timeline.minimap.scheduledJob')}><CalendarClock size={14} /></span>
      : null}
    <span className="queue-copy">
      {isSharedChatCollaborator(turn) && <small className="queue-agent-sender">{t('chatShare.collaborator')}</small>}
      {senderTitle && <small className="queue-agent-sender" title={senderTitle}>{senderTitle}</small>}
      {scheduledJob && <small>{turn.job_title || t('timeline.minimap.scheduledJob')}</small>}
      <span className={`queue-prompt${bodyExpanded ? ' expanded' : ''}`} title={preview}>{preview}</span>
      {agentMessage && turn.message_edited_by_user && <small className="queue-agent-edited">{t('composer.agentQueue.editedByYou')}</small>}
      {agentMessage && !promoted && (messageBody == null || label.length > 160 || label.includes('\n')) && <button type="button" className="queue-body-toggle" disabled={bodyLoading}
        onClick={() => void viewMessageBody()}>{bodyLoading ? t('composer.agentQueue.loading') : bodyExpanded ? t('composer.agentQueue.showLess') : t('composer.agentQueue.viewMessage')}</button>}
      {bodyError && <small role="alert">{bodyError}</small>}
      {promoted
        ? <small>{securePeerDelivery ? 'Starting… · handed to the provider' : t("ui.Composer.QueuedRow.starting_handed_to_the_provider_6aa0965")}</small>
        : deliveryBarrier && !agentMessage
        ? <small>{securePeerDelivery ? `Encrypted peer delivery · position ${turn.position ?? 'pending'} · starts automatically` : t('ui.composer.deliveryPosition', { position: turn.position ?? t("ui.Composer.QueuedRow.pending_62a2fed") })}</small>
        : pausedLabel && <small>{pausedLabel}</small>}
    </span>
    {promoted
      ? <div className="queue-actions"><span className="queue-starting-label">{securePeerDelivery ? 'Starting…' : t("ui.Composer.QueuedRow.starting_bbe5fc3")}</span></div>
      : scheduledJob
      ? <div className="queue-actions"><button
          type="button"
          className="queue-action"
          aria-label={t('composer.cancelQueuedJob')}
          title={t('composer.cancelQueuedJobHint')}
          onClick={() => void runAndRefresh(async () => {
            const removed = await window.agentsDock.queue.remove(sessionId, turn.queued_id)
            if (removed) trackEvent('scheduled_job_run_cancelled')
          })}
        ><Trash2 size={13} /></button>{reorderable && movementMenu}</div>
      : agentMessage
      ? <div className="queue-actions"><button
          type="button" className="steer-action" disabled={!canControlAgentMessage || steeringPending || promotionPending || Boolean(runtimeError) || crossChatFence.runNow}
          title={!canControlAgentMessage ? t('composer.agentQueue.updateRequired') : running ? t('composer.agentQueue.sendNowRunning') : actionTitle} onClick={() => void steer()}
        ><CornerDownRight size={13} /><b>{t('composer.agentQueue.sendNow')}</b></button>
        <button type="button" className="steer-action" disabled={!canControlAgentMessage || bodyLoading || steeringPending}
          title={!canControlAgentMessage ? t('composer.agentQueue.updateRequired') : t('composer.agentQueue.editMessage')} onClick={() => void editAgentMessage()}
        ><Pencil size={13} /><b>{t('composer.agentQueue.edit')}</b></button><button
          type="button"
          className="queue-action"
          aria-label={t('ui.Composer.QueuedRow.remove_from_queue_c0b9d9e')}
          title={canSkipBlockingDelivery ? t('ui.Composer.QueuedRow.remove_from_queue_c0b9d9e') : t('ui.Composer.QueuedRow.update_agentsserver_to_safely_skip_this_de_7c9afa2')}
          disabled={steeringPending || skippingDelivery || !canSkipBlockingDelivery}
          onClick={() => void skipBlockingDelivery()}
        >{skippingDelivery ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button>{reorderable && movementMenu}</div>
      : deliveryBarrier
      ? <div className="queue-actions"><button
          type="button"
          className="steer-action"
          aria-label={securePeerDelivery ? 'Skip encrypted peer delivery' : t("ui.Composer.QueuedRow.skip_incoming_delivery_1e74c78")}
          title={canSkipBlockingDelivery ? skipDeliveryTitle : securePeerDelivery ? 'Update AgentsServer to safely skip this delivery.' : t("ui.Composer.QueuedRow.update_agentsserver_to_safely_skip_this_de_7c9afa2")}
          disabled={steeringPending || skippingDelivery || !canSkipBlockingDelivery}
          onClick={() => void skipBlockingDelivery()}
        >{skippingDelivery ? <LoaderCircle className="spin" size={13} /> : <X size={13} />} <b>{securePeerDelivery ? (skippingDelivery ? 'Skipping…' : 'Skip delivery') : (skippingDelivery ? t("ui.Composer.QueuedRow.skipping_3aaedc1") : t("ui.Composer.QueuedRow.skip_delivery_7a6d970"))}</b></button>{reorderable && movementMenu}</div>
      : <div className="queue-actions">
    <button
      type="button"
      className="steer-action"
      title={openCodeSteeringBlocked ? t('opencode.steerUnavailable') : actionTitle}
      disabled={openCodeSteeringBlocked || steeringPending || promotionPending || Boolean(runtimeError) || remoteAgentRoute || crossChatFence.runNow}
      onClick={() => void steer()}
    ><CornerDownRight size={13} /> <b>{actionLabel}</b></button>
    {blockingDelivery && canSkipBlockingDelivery && <button
      type="button"
      className="steer-action"
      aria-label={t("ui.Composer.QueuedRow.skip_incoming_delivery_1e74c78")}
      title={skipDeliveryTitle}
      disabled={steeringPending || skippingDelivery}
      onClick={() => void skipBlockingDelivery()}
    >{skippingDelivery ? <LoaderCircle className="spin" size={13} /> : <X size={13} />} <b>{skippingDelivery ? t("ui.Composer.QueuedRow.skipping_3aaedc1") : t("ui.Composer.QueuedRow.skip_delivery_7a6d970")}</b></button>}
    <button type="button" className="queue-action" title={t("ui.Composer.QueuedRow.remove_from_queue_c0b9d9e")} onClick={() => void runAndRefresh(() => window.agentsDock.queue.remove(sessionId, turn.queued_id))}><Trash2 size={13} /></button>
    {movementMenu}
    </div>}
  </div>
}

function isBackendLocked(session: Session): boolean { return Boolean(session.backend_locked || session.session_id || session.claude_session_id || session.codex_thread_id || session.cursor_session_id || session.opencode_session_id) }

function sessionRuntimeAdmissionError(
  session: Session | null | undefined,
  health: Parameters<typeof runtimeSelectionError>[0],
  catalog: Parameters<typeof runtimeSelectionError>[1]
): string | null {
  return session ? runtimeSelectionError(health, catalog, session.backend, session.model, session.codex_provider, session.codex_provider_catalog) : null
}

function queuedTurnRuntimeAdmissionError(
  turn: QueuedTurn,
  sourceSession: Session | null | undefined,
  health: Parameters<typeof runtimeSelectionError>[0],
  catalog: Parameters<typeof runtimeSelectionError>[1]
): string | null {
  if (!sourceSession) return t("ui.Composer.queuedTurnRuntimeAdmissionError.the_source_chat_is_no_longer_available_0704bd1")
  const backend = turn.backend ?? sourceSession.backend
  const model = turn.model ?? (backend === sourceSession.backend ? sourceSession.model : null)
  return runtimeSelectionError(health, catalog, backend, model, backend === sourceSession.backend ? sourceSession.codex_provider : undefined, sourceSession.codex_provider_catalog)
}

/** Product-owned `/mcp` must never be admitted as a Claude model turn. */
function isStandaloneMcpCommand(value: string): boolean {
  return /^\s*\/mcp\s*$/iu.test(value)
}

function mentionSessionStatus(session: Session, activeSessionIds: Set<string>, queuedCount: number): string {
  if (session.codex_needs_user_action || session.claude_needs_user_action) return t("ui.Composer.mentionSessionStatus.needs_approval_db0e960")
  if (activeSessionIds.has(session.id)) return t("ui.Composer.mentionSessionStatus.running_f4ccae2")
  if (queuedCount > 0) return t("ui.Composer.mentionSessionStatus.queued_9824882", { "count": String(queuedCount) })
  if (session.codex_goal && session.codex_goal.status !== 'complete') return t("ui.Composer.mentionSessionStatus.goal_a98c7bc", { "status": String(session.codex_goal.status) })
  return t("ui.Composer.mentionSessionStatus.idle_ab0171c")
}

function reportActionError(error: unknown): void {
  useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
}

function cleanActionError(error: unknown): string {
  if (error instanceof TeamMentionUIError) return t(error.localeKey)
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function profileIsActive(profileId: string | null, profileGeneration: number): boolean {
  const state = useAppStore.getState()
  return !state.switchingProfileId && state.activeProfileId === profileId && state.profileGeneration === profileGeneration
}

function activeIdentity(state: ReturnType<typeof useAppStore.getState>): string | null {
  return state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
}

function draftPreferenceScope(context: DraftContext) {
  return context.profileId ? {
    profileId: context.profileId,
    profileGeneration: context.profileGeneration,
    serverIdentity: context.serverIdentity
  } : null
}

function chatReferencesPreferenceKey(sessionId: string): string {
  return `draft-chat-references:${sessionId}`
}

function teamReferencesPreferenceKey(sessionId: string): string {
  return `draft-team-references:${sessionId}`
}

function canonicalizeComposerReferences(
  text: string,
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[],
  sourceSessionId: string | null | undefined,
  canonicalizeChatRoutes: boolean
): { text: string; chatReferences: ChatReference[]; teamReferences: TeamReference[] } {
  const valid = validComposerReferences(
    text,
    chatReferences,
    teamReferences,
    (value, candidates) => validChatReferences(value, candidates, sourceSessionId)
  )
  if (!canonicalizeChatRoutes) return { text, ...valid }
  const canonicalChat = canonicalizeLocalRouteHints(text, valid.chatReferences, sourceSessionId)
  const shiftedTeamReferences = reconcileTeamReferences(text, canonicalChat.text, valid.teamReferences)
  const canonical = validComposerReferences(
    canonicalChat.text,
    canonicalChat.references,
    shiftedTeamReferences,
    (value, candidates) => validChatReferences(value, candidates, sourceSessionId)
  )
  return { text: canonicalChat.text, ...canonical }
}
