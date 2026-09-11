import { describe, expect, it } from 'vitest'
import type { ChatReference, TeamRecipientReference, TeamReference } from '@shared/types'
import {
  atomicComposerReferenceDeletion,
  insertTeamReference,
  orderedComposerReferenceSpans,
  parseStoredTeamReferences,
  reconcileTeamReferences,
  teamMentionTrigger,
  validComposerReferences,
  validTeamReferences
} from './team-references'

const recipient = (start: number, name = 'DPark'): TeamRecipientReference => ({
  kind: 'recipient',
  recipient_kind: 'human',
  team_id: 'team-1',
  target_id: 'person-1',
  display_name_snapshot: name,
  source_text_start: start,
  source_text_end: start + 2 + name.length,
  grant_intent: true
})

describe('Team Network composer references', () => {
  it('parses @@ first and inserts a structured reference at UTF-16 textarea offsets', () => {
    const text = '😀 Tell @@DP'
    const trigger = teamMentionTrigger(text, text.length)
    expect(trigger).toEqual({ kind: '@@', start: 8, end: 12, query: 'DP' })

    const inserted = insertTeamReference(text, trigger!, {
      kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1', display_name_snapshot: 'DPark'
    })
    expect(inserted).toEqual({
      text: '😀 Tell @@DPark ',
      reference: recipient(8),
      caret: 16
    })
  })

  it('accepts only exact structured tokens and revokes a reference touched by an edit', () => {
    const reference = recipient(5)
    expect(validTeamReferences('Tell @@DPark now', [reference])).toEqual([reference])
    expect(validTeamReferences('Tell @@DPark now', [{ ...reference, grant_intent: false } as unknown as TeamReference])).toEqual([])
    expect(parseStoredTeamReferences([{ ...reference, grant_intent: false }], 'Tell @@DPark now')).toEqual([])
    expect(reconcileTeamReferences('Tell @@DPark now', 'Tell @@DParks now', [reference])).toEqual([])
    expect(reconcileTeamReferences('Tell @@DPark now', 'Please Tell @@DPark now', [reference])).toEqual([{
      ...reference, source_text_start: 12, source_text_end: 19
    }])
  })

  it('matches the server limits for reference count and display-name snapshots', () => {
    const names = Array.from({ length: 17 }, (_, index) => `Person${index}`)
    const text = names.map(name => `@@${name}`).join(' ')
    let offset = 0
    const references = names.map((name, index) => {
      const reference: TeamReference = {
        ...recipient(offset, name),
        target_id: `person-${index}`
      }
      offset += name.length + 3
      return reference
    })

    expect(validTeamReferences(text, references)).toEqual(references.slice(0, 16))

    const acceptedName = 'a'.repeat(160)
    const rejectedName = 'b'.repeat(161)
    expect(validTeamReferences(`@@${acceptedName}`, [recipient(0, acceptedName)])).toHaveLength(1)
    expect(validTeamReferences(`@@${rejectedName}`, [recipient(0, rejectedName)])).toEqual([])
  })

  it('keeps historical Bulletin and all-server mail references distinct when restored', () => {
    const historicalBulletin: TeamReference = {
      ...recipient(0, 'all'), recipient_kind: 'all', target_id: 'all'
    }
    const allServers: TeamReference = {
      ...recipient(0, 'all'), recipient_kind: 'all_servers', target_id: 'all_servers'
    }
    expect(parseStoredTeamReferences([historicalBulletin], '@@all')).toEqual([historicalBulletin])
    expect(parseStoredTeamReferences([allServers], '@@all')).toEqual([allServers])
    expect(parseStoredTeamReferences([{ ...allServers, target_id: 'all' }], '@@all')).toEqual([])
    expect(parseStoredTeamReferences([{ ...historicalBulletin, target_id: 'all_servers' }], '@@all')).toEqual([])
  })

  it('validates chat and Team spans together, preferring the new structured @@ reference', () => {
    const text = '@@Training'
    const legacyChat: ChatReference = {
      session_id: 'chat-2', display_title_snapshot: 'Training',
      source_text_start: 0, source_text_end: text.length, action: 'route'
    }
    const team: TeamReference = {
      kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-1',
      display_name_snapshot: 'Training', source_text_start: 0, source_text_end: text.length, grant_intent: true
    }
    expect(validComposerReferences(text, [legacyChat], [team], (_value, refs) => [...refs])).toEqual({
      chatReferences: [], teamReferences: [team]
    })
  })

  it('treats mixed chat and Team chips atomically during deletion', () => {
    const text = '@Chat then @@DPark '
    const chat: ChatReference = {
      session_id: 'chat-2', display_title_snapshot: 'Chat',
      source_text_start: 0, source_text_end: 5, action: 'route'
    }
    const team = recipient(11)
    expect(atomicComposerReferenceDeletion(
      text,
      orderedComposerReferenceSpans([chat], [team]),
      18,
      18,
      'Backspace'
    )).toEqual({ text: '@Chat then ', caret: 11 })
  })
})
