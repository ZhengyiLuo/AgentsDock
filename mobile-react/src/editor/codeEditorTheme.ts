export const CODE_EDITOR_FONT_SIZE_MIN = 11
export const CODE_EDITOR_FONT_SIZE_MAX = 20
export const CODE_EDITOR_DEFAULT_FONT_SIZE = 13

export type CodeEditorThemeId = 'vscode-dark' | 'github-dark' | 'dracula' | 'github-light'
export type CodeEditorThemeMode = 'dark' | 'light'

export interface CodeEditorThemePalette {
  background: string
  foreground: string
  gutterBackground: string
  gutterForeground: string
  gutterBorder: string
  activeLine: string
  activeLineGutter: string
  selection: string
  focus: string
  cursor: string
  panelBackground: string
  tooltipBackground: string
  tooltipBorder: string
  keyword: string
  variable: string
  function: string
  property: string
  type: string
  string: string
  number: string
  comment: string
  operator: string
  punctuation: string
  meta: string
  invalid: string
}

export interface CodeEditorThemeDefinition {
  id: CodeEditorThemeId
  label: string
  mode: CodeEditorThemeMode
  palette: CodeEditorThemePalette
}

export const CODE_EDITOR_THEMES: readonly CodeEditorThemeDefinition[] = [
  {
    id: 'vscode-dark',
    label: 'VS Code Dark',
    mode: 'dark',
    palette: {
      background: '#1e1e1e', foreground: '#d4d4d4', gutterBackground: '#181818', gutterForeground: '#858585',
      gutterBorder: '#2b2b2b', activeLine: '#2a2d2e99', activeLineGutter: '#2a2d2e', selection: '#264f78',
      focus: '#007acc', cursor: '#aeafad', panelBackground: '#252526', tooltipBackground: '#252526',
      tooltipBorder: '#454545', keyword: '#c586c0', variable: '#9cdcfe', function: '#dcdcaa', property: '#9cdcfe',
      type: '#4ec9b0', string: '#ce9178', number: '#b5cea8', comment: '#6a9955', operator: '#d4d4d4',
      punctuation: '#d4d4d4', meta: '#c8c8c8', invalid: '#f44747',
    },
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    mode: 'dark',
    palette: {
      background: '#0d1117', foreground: '#e6edf3', gutterBackground: '#010409', gutterForeground: '#6e7681',
      gutterBorder: '#21262d', activeLine: '#161b2299', activeLineGutter: '#161b22', selection: '#1f6feb66',
      focus: '#2f81f7', cursor: '#f0f6fc', panelBackground: '#161b22', tooltipBackground: '#161b22',
      tooltipBorder: '#30363d', keyword: '#ff7b72', variable: '#ffa657', function: '#d2a8ff', property: '#79c0ff',
      type: '#ffa657', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e', operator: '#ff7b72',
      punctuation: '#e6edf3', meta: '#79c0ff', invalid: '#f85149',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    palette: {
      background: '#282a36', foreground: '#f8f8f2', gutterBackground: '#21222c', gutterForeground: '#6272a4',
      gutterBorder: '#44475a', activeLine: '#34374699', activeLineGutter: '#343746', selection: '#44475a',
      focus: '#8be9fd', cursor: '#f8f8f0', panelBackground: '#21222c', tooltipBackground: '#343746',
      tooltipBorder: '#6272a4', keyword: '#ff79c6', variable: '#f8f8f2', function: '#50fa7b', property: '#8be9fd',
      type: '#8be9fd', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4', operator: '#ff79c6',
      punctuation: '#f8f8f2', meta: '#ffb86c', invalid: '#ff5555',
    },
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    mode: 'light',
    palette: {
      background: '#ffffff', foreground: '#24292f', gutterBackground: '#f6f8fa', gutterForeground: '#8c959f',
      gutterBorder: '#d8dee4', activeLine: '#f6f8fa99', activeLineGutter: '#eaeef2', selection: '#54aeff66',
      focus: '#0969da', cursor: '#24292f', panelBackground: '#f6f8fa', tooltipBackground: '#ffffff',
      tooltipBorder: '#d0d7de', keyword: '#cf222e', variable: '#953800', function: '#8250df', property: '#0550ae',
      type: '#953800', string: '#0a3069', number: '#0550ae', comment: '#6e7781', operator: '#cf222e',
      punctuation: '#24292f', meta: '#0550ae', invalid: '#cf222e',
    },
  },
] as const

export const CODE_EDITOR_DEFAULT_THEME: CodeEditorThemeId = 'vscode-dark'

const themeIds = new Set<CodeEditorThemeId>(CODE_EDITOR_THEMES.map(theme => theme.id))

export function isCodeEditorThemeId(value: unknown): value is CodeEditorThemeId {
  return typeof value === 'string' && themeIds.has(value as CodeEditorThemeId)
}

export function codeEditorTheme(value: unknown): CodeEditorThemeDefinition {
  const id = isCodeEditorThemeId(value) ? value : CODE_EDITOR_DEFAULT_THEME
  return CODE_EDITOR_THEMES.find(theme => theme.id === id) ?? CODE_EDITOR_THEMES[0]
}

export function clampCodeEditorFontSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return CODE_EDITOR_DEFAULT_FONT_SIZE
  return Math.min(CODE_EDITOR_FONT_SIZE_MAX, Math.max(CODE_EDITOR_FONT_SIZE_MIN, Math.round(parsed)))
}
