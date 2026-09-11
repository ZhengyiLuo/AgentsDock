import type { AgentFile, Event } from '../types'
import { filesNewestFirst, formatChatDateTime, formatDateTime, isImage, mergeEvents, mergeFiles, normalizeServerURL } from './format'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function runFormatTests(): void {
  assert(normalizeServerURL('100.64.0.10:7850') === 'http://100.64.0.10:7850', 'short server addresses must normalize')
  assert(normalizeServerURL('https://dock.example/api/health/?x=1#status') === 'https://dock.example', 'health URLs must normalize to their server origin')
  // The edit-server form live-normalizes the address on every keystroke, so
  // an empty-host intermediate value (e.g. backspacing "http://127.0.0.1"
  // down to "http://", or pasting over an existing address) must not throw
  // during render - see crash report on editing a saved server's address.
  assert(normalizeServerURL('http://') === 'http://', 'an empty-host URL must not throw while a user is mid-edit')
  assert(normalizeServerURL('https://') === 'https://', 'an empty-host https URL must not throw while a user is mid-edit')

  const full = formatDateTime('2026-07-16T19:42:00Z')
  assert(/2026/.test(full), `full timestamp must include a year: ${full}`)
  assert(/Jul|7/.test(full), `full timestamp must include a date: ${full}`)
  assert(/\d/.test(full), `full timestamp must include a time: ${full}`)

  const compact = formatChatDateTime('2026-07-16T19:42:00Z')
  assert(/Jul|7/.test(compact), `chat timestamp must include a date: ${compact}`)
  assert(/\d/.test(compact), `chat timestamp must include a time: ${compact}`)
  assert(formatDateTime('not-a-date') === '', 'invalid full timestamps must be empty')
  assert(formatChatDateTime(null) === '', 'missing chat timestamps must be empty')
  assert(isImage({ id: 'image-1', filename: 'export.AVIF' }), 'AVIF uploads must retain their image preview after upload')
  assert(isImage({ id: 'image-2', filename: 'scan.TIFF?download=1' }), 'query-suffixed TIFF uploads must retain their image preview after upload')
  assert(isImage({ id: 'image-3', filename: 'picker-item', content_type: 'image/heif' }), 'image MIME metadata must enable a preview without a filename extension')
  assert(!isImage({ id: 'file-1', filename: 'report.pdf', content_type: 'application/pdf' }), 'documents must keep the file treatment')

  const event = (seq: number): Event => ({ id: `event-${seq}`, session_id: 'chat-1', seq, type: 'assistant_text', ts: `2026-07-16T19:42:${String(seq).padStart(2, '0')}Z` })
  const current = [event(1), event(2)]
  assert(mergeEvents(current, [current[0], current[1]]) === current, 'an already-covered live tail must preserve the current event-array identity')
  const appended = mergeEvents(current, [event(3)])
  assert(appended.length === 3 && appended[2].seq === 3, 'the common live append path must preserve timeline order')
  const merged = mergeEvents(appended, [{ ...event(2), text: 'updated' }])
  assert(merged.length === 3 && merged[1].text === 'updated', 'event reconciliation must still replace an existing event ID')

  const file = (id: string, created_at?: string | null, seq?: number | null, event_seq?: number | null): AgentFile => ({ id, filename: `${id}.png`, created_at, seq, event_seq })
  const files = [
    file('middle', '2026-07-23T18:02:00Z', 20),
    file('oldest', '2026-07-23T18:01:00Z', 10),
    file('newest', '2026-07-23T18:03:00Z', 30),
  ]
  assert(mergeFiles(files, []) === files, 'non-file live events must preserve the current file-array identity')
  const orderedFiles = [files[1], files[0], files[2]]
  assert(mergeFiles(orderedFiles, [{ ...orderedFiles[0] }]) === orderedFiles, 'identical file metadata must preserve file and array identities')
  const newestFirst = filesNewestFirst(files)
  assert(newestFirst.map(value => value.id).join(',') === 'newest,middle,oldest', 'file viewers must show newest files first')
  assert(files.map(value => value.id).join(',') === 'middle,oldest,newest', 'display ordering must not mutate snapshot state')
  const seqFallback = filesNewestFirst([file('seq-old', null, 40), file('seq-new', null, 41)])
  assert(seqFallback.map(value => value.id).join(',') === 'seq-new,seq-old', 'file viewers must fall back to descending event sequence')
  const serverSeqFallback = filesNewestFirst([file('server-old', null, null, 50), file('server-new', null, null, 51)])
  assert(serverSeqFallback.map(value => value.id).join(',') === 'server-new,server-old', 'server file event_seq metadata must also sort newest first')
  const mixedMetadata = filesNewestFirst([
    file('undated-high-seq', null, 99),
    file('dated-low-seq', '2026-07-23T18:00:00Z', 1),
    file('invalid-date', 'not-a-date', 50),
  ])
  assert(mixedMetadata.map(value => value.id).join(',') === 'dated-low-seq,undated-high-seq,invalid-date', 'valid timestamps must form a stable ordering tier before sequence-only files')
  const equalTimestamp = filesNewestFirst([
    file('equal-old', '2026-07-23T18:00:00Z', null, 60),
    file('equal-new', '2026-07-23T18:00:00Z', null, 61),
  ])
  assert(equalTimestamp.map(value => value.id).join(',') === 'equal-new,equal-old', 'equal timestamps must use server event sequence')
  const stableUnknowns = filesNewestFirst([file('unknown-a'), file('unknown-b')])
  assert(stableUnknowns.map(value => value.id).join(',') === 'unknown-a,unknown-b', 'files without recency metadata must preserve server order')
}

runFormatTests()
console.log('date and timestamp formatting regressions passed')
