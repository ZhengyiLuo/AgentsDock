import { useEffect, useMemo, useRef, useState } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent
} from '@dnd-kit/core'
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, Folder, FolderPlus, GripVertical, Inbox, MoreHorizontal,
  PanelLeftClose, Pin, PinOff, Plus, RefreshCw, Search, Settings, Trash2, Undo2
} from 'lucide-react'
import type { Session } from '@shared/types'
import { runtimeLabel } from '../lib/format'
import { sessionMatchesQuery } from '../lib/sessions'
import { sessionUnread, useAppStore } from '../store/app-store'
import { BackendMark } from './BackendMark'

interface Section { id: string; title: string; sessions: Session[]; kind: 'pinned' | 'folder' | 'archived' }
interface DropIndicator { id: string; placement: 'before' | 'after' | 'inside' }
interface DragItemData { type: 'session' | 'folder'; label?: string; section?: string }

export const SIDEBAR_LONG_PRESS = { delay: 280, tolerance: 6 } as const

export type SidebarDropOperation =
  | { kind: 'reorder-folder'; order: string[] }
  | { kind: 'move-session'; sessionId: string; folder: string }
  | { kind: 'reorder-session'; sessionId: string; targetId: string; placement: 'before' | 'after' }

const sidebarCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type
  const droppableContainers = activeType === 'folder'
    ? args.droppableContainers.filter(container => container.data.current?.type === 'folder')
    : args.droppableContainers
  return closestCenter({ ...args, droppableContainers })
}

