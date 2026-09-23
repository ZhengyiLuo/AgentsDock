import assert from 'node:assert/strict'
import { rankSidebarSessions, sidebarContentResult, sidebarNameMatchRank } from './sidebar-search'
import type { Session } from '../types'

const hit = { session_id: 'chat-a', event_id: 'event-old', seq: 12 }

assert.equal(
  sidebarContentResult('iOS release work', 'ios', hit),
  undefined,
  'a matching chat title must open the chat itself instead of an old transcript hit',
)
assert.equal(
  sidebarContentResult('Android release work', 'ios', hit),
  hit,
  'a content-only result must retain its exact timeline target',
)
assert.equal(sidebarContentResult('Zenith   app', '  ZENITH app  ', hit), undefined, 'whitespace/case normalized names still open the live chat')

assert.equal(sidebarNameMatchRank('Zenith', 'zenith'), 0)
assert.equal(sidebarNameMatchRank('ZenithDock', 'zenith'), 1)
assert.equal(sidebarNameMatchRank('Fix Zenith', 'zenith'), 2)
assert.equal(sidebarNameMatchRank('MyZenith', 'zenith'), 3)
assert.equal(sidebarNameMatchRank('Other', 'zenith'), null)
assert.equal(sidebarNameMatchRank('工程 — 搜索', '搜索'), 2, 'word matching supports non-Latin names')

const sessions: Session[] = [
  { id: 'pinned', title: 'Pinned history match', backend: 'codex', pinned: true },
  { id: 'metadata', title: 'Other', backend: 'codex', cwd: '/work/Zenith' },
  { id: 'substring', title: 'MyZenith', backend: 'codex' },
  { id: 'archived-history', title: 'Old chat', backend: 'codex', archived: true },
  { id: 'prefix', title: 'ZenithDock', backend: 'codex' },
  { id: 'word', title: 'Fix Zenith', backend: 'codex' },
  { id: 'exact', title: 'ZENITH', backend: 'codex' },
  { id: 'archived-name', title: 'Zenith archived', backend: 'codex', archived: true },
]
assert.deepEqual(
  rankSidebarSessions(sessions, 'Zenith', new Set(['pinned', 'archived-history', 'unknown-deleted-id'])).map(session => session.id),
  ['exact', 'prefix', 'archived-name', 'word', 'substring', 'pinned', 'metadata'],
  'names rank globally before history and metadata; archived chats require a name match and unknown hits cannot create rows',
)
assert.deepEqual(rankSidebarSessions(sessions, 'not found', new Set()), [])
assert.equal(rankSidebarSessions(sessions, '  ', new Set(['pinned'])), sessions, 'clearing query preserves the original list')

console.log('sidebar search regressions passed')
