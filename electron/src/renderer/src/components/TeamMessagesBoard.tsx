import { getLocale } from '@shared/i18n'
import { t, useLocale } from '../lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileText,
  Film,
  Forward,
  Image as ImageIcon,
  Inbox,
  LoaderCircle,
  Mail,
  Paperclip,
  Pencil,
  Pin,
  RadioTower,
  RefreshCw,
  Reply,
  Search,
  Send,
  Server,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type { TeamHubScope } from '@shared/team-hub'
import { parseMailboxCoverage, type MailArrivalCursor, type MailboxCoverage, type MailHintScope } from '@shared/team-mail-hints'
import type {
  TeamAttachment,
  TeamMessage,
  TeamMessageBase,
  TeamMessageBox,
  TeamMessagePage,
  TeamMessageSummary,
  TeamMessageHistoryEntry,
  TeamMessagesCapability,
  TeamMailboxState,
  TeamMailboxStateInput,
  TeamNetworkBulletinPost,
  TeamNetworkDeletion,
  TeamRecipient,
  TeamRecipientKind,
  TeamSkill,
  TeamSkillDetails,
  TeamSkillVersion,
  TeamSkillVersionSummary
} from '@shared/team-network'
import {
  TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  teamAttachmentSupportsTextPreview
} from '@shared/team-network'
import type { NativeFileRef } from '@shared/types'
import { dispatchTeamNetworkMessageDeleted } from '../lib/team-network-events'
import { teamMailDisplayTitle } from '../lib/team-message-title'
import { openTeamMessageLink, teamMessageLinkURL } from '../lib/team-message-links'
import {
  peekTeamMessagesSnapshot,
  writeTeamMessagesSnapshot,
  type TeamMessagesSnapshotQuery
} from '../lib/team-network-snapshot-cache'
import { MarkdownContent } from './MarkdownContent'
import { acknowledgeMailHintPage, captureMailHintScope, sameMailHintScope } from '../store/app-store'
import './TeamMessagesBoard.css'

const MAX_CATCH_UP_PAGES_PER_REQUEST = 16
// A legal 100-row beta.33 page can exceed the Hub's bounded response size
// once recipients, attachments, and provenance are included. Twenty-five is
// safely below that ceiling while catch-up still batches several pages.
const TEAM_MESSAGES_PAGE_SIZE = 25
const MAX_RECEIPT_RECONCILE_MESSAGES = 16
const TEAM_SKILL_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface TeamMessageAddress {
  kind: Extract<TeamRecipientKind, 'server' | 'human'>
  id: string
  label: string
}

export interface TeamMailRouteTarget {
  id: string
  label: string
  current: boolean
}

export type TeamFeedInitialLoad = Promise<
  | { state: 'ready'; page: TeamMessagePage }
  | { state: 'error'; message: string }
  | { state: 'unavailable' }
>

export function startTeamFeedInitialLoad(scope: TeamHubScope, teamId: string): TeamFeedInitialLoad {
  return window.agentsDock.teamHub.teamMessages(scope, {
    teamId,
    box: 'feed',
    limit: TEAM_MESSAGES_PAGE_SIZE
  }).then(
    page => ({ state: 'ready' as const, page }),
    cause => ({ state: 'error' as const, message: errorMessage(cause) })
  )
}

export function TeamMessagesBoard({
  section,
  scope,
  teamId,
  capability,
  addresses,
  principalId = null,
  callerPostingKind = null,
  canWrite,
  canManageMessages = false,
  canHostDelete = false,
  draftIdentity = 'unknown',
  initialAddress = null,
  mailboxRequestId = 0,
  initialMessageId = null,
  initialMailboxBox,
  onInitialMessageConsumed,
  onAddressChange,
  initialFeedLoad = null,
  onInitialFeedLoadConsumed,
  legacyBulletinPosts = [],
  routeTargets = [],
  onRouteMessage,
  onUnreadSnapshot,
  lifecycleCacheKey = JSON.stringify(scope)
}: {
  section: 'feed' | 'mail' | 'skills'
  scope: TeamHubScope
  teamId: string
  capability: TeamMessagesCapability
  addresses: TeamMessageAddress[]
  principalId?: string | null
  callerPostingKind?: 'human' | 'server' | null
  canWrite: boolean
  canManageMessages?: boolean
  canHostDelete?: boolean
  draftIdentity?: string
  initialAddress?: TeamMessageAddress | null
  mailboxRequestId?: number
  initialMessageId?: string | null
  initialMailboxBox?: 'inbox' | 'sent'
  onInitialMessageConsumed?: () => void
  onAddressChange?: (address: TeamMessageAddress) => void
  initialFeedLoad?: TeamFeedInitialLoad | null
  onInitialFeedLoadConsumed?: (load: TeamFeedInitialLoad) => void
  legacyBulletinPosts?: TeamNetworkBulletinPost[]
  routeTargets?: TeamMailRouteTarget[]
  onRouteMessage?: (message: TeamMessageSummary, sessionId: string, intent?: 'read' | 'reply') => void
  onUnreadSnapshot?: (count: number, hasMore: boolean) => void
  lifecycleCacheKey?: string
}) {
  useLocale()
  if (section === 'feed') {
    return <TeamFeed
      scope={scope}
      teamId={teamId}
      capability={capability}
      canWrite={canWrite}
      canManageMessages={canManageMessages}
      canHostDelete={canHostDelete && capability.host_content_deletion === true}
      addresses={addresses}
      principalId={principalId}
      callerPostingKind={callerPostingKind}
      draftIdentity={draftIdentity}
      initialLoad={initialFeedLoad}
      onInitialLoadConsumed={onInitialFeedLoadConsumed}
      legacyBulletinPosts={legacyBulletinPosts}
      routeTargets={routeTargets}
      onRouteMessage={onRouteMessage}
      lifecycleCacheKey={lifecycleCacheKey}
      initialMessageId={initialMessageId}
      mailboxRequestId={mailboxRequestId}
      onInitialMessageConsumed={onInitialMessageConsumed}
    />
  }
  if (section === 'mail') {
    return <TeamMail scope={scope} teamId={teamId} capability={capability} canWrite={canWrite} callerPostingKind={callerPostingKind} draftIdentity={draftIdentity} addresses={addresses} canManageMessages={canManageMessages} canHostDelete={canHostDelete && capability.host_content_deletion === true} initialAddress={initialAddress} mailboxRequestId={mailboxRequestId} initialMessageId={initialMessageId} initialMailboxBox={initialMailboxBox} onInitialMessageConsumed={onInitialMessageConsumed} onAddressChange={onAddressChange} routeTargets={routeTargets} onRouteMessage={onRouteMessage} onUnreadSnapshot={onUnreadSnapshot} lifecycleCacheKey={lifecycleCacheKey} />
  }
  return <TeamSkills scope={scope} teamId={teamId} capability={capability} canWrite={canWrite} />
}

