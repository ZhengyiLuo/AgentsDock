// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
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
export const REVIEW_MIN_WIDTH = 420
export const REVIEW_MAX_WIDTH = 1100
export const DEFAULT_SIDEBAR_WIDTH = 282
export const DEFAULT_INSPECTOR_WIDTH = 350
export const DEFAULT_REVIEW_WIDTH = 820
const MIN_CONVERSATION_WIDTH = 520
const SIDEBAR_WIDTH_KEY = 'agentsdock:sidebar-width'
const SIDEBAR_VISIBLE_KEY = 'agentsdock:sidebar-visible'
const INSPECTOR_WIDTH_KEY = 'agentsdock:inspector-width'
const REVIEW_WIDTH_KEY = 'agentsdock:review-width'

type Panel = 'sidebar' | 'inspector' | 'review'

interface ResizeDrag {
  panel: Panel
  workspaceKey: string
  pointerId: number
  startX: number
  startWidth: number
  currentWidth: number
  shell: HTMLElement
}

export function workspacePanelStorageKey(workspaceKey: string, panel: Panel): string {
  const baseKey = panel === 'sidebar' ? SIDEBAR_WIDTH_KEY : panel === 'review' ? REVIEW_WIDTH_KEY : INSPECTOR_WIDTH_KEY
  return `${baseKey}:${encodeURIComponent(workspaceKey)}`
}

export function workspaceSidebarVisibilityStorageKey(workspaceKey: string): string {
  return `${SIDEBAR_VISIBLE_KEY}:${encodeURIComponent(workspaceKey)}`
}

export function savedWorkspaceSidebarVisible(workspaceKey: string): boolean {
  const scopedValue = window.localStorage.getItem(workspaceSidebarVisibilityStorageKey(workspaceKey))
  const value = scopedValue ?? window.localStorage.getItem(SIDEBAR_VISIBLE_KEY)
  return value !== 'false'
}

export function persistWorkspaceSidebarVisible(workspaceKey: string, visible: boolean): void {
  window.localStorage.setItem(workspaceSidebarVisibilityStorageKey(workspaceKey), String(visible))
}

