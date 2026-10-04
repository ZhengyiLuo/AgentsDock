import { afterEach, describe, expect, it } from 'vitest'
import type { Event, ViewState } from '@shared/types'
import { clearTimelineViewStates, pendingTurnMessageItem, rememberTimelineViewState, resolveTimelineLiveState, savedTimelineViewState, timelineActiveRunId } from './Timeline'
import { pendingTurnSubmissionAccepted, type PendingTurnSubmission } from '../store/app-store'

function viewState(topItemId: string): ViewState {
  return {
    sessionId: 'shared-chat',
    topItemId,
    topOffset: 10,
    atBottom: false,
    updatedAt: 1
  }
}

describe('profile-scoped timeline view state', () => {
  afterEach(clearTimelineViewStates)

  it('keeps anchors separate when profiles contain the same session ID', () => {
    const profileA = viewState('profile-a-row')
    const profileB = viewState('profile-b-row')

    rememberTimelineViewState('profile-a', profileA)
    rememberTimelineViewState('profile-b', profileB)

    expect(savedTimelineViewState('profile-a', 'shared-chat')).toBe(profileA)
    expect(savedTimelineViewState('profile-b', 'shared-chat')).toBe(profileB)
  })
})

describe('timeline live-state reconciliation', () => {
  it('keeps a server-active turn live despite stale Codex idle or unloaded state', () => {
    expect(resolveTimelineLiveState({ type: 'idle' }, true, true)).toBe(true)
    expect(resolveTimelineLiveState({ type: 'notLoaded' }, true, true)).toBe(true)
  })

  it('does not treat notLoaded alone as proof that an AgentsDock turn ended', () => {
    expect(resolveTimelineLiveState({ type: 'notLoaded' }, false, false)).toBeNull()
    expect(resolveTimelineLiveState({ type: 'notLoaded' }, true, false)).toBe(false)
  })

  it('settles a stale provider-active thread when authoritative health is idle', () => {
    expect(resolveTimelineLiveState({ type: 'idle' }, false, false)).toBe(false)
    expect(resolveTimelineLiveState({ type: 'active', activeFlags: [] }, true, false)).toBe(false)
  })

  it('uses provider activity only before authoritative health is known', () => {
    expect(resolveTimelineLiveState({ type: 'active', activeFlags: [] }, false, false)).toBe(true)
  })
})

describe('timeline active-run inference', () => {
  const start: Event = {
    id: 'start', session_id: 'chat-1', seq: 1, type: 'turn_started',
    ts: '2026-09-10T00:00:00Z', backend: 'codex', run_id: 'live-run', prompt: 'Continue the task'
  }
  const goalContext: Event = {
    ...start, id: 'goal-context', seq: 2, run_id: 'import_goal', prompt: '',
    imported: true, metadata_only: true, provider_runtime_context: 'goal'
  }

  it('keeps an imported goal context from becoming or replacing the active run', () => {
    expect(timelineActiveRunId([goalContext])).toBeNull()
    expect(timelineActiveRunId([start, goalContext])).toBe('live-run')
    expect(timelineActiveRunId([
      start, goalContext, { ...start, id: 'finish', seq: 3, type: 'turn_finished' }
    ])).toBeNull()
  })

  it('preserves native starts but never assigns live ownership to saved user history', () => {
    const userStart = { ...goalContext, provider_user_authored: true, prompt: 'Continue my goal' }
    expect(timelineActiveRunId([start, userStart])).toBe('live-run')
    expect(timelineActiveRunId([start, { ...userStart, imported: false, run_id: 'native-next' }])).toBe('native-next')
    expect(timelineActiveRunId([
      start, userStart, { ...userStart, id: 'finish', seq: 3, type: 'turn_finished', metadata_only: false }
    ])).toBe('live-run')
  })
})

describe('pending outbound timeline presentation', () => {
  const pending: PendingTurnSubmission = {
    token: 'admission-1',
    prompt: 'Run the checks',
    files: [{ id: 'file-1', filename: 'report.txt', content_type: 'text/plain' }],
    uploadPaths: [],
    chatReferences: [],
    teamReferences: [],
    createdAt: Date.parse('2026-09-18T18:30:00Z'),
    afterSeq: 8,
    mode: 'start',
    phase: 'submitting',
    consumeComposer: true
  }

  it('builds a renderer-only pending user row without changing server history', () => {
    const item = pendingTurnMessageItem('chat-1', pending)

    expect(item).toMatchObject({
      kind: 'message', role: 'user', pending: true, pendingPhase: 'submitting',
      key: 'pending-turn:admission-1', files: pending.files
    })
    expect(item.event).toMatchObject({
      session_id: 'chat-1', type: 'turn_started', prompt: 'Run the checks',
      file_ids: ['file-1'], provider_user_authored: true
    })
  })

  it('hides the pending row only for a matching newer authoritative admission', () => {
    const accepted: Event = {
      id: 'accepted', session_id: 'chat-1', seq: 9, type: 'turn_started',
      ts: '2026-09-18T18:30:01Z', prompt: 'Run the checks', file_ids: ['file-1']
    }

    expect(pendingTurnSubmissionAccepted({ ...pending, phase: 'preflight' }, [accepted])).toBe(false)
    expect(pendingTurnSubmissionAccepted(pending, [{ ...accepted, seq: 8 }])).toBe(false)
    expect(pendingTurnSubmissionAccepted(pending, [{ ...accepted, prompt: 'Another request' }])).toBe(false)
    expect(pendingTurnSubmissionAccepted(pending, [{ ...accepted, file_ids: [] }])).toBe(false)
    expect(pendingTurnSubmissionAccepted(pending, [accepted])).toBe(true)
    expect(pendingTurnSubmissionAccepted(pending, [{ ...accepted, type: 'turn_queued' }])).toBe(true)
  })
})
