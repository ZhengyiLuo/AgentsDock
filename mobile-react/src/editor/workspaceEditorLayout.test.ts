import {
  MARKDOWN_LIVE_PREVIEW_MAX_BYTES,
  defaultWorkspaceMarkdownMode,
  workspaceMarkdownModeForLayout,
  workspaceMarkdownPaneVisibility,
} from './workspaceEditorLayout'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(defaultWorkspaceMarkdownMode('phone', 20) === 'source', 'iPhone must open directly in source mode')
assert(defaultWorkspaceMarkdownMode('pad', 20) === 'split', 'iPad should open normal Markdown in split mode')
assert(defaultWorkspaceMarkdownMode('pad', MARKDOWN_LIVE_PREVIEW_MAX_BYTES + 1) === 'source', 'large Markdown must not mount a live preview')
assert(workspaceMarkdownModeForLayout('split', 'phone') === 'source', 'split mode must collapse safely on iPhone')
assert(workspaceMarkdownModeForLayout('preview', 'phone') === 'preview', 'iPhone keeps an explicit preview selection')
assert(JSON.stringify(workspaceMarkdownPaneVisibility('split')) === JSON.stringify({ source: true, preview: true }), 'split mode shows both stable panes')
assert(JSON.stringify(workspaceMarkdownPaneVisibility('source')) === JSON.stringify({ source: true, preview: false }), 'source mode hides preview')
assert(JSON.stringify(workspaceMarkdownPaneVisibility('preview')) === JSON.stringify({ source: false, preview: true }), 'preview mode hides source visually')

console.log('workspace editor adaptive layout regressions passed')