export function Sidebar() {
  const sessions = useAppStore(state => state.sessions)
  const selectedId = useAppStore(state => state.selectedSessionId)
  const folderOrder = useAppStore(state => state.folderOrder)
  const collapsed = useAppStore(state => state.collapsedFolders)
  const archivedCollapsed = useAppStore(state => state.archivedCollapsed)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState<{ id: string; label: string; type: 'session' | 'folder' } | null>(null)
  const [drop, setDrop] = useState<DropIndicator | null>(null)
  const dropRef = useRef<DropIndicator | null>(null)
  const suppressClickRef = useRef<string | null>(null)
  const suppressClickTimer = useRef<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: SIDEBAR_LONG_PRESS }))
  const sections = useMemo(() => buildSections(sessions, folderOrder, query), [sessions, folderOrder, query])
  const folders = useMemo(() => orderedFolders(
    [...new Set([...folderOrder, ...sessions.filter(session => !session.archived && !session.pinned).map(session => session.folder?.trim() || 'General')])],
    folderOrder
  ), [folderOrder, sessions])

  useEffect(() => () => {
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
  }, [])

  const updateDrop = (next: DropIndicator | null) => {
    dropRef.current = next
    setDrop(current => current?.id === next?.id && current?.placement === next?.placement ? current : next)
  }
  const finishDrag = () => {
    setDragging(null)
    updateDrop(null)
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
    suppressClickTimer.current = window.setTimeout(() => {
      suppressClickRef.current = null
      suppressClickTimer.current = null
    }, 0)
  }

  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragItemData | undefined
    if (!data) return
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
    suppressClickRef.current = String(event.active.id)
    setDragging({ id: String(event.active.id), label: data.label ?? '', type: data.type })
  }
  const onDragOver = (event: DragOverEvent) => {
    if (!event.over || event.active.id === event.over.id) { updateDrop(null); return }
    const activeData = event.active.data.current as DragItemData | undefined
    const overData = event.over.data.current as DragItemData | undefined
    if (activeData?.type === 'session' && overData?.type === 'folder') {
      updateDrop({ id: String(event.over.id), placement: 'inside' })
      return
    }
    if (activeData?.type === 'session' && overData?.type === 'session' && activeData.section !== overData.section) {
      updateDrop(null)
      return
    }
    const translated = event.active.rect.current.translated
    const center = translated ? translated.top + translated.height / 2 : 0
    const placement = center < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after'
    const overId = activeData?.type === 'folder' && overData?.type === 'session' && overData.section?.startsWith('folder:')
      ? overData.section
      : String(event.over.id)
    updateDrop({ id: overId, placement })
  }
  const onDragEnd = async (event: DragEndEvent) => {
    const operation = resolveSidebarDrop(
      String(event.active.id),
      event.active.data.current as DragItemData | undefined,
      event.over ? String(event.over.id) : null,
      event.over?.data.current as DragItemData | undefined,
      dropRef.current,
      folders
    )
    finishDrag()
    if (!operation) return
    if (operation.kind === 'reorder-folder') {
      useAppStore.getState().setFolderOrder(operation.order)
    } else if (operation.kind === 'move-session') {
      await useAppStore.getState().updateSession(operation.sessionId, { folder: operation.folder, pinned: false, archived: false })
    } else {
      try {
        const next = await window.agentsDock.sessions.reorder(operation.sessionId, operation.targetId, operation.placement)
        useAppStore.setState({ sessions: next })
      } catch (error) { useAppStore.getState().setError(error instanceof Error ? error.message : String(error)) }
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-drag-region" />
      <div className="sidebar-topbar">
        <strong>AgentsDock</strong>
        <div className="toolbar-cluster">
          <button className="icon-button" title="Refresh" onClick={() => void useAppStore.getState().refreshSessions()}><RefreshCw size={15} /></button>
          <button className="icon-button" title="New chat" onClick={() => useAppStore.getState().setModal('newChat', true)}><Plus size={17} /></button>
        </div>
      </div>
      <div className="sidebar-actions">
        <button className="sidebar-action" title="Resume chat" aria-label="Resume chat" onClick={() => useAppStore.getState().setModal('resume', true)}><Undo2 size={15} /></button>
        <button className="sidebar-action" title="New folder" aria-label="New folder" onClick={() => useAppStore.getState().setModal('folder', true)}><FolderPlus size={15} /></button>
        <button className="sidebar-action" title="Settings" aria-label="Settings" onClick={() => useAppStore.getState().setModal('settings', true)}><Settings size={15} /></button>
      </div>
      <label className="sidebar-search">
        <Search size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { const first = sections.flatMap(section => section.sessions)[0]; if (first) void useAppStore.getState().selectSession(first.id) } }} placeholder="Search chats" />
        <kbd>⌘P</kbd>
      </label>
      <DndContext collisionDetection={sidebarCollisionDetection} sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={finishDrag}>
        <div className="session-list">
          {sections.map(section => (
            <SidebarSection
              key={section.id}
              section={section}
              selectedId={selectedId}
              collapsed={section.kind === 'archived' ? archivedCollapsed : section.kind === 'folder' && collapsed.has(section.title)}
              drop={drop}
              runtime={(session) => runtimeLabel(session, catalog)}
              suppressClick={(id) => suppressClickRef.current === id}
            />
          ))}
          {!sections.some(section => section.sessions.length) && <div className="sidebar-empty">No chats found</div>}
        </div>
        <DragOverlay dropAnimation={null}>{dragging && <div className="drag-overlay"><GripVertical size={13} />{dragging.label}</div>}</DragOverlay>
      </DndContext>
      <div className="sidebar-footer">
        <span>{sessions.filter(session => !session.archived).length} chats</span>
      </div>
    </aside>
  )
}

function SidebarSection({ section, selectedId, collapsed, drop, runtime, suppressClick }: {
  section: Section; selectedId: string | null; collapsed: boolean; drop: DropIndicator | null; runtime: (session: Session) => string; suppressClick: (id: string) => boolean
}) {
  const toggle = () => {
    if (section.kind === 'archived') useAppStore.getState().setArchivedCollapsed(!collapsed)
    else if (section.kind === 'folder') useAppStore.getState().toggleFolder(section.title)
  }
  return (
    <section className="sidebar-section">
      <FolderHeader section={section} collapsed={collapsed} drop={drop} onToggle={toggle} suppressClick={suppressClick} />
      {!collapsed && section.sessions.map(session => (
        <SessionRow key={session.id} session={session} selected={session.id === selectedId} sectionId={section.id} drop={drop} runtime={runtime(session)} suppressClick={suppressClick} />
      ))}
    </section>
  )
}

