import assert from 'node:assert/strict'
import { boundedMediaClaimsForOwner, nextBoundedVisibleCount, reconcileCurrentMediaId } from './media-viewer-state'

assert.equal(nextBoundedVisibleCount(4, 30, 4), 8, 'media expansion must add one bounded page')
assert.equal(nextBoundedVisibleCount(28, 30, 4), 30, 'the last media page must clamp to the total')
assert.equal(nextBoundedVisibleCount(30, 30, 4), 4, 'expanding the complete set again must collapse to the initial page')
assert.equal(nextBoundedVisibleCount(8, 300, 8), 16, 'large galleries must never expand all items in one action')

const initialIds = ['newest', 'selected', 'oldest']
assert.equal(
  reconcileCurrentMediaId(['later', ...initialIds], 'selected', 'newest'),
  'selected',
  'prepending a new file must preserve the currently viewed file',
)
assert.equal(
  reconcileCurrentMediaId(['newest', 'oldest'], 'selected', 'newest'),
  'newest',
  'removing the current file must fall back to the originally opened file',
)
assert.equal(
  reconcileCurrentMediaId(['replacement'], 'selected', 'newest'),
  'replacement',
  'removing both current and initial files must use the first remaining file',
)
assert.equal(reconcileCurrentMediaId([], 'selected', 'newest'), null, 'an empty gallery must have no current file')

assert.deepEqual(
  boundedMediaClaimsForOwner([
    { ownerKey: 'row-a', candidates: ['video-a', 'video-b'] },
    { ownerKey: 'row-b', candidates: ['video-c', 'video-d'] },
  ], 'row-b', 3),
  ['video-c'],
  'automatic video work must share one bounded screen/session budget instead of multiplying per row',
)
assert.deepEqual(
  boundedMediaClaimsForOwner([
    { ownerKey: 'row-b', candidates: ['video-c', 'video-d'] },
  ], 'row-b', 3),
  ['video-c', 'video-d'],
  'unmounting an older row must release its claims for newly visible videos',
)

const firstCompactGridOwner = 'compact:standalone:mount-a'
const secondCompactGridOwner = 'compact:standalone:mount-b'
const duplicateCompactGridOwners = [
  { ownerKey: firstCompactGridOwner, candidates: ['shared-video-a', 'shared-video-b'] },
  { ownerKey: secondCompactGridOwner, candidates: ['shared-video-a', 'shared-video-b'] },
]
assert.deepEqual(
  boundedMediaClaimsForOwner(duplicateCompactGridOwners, secondCompactGridOwner, 4),
  [],
  'two mounted compact standalone grids must keep independent owner registrations',
)
assert.deepEqual(
  boundedMediaClaimsForOwner(
    duplicateCompactGridOwners.filter(owner => owner.ownerKey !== firstCompactGridOwner),
    secondCompactGridOwner,
    4,
  ),
  ['shared-video-a', 'shared-video-b'],
  'unmounting one compact standalone grid must leave the other grid registered and able to claim thumbnails',
)
assert.deepEqual(
  boundedMediaClaimsForOwner([{ ownerKey: 'row-a', candidates: ['video-a'] }], 'row-a', 0),
  [],
  'a disabled media budget must schedule no native work',
)

console.log('media viewer state regressions passed')
