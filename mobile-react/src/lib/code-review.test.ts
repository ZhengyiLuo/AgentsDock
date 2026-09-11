import assert from 'node:assert/strict'
import type { Event } from '../types'
import {
  clearCodeReviewFallbacks,
  codeReviewFallback,
  extractStructuredToolDiff,
  limitReviewSource,
  MAX_REVIEW_FILES,
  MAX_REVIEW_LINE_CHARACTERS,
  MAX_REVIEW_SOURCE_CHARACTERS,
  MAX_REVIEW_SOURCE_LINES,
  parseReviewableDiff,
  parseUnifiedDiff,
  registerCodeReviewFallback,
  reviewFallbackForEvents,
  summarizeStructuredToolDiff,
} from './code-review'

const event = (seq: number, patch: Partial<Event>): Event => ({
  id: `event-${seq}`,
  seq,
  session_id: 'chat-1',
  type: 'tool_started',
  ts: '2026-09-02T12:00:00.000Z',
  run_id: 'run-1',
  ...patch,
})

{
  const tool = {
    id: 'patch-1',
    name: 'functions/apply_patch',
    input: {
      changes: [
        { path: '/repo/src/app.ts', kind: 'update', diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra' },
        { filePath: '/repo/src/new.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+ready' },
      ],
    },
  }
  const events = [event(1, { tool }), event(2, { type: 'tool_finished', tool })]
  const source = extractStructuredToolDiff(events)
  assert.equal(source.match(/\/repo\/src\/app\.ts/gu)?.length, 1, 'started/finished copies must be de-duplicated')
  assert.deepEqual(summarizeStructuredToolDiff(events), {
    files: [
      { path: '/repo/src/app.ts', additions: 2, deletions: 1, binary: false },
      { path: '/repo/src/new.ts', additions: 1, deletions: 0, binary: false },
    ],
    filesChanged: 2,
    additions: 3,
    deletions: 1,
  })
  assert.deepEqual(parseReviewableDiff(source).map(file => [file.path, file.additions, file.deletions]), [
    ['/repo/src/app.ts', 2, 1],
    ['/repo/src/new.ts', 1, 0],
  ])
  const fallback = reviewFallbackForEvents(7, 'chat-1', 'run-1', events)
  assert(fallback)
  clearCodeReviewFallbacks()
  registerCodeReviewFallback(fallback)
  assert.equal(codeReviewFallback(7, 'chat-1', 'run-1')?.source, source)
  assert.equal(codeReviewFallback(8, 'chat-1', 'run-1'), null, 'fallback patches must not cross profile generations')
  assert.equal(codeReviewFallback(7, 'chat-2', 'run-1'), null)
}

{
  const files = parseReviewableDiff([
    '*** Update File: /repo/src/hunkless.ts',
    '-const oldValue = true',
    '+const newValue = true',
  ].join('\n'))
  assert.deepEqual(
    files.map(file => [file.path, file.additions, file.deletions]),
    [['/repo/src/hunkless.ts', 1, 1]],
    'Codex structured changes without @@ hunks must remain reviewable',
  )
}

{
  const oversized = `${'line\n'.repeat(MAX_REVIEW_SOURCE_LINES + 20)}${'x'.repeat(MAX_REVIEW_SOURCE_CHARACTERS)}`
  const limited = limitReviewSource(oversized)
  assert(limited.truncated, 'oversized review sources must report truncation')
  assert(limited.source.length <= MAX_REVIEW_SOURCE_CHARACTERS, 'review sources must have a character ceiling')
  assert(limited.source.split('\n').length <= MAX_REVIEW_SOURCE_LINES, 'review sources must have a line ceiling')

  const longLine = limitReviewSource('x'.repeat(MAX_REVIEW_LINE_CHARACTERS + 50))
  assert(longLine.truncated, 'oversized individual lines must report truncation')
  assert.equal(longLine.source.length, MAX_REVIEW_LINE_CHARACTERS, 'individual review lines must have a render ceiling')

  const manyFiles = Array.from({ length: MAX_REVIEW_FILES + 10 }, (_, index) => [
    `*** Update File: /repo/file-${index}.ts`,
    '-old',
    '+new',
  ].join('\n')).join('\n')
  assert.equal(parseReviewableDiff(manyFiles).length, MAX_REVIEW_FILES, 'review parsing must cap file view allocation')
}

{
  const files = parseUnifiedDiff([
    'diff --git a/conflicted.ts b/conflicted.ts',
    '--- a/conflicted.ts',
    '+++ b/conflicted.ts',
    '@@ -1 +1,7 @@',
    '+<<<<<<< HEAD',
    '+ours',
    '+||||||| base-revision',
    '+base',
    '+=======',
    '+theirs',
    '+>>>>>>> feature',
  ].join('\n'))
  assert.equal(files[0]?.conflictCount, 1)
  assert.deepEqual(
    files[0]?.lines.filter(line => line.conflictMarker).map(line => [line.conflictMarker, line.conflictSide, line.conflictLabel]),
    [
      ['start', 'ours', 'HEAD'],
      ['base', 'base', 'base-revision'],
      ['separator', 'theirs', undefined],
      ['end', 'theirs', 'feature'],
    ],
  )
}

{
  const files = parseUnifiedDiff([
    'diff --cc combined.ts',
    '--- a/combined.ts',
    '+++ b/combined.ts',
    '@@@ -1,1 -1,1 +1,5 @@@',
    '+<<<<<<< HEAD',
    '+ours',
    '+=======',
    '+theirs',
    '+>>>>>>> feature',
  ].join('\n'))
  assert.equal(files[0]?.isCombinedDiff, true)
  assert.equal(files[0]?.conflictCount, 0, 'combined diffs must fail closed instead of guessing conflict sides')
}

{
  const files = parseUnifiedDiff([
    'diff --git a/incomplete.ts b/incomplete.ts',
    '--- a/incomplete.ts',
    '+++ b/incomplete.ts',
    '@@ -0,0 +1,2 @@',
    '+<<<<<<< HEAD',
    '+still open',
  ].join('\n'))
  assert.equal(files[0]?.conflictCount, 0, 'incomplete marker sequences must not be presented as a conflict')
}
