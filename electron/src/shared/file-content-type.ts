import type { AgentFile } from './types'

const GENERIC_BINARY_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])
const EDITOR_TEXT_EXTENSIONS = new Set([
  'bash', 'bazel', 'bzl', 'c', 'cc', 'cfg', 'cmake', 'conf', 'cpp', 'cs',
  'csproj', 'css', 'cts', 'csv', 'dart', 'diff', 'editorconfig', 'env', 'erl',
  'ex', 'exs', 'fish', 'fs', 'fsx', 'gitignore', 'go', 'gql', 'gradle',
  'graphql', 'groovy', 'h', 'hcl', 'hpp', 'hrl', 'htm', 'html', 'ini', 'java',
  'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'm',
  'md', 'mdx', 'mjs', 'mm', 'mts', 'npmrc', 'patch', 'php', 'plist',
  'prettierrc', 'properties', 'proto', 'py', 'rb', 'rs', 'rst', 'scss', 'sh',
  'sql', 'svelte', 'svg', 'swift', 'tf', 'toml', 'ts', 'tsx', 'txt', 'vue',
  'xml', 'yaml', 'yml', 'zsh'
])
const EDITOR_TEXT_FILENAMES = new Set([
  'build', 'buck', 'dockerfile', 'gemfile', 'license', 'makefile', 'procfile',
  'rakefile', 'readme', 'workspace'
])

export type InternalFileViewerKind = 'image' | 'pdf' | 'markdown' | 'text' | 'unsupported'

export function inferredFileContentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff'
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

export function effectiveFileContentType(file: Pick<AgentFile, 'filename' | 'content_type'>): string {
  const recorded = String(file.content_type ?? '').trim().toLowerCase()
  const baseType = recorded.split(';', 1)[0].trim()
  return GENERIC_BINARY_TYPES.has(baseType) ? inferredFileContentType(file.filename) : recorded
}

export function isPreviewableFile(file: Pick<AgentFile, 'filename' | 'content_type'>): boolean {
  return /^(?:image|video)\//.test(effectiveFileContentType(file))
}

export function internalFileViewerKind(file: Pick<AgentFile, 'filename' | 'content_type'>): InternalFileViewerKind {
  const contentType = effectiveFileContentType(file).split(';', 1)[0].trim()
  if (contentType.startsWith('image/') && contentType !== 'image/svg+xml') return 'image'
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'text/markdown' || /\.(?:md|markdown)$/i.test(file.filename)) return 'markdown'
  return isEditorTextFile(file) ? 'text' : 'unsupported'
}

export function isInternalViewerFile(file: Pick<AgentFile, 'filename' | 'content_type'>): boolean {
  return internalFileViewerKind(file) !== 'unsupported'
}

export function isEditorTextFile(file: Pick<AgentFile, 'filename' | 'content_type'>): boolean {
  const contentType = effectiveFileContentType(file).split(';', 1)[0].trim()
  if (contentType.startsWith('text/')) return true
  if (/^application\/(?:json|ld\+json|toml|x-httpd-php|x-javascript|x-sh|xml|yaml)$/.test(contentType)) return true
  if (/\+(?:json|xml)$/.test(contentType)) return true
  const name = file.filename.toLocaleLowerCase()
  if (
    EDITOR_TEXT_FILENAMES.has(name)
    || name.startsWith('dockerfile.')
    || name.startsWith('license')
    || name.startsWith('readme')
  ) return true
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : ''
  return EDITOR_TEXT_EXTENSIONS.has(extension)
}