function TeamFeed({ scope, teamId, capability, canWrite, canManageMessages, canHostDelete, addresses, principalId, callerPostingKind, draftIdentity, initialLoad, onInitialLoadConsumed, legacyBulletinPosts, routeTargets, onRouteMessage, lifecycleCacheKey, initialMessageId, mailboxRequestId, onInitialMessageConsumed }: {
  scope: TeamHubScope
  teamId: string
  capability: TeamMessagesCapability
  canWrite: boolean
  canManageMessages: boolean
  canHostDelete: boolean
  addresses: TeamMessageAddress[]
  principalId: string | null
  callerPostingKind: 'human' | 'server' | null
  draftIdentity: string
  initialLoad: TeamFeedInitialLoad | null
  onInitialLoadConsumed?: (load: TeamFeedInitialLoad) => void
  legacyBulletinPosts: TeamNetworkBulletinPost[]
  routeTargets: TeamMailRouteTarget[]
  onRouteMessage?: (message: TeamMessageSummary, sessionId: string, intent?: 'read' | 'reply') => void
  lifecycleCacheKey: string
  initialMessageId: string | null
  mailboxRequestId: number
  onInitialMessageConsumed?: () => void
}) {
  useLocale()
  const initialLoadRef = useRef(initialLoad)
  const feed = useTeamMessages(
    scope,
    { teamId, box: 'feed' },
    true,
    initialLoadRef.current,
    isBulletinMessage,
    lifecycleCacheKey
  )
  const deletionJournal = useTeamNetworkDeletionJournal(scope, teamId)
  const deletionKeys = deletionJournal.keys
  const [selected, setSelected] = useState<TeamMessageSummary | null>(null)
  const linked = useLinkedTeamMessage(scope, teamId, initialMessageId, mailboxRequestId, setSelected, onInitialMessageConsumed)
  const [hiddenLegacyIds, setHiddenLegacyIds] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<BulletinDeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<TeamMessageSummary | null>(null)
  const deleteRequest = useRef(0)
  const deleteInFlight = useRef(false)
  const deleteTrigger = useRef<HTMLElement | null>(null)
  const bulletinSurface = useRef<HTMLElement | null>(null)
  const draftKey = feedDraftKey(scope, teamId, draftIdentity)
  const entries = useMemo(() => [
    ...feed.messages.filter(message => !deletionKeys.has(`message:${message.id}`)).map(message => ({
      id: `message:${message.id}`,
      createdAt: message.created_at,
      message,
      bulletin: null
    })),
    ...legacyBulletinPosts.filter(bulletin => (
      !hiddenLegacyIds.has(bulletin.id) && !deletionKeys.has(`bulletin:${bulletin.id}`)
    )).map(bulletin => ({
      id: `bulletin:${bulletin.id}`,
      createdAt: bulletin.created_at,
      message: null,
      bulletin
    }))
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [deletionKeys, feed.messages, hiddenLegacyIds, legacyBulletinPosts])

  useEffect(() => {
    setSelected(null)
    setHiddenLegacyIds(new Set())
    setDeleteTarget(null)
    setEditTarget(null)
    setDeleteError(null)
    setDeleting(false)
    deleteInFlight.current = false
    deleteRequest.current += 1
  }, [draftKey])

  useEffect(() => () => {
    deleteRequest.current += 1
    deleteInFlight.current = false
  }, [])

  useEffect(() => {
    if (selected && deletionKeys.has(`message:${selected.id}`)) setSelected(null)
  }, [deletionKeys, selected])

  useEffect(() => {
    if (!deleteTarget) return
    const key = `${deleteTarget.source === 'message' ? 'message' : 'bulletin'}:${deleteTarget.id}`
    if (deletionJournal.supported && !deletionKeys.has(key)) return
    deleteRequest.current += 1
    deleteInFlight.current = false
    setDeleting(false)
    setDeleteError(null)
    setDeleteTarget(null)
    queueMicrotask(() => bulletinSurface.current?.focus())
  }, [deleteTarget, deletionJournal.supported, deletionKeys])

  useEffect(() => {
    const load = initialLoadRef.current
    if (load) onInitialLoadConsumed?.(load)
  }, [onInitialLoadConsumed])

  const askToDelete = (target: BulletinDeleteTarget) => {
    if (deleting) return
    deleteTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDeleteError(null)
    setDeleteTarget(target)
  }

  const cancelDelete = () => {
    if (deleting) return
    setDeleteError(null)
    setDeleteTarget(null)
    queueMicrotask(() => deleteTrigger.current?.focus())
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting || deleteInFlight.current) return
    const target = deleteTarget
    const request = ++deleteRequest.current
    deleteInFlight.current = true
    setDeleting(true)
    setDeleteError(null)
    try {
      if (target.source === 'message') {
        const result = await window.agentsDock.teamHub.deleteTeamMessage(scope, {
          teamId,
          messageId: target.id,
          idempotencyKey: target.idempotencyKey
        })
        if (result.deleted !== true || result.message_id !== target.id) {
          throw new Error('Team Hub returned the wrong Bulletin deletion receipt.')
        }
        if (deleteRequest.current !== request) return
        feed.remove(target.id)
        dispatchTeamNetworkMessageDeleted(scope, teamId, target.id)
        if (selected?.id === target.id) setSelected(null)
      } else {
        const result = await window.agentsDock.teamHub.deleteNetworkBulletin(scope, {
          teamId,
          postId: target.id,
          idempotencyKey: target.idempotencyKey
        })
        if (result.deleted !== true || result.post_id !== target.id) {
          throw new Error('Team Hub returned the wrong legacy Bulletin deletion receipt.')
        }
        if (deleteRequest.current !== request) return
        setHiddenLegacyIds(current => new Set(current).add(target.id))
      }
      setDeleteTarget(null)
      queueMicrotask(() => bulletinSurface.current?.focus())
    } catch (cause) {
      if (deleteRequest.current === request) setDeleteError(errorMessage(cause))
    } finally {
      if (deleteRequest.current === request) {
        deleteInFlight.current = false
        setDeleting(false)
      }
    }
  }

  if (linked.loading || linked.error) return <LinkedMessageState state={linked} />
  if (selected) {
    return <MessageDetailLoader summary={selected} initialMessage={linked.message} scope={scope} teamId={teamId} onBack={() => setSelected(null)}
      routeTargets={routeTargets} onRoute={onRouteMessage ? sessionId => onRouteMessage(selected, sessionId) : undefined} />
  }
  return <section ref={bulletinSurface} className="network-v2-surface" aria-label={t('teamNetwork.mail.teamBulletin')} tabIndex={-1}>
    <SurfaceHeader
      icon={<RadioTower size={20} />}
      title={t('teamNetwork.mail.bulletin')}
      description={t('teamNetwork.mail.bulletinDescription')}
      loading={feed.loading}
      onRefresh={() => { void feed.refresh(); void deletionJournal.refresh() }}
    />
    {feed.error && <InlineError message={feed.error} onRetry={() => { void feed.refresh(); void deletionJournal.refresh() }} />}
    <div className="network-v2-scroll network-v2-feed-stream">
      {feed.loading && <div className="network-v2-feed-sync" role="status"><LoaderCircle className="spin" size={15} />{t('teamNetwork.mail.syncBulletin')}</div>}
      {!feed.loading && entries.length === 0 && <EmptyState icon={<RadioTower size={23} />} title={t('teamNetwork.mail.emptyBulletinTitle')} body={t('teamNetwork.mail.emptyBulletinBody')} />}
      {entries.map(entry => entry.message
        ? <FeedMessageCard
          key={entry.id}
          message={entry.message}
          scope={scope}
          canDelete={deletionJournal.supported && (canHostDelete || (entry.message.kind === 'skill'
            ? canWrite && capability.skill_announcement_deletion === true
              && callerPostingKind === entry.message.sender.kind
              && canEditMessageAuthor(entry.message.sender, addresses, principalId)
            : canDeleteMessageAuthor(entry.message.sender, addresses, canManageMessages)))}
          canEdit={entry.message.kind === 'message' && Boolean(entry.message.revision) && canEditMessageAuthor(entry.message.sender, addresses, principalId)}
          onOpen={() => setSelected(entry.message)}
          onDelete={() => askToDelete(deleteTargetForMessage(entry.message))}
          onEdit={() => setEditTarget(entry.message)}
          routeTargets={onRouteMessage ? routeTargets : []}
          onRoute={onRouteMessage ? sessionId => onRouteMessage(entry.message!, sessionId) : undefined}
        />
        : <LegacyBulletinCard
          key={entry.id}
          bulletin={entry.bulletin!}
          canDelete={deletionJournal.supported && (canHostDelete || canDeleteMessageAuthor(entry.bulletin!.author, addresses, canManageMessages))}
          onDelete={() => askToDelete(deleteTargetForLegacyBulletin(entry.bulletin!))}
        />)}
      {feed.hasMore && <button type="button" className="quiet-button network-v2-load-more" disabled={feed.loadingMore} onClick={feed.loadMore}>{feed.loadingMore && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.mail.loadMore')}</button>}
    </div>
    {canWrite && !feed.loading && <TeamFeedComposer
      key={draftKey}
      scope={scope}
      teamId={teamId}
      capability={capability}
      draftKey={draftKey}
      onPosted={feed.add}
    />}
    {deleteTarget && <MessageDeleteDialog
      target={deleteTarget}
      variant="bulletin"
      busy={deleting}
      error={deleteError}
      onCancel={cancelDelete}
      onConfirm={() => void confirmDelete()}
    />}
    {editTarget && <BulletinEditDialog
      summary={editTarget}
      scope={scope}
      teamId={teamId}
      onCancel={() => setEditTarget(null)}
      onSaved={message => {
        feed.replace(message.id, () => summaryFromMessage(message))
        setEditTarget(null)
      }}
    />}
  </section>
}

interface BulletinDeleteTarget {
  source: 'message' | 'legacy'
  skillAnnouncement?: boolean
  id: string
  attachmentCount: number
  idempotencyKey: string
}

interface FeedDraftFile extends NativeFileRef {
  declarationKey: string
  attachmentId?: string
}

interface FeedDraftSnapshot {
  body: string
  files: FeedDraftFile[]
  retryLocked: boolean
  createKey: string
}

const MAX_EPHEMERAL_FEED_DRAFTS = 16
const ephemeralFeedDrafts = new Map<string, FeedDraftSnapshot>()

function TeamFeedComposer({ scope, teamId, capability, draftKey, onPosted }: {
  scope: TeamHubScope
  teamId: string
  capability: TeamMessagesCapability
  draftKey: string
  onPosted: (message: TeamMessage) => void
}) {
  useLocale()
  const [initialDraft] = useState(() => readFeedDraft(draftKey))
  const [body, setBody] = useState(initialDraft.body)
  const [files, setFiles] = useState<FeedDraftFile[]>(initialDraft.files)
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [retryLocked, setRetryLocked] = useState(initialDraft.retryLocked)
  const [error, setError] = useState<string | null>(initialDraft.retryLocked
    ? 'Posting was interrupted before this app received confirmation.'
    : null)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const contextKey = JSON.stringify([scope, teamId])
  const currentContext = useRef(contextKey)
  const createKey = useRef(initialDraft.createKey)
  currentContext.current = contextKey

  const resetCreateKey = () => { createKey.current = crypto.randomUUID() }
  useEffect(() => {
    mounted.current = true
    setBusy(false)
    setChoosing(false)
    submitting.current = false
    return () => { mounted.current = false; submitting.current = false }
  }, [contextKey])
  useEffect(() => {
    if (!body && files.length === 0 && !retryLocked) deleteFeedDraft(draftKey)
    else writeFeedDraft(draftKey, { body, files, retryLocked, createKey: createKey.current })
  }, [body, draftKey, files, retryLocked])

  const chooseFiles = async () => {
    if (busy || choosing || retryLocked) return
    const expectedContext = contextKey
    setChoosing(true)
    setError(null)
    try {
      const selected = await window.agentsDock.files.choose()
      if (!mounted.current || currentContext.current !== expectedContext || !selected.length) return
      const existing = new Map(files.map(file => [file.path, file]))
      for (const file of selected) {
        if (!existing.has(file.path)) existing.set(file.path, { ...file, declarationKey: crypto.randomUUID() })
      }
      const next = [...existing.values()]
      validateAttachmentFiles(next, capability)
      setFiles(next)
    } catch (cause) {
      if (mounted.current && currentContext.current === expectedContext) setError(errorMessage(cause))
    } finally {
      if (mounted.current && currentContext.current === expectedContext) setChoosing(false)
    }
  }

  const removeFile = (path: string) => {
    if (busy || retryLocked) return
    setFiles(current => current.filter(file => file.path !== path))
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting.current) return
    const cleanBody = body.trim()
    const expectedContext = contextKey
    try {
      validateFeedBody(cleanBody, capability)
      validateAttachmentFiles(files, capability)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    submitting.current = true
    setBusy(true)
    setError(null)
    let createAttempted = false
    let preparedFiles = files
    try {
      const attachmentIds: string[] = []
      for (const file of preparedFiles) {
        if (currentContext.current !== expectedContext) return
        if (file.attachmentId) {
          attachmentIds.push(file.attachmentId)
          continue
        }
        const declaration = await window.agentsDock.teamHub.declareTeamAttachment(scope, {
          teamId,
          path: file.path,
          fileName: file.name,
          mediaType: file.type || undefined,
          idempotencyKey: file.declarationKey
        })
        const uploaded = await window.agentsDock.teamHub.uploadTeamAttachment(scope, {
          teamId,
          attachmentId: declaration.attachment.id,
          path: file.path
        })
        if (
          uploaded.id !== declaration.attachment.id
          || uploaded.team_id !== teamId
          || uploaded.state !== 'ready'
        ) throw new Error(`The upload for ${file.name} did not finish safely.`)
        attachmentIds.push(uploaded.id)
        preparedFiles = preparedFiles.map(candidate => (
          candidate.path === file.path && candidate.declarationKey === file.declarationKey
            ? { ...candidate, attachmentId: uploaded.id }
            : candidate
        ))
        if (mounted.current && currentContext.current === expectedContext) {
          setFiles(preparedFiles)
          writeFeedDraft(draftKey, {
            body,
            files: preparedFiles,
            retryLocked: false,
            createKey: createKey.current
          })
        }
      }
      if (currentContext.current !== expectedContext) return
      createAttempted = true
      // Once the create request starts, its outcome can be ambiguous if the
      // Team Hub generation changes or the board unmounts. Keep both React
      // state and the resumable draft locked before crossing that boundary.
      setRetryLocked(true)
      writeFeedDraft(draftKey, {
        body,
        files: preparedFiles,
        retryLocked: true,
        createKey: createKey.current
      })
      const message = await window.agentsDock.teamHub.createTeamMessage(scope, {
        teamId,
        kind: 'message',
        body: cleanBody,
        bodyFormat: 'markdown',
        recipients: [{ kind: 'all' }],
        attachmentIds,
        provenance: { via: 'desktop' },
        idempotencyKey: createKey.current
      })
      if (!mounted.current || currentContext.current !== expectedContext) return
      onPosted(message)
      deleteFeedDraft(draftKey)
      setBody('')
      setFiles([])
      setRetryLocked(false)
      resetCreateKey()
    } catch (cause) {
      if (mounted.current && currentContext.current === expectedContext) {
        if (createAttempted) {
          setRetryLocked(true)
          writeFeedDraft(draftKey, {
            body,
            files: preparedFiles,
            retryLocked: true,
            createKey: createKey.current
          })
        }
        setError(errorMessage(cause))
      }
    } finally {
      if (mounted.current && currentContext.current === expectedContext) {
        submitting.current = false
        setBusy(false)
      }
    }
  }

  const updateBody = (value: string) => {
    if (busy || retryLocked) return
    setBody(value)
    setError(null)
  }

  const discardAttempt = () => {
    if (busy) return
    setBody('')
    setFiles([])
    setRetryLocked(false)
    setError(null)
    resetCreateKey()
    deleteFeedDraft(draftKey)
  }

  return <form className="network-v2-feed-composer" aria-label={t('teamNetwork.mail.postBulletin')} onSubmit={submit}>
    <label><span>{t('teamNetwork.mail.broadcastEveryone')}</span><textarea
      aria-label={t('teamNetwork.mail.teamBulletinComposer')}
      aria-describedby="team-bulletin-caption-help"
      rows={2}
      value={body}
      disabled={busy || retryLocked}
      onChange={event => updateBody(event.target.value)}
      placeholder={t('teamNetwork.mail.bulletinPlaceholder')}
    /></label>
    {files.length > 0 && <div className="network-v2-compose-files" aria-label={t('teamNetwork.mail.selectedAttachments')}>{files.map(file => <span key={file.path}>
      {attachmentIcon(file.name, file.type)}
      <span><strong>{file.name}</strong><small>{file.size === undefined ? attachmentKindLabel(attachmentKind(file.name, file.type)) : `${attachmentKindLabel(attachmentKind(file.name, file.type))} · ${formatBytes(file.size)}`}</small></span>
      <button type="button" aria-label={t('teamNetwork.mail.removeAttachment', { name: file.name })} disabled={busy || retryLocked} onClick={() => removeFile(file.path)}><X size={13} /></button>
    </span>)}</div>}
    {error && <p className="network-v2-compose-error" role="alert">{localizeMailError(error)}</p>}
    {retryLocked && !busy && <p className="network-v2-compose-retry" role="status">{t('teamNetwork.mail.uncertainPost')}</p>}
    <div><span id="team-bulletin-caption-help">{files.length ? t('teamNetwork.mail.attachedCount', { count: files.length, max: capability.attachments.max_files_per_message }) : t('teamNetwork.mail.addMedia')}</span><span>
      {retryLocked && <button type="button" className="quiet-button" disabled={busy} onClick={discardAttempt}>{t('teamNetwork.mail.newPost')}</button>}
      <button type="button" className="quiet-button" disabled={busy || choosing || retryLocked} onClick={() => void chooseFiles()}>{choosing ? <LoaderCircle className="spin" size={14} /> : <Paperclip size={14} />}{files.length ? t('teamNetwork.mail.addFiles') : t('teamNetwork.mail.attachFiles')}</button>
      <button className="primary-button" disabled={busy || choosing || !body.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{busy ? t('teamNetwork.mail.posting') : t('teamNetwork.mail.post')}</button>
    </span></div>
  </form>
}

function TeamMail({ scope, teamId, capability, canWrite, callerPostingKind, draftIdentity, addresses, canManageMessages, canHostDelete, initialAddress, mailboxRequestId, initialMessageId, initialMailboxBox, onInitialMessageConsumed, onAddressChange, routeTargets, onRouteMessage, onUnreadSnapshot, lifecycleCacheKey }: {
  scope: TeamHubScope
  teamId: string
  capability: TeamMessagesCapability
  canWrite: boolean
  callerPostingKind: 'human' | 'server' | null
  draftIdentity: string
  addresses: TeamMessageAddress[]
  canManageMessages: boolean
  canHostDelete: boolean
  initialAddress: TeamMessageAddress | null
  mailboxRequestId: number
  initialMessageId: string | null
  initialMailboxBox?: 'inbox' | 'sent'
  onInitialMessageConsumed?: () => void
  onAddressChange?: (address: TeamMessageAddress) => void
  routeTargets: TeamMailRouteTarget[]
  onRouteMessage?: (message: TeamMessageSummary, sessionId: string, intent?: 'read' | 'reply') => void
  onUnreadSnapshot?: (count: number, hasMore: boolean) => void
  lifecycleCacheKey: string
}) {
  useLocale()
  const [box, setBox] = useState<Extract<TeamMessageBox, 'inbox' | 'sent'>>(initialMailboxBox ?? 'inbox')
  const [selected, setSelected] = useState<TeamMessageSummary | null>(null)
  const linked = useLinkedTeamMessage(scope, teamId, initialMessageId, mailboxRequestId, setSelected, onInitialMessageConsumed)
  useEffect(() => { if (initialMailboxBox) setBox(initialMailboxBox) }, [initialMailboxBox, mailboxRequestId])
  const [deleteMessage, setDeleteMessage] = useState<TeamMessageSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const readReceiptGeneration = useRef(0)
  const [removing, setRemoving] = useState(false)
  const [retryAction, setRetryAction] = useState<'read' | 'remove'>('read')
  const readReceiptsInFlight = useRef(new Set<string>())
  const mailboxStateAttempts = useRef(new Map<string, TeamMailboxStateInput>())
  const mailboxScopeKey = JSON.stringify(scope)
  const address = addresses.find(candidate => initialAddress && candidate.kind === initialAddress.kind && candidate.id === initialAddress.id)
    ?? addresses[0]
    ?? null
  useEffect(() => {
    readReceiptGeneration.current += 1
    readReceiptsInFlight.current.clear()
    mailboxStateAttempts.current.clear()
    setSelected(null)
    setDeleteMessage(null)
    setDeleteError(null)
  }, [address?.id, address?.kind, box, mailboxRequestId, mailboxScopeKey])
  const mail = useTeamMessages(scope, {
    teamId,
    box,
    ...(box === 'inbox' && address ? { addressKind: address.kind, addressId: address.id } : {})
  }, box === 'sent' || Boolean(address), null, retainEveryMessage, lifecycleCacheKey)
  const deletionJournal = useTeamNetworkDeletionJournal(scope, teamId)
  const deletionKeys = deletionJournal.keys
  const visibleMessages = useMemo(() => mail.messages.filter(message => (
    !isBulletinMessage(message) && !deletionKeys.has(`message:${message.id}`)
  )), [deletionKeys, mail.messages])
  const unreadCount = visibleMessages.filter(message => messageIsUnread(message, address)).length
  const unreadSnapshot = useRef(onUnreadSnapshot)
  unreadSnapshot.current = onUnreadSnapshot
  useEffect(() => {
    if (box === 'inbox' && !mail.loading) unreadSnapshot.current?.(unreadCount, mail.hasMore)
  }, [address?.kind, address?.id, box, mail.hasMore, mail.loading, unreadCount])

  const markMailboxState = async (message: TeamMessageSummary, unread: boolean) => {
    if (box !== 'inbox' || address?.kind !== 'server' || capability.mailbox_state?.available !== true) return
    const state = message.mailbox_state
    if (!state || state.address_id !== address.id) {
      mail.setError('Refresh the mailbox before changing this message’s read status.')
      return
    }
    const generation = readReceiptGeneration.current
    const key = `${mailboxScopeKey}:${teamId}:${address.id}:${message.id}`
    if (readReceiptsInFlight.current.has(key)) return
    readReceiptsInFlight.current.add(key)
    const previous = mailboxStateAttempts.current.get(key)
    const attempt: TeamMailboxStateInput = previous?.unread === unread && previous.expectedVersion === state.version
      ? previous : { teamId, messageId: message.id, addressKind: 'server', addressId: address.id,
        unread, expectedVersion: state.version, idempotencyKey: crypto.randomUUID() }
    mailboxStateAttempts.current.set(key, attempt)
    try {
      const result = await window.agentsDock.teamHub.setTeamMessageMailboxState(scope, attempt)
      if (readReceiptGeneration.current !== generation) return
      if (result.message_id !== message.id || result.mailbox_state.address_id !== address.id
        || result.mailbox_state.unread !== unread || result.mailbox_state.version !== attempt.expectedVersion + 1) {
        throw new Error('Team Hub returned a mismatched mailbox state.')
      }
      mailboxStateAttempts.current.delete(key)
      mail.setError(null)
      mail.replace(message.id, current => keepNewestMailboxState({ ...current,
        mailbox_state: result.mailbox_state,
        recipients: mergeRecipientRows(current.recipients, result.recipients),
        delivery: result.recipients.find(recipient => recipient.kind === 'server' && recipient.id === address.id)
      }, current))
    } catch (cause) {
      if (readReceiptGeneration.current === generation) { setRetryAction('read'); mail.setError(errorMessage(cause)) }
    } finally { readReceiptsInFlight.current.delete(key) }
  }

  const markRead = async (message: TeamMessageSummary) => {
    if (box !== 'inbox' || !address || !messageIsUnread(message, address)) return
    if (capability.mailbox_state?.available === true && address.kind === 'server' && message.kind === 'message') {
      await markMailboxState(message, false)
      return
    }
    const generation = readReceiptGeneration.current
    const receiptKey = `${mailboxScopeKey}:${teamId}:${address.kind}:${address.id}:${message.id}`
    if (readReceiptsInFlight.current.has(receiptKey)) return
    readReceiptsInFlight.current.add(receiptKey)
    try {
      const result = await window.agentsDock.teamHub.recordTeamMessageReceipt(scope, {
        teamId,
        messageId: message.id,
        state: 'read',
        addressKind: address.kind,
        addressId: address.id,
        idempotencyKey: crypto.randomUUID()
      })
      if (result.message_id !== message.id) throw new Error('Team Hub returned the wrong message receipt.')
      const delivery = result.recipients.find(recipient => (
        recipient.kind === address.kind && recipient.id === address.id
      ))
      if (!delivery || delivery.state !== 'read') {
        throw new Error('Team Hub did not mark this mailbox message as read.')
      }
      window.dispatchEvent(new CustomEvent('agentsdock:team-network-mail-read', {
        detail: {
          messageId: message.id,
          teamId,
          addressKind: address.kind,
          addressId: address.id
        }
      }))
      if (readReceiptGeneration.current === generation) {
        mail.setError(null)
        mail.replace(message.id, current => ({
          ...current,
          recipients: mergeRecipientRows(current.recipients, result.recipients),
          delivery
        }))
      }
    } catch (cause) {
      if (readReceiptGeneration.current === generation) {
        setRetryAction('read')
        mail.setError(errorMessage(cause))
      }
    } finally {
      readReceiptsInFlight.current.delete(receiptKey)
    }
  }

  const openMessage = (message: TeamMessageSummary) => {
    setSelected(message)
  }

  const removeFromInbox = async (message: TeamMessageSummary) => {
    if (!address || box !== 'inbox' || removing) return
    const generation = readReceiptGeneration.current
    setRemoving(true)
    mail.setError(null)
    try {
      await window.agentsDock.teamHub.dismissTeamMessage(scope, {
        teamId, messageId: message.id, addressKind: address.kind, addressId: address.id,
        idempotencyKey: crypto.randomUUID()
      })
      if (readReceiptGeneration.current !== generation) return
      mail.remove(message.id)
      setSelected(null)
      await mail.refresh()
    } catch (cause) {
      if (readReceiptGeneration.current === generation) {
        setRetryAction('remove')
        mail.setError(errorMessage(cause))
      }
    } finally {
      setRemoving(false)
    }
  }

  useEffect(() => {
    if (selected && deletionKeys.has(`message:${selected.id}`)) setSelected(null)
    if (deleteMessage && deletionKeys.has(`message:${deleteMessage.id}`)) setDeleteMessage(null)
  }, [deleteMessage, deletionKeys, selected])

  const confirmDelete = async () => {
    if (!deleteMessage || deleting) return
    const message = deleteMessage
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await window.agentsDock.teamHub.deleteTeamMessage(scope, {
        teamId,
        messageId: message.id,
        idempotencyKey: crypto.randomUUID()
      })
      if (result.deleted !== true || result.message_id !== message.id) throw new Error('Team Hub returned the wrong message deletion receipt.')
      dispatchTeamNetworkMessageDeleted(scope, teamId, message.id)
      mail.remove(message.id)
      setDeleteMessage(null)
    } catch (cause) {
      setDeleteError(errorMessage(cause))
    } finally {
      setDeleting(false)
    }
  }

  if (linked.loading || linked.error) return <LinkedMessageState state={linked} />
  if (selected) {
    return <MessageDetailLoader
      summary={selected}
      initialMessage={linked.message}
      scope={scope}
      teamId={teamId}
      onBack={() => setSelected(null)}
      onLoaded={detail => {
        mail.replace(selected.id, current => keepNewestMailboxState({ ...current,
          recipients: detail.recipients, delivery: detail.delivery, mailbox_state: detail.mailbox_state
        }, current))
        void markRead({ ...selected, ...detail })
      }}
      detailError={mail.error}
      onRetryReceipt={retryAction === 'remove' ? () => void removeFromInbox(selected)
        : capability.mailbox_state?.available === true && address?.kind === 'server' ? undefined : () => void markRead(selected)}
      routeTargets={routeTargets}
      onRoute={onRouteMessage ? sessionId => onRouteMessage(selected, sessionId) : undefined}
      onReply={onRouteMessage ? (message, sessionId) => onRouteMessage(summaryFromMessage(message), sessionId, 'reply') : undefined}
      onRemove={box === 'inbox' ? () => void removeFromInbox(selected) : undefined}
      removing={removing}
      showReceipts={box === 'sent'}
      threadEnabled={capability.mail_threads?.available === true}
      ownedAddresses={addresses}
      replyContext={canWrite && callerPostingKind === 'server' && address?.kind === 'server'
        ? { address, ownedAddresses: addresses }
        : undefined}
      canDelete={deletionJournal.supported && (canHostDelete || canDeleteMessageAuthor(selected.sender, addresses, canManageMessages))}
      onDeleted={messageId => { mail.remove(messageId); setSelected(null) }}
    />
  }

  return <section className="network-v2-surface" aria-label={t('teamNetwork.mail.teamMail')}>
    <SurfaceHeader
      icon={<Inbox size={20} />}
      title={t('teamNetwork.mail.mail')}
      description={t('teamNetwork.mail.mailDescription')}
      loading={mail.loading}
      onRefresh={() => { void mail.refresh(); void deletionJournal.refresh() }}
    >
      <div className="network-v2-segmented" role="group" aria-label={t('teamNetwork.mail.mailbox')}>
        <button type="button" className={box === 'inbox' ? 'active' : ''} onClick={() => setBox('inbox')}><Inbox size={13} />{t('teamNetwork.mail.inbox')}</button>
        <button type="button" className={box === 'sent' ? 'active' : ''} onClick={() => setBox('sent')}><Send size={13} />{t('teamNetwork.mail.sent')}</button>
      </div>
      {box === 'inbox' && addresses.length > 1 && <label className="network-v2-address">{t('teamNetwork.mail.address')}<select value={address ? addressKey(address) : ''} onChange={event => {
        const next = addresses.find(candidate => addressKey(candidate) === event.target.value)
        if (next) onAddressChange?.(next)
      }}><option value="" disabled>{t('teamNetwork.mail.chooseAddress')}</option>{addresses.map(option => <option key={addressKey(option)} value={addressKey(option)}>{option.label}</option>)}</select></label>}
    </SurfaceHeader>
    {mail.error && <InlineError message={mail.error} onRetry={mail.refresh} />}
    <div className="network-v2-scroll network-v2-bundle-grid">
      {box === 'inbox' && !address && <EmptyState icon={<Inbox size={23} />} title={t('teamNetwork.mail.noMailboxTitle')} body={t('teamNetwork.mail.noMailboxBody')} />}
      {(box === 'sent' || address) && !mail.loading && visibleMessages.length === 0 && <EmptyState icon={<Mail size={23} />} title={box === 'inbox' ? t('teamNetwork.mail.emptyInbox') : t('teamNetwork.mail.emptySent')} body={box === 'inbox' ? t('teamNetwork.mail.emptyInboxBody') : t('teamNetwork.mail.emptySentBody')} />}
      {visibleMessages.map(message => <MessageCard
        key={message.id}
        message={message}
        unread={box === 'inbox' && messageIsUnread(message, address)}
        onOpen={() => openMessage(message)}
        onMarkRead={box === 'inbox' && messageIsUnread(message, address)
          ? () => void markRead(message)
          : undefined}
        onMarkUnread={box === 'inbox' && address?.kind === 'server' && message.kind === 'message'
          && capability.mailbox_state?.available === true && message.mailbox_state?.address_id === address.id
          && !messageIsUnread(message, address) ? () => void markMailboxState(message, true) : undefined}
        routeTargets={onRouteMessage ? routeTargets : []}
        onRoute={onRouteMessage ? sessionId => onRouteMessage(message, sessionId) : undefined}
        onRemove={box === 'inbox' ? () => void removeFromInbox(message) : undefined}
        onDelete={deletionJournal.supported && (canHostDelete || canDeleteMessageAuthor(message.sender, addresses, canManageMessages))
          ? () => { setDeleteError(null); setDeleteMessage(message) }
          : undefined}
      />)}
      {mail.hasMore && <button type="button" className="quiet-button network-v2-load-more" disabled={mail.loadingMore} onClick={mail.loadMore}>{mail.loadingMore && <LoaderCircle className="spin" size={14} />}{t('teamNetwork.mail.loadMore')}</button>}
    </div>
    {deleteMessage && <MessageDeleteDialog
      target={deleteTargetForMessage(deleteMessage)}
      variant="mail"
      busy={deleting}
      error={deleteError}
      onCancel={() => { if (!deleting) setDeleteMessage(null) }}
      onConfirm={() => void confirmDelete()}
    />}
  </section>
}

interface MessageBundle {
  key: string
  label: string
  icon: ReactNode
  unreadCount: number
  messages: TeamMessageSummary[]
}

function MessageBundleDetail({ bundle, scope, teamId, label, onBack, onOpen, ownedAddresses, canManageMessages, deletionSupported, deletionKeys, onDeleted }: {
  bundle: MessageBundle
  scope: TeamHubScope
  teamId: string
  label: string
  onBack: () => void
  onOpen: (message: TeamMessageSummary) => void
  ownedAddresses: TeamMessageAddress[]
  canManageMessages: boolean
  deletionSupported: boolean
  deletionKeys: ReadonlySet<string>
  onDeleted: (messageId: string) => void
}) {
  useLocale()
  const [selected, setSelected] = useState<TeamMessageSummary | null>(null)
  const [deleteMessage, setDeleteMessage] = useState<TeamMessageSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (selected && deletionKeys.has(`message:${selected.id}`)) setSelected(null)
  }, [deletionKeys, selected])
  const confirmDelete = async () => {
    if (!deleteMessage || deleting) return
    const message = deleteMessage
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await window.agentsDock.teamHub.deleteTeamMessage(scope, {
        teamId,
        messageId: message.id,
        idempotencyKey: crypto.randomUUID()
      })
      if (result.deleted !== true || result.message_id !== message.id) throw new Error('Team Hub returned the wrong message deletion receipt.')
      dispatchTeamNetworkMessageDeleted(scope, teamId, message.id)
      onDeleted(message.id)
      setDeleteMessage(null)
    } catch (cause) {
      setDeleteError(errorMessage(cause))
    } finally {
      setDeleting(false)
    }
  }
  if (selected) return <MessageDetailLoader
    summary={selected}
    scope={scope}
    teamId={teamId}
    onBack={() => setSelected(null)}
    canDelete={deletionSupported && canDeleteMessageAuthor(selected.sender, ownedAddresses, canManageMessages)}
    onDeleted={messageId => {
      onDeleted(messageId)
      setSelected(null)
    }}
  />
  return <section className="network-v2-surface" aria-label={label}>
    <header className="network-v2-detail-header"><button type="button" className="quiet-button" autoFocus onClick={onBack}><ArrowLeft size={14} />{t('teamNetwork.mail.mail')}</button><div><span className="network-v2-avatar">{bundle.icon}</span><span><h1>{bundle.label}</h1><p>{t(bundle.messages.length === 1 ? 'teamNetwork.mail.messageCountOne' : 'teamNetwork.mail.messageCountMany', { count: bundle.messages.length })}</p></span></div></header>
    <div className="network-v2-scroll network-v2-message-list">{bundle.messages.map(message => <MessageCard
      key={message.id}
      message={message}
      onOpen={() => { setSelected(message); void onOpen(message) }}
      onDelete={deletionSupported && canDeleteMessageAuthor(message.sender, ownedAddresses, canManageMessages)
        ? () => { setDeleteError(null); setDeleteMessage(message) }
        : undefined}
    />)}</div>
    {deleteMessage && <MessageDeleteDialog
      target={deleteTargetForMessage(deleteMessage)}
      variant="mail"
      busy={deleting}
      error={deleteError}
      onCancel={() => { if (!deleting) setDeleteMessage(null) }}
      onConfirm={() => void confirmDelete()}
    />}
  </section>
}

