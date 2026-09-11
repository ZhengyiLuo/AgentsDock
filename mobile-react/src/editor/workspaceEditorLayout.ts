export type WorkspaceMarkdownMode = 'source' | 'split' | 'preview'

export const MARKDOWN_LIVE_PREVIEW_MAX_BYTES = 512 * 1024

export function defaultWorkspaceMarkdownMode(layout: 'phone' | 'pad', utf8Bytes: number): WorkspaceMarkdownMode {
  return layout === 'pad' && utf8Bytes <= MARKDOWN_LIVE_PREVIEW_MAX_BYTES ? 'split' : 'source'
}

export function workspaceMarkdownModeForLayout(mode: WorkspaceMarkdownMode, layout: 'phone' | 'pad'): WorkspaceMarkdownMode {
  return layout === 'phone' && mode === 'split' ? 'source' : mode
}

export function workspaceMarkdownPaneVisibility(mode: WorkspaceMarkdownMode): { source: boolean; preview: boolean } {
  return {
    source: mode !== 'preview',
    preview: mode !== 'source',
  }
}
