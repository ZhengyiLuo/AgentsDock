import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampWorkspacePanelWidth
} from './WorkspaceResizeHandles'

describe('clampWorkspacePanelWidth', () => {
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
  })
})
