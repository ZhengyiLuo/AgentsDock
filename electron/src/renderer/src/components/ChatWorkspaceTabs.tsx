import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, X } from 'lucide-react'
import { t, useLocale } from '../lib/i18n'
import type { ChatWorkspace } from '../lib/chat-panes'
import { useAppStore } from '../store/app-store'

export function ChatWorkspaceTabs() {
  useLocale()
  const workspaces = useAppStore(state => state.chatWorkspaces)
  const activeId = useAppStore(state => state.activeChatWorkspaceId)
  const sessions = useAppStore(state => state.sessions)
  const switching = useAppStore(state => Boolean(state.switchingProfileId))
  const [renaming, setRenaming] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const tabsRef = useRef<HTMLDivElement>(null)
  const dragScope = useRef<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const title = (workspace: ChatWorkspace) => workspace.title
    || sessions.find(session => session.id === workspace.panes.primary)?.title
    || t('chatWorkspace.untitled')
  const scope = () => {
    const state = useAppStore.getState()
    return JSON.stringify([state.activeProfileId, state.profileGeneration,
      state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null])
  }
  useEffect(() => () => { dragScope.current = null }, [])
  useEffect(() => {
    const tabs = tabsRef.current
    if (!tabs) return
    const revealActiveTab = () => {
      if (!tabs.isConnected || dragScope.current) return
      const selected = tabs.querySelector<HTMLElement>('.chat-workspace-tab.active')
      if (!selected) return
      const viewport = tabs.getBoundingClientRect()
      const tab = selected.getBoundingClientRect()
      if (tab.left < viewport.left) tabs.scrollLeft += tab.left - viewport.left
      else if (tab.right > viewport.right) tabs.scrollLeft += tab.right - viewport.right
    }
    revealActiveTab()
    const observer = new ResizeObserver(revealActiveTab)
    observer.observe(tabs)
    return () => observer.disconnect()
  }, [activeId, workspaces.length])

  const move = (id: string, targetId: string) => {
    const state = useAppStore.getState()
    if (state.switchingProfileId || id === targetId) return
    state.moveChatWorkspace(id, targetId)
    const ordered = useAppStore.getState().chatWorkspaces
    const position = ordered.findIndex(workspace => workspace.id === id)
    if (position >= 0) setAnnouncement(t('chatWorkspace.moved', {
      name: title(ordered[position]), position: position + 1, count: ordered.length
    }))
  }
  const finishDrag = ({ active, over }: DragEndEvent) => {
    const ownsDrag = dragScope.current === scope()
    dragScope.current = null
    if (ownsDrag && over) move(String(active.id), String(over.id))
  }
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = workspaces.findIndex(workspace => workspace.id === id)
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (event.altKey && event.shiftKey && direction && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      const target = workspaces[index + direction]
      if (target) move(id, target.id)
      const tab = event.currentTarget
      requestAnimationFrame(() => {
        if (tab.isConnected) tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      })
    } else if (!event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey
      && (direction || event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      event.stopPropagation()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? workspaces.length - 1
        : (index + direction + workspaces.length) % workspaces.length
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }
  }

  return <div className="workspace-tab-controls">
    <DndContext sensors={sensors} collisionDetection={args => {
      const point = args.pointerCoordinates
      const rect = tabsRef.current?.getBoundingClientRect()
      if (point && rect && (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom)) return []
      return closestCenter(args)
    }}
      accessibility={{ screenReaderInstructions: { draggable: t('chatWorkspace.reorderHint') } }}
      onDragStart={() => { dragScope.current = scope() }} onDragEnd={finishDrag}
      onDragCancel={() => { dragScope.current = null }}>
      <div ref={tabsRef} className="chat-workspace-tabs" role="tablist" aria-label={t('chatWorkspace.tabs')}>
        <SortableContext items={workspaces.map(workspace => workspace.id)} strategy={horizontalListSortingStrategy}>
          {workspaces.map(workspace => <WorkspaceTab key={workspace.id} workspace={workspace} title={title(workspace)}
            active={workspace.id === activeId} closeable={workspaces.length > 1} disabled={switching}
            renaming={renaming === workspace.id} onRename={value => setRenaming(value ? workspace.id : null)} onKeyDown={keyDown} />)}
        </SortableContext>
      </div>
    </DndContext>
    <button type="button" className="icon-button workspace-add" aria-label={t('chatWorkspace.new')} title={t('chatWorkspace.new')}
      disabled={switching} onClick={() => void useAppStore.getState().createChatWorkspace()}><Plus size={16} /></button>
    <span className="sr-only" role="status">{announcement}</span>
  </div>
}

function WorkspaceTab({ workspace, title, active, closeable, disabled, renaming, onRename, onKeyDown }: {
  workspace: ChatWorkspace; title: string; active: boolean; closeable: boolean; disabled: boolean; renaming: boolean
  onRename: (value: boolean) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void
}) {
  const [name, setName] = useState(title)
  const cancelledRename = useRef(false)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id, disabled: disabled || renaming
  })
  return <div ref={setNodeRef} data-workspace-id={workspace.id}
    className={`chat-workspace-tab${active ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
    style={{ transform: CSS.Translate.toString(transform), transition }}>
    {renaming ? <input autoFocus aria-label={t('chatWorkspace.name')} value={name} onChange={event => setName(event.target.value)}
      onBlur={() => { if (!cancelledRename.current) useAppStore.getState().renameChatWorkspace(workspace.id, name.trim()); onRename(false) }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { event.preventDefault(); cancelledRename.current = true; onRename(false) }
      }} />
      : <button ref={setActivatorNodeRef} {...attributes} {...listeners} type="button" role="tab" aria-label={title}
        aria-selected={active} aria-pressed={undefined} aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
        tabIndex={active ? 0 : -1} disabled={disabled} title={`${title}\n${t('chatWorkspace.reorderHint')}`}
        onKeyDown={event => onKeyDown(event, workspace.id)}
        onClick={() => void useAppStore.getState().selectChatWorkspace(workspace.id)}
        onDoubleClick={() => { setName(title); cancelledRename.current = false; onRename(true) }}>
        <span>{title}</span><small aria-hidden="true">{workspace.paneCount}</small>
      </button>}
    {closeable && <button type="button" className="workspace-tab-close" aria-label={t('chatWorkspace.close', { name: title })}
      disabled={disabled} onClick={() => void useAppStore.getState().closeChatWorkspace(workspace.id)}><X size={12} /></button>}
  </div>
}
