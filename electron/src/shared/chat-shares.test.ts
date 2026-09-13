import { describe, expect, it } from 'vitest'
import { chatShareCreateBody, isSharedChatCollaborator, parseChatShareList, parseChatSharePreview, parseCreatedChatShare } from './chat-shares'
import { updateQueuedTurns } from './queue'
import type { Event } from './types'
import { catalogs } from './locales'

const metadata = { id: `interactive_${'a'.repeat(32)}`, title: 'Synthetic chat', created_at: 1, expires_at: null, revoked_at: null, redeemed_at: null }
const path = `/interactive-chat/${metadata.id}#invite=${'b'.repeat(43)}`
describe('explicit chat sharing boundary', () => {
  it('discloses full chat control and non-rollback revocation in both confirmations', () => {
    const english = catalogs.en['chatShare.confirmInteractive']
    const chinese = catalogs['zh-CN']['chatShare.confirmInteractive']
    expect(english).toContain('full control of this chat')
    expect(english).toContain('permissions and scheduled jobs')
    expect(english).toContain('does not undo accepted work or jobs')
    expect(chinese).toContain('完整控制权')
    expect(chinese).toContain('更改权限和管理定时任务')
    expect(chinese).toContain('不会撤回已接受的工作或任务')
  })
  it('accepts the exact fragment invite and rejects credentials, queries and other share paths', () => {
    expect(parseCreatedChatShare({ ...metadata, path, url: `https://share.example.test${path}` }, 'interactive').path).toBe(path)
    expect(parseCreatedChatShare({ ...metadata, path, url: `http://192.0.2.4:7850${path}` }, 'interactive').path).toBe(path)
    for (const url of [`https://secret@share.example.test${path}`, `http://secret:password@192.0.2.4${path}`, `https://share.example.test${path.replace('#', '?')}`, `ftp://share.example.test${path}`, `http://share.example.test${path.replace(metadata.id, 'other')}`]) {
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
  it('allows direct confirmed creation and validates any legacy boundary as an exact pair', () => {
    expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, title: 'Example' }))
      .toEqual({ confirmed_public: true, title: 'Example' })
    expect(chatShareCreateBody({ mode: 'interactive', confirmed_interactive: true }))
      .toEqual({ confirmed_interactive: true })
    for (const fields of [{ through_bytes: 42 }, { digest: 'd'.repeat(64) }, { through_bytes: -1, digest: 'd'.repeat(64) },
      { through_bytes: 1.5, digest: 'd'.repeat(64) }, { through_bytes: 42, digest: 'bad' }]) {
      expect(() => chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, ...fields })).toThrow()
    }
    expect(() => chatShareCreateBody({ mode: 'snapshot', confirmed_public: false } as never)).toThrow()
    expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, base_url: 'http://untrusted.example.test' } as never))
      .toEqual({ confirmed_public: true })
    const snapshotPath = `/share/${'c'.repeat(43)}`
    expect(parseCreatedChatShare({ ...metadata, share_id: 'share_qa', path: snapshotPath, url: `http://192.0.2.4:7850${snapshotPath}` }, 'snapshot').path)
      .toBe(snapshotPath)
    for (const url of [`http://192.0.2.4${snapshotPath}?token=other`, `http://192.0.2.4${snapshotPath}#other`]) {
      expect(() => parseCreatedChatShare({ ...metadata, share_id: 'share_qa', path: snapshotPath, url }, 'snapshot')).toThrow()
    }
  })
  it('shares a long noisy log without rejecting its small complete text snapshot', () => {
    const messages = Array.from({ length: 2384 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `Message ${index}: ${'small readable text '.repeat(15)}` }))
    const preview = parseChatSharePreview({ messages, through_bytes: 145_336_998, digest: 'e'.repeat(64), warning: 'Review all text.' })
    expect(preview.messages).toHaveLength(messages.length)
    expect(preview.messages.at(-1)?.text).toBe(messages.at(-1)?.text)
    expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, digest: preview.digest, through_bytes: preview.through_bytes }))
      .toEqual({ confirmed_public: true, digest: 'e'.repeat(64), through_bytes: 145_336_998 })
    for (const through_bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => parseChatSharePreview({ messages, through_bytes, digest: 'e'.repeat(64), warning: '' })).toThrow()
    }
  })
  it('bounds actual exported UTF-8 text and serialized bytes, not the source log', () => {
    const value = { through_bytes: 200_000_000, digest: 'f'.repeat(64), warning: '' }
    expect(() => parseChatSharePreview({ ...value, messages: [{ role: 'user', text: 'é'.repeat(128 * 1024 + 1) }] })).toThrow('Invalid chat preview message')
    expect(() => parseChatSharePreview({ ...value, messages: Array.from({ length: 12 }, () => ({ role: 'assistant', text: 'a'.repeat(190 * 1024) })) })).toThrow('2 MiB')
    expect(() => parseChatSharePreview({ ...value, messages: Array.from({ length: 2 }, () => ({ role: 'user', text: '\u0000'.repeat(240_000) })) })).toThrow('2 MiB')
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
