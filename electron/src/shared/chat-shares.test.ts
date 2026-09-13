import { describe, expect, it } from 'vitest'
import { chatShareCreateBody, isSharedChatCollaborator, normalizeChatShareOrigin, parseChatShareList, parseChatSharePreview, parseCreatedChatShare } from './chat-shares'
import { updateQueuedTurns } from './queue'
import type { Event } from './types'
import { catalogs } from './locales'

const metadata = { id: `interactive_${'a'.repeat(32)}`, title: 'Synthetic chat', created_at: 1, expires_at: null, revoked_at: null, redeemed_at: null }
const access_token = 'b'.repeat(43)
const path = `/interactive-chat/${metadata.id}`
const snapshot = { ...metadata, share_id: `share_${'c'.repeat(32)}`, access_token }
const snapshotPath = `/shared-chat/${snapshot.share_id}`
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
  it('accepts token-free interactive URLs with a separate token, rejecting credentials, queries and fragments', () => {
    for (const origin of ['https://share.example.test', 'http://192.0.2.4:7850']) {
      expect(parseCreatedChatShare({ ...metadata, access_token, path, url: `${origin}${path}` }, 'interactive'))
        .toMatchObject({ path, url: `${origin}${path}`, access_token })
    }
    for (const url of [`https://secret@share.example.test${path}`, `http://secret:password@192.0.2.4${path}`,
      `https://share.example.test${path}?token=${access_token}`, `https://share.example.test${path}#invite=${access_token}`,
      `https://share.example.test${path}?`, `https://share.example.test${path}#`, `https://@share.example.test${path}`,
      `ftp://share.example.test${path}`, `http://share.example.test${path.replace(metadata.id, 'other')}`]) {
      expect(() => parseCreatedChatShare({ ...metadata, access_token, path, url }, 'interactive')).toThrow()
    }
    expect(() => parseCreatedChatShare({ ...metadata, access_token, path: path.replace(metadata.id, 'other'), url: null }, 'interactive')).toThrow()
  })
  it('keeps an unhosted snapshot as a relative path and strips unknown fields from lists', () => {
    const source = { ...snapshot, path: snapshotPath, url: null, token: 'never-return-this' }
    expect(parseCreatedChatShare(source, 'snapshot')).toMatchObject({ path: snapshotPath, url: null, access_token })
    for (const mode of ['snapshot', 'interactive'] as const) {
      const listed = parseChatShareList({ shares: [{ ...source, token_url: `https://share.example.test/share/${access_token}` }] }, mode)[0]
      for (const secret of ['token', 'path', 'url', 'access_token', 'token_url']) expect(listed).not.toHaveProperty(secret)
    }
  })
  it('requires separate exact tokens and rejects old bearer-link responses with clean errors', () => {
    for (const mode of ['snapshot', 'interactive'] as const) {
      const source = { ...snapshot, path: mode === 'snapshot' ? snapshotPath : path, url: null }
      for (const token of [undefined, null, '', 'a'.repeat(42), 'a'.repeat(44), '!'.repeat(43), 123]) {
        expect(() => parseCreatedChatShare({ ...source, access_token: token }, mode)).toThrow('Update the server')
      }
      const legacyPath = mode === 'snapshot' ? `/share/${access_token}` : `${path}#invite=${access_token}`
      expect(() => parseCreatedChatShare({ ...source, path: legacyPath, url: `http://share.example.test${legacyPath}` }, mode))
        .toThrow('Update the server')
      for (const id of ['other', `share_${'d'.repeat(32)}`, `interactive_${'d'.repeat(32)}`, '.*']) {
        const changed = mode === 'snapshot' ? { share_id: id } : { id }
        expect(() => parseCreatedChatShare({ ...source, ...changed }, mode)).toThrow()
      }
    }
    const malicious = `http://invalid port/share/${access_token}`
    try {
      parseCreatedChatShare({ ...snapshot, path: snapshotPath, url: malicious }, 'snapshot')
      throw new Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toBe('Error: Invalid public chat URL.')
      expect(String(error)).not.toContain(access_token)
      expect(error).not.toHaveProperty('input')
      expect(error).not.toHaveProperty('cause')
    }
  })
  it('allows only matching same-origin snapshot token URLs and never interactive token URLs', () => {
    const origin = 'http://192.0.2.4:7850'
    const source = { ...snapshot, path: snapshotPath, url: `${origin}${snapshotPath}` }
    const token_url = `${origin}/share/${access_token}`
    expect(parseCreatedChatShare({ ...source, token_url }, 'snapshot').token_url).toBe(token_url)
    for (const other of [`https://share.example.test/share/${access_token}`, `https://192.0.2.4:7850/share/${access_token}`,
      `${origin}/share/${'d'.repeat(43)}`, `${token_url}?x=1`, `${token_url}#fragment`, `${origin}${snapshotPath}`,
      `http://secret@192.0.2.4:7850/share/${access_token}`, null, '']) {
      expect(() => parseCreatedChatShare({ ...source, token_url: other }, 'snapshot')).toThrow()
    }
    expect(() => parseCreatedChatShare({ ...source, url: null, token_url }, 'snapshot')).toThrow()
    for (const other of [token_url, null, '']) {
      expect(() => parseCreatedChatShare({ ...metadata, access_token, path, url: `${origin}${path}`, token_url: other }, 'interactive')).toThrow()
    }
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
    expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, url: 'http://untrusted.example.test' } as never))
      .toEqual({ confirmed_public: true })
    expect(parseCreatedChatShare({ ...snapshot, path: snapshotPath, url: `http://192.0.2.4:7850${snapshotPath}` }, 'snapshot').path)
      .toBe(snapshotPath)
    for (const url of [`http://192.0.2.4${snapshotPath}?token=other`, `http://192.0.2.4${snapshotPath}#other`]) {
      expect(() => parseCreatedChatShare({ ...snapshot, path: snapshotPath, url }, 'snapshot')).toThrow()
    }
  })
  it('normalizes an explicit share address without changing its scheme, host or non-default port', () => {
    for (const [value, expected] of [
      ['http://192.0.2.4:7850', 'http://192.0.2.4:7850'],
      [' http://192.0.2.4:7850/ ', 'http://192.0.2.4:7850'],
      ['https://share.example.test:8443/', 'https://share.example.test:8443'],
      ['http://[2001:db8::4]:7850/', 'http://[2001:db8::4]:7850'],
      ['HTTPS://SHARE.EXAMPLE.TEST:443', 'https://share.example.test']
    ]) {
      expect(normalizeChatShareOrigin(value)).toBe(expected)
      expect(chatShareCreateBody({ mode: 'snapshot', confirmed_public: true, base_url: value }))
        .toEqual({ confirmed_public: true, base_url: expected })
      expect(chatShareCreateBody({ mode: 'interactive', confirmed_interactive: true, base_url: value }))
        .toEqual({ confirmed_interactive: true, base_url: expected })
    }
  })
  it('rejects invalid share addresses without echoing potentially secret input', () => {
    for (const value of [null, 42, '', '192.0.2.4:7850', '//192.0.2.4:7850', 'https:example.test',
      'ftp://example.test', 'file:///etc/passwd', 'http://user:secret@example.test', 'http://@example.test',
      'http://example.test/path', 'http://example.test/..', 'http://example.test//', 'http://example.test/%2f',
      'http://example.test?token=secret', 'http://example.test?', 'http://example.test#secret', 'http://example.test#',
      'http://example.test\\secret', 'http://exa\nmple.test', 'http://example.test:0', 'http://example.test:65536',
      `http://${'a'.repeat(2048)}`]) {
      for (const mode of ['snapshot', 'interactive'] as const) {
        try {
          chatShareCreateBody({ mode, confirmed_public: true, confirmed_interactive: true, base_url: value } as never)
          throw new Error('Expected invalid origin rejection')
        } catch (error) {
          expect(String(error)).toBe('Error: Enter an HTTP or HTTPS server address, without a path, credentials, query, or fragment.')
          expect(error).not.toHaveProperty('input')
          expect(error).not.toHaveProperty('cause')
        }
      }
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
