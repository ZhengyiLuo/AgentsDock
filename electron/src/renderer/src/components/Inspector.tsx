// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Bot, ChevronDown, ChevronRight, Copy, Download, ExternalLink, File, FileCode2, FileStack, FolderOpen, LoaderCircle, Pin, Play, RefreshCw, Unplug, X } from 'lucide-react'
import { effectiveFileContentType, isEditorTextFile, isPreviewableFile } from '@shared/file-content-type'
import type { AgentFile, Event as AgentEvent, PinnedItem, Session, WorkspaceProfileScope } from '@shared/types'
import { agentFileBelongsToSession, eventFileForSession, isolateSessionEvent } from '@shared/session-files'
import { trackEvent } from '../lib/analytics'
import { saveAgentFile } from '../lib/file-actions'
import { formatBytes } from '../lib/format'
import { filePinHasExplicitOwner, pinnedItemsForSession } from '../lib/pinned-items'
import { isSubagentActive, subagentDetailText, subagentDisplayName, subagentLogText, subagentStatusLabel, subagentsFromEvents, type SubagentActivity } from '../lib/subagents'
import { requestOpenAgentFile, requestOpenWorkspacePath, workspacePathForAgentFile } from '../lib/workspace-file-links'
import { useAppStore } from '../store/app-store'
import { LazyVideoThumbnail, MediaPreviewDialog } from './MediaGrid'
import { NativeFileDragSurface } from './NativeFileDragSurface'

const EMPTY_FILES: AgentFile[] = []

