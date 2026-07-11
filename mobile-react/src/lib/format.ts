import type { AgentFile, Event, Session } from '../types'

export function normalizeServerURL(value: string): string {
  let clean = value.trim().replace(/\/+$/, '')
  if (!clean) clean = 'http://127.0.0.1:7850'
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`
  return clean
}

export function messageText(event: Event): string {
  const raw = event.result_text ?? event.text ?? event.prompt ?? event.message ?? event.error ?? event.output ?? ''
  if (typeof raw === 'string') return raw
  try { return JSON.stringify(raw, null, 2) } catch { return String(raw) }
}

export function isUnread(session: Session): boolean {
  if (session.manual_unread) return true
  return (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0)
}

export function isMedia(file: AgentFile): boolean {
  return isImage(file) || isVideo(file)
}
export function isImage(file: AgentFile): boolean {
  return file.content_type?.startsWith('image/') === true || /\.(png|jpe?g|gif|webp|heic)$/i.test(file.filename)
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

export function formatTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function runtimeSummary(session: Session): string {
  const model = session.model?.trim() || 'Server model'
  const effort = session.effort?.trim()
  return [session.backend === 'claude' ? 'Claude' : 'Codex', model, effort].filter(Boolean).join(' · ')
}

export function mergeEvents(current: Event[], incoming: Event[]): Event[] {
  const byId = new Map(current.map(event => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export function mergeFiles(current: AgentFile[], incoming: AgentFile[]): AgentFile[] {
  const byId = new Map(current.map(file => [file.id, file]))
  for (const file of incoming) byId.set(file.id, file)
  return [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}
