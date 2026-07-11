import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef
} from 'react'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'

export const SIDEBAR_MIN_WIDTH = 210
export const SIDEBAR_MAX_WIDTH = 460
export const INSPECTOR_MIN_WIDTH = 280
export const INSPECTOR_MAX_WIDTH = 680
export const DEFAULT_SIDEBAR_WIDTH = 282
export const DEFAULT_INSPECTOR_WIDTH = 350
const MIN_CONVERSATION_WIDTH = 520
const SIDEBAR_WIDTH_KEY = 'agentsdock:sidebar-width'
const INSPECTOR_WIDTH_KEY = 'agentsdock:inspector-width'

type Panel = 'sidebar' | 'inspector'

interface ResizeDrag {
  panel: Panel
  pointerId: number
  startX: number
  startWidth: number
  currentWidth: number
  shell: HTMLElement
}

export function savedWorkspaceColumnStyle(viewportWidth = window.innerWidth): CSSProperties {
  const compact = viewportWidth <= 1040
  const medium = viewportWidth <= 1240
  const sidebarDefault = compact ? 230 : medium ? 245 : DEFAULT_SIDEBAR_WIDTH
  const inspectorDefault = compact ? 330 : medium ? 310 : DEFAULT_INSPECTOR_WIDTH
  let sidebar = savedWidth(SIDEBAR_WIDTH_KEY, sidebarDefault, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  let inspector = savedWidth(INSPECTOR_WIDTH_KEY, inspectorDefault, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH)
  if (!compact) {
    inspector = clampWorkspacePanelWidth('inspector', inspector, viewportWidth, sidebar, true)
    sidebar = clampWorkspacePanelWidth('sidebar', sidebar, viewportWidth, inspector, true)
  }
  return {
    '--sidebar-width': `${sidebar}px`,
    '--inspector-width': `${inspector}px`
  } as CSSProperties
}

export function clampWorkspacePanelWidth(
  panel: Panel,
  width: number,
  viewportWidth: number,
  otherWidth: number,
  inspectorOpen: boolean
): number {
  if (panel === 'sidebar') {
    const reservedInspector = viewportWidth > 1040 && inspectorOpen ? otherWidth : 0
    const maximum = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - reservedInspector - MIN_CONVERSATION_WIDTH))
    return Math.round(Math.min(maximum, Math.max(SIDEBAR_MIN_WIDTH, width)))
  }
  const maximum = viewportWidth <= 1040
    ? Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, viewportWidth - 80))
    : Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, viewportWidth - otherWidth - MIN_CONVERSATION_WIDTH))
  return Math.round(Math.min(maximum, Math.max(INSPECTOR_MIN_WIDTH, width)))
}

export function WorkspaceResizeHandles({ inspectorOpen }: { inspectorOpen: boolean }) {
  const drag = useRef<ResizeDrag | null>(null)

  useEffect(() => () => finishResize(drag, null), [])

  const begin = (panel: Panel, event: ReactPointerEvent<HTMLDivElement>) => {
    const shell = event.currentTarget.parentElement
    if (!shell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startWidth = panelWidth(shell, panel)
    drag.current = { panel, pointerId: event.pointerId, startX: event.clientX, startWidth, currentWidth: startWidth, shell }
    shell.classList.add('column-resizing')
    document.body.classList.add('column-resizing')
    notifyTimelineViewportLayout('begin')
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const other = panelWidth(current.shell, current.panel === 'sidebar' ? 'inspector' : 'sidebar')
    const proposed = current.panel === 'sidebar'
      ? current.startWidth + event.clientX - current.startX
      : current.startWidth + current.startX - event.clientX
    current.currentWidth = clampWorkspacePanelWidth(current.panel, proposed, window.innerWidth, other, inspectorOpen)
    setPanelWidth(current.shell, current.panel, current.currentWidth)
    notifyTimelineViewportLayout('update')
  }
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    finishResize(drag, current.panel)
  }
  const reset = (panel: Panel, event: ReactMouseEvent<HTMLDivElement>) => {
    const shell = event.currentTarget.parentElement
    if (!shell) return
    const other = panelWidth(shell, panel === 'sidebar' ? 'inspector' : 'sidebar')
    const preferred = panel === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_INSPECTOR_WIDTH
    const width = clampWorkspacePanelWidth(panel, preferred, window.innerWidth, other, inspectorOpen)
    notifyTimelineViewportLayout('begin')
    setPanelWidth(shell, panel, width)
    persistWidth(panel, width)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }
  const keyResize = (panel: Panel, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const shell = event.currentTarget.parentElement
    if (!shell) return
    const step = event.shiftKey ? 40 : 16
    const direction = panel === 'sidebar' ? 1 : -1
    let delta = 0
    if (event.key === 'ArrowLeft') delta = -step * direction
    if (event.key === 'ArrowRight') delta = step * direction
    if (!delta) return
    event.preventDefault()
    const other = panelWidth(shell, panel === 'sidebar' ? 'inspector' : 'sidebar')
    const width = clampWorkspacePanelWidth(panel, panelWidth(shell, panel) + delta, window.innerWidth, other, inspectorOpen)
    notifyTimelineViewportLayout('begin')
    setPanelWidth(shell, panel, width)
    persistWidth(panel, width)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }

  const handle = (panel: Panel) => <div
    className={`workspace-resize-handle ${panel}${panel === 'inspector' && !inspectorOpen ? ' hidden' : ''}`}
    role="separator"
    aria-label={`Resize ${panel === 'sidebar' ? 'chat list' : 'details panel'}`}
    aria-orientation="vertical"
    tabIndex={panel === 'inspector' && !inspectorOpen ? -1 : 0}
    title="Drag to resize · double-click to reset"
    onPointerDown={event => begin(panel, event)}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onDoubleClick={event => reset(panel, event)}
    onKeyDown={event => keyResize(panel, event)}
  />

  return <>{handle('sidebar')}{handle('inspector')}</>
}

function savedWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(minimum, value)) : fallback
}

function panelWidth(shell: HTMLElement, panel: Panel): number {
  const value = getComputedStyle(shell).getPropertyValue(panel === 'sidebar' ? '--sidebar-width' : '--inspector-width')
  return Number.parseFloat(value) || (panel === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_INSPECTOR_WIDTH)
}

function setPanelWidth(shell: HTMLElement, panel: Panel, width: number): void {
  shell.style.setProperty(panel === 'sidebar' ? '--sidebar-width' : '--inspector-width', `${width}px`)
}

function persistWidth(panel: Panel, width: number): void {
  window.localStorage.setItem(panel === 'sidebar' ? SIDEBAR_WIDTH_KEY : INSPECTOR_WIDTH_KEY, String(width))
}

function finishResize(drag: MutableRefObject<ResizeDrag | null>, panel: Panel | null): void {
  const current = drag.current
  if (!current) return
  current.shell.classList.remove('column-resizing')
  document.body.classList.remove('column-resizing')
  persistWidth(panel ?? current.panel, current.currentWidth)
  drag.current = null
  window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
}
