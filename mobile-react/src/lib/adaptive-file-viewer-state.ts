import type { MobileFileViewerKind, MobileFileViewerLayout } from './file-viewer'

export type SupportedMobileFileViewerKind = Exclude<MobileFileViewerKind, 'unsupported'>

export interface AdaptiveViewerFile {
  id: string
  kind: MobileFileViewerKind
}

export interface AdaptiveViewerNavigation {
  fileIds: string[]
  currentId: string | null
  index: number
  previousId: string | null
  nextId: string | null
}

export type AdaptiveViewerAction =
  | 'close'
  | 'previous'
  | 'next'
  | 'share'
  | 'download'
  | 'pin'
  | 'overflow'

export interface AdaptiveViewerActionLayout {
  header: AdaptiveViewerAction[]
  footer: AdaptiveViewerAction[]
  overflow: AdaptiveViewerAction[]
  showFileRail: boolean
}

export type AdaptiveViewerDismissInteraction =
  | { source: 'header' }
  | { source: 'content'; kind: 'image'; zoomScale: number }
  | { source: 'content'; kind: 'text' | 'markdown' | 'pdf'; scrollOffsetY: number; selectionActive?: boolean }
  | { source: 'content'; kind: 'video'; scrubbing: boolean }
  | { source: 'content'; kind: 'unsupported' }

const IMAGE_DISMISS_MAX_ZOOM_SCALE = 1.01
const DOCUMENT_DISMISS_MAX_SCROLL_OFFSET = 0.5

/**
 * Preserve the caller's newest-first ordering while removing unsupported,
 * empty, and duplicate identities from the viewer's navigation domain.
 */
export function supportedAdaptiveViewerFileIds(files: readonly AdaptiveViewerFile[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const file of files) {
    const id = file.id.trim()
    if (!id || file.kind === 'unsupported' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Reconcile by stable file identity rather than array index so a newer file
 * arriving at the front cannot move the open viewer to a different file.
 */
export function reconcileAdaptiveViewerNavigation(
  files: readonly AdaptiveViewerFile[],
  currentId: string | null,
  initialId: string,
): AdaptiveViewerNavigation {
  const fileIds = supportedAdaptiveViewerFileIds(files)
  const resolvedId = currentId && fileIds.includes(currentId)
    ? currentId
    : fileIds.includes(initialId)
      ? initialId
      : fileIds[0] ?? null
  const index = resolvedId == null ? -1 : fileIds.indexOf(resolvedId)
  return {
    fileIds,
    currentId: resolvedId,
    index,
    previousId: index > 0 ? fileIds[index - 1] : null,
    nextId: index >= 0 && index < fileIds.length - 1 ? fileIds[index + 1] : null,
  }
}

export function adaptiveViewerNavigationTarget(
  navigation: Pick<AdaptiveViewerNavigation, 'fileIds' | 'index'>,
  offset: -1 | 1,
): string | null {
  if (navigation.index < 0) return null
  return navigation.fileIds[navigation.index + offset] ?? null
}

/** Keep phone chrome sparse while exposing the complete action set on iPad. */
export function adaptiveViewerActionLayout(
  layout: MobileFileViewerLayout,
  fileCount: number,
): AdaptiveViewerActionLayout {
  const hasNavigation = Number.isFinite(fileCount) && fileCount > 1
  if (layout === 'pad') {
    return {
      header: [
        'close',
        ...(hasNavigation ? ['previous', 'next'] as const : []),
        'share',
        'download',
        'pin',
      ],
      footer: [],
      overflow: [],
      showFileRail: true,
    }
  }
  return {
    header: ['close', 'share', 'overflow'],
    footer: hasNavigation ? ['previous', 'next'] : [],
    overflow: ['download', 'pin'],
    showFileRail: false,
  }
}

/**
 * Gate the phone pull-down gesture before applying its distance/velocity
 * threshold. iPad content gestures stay dedicated to its full-feature viewer;
 * the header remains a deterministic pull-down surface on either layout.
 */
export function adaptiveViewerDismissAllowed(
  layout: MobileFileViewerLayout,
  interaction: AdaptiveViewerDismissInteraction,
): boolean {
  if (interaction.source === 'header') return true
  if (layout === 'pad') return false
  if (interaction.kind === 'image') {
    return Number.isFinite(interaction.zoomScale)
      && interaction.zoomScale >= 1
      && interaction.zoomScale <= IMAGE_DISMISS_MAX_ZOOM_SCALE
  }
  if (interaction.kind === 'video') return !interaction.scrubbing
  if (interaction.kind === 'unsupported') return false
  return Number.isFinite(interaction.scrollOffsetY)
    && interaction.scrollOffsetY <= DOCUMENT_DISMISS_MAX_SCROLL_OFFSET
    && interaction.selectionActive !== true
}
