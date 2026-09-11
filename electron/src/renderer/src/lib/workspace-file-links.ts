import type { AgentFile } from '@shared/types'

export interface OpenWorkspacePathDetail {
  sessionId: string
  path: string
  line?: number
  column?: number
  resolve?: boolean
}

export interface OpenAgentFileDetail {
  sessionId: string
  file: AgentFile
  line?: number
  column?: number
}

export interface WorkspaceCodeReference {
  path: string
  line?: number
  column?: number
}

const CODE_FILE_EXTENSIONS = new Set([
  'bash', 'bzl', 'c', 'cc', 'cfg', 'cmake', 'conf', 'cpp', 'css', 'cts', 'cu',
  'cuh', 'dart', 'env', 'ex', 'exs', 'fish', 'fs', 'fsx', 'go', 'gradle', 'h',
  'hpp', 'html', 'htm', 'ini', 'ipynb', 'java', 'js', 'json', 'jsonc', 'jsx',
  'kt', 'kts', 'less', 'lua', 'm', 'md', 'mdx', 'mjs', 'mm', 'mts', 'php',
  'plist', 'proto', 'ps1', 'py', 'r', 'rb', 'rs', 'scala', 'scss', 'sh', 'sol',
  'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml',
  'yml', 'zsh'
])

const CODE_FILE_NAMES = new Set([
  '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore', 'build',
  'dockerfile', 'gemfile', 'justfile', 'makefile', 'procfile', 'rakefile',
  'workspace'
])

export function workspacePathForAgentFile(
  file: Pick<AgentFile, 'source_path'>,
  workspaceRoot: string | null | undefined
): string | null {
  const source = normalizedPath(file.source_path)
  const root = normalizedPath(workspaceRoot)
  if (!source || !root || !isAbsolutePath(source) || !isAbsolutePath(root)) return null

  const caseInsensitive = /^[A-Za-z]:\//.test(source) || /^[A-Za-z]:\//.test(root)
  const comparedSource = caseInsensitive ? source.toLocaleLowerCase() : source
  const comparedRoot = caseInsensitive ? root.toLocaleLowerCase() : root
  const rootIsFilesystemRoot = comparedRoot === '/' || /^[a-z]:\/$/i.test(comparedRoot)
  const prefix = rootIsFilesystemRoot ? comparedRoot : `${comparedRoot}/`
  if (!comparedSource.startsWith(prefix)) return null

  const relative = source.slice(rootIsFilesystemRoot ? root.length : root.length + 1)
  return relative && !relative.split('/').includes('..') ? relative : null
}

export function requestOpenWorkspacePath(
  sessionId: string,
  path: string,
  location: Pick<WorkspaceCodeReference, 'line' | 'column'> = {}
): void {
  window.dispatchEvent(new CustomEvent<OpenWorkspacePathDetail>(
    'agentsdock:open-workspace-path',
    { detail: { sessionId, path, ...location } }
  ))
}

export function requestOpenWorkspaceReference(sessionId: string, reference: WorkspaceCodeReference): void {
  window.dispatchEvent(new CustomEvent<OpenWorkspacePathDetail>(
    'agentsdock:open-workspace-path',
    {
      detail: {
        sessionId,
        path: reference.path,
        line: reference.line,
        column: reference.column,
        resolve: true
      }
    }
  ))
}

export function requestOpenAgentFile(
  sessionId: string,
  file: AgentFile,
  location: Pick<WorkspaceCodeReference, 'line' | 'column'> = {}
): void {
  window.dispatchEvent(new CustomEvent<OpenAgentFileDetail>(
    'agentsdock:open-agent-file',
    {
      detail: {
        sessionId,
        file,
        ...(location.line ? { line: location.line } : {}),
        ...(location.column ? { column: location.column } : {})
      }
    }
  ))
}

export function parseWorkspaceCodeReference(value: string): WorkspaceCodeReference | null {
  const candidate = value.trim()
  if (!candidate || candidate.length > 1_024 || /[\r\n\0]/.test(candidate)) return null
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i.test(candidate)) return null

  let path = candidate
  let line: number | undefined
  let column: number | undefined
  const fragment = /#L(\d+)(?:C(\d+))?$/i.exec(path)
  if (fragment) {
    line = positiveInteger(fragment[1])
    column = positiveInteger(fragment[2])
    if (!line || (fragment[2] && !column)) return null
    path = path.slice(0, fragment.index)
  } else {
    const location = /:(\d+)(?::(\d+))?$/.exec(path)
    if (location) {
      line = positiveInteger(location[1])
      column = positiveInteger(location[2])
      if (!line || (location[2] && !column)) return null
      path = path.slice(0, location.index)
    }
  }

  path = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path || path.startsWith('../') || path.includes('/../') || path.endsWith('/..')) return null
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (!name || (!CODE_FILE_NAMES.has(name) && !CODE_FILE_EXTENSIONS.has(name.split('.').at(-1) ?? ''))) return null
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

function normalizedPath(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim().replace(/\\/g, '/')
  if (!normalized) return ''
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '')
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
