import type { AgentsDockAPI } from '@shared/ipc'
import { secureRandomUUID } from '../lib/browser-crypto'
import { copySharedChatText } from './clipboard'
import { isSharedFileId, isSharedVideoId, projectSharedVideoEvents } from './videos'
import type { AgentFile, AppEventMap, ClaudeRuntimeSnapshot, CodexGoalSnapshot, CodexRuntimeSnapshot, Event, Health, Job, LanguageSettingsSnapshot, NativeFileRef, QueuedTurn, RuntimeCatalog, Session, SessionSnapshot, TimelinePage, TimelineTracePage, ViewState } from '@shared/types'

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
  /** Bridge-derived metadata only; never trust a wire-level file inventory. */
  files?: AgentFile[]
}

const denied = (): never => { throw new Error('This action is not available in a shared chat.') }
class SharedChatHTTPError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
class SharedChatWriteDenied extends Error {}
class SharedChatMalformedResponse extends Error {}
export type SharedChatConnectionStatus = 'live' | 'reconnecting' | 'offline' | 'terminal'
const unsupported: unknown = new Proxy(() => Promise.reject(new Error('This action is not available in a shared chat.')), {
  get: (_target, key) => key === 'then' ? undefined : unsupported
})

export function createSharedChatBridge(
  prefix: string,
  receive: (state: SharedChatState) => void,
  connection: (status: SharedChatConnectionStatus, error?: string) => void,
  request: typeof fetch = fetch
) {
  if (!/^\/interactive-chat\/interactive_[a-f0-9]{32}$/.test(prefix)) throw new Error('Invalid shared chat URL.')
  let state: SharedChatState | null = null
  // Live snapshots intentionally contain only a cheap current-model baseline.
  // A successful explicit discovery belongs to this exact chat bridge, not to
  // a transcript revision, and must survive subsequent snapshot updates.
  let discoveredCatalog: RuntimeCatalog | null = null
  let csrf = ''
  let source: EventSource | null = null
  let disposed = false
  let terminalError: string | null = null
  let streamLive = false
  let recoveryListenersActive = false
  let lastAutomaticRecovery = 0
  let recoveryInFlight: Promise<void> | null = null
  let streamEpoch = 0
  let refreshRequest = 0
  let uncertainWrite: string | null = null
  let viewState: ViewState | null = null
  let language: LanguageSettingsSnapshot = { preference: 'en', systemLocale: navigator.language }
  const preferences = new Map<string, unknown>()
  const staged = new Map<string, File>()
  const uploaded = new Map<string, AgentFile>()
  const uploadPreviews = new Map<string, string>()
  const videos = new Map<string, AgentFile>()
  const listeners = new Map<string, Set<(value: never) => void>>()
  const emit = <K extends keyof AppEventMap>(name: K, value: AppEventMap[K]) => {
    for (const listener of listeners.get(name) ?? []) listener(value as never)
  }
  const current = () => {
    if (!state || disposed) return denied()
    if (terminalError) throw new Error(terminalError)
    return state
  }
  const exact = (id: string) => { if (id !== current().session.id) denied() }
  function latchTerminal(message: string) {
    if (disposed || terminalError) return
    terminalError = message
    streamLive = false
    source?.close()
    connection('terminal', message)
  }
  const reportInterrupted = () => {
    if (disposed || terminalError) return
    streamLive = false
    connection(navigator.onLine === false ? 'offline' : 'reconnecting')
  }
  async function json(path: '/state' | '/redeem' | '/controls' | '/prompts' | '/uploads', init: RequestInit = {}) {
    if (disposed || terminalError) current()
    const response = await request(prefix + path, {
      ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { ...(init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-Chat-CSRF': csrf } : {}), ...init.headers }
    })
    if (!response.ok) {
      let message = `Shared chat request failed (${response.status}).`
      try { const value = await response.json(); if (typeof value.detail === 'string') message = value.detail } catch { /* Keep bounded status-only fallback. */ }
      // A missing cookie before redemption belongs to the token-entry flow.
      // Once loaded, /state is the authoritative revocation check. Do not
      // confuse expected 403 control denials with revoked access.
      if (state && ([401, 410].includes(response.status)
        || (path === '/state' && [403, 404].includes(response.status)))) latchTerminal(message)
      throw new SharedChatHTTPError(response.status, message)
    }
    try { return await response.json() }
    catch { throw new SharedChatMalformedResponse('The shared chat server returned malformed data.') }
  }
  async function write(path: '/controls' | '/prompts' | '/uploads', init: RequestInit, validate: (value: any) => boolean) {
    current()
    if (uncertainWrite) throw new Error(uncertainWrite)
    if (source && !streamLive) throw new SharedChatWriteDenied('Reconnect before trying this action again.')
    try {
      const value = await json(path, init)
      if (!validate(value)) throw new Error('The server returned an invalid acceptance receipt.')
      return value
    } catch (error) {
      // These statuses are rejected before a native write. A transport error,
      // 5xx, pending/conflicting receipt, or malformed acknowledgment is not.
      if (!(error instanceof SharedChatWriteDenied)
        && !(error instanceof SharedChatHTTPError && [400, 401, 403, 404, 408, 410, 413, 415, 422].includes(error.status))) {
        uncertainWrite = 'Acceptance is unconfirmed. Reopen this page and inspect the chat before trying again; this action will not be retried automatically.'
        latchTerminal(uncertainWrite)
        throw new Error(`${uncertainWrite} ${error instanceof Error ? error.message : ''}`.trim())
      }
      throw error
    }
  }
  const apply = (next: SharedChatState, catalogOnly = false) => {
    if (disposed || terminalError || !next || !next.session || typeof next.session.id !== 'string'
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
    if (!catalogOnly) {
      if (state && state.revision.split(':')[0] !== next.revision.split(':')[0]) videos.clear()
      const projected = projectSharedVideoEvents(next.events, next.session.id)
      for (const file of projected.files) videos.set(file.id, file)
      next = { ...next, events: projected.events, files: [...videos.values()] }
    }
    state = discoveredCatalog ? { ...next, runtime_catalog: discoveredCatalog } : next
    receive(state)
    emit('server:sessions', { profileId: 'shared-chat', profileGeneration: 1, serverIdentity: prefix, sessions: [next.session] })
    if (next.session.backend === 'codex' || next.session.backend === 'claude') emit('server:provider-runtime', {
      profileId: 'shared-chat', profileGeneration: 1, serverIdentity: prefix,
      event: { type: 'provider_runtime_changed', session_id: next.session.id, backend: next.session.backend, runtime: 'context_usage', ephemeral: true }
    })
  }
  async function refresh() {
    const epoch = streamEpoch
    const requestId = ++refreshRequest
    try {
      const next = await json('/state')
      if (epoch === streamEpoch && requestId === refreshRequest) apply(next)
      return current()
    } catch (error) {
      if (error instanceof SharedChatMalformedResponse || (error instanceof Error && error.message === 'Invalid shared chat state.')) {
        latchTerminal('The shared chat stream returned invalid data. Reopen this page to reconnect safely.')
      }
      throw error
    }
  }
  async function reconcileAccepted() {
    try { await refresh() }
    catch {
      if (!terminalError) reportInterrupted()
    }
  }
  async function action(name: string, payload: Record<string, unknown> = {}, read = false) {
    current()
    const requestId = secureRandomUUID()
    const init = { method: 'POST', body: JSON.stringify({ action: name, payload, request_id: requestId }) }
    const result = read ? await json('/controls', init) : await write('/controls', init, value => {
      if (value?.action !== name || value?.request_id !== requestId) return false
      if (value.accepted === false && ['forbidden', 'invalid_request'].includes(value.error_code)) {
        throw new SharedChatWriteDenied(typeof value.detail === 'string' ? value.detail : 'This chat control request was rejected.')
      }
      return value.accepted === true && Object.hasOwn(value, 'result')
    })
    // An unknown/failed acknowledgment is never automatically retried.
    if (!read) await reconcileAccepted()
    return result.result
  }
  async function discoverRuntimeCatalog(): Promise<RuntimeCatalog> {
    const value = await action('runtime.catalog', {}, true)
    if (!value?.backends || typeof value.backends !== 'object' || Array.isArray(value.backends)) {
      throw new Error('The shared chat server returned an invalid runtime catalog.')
    }
    const catalog = value as RuntimeCatalog
    discoveredCatalog = catalog
    apply(current(), true)
    return catalog
  }
  async function timelinePage(name: 'timeline.older' | 'timeline.around', payload: Record<string, unknown>): Promise<TimelinePage> {
    const id = current().session.id
    const identity = current().revision.split(':')[0]
    const page = await action(name, payload, true)
    exact(id)
    if (!page || typeof page !== 'object' || !Array.isArray(page.events)
      || current().revision.split(':')[0] !== identity
      || (page.session !== undefined && page.session?.id !== id)
      || page.events.some((event: Event) => !event || (event.session_id && event.session_id !== id))) {
      throw new Error('Invalid shared chat history page.')
    }
    // Native semantic readers return events and paging metadata only. The
    // desktop store also requires Session; use our exact sanitized snapshot.
    return { ...page, events: projectPageVideos(page.events), session: current().session }
  }
  function projectPageVideos(events: Event[]): Event[] {
    const projected = projectSharedVideoEvents(events, current().session.id)
    if (projected.files.some(file => !videos.has(file.id))) {
      for (const file of projected.files) videos.set(file.id, file)
      // Native history pages carry no file inventory. Commit known attachment
      // metadata before the store merges their unchanged event IDs/sequences.
      state = { ...current(), files: [...videos.values()] }
      receive(state)
    }
    return projected.events
  }
  async function tracePage(id: string, runId: string, anchorSeq: number, after = 0, limit = 100): Promise<TimelineTracePage> {
    exact(id)
    const identity = current().revision.split(':')[0]
    const page = await action('timeline.trace', { run_id: runId, anchor_seq: anchorSeq, after, limit }, true)
    exact(id)
    if (!page || !Array.isArray(page.events) || current().revision.split(':')[0] !== identity
      || page.events.some((event: Event) => !event || (event.session_id && event.session_id !== id))) {
      throw new Error('Invalid shared chat history page.')
    }
    return { ...page, events: projectPageVideos(page.events) }
  }
  function snapshot(): SessionSnapshot {
    const value = current()
    const files = [...videos.values()]
    return { session: value.session, events: value.events, queuedTurns: value.queue, files, filesTotal: files.length,
      hasMoreEvents: value.hasMoreEvents === true, nextTimelineBefore: value.nextTimelineBefore,
      eventsTotal: value.eventsTotal, semanticPaging: true, historyVerified: true, cachedAt: Date.now(), viewState }
  }
  const stage = (file: File): NativeFileRef => {
    const path = `guest-upload:${secureRandomUUID()}`
    staged.set(path, file)
    return { path, name: file.name, size: file.size, type: file.type }
  }
  async function saveFile(id: string, file: AgentFile): Promise<string> {
    exact(id)
    const known = videos.get(file.id)
    if (!known || (file.session_id && file.session_id !== id)) return denied()
    const url = `${prefix}/files/${encodeURIComponent(known.id)}`
    // The same-origin browser request carries the share cookie; the server
    // authorizes that GET and streams directly to the download manager.
    const link = document.createElement('a')
    link.href = url
    link.download = known.filename
    document.body.append(link)
    link.click()
    link.remove()
    return url
  }
  const group = <T extends object>(methods: T): T => new Proxy(methods, { get: (target, key) => key in target ? Reflect.get(target, key) : unsupported })
  const methods = {
    sharedChat: true,
    events: { on(name: string, listener: (value: never) => void) { const bucket = listeners.get(name) ?? new Set(); bucket.add(listener); listeners.set(name, bucket); return () => { bucket.delete(listener) } } },
    language: { get: async () => language, set: async (preference: LanguageSettingsSnapshot['preference']) => { language = { ...language, preference }; emit('app:language', language); return language } },
    native: group({ analyticsDisabled: true, log: async () => undefined, writeClipboard: copySharedChatText, readyForNotifications: async () => false, readyForSecurePeerInvite: async () => false }),
    preferences: { get: async <T>(key: string, fallback: T) => preferences.has(key) ? preferences.get(key) as T : fallback, set: async (key: string, value: unknown) => { preferences.set(key, value) }, getScoped: async <T>(_scope: unknown, key: string, fallback: T) => preferences.has(key) ? preferences.get(key) as T : fallback, setScoped: async (_scope: unknown, key: string, value: unknown) => { preferences.set(key, value) } },
    runtime: group({ catalog: async (_refresh?: boolean) => discoverRuntimeCatalog() }),
    sessions: group({ list: async () => [current().session], update: async (id: string, patch: Record<string, unknown>) => { exact(id); const allowed = new Set(['title', 'model', 'effort', 'system_prompt', 'codex_approval_policy', 'codex_sandbox_mode', 'codex_permission_profile', 'codex_approvals_reviewer', 'claude_permission_mode', 'cursor_permission_mode', 'provider_jobs_access']); const payload = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)); if (Object.keys(payload).some(key => !allowed.has(key))) denied(); await action('settings.update', payload); return current().session }, markRead: async (id: string) => { exact(id); return current().session } }),
    timeline: group({ cached: async (id: string) => { exact(id); return snapshot() }, open: async (id: string) => { exact(id); await refresh(); return snapshot() }, older: async (id: string, before: number, limit = 100) => { exact(id); return timelinePage('timeline.older', { before, limit }) }, historicalOlder: async (id: string, before: number, limit = 100) => { exact(id); return timelinePage('timeline.older', { before, limit }) }, around: async (id: string, anchorSeq: number, limit = 100) => { exact(id); return timelinePage('timeline.around', { anchor_seq: anchorSeq, limit }) }, trace: tracePage, index: async (id: string) => { exact(id); return action('timeline.index', {}, true) }, subscribe: async (id: string) => { exact(id) }, unsubscribe: async (id: string) => { exact(id) }, saveViewState: async (_scope: unknown, value: ViewState) => { exact(value.sessionId); viewState = value }, getViewState: async (_scope: unknown, id: string) => { exact(id); return viewState }, search: async (id: string) => { exact(id); return [] } }),
    turns: { send: async (input: { sessionId: string; prompt: string; fileIds: string[]; chatReferences?: unknown[]; teamReferences?: unknown[]; skillSelection?: unknown }) => {
      exact(input.sessionId)
      if (input.chatReferences?.length || input.teamReferences?.length || input.skillSelection || input.fileIds.some(id => !uploaded.has(id))) denied()
      const requestId = secureRandomUUID()
      const result = await write('/prompts', { method: 'POST', body: JSON.stringify({ prompt: input.prompt, upload_ids: input.fileIds, request_id: requestId }) }, value =>
        value?.accepted === true && value.request_id === requestId && typeof value.queued === 'boolean'
        && (value.queued ? typeof value.queued_id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value.queued_id) : value.queued_id === undefined))
      await reconcileAccepted()
      return { ...result, session: current().session }
    }, stop: async (id: string) => { exact(id); return action('turn.stop') } },
    queue: { list: async (id: string) => { exact(id); return current().queue }, update: async (id: string, queuedId: string, prompt: string, chats?: unknown[], _capabilities?: string[], teams?: unknown[], revision?: number) => { exact(id); if (chats?.length || teams?.length) denied(); await action('queue.edit', { id: queuedId, prompt, ...(revision === undefined ? {} : { expected_message_revision: revision }) }); return true }, remove: async (id: string, queuedId: string) => { exact(id); await action('queue.delete', { id: queuedId }); return true }, move: async (id: string, queuedId: string, direction: string, adjacent?: string) => { exact(id); await action('queue.move', { id: queuedId, direction, ...(adjacent ? { expected_adjacent_queued_id: adjacent } : {}) }); return current().queue }, runNow: async (id: string, queuedId: string) => { exact(id); return action('queue.run_now', { id: queuedId }) } },
    codex: group({ runtime: async (id: string) => { exact(id); return current().codex_runtime }, permissionProfiles: async (id: string) => { exact(id); return current().codex_runtime?.permission_profiles ?? [] }, goal: async (id: string) => { exact(id); return current().goal }, setGoal: async (id: string, input: Record<string, unknown>) => { exact(id); await action('goal.set', input); return current().goal }, clearGoal: async (id: string) => { exact(id); await action('goal.delete'); return current().goal }, resolveInteraction: async (id: string, interactionId: string, response: unknown) => { exact(id); return action('approval.respond', { backend: 'codex', id: interactionId, response }) } }),
    claude: group({ runtime: async (id: string) => { exact(id); return current().claude_runtime }, refreshContextUsage: async (id: string) => { exact(id); return current().claude_runtime }, resolveInteraction: async (id: string, interactionId: string, response: unknown) => { exact(id); return action('approval.respond', { backend: 'claude', id: interactionId, response }) } }),
    jobs: { list: async () => current().jobs, runs: async (id: string, jobId: string, beforeSeq?: number, limit = 25, timelineGroupId?: string) => { exact(id); return action('jobs.runs', { id: jobId, before_seq: beforeSeq, limit, timeline_group_id: timelineGroupId }, true) }, create: async (input: { session_id: string } & Record<string, unknown>) => { exact(input.session_id); const { session_id: _id, ...payload } = input; return (await action('job.create', payload))?.job }, update: async (id: string, patch: Record<string, unknown>) => (await action('job.update', { id, ...patch }))?.job, remove: async (id: string) => { await action('job.delete', { id }); return true }, run: async (id: string) => action('job.run', { id }) },
    pins: group({ list: async () => [] }),
    handoffs: group({ get: async (id: string) => {
      const sessionId = current().session.id
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) denied()
      const handoff = (await action('handoffs.get', { id }, true))?.handoff
      exact(sessionId)
      if (!handoff || handoff.id !== id || typeof handoff.body !== 'string'
        || typeof handoff.source_session_id !== 'string' || typeof handoff.target_session_id !== 'string'
        || (handoff.source_session_id !== sessionId && handoff.target_session_id !== sessionId)
        || (handoff.conversation_mode === 'async_route_v1' && (handoff.message_id !== id || !handoff.conversation_id))) {
        throw new Error('Invalid shared chat message detail.')
      }
      return handoff
    } }),
    files: group({
      choose: () => new Promise<NativeFileRef[]>((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = () => {
          try {
            const files = Array.from(input.files ?? [])
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
        try { for (const path of paths) {
          const file = staged.get(path)
          if (!file) throw new Error('Select the upload again.')
          const value = await write('/uploads', {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Chat-Filename': encodeURIComponent(file.name) },
            body: file
          }, value => typeof value?.id === 'string' && value.id.length > 0 && typeof value.name === 'string'
            && typeof value.media_type === 'string' && value.byte_size === file.size)
          const item = { id: value.id, session_id: id, filename: value.name, content_type: value.media_type, size: value.byte_size } as AgentFile
          uploaded.set(item.id, item)
          if (/^(image|video)\//.test(file.type)) uploadPreviews.set(item.id, URL.createObjectURL(file))
          staged.delete(path)
          result.push(item)
        }
        return result
        } finally {
          // The native composer removes failed batch chips. Release only the
          // browser staging handles; server uploads are never erased.
          for (const path of paths) staged.delete(path)
        }
      },
      mediaURL: (profileId: string, generation: number, id: string, fileId: string) => {
        if (disposed || terminalError || !state || profileId !== 'shared-chat' || generation !== 1 || id !== state.session.id) return ''
        if (uploadPreviews.has(fileId)) return uploadPreviews.get(fileId)!
        const file = videos.get(fileId)
        if (!file || (!isSharedVideoId(fileId) && (!isSharedFileId(fileId)
          || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(file.content_type ?? '')))) return ''
        return `${prefix}/media/${encodeURIComponent(fileId)}`
      },
      save: saveFile,
      open: async (id: string, file: AgentFile) => { await saveFile(id, file) },
      list: async (id: string) => { exact(id); const files = [...videos.values()]; return { files, total: files.length, has_more: false } },
      findEvent: async (id: string) => { exact(id); return null }
    })
  }
  const api = group(methods) as unknown as AgentsDockAPI
  const connectStream = () => {
    if (disposed || terminalError) return
    streamLive = false
    source?.close()
    connection(navigator.onLine === false ? 'offline' : 'reconnecting')
    const nextSource = new EventSource(prefix + '/events', { withCredentials: true })
    source = nextSource
    nextSource.addEventListener('state', event => {
      if (source !== nextSource || disposed || terminalError) return
      try {
        ++streamEpoch
        apply(JSON.parse((event as MessageEvent).data))
        // A complete authenticated SSE snapshot, including an unchanged
        // revision, confirms live sync. Opening the socket alone does not.
        if (uncertainWrite) latchTerminal(uncertainWrite)
        else {
          streamLive = true
          connection('live')
        }
      } catch {
        latchTerminal('The shared chat stream returned invalid data. Reopen this page to reconnect safely.')
      }
    })
    nextSource.addEventListener('unavailable', () => {
      if (source === nextSource) latchTerminal('This shared chat is no longer available.')
    })
    nextSource.onerror = () => {
      if (source === nextSource) reportInterrupted()
      // Do not close a transiently failed EventSource. The browser owns its
      // retry policy and a later authenticated state event restores live sync.
    }
  }
  const recover = () => {
    if (disposed || terminalError || !state || streamLive) return
    const now = Date.now()
    if (now - lastAutomaticRecovery < 500) return
    lastAutomaticRecovery = now
    void retryStream().catch(() => { /* The connection callback owns recovery status. */ })
  }
  async function retryStream() {
    if (disposed || terminalError) return
    if (recoveryInFlight) return recoveryInFlight
    const attempt = (async () => {
      try { await refresh() }
      catch (error) {
        if (!terminalError && !streamLive) reportInterrupted()
        throw error
      }
      if (!streamLive) connectStream()
    })()
    recoveryInFlight = attempt
    try { await attempt }
    finally { if (recoveryInFlight === attempt) recoveryInFlight = null }
  }
  const recoverVisible = () => {
    if (document.visibilityState === 'visible') recover()
  }
  const addRecoveryListeners = () => {
    if (recoveryListenersActive) return
    recoveryListenersActive = true
    window.addEventListener('online', recover)
    window.addEventListener('offline', reportInterrupted)
    window.addEventListener('focus', recover)
    document.addEventListener('visibilitychange', recoverVisible)
  }
  const removeRecoveryListeners = () => {
    if (!recoveryListenersActive) return
    recoveryListenersActive = false
    window.removeEventListener('online', recover)
    window.removeEventListener('offline', reportInterrupted)
    window.removeEventListener('focus', recover)
    document.removeEventListener('visibilitychange', recoverVisible)
  }
  return {
    api, snapshot, refresh,
    async redeem(token: string) { if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid invitation.'); const result = await json('/redeem', { method: 'POST', body: JSON.stringify({ invitation_token: token }) }); csrf = result.csrf },
    async start() {
      if (disposed || terminalError) current()
      addRecoveryListeners()
      try {
        await refresh()
        connectStream()
      } catch (error) {
        if (!terminalError) reportInterrupted()
        throw error
      }
    },
    async retry() {
      addRecoveryListeners()
      await retryStream()
    },
    async catalog() {
      await discoverRuntimeCatalog()
    },
    close() {
      disposed = true
      streamLive = false
      source?.close()
      removeRecoveryListeners()
      listeners.clear()
      staged.clear()
      uploaded.clear()
      for (const url of uploadPreviews.values()) URL.revokeObjectURL(url)
      uploadPreviews.clear()
      videos.clear()
      discoveredCatalog = null
    }
  }
}
