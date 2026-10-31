import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '../types'
import { sidebarSessionSections } from './sidebar-sections'
import { WELCOME_SESSION_ID } from './welcome-session'

const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, title: id, backend: 'codex', folder: 'Work', ...patch })
const summarize = (sessions: Session[], active = new Set<string>(), folders: string[] = [], includeEmpty = true) =>
  sidebarSessionSections(sessions, active, folders, includeEmpty).map(section => [section.status ?? 'folder', section.title, section.sessions.map(value => value.id)])

test('unread and running precede real folders without duplicating or moving chats', () => {
  const sessions = [session('idle'), session('running', { manual_unread: true }), session('unread', { latest_agent_event_seq: 4, last_read_agent_event_seq: 2, pinned: true })]
  const original = structuredClone(sessions)
  assert.deepEqual(summarize(sessions, new Set(['running'])), [
    ['unread', 'Unread', ['unread']], ['running', 'Running', ['running']], ['folder', 'Work', ['idle']],
  ])
  assert.deepEqual(sessions, original)
})

test('a completed run moves to unread, then reading returns it to its original folder', () => {
  const chat = session('chat', { latest_agent_event_seq: 5, last_read_agent_event_seq: 2 })
  assert.deepEqual(summarize([chat], new Set(['chat'])), [['running', 'Running', ['chat']]])
  assert.deepEqual(summarize([chat]), [['unread', 'Unread', ['chat']]])
  assert.deepEqual(summarize([{ ...chat, last_read_agent_event_seq: 5 }]), [['folder', 'Work', ['chat']]])
})

test('agent-marked important input and emergencies appear in Unread even while a turn is active', () => {
  const waiting = session('waiting', { manual_unread: true, codex_needs_user_action: true, unread_notification_level: 'important' })
  const emergency = session('emergency', { manual_unread: true, emergency_alert: { id: 'alert', status: 'active', severity: 'critical', message: 'Test incident', raised_at: '2026-10-20T12:00:00Z' } })
  const sections = sidebarSessionSections([waiting, emergency], new Set(['waiting', 'emergency']), [], true)
  assert.equal(sections[0]?.status, 'unread')
  assert.equal(sections[0]?.attentionLevel, 'emergency')
  assert.deepEqual(sections[0]?.sessions.map(value => value.id), ['waiting', 'emergency'])
  assert.equal(sections.some(value => value.status === 'running'), false)
  assert.equal(sidebarSessionSections([waiting], new Set(['waiting']), [], true)[0]?.attentionLevel, 'important')
})

test('Unread returns to blue after its only important chat is read', () => {
  const normal = session('normal', { latest_agent_event_seq: 8, last_read_agent_event_seq: 3 })
  const important = session('important', {
    latest_agent_event_seq: 6,
    last_read_agent_event_seq: 2,
    unread_notification_level: 'important',
    unread_notification_seq: 5,
  })
  const before = sidebarSessionSections([normal, important], new Set(), [], true)
  assert.equal(before[0]?.attentionLevel, 'important')
  assert.deepEqual(before[0]?.sessions.map(value => value.id), ['normal', 'important'])

  const after = sidebarSessionSections([normal, { ...important, last_read_agent_event_seq: 6 }], new Set(), [], true)
  assert.equal(after[0]?.attentionLevel, 'normal')
  assert.deepEqual(after[0]?.sessions.map(value => value.id), ['normal'])
})

test('acknowledging an emergency removes its red unread status', () => {
  const alert = { id: 'alert', status: 'active' as const, severity: 'critical' as const, message: 'Test incident', raised_at: '2026-10-20T12:00:00Z' }
  const active = session('emergency', { manual_unread: true, emergency_alert: alert })
  assert.equal(sidebarSessionSections([active], new Set(), [], true)[0]?.attentionLevel, 'emergency')
  const acknowledged = session('emergency', { manual_unread: true, emergency_alert: { ...alert, status: 'acknowledged' } })
  assert.equal(sidebarSessionSections([acknowledged], new Set(), [], true)[0]?.attentionLevel, 'normal')
  assert.equal(sidebarSessionSections([{ ...acknowledged, manual_unread: false }], new Set(), [], true)[0]?.status, undefined)
})

test('empty smart groups vanish while explicit empty custom folders remain', () => {
  assert.deepEqual(summarize([], new Set(['unknown']), ['Empty folder']), [['folder', 'Empty folder', []]])
  assert.deepEqual(summarize([], new Set(), ['Empty folder'], false), [])
})

test('archived chats and the local welcome guide stay in their normal sections', () => {
  assert.deepEqual(summarize([
    session('archived', { archived: true, manual_unread: true }),
    session(WELCOME_SESSION_ID, { folder: 'General', manual_unread: true }),
  ], new Set(['archived', WELCOME_SESSION_ID])), [
    ['folder', 'General', [WELCOME_SESSION_ID]], ['folder', 'Archived', ['archived']],
  ])
})

test('manual unread and all providers share the status groups, keeping existing chat ordering', () => {
  assert.deepEqual(summarize([
    session('codex', { manual_unread: true, sort_order: 3 }),
    session('cursor', { backend: 'cursor', manual_unread: true, sort_order: 1 }),
    session('claude', { backend: 'claude', latest_agent_event_seq: 1, sort_order: 2 }),
  ]), [['unread', 'Unread', ['cursor', 'claude', 'codex']]])
})

test('real folders named Unread and Running are separate from temporary status groups', () => {
  assert.deepEqual(summarize([
    session('new-output', { manual_unread: true }), session('active'),
    session('real-unread', { folder: 'Unread' }), session('real-running', { folder: 'Running' }),
  ], new Set(['active']), ['Unread', 'Running']), [
    ['unread', 'Unread', ['new-output']], ['running', 'Running', ['active']],
    ['folder', 'Unread', ['real-unread']], ['folder', 'Running', ['real-running']],
  ])
})
