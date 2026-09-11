export const IMAGE_VIEWER_DISMISS_DISTANCE = 96
export const IMAGE_VIEWER_DISMISS_FLING_DISTANCE = 24
export const IMAGE_VIEWER_DISMISS_VELOCITY = 850
export const IMAGE_VIEWER_MIN_SCALE = 1
export const IMAGE_VIEWER_MAX_SCALE = 4
export const IMAGE_VIEWER_ZOOM_EPSILON = 0.02

const IMAGE_VIEWER_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const

export function clampImageViewerScale(value: number): number {
  'worklet'
  if (!Number.isFinite(value)) return IMAGE_VIEWER_MIN_SCALE
  return Math.max(IMAGE_VIEWER_MIN_SCALE, Math.min(IMAGE_VIEWER_MAX_SCALE, value))
}

export function imageViewerIsZoomed(value: number): boolean {
  'worklet'
  return Number.isFinite(value) && value > IMAGE_VIEWER_MIN_SCALE + IMAGE_VIEWER_ZOOM_EPSILON
}

export function nextImageViewerScale(value: number, direction: -1 | 1): number {
  const scale = clampImageViewerScale(value)
  if (direction > 0) {
    return IMAGE_VIEWER_ZOOM_STEPS.find(step => step > scale + IMAGE_VIEWER_ZOOM_EPSILON)
      ?? IMAGE_VIEWER_MAX_SCALE
  }
  return [...IMAGE_VIEWER_ZOOM_STEPS].reverse().find(step => step < scale - IMAGE_VIEWER_ZOOM_EPSILON)
    ?? IMAGE_VIEWER_MIN_SCALE
}

/** Keep a viewport-sized image from exposing empty space while it is panned. */
export function clampImageViewerTranslation(
  translation: number,
  viewportDimension: number,
  scale: number,
): number {
  'worklet'
  if (!Number.isFinite(translation) || !Number.isFinite(viewportDimension) || viewportDimension <= 0) return 0
  const maximum = viewportDimension * (clampImageViewerScale(scale) - 1) / 2
  return Math.max(-maximum, Math.min(maximum, translation))
}

/** Preserve the point beneath the user's fingers when a pinch changes scale. */
export function imageViewerPinchTranslation(
  startTranslation: number,
  focalPoint: number,
  viewportDimension: number,
  startScale: number,
  nextScale: number,
): number {
  'worklet'
  if (!Number.isFinite(viewportDimension) || viewportDimension <= 0) return 0
  const initialScale = clampImageViewerScale(startScale)
  const resolvedScale = clampImageViewerScale(nextScale)
  const initialTranslation = Number.isFinite(startTranslation) ? startTranslation : 0
  const focal = Number.isFinite(focalPoint) ? focalPoint : viewportDimension / 2
  const ratio = resolvedScale / initialScale
  const desired = (focal - viewportDimension / 2) * (1 - ratio) + initialTranslation * ratio
  return clampImageViewerTranslation(desired, viewportDimension, resolvedScale)
}

export function shouldDismissImageViewer(
  translationX: number,
  translationY: number,
  velocityY: number,
): boolean {
  'worklet'
  if (!Number.isFinite(translationX) || !Number.isFinite(translationY) || !Number.isFinite(velocityY)) return false
  if (translationY <= 0 || translationY <= Math.abs(translationX)) return false
  return translationY >= IMAGE_VIEWER_DISMISS_DISTANCE
    || (translationY >= IMAGE_VIEWER_DISMISS_FLING_DISTANCE && velocityY >= IMAGE_VIEWER_DISMISS_VELOCITY)
}
