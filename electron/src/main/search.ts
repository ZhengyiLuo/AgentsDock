import type { Event, TimelineSearchResult } from '../shared/types'

export function searchTokens(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map(match => (match[1] || match[2] || '').toLocaleLowerCase())
    .filter(Boolean)
}

export function searchFtsQuery(query: string): string {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map(match => {
      const phrase = match[1]
      const value = (phrase || match[2] || '').toLocaleLowerCase().replaceAll('"', '""')
      if (!value) return ''
      return phrase ? `"${value}"` : `"${value}"*`
    })
    .filter(Boolean)
    .join(' AND ')
}

export function searchableEventText(event: Event): string {
  const error = typeof event.error === 'string' ? event.error : event.error ? JSON.stringify(event.error) : ''
  return [
    event.result_text, event.text, event.prompt, event.digest, event.message, error,
    event.job?.title, event.job?.prompt,
    event.artifact?.title, event.artifact?.filename,
    event.file?.title, event.file?.filename
  ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim()
}

export function isSearchableEvent(event: Event): boolean {
  return [
    'turn_started', 'assistant_text', 'turn_finished', 'reasoning_summary', 'error',
    'job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error',
    'artifact_created', 'artifact_error', 'file_uploaded',
    'handoff_digest_started', 'handoff_digest_ready', 'handoff_digest_received', 'handoff_digest_submitted', 'handoff_digest_sent'
  ].includes(event.type) || event.type.endsWith('_error')
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

export function searchEventsAcrossSessions(events: Iterable<Event>, query: string, limit = 40): TimelineSearchResult[] {
  const tokens = searchTokens(query)
  if (!tokens.length) return []
  const matched = new Set<string>()
  const results: TimelineSearchResult[] = []
  for (const event of events) {
    if (matched.has(event.session_id)) continue
    const text = searchableEventText(event)
    const folded = text.toLocaleLowerCase()
    if (!text || !tokens.every(token => folded.includes(token))) continue
    matched.add(event.session_id)
    results.push({
      session_id: event.session_id,
      event_id: event.id,
      seq: event.seq,
      ts: event.ts,
      role: searchEventRole(event),
      snippet: searchSnippet(text, tokens)
    })
    if (results.length >= Math.max(1, Math.min(100, limit))) break
  }
  return results
}

export function mergeTimelineSearchResults(
  preferred: TimelineSearchResult[],
  fallback: TimelineSearchResult[],
  limit: number,
  onePerSession: boolean
): TimelineSearchResult[] {
  const unique = new Map<string, TimelineSearchResult>()
  for (const result of [...preferred, ...fallback]) {
    const key = onePerSession ? result.session_id : `${result.session_id}:${result.event_id}`
    const current = unique.get(key)
    if (!current || result.seq > current.seq) unique.set(key, result)
  }
  return [...unique.values()]
    .sort((left, right) => String(right.ts ?? '').localeCompare(String(left.ts ?? '')) || right.seq - left.seq)
    .slice(0, Math.max(1, Math.min(100, limit)))
}
