import assert from 'node:assert/strict'
import {
  adaptiveViewerActionLayout,
  adaptiveViewerDismissAllowed,
  adaptiveViewerNavigationTarget,
  reconcileAdaptiveViewerNavigation,
  supportedAdaptiveViewerFileIds,
  type AdaptiveViewerFile,
} from './adaptive-file-viewer-state'

const allKinds: AdaptiveViewerFile[] = [
  { id: 'new-image', kind: 'image' },
  { id: 'archive', kind: 'unsupported' },
  { id: 'report', kind: 'pdf' },
  { id: 'notes', kind: 'markdown' },
  { id: 'clip', kind: 'video' },
  { id: 'source', kind: 'text' },
  { id: 'report', kind: 'pdf' },
  { id: '   ', kind: 'image' },
]

assert.deepEqual(
  supportedAdaptiveViewerFileIds(allKinds),
  ['new-image', 'report', 'notes', 'clip', 'source'],
  'navigation must span every supported modality in caller order while excluding unsupported and duplicate files',
)

const initial = reconcileAdaptiveViewerNavigation(allKinds, 'report', 'new-image')
assert.equal(initial.currentId, 'report')
assert.equal(initial.index, 1)
assert.equal(initial.previousId, 'new-image')
assert.equal(initial.nextId, 'notes')
assert.equal(adaptiveViewerNavigationTarget(initial, -1), 'new-image')
assert.equal(adaptiveViewerNavigationTarget(initial, 1), 'notes')

const prepended = reconcileAdaptiveViewerNavigation(
  [{ id: 'newest-text', kind: 'text' }, ...allKinds],
  initial.currentId,
  'new-image',
)
assert.equal(prepended.currentId, 'report', 'prepending a newer supported file must retain the open file identity')
assert.equal(prepended.index, 2, 'the stable file may move indexes without changing selection')

const currentRemoved = reconcileAdaptiveViewerNavigation(
  allKinds.filter(file => file.id !== 'report'),
  'report',
  'new-image',
)
assert.equal(currentRemoved.currentId, 'new-image', 'removing the current file must fall back to the originally opened file')

const currentAndInitialRemoved = reconcileAdaptiveViewerNavigation(
  allKinds.filter(file => file.id !== 'report' && file.id !== 'new-image'),
  'report',
  'new-image',
)
assert.equal(currentAndInitialRemoved.currentId, 'notes', 'removing current and initial files must select the first remaining supported file')

const noSupportedFiles = reconcileAdaptiveViewerNavigation(
  [{ id: 'archive', kind: 'unsupported' }],
  'archive',
  'archive',
)
assert.equal(noSupportedFiles.currentId, null)
assert.equal(noSupportedFiles.index, -1)
assert.equal(adaptiveViewerNavigationTarget(noSupportedFiles, 1), null)

assert.deepEqual(adaptiveViewerActionLayout('phone', 5), {
  header: ['close', 'share', 'overflow'],
  footer: ['previous', 'next'],
  overflow: ['download', 'pin'],
  showFileRail: false,
}, 'phone layout must keep secondary actions out of its narrow header')
assert.deepEqual(adaptiveViewerActionLayout('phone', 1).footer, [], 'a one-file phone viewer needs no navigation rail')
assert.deepEqual(adaptiveViewerActionLayout('pad', 5), {
  header: ['close', 'previous', 'next', 'share', 'download', 'pin'],
  footer: [],
  overflow: [],
  showFileRail: true,
}, 'iPad must expose its full action set and file rail')
assert.deepEqual(
  adaptiveViewerActionLayout('pad', Number.NaN).header,
  ['close', 'share', 'download', 'pin'],
  'invalid counts must not expose unusable navigation controls',
)

assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'image', zoomScale: 1 }), true)
assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'image', zoomScale: 2 }), false, 'a zoomed image owns one-finger panning')
assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'image', zoomScale: Number.NaN }), false)

for (const kind of ['text', 'markdown', 'pdf'] as const) {
  assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind, scrollOffsetY: 0 }), true, `${kind} may pull down only at its top`)
  assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind, scrollOffsetY: 1 }), false, `${kind} scrolling must win below its top`)
  assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind, scrollOffsetY: -8 }), true, `${kind} top bounce remains dismissible`)
  assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind, scrollOffsetY: 0, selectionActive: true }), false, `${kind} text selection must win over dismissal`)
}

assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'video', scrubbing: false }), true)
assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'video', scrubbing: true }), false, 'video timeline scrubbing must win over dismissal')
assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'content', kind: 'unsupported' }), false)
assert.equal(adaptiveViewerDismissAllowed('pad', { source: 'content', kind: 'image', zoomScale: 1 }), false, 'iPad content remains dedicated to full-feature interaction')
assert.equal(adaptiveViewerDismissAllowed('pad', { source: 'header' }), true, 'iPad retains an explicit header pull-down surface')
assert.equal(adaptiveViewerDismissAllowed('phone', { source: 'header' }), true, 'phone header dismissal remains independent from content state')

console.log('adaptive file viewer state regressions passed')
