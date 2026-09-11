export const DEFAULT_TIMELINE_HISTORY_ROW_TARGET = 24
export const MAX_TIMELINE_HISTORY_BOOTSTRAP_PAGES = 4
export const LEGACY_TIMELINE_HISTORY_PAGE_LIMIT = 480

export interface TimelineHistoryBootstrapState {
  pagesStarted: number
  sourceKey: string | null
  request: {
    cursor: number
    rowCount: number
  } | null
  stopped: boolean
}

export interface TimelineHistoryBootstrapInput {
  cursor: number | null
  hasMore: boolean
  loading: boolean
  rowCount: number
  sourceKey?: string | null
  semanticPaging?: boolean | null
  rowTarget?: number
  maxPages?: number
}

export interface TimelineHistoryBootstrapStep {
  state: TimelineHistoryBootstrapState
  loadLimit: number | null
}

export function initialTimelineHistoryBootstrapState(): TimelineHistoryBootstrapState {
  return { pagesStarted: 0, sourceKey: null, request: null, stopped: false }
}

export function advanceTimelineHistoryBootstrap(
  current: TimelineHistoryBootstrapState,
  input: TimelineHistoryBootstrapInput
): TimelineHistoryBootstrapStep {
  let state = input.sourceKey !== undefined && input.sourceKey !== current.sourceKey
    ? { ...initialTimelineHistoryBootstrapState(), sourceKey: input.sourceKey }
    : current
  if (state.stopped) return { state, loadLimit: null }

  const rowTarget = Math.max(1, Math.floor(input.rowTarget ?? DEFAULT_TIMELINE_HISTORY_ROW_TARGET))
  const maxPages = Math.max(1, Math.floor(input.maxPages ?? MAX_TIMELINE_HISTORY_BOOTSTRAP_PAGES))

  if (input.rowCount >= rowTarget || !input.hasMore) {
    return { state: { ...state, request: null, stopped: true }, loadLimit: null }
  }

  if (state.request) {
    if (input.loading) return { state, loadLimit: null }
    if (input.cursor == null || input.cursor === state.request.cursor) {
      return { state: { ...state, request: null, stopped: true }, loadLimit: null }
    }
    state = { ...state, request: null }
  } else if (input.loading) {
    return { state, loadLimit: null }
  }

  if (state.pagesStarted >= maxPages || input.cursor == null) {
    return { state: { ...state, stopped: true }, loadLimit: null }
  }

  return {
    state: {
      ...state,
      pagesStarted: state.pagesStarted + 1,
      request: { cursor: input.cursor, rowCount: input.rowCount }
    },
    loadLimit: input.semanticPaging === true
      ? Math.max(1, rowTarget - input.rowCount)
      : LEGACY_TIMELINE_HISTORY_PAGE_LIMIT
  }
}