function useLinkedTeamMessage(scope: TeamHubScope, teamId: string, messageId: string | null, requestId: number,
  onSelect: (message: TeamMessageSummary | null) => void, onConsumed?: () => void) {
  const [message, setMessage] = useState<TeamMessage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const callbacks = useRef({ onSelect, onConsumed })
  callbacks.current = { onSelect, onConsumed }
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    if (!messageId) return
    let active = true
    const attempt = ++generation.current
    setMessage(null)
    setError(null)
    setLoading(true)
    callbacks.current.onSelect(null)
    void window.agentsDock.teamHub.teamMessage(scope, teamId, messageId).then(detail => {
      if (!active || attempt !== generation.current) return
      if (detail.id !== messageId || detail.team_id !== teamId) throw new Error('Team Network returned the wrong linked message.')
      setMessage(detail)
      setLoading(false)
      callbacks.current.onSelect(summaryFromMessage(detail))
      callbacks.current.onConsumed?.()
    }).catch(cause => {
      if (active && attempt === generation.current) { setError(errorMessage(cause)); setLoading(false) }
    })
    return () => { active = false }
  }, [scopeKey, teamId, messageId, requestId, retry])
  return { message, error, loading, retry: () => setRetry(value => value + 1), dismiss: () => {
    generation.current += 1
    setError(null)
    setLoading(false)
    callbacks.current.onConsumed?.()
  } }
}

function LinkedMessageState({ state }: { state: ReturnType<typeof useLinkedTeamMessage> }) {
  useLocale()
  return <section className="network-v2-surface" aria-label={t('teamNetwork.mail.linkedMessage')}>
    <header className="network-v2-detail-header"><button type="button" className="quiet-button" onClick={state.dismiss}><ArrowLeft size={14} />{t('teamNetwork.mail.back')}</button></header>
    {state.error ? <InlineError message={state.error} onRetry={state.retry} /> : <div className="network-v2-detail-state" role="status">{t('teamNetwork.mail.loadingLinked')}</div>}
  </section>
}

