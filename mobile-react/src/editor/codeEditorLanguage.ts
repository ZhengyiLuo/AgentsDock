export type CodeEditorLanguageId =
  | 'javascript'
  | 'typescript'
  | 'javascript-react'
  | 'typescript-react'
  | 'json'
  | 'markdown'
  | 'python'
  | 'html'
  | 'css'
  | 'yaml'
  | 'shell'
  | 'toml'
  | 'go'
  | 'rust'
  | 'sql'
  | 'dockerfile'
  | 'c'
  | 'cpp'
  | 'java'
  | 'plain-text'

export interface CodeEditorLanguageDefinition {
  id: CodeEditorLanguageId
  label: string
}

const LANGUAGE_LABELS: Readonly<Record<CodeEditorLanguageId, string>> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  'javascript-react': 'JavaScript React',
  'typescript-react': 'TypeScript React',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  shell: 'Shell',
  toml: 'TOML',
  go: 'Go',
  rust: 'Rust',
  sql: 'SQL',
  dockerfile: 'Dockerfile',
  c: 'C',
  cpp: 'C++',
  java: 'Java',
  'plain-text': 'Plain text',
}

export function codeEditorLanguage(path: string): CodeEditorLanguageDefinition {
  const name = path.replace(/\\/g, '/').split('/').at(-1)?.toLocaleLowerCase() ?? ''
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : ''
  let id: CodeEditorLanguageId = 'plain-text'

  if (['js', 'mjs', 'cjs'].includes(extension)) id = 'javascript'
  else if (extension === 'jsx') id = 'javascript-react'
  else if (['ts', 'mts', 'cts'].includes(extension)) id = 'typescript'
  else if (extension === 'tsx') id = 'typescript-react'
  else if (['json', 'jsonc'].includes(extension) || name === '.eslintrc' || name === '.prettierrc') id = 'json'
  else if (['md', 'mdx', 'markdown'].includes(extension)) id = 'markdown'
  else if (extension === 'py' || name === 'sconstruct') id = 'python'
  else if (['html', 'htm', 'vue', 'svelte'].includes(extension)) id = 'html'
  else if (['css', 'scss', 'less'].includes(extension)) id = 'css'
  else if (['yaml', 'yml'].includes(extension)) id = 'yaml'
  else if (['sh', 'bash', 'zsh', 'fish'].includes(extension) || ['docker-entrypoint', 'makefile'].includes(name)) id = 'shell'
  else if (extension === 'toml') id = 'toml'
  else if (extension === 'go') id = 'go'
  else if (extension === 'rs') id = 'rust'
  else if (['sql', 'sqlite'].includes(extension)) id = 'sql'
  else if (name === 'dockerfile' || name.startsWith('dockerfile.')) id = 'dockerfile'
  else if (['c', 'h'].includes(extension)) id = 'c'
  else if (['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'].includes(extension)) id = 'cpp'
  else if (extension === 'java') id = 'java'

  return { id, label: LANGUAGE_LABELS[id] }
}

export function codeEditorLanguageLabel(path: string): string {
  return codeEditorLanguage(path).label
}
