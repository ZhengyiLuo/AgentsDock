import type { AgentFile, Backend, Event, Session } from '../types'
import { hasProviderUserProvenance, mergeProviderInterruptionEvent } from './provider-origin'
import { isNativeGoalSteerEvent } from './native-goal-steering'
import { retainNativeGoalAcknowledgementFiles } from './native-goal-file-association'

const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const chatDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

export function normalizeServerURL(value: string): string {
  let clean = value.trim()
  if (!clean) clean = 'http://127.0.0.1:7850'
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`
  // The edit-server form recomputes this on every keystroke (including
  // mid-edit states like "http://" while a user backspaces or pastes over
  // an address), so an unparseable intermediate value must fall back
  // instead of throwing during render and crashing the app.
  try {
    const url = new URL(clean)
    url.pathname = url.pathname.replace(/\/(api\/health)?\/?$/, '') || ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return clean
  }
}

export function messageText(event: Event): string {
  const inputEvent = event.type === 'turn_started' || event.type === 'turn_queued' || event.type === 'turn_queue_run_now' || isNativeGoalSteerEvent(event)
  const raw = inputEvent && event.display_prompt != null
    ? event.display_prompt
    : event.result_text ?? event.text ?? event.prompt ?? event.message ?? event.error ?? event.output ?? ''
  let text: string
  if (typeof raw === 'string') text = raw
  else {
    try { text = JSON.stringify(raw, null, 2) } catch { text = String(raw) }
  }
  if (!text.trim() && event.type === 'turn_finished' && event.stopped !== true && typeof event.exit_code === 'number' && event.exit_code !== 0) {
    text = `Agent turn failed with exit code ${event.exit_code}.`
  }
  if (!inputEvent) return text
  const visibleText = stripInjectedProviderAuthority(text)
  return isImportedClaudeTaskNotification(event, visibleText) ? '' : visibleText
}

/**
 * Provider transcripts can echo AgentsDock's launch-only authority suffix
 * back as user input. Match only the generated block shape so ordinary user
 * examples containing the marker remain untouched.
 */
export function stripInjectedProviderAuthority(text: string): string {
  const start = injectedProviderAuthorityStart(text)
  return start < 0 ? text : text.slice(0, start)
}

function injectedProviderAuthorityStart(text: string): number {
  const blockMarker = '[AgentsDock provider authority]\n'
  const blockStart = text.lastIndexOf(blockMarker)
  if (blockStart < 0) return -1
  // Generated suffixes either are the entire provider message or follow the
  // human prompt after one blank line. Avoid treating inline documentation as
  // a server-owned boundary.
  if (blockStart > 0 && text.slice(blockStart - 2, blockStart) !== '\n\n') return -1
  const start = blockStart > 0 ? blockStart - 2 : 0
  const endMarker = '[End AgentsDock provider authority]'
  const end = text.indexOf(endMarker, blockStart + blockMarker.length)
  if (end < 0) return -1
  if (end === 0 || !/\s/u.test(text[end - 1])) return -1
  if (text.slice(end + endMarker.length).trim()) return -1
  const block = text.slice(blockStart + blockMarker.length, end)
  // A transcript can be migrated between Windows and POSIX hosts. Normalize
  // only for validating the generated authority path; keep the returned user
  // text byte-for-byte intact.
  const portableBlock = block.replace(/\\/gu, '/')
  const compactGenerated = /(?:^|\n)authority-file=(?:['"])?(?:\/|[A-Za-z]:\/)[^\n]*\/cross_chat_authority\/run_[0-9a-z_-]+\.json(?:['"])?(?:\s|$)/iu.test(portableBlock)
    && /(?:^|\s)chat-id=sess_[0-9a-f]+(?:\s|$)/u.test(block)
    && /(?:^|\n)usage: see AgentsDock instructions(?:\n|$)/u.test(block)
  const verboseGenerated = block.includes('This authority file is bound to this server, chat, and live run.')
    && block.includes('Do not read, print, quote, or expose the authority file.')
  return compactGenerated || verboseGenerated ? start : -1
}

/**
 * Claude records internal subtask completions as synthetic user messages.
 * Older server imports lost the source metadata but retained the provider,
 * import provenance, and exact outer wrapper. Contain those legacy records
 * without treating a tag pasted into a live or non-Claude chat as special.
 */
function isImportedClaudeTaskNotification(event: Event, text: string): boolean {
  if (
    event.type !== 'turn_started'
    || event.backend !== 'claude'
    || event.provider_history_sanitized === true
    || hasProviderUserProvenance(event)
    || !(event.imported === true || event.run_id?.startsWith('import_') === true)
  ) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('<task-notification>') || !trimmed.endsWith('</task-notification>')) return false
  const body = trimmed.slice('<task-notification>'.length, -'</task-notification>'.length).trim()
  return body.includes('<summary>') && body.includes('</summary>')
}

export function isUnread(session: Session): boolean {
  if (session.manual_unread) return true
  return (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0)
}

export function isMedia(file: AgentFile): boolean {
  return isImage(file) || isVideo(file)
}
export function isImage(file: AgentFile): boolean {
  const filename = file.filename.split(/[?#]/, 1)[0]
  return file.content_type?.startsWith('image/') === true || /\.(avif|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(filename)
}
export function isVideo(file: AgentFile): boolean {
  return file.content_type?.startsWith('video/') === true || /\.(mp4|mov|m4v|webm)$/i.test(file.filename)
}

export function formatBytes(value?: number | null): string {
  if (!value) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

export function formatDateTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return fullDateTimeFormatter.format(date)
}

export function formatChatDateTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return chatDateTimeFormatter.format(date)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function backendLabel(backend: Backend): string {
  return backend === 'codex' ? 'Codex' : backend === 'cursor' ? 'Cursor' : 'Claude'
}

export function runtimeSummary(session: Session): string {
  const model = session.model?.trim() || 'Server model'
  const effort = session.effort?.trim()
  return [backendLabel(session.backend), model, effort].filter(Boolean).join(' · ')
}

export function mergeEvents(current: Event[], incoming: Event[]): Event[] {
  if (!incoming.length) return current
  if (!current.length) return incoming.length === 1 ? incoming : [...incoming].sort((a, b) => a.seq - b.seq)
  if (incoming.length === 1 && incoming[0].seq > current[current.length - 1].seq
    && !current.some(event => event.id === incoming[0].id)) return [...current, incoming[0]]
  const byId = new Map(current.map(event => [event.id, event]))
  for (const event of incoming) {
    const previous = byId.get(event.id)
    byId.set(event.id, previous ? retainNativeGoalAcknowledgementFiles(previous, mergeProviderInterruptionEvent(previous, event)) : event)
  }
  const merged = [...byId.values()].sort((a, b) => a.seq - b.seq)
  return merged.length === current.length && merged.every((event, index) => event === current[index])
    ? current
    : merged
}

export function mergeFiles(current: AgentFile[], incoming: AgentFile[]): AgentFile[] {
  if (!incoming.length) return current
  const byId = new Map(current.map(file => [file.id, file]))
  for (const file of incoming) {
    const existing = byId.get(file.id)
    byId.set(file.id, existing && sameFlatRecord(existing, file) ? existing : file)
  }
  const merged = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return merged.length === current.length && merged.every((file, index) => file === current[index])
    ? current
    : merged
}

function sameFlatRecord(left: object, right: object): boolean {
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
  for (const key of keys) {
    if (leftRecord[key] !== rightRecord[key]) return false
  }
  return true
}

export function filesNewestFirst(files: readonly AgentFile[]): AgentFile[] {
  return files
    .map((file, index) => ({ file, index, createdAt: fileTimestamp(file.created_at) }))
    .sort((left, right) => {
      if (left.createdAt != null || right.createdAt != null) {
        if (left.createdAt == null) return 1
        if (right.createdAt == null) return -1
        if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
      }
      const leftSeq = fileSequence(left.file)
      const rightSeq = fileSequence(right.file)
      if (leftSeq != null && rightSeq != null && leftSeq !== rightSeq) return rightSeq - leftSeq
      return left.index - right.index
    })
    .map(value => value.file)
}

function fileSequence(file: AgentFile): number | null {
  const value = file.seq ?? file.event_seq
  return Number.isFinite(value) ? value as number : null
}

function fileTimestamp(value?: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}