function FolderHeader({ section, collapsed, drop, onToggle, suppressClick }: { section: Section; collapsed: boolean; drop: DropIndicator | null; onToggle: () => void; suppressClick: (id: string) => boolean }) {
  const id = `folder:${section.title}`
  const draggable = useDraggable({ id, disabled: section.kind !== 'folder', data: { type: 'folder', label: section.title } })
  const droppable = useDroppable({ id, disabled: section.kind !== 'folder', data: { type: 'folder' } })
  const ref = (node: HTMLElement | null) => { draggable.setNodeRef(node); droppable.setNodeRef(node) }
  const indicator = drop?.id === id ? `drop-${drop.placement}` : ''
  return (
    <div ref={ref} className={`section-header ${indicator} ${draggable.isDragging ? 'dragging' : ''}`}>
      <button onClick={() => { if (!suppressClick(id)) onToggle() }} {...draggable.listeners} {...draggable.attributes}>
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        {section.kind === 'pinned' ? <Pin size={11} /> : section.kind === 'archived' ? <Archive size={11} /> : <Folder size={11} />}
        <span>{section.title}</span><small>{section.sessions.length}</small>
      </button>
    </div>
  )
}

function SessionRow({ session, selected, sectionId, drop, runtime, suppressClick }: { session: Session; selected: boolean; sectionId: string; drop: DropIndicator | null; runtime: string; suppressClick: (id: string) => boolean }) {
  const id = `session:${session.id}`
  const draggable = useDraggable({ id, data: { type: 'session', label: session.title, section: sectionId } })
  const droppable = useDroppable({ id, data: { type: 'session', section: sectionId } })
  const ref = (node: HTMLElement | null) => { draggable.setNodeRef(node); droppable.setNodeRef(node) }
  const unread = sessionUnread(session)
  const running = useAppStore(state => state.activeSessionIds.has(session.id))
  const indicator = drop?.id === id ? `drop-${drop.placement}` : ''
  const prefetchTimer = useRef<number | null>(null)
  useEffect(() => () => { if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current) }, [])
  const schedulePrefetch = () => {
    if (session.archived || selected) return
    if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null
      void useAppStore.getState().prefetchSession(session.id)
    }, 180)
  }
  const cancelPrefetch = () => {
    if (!prefetchTimer.current) return
    window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = null
  }
  const select = () => { if (!suppressClick(id)) void useAppStore.getState().selectSession(session.id) }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={ref}
          className={`session-row ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${indicator} ${draggable.isDragging ? 'dragging' : ''}`}
          onClick={select}
          onMouseEnter={schedulePrefetch}
          onMouseLeave={cancelPrefetch}
          onKeyDown={event => { if (event.key === 'Enter') select() }}
          {...draggable.listeners}
          {...draggable.attributes}
        >
          <BackendMark backend={session.backend} size={18} />
          <span className="session-copy"><strong>{session.title}</strong><small>{session.backend === 'codex' ? 'Codex' : 'Claude'} · {runtime}{running ? ' · running' : unread ? ' · new' : ''}</small></span>
          {(running || unread) && <span className={`status-dot ${running ? 'running' : 'unread'}`} />}
        </div>
      </ContextMenu.Trigger>
      <SessionContextMenu session={session} unread={unread} />
    </ContextMenu.Root>
  )
}

