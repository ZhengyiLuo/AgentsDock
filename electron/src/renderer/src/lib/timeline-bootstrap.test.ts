import { describe, expect, it } from 'vitest'
import {
  advanceTimelineHistoryBootstrap,
  initialTimelineHistoryBootstrapState
} from './timeline-bootstrap'

describe('initial timeline history bootstrap', () => {
  it('requests only enough semantic rows to fill the default history target', () => {
    const step = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 180,
      hasMore: true,
      loading: false,
      rowCount: 3,
      semanticPaging: true
    })

    expect(step.loadLimit).toBe(21)
    expect(step.state).toMatchObject({
      pagesStarted: 1,
      request: { cursor: 180, rowCount: 3 },
      stopped: false
    })
  })

  it('continues after a cursor advances and stops at the hard page cap', () => {
    let cursor = 100
    let step = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor,
      hasMore: true,
      loading: false,
      rowCount: 1,
      semanticPaging: true
    })
    expect(step.loadLimit).not.toBeNull()

    for (let page = 1; page <= 4; page += 1) {
      cursor -= 10
      const waiting = advanceTimelineHistoryBootstrap(step.state, {
        cursor,
        hasMore: true,
        loading: true,
        rowCount: page + 1,
        semanticPaging: true
      })
      expect(waiting.loadLimit).toBeNull()

      step = advanceTimelineHistoryBootstrap(waiting.state, {
        cursor,
        hasMore: true,
        loading: false,
        rowCount: page + 2,
        semanticPaging: true
      })
      if (page < 4) expect(step.loadLimit).not.toBeNull()
    }

    expect(step.state).toMatchObject({ pagesStarted: 4, stopped: true })
  })

  it('stops when the page does not advance the semantic cursor', () => {
    const started = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 50,
      hasMore: true,
      loading: false,
      rowCount: 1,
      semanticPaging: true
    })
    const finished = advanceTimelineHistoryBootstrap(started.state, {
      cursor: 50,
      hasMore: true,
      loading: false,
      rowCount: 2,
      semanticPaging: true
    })

    expect(finished.loadLimit).toBeNull()
    expect(finished.state.stopped).toBe(true)
  })

  it('does nothing when history is exhausted or enough rows are already loaded', () => {
    expect(advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: null,
      hasMore: false,
      loading: false,
      rowCount: 1
    }).state.stopped).toBe(true)

    expect(advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 10,
      hasMore: true,
      loading: false,
      rowCount: 24,
      semanticPaging: true
    }).state.stopped).toBe(true)
  })

  it('uses a full bounded raw page when semantic paging is unavailable or still unknown', () => {
    const legacy = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 180,
      hasMore: true,
      loading: false,
      rowCount: 3,
      semanticPaging: false
    })
    const unknown = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 180,
      hasMore: true,
      loading: false,
      rowCount: 3,
      semanticPaging: null
    })

    expect(legacy.loadLimit).toBe(480)
    expect(unknown.loadLimit).toBe(480)
  })

  it('restarts after an authoritative live source replacement', () => {
    const completed = advanceTimelineHistoryBootstrap(initialTimelineHistoryBootstrapState(), {
      cursor: 180,
      hasMore: true,
      loading: false,
      rowCount: 24,
      sourceKey: 'live:1',
      semanticPaging: true
    })
    expect(completed.state.stopped).toBe(true)

    const replacedButFull = advanceTimelineHistoryBootstrap(completed.state, {
      cursor: 90,
      hasMore: true,
      loading: false,
      rowCount: 24,
      sourceKey: 'live:2',
      semanticPaging: true
    })
    expect(replacedButFull.state).toMatchObject({
      pagesStarted: 0,
      sourceKey: 'live:2',
      request: null,
      stopped: true
    })

    const restarted = advanceTimelineHistoryBootstrap(replacedButFull.state, {
      cursor: 90,
      hasMore: true,
      loading: false,
      rowCount: 3,
      sourceKey: 'live:3',
      semanticPaging: true
    })

    expect(restarted.loadLimit).toBe(21)
    expect(restarted.state).toMatchObject({
      pagesStarted: 1,
      sourceKey: 'live:3',
      request: { cursor: 90, rowCount: 3 },
      stopped: false
    })
  })
})