function MessageDetailLoader({ summary, initialMessage, scope, teamId, onBack, canDelete = false, onDeleted, onLoaded, detailError, onRetryReceipt, routeTargets = [], onRoute, onReply, onRemove, removing, showReceipts, replyContext, threadEnabled = false, ownedAddresses = [] }: {
  summary: TeamMessageSummary
  initialMessage?: TeamMessage | null
  scope: TeamHubScope
  teamId: string
  onBack: () => void
  canDelete?: boolean
  onDeleted?: (messageId: string) => void
  onLoaded?: (message: TeamMessage) => void
  detailError?: string | null
  onRetryReceipt?: () => void
  routeTargets?: TeamMailRouteTarget[]
  onRoute?: (sessionId: string) => void
  onReply?: (message: TeamMessage, sessionId: string) => void
  onRemove?: () => void
  removing?: boolean
  showReceipts?: boolean
  replyContext?: MailReplyContext
  threadEnabled?: boolean
  ownedAddresses?: TeamMessageAddress[]
}) {
  useLocale()
  const [message, setMessage] = useState<TeamMessage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState(0)
  const scopeKey = JSON.stringify(scope)
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  useEffect(() => {
    let active = true
    setMessage(null)
    setError(null)
    if (initialMessage?.id === summary.id && initialMessage.team_id === teamId) {
      setMessage(initialMessage)
      onLoadedRef.current?.(initialMessage)
      return
    }
    void window.agentsDock.teamHub.teamMessage(scope, teamId, summary.id)
      .then(detail => {
        if (!active) return
        if (detail.id !== summary.id || detail.team_id !== teamId) throw new Error('Team Network returned the wrong message detail.')
        setMessage(detail)
        onLoadedRef.current?.(detail)
      })
      .catch(cause => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [request, scopeKey, summary.id, teamId, initialMessage])

  if (message) return <MessageDetail key={`${scopeKey}:${message.id}`} message={message} mailTitle={mailDisplayTitle(summary)} scope={scope} teamId={teamId} onBack={onBack} canDelete={canDelete} onDeleted={onDeleted} routeTargets={routeTargets} onReply={onReply} threadEnabled={threadEnabled} ownedAddresses={ownedAddresses} actions={<>
    {onRoute && <MessageRouteMenu message={summary} routeTargets={routeTargets} onRoute={onRoute} menuLabel={t('teamNetwork.mail.openInChat')} />}
    {onRemove && <button type="button" className="quiet-button" disabled={removing} onClick={onRemove}><Archive size={14} />{removing ? t('teamNetwork.mail.removing') : t('teamNetwork.mail.removeInbox')}</button>}
  </>} notice={detailError && <InlineError message={detailError} onRetry={onRetryReceipt ?? (() => setRequest(value => value + 1))} />} showReceipts={showReceipts} replyContext={replyContext} />
  return <section className="network-v2-surface" aria-label={mailDisplayTitle(summary) || summary.title || t('teamNetwork.mail.teamMessage')}>
    <MessageDetailHeader message={summary} onBack={onBack} />
    {error
      ? <div className="network-v2-detail-state" role="alert"><span>{localizeMailError(error)}</span><button type="button" className="quiet-button" onClick={() => setRequest(value => value + 1)}>{t('teamNetwork.mail.retry')}</button></div>
      : <div className="network-v2-detail-state" role="status"><LoaderCircle className="spin" size={17} />{t('teamNetwork.mail.loadingMessage')}</div>}
  </section>
}

function MessageDetail({ message, mailTitle, scope, teamId, onBack, canDelete, onDeleted, actions, notice, showReceipts, replyContext, routeTargets, onReply, threadEnabled, ownedAddresses }: {
  message: TeamMessage
  mailTitle?: string
  scope: TeamHubScope
  teamId: string
  onBack: () => void
  canDelete: boolean
  onDeleted?: (messageId: string) => void
  actions?: ReactNode
  notice?: ReactNode
  showReceipts?: boolean
  replyContext?: MailReplyContext
  routeTargets: TeamMailRouteTarget[]
  onReply?: (message: TeamMessage, sessionId: string) => void
  threadEnabled: boolean
  ownedAddresses: TeamMessageAddress[]
}) {
  useLocale()
  const [historyOpen, setHistoryOpen] = useState(false)
  const canReply = onReply && replyContext && incomingServerMail(message, replyContext)
  const showThread = threadEnabled && !isBulletinMessage(message)
  const parentLink = message.in_reply_to_message_id && !isBulletinMessage(message)
    ? teamMessageLinkURL({ section: 'mail', teamId, messageId: message.in_reply_to_message_id,
      serverIdentity: scope.serverIdentity,
      ...(showReceipts === undefined ? {} : { mailboxBox: showReceipts ? 'inbox' : 'sent' }) })
    : null
  return <section className="network-v2-surface" aria-label={mailDisplayTitle(message, mailTitle) || message.title || t('teamNetwork.mail.teamMessage')}>
    <MessageDetailHeader message={message} mailTitle={mailTitle} onBack={onBack} actions={<>{canReply && !showThread && <MessageRouteMenu message={summaryFromMessage(message)} routeTargets={routeTargets} onRoute={sessionId => onReply(message, sessionId)} menuLabel={t('teamNetwork.mail.replyThroughAgent')} intent="reply" />}{actions}{isBulletinMessage(message) && message.revision && <button type="button" className="quiet-button" onClick={() => setHistoryOpen(value => !value)}>{t('teamNetwork.mail.versionHistory')}</button>}{canDelete && onDeleted && <DeleteTeamMessageAction message={message} scope={scope} teamId={teamId} onDeleted={onDeleted} />}</>} />
    {notice}
    <div className="network-v2-scroll network-v2-detail-body">
      {showThread ? <MailThread message={message} scope={scope} teamId={teamId} ownedAddresses={ownedAddresses} replyContext={replyContext} routeTargets={routeTargets} onReply={onReply} /> : <>
      {parentLink && <p className="network-v2-provenance">{t('teamNetwork.mail.inReplyTo')} <a href={parentLink} onClick={event => { event.preventDefault(); openTeamMessageLink(parentLink) }}>{t('teamNetwork.mail.originalMessage')}</a></p>}
      <div className="network-v2-recipient-row"><strong>{message.destination === 'all_servers' ? t('teamNetwork.mail.allServerMail') : t('teamNetwork.mail.to')}</strong>{message.recipients.map((recipient, index) => <span className="network-v2-tag" key={`${recipient.kind}:${recipient.id ?? 'all'}:${index}`}>{recipient.kind === 'all' ? t('teamNetwork.mail.bulletin') : recipient.display_name}{showReceipts && recipient.kind !== 'all' ? ` · ${recipient.state === 'available' ? t('teamNetwork.mail.available') : recipient.state === 'delivered' ? t('teamNetwork.mail.delivered') : t('teamNetwork.mail.read')}` : ''}</span>)}</div>
      {historyOpen && <MessageVersionHistory scope={scope} teamId={teamId} messageId={message.id} />}
      <TeamMessageBody format={message.body_format} body={message.body} />
      {message.attachments.length > 0 && <AttachmentCollection attachments={message.attachments} scope={scope} />}
      <footer className="network-v2-provenance">{t('teamNetwork.mail.messageSequence', { sequence: message.sequence })}{message.revision && message.revision.version > 1 ? t('teamNetwork.mail.editedSuffix', { version: message.revision.version }) : ''}{message.provenance.backend ? t('teamNetwork.mail.composedBy', { backend: message.provenance.backend }) : ''}</footer>
      </>}
    </div>
  </section>
}

interface MailReplyContext {
  address: TeamMessageAddress
  ownedAddresses: TeamMessageAddress[]
}

function incomingServerMail(message: TeamMessage, context: MailReplyContext): boolean {
  return message.kind === 'message' && message.skill === null && !isBulletinMessage(message)
    && message.sender.kind === 'server'
    && !context.ownedAddresses.some(address => address.kind === 'server' && address.id === message.sender.id)
    && context.address.kind === 'server' && message.delivery?.kind === 'server'
    && message.delivery.id === context.address.id
    && message.recipients.length > 0 && message.recipients.every(recipient => recipient.kind === 'server')
    && message.recipients.some(recipient => recipient.id === context.address.id)
}


function MailThread({ message, scope, teamId, ownedAddresses, replyContext, routeTargets, onReply }: {
  message: TeamMessage
  scope: TeamHubScope
  teamId: string
  ownedAddresses: TeamMessageAddress[]
  replyContext?: MailReplyContext
  routeTargets: TeamMailRouteTarget[]
  onReply?: (message: TeamMessage, sessionId: string) => void
}) {
  useLocale()
  const [messages, setMessages] = useState<TeamMessage[]>([message])
  const [cursor, setCursor] = useState(0)
  const [nextCursor, setNextCursor] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const rootId = useRef<string | null>(null)
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.agentsDock.teamHub.teamMessageThread(scope, { teamId, messageId: message.id, afterSequence: cursor, limit: 25 })
      .then(page => {
        if (!active) return
        if (page.team_id !== teamId || page.anchor_message_id !== message.id
          || (rootId.current && rootId.current !== page.root_message_id)
          || page.messages.some(row => row.team_id !== teamId)
          || (page.has_more && page.next_after_sequence <= cursor)) throw new Error('Team Network returned a different mail thread.')
        rootId.current = page.root_message_id
        setMessages(current => [...new Map([...(cursor === 0 ? [] : current), ...page.messages].map(row => [row.id, row])).values()]
          .sort((left, right) => left.sequence - right.sequence))
        setNextCursor(page.next_after_sequence)
        setHasMore(page.has_more)
        setTruncated(current => cursor === 0 ? page.truncated : current || page.truncated)
      }).catch(cause => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scopeKey, teamId, message.id, cursor, retry])
  return <div className="network-v2-mail-thread" aria-label={t('teamNetwork.mail.thread')}>
    <div className="network-v2-thread-actions"><button type="button" className="quiet-button" aria-label={t('teamNetwork.mail.refreshThread')} title={t('teamNetwork.mail.refreshThread')} disabled={loading} onClick={() => { rootId.current = null; setCursor(0); setRetry(value => value + 1) }}><RefreshCw size={14} /></button></div>
    {messages.map(row => {
      const outgoing = ownedAddresses.some(address => address.kind === row.sender.kind && address.id === row.sender.id)
      const canReply = onReply && replyContext && incomingServerMail(row, replyContext)
      return <article key={row.id} className={`network-v2-thread-message${outgoing ? ' outgoing' : ' incoming'}`} data-message-id={row.id}>
        <header><strong>{row.sender.display_name}</strong><time>{formatDate(row.created_at)}</time>
          {canReply && <MessageRouteMenu message={summaryFromMessage(row)} routeTargets={routeTargets} onRoute={sessionId => onReply(row, sessionId)} menuLabel={t('teamNetwork.mail.replyThroughAgent')} intent="reply" />}
        </header>
        <div className="network-v2-thread-recipients">{t('teamNetwork.mail.to')} {row.recipients.map(recipient => `${recipient.display_name}${outgoing ? ` · ${recipient.state === 'available' ? t('teamNetwork.mail.available') : recipient.state === 'delivered' ? t('teamNetwork.mail.delivered') : t('teamNetwork.mail.read')}` : ''}`).join(', ')}</div>
        <TeamMessageBody format={row.body_format} body={row.body} />
        {row.attachments.length > 0 && <AttachmentCollection attachments={row.attachments} scope={scope} />}
      </article>
    })}
    {loading && <div className="network-v2-detail-state" role="status">{t('teamNetwork.mail.loadingThread')}</div>}
    {error && <InlineError message={error} onRetry={() => setRetry(value => value + 1)} />}
    {truncated && <p className="network-v2-provenance" role="status">{t('teamNetwork.mail.partialThread')}</p>}
    {hasMore && <button type="button" className="quiet-button" disabled={loading} onClick={() => setCursor(nextCursor)}>{t('teamNetwork.mail.loadMoreMessages')}</button>}
  </div>
}

function MessageVersionHistory({ scope, teamId, messageId }: { scope: TeamHubScope; teamId: string; messageId: string }) {
  useLocale()
  const [versions, setVersions] = useState<TeamMessageHistoryEntry[]>([])
  const [selected, setSelected] = useState<TeamMessageHistoryEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState(0)
  const [version, setVersion] = useState<number | undefined>()
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.agentsDock.teamHub.teamMessageHistory(scope, teamId, messageId, version).then(result => {
      if (!active) return
      if (version === undefined) setVersions(result.versions)
      else setSelected(result.versions[0] ?? null)
    }).catch(cause => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scopeKey, teamId, messageId, version, request])
  return <section aria-label={t('teamNetwork.mail.versionHistory')}>
    <h2>{t('teamNetwork.mail.versionHistory')}</h2>
    <div className="network-v2-recipient-row">{versions.map(item => <button type="button" className="quiet-button" key={item.version}
      disabled={loading} onClick={() => setVersion(item.version)}>v{item.version} · {formatDate(item.created_at)}</button>)}</div>
    {loading && <p role="status">{t('teamNetwork.mail.loadingHistory')}</p>}
    {error && <InlineError message={error} onRetry={() => setRequest(value => value + 1)} />}
    {selected && !loading && <><p>{t('teamNetwork.mail.version', { version: selected.version })} · {selected.editor.display_name}</p><TeamMessageBody format={selected.body_format} body={selected.body ?? selected.preview ?? ''} /></>}
  </section>
}

function DeleteTeamMessageAction({ message, scope, teamId, onDeleted }: {
  message: TeamMessage
  scope: TeamHubScope
  teamId: string
  onDeleted: (messageId: string) => void
}) {
  useLocale()
  const [target, setTarget] = useState<BulletinDeleteTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const trigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => () => {
    mounted.current = false
    inFlight.current = false
  }, [])

  const close = () => {
    if (inFlight.current) return
    setTarget(null)
    setError(null)
    queueMicrotask(() => trigger.current?.focus())
  }
  const remove = async () => {
    if (!target || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await window.agentsDock.teamHub.deleteTeamMessage(scope, {
        teamId,
        messageId: message.id,
        idempotencyKey: target.idempotencyKey
      })
      if (result.deleted !== true || result.message_id !== message.id) {
        throw new Error('Team Hub returned the wrong message deletion receipt.')
      }
      dispatchTeamNetworkMessageDeleted(scope, teamId, message.id)
      onDeleted(message.id)
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    <button
      ref={trigger}
      type="button"
      className="quiet-button danger"
      aria-label={t('teamNetwork.mail.deleteEveryone')}
      onClick={() => {
        setError(null)
        setTarget(deleteTargetForMessage(message))
      }}
    ><Trash2 size={14} />{t('teamNetwork.mail.deleteEveryone')}</button>
    {target && <MessageDeleteDialog
      target={target}
      variant="mail"
      busy={busy}
      error={error}
      onCancel={close}
      onConfirm={() => void remove()}
    />}
  </>
}

function MessageDetailHeader({ message, mailTitle, onBack, actions }: { message: TeamMessageBase; mailTitle?: string; onBack: () => void; actions?: ReactNode }) {
  useLocale()
  return <header className={`network-v2-detail-header${isBulletinMessage(message) ? '' : ' mail'}`}><button type="button" className="quiet-button" autoFocus onClick={onBack}><ArrowLeft size={14} />{t('teamNetwork.mail.back')}</button><div><span className="network-v2-avatar">{message.kind === 'skill' ? <BookOpenCheck size={18} /> : <Mail size={18} />}</span><span><h1>{mailDisplayTitle(message, mailTitle) || message.title || t(isBulletinMessage(message) ? 'teamNetwork.mail.announcementFrom' : 'teamNetwork.mail.messageFrom', { sender: message.sender.display_name })}</h1><p>{isBulletinMessage(message) ? `${message.kind === 'skill' ? t('teamNetwork.mail.skill') : t('teamNetwork.mail.announcement')} · ` : ''}{message.sender.display_name} · {formatDate(message.created_at)}</p></span></div>{actions && <div className="network-v2-detail-actions">{actions}</div>}</header>
}

function TeamMessageBody({ format, body }: { format: TeamMessage['body_format']; body: string }) {
  return format === 'markdown'
    ? <MarkdownContent text={body} fold={false} />
    : <p className="network-v2-plain-body">{body}</p>
}

function MessageCard({ message, unread = false, onOpen, onMarkRead, onMarkUnread, onDelete, onRemove, routeTargets = [], onRoute }: { message: TeamMessageSummary; unread?: boolean; onOpen: () => void; onMarkRead?: () => void; onMarkUnread?: () => void; onDelete?: () => void; onRemove?: () => void; routeTargets?: TeamMailRouteTarget[]; onRoute?: (sessionId: string) => void }) {
  useLocale()
  const title = mailDisplayTitle(message) || message.title
  const card = <article className={`network-v2-card message ${message.kind}${unread ? ' unread' : ''}`}>
    <button type="button" className="network-v2-card-open" aria-label={t('teamNetwork.mail.openNamedMessage', { message: title || t('teamNetwork.mail.messageFromLower', { sender: message.sender.display_name }) })} onClick={onOpen}>
      <span className="network-v2-card-heading">
        <strong className="network-v2-card-title" title={title || message.sender.display_name}>{title || message.sender.display_name}</strong>
        <small className="network-v2-card-metadata">
          <span className="network-v2-card-sender" title={message.sender.display_name}>{message.kind === 'skill' ? <BookOpenCheck size={14} /> : <Server size={14} />}<span>{message.sender.display_name}</span></span>
          <time dateTime={message.created_at} title={formatDate(message.created_at)}>{mailCardDateFormats[getLocale()].format(new Date(message.created_at))}</time>
        </small>
      </span>
      <span className="network-v2-card-preview">{messagePreview(message)}</span>
      {message.attachments.length > 0 && <span className="network-v2-card-media" aria-label={attachmentCountLabel(message.attachments)}>{message.attachments.slice(0, 3).map(attachment => <span key={attachment.id}>
        {attachmentIcon(attachment.file_name, attachment.media_type)}<span>{attachment.file_name}</span>
      </span>)}{message.attachments.length > 3 && <b>+{message.attachments.length - 3}</b>}</span>}
    </button>
    <footer className="network-v2-card-footer">
      <span className="network-v2-card-destination" title={isBulletinMessage(message) ? t('teamNetwork.mail.bulletin') : t('teamNetwork.mail.toRecipients', { recipients: recipientSummary(message) })}>{isBulletinMessage(message) ? t('teamNetwork.mail.bulletin') : t('teamNetwork.mail.toRecipients', { recipients: recipientSummary(message) })}</span>
      {message.attachments.length > 0 && <span><Paperclip size={12} />{message.attachments.length}</span>}
      {onRoute && <span className="network-v2-message-actions"><MessageRouteMenu message={message} routeTargets={routeTargets} onRoute={onRoute} menuLabel={t('teamNetwork.mail.openInChat')} /></span>}
    </footer>
  </article>
  return <ContextMenu.Root><ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger><ContextMenu.Portal>
    <ContextMenu.Content className="menu-content">
      <ContextMenu.Item className="menu-item" onSelect={onOpen}><Mail size={14} />{t('teamNetwork.mail.openMessage')}</ContextMenu.Item>
      {onMarkRead && <ContextMenu.Item className="menu-item" onSelect={onMarkRead}><Check size={14} />{t('teamNetwork.mail.markRead')}</ContextMenu.Item>}
      {onMarkUnread && <ContextMenu.Item className="menu-item" onSelect={onMarkUnread}><Mail size={14} />{t('teamNetwork.mail.markUnread')}</ContextMenu.Item>}
      {onRemove && <ContextMenu.Item className="menu-item" onSelect={onRemove}><Archive size={14} />{t('teamNetwork.mail.removeInbox')}</ContextMenu.Item>}
      {onDelete && <><ContextMenu.Separator className="menu-separator" /><ContextMenu.Item className="menu-item danger" onSelect={onDelete}><Trash2 size={14} />{t('teamNetwork.mail.deleteEveryoneMenu')}</ContextMenu.Item></>}
    </ContextMenu.Content>
  </ContextMenu.Portal></ContextMenu.Root>
}

function MessageRouteMenu({ message, routeTargets, onRoute, menuLabel, intent = 'read' }: {
  message: TeamMessageSummary
  routeTargets: TeamMailRouteTarget[]
  onRoute: (sessionId: string) => void
  menuLabel: string
  intent?: 'read' | 'reply'
}) {
  useLocale()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  const filtered = useMemo(() => open ? routeTargets.filter(target => target.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [], [open, query, routeTargets])
  const duplicateLabels = useMemo(() => {
    const seen = new Set<string>(), duplicates = new Set<string>()
    if (!open) return duplicates
    for (const target of routeTargets) { if (seen.has(target.label)) duplicates.add(target.label); seen.add(target.label) }
    return duplicates
  }, [open, routeTargets])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  return <DropdownMenu.Root open={open} onOpenChange={next => { setOpen(next); if (next) setQuery('') }}><DropdownMenu.Trigger asChild><button type="button" className="quiet-button route" aria-label={intent === 'reply' ? t('teamNetwork.mail.reply') : t('teamNetwork.mail.routeNamedMessage', { message: mailDisplayTitle(message) || message.title || t('teamNetwork.mail.messageFromLower', { sender: message.sender.display_name }) })} title={intent === 'reply' ? t('teamNetwork.mail.draftAgentReply') : t('teamNetwork.mail.routeChat')}>{intent === 'reply' ? <Reply size={14} /> : <Forward size={14} />}<span>{intent === 'reply' ? t('teamNetwork.mail.reply') : t('teamNetwork.mail.route')}</span><ChevronDown size={12} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content network-v2-route-menu" align="end">
    <DropdownMenu.Label className="menu-label">{menuLabel}</DropdownMenu.Label>
    <input ref={input} className="network-v2-route-search" aria-label={t('teamNetwork.mail.searchChats')} placeholder={t('teamNetwork.mail.searchChatsPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === 'Escape') return
      event.stopPropagation()
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault()
        const first = event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]')
        if (event.key === 'Enter') first?.click()
        else first?.focus()
      }
    }} />
    {filtered.length ? filtered.map(target => <DropdownMenu.Item className="menu-item network-v2-route-item" key={target.id} onSelect={() => onRoute(target.id)}><span>{target.label}{duplicateLabels.has(target.label) && <small>{target.id}</small>}</span>{target.current && <Check size={13} aria-label={t('teamNetwork.mail.currentChat')} />}</DropdownMenu.Item>) : <DropdownMenu.Label className="menu-label">{routeTargets.length ? t('teamNetwork.mail.noMatchingChats') : t('teamNetwork.mail.noActiveChats')}</DropdownMenu.Label>}
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}

