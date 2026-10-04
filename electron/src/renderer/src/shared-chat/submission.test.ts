import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { createSharedChatBridge, type SharedChatState } from './bridge'
import { receiveSharedChatState } from './SharedChatApp'
import { pendingTurnSubmissionAccepted, useAppStore } from '../store/app-store'

const prefix = '/interactive-chat/interactive_' + '1'.repeat(32)
const originalStore = useAppStore.getState()
const originalAPI = window.agentsDock
afterEach(() => {
  useAppStore.setState(originalStore, true)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: originalAPI })
  vi.restoreAllMocks()
})

describe('shared attachment submission reconciliation', () => {
  it.each(['immediate', 'later'] as const)('removes the optimistic copy from the exact %s acceptance despite changed file IDs', async delivery => {
    const session = { id: 'shared-one', title: 'Shared chat', backend: 'codex' as const }
    let state: SharedChatState = { revision: '1111111111111111:1', csrf: 'synthetic-csrf', session,
      events: [], queue: [], active: false, jobs: [], goal: { goal: null, time_budget_seconds: null },
      codex_runtime: null, claude_runtime: null, health: null, runtime_catalog: null }
    let requestId = ''
    const file = { id: `shared_file_YXR0YWNobWVudA.${'a'.repeat(64)}`, filename: 'proof.txt', content_type: 'text/plain', size: 5 }
    const acceptedEvent = (id: string, seq = 1): Event => ({ id: `event-${seq}`, seq, session_id: session.id,
      type: 'turn_started', ts: '2026-09-25T12:00:00Z', prompt: 'Read the attachment',
      shared_chat_id: prefix.split('/').at(-1), shared_chat_request_id: id,
      author_label: 'Collaborator', shared_files: [file] } as Event)
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/state')) return new Response(JSON.stringify(state))
      if (String(url).endsWith('/uploads')) return new Response(JSON.stringify({ id: 'upload_temporary',
        name: file.filename, media_type: file.content_type, byte_size: file.size }))
      const body = JSON.parse(String(init?.body))
      requestId = body.request_id
      if (delivery === 'immediate') state = { ...state, revision: '1111111111111111:2', active: true, events: [acceptedEvent(requestId)] }
      return new Response(JSON.stringify({ accepted: true, request_id: requestId, queued: false }))
    })
    useAppStore.setState({ switchingProfileId: null, snapshots: {}, pendingTurnSubmissions: {},
      turnAdmissionTokens: {}, chatReferencesBySession: {}, teamReferencesBySession: {},
      agentRoutesBySession: {}, agentRouteLoadingSessionIds: new Set(), agentRouteErrorsBySession: {} })
    const bridge = createSharedChatBridge(prefix, value => receiveSharedChatState(value, prefix), vi.fn(), request)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: bridge.api })
    try {
      await bridge.refresh()
      const ref = await bridge.api.files.stageNativeFile(new File(['proof'], file.filename, { type: file.content_type }))
      const uploaded = await bridge.api.files.upload(session.id, [ref!.path])
      useAppStore.setState({ connected: true, drafts: { [session.id]: 'Read the attachment' },
        uploadsBySession: { [session.id]: uploaded }, uploadPathsBySession: {} })
      const token = useAppStore.getState().beginTurnAdmission(session.id)!
      useAppStore.getState().stagePendingTurnSubmission(session.id, token, { prompt: 'Read the attachment' })
      const pending = useAppStore.getState().pendingTurnSubmissions[session.id]
      expect(pending.sharedChatRequestId).toEqual(expect.any(String))
      expect(pendingTurnSubmissionAccepted(pending, [acceptedEvent(pending.sharedChatRequestId!)])).toBe(false)
      expect(await useAppStore.getState().sendPromptForSession(session.id, undefined, false, { admissionToken: token })).toBe(true)
      expect(requestId).toBe(pending.sharedChatRequestId)
      if (delivery === 'later') {
        expect(useAppStore.getState().pendingTurnSubmissions[session.id]?.phase).toBe('submitted')
        state = { ...state, revision: '1111111111111111:2', events: [acceptedEvent('another-browser-request')] }
        await bridge.refresh()
        expect(useAppStore.getState().pendingTurnSubmissions[session.id]).toBeTruthy()
        state = { ...state, revision: '1111111111111111:3', events: [...state.events, acceptedEvent(requestId, 2)] }
        await bridge.refresh()
      }
      expect(useAppStore.getState().pendingTurnSubmissions[session.id]).toBeUndefined()
      const events = useAppStore.getState().snapshots[session.id].events
      const accepted = events.find(event => event.shared_chat_request_id === requestId)!
      expect(accepted.file_ids).toEqual([file.id])
      expect(accepted.file_ids).not.toEqual(uploaded.map(file => file.id))
      expect(events.filter(event => event.shared_chat_request_id === requestId)).toHaveLength(1)
      expect(useAppStore.getState().error).toBeNull()
    } finally { bridge.close() }
  })
})
