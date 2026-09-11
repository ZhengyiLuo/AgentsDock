import { afterEach, describe, expect, it } from 'vitest'
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  REVIEW_MAX_WIDTH,
  REVIEW_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampWorkspacePanelWidth,
  persistWorkspaceSidebarVisible,
  savedWorkspaceColumnStyle,
  savedWorkspaceSidebarVisible,
  workspacePanelStorageKey,
  workspaceSidebarVisibilityStorageKey
} from './WorkspaceResizeHandles'

afterEach(() => localStorage.clear())

describe('clampWorkspacePanelWidth', () => {
  it('persists sidebar visibility independently for each server workspace', () => {
    expect(savedWorkspaceSidebarVisible('server:alpha')).toBe(true)

    persistWorkspaceSidebarVisible('server:alpha', false)

    expect(localStorage.getItem(workspaceSidebarVisibilityStorageKey('server:alpha'))).toBe('false')
    expect(savedWorkspaceSidebarVisible('server:alpha')).toBe(false)
    expect(savedWorkspaceSidebarVisible('server:beta')).toBe(true)
  })

  it('keeps both docked panels from crushing the conversation', () => {
    expect(clampWorkspacePanelWidth('sidebar', 900, 1440, 400, true)).toBe(460)
    expect(clampWorkspacePanelWidth('inspector', 900, 1200, 300, true)).toBe(380)
  })

  it('allows a wider overlaid inspector on compact windows', () => {
    expect(clampWorkspacePanelWidth('inspector', 620, 1000, 230, true)).toBe(620)
  })

  it('honors each panel minimum and maximum', () => {
    expect(clampWorkspacePanelWidth('sidebar', 10, 2000, 350, true)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('sidebar', 900, 2000, 350, false)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampWorkspacePanelWidth('inspector', 10, 2000, 282, true)).toBe(INSPECTOR_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('inspector', 900, 2000, 282, true)).toBe(INSPECTOR_MAX_WIDTH)
    expect(clampWorkspacePanelWidth('review', 10, 2200, 282, true)).toBe(REVIEW_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('review', 1400, 2200, 282, true)).toBe(REVIEW_MAX_WIDTH)
  })

  it('keeps a docked review wide without covering the conversation', () => {
    expect(clampWorkspacePanelWidth('review', 900, 1440, 282, true)).toBe(638)
    expect(clampWorkspacePanelWidth('review', 820, 1728, 282, true)).toBe(820)
  })

  it('keeps sidebar, inspector, and review widths independent across A to B to A', () => {
    const widths = (workspaceKey: string, sidebar: number, inspector: number, review: number) => {
      localStorage.setItem(workspacePanelStorageKey(workspaceKey, 'sidebar'), String(sidebar))
      localStorage.setItem(workspacePanelStorageKey(workspaceKey, 'inspector'), String(inspector))
      localStorage.setItem(workspacePanelStorageKey(workspaceKey, 'review'), String(review))
    }
    const columns = (workspaceKey: string) => savedWorkspaceColumnStyle(workspaceKey, 2000) as Record<string, string>

    widths('server:alpha', 320, 420, 750)
    widths('server:beta', 230, 300, 500)

    expect(columns('server:alpha')).toMatchObject({
      '--sidebar-width': '320px',
      '--inspector-width': '420px',
      '--review-width': '750px'
    })
    expect(columns('server:beta')).toMatchObject({
      '--sidebar-width': '230px',
      '--inspector-width': '300px',
      '--review-width': '500px'
    })
    expect(columns('server:alpha')).toMatchObject({
      '--sidebar-width': '320px',
      '--inspector-width': '420px',
      '--review-width': '750px'
    })
  })
})
