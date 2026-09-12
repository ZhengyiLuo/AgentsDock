import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile, AppEventMap, ClaudeRuntimeSnapshot, CodexGoalSnapshot, CodexRuntimeSnapshot, Event, Health, Job, LanguageSettingsSnapshot, NativeFileRef, QueuedTurn, RuntimeCatalog, Session, SessionSnapshot, ViewState } from '@shared/types'

/** The server emits native DTOs, scoped and sanitized for the one redeemed chat. */
export interface SharedChatState {
  revision: string
  csrf?: string
  session: Session
  events: Event[]
  queue: QueuedTurn[]
  active: boolean
  goal: CodexGoalSnapshot
  jobs: Job[]
  codex_runtime: CodexRuntimeSnapshot | null
  claude_runtime: ClaudeRuntimeSnapshot | null
  health: Health | null
  runtime_catalog: RuntimeCatalog | null
  hasMoreEvents?: boolean
  nextTimelineBefore?: number | null
  eventsTotal?: number | null
}

const denied = (): never => { throw new Error('This action is not available in a shared chat.') }
const unsupported: unknown = new Proxy(() => Promise.reject(new Error('This action is not available in a shared chat.')), {
  get: (_target, key) => key === 'then' ? undefined : unsupported
})

export function createSharedChatBridge(
  prefix: string,
  receive: (state: SharedChatState) => void,
  connection: (connected: boolean, error?: string) => void,
  request: typeof fetch = fetch
) {
  if (!/^\/interactive-chat\/interactive_[a-f0-9]{32}$/.test(prefix)) throw new Error('Invalid shared chat URL.')
  let state: SharedChatState | null = null
  let csrf = ''
  let source: EventSource | null = null
  let closed = false
  let streamEpoch = 0
  let refreshRequest = 0
  let viewState: ViewState | null = null
  let language: LanguageSettingsSnapshot = { preference: 'en', systemLocale: navigator.language }
  const preferences = new Map<string, unknown>()
  const staged = new Map<string, File>()
  const uploaded = new Map<string, AgentFile>()
  const listeners = new Map<string, Set<(value: never) => void>>()
  const emit = <K extends keyof AppEventMap>(name: K, value: AppEventMap[K]) => {
    for (const listener of listeners.get(name) ?? []) listener(value as never)
  }
  const current = () => { if (!state || closed) return denied(); return state }
  const exact = (id: string) => { if (id !== current().session.id) denied() }
  async function json(path: '/state' | '/redeem' | '/controls' | '/prompts' | '/uploads', init: RequestInit = {}) {
    if (closed) denied()
    const response = await request(prefix + path, {
      ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { ...(init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-Chat-CSRF': csrf } : {}), ...init.headers }
    })
    if (!response.ok) {
      let message = `Shared chat request failed (${response.status}).`
      try { const value = await response.json(); if (typeof value.detail === 'string') message = value.detail } catch { /* Keep bounded status-only fallback. */ }
      if ([401, 403, 410].includes(response.status)) { source?.close(); connection(false, message) }
      throw new Error(message)
    }
    return response.json()
  }
  const apply = (next: SharedChatState, catalogOnly = false) => {
    if (closed || !next || !next.session || typeof next.session.id !== 'string'
      || !Array.isArray(next.events) || !Array.isArray(next.queue) || !Array.isArray(next.jobs)
      || typeof next.revision !== 'string' || !/^[a-f0-9]{16}:[0-9]+$/.test(next.revision)
      || next.events.some(event => event.session_id && event.session_id !== next.session.id)
      || (state && next.session.id !== state.session.id)) throw new Error('Invalid shared chat state.')
    if (typeof next.csrf === 'string') csrf = next.csrf
    if (state && !catalogOnly) {
      const [oldIdentity, oldGeneration] = state.revision.split(':')
      const [identity, generation] = next.revision.split(':')
      if (oldIdentity === identity && BigInt(generation) <= BigInt(oldGeneration)) return
    }
    state = next
    receive(next)
    connection(true)
    emit('server:sessions', { profileId: 'shared-chat', profileGeneration: 1, serverIdentity: prefix, sessions: [next.session] })
    if (next.session.backend === 'codex' || next.session.backend === 'claude') emit('server:provider-runtime', {
      profileId: 'shared-chat', profileGeneration: 1, serverIdentity: prefix,
      event: { type: 'provider_runtime_changed', session_id: next.session.id, backend: next.session.backend, runtime: 'context_usage', ephemeral: true }
    })
  }
  async function refresh() {
    const epoch = streamEpoch
    const requestId = ++refreshRequest
    const next = await json('/state')
    if (epoch === streamEpoch && requestId === refreshRequest) apply(next)
    return current()
  }
  async function reconcileAccepted() {
    try { await refresh() }
    catch { connection(false, 'The action was accepted, but its updated state could not be loaded. Reopen this page before trying it again.') }
  }
  async function action(name: string, payload: Record<string, unknown> = {}, read = false) {
    current()
    const result = await json('/controls', { method: 'POST', body: JSON.stringify({ action: name, payload, request_id: crypto.randomUUID() }) })
    // An unknown/failed acknowledgment is never automatically retried.
    if (!read) await reconcileAccepted()
    return result.result
  }
  function snapshot(): SessionSnapshot {
    const value = current()
    return { session: value.session, events: value.events, queuedTurns: value.queue, files: [], filesTotal: 0,
      hasMoreEvents: value.hasMoreEvents === true, nextTimelineBefore: value.nextTimelineBefore,
      eventsTotal: value.eventsTotal, semanticPaging: true, historyVerified: true, cachedAt: Date.now(), viewState }
  }
  const stage = (file: File): NativeFileRef => {
    if (staged.size >= 4 || file.size > 8 * 1024 * 1024) throw new Error('Choose at most 4 files, up to 8 MiB each.')
    const path = `guest-upload:${crypto.randomUUID()}`
    staged.set(path, file)
    return { path, name: file.name, size: file.size, type: file.type }
  }
  const group = <T extends object>(methods: T): T => new Proxy(methods, { get: (target, key) => key in target ? Reflect.get(target, key) : unsupported })
  const methods = {
    sharedChat: true,
    events: { on(name: string, listener: (value: never) => void) { const bucket = listeners.get(name) ?? new Set(); bucket.add(listener); listeners.set(name, bucket); return () => { bucket.delete(listener) } } },
    language: { get: async () => language, set: async (preference: LanguageSettingsSnapshot['preference']) => { language = { ...language, preference }; emit('app:language', language); return language } },
    native: group({ analyticsDisabled: true, log: async () => undefined, writeClipboard: async (text: string) => navigator.clipboard.writeText(text), readyForNotifications: async () => false, readyForSecurePeerInvite: async () => false }),
    preferences: { get: async <T>(key: string, fallback: T) => preferences.has(key) ? preferences.get(key) as T : fallback, set: async (key: string, value: unknown) => { preferences.set(key, value) }, getScoped: async <T>(_scope: unknown, key: string, fallback: T) => preferences.has(key) ? preferences.get(key) as T : fallback, setScoped: async (_scope: unknown, key: string, value: unknown) => { preferences.set(key, value) } },
    sessions: group({ list: async () => [current().session], update: async (id: string, patch: Record<string, unknown>) => { exact(id); const allowed = new Set(['title', 'model', 'effort', 'system_prompt', 'codex_approval_policy', 'codex_sandbox_mode', 'codex_permission_profile', 'codex_approvals_reviewer', 'claude_permission_mode', 'cursor_permission_mode', 'provider_jobs_access']); const payload = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)); if (Object.keys(payload).some(key => !allowed.has(key))) denied(); await action('settings.update', payload); return current().session }, markRead: async (id: string) => { exact(id); return current().session } }),
    timeline: group({ cached: async (id: string) => { exact(id); return snapshot() }, open: async (id: string) => { exact(id); await refresh(); return snapshot() }, older: async (id: string, before: number, limit = 100) => { exact(id); return action('timeline.older', { before, limit }, true) }, historicalOlder: async (id: string, before: number, limit = 100) => { exact(id); return action('timeline.older', { before, limit }, true) }, around: async (id: string, anchorSeq: number, limit = 100) => { exact(id); return action('timeline.around', { anchor_seq: anchorSeq, limit }, true) }, trace: async (id: string, runId: string, anchorSeq: number, after = 0, limit = 100) => { exact(id); return action('timeline.trace', { run_id: runId, anchor_seq: anchorSeq, after, limit }, true) }, index: async (id: string) => { exact(id); return action('timeline.index', {}, true) }, subscribe: async (id: string) => { exact(id) }, unsubscribe: async (id: string) => { exact(id) }, saveViewState: async (_scope: unknown, value: ViewState) => { exact(value.sessionId); viewState = value }, getViewState: async (_scope: unknown, id: string) => { exact(id); return viewState }, search: async (id: string) => { exact(id); return [] } }),
    turns: { send: async (input: { sessionId: string; prompt: string; fileIds: string[]; chatReferences?: unknown[]; teamReferences?: unknown[]; skillSelection?: unknown }) => { exact(input.sessionId); if (input.chatReferences?.length || input.teamReferences?.length || input.skillSelection || input.fileIds.length > 4 || input.fileIds.some(id => !uploaded.has(id))) denied(); const result = await json('/prompts', { method: 'POST', body: JSON.stringify({ prompt: input.prompt, upload_ids: input.fileIds, request_id: crypto.randomUUID() }) }); await reconcileAccepted(); return { ...result, session: current().session } }, stop: async (id: string) => { exact(id); return action('turn.stop') } },
    queue: { list: async (id: string) => { exact(id); return current().queue }, update: async (id: string, queuedId: string, prompt: string, chats?: unknown[], _capabilities?: string[], teams?: unknown[], revision?: number) => { exact(id); if (chats?.length || teams?.length) denied(); await action('queue.edit', { id: queuedId, prompt, ...(revision === undefined ? {} : { expected_message_revision: revision }) }); return true }, remove: async (id: string, queuedId: string) => { exact(id); await action('queue.delete', { id: queuedId }); return true }, move: async (id: string, queuedId: string, direction: string, adjacent?: string) => { exact(id); await action('queue.move', { id: queuedId, direction, ...(adjacent ? { expected_adjacent_queued_id: adjacent } : {}) }); return current().queue }, runNow: async (id: string, queuedId: string) => { exact(id); return action('queue.run_now', { id: queuedId }) } },
    codex: group({ runtime: async (id: string) => { exact(id); return current().codex_runtime }, permissionProfiles: async (id: string) => { exact(id); return current().codex_runtime?.permission_profiles ?? [] }, goal: async (id: string) => { exact(id); return current().goal }, setGoal: async (id: string, input: Record<string, unknown>) => { exact(id); await action('goal.set', input); return current().goal }, clearGoal: async (id: string) => { exact(id); await action('goal.delete'); return current().goal }, resolveInteraction: async (id: string, interactionId: string, response: unknown) => { exact(id); return action('approval.respond', { backend: 'codex', id: interactionId, response }) } }),
    claude: group({ runtime: async (id: string) => { exact(id); return current().claude_runtime }, refreshContextUsage: async (id: string) => { exact(id); return current().claude_runtime }, resolveInteraction: async (id: string, interactionId: string, response: unknown) => { exact(id); return action('approval.respond', { backend: 'claude', id: interactionId, response }) } }),
    jobs: { list: async () => current().jobs, runs: async (id: string, jobId: string, beforeSeq?: number, limit = 25, timelineGroupId?: string) => { exact(id); return action('jobs.runs', { id: jobId, before_seq: beforeSeq, limit, timeline_group_id: timelineGroupId }, true) }, create: async (input: { session_id: string } & Record<string, unknown>) => { exact(input.session_id); const { session_id: _id, ...payload } = input; return (await action('job.create', payload))?.job }, update: async (id: string, patch: Record<string, unknown>) => (await action('job.update', { id, ...patch }))?.job, remove: async (id: string) => { await action('job.delete', { id }); return true }, run: async (id: string) => action('job.run', { id }) },
    pins: group({ list: async () => [] }),
    files: group({
      choose: () => new Promise<NativeFileRef[]>((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = () => {
          try {
            const files = Array.from(input.files ?? [])
            // Validate the entire selection before staging any file.
            if (files.length + staged.size > 4 || files.some(file => file.size > 8 * 1024 * 1024)) {
              throw new Error('Choose at most 4 files, up to 8 MiB each.')
            }
            resolve(files.map(stage))
          } catch (error) { reject(error) }
          finally { input.remove() }
        }
        input.oncancel = () => { input.remove(); resolve([]) }
        input.click()
      }),
      pathForFile: () => '',
      stageNativeFile: async (file: File) => stage(file),
      stageClipboardImage: async (data: ArrayBuffer, name: string, type: string) => stage(new File([data], name, { type })),
      upload: async (id: string, paths: string[]) => {
        exact(id)
        const result: AgentFile[] = []
        for (const path of paths) {
          const file = staged.get(path)
          if (!file) throw new Error('Select the upload again.')
          const value = await json('/uploads', {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Chat-Filename': encodeURIComponent(file.name) },
            body: file
          })
          const item = { id: value.id, session_id: id, filename: value.name, content_type: value.media_type, size: value.byte_size } as AgentFile
          uploaded.set(item.id, item)
          staged.delete(path)
          result.push(item)
        }
        return result
      },
      mediaURL: () => '',
      list: async (id: string) => { exact(id); return { files: [], total: 0, has_more: false } },
      findEvent: async (id: string) => { exact(id); return null }
    })
  }
  const api = group(methods) as unknown as AgentsDockAPI
  return {
    api, snapshot, refresh,
    async redeem(token: string) { if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid invitation.'); const result = await json('/redeem', { method: 'POST', body: JSON.stringify({ invitation_token: token }) }); csrf = result.csrf },
    async start() {
      await refresh()
      source?.close()
      source = new EventSource(prefix + '/events', { withCredentials: true })
      source.addEventListener('state', event => { try { ++streamEpoch; apply(JSON.parse((event as MessageEvent).data)) } catch { source?.close(); connection(false, 'The shared chat stream could not be read. Reopen this page to reconnect.') } })
      source.addEventListener('unavailable', () => { closed = true; source?.close(); connection(false, 'This shared chat is no longer available.') })
      source.onerror = () => { source?.close(); connection(false, 'Connection interrupted. Reopen this page to reconnect.') }
    },
    async catalog() { const value = await action('runtime.catalog', {}, true); if (state && !closed) apply({ ...state, runtime_catalog: value }, true) },
    close() { closed = true; source?.close(); listeners.clear(); staged.clear(); uploaded.clear() }
  }
}
