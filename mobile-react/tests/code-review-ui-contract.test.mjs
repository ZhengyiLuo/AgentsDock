import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.resolve('src/components/CodeReview.tsx'), 'utf8')

test('code review retries its canonical bounded diff when the connection becomes ready', () => {
  assert.match(source, /interface ScopedCodeReviewProps[^]*?connectionReady: boolean/)
  assert.match(source, /<ScopedCodeReview[^]*?connectionReady=\{connectionReady\}/)
  assert.match(source, /if \(!runId \|\| !connectionReady\) return/)
  assert.match(source, /\[activeProfileId, connection, connectionReady, profileGeneration, runId, sessionId\]/)
})

test('code review renders only the bounded client result and discloses truncation', () => {
  assert.match(source, /const limited = limitReviewSource\(value\.text\)/)
  assert.match(source, /setTruncated\(value\.truncated \|\| limited\.truncated\)/)
  assert.match(source, /mobile is showing a bounded preview/)
})
