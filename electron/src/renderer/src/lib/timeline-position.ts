import type { ViewState } from '@shared/types'

export type TimelineInitialLocation = number | { index: number | 'LAST'; align: 'start' | 'end'; offset?: number } | undefined

export function initialTimelineLocation(saved: ViewState | null | undefined, itemKeys: string[], unread: boolean): TimelineInitialLocation {
  if (!unread && saved?.atBottom === false && saved.topItemId) {
    const index = itemKeys.indexOf(saved.topItemId)
    if (index >= 0) return { index, align: 'start', offset: -(saved.topOffset ?? 0) }
  }
  return { index: 'LAST', align: 'end' }
}