function SessionContextMenu({ session, unread }: { session: Session; unread: boolean }) {
  const update = useAppStore(state => state.updateSession)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const folders = orderedFolders([...new Set([...folderOrder, ...sessions.filter(candidate => !candidate.archived).map(candidate => candidate.folder?.trim() || 'General')])], folderOrder)
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <MenuItem icon={unread ? Inbox : Inbox} label={unread ? 'Mark as Read' : 'Mark as Unread'} onSelect={() => unread ? void useAppStore.getState().markRead(session.id, true) : void useAppStore.getState().markUnread(session.id)} />
        <MenuItem icon={session.pinned ? PinOff : Pin} label={session.pinned ? 'Unpin Chat' : 'Pin Chat'} onSelect={() => void update(session.id, { pinned: !session.pinned })} />
        {!session.archived && <ContextMenu.Sub><ContextMenu.SubTrigger className="menu-item"><Folder size={14} />Move to folder<ChevronRight size={13} className="submenu-arrow" /></ContextMenu.SubTrigger><ContextMenu.Portal><ContextMenu.SubContent className="menu-content" sideOffset={3}>{folders.map(folder => <ContextMenu.Item className="menu-item" key={folder} onSelect={() => void update(session.id, { folder, pinned: false })}>{folder}</ContextMenu.Item>)}</ContextMenu.SubContent></ContextMenu.Portal></ContextMenu.Sub>}
        <MenuItem icon={session.archived ? ArchiveRestore : Archive} label={session.archived ? 'Unarchive Chat' : 'Archive Chat'} onSelect={() => void update(session.id, { archived: !session.archived })} />
        <ContextMenu.Separator className="menu-separator" />
        <MenuItem icon={Undo2} label="Fork Chat" onSelect={() => void useAppStore.getState().forkSession(session.id)} />
        <MenuItem icon={Trash2} label="Delete Chat" danger onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-delete', { detail: session }))} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}

function MenuItem({ icon: Icon, label, onSelect, danger }: { icon: typeof MoreHorizontal; label: string; onSelect: () => void; danger?: boolean }) {
  return <ContextMenu.Item className={`menu-item ${danger ? 'danger' : ''}`} onSelect={onSelect}><Icon size={14} />{label}</ContextMenu.Item>
}

function buildSections(sessions: Session[], folderOrder: string[], query: string): Section[] {
  const filtered = sessions.filter(session => sessionMatchesQuery(session, query))
  const pinned = filtered.filter(session => session.pinned && !session.archived)
  const archived = filtered.filter(session => session.archived)
  const byFolder = new Map<string, Session[]>()
  for (const session of filtered.filter(session => !session.archived && !session.pinned)) {
    const folder = session.folder?.trim() || 'General'
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), session])
  }
  const folders = orderedFolders(query.trim() ? [...byFolder.keys()] : [...new Set([...folderOrder, ...byFolder.keys()])], folderOrder)
  return [
    ...(pinned.length ? [{ id: 'pinned', title: 'Pinned', sessions: pinned, kind: 'pinned' as const }] : []),
    ...folders.map(folder => ({ id: `folder:${folder}`, title: folder, sessions: byFolder.get(folder) ?? [], kind: 'folder' as const })),
    ...(archived.length ? [{ id: 'archived', title: 'Archived', sessions: archived, kind: 'archived' as const }] : [])
  ]
}

function orderedFolders(folders: string[], order: string[]): string[] {
  const index = new Map(order.map((folder, i) => [folder, i]))
  return [...folders].sort((a, b) => (index.get(a) ?? Number.MAX_SAFE_INTEGER) - (index.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
}

export function reorderFolderList(folders: string[], active: string, target: string, placement: 'before' | 'after'): string[] {
  if (active === target || !folders.includes(active) || !folders.includes(target)) return folders
  const reordered = folders.filter(folder => folder !== active)
  let index = reordered.indexOf(target)
  if (placement === 'after') index += 1
  reordered.splice(Math.max(0, index), 0, active)
  return reordered
}

export function resolveSidebarDrop(
  activeId: string,
  activeData: DragItemData | undefined,
  overId: string | null,
  overData: DragItemData | undefined,
  drop: DropIndicator | null,
  folders: string[]
): SidebarDropOperation | null {
  if (!overId || !drop || activeId === overId) return null
  if (activeData?.type === 'folder' && drop.id.startsWith('folder:') && drop.placement !== 'inside') {
    const active = activeId.replace('folder:', '')
    const target = drop.id.replace('folder:', '')
    const order = reorderFolderList(folders, active, target, drop.placement)
    return order === folders ? null : { kind: 'reorder-folder', order }
  }
  if (activeData?.type === 'session' && overData?.type === 'folder') {
    return { kind: 'move-session', sessionId: activeId.replace('session:', ''), folder: overId.replace('folder:', '') }
  }
  if (activeData?.type === 'session' && overData?.type === 'session' && activeData.section === overData.section && drop.placement !== 'inside') {
    return {
      kind: 'reorder-session',
      sessionId: activeId.replace('session:', ''),
      targetId: overId.replace('session:', ''),
      placement: drop.placement
    }
  }
  return null
}
