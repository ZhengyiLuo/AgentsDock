import {
  clampImageViewerScale,
  clampImageViewerTranslation,
  IMAGE_VIEWER_DISMISS_DISTANCE,
  IMAGE_VIEWER_DISMISS_FLING_DISTANCE,
  IMAGE_VIEWER_MAX_SCALE,
  IMAGE_VIEWER_MIN_SCALE,
  IMAGE_VIEWER_DISMISS_VELOCITY,
  imageViewerIsZoomed,
  imageViewerPinchTranslation,
  nextImageViewerScale,
  shouldDismissImageViewer,
} from './image-viewer-gesture'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(shouldDismissImageViewer(0, IMAGE_VIEWER_DISMISS_DISTANCE, 0), 'a deliberate downward drag must dismiss the viewer')
assert(shouldDismissImageViewer(4, IMAGE_VIEWER_DISMISS_FLING_DISTANCE, IMAGE_VIEWER_DISMISS_VELOCITY), 'a short fast downward flick must dismiss the viewer')
assert(!shouldDismissImageViewer(0, IMAGE_VIEWER_DISMISS_DISTANCE - 1, IMAGE_VIEWER_DISMISS_VELOCITY - 1), 'a short slow drag must stay open')
assert(!shouldDismissImageViewer(0, IMAGE_VIEWER_DISMISS_FLING_DISTANCE - 1, IMAGE_VIEWER_DISMISS_VELOCITY + 500), 'velocity alone must not dismiss on an accidental touch')
assert(!shouldDismissImageViewer(0, -IMAGE_VIEWER_DISMISS_DISTANCE, -IMAGE_VIEWER_DISMISS_VELOCITY), 'an upward swipe must stay open')
assert(!shouldDismissImageViewer(IMAGE_VIEWER_DISMISS_DISTANCE * 2, IMAGE_VIEWER_DISMISS_DISTANCE, IMAGE_VIEWER_DISMISS_VELOCITY * 2), 'a horizontal page swipe must not dismiss vertically')
assert(!shouldDismissImageViewer(Number.NaN, IMAGE_VIEWER_DISMISS_DISTANCE, IMAGE_VIEWER_DISMISS_VELOCITY), 'invalid gesture geometry must stay open')

assert(clampImageViewerScale(0.2) === IMAGE_VIEWER_MIN_SCALE, 'image zoom must clamp to its minimum')
assert(clampImageViewerScale(8) === IMAGE_VIEWER_MAX_SCALE, 'image zoom must clamp to its maximum')
assert(clampImageViewerScale(Number.NaN) === IMAGE_VIEWER_MIN_SCALE, 'invalid image zoom must fail closed at 1x')
assert(!imageViewerIsZoomed(1.02), 'native gesture noise at the epsilon must remain unzoomed')
assert(imageViewerIsZoomed(1.021), 'a deliberate pinch must own panning above the epsilon')
assert(nextImageViewerScale(1, 1) === 1.5, 'Zoom In must advance to the first bounded step')
assert(nextImageViewerScale(1.5, 1) === 2, 'Zoom In must advance through stable steps')
assert(nextImageViewerScale(4, 1) === 4, 'Zoom In must stop at 4x')
assert(nextImageViewerScale(3, -1) === 2, 'Zoom Out must return through stable steps')
assert(nextImageViewerScale(1, -1) === 1, 'Zoom Out must stop at 1x')
assert(clampImageViewerTranslation(500, 390, 2) === 195, 'panning must stop at the scaled horizontal edge')
assert(clampImageViewerTranslation(-900, 700, 3) === -700, 'negative panning must stop at the scaled vertical edge')
assert(clampImageViewerTranslation(100, 0, 2) === 0, 'invalid viewport geometry must not move the image')
assert(imageViewerPinchTranslation(0, 195, 390, 1, 2) === 0, 'a centered pinch must stay centered')
assert(imageViewerPinchTranslation(0, 300, 390, 1, 2) === -105, 'a pinch must preserve its focal point')
assert(imageViewerPinchTranslation(0, Number.NaN, 390, 1, 2) === 0, 'an invalid focal point must fall back to center')

console.log('image viewer dismissal regressions passed')
