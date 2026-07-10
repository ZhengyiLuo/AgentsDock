export const TIMELINE_VIEWPORT_LAYOUT_EVENT = 'agentsdock:timeline-viewport-layout'

export type TimelineViewportLayoutPhase = 'begin' | 'update' | 'end'

export interface TimelineViewportLayoutDetail {
  phase: TimelineViewportLayoutPhase
}

export function notifyTimelineViewportLayout(phase: TimelineViewportLayoutPhase): void {
  window.dispatchEvent(new CustomEvent<TimelineViewportLayoutDetail>(
    TIMELINE_VIEWPORT_LAYOUT_EVENT,
    { detail: { phase } }
  ))
}