function FeedMessageCard({ message, scope, canDelete, canEdit, onOpen, onDelete, onEdit, routeTargets, onRoute }: {
  message: TeamMessageSummary
  scope: TeamHubScope
  canDelete: boolean
  canEdit: boolean
  onOpen: () => void
  onDelete: () => void
  onEdit: () => void
  routeTargets: TeamMailRouteTarget[]
  onRoute?: (sessionId: string) => void
}) {
  useLocale()
  const card = <article className="network-v2-bulletin-card">
    <button
      type="button"
      className="network-v2-bulletin-open"
      onClick={onOpen}
    >
      {message.title && <strong className="network-v2-bulletin-title">{message.title}</strong>}
      <span className="network-v2-bulletin-body">{messagePreview(message)}</span>
      {message.attachments.length > 0 && <AnnouncementMediaPreview attachments={message.attachments} scope={scope} />}
    </button>
    <footer className="network-v2-bulletin-footer">
      <span className="network-v2-avatar"><Server size={15} /></span>
      <span><strong>{message.sender.display_name}</strong><small>{message.revision && message.revision.version > 1 ? t('teamNetwork.mail.editedVersion', { version: message.revision.version }) : formatDate(message.created_at)}</small></span>
      <span className="network-v2-tag">{message.kind === 'skill' ? t('teamNetwork.mail.skill') : t('teamNetwork.mail.announcement')}</span>
      {onRoute && <span className="network-v2-message-actions"><MessageRouteMenu message={message} routeTargets={routeTargets} onRoute={onRoute} menuLabel={t('teamNetwork.mail.openBulletinChat')} /></span>}
    </footer>
  </article>
  return <ContextMenu.Root><ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="menu-content">
    <ContextMenu.Item className="menu-item" onSelect={onOpen}><Mail size={14} />{t('teamNetwork.mail.openBulletinItem')}</ContextMenu.Item>
    {canEdit && <ContextMenu.Item className="menu-item" onSelect={onEdit}><Pencil size={14} />{t('teamNetwork.mail.editBulletinMenu')}</ContextMenu.Item>}
    {canDelete && <><ContextMenu.Separator className="menu-separator" /><ContextMenu.Item className="menu-item danger" onSelect={onDelete}><Trash2 size={14} />{t('teamNetwork.mail.deleteBulletinMenu')}</ContextMenu.Item></>}
  </ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
}

function LegacyBulletinCard({ bulletin, canDelete, onDelete }: {
  bulletin: TeamNetworkBulletinPost
  canDelete: boolean
  onDelete: () => void
}) {
  useLocale()
  const card = <article className="network-v2-bulletin-card legacy">
    <div className="network-v2-bulletin-open">
      <span className="network-v2-bulletin-body">{bulletin.body}</span>
    </div>
    <footer className="network-v2-bulletin-footer">
      <span className="network-v2-avatar"><FileText size={15} /></span>
      <span><strong>{bulletin.author.display_name}</strong><small>{formatDate(bulletin.created_at)}</small></span>
      <span className="network-v2-tag">{t('teamNetwork.mail.announcement')}</span>
      {canDelete && <button type="button" className="network-v2-bulletin-delete" aria-label={t('teamNetwork.mail.deleteLegacyAnnouncement', { sender: bulletin.author.display_name })} title={t('teamNetwork.mail.deleteAnnouncement')} onClick={onDelete}><Trash2 size={14} /></button>}
    </footer>
  </article>
  if (!canDelete) return card
  return <ContextMenu.Root><ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="menu-content">
    <ContextMenu.Item className="menu-item danger" onSelect={onDelete}><Trash2 size={14} />{t('teamNetwork.mail.deleteBulletinMenu')}</ContextMenu.Item>
  </ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
}

function AnnouncementMediaPreview({ attachments, scope }: { attachments: TeamAttachment[]; scope: TeamHubScope }) {
  useLocale()
  const primary = attachments.find(attachment => attachmentKind(attachment.file_name, attachment.media_type) === 'Image')
    ?? attachments.find(attachment => attachmentKind(attachment.file_name, attachment.media_type) === 'Video')
    ?? attachments[0]
  const kind = attachmentKind(primary.file_name, primary.media_type)
  const visualKind = kind === 'Image' ? 'image' : kind === 'Video' ? 'video' : null
  const [url, setURL] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const host = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    let active = true
    let observer: IntersectionObserver | null = null
    setURL(null)
    setLoading(false)
    if (!visualKind || primary.state !== 'ready') return () => { active = false }
    const load = async () => {
      setLoading(true)
      try {
        const result = await window.agentsDock.teamHub.cacheTeamAttachment(scope, {
          teamId: primary.team_id,
          attachmentId: primary.id
        })
        if (active) setURL(result.media_url)
      } catch {
        // Keep the compact file summary as the fallback when preview caching fails.
      } finally {
        if (active) setLoading(false)
      }
    }
    if (host.current && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        observer?.disconnect()
        observer = null
        void load()
      }, { rootMargin: '160px' })
      observer.observe(host.current)
    } else {
      void load()
    }
    return () => {
      active = false
      observer?.disconnect()
    }
  }, [primary.id, primary.state, primary.team_id, scope.generation, scope.hubIdentity, scope.profileGeneration, scope.profileId, scope.serverIdentity, visualKind])
  return <span ref={host} className={`network-v2-bulletin-media ${kind.toLocaleLowerCase()}${url ? ' preview' : ''}`} aria-label={attachmentCountLabel(attachments)}>
    {url && visualKind === 'image' && <img src={url} alt={primary.file_name} loading="lazy" />}
    {url && visualKind === 'video' && <video src={url} muted playsInline preload="auto" aria-label={primary.file_name} />}
    {!url && loading && <LoaderCircle className="spin" size={25} />}
    {!url && !loading && attachmentIcon(primary.file_name, primary.media_type)}
    <span className={url ? 'network-v2-bulletin-media-caption' : undefined}><strong>{primary.file_name}</strong><small>{attachmentKindLabel(kind)}{attachments.length > 1 ? t('teamNetwork.mail.moreAttachments', { count: attachments.length - 1 }) : ''}</small></span>
  </span>
}

function MessageDeleteDialog({ target, variant, busy, error, onCancel, onConfirm }: {
  target: BulletinDeleteTarget
  variant: 'bulletin' | 'mail'
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useLocale()
  const cancel = useRef<HTMLButtonElement | null>(null)
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onCancel() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="network-v2-delete-backdrop" />
      <Dialog.Content
        className="network-v2-delete-dialog"
        role="alertdialog"
        aria-describedby="network-v2-delete-description"
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onPointerDownOutside={event => { if (busy) event.preventDefault() }}
        onOpenAutoFocus={event => {
          event.preventDefault()
          cancel.current?.focus()
        }}
      >
        <span className="network-v2-delete-icon"><Trash2 size={18} /></span>
        <div>
          <Dialog.Title>{variant === 'bulletin' ? t('teamNetwork.mail.deleteBulletinQuestion') : t('teamNetwork.mail.deleteEveryoneQuestion')}</Dialog.Title>
          <Dialog.Description id="network-v2-delete-description">{t(variant === 'bulletin' ? 'teamNetwork.mail.deleteBulletinDescription' : 'teamNetwork.mail.deleteMailDescription', { attachments: target.attachmentCount > 0 ? t(target.attachmentCount === 1 ? 'teamNetwork.mail.disableOneAttachment' : 'teamNetwork.mail.disableAttachments', { count: target.attachmentCount }) : '' })}{target.skillAnnouncement ? t('teamNetwork.mail.keepSkillHistory') : ''}</Dialog.Description>
        </div>
        {error && <p className="network-v2-delete-error" role="alert">{localizeMailError(error)}</p>}
        <footer>
          <button ref={cancel} type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t('teamNetwork.mail.cancel')}</button>
          <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{busy ? t('teamNetwork.mail.deleting') : variant === 'bulletin' ? t('teamNetwork.mail.deleteItem') : t('teamNetwork.mail.deleteEveryone')}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function BulletinEditDialog({ summary, scope, teamId, onCancel, onSaved }: {
  summary: TeamMessageSummary
  scope: TeamHubScope
  teamId: string
  onCancel: () => void
  onSaved: (message: TeamMessage) => void
}) {
  useLocale()
  const [message, setMessage] = useState<TeamMessage | null>(null)
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = useRef<HTMLButtonElement | null>(null)
  const scopeKey = JSON.stringify(scope)
  const editDraftKey = `agentsdock:team-bulletin-edit:${feedDraftKey(scope, teamId, `${summary.sender.kind}:${summary.sender.id}`)}:${summary.id}`
  const savedDraft = useRef(readBulletinEditDraft(editDraftKey))
  const attempt = useRef<{ body: string; expectedVersion: number; key: string } | null>(savedDraft.current?.attempt ?? null)
  const [retryLocked, setRetryLocked] = useState(Boolean(attempt.current))
  const [reload, setReload] = useState(0)
  const [conflict, setConflict] = useState(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.agentsDock.teamHub.teamMessage(scope, teamId, summary.id).then(value => {
      if (!active) return
      if (!value.revision) throw new Error('This server does not support Bulletin revisions yet.')
      setMessage(value)
      if (reload === 0) setBody(savedDraft.current?.body ?? value.body)
    }).catch(cause => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scopeKey, summary.id, teamId, reload])
  useEffect(() => {
    if (message) writeBulletinEditDraft(editDraftKey, { body, attempt: attempt.current })
  }, [body, editDraftKey, message, retryLocked])
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!message?.revision || saving || conflict || !body.trim() || (!retryLocked && body === message.body)) return
    setSaving(true)
    setError(null)
    const pending = attempt.current ?? { body, expectedVersion: message.revision.version, key: crypto.randomUUID() }
    attempt.current = pending
    setRetryLocked(true)
    writeBulletinEditDraft(editDraftKey, { body, attempt: pending })
    try {
      const revised = await window.agentsDock.teamHub.reviseTeamMessage(scope, {
        teamId,
        messageId: message.id,
        body: pending.body,
        bodyFormat: message.body_format,
        expectedVersion: pending.expectedVersion,
        idempotencyKey: pending.key
      })
      deleteSavedDraft(editDraftKey)
      onSaved(revised)
    } catch (cause) {
      const text = errorMessage(cause)
      setError(text)
      if (/version_conflict|message changed|reload it before editing/i.test(text)) setConflict(true)
    } finally {
      setSaving(false)
    }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onCancel() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="network-v2-delete-backdrop" />
      <Dialog.Content
        className="network-v2-edit-dialog"
        aria-describedby="network-v2-edit-description"
        onEscapeKeyDown={event => { if (saving) event.preventDefault() }}
        onPointerDownOutside={event => { if (saving) event.preventDefault() }}
      >
        <Dialog.Title>{t('teamNetwork.mail.editBulletin')}</Dialog.Title>
        <Dialog.Description id="network-v2-edit-description">{message?.revision ? t('teamNetwork.mail.versionPreserved', { version: message.revision.version }) : t('teamNetwork.mail.loadingCurrentVersion')}</Dialog.Description>
        {loading && <div className="network-v2-edit-loading" role="status"><LoaderCircle className="spin" size={14} />{t('teamNetwork.mail.loading')}</div>}
        {error && !message && <p role="alert">{localizeMailError(error)}</p>}
        {message && <form onSubmit={save}>
          <textarea aria-label={t('teamNetwork.mail.bulletinMessage')} value={body} disabled={saving || retryLocked} autoFocus onChange={event => setBody(event.target.value)} />
          {error && <p role="alert">{localizeMailError(error)}</p>}
          {retryLocked && !conflict && <p role="status">{t('teamNetwork.mail.uncertainEdit')}</p>}
          {conflict && <p role="status">{t('teamNetwork.mail.editConflict')}</p>}
          <footer>
            <button ref={cancel} type="button" className="quiet-button" disabled={saving} onClick={onCancel}>{t('teamNetwork.mail.cancel')}</button>
            {conflict && <button type="button" className="quiet-button" disabled={saving || loading} onClick={() => {
              attempt.current = null; setRetryLocked(false); setConflict(false); setReload(value => value + 1)
            }}>{t('teamNetwork.mail.reloadVersion')}</button>}
            <button type="submit" className="primary-button" disabled={saving || loading || conflict || !body.trim() || (!retryLocked && body === message.body)}>{saving ? <LoaderCircle className="spin" size={14} /> : <Pencil size={14} />}{saving ? t('teamNetwork.mail.saving') : retryLocked ? t('teamNetwork.mail.retrySave') : t('teamNetwork.mail.saveVersion', { version: message.revision!.version + 1 })}</button>
          </footer>
        </form>}
        {!loading && !message && <footer><button ref={cancel} type="button" className="quiet-button" onClick={onCancel}>{t('teamNetwork.mail.close')}</button></footer>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function TeamSkills({ scope, teamId, capability, canWrite }: {
  scope: TeamHubScope
  teamId: string
  capability: TeamMessagesCapability
  canWrite: boolean
}) {
  useLocale()
  const [skills, setSkills] = useState<TeamSkill[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const page = await window.agentsDock.teamHub.teamSkills(scope, { teamId, includeArchived: true })
      if (request.current === id) setSkills(sortSkills(page.skills))
    } catch (cause) {
      if (request.current === id) setError(errorMessage(cause))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }, [scope, teamId])
  useEffect(() => { void load(); return () => { request.current += 1 } }, [load])
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return skills.filter(skill => !needle || `${skill.title} ${skill.slug} ${skill.summary} ${skill.tags.join(' ')}`.toLocaleLowerCase().includes(needle))
  }, [query, skills])
  const replaceSkill = useCallback((skill: TeamSkill) => {
    setSkills(current => sortSkills(current.map(item => item.id === skill.id ? skill : item)))
  }, [])

  if (selectedId) {
    return <SkillDetail
      scope={scope}
      teamId={teamId}
      skillId={selectedId}
      capability={capability}
      canWrite={canWrite}
      onBack={() => setSelectedId(null)}
      onChanged={replaceSkill}
    />
  }
  return <section className="network-v2-surface" aria-label={t('teamNetwork.mail.teamSkills')}>
    <SurfaceHeader icon={<BookOpenCheck size={20} />} title={t('teamNetwork.mail.skills')} description={t('teamNetwork.mail.skillsDescription')} loading={loading} onRefresh={load}>
      <label className="network-v2-search"><Search size={14} /><span className="sr-only">{t('teamNetwork.mail.filterSkills')}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('teamNetwork.mail.filterSkills')} /></label>
    </SurfaceHeader>
    {error && <InlineError message={error} onRetry={load} />}
    <div className="network-v2-scroll network-v2-skill-grid">
      {!loading && visible.length === 0 && <EmptyState icon={<BookOpenCheck size={23} />} title={query ? t('teamNetwork.mail.noMatchingSkills') : t('teamNetwork.mail.emptySkills')} body={query ? t('teamNetwork.mail.filterSkillsHelp') : t('teamNetwork.mail.publishSkillHelp')} />}
      {visible.map(skill => <button type="button" className={`network-v2-skill-card ${skill.archived_at ? 'archived' : ''}`} key={skill.id} onClick={() => setSelectedId(skill.id)}>
        <span className="network-v2-skill-top"><span className="network-v2-avatar"><BookOpenCheck size={16} /></span><span><strong>{skill.title}</strong><code>/{skill.slug}</code></span>{skill.pinned_at && <Pin size={14} fill="currentColor" aria-label={t('teamNetwork.mail.pinned')} />}</span>
        <span>{skill.summary || t('teamNetwork.mail.noSummary')}</span>
        <span className="network-v2-skill-footer"><span>{t('teamNetwork.mail.version', { version: skill.version })}</span>{skill.archived && <b>{t('teamNetwork.mail.archived')}</b>}{skill.tags.slice(0, 2).map(tag => <i key={tag}>{tag}</i>)}</span>
      </button>)}
    </div>
  </section>
}

