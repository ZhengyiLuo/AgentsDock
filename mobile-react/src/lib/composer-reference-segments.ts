import { validChatReferences } from './chat-references'
import type { ChatReference } from '../types'

/** Styling is derived only from intact draft references; it grants no access. */
export function composerReferenceSegments(text: string, references: readonly ChatReference[], sessionId: string) {
  const valid = validChatReferences(text, [...references], sessionId)
    .sort((a, b) => a.source_text_start - b.source_text_start)
  const segments: { key: string; text: string; reference: boolean }[] = []
  let offset = 0
  for (const reference of valid) {
    if (reference.source_text_start < offset) continue
    if (reference.source_text_start > offset) segments.push({ key: `text:${offset}`, text: text.slice(offset, reference.source_text_start), reference: false })
    segments.push({ key: `reference:${reference.source_text_start}`, text: text.slice(reference.source_text_start, reference.source_text_end), reference: true })
    offset = reference.source_text_end
  }
  if (offset < text.length) segments.push({ key: `text:${offset}`, text: text.slice(offset), reference: false })
  return segments
}
