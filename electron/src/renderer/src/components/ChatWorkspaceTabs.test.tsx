import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { ChatWorkspaceTabs } from './ChatWorkspaceTabs'

const drag = vi.hoisted(() => ({ start: () => {}, cancel: () => {}, end: (_event: DragEndEvent) => {} }))
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragCancel, onDragEnd }: {
    children: ReactNode; onDragStart: () => void; onDragCancel: () => void; onDragEnd: (event: DragEndEvent) => void
  }) => { drag.start = onDragStart; drag.cancel = onDragCancel; drag.end = onDragEnd; return children },
  PointerSensor: class {}, closestCenter: vi.fn(), useSensor: () => ({}), useSensors: () => []
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  horizontalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, setActivatorNodeRef: () => {}, isDragging: false })
}))

describe('workspace tab interactions', () => {
  let persist: ReturnType<typeof vi.fn>
  beforeEach(() => {
    persist = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { setScoped: persist, set: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ ...useAppStore.getInitialState(), activeProfileId: 'one', profileGeneration: 1,
      activeChatWorkspaceId: 'a', chatPaneCount: 1, chatPanes: { primary: null, secondary: null },
      chatWorkspaces: ['a', 'b', 'c'].map(id => ({ id, title: id.toUpperCase(), paneCount: 1,
        panes: { primary: null, secondary: null }, focusedPane: 'primary', columnRatio: 0.5, rowRatio: 0.5 }))
    }, true)
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  const order = () => screen.getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))
  const drop = (active: string, over: string | null) => act(() => drag.end({
    active: { id: active }, over: over ? { id: over } : null
  } as DragEndEvent))

  it('reorders inactive and active tabs through drag completion without selecting another workspace', () => {
    render(<ChatWorkspaceTabs />)
    act(() => drag.start())
    drop('c', 'a')
    expect(order()).toEqual(['C', 'A', 'B'])
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
    act(() => drag.start())
    drop('a', 'b')
    expect(order()).toEqual(['C', 'B', 'A'])
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('a')
    expect(screen.getByRole('status')).toHaveTextContent('Moved A to position 3 of 3.')
  })

  it('moves a focused tab with Alt+Shift+arrows and keeps focus and active selection', () => {
    render(<ChatWorkspaceTabs />)
    const tab = screen.getByRole('tab', { name: 'B' })
    tab.focus()
    fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(order()).toEqual(['B', 'A', 'C'])
    expect(tab).toHaveFocus()
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('a')
    expect(tab).toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight')
    persist.mockClear()
    fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(persist).not.toHaveBeenCalled()
    fireEvent.keyDown(tab, { key: 'ArrowRight', altKey: true, shiftKey: true })
    expect(order()).toEqual(['A', 'B', 'C'])
  })

  it('keeps the active tab visible when its rail shrinks without snapping back during a drag', () => {
    let resize: ResizeObserverCallback = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    const view = render(<ChatWorkspaceTabs />)
    const rail = screen.getByRole('tablist')
    const selected = screen.getByRole('tab', { name: 'A' }).closest('.chat-workspace-tab')!
    let width = 1000
    vi.spyOn(rail, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: width }) as DOMRect)
    vi.spyOn(selected, 'getBoundingClientRect').mockImplementation(() => ({
      left: 800 - rail.scrollLeft, right: 900 - rail.scrollLeft
    }) as DOMRect)
    const notifyResize = () => act(() => resize([], {} as ResizeObserver))
    expect(observe).toHaveBeenCalledWith(rail)
    notifyResize()
    expect(rail.scrollLeft).toBe(0)
    width = 600
    notifyResize()
    expect(rail.scrollLeft).toBe(300)
    act(() => drag.start())
    width = 450
    notifyResize()
    expect(rail.scrollLeft).toBe(300)
    act(() => drag.cancel())
    width = 440
    notifyResize()
    expect(rail.scrollLeft).toBe(460)
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('a')
    expect(persist).not.toHaveBeenCalled()
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    width = 100
    notifyResize()
    expect(rail.scrollLeft).toBe(460)
  })

  it('navigates tab focus without reordering and keeps rename, close and adjacent add actions', async () => {
    const view = render(<ChatWorkspaceTabs />)
    const first = screen.getByRole('tab', { name: 'A' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus()
    expect(order()).toEqual(['A', 'B', 'C'])
    expect(persist).not.toHaveBeenCalled()
    fireEvent.doubleClick(first)
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'Renamed' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Workspace name' }), { key: 'Enter' })
    expect(screen.getByRole('tab', { name: 'Renamed' })).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Renamed' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'Discard this rename' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Workspace name' }), { key: 'Escape' })
    expect(screen.getByRole('tab', { name: 'Renamed' })).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close B' })))
    expect(order()).toEqual(['Renamed', 'C'])
    const add = screen.getByRole('button', { name: 'New workspace' })
    expect(view.container.querySelector('.chat-workspace-tabs')?.nextElementSibling).toBe(add)
    await act(async () => fireEvent.click(add))
    expect(order()).toEqual(['Renamed', 'C', 'Workspace'])
  })

  it.each(['cancel', 'outside', 'profile', 'generation', 'switching', 'unmount'] as const)(
    'ignores an unfinished drag after %s', reason => {
      const view = render(<ChatWorkspaceTabs />)
      act(() => drag.start())
      const finish = drag.end
      if (reason === 'cancel') act(() => drag.cancel())
      if (reason === 'profile') act(() => useAppStore.setState({ activeProfileId: 'two' }))
      if (reason === 'generation') act(() => useAppStore.setState({ profileGeneration: 2 }))
      if (reason === 'switching') act(() => useAppStore.setState({ switchingProfileId: 'two' }))
      if (reason === 'unmount') view.unmount()
      act(() => finish({ active: { id: 'c' }, over: reason === 'outside' ? null : { id: 'a' } } as DragEndEvent))
      expect(useAppStore.getState().chatWorkspaces.map(workspace => workspace.id)).toEqual(['a', 'b', 'c'])
      expect(persist).not.toHaveBeenCalled()
    }
  )
})