function SkillDetail({ scope, teamId, skillId, capability, canWrite, onBack, onChanged }: {
  scope: TeamHubScope
  teamId: string
  skillId: string
  capability: TeamMessagesCapability
  canWrite: boolean
  onBack: () => void
  onChanged: (skill: TeamSkill) => void
}) {
  useLocale()
  const [details, setDetails] = useState<TeamSkillDetails | null>(null)
  const [versions, setVersions] = useState<TeamSkillVersionSummary[]>([])
  const [shownVersion, setShownVersion] = useState<TeamSkillVersion | TeamSkillDetails | null>(null)
  const [editing, setEditing] = useState(false)
  const [files, setFiles] = useState<NativeFileRef[]>([])
  const [busy, setBusy] = useState<string | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  const chooserContextKey = JSON.stringify([scope, teamId, skillId])
  const chooserContext = useRef(chooserContextKey)
  chooserContext.current = chooserContextKey
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const load = useCallback(async () => {
    const id = ++request.current
    setBusy('loading')
    setError(null)
    try {
      const [next, history] = await Promise.all([
        window.agentsDock.teamHub.teamSkill(scope, teamId, skillId),
        window.agentsDock.teamHub.teamSkillVersions(scope, { teamId, skillId })
      ])
      if (request.current !== id) return
      setDetails(next)
      setShownVersion(next)
      setVersions(history.versions)
      onChanged(next)
    } catch (cause) {
      if (request.current === id) setError(errorMessage(cause))
    } finally {
      if (request.current === id) setBusy(null)
    }
  }, [onChanged, scope, skillId, teamId])
  useEffect(() => { void load(); return () => { request.current += 1 } }, [load])
  const mutate = async (kind: 'pin' | 'archive', value: boolean) => {
    if (!details || !canWrite || !details.permissions.manage) return
    setBusy(kind)
    setError(null)
    try {
      const skill = kind === 'pin'
        ? await window.agentsDock.teamHub.pinTeamSkill(scope, { teamId, skillId, pinned: value, idempotencyKey: crypto.randomUUID() })
        : await window.agentsDock.teamHub.archiveTeamSkill(scope, { teamId, skillId, archived: value, idempotencyKey: crypto.randomUUID() })
      setDetails(current => current ? { ...current, ...skill } : current)
      onChanged(skill)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(null) }
  }
  const chooseFiles = async () => {
    const expectedContext = chooserContextKey
    try {
      const selected = await window.agentsDock.files.choose()
      if (mounted.current && chooserContext.current === expectedContext) setFiles(selected)
    } catch (cause) {
      if (mounted.current && chooserContext.current === expectedContext) setError(errorMessage(cause))
    }
  }
  const saveVersion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!details || !canWrite) return
    const form = new FormData(event.currentTarget)
    setBusy('save')
    setError(null)
    try {
      if (files.length > capability.attachments.max_files_per_message) throw new Error(`Choose no more than ${capability.attachments.max_files_per_message} attachments.`)
      const body = String(form.get('body') ?? '')
      const bodyBytes = new TextEncoder().encode(body).byteLength
      if (bodyBytes < 1 || bodyBytes > capability.max_body_bytes) throw new Error(`Skill Markdown must be between 1 and ${capability.max_body_bytes} bytes.`)
      const tags = formValue(form, 'tags').split(',').map(tag => tag.trim()).filter(Boolean)
      if (tags.length > capability.skills.max_tags || tags.some(tag => !TEAM_SKILL_TAG_PATTERN.test(tag)) || new Set(tags).size !== tags.length) {
        throw new Error(`Use up to ${capability.skills.max_tags} unique lowercase skill tags.`)
      }
      let knownAttachmentBytes = 0
      for (const file of files) {
        if (file.size === undefined) continue
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > capability.attachments.max_bytes_per_file) {
          throw new Error(`${file.name} exceeds the per-file attachment limit.`)
        }
        knownAttachmentBytes += file.size
      }
      if (knownAttachmentBytes > capability.attachments.max_bytes_per_message) {
        throw new Error('The selected attachments exceed the per-message attachment limit.')
      }
      const attachmentIds: string[] = []
      for (const file of files) {
        const declaration = await window.agentsDock.teamHub.declareTeamAttachment(scope, {
          teamId,
          path: file.path,
          fileName: file.name,
          mediaType: file.type || undefined,
          idempotencyKey: crypto.randomUUID()
        })
        await window.agentsDock.teamHub.uploadTeamAttachment(scope, { teamId, attachmentId: declaration.attachment.id, path: file.path })
        attachmentIds.push(declaration.attachment.id)
      }
      await window.agentsDock.teamHub.createTeamMessage(scope, {
        teamId,
        kind: 'skill',
        title: formValue(form, 'title'),
        body,
        bodyFormat: 'markdown',
        recipients: [{ kind: 'all' }],
        attachmentIds,
        skill: {
          slug: details.slug,
          summary: formValue(form, 'summary'),
          tags,
          change_note: formValue(form, 'changeNote'),
          expected_version: details.version
        },
        provenance: { via: 'desktop' },
        idempotencyKey: crypto.randomUUID()
      })
      setEditing(false)
      setFiles([])
      await load()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(null) }
  }
  const selectVersion = async (version: number) => {
    if (!details || version === details.version) { setShownVersion(details); return }
    setBusy('version')
    setError(null)
    try { setShownVersion(await window.agentsDock.teamHub.teamSkillVersion(scope, teamId, skillId, version)) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(null) }
  }

  return <section className="network-v2-surface" aria-label={details?.title || t('teamNetwork.mail.teamSkill')}>
    <header className="network-v2-detail-header"><button type="button" className="quiet-button" autoFocus onClick={onBack}><ArrowLeft size={14} />{t('teamNetwork.mail.skills')}</button>{details && <><div><span className="network-v2-avatar"><BookOpenCheck size={18} /></span><span><h1>{shownVersion?.title ?? details.title}</h1><p>{t('teamNetwork.mail.skillVersion', { slug: details.slug, version: shownVersion?.version ?? details.version })}</p></span></div>{canWrite && <div className="network-v2-detail-actions">{details.permissions.manage && <><button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => void mutate('pin', !details.pinned)}><Pin size={13} fill={details.pinned ? 'currentColor' : 'none'} />{details.pinned ? t('teamNetwork.mail.unpin') : t('teamNetwork.mail.pin')}</button><button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => void mutate('archive', !details.archived)}>{details.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{details.archived ? t('teamNetwork.mail.restore') : t('teamNetwork.mail.archive')}</button></>}{details.permissions.edit && !details.archived && <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => setEditing(value => !value)}>{t('teamNetwork.mail.edit')}</button>}</div>}</>}</header>
    {error && <InlineError message={error} onRetry={load} />}
    {busy === 'loading' && <div className="network-v2-loading"><LoaderCircle className="spin" size={17} />{t('teamNetwork.mail.loadingSkill')}</div>}
    {details && canWrite && details.permissions.edit && editing && <form className="network-v2-skill-editor" onSubmit={saveVersion}><div><label>{t('teamNetwork.mail.title')}<input required name="title" maxLength={160} defaultValue={details.title} /></label><label>{t('teamNetwork.mail.summary')}<input name="summary" maxLength={280} defaultValue={details.summary} /></label></div><label>{t('teamNetwork.mail.tags')}<input name="tags" defaultValue={details.tags.join(', ')} placeholder={t('teamNetwork.mail.tagsPlaceholder')} /></label><label>{t('teamNetwork.mail.changeNote')}<input name="changeNote" maxLength={280} placeholder={t('teamNetwork.mail.whatChanged')} /></label><label>{t('teamNetwork.mail.markdown')}<textarea required name="body" defaultValue={details.body} /></label><div className="network-v2-editor-files"><button type="button" className="quiet-button" onClick={() => void chooseFiles()}><Paperclip size={13} />{t('teamNetwork.mail.chooseAttachments')}</button>{files.map(file => <span key={file.path}>{file.name}</span>)}</div><div><button className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <LoaderCircle className="spin" size={13} />}{t('teamNetwork.mail.postVersion', { version: details.version + 1 })}</button><button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => { setEditing(false); setFiles([]) }}>{t('teamNetwork.mail.cancel')}</button></div></form>}
    {details && (!editing || !canWrite) && <div className="network-v2-skill-layout">
      <aside><strong>{t('teamNetwork.mail.versions')}</strong>{versions.map(version => <button type="button" className={shownVersion?.version === version.version ? 'active' : ''} key={version.message_id} disabled={busy === 'version'} onClick={() => void selectVersion(version.version)}><span>v{version.version}</span><small>{version.change_note || formatDate(version.created_at)}</small></button>)}</aside>
      <div className="network-v2-scroll network-v2-skill-document"><div className="network-v2-skill-summary">{shownVersion?.summary || t('teamNetwork.mail.noSummary')}{shownVersion?.tags.map(tag => <span className="network-v2-tag" key={tag}>{tag}</span>)}</div>{shownVersion && <><TeamMessageBody format={shownVersion.body_format} body={shownVersion.body} />{shownVersion.attachments.length > 0 && <AttachmentCollection attachments={shownVersion.attachments} scope={scope} />}</>}</div>
    </div>}
  </section>
}

function AttachmentCollection({ attachments, scope }: { attachments: TeamAttachment[]; scope: TeamHubScope }) {
  useLocale()
  return <section className="network-v2-attachments" aria-label={attachmentCountLabel(attachments)}><header><Paperclip size={14} /><strong>{t('teamNetwork.mail.attachments')}</strong><span>{attachments.length}</span></header><div>{attachments.map(attachment => <AttachmentView key={attachment.id} attachment={attachment} scope={scope} />)}</div></section>
}

function AttachmentView({ attachment, scope }: { attachment: TeamAttachment; scope: TeamHubScope }) {
  useLocale()
  const [url, setURL] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [textTruncated, setTextTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  useEffect(() => {
    request.current += 1
    setURL(null)
    setText(null)
    setTextTruncated(false)
    setError(null)
    setLoading(false)
    return () => { request.current += 1 }
  }, [attachment.id, attachment.team_id, scope.generation, scope.hubIdentity, scope.profileGeneration, scope.profileId, scope.serverIdentity])
  const load = async () => {
    if (attachment.state !== 'ready' || loading || url) return
    const id = ++request.current
    const textAttachment = teamAttachmentSupportsTextPreview(attachment)
    setLoading(true)
    setError(null)
    try {
      const result = await window.agentsDock.teamHub.cacheTeamAttachment(scope, {
        teamId: attachment.team_id,
        attachmentId: attachment.id,
        ...(textAttachment ? { previewBytes: TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES } : {})
      })
      let nextText: string | null = null
      let nextTextTruncated = false
      if (textAttachment) {
        const expectedPreviewBytes = Math.min(attachment.byte_size, TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES)
        if (
          !result.text_preview
          || typeof result.text_preview.text !== 'string'
          || result.text_preview.byte_size !== expectedPreviewBytes
          || result.text_preview.truncated !== (attachment.byte_size > expectedPreviewBytes)
        ) {
          throw new Error('Attachment preview was not returned by the desktop service.')
        }
        nextText = result.text_preview.text
        nextTextTruncated = result.text_preview.truncated
      }
      if (request.current !== id) return
      setURL(result.media_url)
      setText(nextText)
      setTextTruncated(nextTextTruncated)
    } catch (cause) {
      if (request.current === id) setError(errorMessage(cause))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }
  const canLoad = attachment.state === 'ready'
  const normalizedMediaType = attachment.media_type.toLowerCase()
  const visualKind = normalizedMediaType.startsWith('image/') ? 'image' : normalizedMediaType.startsWith('video/') ? 'video' : null
  const loadLabel = error ? t('teamNetwork.mail.retryLoadAttachment', { name: attachment.file_name }) : t('teamNetwork.mail.loadNamedAttachment', { name: attachment.file_name })
  return <article className="network-v2-attachment">
    <header><span>{teamAttachmentSupportsTextPreview(attachment) ? <FileText size={15} /> : attachmentIcon(attachment.file_name, attachment.media_type)}</span><div><strong>{attachment.file_name}</strong><small>{attachment.media_type} · {formatBytes(attachment.byte_size)}</small></div>{url
      ? <a href={url} download={attachment.file_name} aria-label={t('teamNetwork.mail.downloadNamedAttachment', { name: attachment.file_name })} title={t('teamNetwork.mail.downloadAttachment')}><Download size={14} /></a>
      : !visualKind && <button type="button" className="network-v2-attachment-load" aria-label={loadLabel} title={canLoad ? t('teamNetwork.mail.loadAttachment') : t('teamNetwork.mail.attachmentNotReady')} disabled={!canLoad || loading} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}</button>}</header>
    {loading && !visualKind && <div className="network-v2-attachment-loading"><LoaderCircle className="spin" size={14} />{t('teamNetwork.mail.caching')}</div>}
    {error && <p role="alert">{localizeMailError(error)}</p>}
    {!url && visualKind && <button
      type="button"
      className="network-v2-media-load"
      aria-label={t(error ? 'teamNetwork.mail.retryNamedMedia' : 'teamNetwork.mail.showNamedMedia', { kind: mediaKindLabel(visualKind), name: attachment.file_name })}
      disabled={!canLoad || loading}
      onClick={() => void load()}
    >{loading ? <LoaderCircle className="spin" size={22} /> : visualKind === 'image' ? <ImageIcon size={24} /> : <Film size={24} />}<span>{loading ? t('teamNetwork.mail.loadingMedia', { kind: mediaKindLabel(visualKind) }) : error ? t('teamNetwork.mail.retryMedia', { kind: mediaKindLabel(visualKind) }) : t('teamNetwork.mail.showMedia', { kind: mediaKindLabel(visualKind) })}</span></button>}
    {url && visualKind === 'image' && <img src={url} alt={attachment.file_name} loading="lazy" />}
    {url && visualKind === 'video' && <video src={url} controls preload="metadata" aria-label={attachment.file_name} />}
    {textTruncated && <p className="network-v2-attachment-truncated">{t('teamNetwork.mail.truncatedPreview', { size: formatBytes(TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES) })}</p>}
    {text !== null && (normalizedMediaType === 'text/markdown' || /\.md$/i.test(attachment.file_name)) && <div className="network-v2-attachment-markdown"><MarkdownContent text={text} fold={false} /></div>}
    {text !== null && normalizedMediaType !== 'text/markdown' && !/\.md$/i.test(attachment.file_name) && <pre>{text}</pre>}
  </article>
}

function useTeamNetworkDeletionJournal(scope: TeamHubScope, teamId: string): {
  keys: ReadonlySet<string>
  supported: boolean
  refresh: () => Promise<void>
} {
  const [keys, setKeys] = useState<Set<string>>(() => new Set())
  const [supported, setSupported] = useState(false)
  const generation = useRef(0)
  const afterSequence = useRef(0)
  const inFlight = useRef(false)
  const unavailable = useRef(false)
  const scopeKey = JSON.stringify(scope)

  const read = useCallback(async () => {
    if (inFlight.current || unavailable.current || typeof window.agentsDock.teamHub.networkDeletions !== 'function') return
    const request = generation.current
    inFlight.current = true
    try {
      let cursor = afterSequence.current
      const collected: TeamNetworkDeletion[] = []
      for (let pageNumber = 0; pageNumber < MAX_CATCH_UP_PAGES_PER_REQUEST; pageNumber += 1) {
        const result = await window.agentsDock.teamHub.networkDeletions(scope, {
          teamId,
          afterSequence: cursor,
          limit: TEAM_MESSAGES_PAGE_SIZE
        })
        if (generation.current !== request) return
        if (!result.supported) {
          unavailable.current = true
          setSupported(false)
          return
        }
        const page = result.page
        setSupported(true)
        collected.push(...page.deletions)
        cursor = page.next_after_sequence
        if (!page.has_more) break
      }
      if (generation.current !== request) return
      afterSequence.current = cursor
      if (collected.length) setKeys(current => {
        let next: Set<string> | null = null
        for (const deletion of collected) {
          const key = `${deletion.kind}:${deletion.id}`
          if (current.has(key)) continue
          if (!next) next = new Set(current)
          next.add(key)
        }
        return next ?? current
      })
    } catch {
      // Deletion journals are additive. Older Hubs can omit the endpoint, and
      // a transient journal failure must never hide the rest of the Bulletin.
    } finally {
      if (generation.current === request) inFlight.current = false
    }
  }, [scopeKey, teamId])

  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    afterSequence.current = 0
    unavailable.current = false
    setKeys(new Set())
    setSupported(false)
    if (typeof window.agentsDock.teamHub.networkDeletions !== 'function') return
    void read()
    return () => {
      generation.current += 1
      inFlight.current = false
      unavailable.current = true
    }
  }, [read])

  return { keys, supported, refresh: read }
}