export function savedWorkspaceColumnStyle(workspaceKey: string, viewportWidth = window.innerWidth): CSSProperties {
  const compact = viewportWidth <= 1040
  const medium = viewportWidth <= 1240
  const sidebarDefault = compact ? 230 : medium ? 245 : DEFAULT_SIDEBAR_WIDTH
  const inspectorDefault = compact ? 330 : medium ? 310 : DEFAULT_INSPECTOR_WIDTH
  let sidebar = savedWidth(workspacePanelStorageKey(workspaceKey, 'sidebar'), SIDEBAR_WIDTH_KEY, sidebarDefault, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  let inspector = savedWidth(workspacePanelStorageKey(workspaceKey, 'inspector'), INSPECTOR_WIDTH_KEY, inspectorDefault, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH)
  const reviewDefault = Math.min(DEFAULT_REVIEW_WIDTH, Math.max(REVIEW_MIN_WIDTH, viewportWidth - sidebar - MIN_CONVERSATION_WIDTH))
  let review = savedWidth(workspacePanelStorageKey(workspaceKey, 'review'), REVIEW_WIDTH_KEY, reviewDefault, REVIEW_MIN_WIDTH, REVIEW_MAX_WIDTH)
  if (!compact) {
    inspector = clampWorkspacePanelWidth('inspector', inspector, viewportWidth, sidebar, true)
    review = clampWorkspacePanelWidth('review', review, viewportWidth, sidebar, true)
    sidebar = clampWorkspacePanelWidth('sidebar', sidebar, viewportWidth, inspector, true)
  }
  return {
    '--sidebar-width': `${sidebar}px`,
    '--inspector-width': `${inspector}px`,
    '--review-width': `${review}px`
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
  const minimum = panel === 'review' ? REVIEW_MIN_WIDTH : INSPECTOR_MIN_WIDTH
  const configuredMaximum = panel === 'review' ? REVIEW_MAX_WIDTH : INSPECTOR_MAX_WIDTH
  const maximum = viewportWidth <= 1040
    ? Math.max(minimum, Math.min(configuredMaximum, viewportWidth - 80))
    : Math.max(minimum, Math.min(configuredMaximum, viewportWidth - otherWidth - MIN_CONVERSATION_WIDTH))
  return Math.round(Math.min(maximum, Math.max(minimum, width)))
}

export function WorkspaceResizeHandles({
  workspaceKey,
  sidebarVisible = true,
  inspectorOpen,
  inspectorMode = 'inspector'
}: {
  workspaceKey: string
  sidebarVisible?: boolean
  inspectorOpen: boolean
  inspectorMode?: 'inspector' | 'review'
}) {
  useLocale()
  const drag = useRef<ResizeDrag | null>(null)
  const dockPanel: Panel = inspectorMode

  useEffect(() => () => finishResize(drag, null), [])

  const begin = (panel: Panel, event: ReactPointerEvent<HTMLDivElement>) => {
    const shell = event.currentTarget.parentElement
    if (!shell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startWidth = panelWidth(shell, panel)
    drag.current = { panel, workspaceKey, pointerId: event.pointerId, startX: event.clientX, startWidth, currentWidth: startWidth, shell }
    shell.classList.add('column-resizing')
    document.body.classList.add('column-resizing')
    notifyTimelineViewportLayout('begin')
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const other = panelWidth(current.shell, current.panel === 'sidebar' ? dockPanel : 'sidebar')
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
    const other = panelWidth(shell, panel === 'sidebar' ? dockPanel : 'sidebar')
    const preferred = panel === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : panel === 'review' ? DEFAULT_REVIEW_WIDTH : DEFAULT_INSPECTOR_WIDTH
    const width = clampWorkspacePanelWidth(panel, preferred, window.innerWidth, other, inspectorOpen)
    notifyTimelineViewportLayout('begin')
    setPanelWidth(shell, panel, width)
    persistWidth(workspaceKey, panel, width)
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
    const other = panelWidth(shell, panel === 'sidebar' ? dockPanel : 'sidebar')
    const width = clampWorkspacePanelWidth(panel, panelWidth(shell, panel) + delta, window.innerWidth, other, inspectorOpen)
    notifyTimelineViewportLayout('begin')
    setPanelWidth(shell, panel, width)
    persistWidth(workspaceKey, panel, width)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }

  const handle = (panel: Panel, visualPanel: 'sidebar' | 'inspector' = panel === 'sidebar' ? 'sidebar' : 'inspector') => <div
    className={`workspace-resize-handle ${visualPanel}${visualPanel === 'sidebar' && !sidebarVisible ? ' hidden' : ''}${visualPanel === 'inspector' && !inspectorOpen ? ' hidden' : ''}`}
    role="separator"
    aria-label={`Resize ${panel === 'sidebar' ? 'chat list' : panel === 'review' ? 'code review panel' : 'details panel'}`}
    aria-orientation="vertical"
    tabIndex={(visualPanel === 'sidebar' && !sidebarVisible) || (visualPanel === 'inspector' && !inspectorOpen) ? -1 : 0}
    title={t("ui.WorkspaceResizeHandles.handle.drag_to_resize_double_click_to_reset_dc94eb6")}
    onPointerDown={event => begin(panel, event)}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onDoubleClick={event => reset(panel, event)}
    onKeyDown={event => keyResize(panel, event)}
  />

  return <>{handle('sidebar')}{handle(dockPanel, 'inspector')}</>
}

function savedWidth(scopedKey: string, legacyKey: string, fallback: number, minimum: number, maximum: number): number {
  const scopedValue = window.localStorage.getItem(scopedKey)
  const value = Number(scopedValue ?? window.localStorage.getItem(legacyKey))
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(minimum, value)) : fallback
}

function panelWidth(shell: HTMLElement, panel: Panel): number {
  const property = panel === 'sidebar' ? '--sidebar-width' : panel === 'review' ? '--review-width' : '--inspector-width'
  const value = getComputedStyle(shell).getPropertyValue(property)
  return Number.parseFloat(value) || (panel === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : panel === 'review' ? DEFAULT_REVIEW_WIDTH : DEFAULT_INSPECTOR_WIDTH)
}

function setPanelWidth(shell: HTMLElement, panel: Panel, width: number): void {
  shell.style.setProperty(panel === 'sidebar' ? '--sidebar-width' : panel === 'review' ? '--review-width' : '--inspector-width', `${width}px`)
}

function persistWidth(workspaceKey: string, panel: Panel, width: number): void {
  window.localStorage.setItem(workspacePanelStorageKey(workspaceKey, panel), String(width))
}

function finishResize(drag: MutableRefObject<ResizeDrag | null>, panel: Panel | null): void {
  const current = drag.current
  if (!current) return
  current.shell.classList.remove('column-resizing')
  document.body.classList.remove('column-resizing')
  persistWidth(current.workspaceKey, panel ?? current.panel, current.currentWidth)
  drag.current = null
  window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
}
