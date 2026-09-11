import assert from 'node:assert/strict'
import { sidebarContentResult } from './sidebar-search'

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

console.log('sidebar search regressions passed')