type MessageQuery = TeamMessagesSnapshotQuery

function useTeamMessages(
  scope: TeamHubScope,
  query: MessageQuery,
  enabled = true,
  initialLoad: TeamFeedInitialLoad | null = null,
  retainMessage: (message: TeamMessageSummary) => boolean = retainEveryMessage,
  lifecycleCacheKey = JSON.stringify(scope)
) {
  const [initialSnapshot] = useState(() => enabled
    ? peekTeamMessagesSnapshot(lifecycleCacheKey, query)
    : null)
  const [messages, setMessages] = useState<TeamMessageSummary[]>(initialSnapshot?.messages ?? [])
  const messagesRef = useRef<TeamMessageSummary[]>(initialSnapshot?.messages ?? [])
  const [nextAfter, setNextAfter] = useState<number | null>(initialSnapshot?.nextAfter ?? null)
  const nextAfterRef = useRef<number | null>(initialSnapshot?.nextAfter ?? null)
  const [hasMore, setHasMore] = useState(initialSnapshot?.hasMore ?? false)
  const hasMoreRef = useRef(initialSnapshot?.hasMore ?? false)
  const [loading, setLoading] = useState(enabled && !initialSnapshot)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const inFlightGeneration = useRef<number | null>(null)
  const receiptReconcileGeneration = useRef<number | null>(null)
  const receiptReconcileOffset = useRef(0)
  const latestSequence = useRef(initialSnapshot?.latestSequence ?? 0)
  // Cache rows/sequence maxima are not coverage. Only a fresh, validated page
  // in this exact stream can supply the immutable next-page predecessor.
  const mailCoverageContinuation = useRef<{ scope: Readonly<MailHintScope>; cursor: Readonly<MailArrivalCursor> } | null>(null)
  const queryKey = JSON.stringify(query)
  const scopeKey = JSON.stringify(scope)
  const persistSnapshot = useCallback(() => {
    writeTeamMessagesSnapshot(lifecycleCacheKey, query, {
      messages: messagesRef.current,
      nextAfter: nextAfterRef.current,
      hasMore: hasMoreRef.current,
      latestSequence: latestSequence.current
    })
  }, [lifecycleCacheKey, queryKey])
  const fetchPage = useCallback(async (
    afterSequence?: number,
    append = false,
    quiet = false,
    updateBacklog = !quiet,
    prefetchedLoad: TeamFeedInitialLoad | null = null
  ) => {
    if (!enabled) {
      messagesRef.current = []
      nextAfterRef.current = null
      hasMoreRef.current = false
      setMessages([])
      setLoading(false)
      setHasMore(false)
      return
    }
    const generation = requestGeneration.current
    if (inFlightGeneration.current === generation) return
    inFlightGeneration.current = generation
    if (!quiet) append ? setLoadingMore(true) : setLoading(true)
    if (!quiet) setError(null)
    try {
      let cursor = afterSequence
      const hintScope = retainMessage === retainEveryMessage ? captureMailHintScope(scope, query) : null
      const continuation = mailCoverageContinuation.current
      let requestedAfter: Readonly<MailArrivalCursor> | null = hintScope
        ? cursor == null
          ? Object.freeze({ through_sequence: 0, arrival_id: null })
          : continuation && continuation.cursor.through_sequence === cursor && sameMailHintScope(continuation.scope, hintScope)
            ? continuation.cursor : null
        : null
      let preserveCurrent = append || quiet
      const prefetched = prefetchedLoad ? await prefetchedLoad : null
      if (requestGeneration.current !== generation) return
      if (prefetched?.state === 'error') throw new Error(prefetched.message)
      for (let pageNumber = 0; pageNumber < MAX_CATCH_UP_PAGES_PER_REQUEST; pageNumber += 1) {
        const isPrefetched = pageNumber === 0 && prefetched?.state === 'ready'
        const page = isPrefetched
          ? prefetched.page
          : await window.agentsDock.teamHub.teamMessages(scope, {
            ...query,
            ...(cursor == null ? {} : { afterSequence: cursor }),
            ...(hintScope && requestedAfter ? {
              includeMailboxCoverage: true,
              afterSequence: requestedAfter.through_sequence,
              ...(requestedAfter.arrival_id ? { afterArrivalId: requestedAfter.arrival_id } : {})
            } : {}),
            limit: TEAM_MESSAGES_PAGE_SIZE
          })
        if (requestGeneration.current !== generation) return
        const observedSequence = Math.max(
          page.next_after_sequence ?? 0,
          ...page.messages.map(message => message.sequence)
        )
        latestSequence.current = Math.max(latestSequence.current, observedSequence)
        const retainedById = new Map(messagesRef.current.map(message => [message.id, message]))
        const next = mergeMessages(preserveCurrent ? messagesRef.current : [], page.messages.filter(retainMessage)
          .map(message => keepNewestMailboxState(message, retainedById.get(message.id))))
        messagesRef.current = next
        setMessages(next)
        preserveCurrent = true
        // Live polling has its own forward cursor. It must not erase the
        // continuation for a capped initial/history fetch when a quiet poll
        // happens to return an empty page.
        if (updateBacklog) {
          nextAfterRef.current = page.next_after_sequence
          hasMoreRef.current = page.has_more
          setNextAfter(page.next_after_sequence)
          setHasMore(page.has_more)
        }
        persistSnapshot()
        const currentHintScope = captureMailHintScope(scope, query)
        let coverage: MailboxCoverage | null = null
        if (!isPrefetched && hintScope && requestedAfter && currentHintScope && sameMailHintScope(hintScope, currentHintScope)) {
          try {
            const parsed = parseMailboxCoverage(page.mailbox_coverage)
            if (parsed.team_id === hintScope.teamId && parsed.recipient_server_id === hintScope.recipientServerId
              && parsed.through_sequence >= requestedAfter.through_sequence
              && (parsed.through_sequence !== requestedAfter.through_sequence || parsed.arrival_id === requestedAfter.arrival_id)) coverage = parsed
          } catch { /* Older/unnegotiated servers provide no acknowledgement proof. */ }
        }
        if (coverage && hintScope && requestedAfter) {
          // Rows have passed the request-generation fence and been applied.
          // This optional IPC only persists local seen metadata; no receipts.
          void acknowledgeMailHintPage(hintScope, requestedAfter, coverage)
        }
        requestedAfter = coverage && coverage.through_sequence === page.next_after_sequence
          ? Object.freeze({ through_sequence: coverage.through_sequence, arrival_id: coverage.arrival_id }) : null
        mailCoverageContinuation.current = requestedAfter && hintScope ? { scope: hintScope, cursor: requestedAfter } : null
        if (!page.has_more || page.next_after_sequence == null) break
        cursor = page.next_after_sequence
      }
    } catch (cause) {
      if (requestGeneration.current === generation && !quiet) setError(errorMessage(cause))
    } finally {
      if (inFlightGeneration.current === generation) inFlightGeneration.current = null
      if (requestGeneration.current === generation) { setLoading(false); setLoadingMore(false) }
    }
  }, [enabled, persistSnapshot, queryKey, retainMessage, scopeKey])
  const reconcileReceiptStates = useCallback(async () => {
    if (!enabled || query.box !== 'inbox' || messagesRef.current.length === 0) return
    const generation = requestGeneration.current
    if (receiptReconcileGeneration.current === generation) return
    receiptReconcileGeneration.current = generation
    const retained = messagesRef.current
    const start = receiptReconcileOffset.current % retained.length
    const batch = [...retained.slice(start), ...retained.slice(0, start)]
      .slice(0, MAX_RECEIPT_RECONCILE_MESSAGES)
    receiptReconcileOffset.current = (start + batch.length) % retained.length
    try {
      const refreshed = await Promise.allSettled(batch.map(message => (
        window.agentsDock.teamHub.teamMessage(scope, query.teamId, message.id)
      )))
      if (requestGeneration.current !== generation) return
      const replacements = new Map<string, Pick<TeamMessage, 'recipients' | 'delivery' | 'mailbox_state'>>()
      for (const result of refreshed) {
        if (result.status !== 'fulfilled' || result.value.team_id !== query.teamId) continue
        replacements.set(result.value.id, {
          recipients: result.value.recipients,
          delivery: result.value.delivery,
          mailbox_state: result.value.mailbox_state
        })
      }
      if (!replacements.size) return
      let changed = false
      const next = messagesRef.current.map(message => {
        const replacement = replacements.get(message.id)
        if (!replacement || sameMessageReceiptState(message, replacement)) return message
        changed = true
        return keepNewestMailboxState({ ...message, ...replacement }, message)
      })
      if (!changed) return
      messagesRef.current = next
      setMessages(next)
      persistSnapshot()
    } finally {
      if (receiptReconcileGeneration.current === generation) receiptReconcileGeneration.current = null
    }
  }, [enabled, persistSnapshot, queryKey, scopeKey])
  useEffect(() => {
    requestGeneration.current += 1
    inFlightGeneration.current = null
    receiptReconcileGeneration.current = null
    receiptReconcileOffset.current = 0
    mailCoverageContinuation.current = null
    const cached = enabled ? peekTeamMessagesSnapshot(lifecycleCacheKey, query) : null
    const stagedMessages = cached?.messages ?? []
    messagesRef.current = stagedMessages
    latestSequence.current = cached?.latestSequence ?? 0
    nextAfterRef.current = cached?.nextAfter ?? null
    hasMoreRef.current = cached?.hasMore ?? false
    setMessages(stagedMessages)
    setNextAfter(nextAfterRef.current)
    setHasMore(hasMoreRef.current)
    setLoading(enabled && !cached)
    void fetchPage(undefined, false, Boolean(cached), true, initialLoad)
    return () => {
      requestGeneration.current += 1
      inFlightGeneration.current = null
    }
  }, [fetchPage, initialLoad, lifecycleCacheKey, queryKey])
  return {
    messages,
    loading,
    loadingMore,
    hasMore,
    error,
    setError,
    refresh: async () => {
      // A manual refresh reconciles existing rows too, including remote edits.
      await fetchPage(undefined, false, false, true)
      await reconcileReceiptStates()
    },
    loadMore: () => nextAfter != null && fetchPage(nextAfter, true),
    add: (message: TeamMessage) => {
      const summary = summaryFromMessage(message)
      if (!retainMessage(summary)) return
      const next = mergeMessages(messagesRef.current, [summary])
      messagesRef.current = next
      latestSequence.current = Math.max(latestSequence.current, message.sequence)
      setMessages(next)
      persistSnapshot()
    },
    remove: (id: string) => {
      const next = messagesRef.current.filter(message => message.id !== id)
      messagesRef.current = next
      setMessages(next)
      persistSnapshot()
    },
    replace: (id: string, update: (message: TeamMessageSummary) => TeamMessageSummary) => {
      const next = messagesRef.current.map(message => message.id === id ? update(message) : message)
      messagesRef.current = next
      setMessages(next)
      persistSnapshot()
    }
  }
}

function retainEveryMessage(): boolean {
  return true
}

function isBulletinMessage(message: TeamMessageBase): boolean {
  // The stored legacy `all` recipient denotes Bulletin, never a server-inbox fanout.
  return message.destination !== 'all_servers' && message.recipients.some(recipient => recipient.kind === 'all')
}

function mailDisplayTitle(message: TeamMessageBase & { body?: string; preview?: string }, fallback?: string): string | undefined {
  if (message.kind !== 'message' || isBulletinMessage(message)) return undefined
  // Keep a selected summary's heading stable when its server preview flattened body lines.
  return message.title?.trim() ? message.title : fallback ?? teamMailDisplayTitle(message)
}

function SurfaceHeader({ icon, title, description, loading, onRefresh, children }: {
  icon: ReactNode
  title: string
  description: string
  loading: boolean
  onRefresh: () => void
  children?: ReactNode
}) {
  useLocale()
  return <header className="network-v2-header"><span className="network-v2-header-icon">{icon}</span><div><h1>{title}</h1><p>{description}</p></div>{children}<button type="button" className="icon-button" title={t('teamNetwork.mail.refreshSurface', { title: title.toLocaleLowerCase() })} aria-label={t('teamNetwork.mail.refreshSurface', { title: title.toLocaleLowerCase() })} disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={15} /></button></header>
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  useLocale()
  return <div className="network-v2-error" role="alert"><span>{localizeMailError(message)}</span><button type="button" className="quiet-button" onClick={onRetry}>{t('teamNetwork.mail.retry')}</button></div>
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  useLocale()
  return <div className="network-v2-empty"><span>{icon}</span><h2>{title}</h2><p>{body}</p></div>
}

function buildMessageBundles(
  messages: TeamMessageSummary[],
  box: 'inbox' | 'sent',
  address: TeamMessageAddress | null
): MessageBundle[] {
  const grouped = new Map<string, MessageBundle>()
  for (const message of [...messages].sort((left, right) => right.created_at.localeCompare(left.created_at))) {
    const counterpart = box === 'inbox'
      ? { key: `${message.sender.kind}:${message.sender.id}`, label: message.sender.display_name, icon: message.sender.kind === 'server' ? <Server size={16} /> : <Users size={16} /> }
      : sentCounterpart(message)
    const current = grouped.get(counterpart.key)
    const unread = box === 'inbox' && messageIsUnread(message, address) ? 1 : 0
    if (current) { current.messages.push(message); current.unreadCount += unread }
    else grouped.set(counterpart.key, { ...counterpart, unreadCount: unread, messages: [message] })
  }
  return [...grouped.values()].sort((left, right) => right.messages[0].created_at.localeCompare(left.messages[0].created_at))
}

