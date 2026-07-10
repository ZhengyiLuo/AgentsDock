import type { Event, TimelineSearchResult } from '../shared/types'

export function searchTokens(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map(match => (match[1] || match[2] || '').toLocaleLowerCase())
    .filter(Boolean)
}

export function searchableEventText(event: Event): string {
  const error = typeof event.error === 'string' ? event.error : event.error ? JSON.stringify(event.error) : ''
  return [
    event.result_text, event.text, event.prompt, event.message, error,
    event.job?.title, event.job?.prompt,
    event.artifact?.title, event.artifact?.filename,
    event.file?.title, event.file?.filename
  ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim()
}

export function searchEventRole(event: Event): TimelineSearchResult['role'] {
  if (event.type === 'turn_started') return 'user'
  if (event.type === 'assistant_text' || event.type === 'turn_finished') return 'assistant'
  if (event.type === 'reasoning_summary') return 'trace'
  if (event.type.startsWith('job_') || event.job_id) return 'job'
  if (event.type === 'artifact_created' || event.type === 'file_uploaded') return 'file'
  if (event.type === 'error' || event.type.endsWith('_error') || event.error) return 'error'
  return 'system'
}

export function searchSnippet(text: string, tokens: string[], limit = 260): string {
  if (text.length <= limit) return text
  const folded = text.toLocaleLowerCase()
  const positions = tokens.map(token => folded.indexOf(token)).filter(position => position >= 0)
  const center = positions.length ? Math.min(...positions) : 0
  let start = Math.max(0, center - Math.floor(limit / 3))
  const end = Math.min(text.length, start + limit)
  start = Math.max(0, end - limit)
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}