export function Inspector() {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const snapshotFiles = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId]?.files ?? EMPTY_FILES : EMPTY_FILES)
  const snapshotFilesTotal = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId]?.filesTotal ?? 0 : 0)
  const pinProfileScope = useMemo<WorkspaceProfileScope | null>(() => activeProfileId ? ({
    profileId: activeProfileId,
    profileGeneration,
    serverIdentity
  }) : null, [activeProfileId, profileGeneration, serverIdentity])
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [files, setFiles] = useState<AgentFile[]>([])
  const [filesTotal, setFilesTotal] = useState(0)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [preview, setPreview] = useState<AgentFile | null>(null)
  const sessionRequest = useRef(0)
  const fileRequest = useRef(0)

  useEffect(() => {
    const request = ++sessionRequest.current
    fileRequest.current += 1
    let cancelled = false
    setPreview(null)
    setMediaOpen(false)
    setLoadingFiles(false)
    setPins([])
    if (!session || !pinProfileScope) { setPins([]); setFiles([]); setFilesTotal(0); return }
    const ownedSnapshotFiles = snapshotFiles.filter(file => agentFileBelongsToSession(file, session.id))
    setFiles(ownedSnapshotFiles)
    setFilesTotal(Math.max(ownedSnapshotFiles.length, snapshotFilesTotal - (snapshotFiles.length - ownedSnapshotFiles.length)))
    void window.agentsDock.pins.list(pinProfileScope, session.id).then(items => {
      if (!cancelled && request === sessionRequest.current) setPins(pinnedItemsForSession(items, session.id))
    }).catch(error => {
      if (!cancelled && request === sessionRequest.current) reportActionError(error)
    })
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== session.id) return
      void window.agentsDock.pins.list(pinProfileScope, session.id).then(items => {
        if (!cancelled && request === sessionRequest.current) setPins(pinnedItemsForSession(items, session.id))
      }).catch(error => {
        if (!cancelled && request === sessionRequest.current) reportActionError(error)
      })
    }
    const unsubscribePins = window.agentsDock.events?.on?.('server:pins', payload => {
      if (
        cancelled
        || request !== sessionRequest.current
        || payload.profileId !== pinProfileScope.profileId
        || payload.profileGeneration !== pinProfileScope.profileGeneration
        || payload.sessionId !== session.id
      ) return
      setPins(pinnedItemsForSession(payload.pins, session.id))
    }) ?? (() => undefined)
    window.addEventListener('agentsdock:pins-changed', changed)
    return () => {
      cancelled = true
      if (request === sessionRequest.current) sessionRequest.current += 1
      fileRequest.current += 1
      unsubscribePins()
      window.removeEventListener('agentsdock:pins-changed', changed)
    }
  }, [pinProfileScope, session?.id])

  useEffect(() => {
    if (!session) return
    const ownedSnapshotFiles = snapshotFiles.filter(file => agentFileBelongsToSession(file, session.id))
    setFiles(current => mergeFiles(current, ownedSnapshotFiles))
    setFilesTotal(Math.max(ownedSnapshotFiles.length, snapshotFilesTotal - (snapshotFiles.length - ownedSnapshotFiles.length)))
  }, [session?.id, snapshotFiles, snapshotFilesTotal])

  const loadFiles = async (reset = false) => {
    if (!session || loadingFiles) return
    const sessionId = session.id
    const request = ++fileRequest.current
    setLoadingFiles(true)
    try {
      const offset = reset ? 0 : files.length
      const page = await window.agentsDock.files.list(sessionId, offset, 60)
      if (request !== fileRequest.current || useAppStore.getState().selectedSessionId !== sessionId) return
      const ownedPageFiles = page.files.filter(file => agentFileBelongsToSession(file, sessionId))
      setFiles(current => reset ? ownedPageFiles : mergeFiles(current, ownedPageFiles))
      setFilesTotal(Math.max(ownedPageFiles.length, page.total - (page.files.length - ownedPageFiles.length)))
    } catch (error) {
      if (request === fileRequest.current && useAppStore.getState().selectedSessionId === sessionId) {
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (request === fileRequest.current) setLoadingFiles(false)
    }
  }
  const toggleMedia = () => { const next = !mediaOpen; setMediaOpen(next); if (next && session && files.length === 0) void loadFiles(true) }

  return <aside className="inspector">
    <div className="inspector-drag-region" />
    <div className="inspector-scroll">
      {!session ? <div className="inspector-empty">{t("ui.Inspector.Inspector.select_a_chat_to_inspect_its_runtime_files_f5631ca")}</div> : <>
        <section className="inspector-section session-settings">
          <SessionPromptField value={session.system_prompt || ''} onSave={value => useAppStore.getState().updateSession(session.id, { system_prompt: value || null })} />
        </section>

        {pinProfileScope && <PinnedSection key={`pinned:${session.id}`} profileScope={pinProfileScope} sessionId={session.id} pins={pins} setPins={setPins} files={files} />}
        <SubagentsSection key={`subagents:${session.id}`} sessionId={session.id} />
        <section className="inspector-section collapsible-section">
          <div className="section-heading-row"><button className="section-toggle" onClick={toggleMedia}>{mediaOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FileStack size={15} /><strong>{t("ui.Inspector.Inspector.media_files_9d2cd70")}</strong><small>{files.length}/{filesTotal || files.length}</small></button><button className="nested-icon" title={t("ui.Inspector.Inspector.refresh_0e91610")} onClick={() => void loadFiles(true)}><RefreshCw size={12} /></button></div>
          {mediaOpen && pinProfileScope && <MediaInspector profileScope={pinProfileScope} sessionId={session.id} workspaceRoot={session.cwd ?? null} files={files} total={filesTotal} loading={loadingFiles} loadMore={() => void loadFiles(false)} onPreview={setPreview} />}
        </section>
        <MediaPreviewDialog sessionId={session.id} file={preview} files={files} onSelect={setPreview} onClose={() => setPreview(null)} />
      </>}
    </div>
  </aside>

}

const EMPTY_EVENTS: AgentEvent[] = []

function SubagentsSection({ sessionId }: { sessionId: string }) {
  useLocale()
  const events = useAppStore(state => state.snapshots[sessionId]?.events ?? EMPTY_EVENTS)
  const ownerBackend = useAppStore(state => (
    state.snapshots[sessionId]?.session.backend
    ?? state.sessions.find(session => session.id === sessionId)?.backend
    ?? 'codex'
  ))
  const subagentOwnerBackend = ownerBackend === 'claude' ? 'claude' : 'codex'
  const agents = useMemo(() => subagentsFromEvents(events, subagentOwnerBackend), [events, subagentOwnerBackend, getLocale()])
  const activeAgents = useMemo(() => agents.filter(isSubagentActive), [agents])
  const historicalAgents = useMemo(() => agents.filter(agent => !isSubagentActive(agent)), [agents])
  const activeCount = activeAgents.length
  const [open, setOpen] = useState(activeCount > 0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [output, setOutput] = useState<ReturnType<typeof subagentsFromEvents>[number] | null>(null)
  const [, setClock] = useState(0)

  useEffect(() => {
    if (activeCount > 0) setOpen(true)
  }, [activeCount])

  useEffect(() => {
    if (!activeCount) return
    const timer = window.setInterval(() => setClock(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [activeCount])

  if (!agents.length) return null
  return <section className="inspector-section collapsible-section subagents-section">
    <button className="section-toggle" aria-label={t("ui.Inspector.SubagentsSection.subagents_active_987ab1c", { "count": String(activeCount) })} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Bot size={15} /><strong>Subagents</strong><small className="subagent-active-count">{activeCount}{" "}{t("ui.Inspector.SubagentsSection.active_9687961")}</small></button>
    {open && <div className="subagent-groups">
      {activeAgents.length
        ? <div className="subagent-group subagent-active-group">
          <div className="subagent-group-label"><span>{t("ui.Inspector.SubagentsSection.active_now_441658c")}</span><small>{activeAgents.length}</small></div>
          <SubagentList agents={activeAgents} onSelect={setOutput} />
        </div>
        : <p className="subagent-empty">{t("ui.Inspector.SubagentsSection.no_active_subagents_984b6e9")}</p>}
      {historicalAgents.length > 0 && <div className="subagent-group subagent-history-group">
        <button className="subagent-history-toggle" aria-label={t("ui.Inspector.SubagentsSection.history_records_11b5ddd", { "count": String(historicalAgents.length) })} aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>
          {historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{t("ui.Inspector.SubagentsSection.history_0e76960")}</span>
          <small>{t('ui.inspector.recordCount', { count: historicalAgents.length })}</small>
        </button>
        {historyOpen && <SubagentList agents={historicalAgents} onSelect={setOutput} history />}
      </div>}
    </div>}
    {output && <OutputPanel title={subagentDisplayName(output)} text={subagentLogText(agents.find(agent => agent.key === output.key) || output)} onClose={() => setOutput(null)} />}
  </section>
}

function SubagentList({ agents, onSelect, history = false }: { agents: SubagentActivity[]; onSelect: (agent: SubagentActivity) => void; history?: boolean }) {
  useLocale()
  return <div className={`subagent-list${history ? ' subagent-history-list' : ''}`}>{agents.map(agent => <button key={agent.key} onClick={() => onSelect(agent)}>
    <span className={`subagent-state ${agent.status}`} />
    <div><strong>{subagentDisplayName(agent)}</strong><small>{agent.backend === 'claude' ? 'Claude' : 'Codex'} · {subagentStatusLabel(agent.status)} · {subagentElapsed(agent.startedAt, agent.updatedAt, isSubagentActive(agent))}</small><code>{subagentDetailText(agent)}</code></div>
  </button>)}</div>
}

function subagentElapsed(startedAt: string, updatedAt: string, active: boolean): string {
  const start = Date.parse(startedAt)
  const end = active ? Date.now() : Date.parse(updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'live'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return t("ui.Inspector.subagentElapsed.s_5307d20", { "seconds": String(seconds) })
  if (seconds < 3600) return t("ui.Inspector.subagentElapsed.m_s_c452161", { "minutes": String(Math.floor(seconds / 60)), "seconds": String(seconds % 60) })
  return t("ui.Inspector.subagentElapsed.h_m_425dc6c", { "hours": String(Math.floor(seconds / 3600)), "minutes": String(Math.floor((seconds % 3600) / 60)) })
}

function PinnedSection({ profileScope, sessionId, pins, setPins, files }: { profileScope: WorkspaceProfileScope; sessionId: string; pins: PinnedItem[]; setPins: (items: PinnedItem[]) => void; files: AgentFile[] }) {
  useLocale()
  const workspaceRoot = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.cwd ?? null)
  const [legacyFiles, setLegacyFiles] = useState<Record<string, AgentFile | null>>({})
  const [removingPinId, setRemovingPinId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const missing = pins.filter(pin => (
      pin.kind === 'file'
      && pin.fileId
      && !filePinHasExplicitOwner(pin, sessionId)
      && !files.some(file => file.id === pin.fileId && agentFileBelongsToSession(file, sessionId))
      && !Object.prototype.hasOwnProperty.call(legacyFiles, pin.fileId)
    ))
    if (!missing.length) return
    void Promise.all(missing.map(async pin => {
      const event = await window.agentsDock.files.findEvent(sessionId, pin.fileId as string).catch(() => null)
      const isolated = event ? isolateSessionEvent(event, sessionId) : null
      return [pin.fileId as string, isolated ? eventFileForSession(isolated) : null] as const
    })).then(results => {
      if (cancelled) return
      setLegacyFiles(current => ({ ...current, ...Object.fromEntries(results) }))
    })
    return () => { cancelled = true }
  }, [files, legacyFiles, pins, sessionId])
  const remove = async (itemId: string) => {
    if (removingPinId) return
    setRemovingPinId(itemId)
    try {
      const next = pinnedItemsForSession(await window.agentsDock.pins.remove(profileScope, sessionId, itemId), sessionId)
      if (useAppStore.getState().selectedSessionId === sessionId) {
        setPins(next)
        window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
      }
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingPinId(current => current === itemId ? null : current)
    }
  }
  const visiblePins = pins.flatMap<{ pin: PinnedItem; file: AgentFile | null }>(pin => {
    if (pin.kind !== 'file') return [{ pin, file: null }]
    if (!pin.fileId) return []
    const currentFile = files.find(candidate => candidate.id === pin.fileId && agentFileBelongsToSession(candidate, sessionId))
    const file = currentFile
      || (filePinHasExplicitOwner(pin, sessionId) ? pinnedAgentFile(pin, sessionId) : legacyFiles[pin.fileId])
    return file ? [{ pin, file }] : []
  })
  return <section className="inspector-section pins-section"><h3><Pin size={14} />{" "}{t("ui.Inspector.PinnedSection.pinned_f20c879")}{" "}<small>{visiblePins.length}</small></h3>{!visiblePins.length ? <p>{t("ui.Inspector.PinnedSection.pin_important_messages_or_files_from_the_t_28fc9c2")}</p> : <div className="pin-list">{visiblePins.map(({ pin, file }) => {
    const canOpenInEditor = Boolean(file && (workspacePathForAgentFile(file, workspaceRoot) || isEditorTextFile(file)))
    const open = () => {
      if (file) {
        if (canOpenInEditor) requestOpenAgentFile(sessionId, file)
        else runAction(window.agentsDock.files.open(sessionId, file))
      } else if (pin.eventId) {
        window.dispatchEvent(new CustomEvent('agentsdock:find-event', {
          detail: {
            sessionId,
            eventId: pin.eventId,
            query: pinnedMessageSearchQuery(pin)
          }
        }))
      }
    }
    return <article key={pin.id} className={pin.kind}><Pin className="pin-item-mark" size={11} fill="currentColor" /><button type="button" className="pin-content" aria-label={`Open ${pin.title}`} onClick={open}>{pin.body ? <span className="pin-preview">{pin.body}</span> : <strong>{pin.title}</strong>}<small><b>{pin.body ? pin.title : pin.kind === 'file' ? t("ui.Inspector.file_50009ce") : t("ui.Inspector.message_2f77668")}</b>{pin.subtitle ? ` · ${pin.subtitle}` : ''}</small></button>{file && canOpenInEditor && <button type="button" title={t("ui.Inspector.open_in_editor_f395ae5")} onClick={() => requestOpenAgentFile(sessionId, file)}><FileCode2 size={12} /></button>}<button type="button" aria-label={`Unpin ${pin.title}`} title={t("ui.Inspector.unpin_ee3c716")} disabled={Boolean(removingPinId)} onClick={() => void remove(pin.id)}>{removingPinId === pin.id ? <LoaderCircle className="spin" size={12} /> : <X size={12} />}</button></article>
  })}</div>}</section>
}

function pinnedMessageSearchQuery(pin: PinnedItem): string {
  const text = (pin.body || pin.title).replaceAll('"', ' ').replace(/\s+/g, ' ').trim()
  return text.split(' ').slice(0, 6).join(' ').slice(0, 320)
}

function pinnedAgentFile(pin: PinnedItem, sessionId: string): AgentFile | null {
  if (!pin.fileId || !filePinHasExplicitOwner(pin, sessionId)) return null
  return {
    id: pin.fileId,
    session_id: sessionId,
    filename: pin.filename || pin.title,
    ...(pin.content_type ? { content_type: pin.content_type } : {}),
    ...(pin.path ? { path: pin.path } : {}),
    ...(pin.source_path ? { source_path: pin.source_path } : {})
  }
}


export function SessionPromptField({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  useLocale()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => { const clean = draft.trim(); if (clean !== value) void onSave(clean) }
  return <label className="session-prompt-field"><span>{t("ui.Inspector.SessionPromptField.system_prompt_561257c")}</span><textarea value={draft} placeholder={t("ui.Inspector.SessionPromptField.optional_per_chat_instructions_454671b")} onChange={event => setDraft(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur() } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur() }} /></label>
}

function OutputPanel({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  useLocale()
  return <div className="output-panel"><header><strong>{title}</strong><button type="button" aria-label={t("ui.Inspector.OutputPanel.copy_fca0eed", { "title": String(title) })} onClick={() => runAction(window.agentsDock.native.writeClipboard(text))}><Copy size={12} /></button><button type="button" aria-label={t("ui.Inspector.OutputPanel.close_31a8910", { "name": String(title) })} onClick={onClose}><X size={12} /></button></header><pre>{text}</pre></div>
}

function MediaInspector({ profileScope, sessionId, workspaceRoot, files, total, loading, loadMore, onPreview }: { profileScope: WorkspaceProfileScope; sessionId: string; workspaceRoot: string | null; files: AgentFile[]; total: number; loading: boolean; loadMore: () => void; onPreview: (file: AgentFile) => void }) {
  useLocale()
  const media = useMemo(() => files.filter(isPreviewableFile), [files])
  const documents = useMemo(() => files.filter(file => !isPreviewableFile(file)), [files])
  const pin = async (file: AgentFile) => {
    if (!agentFileBelongsToSession(file, sessionId)) return
    await window.agentsDock.pins.put(profileScope, {
      id: `file:${file.id}`,
      sessionId,
      kind: 'file',
      fileId: file.id,
      fileSessionId: sessionId,
      filename: file.filename,
      content_type: file.content_type,
      path: file.path,
      source_path: file.source_path,
      title: file.title || file.filename,
      createdAt: Date.now()
    })
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  return <div className="media-inspector"><div className="inspector-media-grid">{media.map(file => {
    const source = window.agentsDock.files.mediaURL(profileScope.profileId, profileScope.profileGeneration, sessionId, file.id)
    const type = effectiveFileContentType(file)
    const workspacePath = workspacePathForAgentFile(file, workspaceRoot)
    return <NativeFileDragSurface key={file.id} sessionId={sessionId} file={file}><button type="button" className="inspector-thumb" onClick={() => { trackEvent('file_view_opened'); onPreview(file) }}>{type.startsWith('image/') ? <img src={source} loading="lazy" draggable={false} /> : source ? <LazyVideoThumbnail source={source} /> : null}{type.startsWith('video/') && <Play className="thumb-play" size={14} fill="currentColor" />}</button><strong title={file.title || file.filename}>{file.title || file.filename}</strong><small>{formatBytes(file.size)}</small><div data-native-drag-ignore><button type="button" title={t("ui.Inspector.find_in_chat_df9554c")} onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:find-file', { detail: { sessionId, fileId: file.id } }))}><RefreshCw size={11} /></button>{workspacePath && <button type="button" title={t("ui.Inspector.open_in_editor_f395ae5")} onClick={() => requestOpenWorkspacePath(sessionId, workspacePath)}><FileCode2 size={11} /></button>}<button type="button" title={t("ui.Inspector.pin_ff1cee7")} onClick={() => runAction(pin(file))}><Pin size={11} /></button><button type="button" title={t("ui.Inspector.download_d6eafe8")} onClick={() => runAction(saveAgentFile(sessionId, file))}><Download size={11} /></button><button type="button" title={t("ui.Inspector.show_in_folder_3c4d9b8")} onClick={() => runAction(window.agentsDock.files.reveal(sessionId, file))}><FolderOpen size={11} /></button><button type="button" title={t("ui.Inspector.open_ed077f3")} onClick={() => runAction(window.agentsDock.files.open(sessionId, file))}><ExternalLink size={11} /></button></div></NativeFileDragSurface>
  })}</div>{documents.length > 0 && <div className="document-list">{documents.map(file => {
    const workspacePath = workspacePathForAgentFile(file, workspaceRoot)
    const canOpenInEditor = Boolean(workspacePath) || isEditorTextFile(file)
    const openInEditor = () => requestOpenAgentFile(sessionId, file)
    return <NativeFileDragSurface key={file.id} sessionId={sessionId} file={file}><File size={14} /><button type="button" className="inspector-document-title" data-native-drag-ignore onClick={() => canOpenInEditor ? openInEditor() : runAction(window.agentsDock.files.open(sessionId, file))}><strong title={file.filename}>{file.filename}</strong><small>{formatBytes(file.size)}</small></button><button type="button" data-native-drag-ignore title={t("ui.Inspector.find_in_chat_df9554c")} onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:find-file', { detail: { sessionId, fileId: file.id } }))}><RefreshCw size={12} /></button>{canOpenInEditor && <button type="button" data-native-drag-ignore title={t("ui.Inspector.open_in_editor_f395ae5")} onClick={openInEditor}><FileCode2 size={12} /></button>}<button type="button" data-native-drag-ignore title={t("ui.Inspector.download_d6eafe8")} onClick={() => runAction(saveAgentFile(sessionId, file))}><Download size={12} /></button><button type="button" data-native-drag-ignore title={t("ui.Inspector.show_in_folder_3c4d9b8")} onClick={() => runAction(window.agentsDock.files.reveal(sessionId, file))}><FolderOpen size={12} /></button></NativeFileDragSurface>
  })}</div>}{files.length < total && <button type="button" className="load-more" disabled={loading} onClick={loadMore}>{loading && <LoaderCircle className="spin" size={13} />}{" "}{t("ui.Inspector.MediaInspector.load_60_more_b3ee0b4")}</button>}</div>
}


function mergeFiles(a: AgentFile[], b: AgentFile[]): AgentFile[] { return [...new Map([...a, ...b].map(file => [file.id, file])).values()].sort((x, y) => (y.seq || 0) - (x.seq || 0)) }

function reportActionError(error: unknown): void {
  useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
}

function runAction(operation: Promise<unknown>): void {
  void operation.catch(reportActionError)
}