function sentCounterpart(message: TeamMessageSummary) {
  if (message.destination === 'all_servers') return { key: 'all_servers', label: t('teamNetwork.mail.allServers'), icon: <Mail size={16} /> }
  if (isBulletinMessage(message)) return { key: 'all', label: t('teamNetwork.mail.bulletin'), icon: <Users size={16} /> }
  const recipients = [...message.recipients].sort((left, right) => (
    `${left.kind}:${left.id ?? ''}`.localeCompare(`${right.kind}:${right.id ?? ''}`)
  ))
  const labels = recipients.map(recipient => recipient.display_name).join(', ')
  return { key: recipients.map(recipient => `${recipient.kind}:${recipient.id}`).join('|'), label: labels || t('teamNetwork.mail.recipients'), icon: <Mail size={16} /> }
}

function messageIsUnread(message: TeamMessageSummary, address: TeamMessageAddress | null): boolean {
  if (!address) return false
  if (address.kind === 'server' && message.mailbox_state?.address_id === address.id) return message.mailbox_state.unread
  const delivery = messageDelivery(message)
  if (delivery && delivery.kind === address.kind && delivery.id === address.id) return delivery.state !== 'read'
  return message.recipients.some(recipient => recipient.kind === address.kind && recipient.id === address.id && recipient.state !== 'read')
}

function mergeMessages(current: TeamMessageSummary[], incoming: TeamMessageSummary[]): TeamMessageSummary[] {
  // Empty bounded refreshes need not rebuild, sort, and repaint every row.
  if (incoming.length === 0) return current
  const merged = new Map(current.map(message => [message.id, message]))
  for (const message of incoming) merged.set(message.id, keepNewestMailboxState(message, merged.get(message.id)))
  return [...merged.values()].sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))
}

function keepNewestMailboxState<T extends { mailbox_state?: TeamMailboxState }>(incoming: T, current?: { mailbox_state?: TeamMailboxState }): T {
  const saved = current?.mailbox_state
  const next = incoming.mailbox_state
  return saved && (!next || saved.address_id === next.address_id && saved.version > next.version)
    ? { ...incoming, mailbox_state: saved } : incoming
}

function sameMessageReceiptState(
  current: Pick<TeamMessageSummary, 'recipients' | 'delivery' | 'mailbox_state'>,
  incoming: Pick<TeamMessage, 'recipients' | 'delivery' | 'mailbox_state'>
): boolean {
  if (current.mailbox_state?.version !== incoming.mailbox_state?.version
    || current.mailbox_state?.unread !== incoming.mailbox_state?.unread
    || current.mailbox_state?.address_id !== incoming.mailbox_state?.address_id) return false
  if (!sameRecipientState(current.delivery, incoming.delivery)) return false
  if (current.recipients.length !== incoming.recipients.length) return false
  return current.recipients.every((recipient, index) => sameRecipientState(recipient, incoming.recipients[index]))
}

function sameRecipientState(
  current: TeamMessageSummary['delivery'] | TeamMessageSummary['recipients'][number] | null,
  incoming: TeamMessage['delivery'] | TeamMessage['recipients'][number] | null
): boolean {
  return current === incoming || Boolean(current && incoming
    && current.kind === incoming.kind
    && current.id === incoming.id
    && current.display_name === incoming.display_name
    && current.state === incoming.state
    && current.delivered_at === incoming.delivered_at
    && current.read_at === incoming.read_at)
}

function sortSkills(skills: TeamSkill[]): TeamSkill[] {
  return [...skills].sort((left, right) => (
    Number(Boolean(right.pinned_at)) - Number(Boolean(left.pinned_at))
    || Number(Boolean(left.archived_at)) - Number(Boolean(right.archived_at))
    || right.updated_at.localeCompare(left.updated_at)
    || left.title.localeCompare(right.title)
  ))
}

function recipientSummary(message: TeamMessageBase): string {
  if (message.destination === 'all_servers') return t('teamNetwork.mail.allServersCount', { count: message.recipients.length })
  const names = message.recipients.map(recipient => recipient.display_name)
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

function addressKey(address: TeamMessageAddress): string { return `${address.kind}:${address.id}` }
function feedDraftKey(scope: TeamHubScope, teamId: string, draftIdentity: string): string {
  return JSON.stringify([
    scope.profileId,
    scope.serverIdentity,
    scope.hubIdentity,
    teamId,
    draftIdentity
  ])
}
function readFeedDraft(key: string): FeedDraftSnapshot {
  const persisted = readSavedDraft(`agentsdock:team-feed-draft:${key}`)
  const saved = persisted && typeof persisted.body === 'string' && typeof persisted.retryLocked === 'boolean'
    && typeof persisted.createKey === 'string' && Array.isArray(persisted.files)
    && persisted.files.every((file: unknown) => file && typeof file === 'object'
      && typeof (file as FeedDraftFile).path === 'string' && typeof (file as FeedDraftFile).name === 'string'
      && typeof (file as FeedDraftFile).declarationKey === 'string')
    ? persisted as unknown as FeedDraftSnapshot : ephemeralFeedDrafts.get(key)
  return saved
    ? { ...saved, files: saved.files.map(file => ({ ...file })) }
    : { body: '', files: [], retryLocked: false, createKey: crypto.randomUUID() }
}
function writeFeedDraft(key: string, draft: FeedDraftSnapshot): void {
  writeBulletinEditDraft(`agentsdock:team-feed-draft:${key}`, draft)
  ephemeralFeedDrafts.delete(key)
  ephemeralFeedDrafts.set(key, { ...draft, files: draft.files.map(file => ({ ...file })) })
  while (ephemeralFeedDrafts.size > MAX_EPHEMERAL_FEED_DRAFTS) {
    const oldest = ephemeralFeedDrafts.keys().next().value
    if (typeof oldest !== 'string') break
    ephemeralFeedDrafts.delete(oldest)
  }
}
function deleteFeedDraft(key: string): void {
  ephemeralFeedDrafts.delete(key)
  deleteSavedDraft(`agentsdock:team-feed-draft:${key}`)
}

function readSavedDraft(key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function writeBulletinEditDraft(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep the active draft in memory if storage is unavailable. */ }
}

function deleteSavedDraft(key: string): void {
  try { localStorage.removeItem(key) } catch { /* Storage may be disabled. */ }
}

function readBulletinEditDraft(key: string): { body: string; attempt: { body: string; expectedVersion: number; key: string } | null } | null {
  const value = readSavedDraft(key)
  if (!value || typeof value.body !== 'string') return null
  const attempt = value.attempt as Record<string, unknown> | null
  if (attempt && (typeof attempt.body !== 'string' || typeof attempt.key !== 'string'
    || !Number.isInteger(attempt.expectedVersion) || Number(attempt.expectedVersion) < 1)) return null
  return { body: value.body, attempt: attempt as { body: string; expectedVersion: number; key: string } | null }
}
function messagePreview(message: TeamMessageSummary): string {
  return plainPreview(message.preview) || t('teamNetwork.mail.messageSize', { size: formatBytes(message.body_bytes) })
}

function canDeleteMessageAuthor(
  author: { kind: 'human' | 'server'; id: string },
  ownedAddresses: TeamMessageAddress[],
  canManageMessages: boolean
): boolean {
  return canManageMessages || ownedAddresses.some(address => address.kind === author.kind && address.id === author.id)
}

function canEditMessageAuthor(
  author: { kind: 'human' | 'server'; id: string },
  ownedAddresses: TeamMessageAddress[],
  principalId: string | null
): boolean {
  return author.kind === 'human'
    ? author.id === principalId
    : ownedAddresses.some(address => address.kind === 'server' && address.id === author.id)
}

function deleteTargetForMessage(message: TeamMessageBase): BulletinDeleteTarget {
  return {
    source: 'message',
    skillAnnouncement: message.kind === 'skill',
    id: message.id,
    attachmentCount: message.attachments.length,
    idempotencyKey: crypto.randomUUID()
  }
}

function deleteTargetForLegacyBulletin(bulletin: TeamNetworkBulletinPost): BulletinDeleteTarget {
  return {
    source: 'legacy',
    id: bulletin.id,
    attachmentCount: 0,
    idempotencyKey: crypto.randomUUID()
  }
}
function summaryFromMessage(message: TeamMessage): TeamMessageSummary {
  const { body, ...summary } = message
  return { ...summary, preview: plainPreview(body) }
}
function messageDelivery(message: TeamMessageSummary): TeamRecipient | null { return message.delivery ?? null }
function mergeRecipientRows(current: TeamRecipient[], incoming: TeamRecipient[]): TeamRecipient[] {
  const replacements = new Map(incoming.map(recipient => [`${recipient.kind}:${recipient.id ?? ''}`, recipient]))
  const merged = current.map(recipient => replacements.get(`${recipient.kind}:${recipient.id ?? ''}`) ?? recipient)
  const known = new Set(current.map(recipient => `${recipient.kind}:${recipient.id ?? ''}`))
  for (const recipient of incoming) {
    if (!known.has(`${recipient.kind}:${recipient.id ?? ''}`)) merged.push(recipient)
  }
  return merged
}
function plainPreview(value: string): string {
  return [...value.replace(/[#*_>`~\[\]()]/g, '').replace(/\s+/g, ' ').trim()].slice(0, 240).join('')
}
const mailCardDateFormats = {
  en: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  'zh-CN': new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatDate(value: string): string { return new Date(value).toLocaleString(getLocale() === 'en' ? undefined : getLocale()) }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function attachmentKind(fileName: string, mediaType?: string): 'Image' | 'Video' | 'File' {
  const normalizedType = mediaType?.toLowerCase() ?? ''
  const normalizedName = fileName.toLowerCase()
  if (normalizedType.startsWith('image/') || /\.(?:avif|bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(normalizedName)) return 'Image'
  if (normalizedType.startsWith('video/') || /\.(?:m4v|mov|mp4|webm)$/i.test(normalizedName)) return 'Video'
  return 'File'
}
function attachmentIcon(fileName: string, mediaType?: string): ReactNode {
  const kind = attachmentKind(fileName, mediaType)
  return kind === 'Image' ? <ImageIcon size={14} /> : kind === 'Video' ? <Film size={14} /> : <File size={14} />
}
function attachmentCountLabel(attachments: TeamAttachment[]): string {
  const images = attachments.filter(attachment => attachmentKind(attachment.file_name, attachment.media_type) === 'Image').length
  const videos = attachments.filter(attachment => attachmentKind(attachment.file_name, attachment.media_type) === 'Video').length
  const files = attachments.length - images - videos
  return [
    images ? t(images === 1 ? 'teamNetwork.mail.imageCountOne' : 'teamNetwork.mail.imageCountMany', { count: images }) : '',
    videos ? t(videos === 1 ? 'teamNetwork.mail.videoCountOne' : 'teamNetwork.mail.videoCountMany', { count: videos }) : '',
    files ? t(files === 1 ? 'teamNetwork.mail.fileCountOne' : 'teamNetwork.mail.fileCountMany', { count: files }) : ''
  ].filter(Boolean).join(', ')
}
function validateFeedBody(value: string, capability: TeamMessagesCapability): void {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes < 1) throw new Error('Write a message before posting.')
  if (bytes > capability.max_body_bytes) throw new Error(`This bulletin exceeds the ${formatBytes(capability.max_body_bytes)} message limit.`)
}
function validateAttachmentFiles(files: NativeFileRef[], capability: TeamMessagesCapability): void {
  if (files.length > capability.attachments.max_files_per_message) {
    throw new Error(`Choose no more than ${capability.attachments.max_files_per_message} attachments.`)
  }
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('The same file cannot be attached twice.')
  const effectivePerFileLimit = Math.min(
    capability.attachments.max_bytes_per_file,
    capability.attachments.max_bytes_per_message
  )
  let total = 0
  for (const file of files) {
    if (file.size === undefined) continue
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error(`${file.name} is not a valid attachment.`)
    if (file.size > effectivePerFileLimit) {
      throw new Error(`${file.name} exceeds the ${formatBytes(effectivePerFileLimit)} per-file limit.`)
    }
    total += file.size
  }
  if (total > capability.attachments.max_bytes_per_message) {
    throw new Error(`The selected attachments exceed the ${formatBytes(capability.attachments.max_bytes_per_message)} post limit.`)
  }
}
function formValue(form: FormData, name: string): string { return String(form.get(name) ?? '').trim() }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : 'Team Network request failed.' }

function attachmentKindLabel(kind: 'Image' | 'Video' | 'File'): string {
  return t(kind === 'Image' ? 'teamNetwork.mail.image' : kind === 'Video' ? 'teamNetwork.mail.video' : 'teamNetwork.mail.file')
}

function mediaKindLabel(kind: 'image' | 'video'): string {
  return t(kind === 'image' ? 'teamNetwork.mail.imageLower' : 'teamNetwork.mail.videoLower')
}

// Keep stored request errors language-neutral; only app-authored display text is localized.
const mailErrorKeys: Record<string, string> = {
  'Posting was interrupted before this app received confirmation.': 'teamNetwork.mail.error.postInterrupted',
  "Team Hub returned the wrong Bulletin deletion receipt.": 'teamNetwork.mail.error.wrongBulletinDeletion',
  "Team Hub returned the wrong legacy Bulletin deletion receipt.": 'teamNetwork.mail.error.wrongLegacyDeletion',
  "Refresh the mailbox before changing this message’s read status.": 'teamNetwork.mail.error.refreshMailboxFirst',
  "Team Hub returned a mismatched mailbox state.": 'teamNetwork.mail.error.wrongMailboxState',
  "Team Hub returned the wrong message receipt.": 'teamNetwork.mail.error.wrongMessageReceipt',
  "Team Hub did not mark this mailbox message as read.": 'teamNetwork.mail.error.notMarkedRead',
  "Team Hub returned the wrong message deletion receipt.": 'teamNetwork.mail.error.wrongMessageDeletion',
  "Team Network returned the wrong linked message.": 'teamNetwork.mail.error.wrongLinkedMessage',
  "Team Network returned the wrong message detail.": 'teamNetwork.mail.error.wrongMessageDetail',
  "Team Network returned a different mail thread.": 'teamNetwork.mail.error.wrongThread',
  "This server does not support Bulletin revisions yet.": 'teamNetwork.mail.error.revisionsUnsupported',
  "The selected attachments exceed the per-message attachment limit.": 'teamNetwork.mail.error.attachmentTotalLimit',
  "Attachment preview was not returned by the desktop service.": 'teamNetwork.mail.error.missingPreview',
  "Write a message before posting.": 'teamNetwork.mail.error.writeMessage',
  "The same file cannot be attached twice.": 'teamNetwork.mail.error.duplicateAttachment',
  "Team Network request failed.": 'teamNetwork.mail.error.requestFailed'
}
const mailErrorPatterns: Array<{ pattern: RegExp; key: string; params: string[] }> = [
  { pattern: /^The upload for (.+) did not finish safely\.$/, key: 'teamNetwork.mail.error.uploadIncomplete', params: ["name"] },
  { pattern: /^Choose no more than (\d+) attachments\.$/, key: 'teamNetwork.mail.error.chooseMaxAttachments', params: ["count"] },
  { pattern: /^Skill Markdown must be between 1 and (\d+) bytes\.$/, key: 'teamNetwork.mail.error.skillBodyBytes', params: ["count"] },
  { pattern: /^Use up to (\d+) unique lowercase skill tags\.$/, key: 'teamNetwork.mail.error.skillTags', params: ["count"] },
  { pattern: /^(.+) exceeds the per-file attachment limit\.$/, key: 'teamNetwork.mail.error.fileLimit', params: ["name"] },
  { pattern: /^This bulletin exceeds the (.+) message limit\.$/, key: 'teamNetwork.mail.error.bulletinSizeLimit', params: ["size"] },
  { pattern: /^(.+) is not a valid attachment\.$/, key: 'teamNetwork.mail.error.invalidAttachment', params: ["name"] },
  { pattern: /^(.+) exceeds the (.+) per-file limit\.$/, key: 'teamNetwork.mail.error.namedFileSizeLimit', params: ["name","size"] },
  { pattern: /^The selected attachments exceed the (.+) post limit\.$/, key: 'teamNetwork.mail.error.postAttachmentLimit', params: ["size"] }
]
function localizeMailError(message: string): string {
  if (Object.hasOwn(mailErrorKeys, message)) return t(mailErrorKeys[message])
  for (const { pattern, key, params } of mailErrorPatterns) {
    const match = pattern.exec(message)
    if (match) return t(key, Object.fromEntries(params.map((name, index) => [name, match[index + 1]])))
  }
  return message
}
