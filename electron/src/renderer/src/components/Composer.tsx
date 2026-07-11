import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core'
import { ArrowDown, ArrowUp, ChevronDown, CornerDownRight, File, GripVertical, ListOrdered, MoreHorizontal, Paperclip, Pencil, Plus, Send, Square, Trash2, X } from 'lucide-react'
import type { AgentFile, NativeFileRef, QueuedTurn, Session } from '@shared/types'
import { formatBytes, runtimeLabel } from '../lib/format'
import { steerQueuedTurn } from '../lib/queue-actions'
import { useAppStore } from '../store/app-store'
import { BackendMark } from './BackendMark'

const EMPTY_UPLOADS: AgentFile[] = []
const EMPTY_UPLOAD_PATHS: NativeFileRef[] = []
const EMPTY_QUEUED_TURNS: QueuedTurn[] = []

export function Composer() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const selectedId = useAppStore(state => state.selectedSessionId)
  const queuedTurns = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId]?.queuedTurns ?? EMPTY_QUEUED_TURNS : EMPTY_QUEUED_TURNS)
  const storedDraft = useAppStore(state => state.selectedSessionId ? state.drafts[state.selectedSessionId] ?? '' : '')
  const uploads = useAppStore(state => state.selectedSessionId ? state.uploadsBySession[state.selectedSessionId] ?? EMPTY_UPLOADS : EMPTY_UPLOADS)
  const uploadPaths = useAppStore(state => state.selectedSessionId ? state.uploadPathsBySession[state.selectedSessionId] ?? EMPTY_UPLOAD_PATHS : EMPTY_UPLOAD_PATHS)
  const running = useAppStore(state => state.selectedSessionId ? state.activeSessionIds.has(state.selectedSessionId) : false)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const draftRef = useRef(storedDraft)
  const draftSessionRef = useRef(selectedId)
  const [draft, setDraft] = useState(storedDraft)
  const [dropActive, setDropActive] = useState(false)

  useEffect(() => { draftRef.current = draft }, [draft])

  useEffect(() => () => {
    const id = draftSessionRef.current
    if (!id) return
    const text = draftRef.current
    useAppStore.getState().setDraftForSession(id, text)
    void window.agentsDock.preferences.set(`draft:${id}`, text)
  }, [])

  useEffect(() => {
    const previousSession = draftSessionRef.current
    if (previousSession && previousSession !== selectedId) {
      const previousDraft = draftRef.current
      useAppStore.getState().setDraftForSession(previousSession, previousDraft)
      void window.agentsDock.preferences.set(`draft:${previousSession}`, previousDraft)
    }
    draftSessionRef.current = selectedId
    if (!selectedId) { setDraft(''); return }
    const immediate = useAppStore.getState().drafts[selectedId] ?? ''
    setDraft(immediate)
    if (!immediate) void window.agentsDock.preferences.get(`draft:${selectedId}`, '').then(value => {
      if (useAppStore.getState().selectedSessionId === selectedId && value) setDraft(value)
    })
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) return
    const timer = window.setTimeout(() => {
      if (useAppStore.getState().selectedSessionId !== selectedId) return
      useAppStore.getState().setDraft(draft)
      void window.agentsDock.preferences.set(`draft:${selectedId}`, draft)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [draft, selectedId])

  useEffect(() => {
    if (storedDraft && !draft && selectedId === useAppStore.getState().selectedSessionId) setDraft(storedDraft)
  }, [storedDraft])

  const send = async (steer = false) => {
    const outgoing = draft.trim()
    if (!outgoing) return
    setDraft('')
    if (selectedId) {
      useAppStore.getState().setDraftForSession(selectedId, '')
      void window.agentsDock.preferences.set(`draft:${selectedId}`, '')
    }
    const sent = await useAppStore.getState().sendPrompt(outgoing, steer)
    if (!sent && useAppStore.getState().selectedSessionId === selectedId) {
      setDraft(current => !current.trim() || current === outgoing ? outgoing : `${outgoing}\n\n${current}`)
    }
  }

  const addFiles = async (refs: NativeFileRef[]) => useAppStore.getState().attachPaths(refs)
  const handleFiles = async (files: FileList | File[]) => {
    const refs: NativeFileRef[] = []
    for (const file of Array.from(files)) {
      const path = window.agentsDock.files.pathForFile(file)
      if (path) refs.push({ path, name: file.name, size: file.size, type: file.type })
      else if (file.type.startsWith('image/')) refs.push(await window.agentsDock.files.stageClipboardImage(await file.arrayBuffer(), file.name, file.type))
    }
    if (refs.length) await addFiles(refs)
  }

  if (!session) return <div className="composer disabled"><span>Select or create a chat to begin.</span></div>
  return (
    <div
      className={`composer ${dropActive ? 'drop-active' : ''}`}
      onDragEnter={event => { event.preventDefault(); setDropActive(true) }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false) }}
      onDrop={event => { event.preventDefault(); setDropActive(false); void handleFiles(event.dataTransfer.files) }}
    >
      <QueueShelf sessionId={session.id} turns={queuedTurns} />
      {(uploads.length > 0 || uploadPaths.length > 0) && <AttachmentShelf files={uploads} pending={uploadPaths} />}
      <textarea
        value={draft}
        rows={1}
        placeholder="Message"
        spellCheck
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (draft.trim()) void send(event.metaKey)
          }
        }}
        onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void handleFiles(event.clipboardData.files) } }}
      />
      <div className="composer-bar">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button className="composer-icon" title="Add"><Plus size={18} /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="start">
            <DropdownMenu.Item className="menu-item" onSelect={() => void window.agentsDock.files.choose().then(addFiles)}><Paperclip size={14} /> Attach files</DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Label className="menu-label">Frequent phrases</DropdownMenu.Label>
            {['Status report', 'Keep going.', 'Verify the result carefully.'].map(phrase => <DropdownMenu.Item key={phrase} className="menu-item" onSelect={() => setDraft(draft ? `${draft}\n${phrase}` : phrase)}>{phrase}</DropdownMenu.Item>)}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <BackendMenu session={session} />
        <RuntimeMenu session={session} />
        <span className="composer-spacer" />
        {running && <button className="stop-button" onClick={() => void useAppStore.getState().stopTurn()} title="Stop agent"><span className="activity-ring" /><Square size={12} fill="currentColor" /> Stop</button>}
        <button className="send-button" disabled={!draft.trim()} onClick={() => void send()} title={running ? 'Queue message · ⌘↩ steers now' : 'Send message'}><Send size={17} /></button>
      </div>
      {dropActive && <div className="drop-overlay"><Paperclip size={22} /> Drop files to attach</div>}
    </div>
  )
}

