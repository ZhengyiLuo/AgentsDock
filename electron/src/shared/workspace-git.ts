/** Repository-wide state, not a single chat turn's recorded patch. */
export interface WorkspaceGitFile {
  path: string
  original_path?: string
  index_status: string
  worktree_status: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}
export interface WorkspaceGitStatus {
  root: string
  branch: string | null
  head: string | null
  revision: string
  operation: null | 'merge' | 'rebase' | 'cherry-pick' | 'revert'
  files: WorkspaceGitFile[]
  staged_count: number
  conflict_count: number
}
export type WorkspaceGitView = 'staged' | 'unstaged'
export interface WorkspaceGitDiff {
  path: string
  view: WorkspaceGitView
  diff: string
  binary: boolean
  truncated: boolean
  revision: string
}
export interface WorkspaceGitConflict {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
  revision: string
  binary: boolean
}
export interface WorkspaceGitAction {
  action: 'stage' | 'unstage' | 'commit' | 'resolve' | 'continue' | 'abort'
  expected_revision: string
  paths?: string[]
  message?: string
  path?: string
  content?: string
  confirmed?: boolean
}
export function workspaceGitSessionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid workspace chat.')
  return value
}
export function workspaceGitPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')
    || value.startsWith('/') || value.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Invalid repository file path.')
  }
  return value
}
export function validateWorkspaceGitAction(input: WorkspaceGitAction): WorkspaceGitAction {
  if (!input || !['stage', 'unstage', 'commit', 'resolve', 'continue', 'abort'].includes(input.action)
    || typeof input.expected_revision !== 'string' || !input.expected_revision || input.expected_revision.length > 256) {
    throw new Error('Refresh Changes before making a Git change.')
  }
  const result: WorkspaceGitAction = { action: input.action, expected_revision: input.expected_revision }
  if (input.action === 'stage' || input.action === 'unstage') {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1000) throw new Error('Select files first.')
    result.paths = input.paths.map(workspaceGitPath)
  }
  if (input.action === 'commit') {
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 65536) throw new Error('Enter a commit message.')
    result.message = input.message
  }
  if (input.action === 'resolve') {
    result.path = workspaceGitPath(input.path!)
    if (typeof input.content !== 'string' || input.content.includes('\0') || new TextEncoder().encode(input.content).byteLength > 2 * 1024 * 1024) throw new Error('The resolved file exceeds the 2 MiB Git text editor limit.')
    result.content = input.content
  }
  if (input.action === 'abort') {
    if (input.confirmed !== true) throw new Error('Confirm before aborting the Git operation.')
    result.confirmed = true
  }
  return result
}
export function parseWorkspaceGitStatus(value: unknown): WorkspaceGitStatus {
  const item = value as WorkspaceGitStatus | null
  if (!item || typeof item.root !== 'string' || !(item.branch === null || typeof item.branch === 'string')
    || !(item.head === null || typeof item.head === 'string') || typeof item.revision !== 'string' || !item.revision
    || ![null, 'merge', 'rebase', 'cherry-pick', 'revert'].includes(item.operation)
    || !Number.isSafeInteger(item.staged_count) || !Number.isSafeInteger(item.conflict_count)
    || !Array.isArray(item.files) || !item.files.every(file => file && typeof file.path === 'string'
      && typeof file.index_status === 'string' && typeof file.worktree_status === 'string'
      && ['staged', 'unstaged', 'untracked', 'conflicted'].every(key => typeof file[key as keyof WorkspaceGitFile] === 'boolean'))) {
    throw new Error('The server returned an invalid Git workspace snapshot.')
  }
  return item
}
