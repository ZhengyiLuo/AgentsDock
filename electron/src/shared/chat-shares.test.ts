import { describe, expect, it } from 'vitest'
import { chatShareCreateBody, isSharedChatCollaborator, parseChatShareList, parseChatSharePreview, parseCreatedChatShare } from './chat-shares'
import { updateQueuedTurns } from './queue'
import type { Event } from './types'

const metadata = { id: `interactive_${'a'.repeat(32)}`, title: 'Synthetic chat', created_at: 1, expires_at: null, revoked_at: null, redeemed_at: null }
const path = `/interactive-chat/${metadata.id}#invite=${'b'.repeat(43)}`
describe('explicit chat sharing boundary', () => {
  it('accepts the exact fragment invite and rejects credentials, queries and other share paths', () => {
    expect(parseCreatedChatShare({ ...metadata, path, url: `https://share.example.test${path}` }, 'interactive').path).toBe(path)
    for (const url of [`https://secret@share.example.test${path}`, `https://share.example.test${path.replace('#', '?')}`, `http://share.example.test${path}`]) {
      expect(() => parseCreatedChatShare({ ...metadata, path, url }, 'interactive')).toThrow()
    }
    expect(() => parseCreatedChatShare({ ...metadata, path: path.replace(metadata.id, 'other'), url: null }, 'interactive')).toThrow()
  })
  it('keeps an unhosted snapshot as a relative path and strips unknown fields from lists', () => {
    const source = { ...metadata, share_id: 'share_qa', path: `/share/${'c'.repeat(43)}`, url: null, token: 'never-return-this' }
    expect(parseCreatedChatShare(source, 'snapshot').url).toBeNull()
    expect(parseChatShareList({ shares: [source] }, 'snapshot')[0]).not.toHaveProperty('token')
    expect(parseChatShareList({ shares: [source] }, 'snapshot')[0]).not.toHaveProperty('path')
  })
  it('requires explicit confirmation and keeps the exact reviewed digest and message text', () => {
    const preview = parseChatSharePreview({ messages: [{ role: 'user', text: '<private quotation>' }], digest: 'd'.repeat(64), through_bytes: 42, warning: 'Synthetic warning' })
    expect(preview.messages[0].text).toBe('<private quotation>')
    expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, digest: preview.digest, through_bytes: preview.through_bytes })).toEqual({ confirmed_public: true, digest: 'd'.repeat(64), through_bytes: 42 })
    expect(() => chatShareCreateBody({ mode: 'interactive', confirmed_interactive: false } as never)).toThrow()
  })
  it('labels only exact nonsecret collaborator provenance and preserves it in the queue', () => {
    const source = { shared_chat_id: metadata.id, shared_chat_request_id: 'qa_request_123', author_label: 'Collaborator' as const }
    expect(isSharedChatCollaborator(source)).toBe(true)
    for (const value of [{ ...source, shared_chat_id: 'another' }, { ...source, shared_chat_request_id: '' }, { ...source, imported: true }, { ...source, author_label: 'Owner' }]) {
      expect(isSharedChatCollaborator(value as never)).toBe(false)
    }
    const event: Event = { ...source, type: 'turn_queued', id: 'event', session_id: 'chat', seq: 1, ts: '2026-09-12T12:00:00Z', queued_id: 'queue', prompt: 'Exact guest text' }
    const queued = updateQueuedTurns([], event)[0]
    expect(queued.prompt).toBe(event.prompt)
    expect(isSharedChatCollaborator(queued)).toBe(true)
  })
})