function RuntimeMenu({ session }: { session: Session }) {
  const catalog = useAppStore(state => state.runtimeCatalog)
  const options = catalog?.backends[session.backend]
  const models = withCurrentRuntime(options?.models ?? [], session.model)
  const efforts = withCurrentRuntime(options?.efforts ?? [], session.effort)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button className="runtime-chip"><span>{runtimeLabel(session, catalog)}</span><ChevronDown size={13} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="menu-content runtime-menu" side="top" align="start">
        <DropdownMenu.Label className="menu-label">Model</DropdownMenu.Label>
        {models.map(option => <DropdownMenu.CheckboxItem key={option.value || 'default'} className="menu-item" checked={(session.model ?? '') === option.value} onCheckedChange={() => void useAppStore.getState().updateSession(session.id, { model: option.value || null })}>{option.label}</DropdownMenu.CheckboxItem>)}
        <DropdownMenu.Separator className="menu-separator" />
        <DropdownMenu.Label className="menu-label">Reasoning</DropdownMenu.Label>
        {efforts.map(option => <DropdownMenu.CheckboxItem key={option.value || 'default'} className="menu-item" checked={(session.effort ?? '') === option.value} onCheckedChange={() => void useAppStore.getState().updateSession(session.id, { effort: option.value || null })}>{option.label}</DropdownMenu.CheckboxItem>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function BackendMenu({ session }: { session: Session }) {
  const chip = <button className="backend-chip" title={isBackendLocked(session) ? 'Backend is fixed after the provider session starts' : 'Change backend'} disabled={isBackendLocked(session)}><BackendMark backend={session.backend} size={17} /><span>{session.backend === 'codex' ? 'Codex' : 'Claude'}</span>{!isBackendLocked(session) && <ChevronDown size={12} />}</button>
  if (isBackendLocked(session)) return chip
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild>{chip}</DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="start">{(['claude', 'codex'] as const).map(backend => <DropdownMenu.CheckboxItem key={backend} className="menu-item" checked={session.backend === backend} onCheckedChange={() => void useAppStore.getState().updateSession(session.id, { backend, model: null, effort: null })}><BackendMark backend={backend} size={15} />{backend === 'claude' ? 'Claude' : 'Codex'}</DropdownMenu.CheckboxItem>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}

function withCurrentRuntime(options: Array<{ value: string; label: string }>, current?: string | null): Array<{ value: string; label: string }> {
  const values = options.some(option => option.value === '') ? options : [{ value: '', label: 'Server default' }, ...options]
  if (!current || values.some(option => option.value === current)) return values
  return [...values, { value: current, label: current }]
}

function AttachmentShelf({ files, pending }: { files: AgentFile[]; pending: NativeFileRef[] }) {
  return <div className="attachment-shelf">
    {files.map(file => <div className="attachment-chip" key={file.id}>{file.content_type?.startsWith('image/') ? <img src={window.agentsDock.files.mediaURL(file.id)} alt="" /> : <File size={15} />}<span><strong>{file.filename}</strong><small>{formatBytes(file.size)}</small></span><button onClick={() => useAppStore.getState().removeUpload(file.id)}><X size={13} /></button></div>)}
    {pending.map(file => <div className="attachment-chip pending" key={file.path}><span className="mini-spinner" /><span><strong>{file.name}</strong><small>Uploading</small></span></div>)}
  </div>
}

function QueueShelf({ sessionId, turns }: { sessionId: string; turns: QueuedTurn[] }) {
  const [editing, setEditing] = useState<QueuedTurn | null>(null)
  const [draft, setDraft] = useState('')
  const [drop, setDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  if (!turns.length) return null
  const moveTo = async (activeId: string, targetId: string, placement: 'before' | 'after') => {
    try {
      const ordered = [...turns].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      const from = ordered.findIndex(turn => turn.queued_id === activeId)
      const target = ordered.findIndex(turn => turn.queued_id === targetId)
      if (from < 0 || target < 0) return
      let to = target + (placement === 'after' ? 1 : 0)
      if (from < to) to -= 1
      let current = from
      while (current !== to) {
        const direction = current < to ? 'down' : 'up'
        const next = await window.agentsDock.queue.move(sessionId, activeId, direction)
        useAppStore.getState().setQueued(sessionId, next); current += direction === 'down' ? 1 : -1
      }
    } catch (error) { reportActionError(error) }
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
  const saveEdit = async (steer = false) => {
    if (!editing) return
    try {
      await window.agentsDock.queue.update(sessionId, editing.queued_id, draft)
      const turns = steer ? await steerQueuedTurn(sessionId, editing.queued_id) : await window.agentsDock.queue.list(sessionId)
      useAppStore.getState().setQueued(sessionId, turns)
      setEditing(null)
    } catch (error) { reportActionError(error) }
  }
  return <div className="queue-shelf"><div className="queue-header"><div className="queue-label"><ListOrdered size={13} /><span>Queued turns</span><b>{turns.length}</b></div></div><DndContext sensors={sensors} onDragOver={onDragOver} onDragEnd={onDragEnd}>
    <div className="queue-list">{turns.map(turn => <QueuedRow key={turn.queued_id} turn={turn} sessionId={sessionId} drop={drop} onEdit={() => { setEditing(turn); setDraft(turn.display_prompt || turn.prompt) }} />)}</div>
  </DndContext>
  {editing && <div className="inline-editor"><textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit(true) } }} autoFocus /><div><button onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" onClick={() => void saveEdit()}>Save</button></div></div>}
  </div>
}

function QueuedRow({ turn, sessionId, drop, onEdit }: { turn: QueuedTurn; sessionId: string; drop: { id: string; placement: 'before' | 'after' } | null; onEdit: () => void }) {
  const drag = useDraggable({ id: turn.queued_id })
  const target = useDroppable({ id: turn.queued_id })
  const ref = (node: HTMLElement | null) => { drag.setNodeRef(node); target.setNodeRef(node) }
  const indicator = drop?.id === turn.queued_id ? `drop-${drop.placement}` : ''
  const refresh = async () => useAppStore.getState().setQueued(sessionId, await window.agentsDock.queue.list(sessionId))
  const runAndRefresh = async (action: () => Promise<unknown>) => {
    try { await action(); await refresh() }
    catch (error) { reportActionError(error) }
  }
  const steer = async () => {
    try { useAppStore.getState().setQueued(sessionId, await steerQueuedTurn(sessionId, turn.queued_id)) }
    catch (error) { reportActionError(error) }
  }
  const move = async (direction: 'up' | 'down') => {
    try { useAppStore.getState().setQueued(sessionId, await window.agentsDock.queue.move(sessionId, turn.queued_id, direction)) }
    catch (error) { reportActionError(error) }
  }
  return <div ref={ref} className={`queued-row ${indicator} ${drag.isDragging ? 'dragging' : ''}`} {...drag.attributes}>
    <button className="queue-grip" title="Drag to reorder" {...drag.listeners}><GripVertical size={13} /></button>
    <span className="queue-prompt" title={turn.display_prompt || turn.prompt}>{turn.display_prompt || turn.prompt}</span>
    <div className="queue-actions">
    <button className="steer-action" title="Interrupt the current turn and send this now (⌘↩ while editing)" onClick={() => void steer()}><CornerDownRight size={13} /> <b>Steer</b></button>
    <button className="queue-action" title="Remove from queue" onClick={() => void runAndRefresh(() => window.agentsDock.queue.remove(sessionId, turn.queued_id))}><Trash2 size={13} /></button>
    <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="queue-action" title="More queue actions"><MoreHorizontal size={13} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" side="top" align="end">
      <DropdownMenu.Item className="menu-item" onSelect={onEdit}><Pencil size={13} /> Edit message</DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" onSelect={() => void move('up')}><ArrowUp size={13} /> Move earlier</DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" onSelect={() => void move('down')}><ArrowDown size={13} /> Move later</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    </div>
  </div>
}

function isBackendLocked(session: Session): boolean { return Boolean(session.session_id || session.claude_session_id || session.codex_thread_id) }

function reportActionError(error: unknown): void {
  useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
}
