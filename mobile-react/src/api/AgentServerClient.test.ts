import {
  AgentServerClient,
  AgentServerClientDisposedError,
  AgentServerClientUnvalidatedError,
  ServerError,
  type WebSocketConnectionError,
  type WebSocketStateDetail,
} from './AgentServerClient'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function assertRejects(promise: Promise<unknown>, predicate: (error: unknown) => boolean, message: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    assert(predicate(error), `${message}: received ${String(error)}`)
    return
  }
  throw new Error(`${message}: promise resolved`)
}

function assertThrows(callback: () => void, predicate: (error: unknown) => boolean, message: string): void {
  try {
    callback()
  } catch (error) {
    assert(predicate(error), `${message}: received ${String(error)}`)
    return
  }
  throw new Error(`${message}: callback returned`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

interface FetchRecord {
  url: string
  token: string | null
  teamNetworkToken: string | null
  authorization: string | null
  signal: AbortSignal
  method: string
  body: string | null
  range: string | null
}

const originalFetch = globalThis.fetch
const fetchRecords: FetchRecord[] = []
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const signal = init?.signal
  assert(signal, 'Client request did not provide a combined signal')
  const url = String(input)
  fetchRecords.push({
    url,
    token: new Headers(init?.headers).get('X-ZenithDock-Token'),
    teamNetworkToken: new Headers(init?.headers).get('X-AgentsDock-Token'),
    authorization: new Headers(init?.headers).get('Authorization'),
    signal,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : null,
    range: new Headers(init?.headers).get('Range'),
  })
  if (url.startsWith('https://new.example')) {
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://validation.example/api/health') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, server_identity: 'validated-server', api_contract_version: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://validation.example/api/sessions') {
    return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://revoke.example/api/health') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, server_identity: 'revoke-server', api_contract_version: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://paging.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      session: { id: 'session /?', title: 'Paging', backend: 'codex' },
      events: [],
      events_omitted_before: 0,
      events_omitted_after: 0,
      semantic_item_count: 2,
      semantic_total: 5,
      semantic_omitted_before: 3,
      semantic_omitted_after: 0,
      next_semantic_before: 77,
      latest_seq: 91,
      event_count: 91,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://diff.example/api/sessions/session/diffs/run') {
    return Promise.resolve(new Response('*** Update File: app.ts\n-old\n+new', {
      status: 206,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': '33',
        'Content-Range': 'bytes 0-32/900000',
      },
    }))
  }
  if (url.includes('/api/sessions/session/diffs/run') && url.startsWith('https://diff-oversized.example')) {
    return Promise.resolve(new Response('unsafe', {
      status: 206,
      headers: { 'Content-Length': '600000', 'Content-Range': 'bytes 0-599999/900000' },
    }))
  }
  if (url.includes('/api/sessions/session/diffs/run') && url.startsWith('https://diff-unbounded.example')) {
    return Promise.resolve(new Response('unproven', { status: 200 }))
  }
  if (url.includes('/api/sessions/session/diffs/run') && url.startsWith('https://diff-malformed.example')) {
    return Promise.resolve(new Response('unproven', {
      status: 206,
      headers: { 'Content-Length': '8', 'Content-Range': 'not-a-range' },
    }))
  }
  if (url.startsWith('https://paging-ignored.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      session: { id: 'session /?', title: 'Paging', backend: 'codex' },
      events: [{
        id: 'event-75',
        session_id: 'session /?',
        seq: 75,
        type: 'assistant_text',
        ts: '2026-07-30T00:00:00Z',
        text: 'Legacy page',
      }],
      events_omitted_before: 74,
      events_omitted_after: 15,
      latest_seq: 91,
      event_count: 91,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://jobs.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      session_id: 'session /?',
      job_id: 'job /?',
      runs: [{
        id: 'job-run-1',
        session_id: 'session /?',
        seq: 8,
        type: 'turn_finished',
        ts: '2026-07-29T00:00:00Z',
        run_id: 'run-1',
        job_id: 'job /?',
        result_text: 'Previous result',
      }],
      total: 4,
      has_more: true,
      next_before: 8,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://job-run.example/api/jobs/')) {
    return Promise.resolve(new Response(JSON.stringify({
      ok: true,
      queued: true,
      deferred: true,
      job_id: 'job /?',
      message: 'Waiting for this chat to become idle.',
      job: {
        id: 'job /?',
        session_id: 'session',
        title: 'Status report',
        prompt: 'Report status',
        interval_seconds: null,
        manual_run_pending: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://job-update.example/api/jobs/')) {
    return Promise.resolve(new Response(JSON.stringify({
      job: {
        id: 'job /?',
        session_id: 'session',
        title: 'Status report',
        prompt: 'Report status',
        interval_seconds: null,
        schedule_kind: 'cron',
        enabled: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://trace.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      events: [{
        id: 'trace-thought-1',
        session_id: 'session /?',
        seq: 18,
        type: 'reasoning_summary',
        ts: '2026-07-30T00:00:00Z',
        run_id: 'run /?',
        text: 'Checked the latest state',
      }],
      has_more: true,
      next_after: 18,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://queue-run.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      ok: false,
      queued_id: 'queued /?',
      deferred: true,
      message: 'The provider is still starting, so this message remains queued.',
      remaining: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://queue-uncertain.example/api/sessions/')) {
    return Promise.resolve(new Response(JSON.stringify({
      detail: {
        code: 'force_send_delivery_uncertain',
        message: 'Force Send delivery could not be confirmed.',
        action: 'Do not retry automatically. Refresh the chat and verify whether the message appeared.',
        retryable: false,
        delivery_uncertain: true,
        queued_id: 'queued /?',
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://server-update.example/api/admin/update') {
    return Promise.resolve(new Response(JSON.stringify({
      phase: 'pending',
      schedule_id: '0123456789abcdef0123456789abcdef',
      target_version: '0.1.26-beta.12',
      cancelable: true,
      blocker_counts: { active_runs: 1, queued_turns: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://server-update.example/api/admin/update/cancel') {
    return Promise.resolve(new Response(JSON.stringify({
      phase: 'available',
      schedule_id: null,
      cancelable: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://server-update-race.example/api/admin/update/cancel') {
    return Promise.resolve(new Response(JSON.stringify({
      detail: {
        code: 'server_update_changed',
        message: 'The scheduled server update changed before cancellation.',
        action: 'Refresh update status before trying again.',
        retryable: true,
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://codex.example/api/')) {
    const path = new URL(url).pathname
    let value: unknown = { accepted: true }
    if (path === '/api/admin/codex/goals') {
      value = {
        enabled: init?.method === 'PUT' ? JSON.parse(String(init.body)).enabled : true,
        configurable: true,
        message: 'Persistent goals configured.',
      }
    } else if (path === '/api/sessions') {
      value = { session: { id: 'session /?', title: 'Codex', backend: 'codex' } }
    } else if (path.endsWith('/provider/reload')) {
      value = {
        session: { id: 'session /?', title: 'Codex', backend: 'codex', backend_locked: true },
        reloaded: true,
        message: 'Codex reloaded.',
      }
    } else if (path.endsWith('/stop')) {
      value = {
        ok: true,
        stopped: false,
        pending: true,
        deferred: true,
        message: 'The native interrupt is still pending.',
      }
    } else if (path.endsWith('/turns')) {
      value = { session: { id: 'session /?', title: 'Codex', backend: 'codex' } }
    } else if (path === '/api/cross-chat/handoffs/handoff%20%2F%3F') {
      value = {
        handoff: {
          id: 'handoff /?', kind: 'instruction', source_session_id: 'source', source_run_id: 'run',
          target_session_id: 'target', action: 'instruction', status: 'queued', body: 'Check this',
          body_chars: 10, body_sha256: 'hash', created_at: '2026-08-11T00:00:00Z', updated_at: '2026-08-11T00:00:00Z',
        },
      }
    } else if (path === '/api/cross-chat/handoffs/handoff%20%2F%3F/cancel') {
      value = {
        handoff: {
          id: 'handoff /?', kind: 'instruction', source_session_id: 'source', source_run_id: 'run',
          target_session_id: 'target', action: 'instruction', status: 'cancelled',
          created_at: '2026-08-11T00:00:00Z', updated_at: '2026-08-11T00:00:01Z',
        },
      }
    } else if (path === '/api/cross-chat/exchanges/exchange%20%2F%3F') {
      value = {
        exchange: {
          id: 'exchange /?', status: 'active', requester_session_id: 'source', responder_session_id: 'target',
          authorization_source_run_id: 'run', max_legs: 6, used_legs: 1, remaining_legs: 5,
          active_leg_id: 'leg', error_code: null, error: null, expires_at: '2026-08-14T00:00:00Z',
          created_at: '2026-08-11T00:00:00Z', updated_at: '2026-08-11T00:00:00Z', legs: [],
        },
      }
    } else if (path === '/api/cross-chat/exchanges/exchange%20%2F%3F/cancel') {
      value = {
        exchange: {
          id: 'exchange /?', status: 'cancelled', requester_session_id: 'source', responder_session_id: 'target',
          authorization_source_run_id: 'run', max_legs: 6, used_legs: 1, remaining_legs: 5,
          active_leg_id: 'leg', error_code: 'cancelled_by_user', error: 'cancelled', expires_at: '2026-08-14T00:00:00Z',
          created_at: '2026-08-11T00:00:00Z', updated_at: '2026-08-11T00:00:01Z', legs: [],
        },
      }
    } else if (path.endsWith('/codex/runtime')) {
      value = {
        available: true,
        transport: 'app-server',
        interactive_capability: 'codex_interactive_v1',
        thread_loaded: true,
        status: { type: 'idle' },
        goal: null,
        time_budget_seconds: null,
        pending_interactions: [],
        permission_profiles: [],
        background_terminals_supported: true,
      }
    } else if (path.includes('/codex/interactions/')) {
      value = {
        interaction: {
          id: 'interaction /?',
          session_id: 'session /?',
          thread_id: 'thread',
          method: 'item/tool/requestUserInput',
          params: {},
          created_at: '2026-07-28T00:00:00Z',
        },
      }
    } else if (path.endsWith('/claude/runtime')) {
      value = {
        available: true,
        transport: 'agent-sdk',
        interactive_capability: 'claude_sdk_interactive_v1',
        session_loaded: true,
        status: { type: 'idle' },
        pending_interactions: [],
      }
    } else if (path.endsWith('/claude/mcp')) {
      const control = init?.method === 'POST'
        ? JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { action?: string; server_name?: string | null }
        : null
      value = {
        version: 1,
        available: true,
        transport: 'agent-sdk',
        generation: 'claudemcp_opaque',
        session_loaded: true,
        truncated: false,
        servers: [{
          name: 'calendar',
          status: control?.action === 'disable' ? 'disabled' : 'connected',
          enabled: control?.action !== 'disable',
          error: null,
          scope: 'user',
          server_info: { name: 'Calendar', version: '1.0' },
          tool_count: 2,
        }],
        reason: null,
        action: control ? { type: control.action, server_name: control.server_name ?? null } : null,
      }
    } else if (path.endsWith('/claude/context-usage/refresh')) {
      value = {
        available: true,
        transport: 'agent-sdk',
        interactive_capability: 'claude_sdk_interactive_v1',
        session_loaded: true,
        status: { type: 'idle' },
        pending_interactions: [],
        context_usage_refreshed: true,
      }
    } else if (path.includes('/claude/interactions/')) {
      value = {
        interaction: {
          id: 'claude interaction /?',
          session_id: 'session /?',
          thread_id: 'claude-thread',
          method: 'item/tool/requestApproval',
          params: {},
          created_at: '2026-08-05T00:00:00Z',
        },
      }
    } else if (path.endsWith('/codex/permission-profiles')) {
      value = { profiles: [] }
    } else if (path.endsWith('/codex/goal')) {
      value = { goal: null, time_budget_seconds: null }
    } else if (path.endsWith('/codex/rollback')) {
      value = { accepted: true, thread: {} }
    } else if (path.endsWith('/codex/background-terminals')) {
      value = { supported: true, terminals: [] }
    } else if (path.endsWith('/codex/background-terminals/terminate')) {
      value = { terminated: true }
    } else if (path.endsWith('/codex/background-terminals/clean')) {
      value = { cleaned: true }
    }
    return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://auth-reject.example/api/')) {
    return Promise.resolve(new Response(JSON.stringify({ detail: 'Access token rejected' }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://validation-detail.example/api/sessions') {
    return Promise.resolve(new Response(JSON.stringify({
      detail: [{
        type: 'string_too_short',
        loc: ['query', 'q'],
        msg: 'String should have at least 2 characters',
        input: 'x',
        ctx: { min_length: 2 },
      }],
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://workspace.example/api/sessions/session%20%2F%3F/workspace/file') {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { path?: string; content?: string; expected_revision?: string }
    return Promise.resolve(new Response(JSON.stringify({
      root: '/workspace',
      path: body.path,
      name: 'notes.md',
      content: body.content,
      revision: 'b'.repeat(64),
      size: new TextEncoder().encode(body.content ?? '').byteLength,
      mtime_ns: 42,
      writable: true,
      scope: 'workspace',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://workspace.example/api/sessions/session%20%2F%3F/workspace/entry')) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { path?: string; kind?: string; new_name?: string }
    const query = new URL(url).searchParams
    const path = body.path ?? query.get('path') ?? ''
    const name = body.new_name ?? path.split('/').at(-1) ?? ''
    return Promise.resolve(new Response(JSON.stringify(init?.method === 'DELETE'
      ? { root: '/workspace', path, kind: 'file', removed: true }
      : { root: '/workspace', ...(body.new_name ? { previous_path: path } : {}), entry: { name, path: body.new_name ? `notes/${name}` : path, kind: body.kind ?? 'file', revision: 'c'.repeat(64), writable: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url.startsWith('https://working-directory.example/api/working-directories/complete?')) {
    return Promise.resolve(new Response(JSON.stringify({
      input: '/srv/pro',
      resolved_path: '/srv/pro',
      exists: false,
      base_path: '/srv',
      suggestions: [{ name: 'project one', path: '/srv/project one/' }],
      truncated: false,
      message: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  if (url === 'https://workspace-permission.example/api/sessions/session/workspace/file') {
    return Promise.resolve(new Response(JSON.stringify({
      detail: { code: 'workspace_permission_denied', message: 'Workspace file is read-only.' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
  }
  return new Promise<Response>((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) rejectAbort()
    else signal.addEventListener('abort', rejectAbort, { once: true })
  })
}) as typeof fetch

try {
  const reconfigured = new AgentServerClient('https://old.example/', 'old-token')
  const oldRequest = reconfigured.health()
  reconfigured.configure('https://new.example', 'new-token')
  await assertRejects(oldRequest, () => true, 'Reconfiguration should abort old HTTP requests')
  await reconfigured.health()
  assert(fetchRecords[0]?.url === 'https://old.example/api/health', 'Old request should capture its original URL')
  assert(fetchRecords[0]?.token === 'old-token', 'Old request should capture its original token')
  assert(fetchRecords[1]?.url === 'https://new.example/api/health', 'New request should use the replacement URL')
  assert(fetchRecords[1]?.token === 'new-token', 'New request should use the replacement token')
  reconfigured.dispose()

  const paging = new AgentServerClient('https://paging.example')
  await paging.sessionPage('session /?', {
    before: 91,
    limit: 80,
    tail: false,
    visible: false,
    compact: true,
  })
  const pagingRequest = fetchRecords.at(-1)
  assert(pagingRequest, 'Session paging should issue a request')
  const pagingURL = new URL(pagingRequest.url)
  assert(pagingURL.pathname === '/api/sessions/session%20%2F%3F', 'Session paging should encode the session ID')
  assert(pagingURL.searchParams.get('before') === '91', 'Session paging should preserve the older-page cursor')
  assert(pagingURL.searchParams.get('limit') === '80', 'Session paging should preserve the page limit')
  assert(pagingURL.searchParams.get('tail') === 'false', 'Session paging should preserve an explicit tail=false')
  assert(pagingURL.searchParams.get('visible') === 'false', 'Session paging should preserve an explicit visible=false')
  assert(pagingURL.searchParams.get('compact') === 'true', 'Compact session paging should opt into the compact server response')

  const diffClient = new AgentServerClient('https://diff.example')
  const boundedDiff = await diffClient.codeDiff('session', 'run')
  assert(boundedDiff.text.includes('+new'), 'Code diff should return the bounded review source')
  assert(boundedDiff.truncated, 'Partial content should report a truncated review')
  assert(fetchRecords.at(-1)?.range === 'bytes=0-524287', 'Code diff should bound the server response with an HTTP range')
  for (const origin of ['https://diff-oversized.example', 'https://diff-unbounded.example', 'https://diff-malformed.example']) {
    const rejectedDiff = await new AgentServerClient(origin).codeDiff('session', 'run')
    assert(rejectedDiff.text === '', `${origin} must not read an unproven response body`)
    assert(rejectedDiff.truncated, `${origin} must surface a bounded-preview warning`)
  }

  const semanticPage = await paging.sessionPage('session /?', {
    before: 91,
    limit: 80,
    pageMode: 'semantic',
  })
  const semanticRequest = fetchRecords.at(-1)
  assert(semanticRequest, 'Semantic session paging should issue a request')
  const semanticURL = new URL(semanticRequest.url)
  assert(semanticURL.searchParams.get('page_mode') === 'semantic', 'Semantic session paging should opt into logical server pages')
  assert(semanticURL.searchParams.get('compact') === null, 'Semantic session paging should not also request compact filtering')
  assert(semanticPage.has_more, 'Semantic paging should use the semantic omitted count')
  assert(semanticPage.before === null, 'Semantic paging should keep the raw event boundary separate from its cursor')
  assert(semanticPage.next_before === 77, 'Semantic paging should expose the server-provided next cursor')
  assert(semanticPage.next_semantic_before === 77, 'Semantic paging should preserve the explicit semantic cursor')
  assert(semanticPage.semantic_paging === true, 'Semantic paging should be marked authoritative only when the server returns semantic metadata')
  assert(semanticPage.semantic_item_count === 2 && semanticPage.semantic_total === 5, 'Semantic paging should expose server landmark counts')
  paging.dispose()

  const queueRun = new AgentServerClient('https://queue-run.example')
  const deferredRun = await queueRun.runQueuedNow('session /?', 'queued /?')
  assert(deferredRun.ok === false && deferredRun.deferred === true, 'Run now should preserve the server deferred outcome')
  assert(deferredRun.queued_id === 'queued /?' && deferredRun.remaining === 1, 'Run now should expose the authoritative queued item and remaining count')
  assert(deferredRun.message?.includes('remains queued'), 'Run now should expose the server action message')
  assert(fetchRecords.at(-1)?.url === 'https://queue-run.example/api/sessions/session%20%2F%3F/queue/queued%20%2F%3F/run-now', 'Run now should encode both IDs')
  assert(JSON.parse(fetchRecords.at(-1)?.body ?? '{}').accept_deferred_queue_response === true, 'Run now should explicitly negotiate the deferred queue contract')
  queueRun.dispose()

  const queueUncertain = new AgentServerClient('https://queue-uncertain.example')
  await assertRejects(
    queueUncertain.runQueuedNow('session /?', 'queued /?'),
    error => error instanceof ServerError
      && error.status === 409
      && (error.detail as { delivery_uncertain?: unknown } | undefined)?.delivery_uncertain === true
      && (error.detail as { retryable?: unknown } | undefined)?.retryable === false
      && error.message.includes('Do not retry automatically'),
    'Run now should preserve structured non-retryable delivery uncertainty',
  )
  queueUncertain.dispose()

  const ignoredSemantic = new AgentServerClient('https://paging-ignored.example')
  const ignoredSemanticPage = await ignoredSemantic.sessionPage('session /?', {
    before: 91,
    limit: 48,
    pageMode: 'semantic',
  })
  assert(ignoredSemanticPage.semantic_paging === false, 'A server that ignores page_mode must not be treated as semantic')
  assert(ignoredSemanticPage.has_more, 'An ignored semantic request should fall back to the raw omitted count')
  assert(ignoredSemanticPage.before === 75 && ignoredSemanticPage.next_before === 75, 'An ignored semantic request should expose a safe raw cursor')
  ignoredSemantic.dispose()

  const jobs = new AgentServerClient('https://jobs.example')
  const jobPage = await jobs.jobRuns('session /?', 'job /?', 91, 20)
  const jobRequest = fetchRecords.at(-1)
  assert(jobRequest, 'Scheduled-run history should issue a request')
  const jobURL = new URL(jobRequest.url)
  assert(jobURL.pathname === '/api/sessions/session%20%2F%3F/jobs/job%20%2F%3F/runs', 'Scheduled-run history should encode session and job IDs')
  assert(jobURL.searchParams.get('before_seq') === '91', 'Scheduled-run history should preserve its cursor')
  assert(jobURL.searchParams.get('limit') === '20', 'Scheduled-run history should preserve its page size')
  assert(jobPage.supported && jobPage.runs[0]?.result_text === 'Previous result', 'Scheduled-run history should expose a supported page')
  jobs.dispose()

  const jobRun = new AgentServerClient('https://job-run.example')
  const jobRunResult = await jobRun.runJob('job /?')
  const jobRunRequest = fetchRecords.at(-1)
  assert(jobRunRequest?.url === 'https://job-run.example/api/jobs/job%20%2F%3F/run', 'Scheduled Run now should encode the job ID')
  assert(jobRunRequest?.method === 'POST' && jobRunRequest.body === '{}', 'Scheduled Run now should use an empty POST body')
  assert(jobRunResult.deferred === true && jobRunResult.job?.manual_run_pending === true, 'Scheduled Run now should preserve the deferred server outcome')
  assert(jobRunResult.message?.includes('idle'), 'Scheduled Run now should expose inline status text')
  jobRun.dispose()

  const jobUpdate = new AgentServerClient('https://job-update.example')
  await jobUpdate.updateJob('job /?', { next_run_at: null, enabled: true })
  const jobUpdateRequest = fetchRecords.at(-1)
  assert(jobUpdateRequest?.url === 'https://job-update.example/api/jobs/job%20%2F%3F', 'Scheduled update should encode the job ID')
  assert(jobUpdateRequest?.method === 'PATCH', 'Scheduled update should use PATCH')
  const jobUpdateBody = JSON.parse(jobUpdateRequest?.body ?? '{}') as Record<string, unknown>
  assert(Object.prototype.hasOwnProperty.call(jobUpdateBody, 'next_run_at') && jobUpdateBody.next_run_at === null, 'Scheduled update must preserve an explicit null next-run reset on the wire')
  assert(jobUpdateBody.enabled === true, 'Scheduled reset must carry the legacy-compatible enable signal')
  jobUpdate.dispose()

  const serverUpdate = new AgentServerClient('https://server-update.example', 'update-token')
  const updateStatus = await serverUpdate.serverUpdateStatus()
  const updateStatusRequest = fetchRecords.at(-1)
  assert(updateStatusRequest?.url === 'https://server-update.example/api/admin/update', 'Managed update status should use the authoritative admin endpoint')
  assert(updateStatusRequest?.method === 'GET' && updateStatusRequest.token === 'update-token', 'Managed update status should use an authenticated GET')
  assert(updateStatus.phase === 'pending' && updateStatus.cancelable === true, 'Managed update status should preserve its pending cancellation state')
  assert(updateStatus.blocker_counts?.active_runs === 1, 'Managed update status should preserve blocker counts')
  const canceledUpdate = await serverUpdate.cancelServerUpdate('0123456789abcdef0123456789abcdef')
  const cancelUpdateRequest = fetchRecords.at(-1)
  assert(cancelUpdateRequest?.url === 'https://server-update.example/api/admin/update/cancel', 'Managed update cancellation should use the narrow cancel endpoint')
  assert(cancelUpdateRequest?.method === 'POST' && cancelUpdateRequest.token === 'update-token', 'Managed update cancellation should use an authenticated POST')
  assert(cancelUpdateRequest?.body === '{"schedule_id":"0123456789abcdef0123456789abcdef"}', 'Managed update cancellation should send only the exact schedule ID')
  assert(canceledUpdate.phase === 'available', 'Managed update cancellation should return the authoritative replacement status')
  serverUpdate.dispose()

  const updateRejections: ServerError[] = []
  const serverUpdateRace = new AgentServerClient('https://server-update-race.example', '', {
    onServerError: error => updateRejections.push(error),
  })
  await assertRejects(
    serverUpdateRace.cancelServerUpdate('0123456789abcdef0123456789abcdef'),
    error => error instanceof ServerError
      && error.status === 409
      && (error.detail as { code?: unknown } | undefined)?.code === 'server_update_changed'
      && error.message.includes('Refresh update status'),
    'Managed update cancellation should preserve structured compare-and-swap failures',
  )
  assert(updateRejections.length === 1, 'The active client should report structured server rejections to its workspace owner')
  assert((updateRejections[0]?.detail as { code?: unknown } | undefined)?.code === 'server_update_changed', 'The server rejection callback should preserve structured detail')
  serverUpdateRace.dispose()

  const trace = new AgentServerClient('https://trace.example')
  const tracePage = await trace.runTrace('session /?', 'run /?', 25, 12, 40)
  const traceRequest = fetchRecords.at(-1)
  assert(traceRequest, 'Trace detail should issue a request')
  const traceURL = new URL(traceRequest.url)
  assert(traceURL.pathname === '/api/sessions/session%20%2F%3F/runs/run%20%2F%3F/trace', 'Trace detail should encode session and run IDs')
  assert(traceURL.searchParams.get('anchor_seq') === '25', 'Trace detail should preserve its timeline anchor')
  assert(traceURL.searchParams.get('after_seq') === '12', 'Trace detail should preserve its forward cursor')
  assert(traceURL.searchParams.get('limit') === '40', 'Trace detail should preserve its page size')
  assert(tracePage.events[0]?.text === 'Checked the latest state', 'Trace detail should return reasoning events')
  assert(tracePage.has_more && tracePage.next_after === 18, 'Trace detail should expose its next-page cursor')
  trace.dispose()

  const unanchoredTrace = new AgentServerClient('https://trace.example')
  await unanchoredTrace.runTrace('session /?', 'run /?', 0, 0, 40)
  const unanchoredTraceRequest = fetchRecords.at(-1)
  assert(unanchoredTraceRequest, 'Unanchored trace detail should issue a request')
  const unanchoredTraceURL = new URL(unanchoredTraceRequest.url)
  assert(
    !unanchoredTraceURL.searchParams.has('anchor_seq'),
    'An unavailable trace anchor must be omitted so the server can select the latest run occurrence',
  )
  assert(unanchoredTraceURL.searchParams.get('after_seq') === '0', 'Unanchored trace detail should preserve its forward cursor')
  unanchoredTrace.dispose()

  const workingDirectory = new AgentServerClient('https://working-directory.example', 'working-directory-token')
  const directoryCompletion = await workingDirectory.completeWorkingDirectory('/srv/pro', 12)
  const directoryRequest = fetchRecords.at(-1)
  assert(directoryRequest, 'Working-directory completion should issue a request')
  const directoryURL = new URL(directoryRequest.url)
  assert(directoryURL.pathname === '/api/working-directories/complete', 'Working-directory completion should use the server-host folder endpoint')
  assert(directoryURL.searchParams.get('path') === '/srv/pro', 'Working-directory completion should preserve the requested server path')
  assert(directoryURL.searchParams.get('limit') === '12', 'Working-directory completion should preserve its bounded result limit')
  assert(directoryRequest.token === 'working-directory-token', 'Working-directory completion should use the authenticated active-server client')
  assert(directoryCompletion.suggestions[0]?.path === '/srv/project one/', 'Working-directory completion should preserve authoritative server paths')
  workingDirectory.dispose()

  const validationDetail = new AgentServerClient('https://validation-detail.example')
  await assertRejects(
    validationDetail.sessions(),
    error => error instanceof ServerError
      && error.status === 422
      && error.message === 'String should have at least 2 characters',
    'FastAPI validation arrays should become readable messages instead of raw JSON',
  )
  validationDetail.dispose()

  const workspace = new AgentServerClient('https://workspace.example', 'workspace-token')
  const expectedRevision = 'a'.repeat(64)
  const savedWorkspaceFile = await workspace.workspaceWriteFile('session /?', 'notes / draft.md', '# Updated\n', expectedRevision)
  const workspaceWriteRequest = fetchRecords.at(-1)
  assert(workspaceWriteRequest, 'Workspace save should issue a request')
  assert(workspaceWriteRequest.url === 'https://workspace.example/api/sessions/session%20%2F%3F/workspace/file', 'Workspace save should encode the session ID')
  assert(workspaceWriteRequest.method === 'PUT', 'Workspace save should use PUT')
  assert(workspaceWriteRequest.token === 'workspace-token', 'Workspace save should authenticate through the validated client')
  assert(JSON.stringify(JSON.parse(workspaceWriteRequest.body ?? '{}')) === JSON.stringify({ path: 'notes / draft.md', content: '# Updated\n', expected_revision: expectedRevision }), 'Workspace save should send the path, content, and content revision exactly')
  assert(savedWorkspaceFile.path === 'notes / draft.md' && savedWorkspaceFile.revision === 'b'.repeat(64), 'Workspace save should return the authoritative file and new content revision')
  const createdWorkspaceEntry = await workspace.workspaceCreateEntry('session /?', 'notes/New File.ts', 'file')
  const createWorkspaceRequest = fetchRecords.at(-1)
  assert(createWorkspaceRequest?.method === 'POST', 'Workspace create should use POST')
  assert(JSON.stringify(JSON.parse(createWorkspaceRequest.body ?? '{}')) === JSON.stringify({ path: 'notes/New File.ts', kind: 'file' }), 'Workspace create should preserve its path and kind')
  assert(createdWorkspaceEntry.entry.path === 'notes/New File.ts', 'Workspace create should return its new entry')
  const renamedWorkspaceEntry = await workspace.workspaceRenameEntry('session /?', 'notes/New File.ts', 'Renamed.ts', 'c'.repeat(64))
  const renameWorkspaceRequest = fetchRecords.at(-1)
  assert(renameWorkspaceRequest?.method === 'PATCH', 'Workspace rename should use PATCH')
  assert(JSON.stringify(JSON.parse(renameWorkspaceRequest.body ?? '{}')) === JSON.stringify({ path: 'notes/New File.ts', new_name: 'Renamed.ts', expected_revision: 'c'.repeat(64) }), 'Workspace rename should require the current revision')
  assert(renamedWorkspaceEntry.previous_path === 'notes/New File.ts', 'Workspace rename should return its previous path')
  const removedWorkspaceEntry = await workspace.workspaceRemoveEntry('session /?', 'notes/Renamed.ts', 'd'.repeat(64))
  const removeWorkspaceRequest = fetchRecords.at(-1)
  assert(removeWorkspaceRequest?.method === 'DELETE', 'Workspace removal should use DELETE')
  const removeWorkspaceURL = new URL(removeWorkspaceRequest.url)
  assert(removeWorkspaceURL.searchParams.get('path') === 'notes/Renamed.ts', 'Workspace removal should encode its path')
  assert(removeWorkspaceURL.searchParams.get('expected_revision') === 'd'.repeat(64), 'Workspace removal should require the current revision')
  assert(removeWorkspaceURL.searchParams.get('recursive') === 'false', 'Workspace file removal should not recurse by default')
  assert(removedWorkspaceEntry.removed, 'Workspace removal should return server confirmation')
  workspace.dispose()

  const permissionFailures: Array<ServerError | WebSocketConnectionError> = []
  const workspacePermission = new AgentServerClient(
    'https://workspace-permission.example',
    'workspace-token',
    { requireValidation: true, onAuthorizationFailure: error => permissionFailures.push(error) },
  )
  workspacePermission.markValidated()
  await assertRejects(
    workspacePermission.workspaceWriteFile('session', 'notes.md', 'new content', expectedRevision),
    error => error instanceof ServerError && error.status === 403 && (error.detail as { code?: string })?.code === 'workspace_permission_denied',
    'Workspace permission failures should preserve their structured server error',
  )
  assert(workspacePermission.isValidated, 'A workspace 403 must not revoke the authenticated client')
  assert(permissionFailures.length === 0, 'A workspace 403 must not report a bearer-token failure')
  workspacePermission.dispose()

  const codex = new AgentServerClient('https://codex.example', 'codex-token')
  const codexFetchStart = fetchRecords.length
  await codex.createSession({
    title: 'Codex',
    folder: '',
    cwd: '/workspace',
    backend: 'codex',
    system_prompt: 'Stay focused.',
  })
  const createBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(createBody.system_prompt === 'Stay focused.', 'Session creation should send the system prompt')
  assert(createBody.codex_approval_policy === null, 'The server should own an omitted Codex approval default')
  assert(createBody.codex_sandbox_mode === null, 'The server should own an omitted Codex sandbox default')
  assert(createBody.codex_permission_profile === null, 'The server should own an omitted Codex permission profile default')
  assert(createBody.codex_approvals_reviewer === null, 'The server should own an omitted Codex reviewer default')
  assert(createBody.provider_jobs_access === null, 'The server should own an omitted provider jobs access default')

  await codex.createSession({
    title: 'Restricted Codex',
    folder: '',
    cwd: '/workspace',
    backend: 'codex',
    codex_approval_policy: 'untrusted',
    codex_sandbox_mode: 'workspace-write',
    codex_permission_profile: 'workspace',
    codex_approvals_reviewer: 'user',
    provider_jobs_access: 'read_only',
  })
  const explicitCreateBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(explicitCreateBody.codex_approval_policy === 'untrusted', 'Explicit Codex approval policy must override the default')
  assert(explicitCreateBody.codex_sandbox_mode === 'workspace-write', 'Explicit Codex sandbox mode must override the default')
  assert(explicitCreateBody.codex_permission_profile === 'workspace', 'Explicit Codex permission profile must override the default')
  assert(explicitCreateBody.codex_approvals_reviewer === 'user', 'Explicit Codex reviewer must override the default')
  assert(explicitCreateBody.provider_jobs_access === 'read_only', 'Session creation must serialize explicit provider jobs access')

  await codex.createSession({
    title: 'Claude plan',
    folder: '',
    cwd: '/workspace',
    backend: 'claude',
    claude_permission_mode: 'plan',
  })
  const claudeCreateBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(claudeCreateBody.claude_permission_mode === 'plan', 'Claude session creation must send the requested SDK permission mode')
  await codex.updateSession('session /?', { claude_permission_mode: null })
  const claudeResetBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(Object.hasOwn(claudeResetBody, 'claude_permission_mode'), 'Claude permission reset must preserve an explicit null')
  assert(claudeResetBody.claude_permission_mode === null, 'Claude permission reset must send null to restore the server default')

  await codex.sendTurn('session /?', 'Default-safe turn', [])
  const defaultTurnBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(!Object.hasOwn(defaultTurnBody, 'client_capabilities'), 'Turns must not opt into interactive Codex requests by default')
  await codex.sendTurn('session /?', 'Interactive turn', [], null, null, ['codex_interactive_v1'])
  const interactiveTurnBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(
    Array.isArray(interactiveTurnBody.client_capabilities)
      && interactiveTurnBody.client_capabilities[0] === 'codex_interactive_v1',
    'Callers should be able to opt into the Codex interactive capability explicitly',
  )
  await codex.sendTurn('session /?', 'Claude SDK turn', [], null, null, ['claude_sdk_interactive_v1'])
  const claudeTurnBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(
    Array.isArray(claudeTurnBody.client_capabilities)
      && claudeTurnBody.client_capabilities[0] === 'claude_sdk_interactive_v1',
    'Callers should be able to opt into the Claude Agent SDK capability explicitly',
  )
  const chatReference = {
    session_id: 'target',
    display_title_snapshot: 'Target',
    source_text_start: 4,
    source_text_end: 11,
    action: 'request_reply' as const,
  }
  await codex.sendTurn(
    'session /?',
    'Ask @Target',
    [],
    null,
    null,
    ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'],
    [chatReference],
  )
  const crossChatTurnBody = JSON.parse(fetchRecords.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert(
    JSON.stringify(crossChatTurnBody.chat_references) === JSON.stringify([chatReference]),
    'Turns should forward structured cross-chat references unchanged',
  )
  await codex.updateQueued(
    'session /?',
    'queued /?',
    'Ask @Target',
    [chatReference],
    ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'],
  )
  const queuedEditRequest = fetchRecords.at(-1)
  const queuedEditBody = JSON.parse(queuedEditRequest?.body ?? '{}') as Record<string, unknown>
  assert(
    queuedEditRequest?.url === 'https://codex.example/api/sessions/session%20%2F%3F/queue/queued%20%2F%3F',
    'Queued reference edits should encode both IDs',
  )
  assert(
    JSON.stringify(queuedEditBody.chat_references) === JSON.stringify([chatReference])
      && Array.isArray(queuedEditBody.client_capabilities)
      && queuedEditBody.client_capabilities.includes('cross_chat_handoffs_v2'),
    'Queued edits should preserve structured references with refreshed v2 capability authority',
  )
  assert((await codex.crossChatHandoff('handoff /?')).body === 'Check this', 'Handoff details should unwrap the authenticated response')
  assert((await codex.cancelCrossChatHandoff('handoff /?')).status === 'cancelled', 'Handoff cancellation should unwrap the summary')
  assert((await codex.crossChatExchange('exchange /?')).status === 'active', 'Exchange details should unwrap the authenticated response')
  assert((await codex.cancelCrossChatExchange('exchange /?')).status === 'cancelled', 'Exchange cancellation should unwrap the full exchange')
  await codex.skipQueuedCrossChatDelivery('session /?', 'queued /?', {
    cross_chat_exchange_id: 'exchange /?',
    cross_chat_exchange_leg_id: 'leg /?',
  })
  const exactSkipRequest = fetchRecords.at(-1)
  assert(exactSkipRequest?.url === 'https://codex.example/api/sessions/session%20%2F%3F/queue/queued%20%2F%3F/skip-cross-chat-delivery', 'Exact delivery skip should encode both queue identifiers')
  assert(JSON.parse(exactSkipRequest?.body ?? '{}').cross_chat_exchange_leg_id === 'leg /?', 'Exact delivery skip should bind the exchange leg identity')
  await codex.teamNetworkGet('/api/team-hub-server', '/v1/server-session')
  const teamNetworkGetRequest = fetchRecords.at(-1)
  assert(teamNetworkGetRequest?.url === 'https://codex.example/api/team-hub-server/v1/server-session', 'Team Network should stay on the authenticated AgentsServer proxy')
  assert(teamNetworkGetRequest?.teamNetworkToken === 'codex-token', 'Team Network proxy calls should use the exact AgentsDock control-token header')
  assert(teamNetworkGetRequest?.token === null && teamNetworkGetRequest.authorization === null, 'Team Network proxy calls should not mix legacy or Hub authorization headers into the control-token lane')
  await codex.teamNetworkPost('/api/team-hub-server', '/v1/teams/team/network/messages', { body: 'hello' })
  const teamNetworkPostRequest = fetchRecords.at(-1)
  assert(teamNetworkPostRequest?.teamNetworkToken === 'codex-token' && teamNetworkPostRequest.token === null && teamNetworkPostRequest.authorization === null, 'Team Network mutations should use only the exact AgentsDock control-token header')
  assert(teamNetworkPostRequest?.method === 'POST' && teamNetworkPostRequest.body === '{"body":"hello"}', 'Team Network mutations should preserve their JSON request body')
  assertThrows(() => { void codex.teamNetworkGet('https://hub.invalid', '/v1/teams') }, error => error instanceof Error && /Invalid Teamspace proxy route/.test(error.message), 'Team Network should reject direct Hub URLs')

  const stopResult = await codex.stopTurn('session /?')
  assert(stopResult.stopped === false, 'Stop acknowledgements must preserve an unfinished native interrupt')
  assert(stopResult.pending === true && stopResult.deferred === true, 'Stop acknowledgements must preserve retryable pending fields')
  assert(stopResult.message === 'The native interrupt is still pending.', 'Stop acknowledgements must preserve server guidance')

  const reloadResult = await codex.reloadProvider('session /?')
  assert(reloadResult.reloaded === true, 'Provider reload should return the structured server result')
  assert(reloadResult.session.backend_locked === true, 'Provider reload should preserve additive session contract fields')
  const reloadRequest = fetchRecords.at(-1)
  assert(reloadRequest?.url === 'https://codex.example/api/sessions/session%20%2F%3F/provider/reload', 'Provider reload should encode the session ID')
  assert(reloadRequest.method === 'POST' && reloadRequest.body === '{}', 'Provider reload should POST an explicit empty object')

  await codex.codexRuntime('session /?')
  await codex.resolveCodexInteraction('session /?', 'interaction /?', { decision: 'accept' })
  const claudeRuntime = await codex.claudeRuntime('session /?')
  assert(claudeRuntime.transport === 'agent-sdk', 'Claude runtime should return the server transport snapshot')
  const claudeMcp = await codex.claudeMcp('session /?')
  assert(claudeMcp.generation === 'claudemcp_opaque', 'Claude MCP status should preserve its opaque generation token')
  assert(claudeMcp.servers[0]?.name === 'calendar', 'Claude MCP status should preserve the display-safe server list')
  const disabledClaudeMcp = await codex.controlClaudeMcp('session /?', {
    version: 1,
    action: 'disable',
    server_name: 'calendar',
    expected_generation: claudeMcp.generation ?? '',
  })
  assert(disabledClaudeMcp.servers[0]?.enabled === false, 'Claude MCP control should return the refreshed snapshot')
  const mcpControlRequest = fetchRecords.at(-1)
  assert(mcpControlRequest?.url === 'https://codex.example/api/sessions/session%20%2F%3F/claude/mcp', 'Claude MCP control should encode the session ID')
  assert(mcpControlRequest.method === 'POST', 'Claude MCP control should use POST')
  assert(JSON.stringify(JSON.parse(mcpControlRequest.body ?? '{}')) === JSON.stringify({
    version: 1,
    action: 'disable',
    server_name: 'calendar',
    expected_generation: 'claudemcp_opaque',
  }), 'Claude MCP control should echo the exact opaque generation and action')
  const refreshedClaudeRuntime = await codex.refreshClaudeContextUsage('session /?')
  assert(refreshedClaudeRuntime.context_usage_refreshed === true, 'Claude context refresh should return the sampled runtime snapshot')
  const contextRefreshRequest = fetchRecords.at(-1)
  assert(
    contextRefreshRequest?.url === 'https://codex.example/api/sessions/session%20%2F%3F/claude/context-usage/refresh',
    'Claude context refresh should encode the session ID in its dedicated endpoint',
  )
  assert(contextRefreshRequest.method === 'POST', 'Claude context refresh should use POST')
  assert(contextRefreshRequest.body === '{}', 'Claude context refresh should send an explicit empty JSON object')
  assert(contextRefreshRequest.token === 'codex-token', 'Claude context refresh should use the authenticated client')
  const claudeInteraction = await codex.resolveClaudeInteraction(
    'session /?',
    'claude interaction /?',
    { decision: 'accept' },
  )
  assert(claudeInteraction.id === 'claude interaction /?', 'Claude interaction resolution should unwrap the interaction')
  await codex.codexPermissionProfiles('session /?')
  await codex.codexGoal('session /?')
  await codex.setCodexGoal('session /?', { objective: 'Ship parity', time_budget_seconds: 900 })
  await codex.clearCodexGoal('session /?')
  const serverGoals = await codex.codexServerGoals()
  assert(serverGoals.enabled && serverGoals.configurable, 'Server goal settings should return their capability and confirmed state')
  const serverGoalsRead = fetchRecords.at(-1)
  assert(serverGoalsRead?.url === 'https://codex.example/api/admin/codex/goals' && serverGoalsRead.method === 'GET', 'Server goals should use the dedicated GET endpoint')
  assert(serverGoalsRead.teamNetworkToken === 'codex-token' && serverGoalsRead.token === null, 'Server goal reads should use only the modern authenticated header')
  const disabledServerGoals = await codex.setCodexServerGoals(false)
  assert(disabledServerGoals.enabled === false, 'Server goal settings should apply the confirmed response, including disabled state')
  const serverGoalsWrite = fetchRecords.at(-1)
  assert(serverGoalsWrite?.url === 'https://codex.example/api/admin/codex/goals' && serverGoalsWrite.method === 'PUT', 'Server goals should use the dedicated PUT endpoint')
  assert(serverGoalsWrite.teamNetworkToken === 'codex-token' && serverGoalsWrite.token === null, 'Server goal writes should use only the modern authenticated header')
  assert(serverGoalsWrite.body === '{"enabled":false}', 'Server goal writes should send only the requested configuration')
  await codex.compactCodexThread('session /?')
  await codex.rollbackCodexThread('session /?', { num_turns: 2, confirmed: true })
  await codex.reviewCodexThread('session /?', { target: { type: 'uncommittedChanges' } })
  await codex.shellCodexThread('session /?', { command: 'git status --short', confirmed: true })
  await codex.codexBackgroundTerminals('session /?')
  assert(
    await codex.terminateCodexBackgroundTerminal('session /?', {
      process_id: 'process /?',
      confirmed: true,
    }),
    'Codex terminal termination should unwrap the server result',
  )
  assert(
    await codex.cleanCodexBackgroundTerminals('session /?', { confirmed: true }),
    'Codex terminal cleanup should unwrap the server result',
  )
  const codexRequests = fetchRecords.slice(codexFetchStart)
  assert(codexRequests.every(record => (
    record.teamNetworkToken === 'codex-token'
      ? record.token === null
      : record.token === 'codex-token' && record.teamNetworkToken === null
  )), 'Every endpoint should use exactly its expected authenticated request lane')
  assert(
    codexRequests.some(record => record.method === 'PUT' && new URL(record.url).pathname.endsWith('/codex/goal')),
    'Setting a Codex goal should use the authenticated PUT endpoint',
  )
  assert(
    codexRequests.some(record => new URL(record.url).pathname.includes('/interactions/interaction%20%2F%3F/resolve')),
    'Codex interaction IDs should be encoded in endpoint paths',
  )
  assert(
    codexRequests.some(record => new URL(record.url).pathname.endsWith('/claude/runtime')),
    'Claude runtime should use the authenticated per-session endpoint',
  )
  assert(
    codexRequests.some(record => {
      const path = new URL(record.url).pathname
      if (!path.includes('/claude/interactions/claude%20interaction%20%2F%3F/resolve')) return false
      return JSON.stringify(JSON.parse(record.body ?? '{}')) === JSON.stringify({ response: { decision: 'accept' } })
    }),
    'Claude interaction IDs should be encoded and responses should use the server envelope',
  )
  assert(
    codexRequests.some(record => {
      if (!record.url.endsWith('/codex/background-terminals/terminate')) return false
      const body = JSON.parse(record.body ?? '{}') as { process_id?: string; confirmed?: boolean }
      return body.process_id === 'process /?' && body.confirmed === true
    }),
    'Background-terminal termination should send the opaque process ID and explicit confirmation',
  )
  assert(
    codexRequests.some(record => {
      if (!record.url.endsWith('/codex/rollback')) return false
      const body = JSON.parse(record.body ?? '{}') as { num_turns?: number; confirmed?: boolean }
      return body.num_turns === 2 && body.confirmed === true
    }),
    'Codex rollback should send the server-required explicit confirmation',
  )
  assert(
    codexRequests.some(record => {
      if (!record.url.endsWith('/codex/background-terminals/clean')) return false
      return (JSON.parse(record.body ?? '{}') as { confirmed?: boolean }).confirmed === true
    }),
    'Stopping all Codex background terminals should send explicit confirmation',
  )
  codex.dispose()

  const disposed = new AgentServerClient('https://dispose.example', 'dispose-token')
  const pendingRequest = disposed.health()
  disposed.dispose()
  await assertRejects(
    pendingRequest,
    error => error instanceof AgentServerClientDisposedError,
    'Disposal should reject outstanding HTTP requests with a disposal error',
  )
  await assertRejects(
    disposed.health(),
    error => error instanceof AgentServerClientDisposedError,
    'Disposed clients should reject new HTTP requests',
  )
  assertThrows(
    () => disposed.url('/api/health'),
    error => error instanceof AgentServerClientDisposedError,
    'Disposed clients should reject synchronous URL work',
  )

  const combined = new AgentServerClient('https://signals.example')
  const internals = combined as unknown as {
    captureScope(): { signal: AbortSignal }
    fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, scopeSignal: AbortSignal): Promise<Response>
  }
  const callerController = new AbortController()
  const callerRequest = internals.fetchWithTimeout(
    'https://signals.example/caller',
    { signal: callerController.signal },
    30_000,
    internals.captureScope().signal,
  )
  callerController.abort(new Error('caller cancelled'))
  await assertRejects(
    callerRequest,
    error => error instanceof Error && error.message === 'caller cancelled',
    'Caller abort signals should be preserved by the combined request signal',
  )
  await assertRejects(
    internals.fetchWithTimeout('https://signals.example/timeout', {}, 1, internals.captureScope().signal),
    error => error instanceof Error && error.name === 'AbortError',
    'Request timeout should remain active alongside client and caller signals',
  )
  assert(!combined.isDisposed, 'Caller cancellation and timeout should not dispose the client')
  combined.dispose()

  const validationClient = new AgentServerClient(
    'https://validation.example',
    'validation-token',
    { requireValidation: true },
  )
  assert(!validationClient.isValidated, 'Validation-required clients should begin health-only')
  const health = await validationClient.health()
  assert(health.server_identity === 'validated-server', 'Health should remain available before validation')
  const fetchesAfterHealth = fetchRecords.length
  const blockedHTTPCalls: Array<[string, () => unknown]> = [
    ['runtime catalog', () => validationClient.runtimeCatalog()],
    ['sessions', () => validationClient.sessions()],
    ['jobs', () => validationClient.jobs()],
    ['create session', () => validationClient.createSession({} as never)],
    ['update session', () => validationClient.updateSession('session', {})],
    ['reload provider', () => validationClient.reloadProvider('session')],
    ['delete session', () => validationClient.deleteSession('session')],
    ['fork session', () => validationClient.forkSession('session')],
    ['reorder session', () => validationClient.reorderSession('session', 'target', 'after')],
    ['mark read', () => validationClient.markRead('session')],
    ['mark unread', () => validationClient.markUnread('session')],
    ['session page', () => validationClient.sessionPage('session')],
    ['timeline index', () => validationClient.timelineIndex('session')],
    ['code diff', () => validationClient.codeDiff('session', 'run')],
    ['timeline search', () => validationClient.searchTimeline('session', 'query')],
    ['session search', () => validationClient.searchSessions('query')],
    ['send turn', () => validationClient.sendTurn('session', 'prompt', [])],
    ['stop turn', () => validationClient.stopTurn('session')],
    ['Codex runtime', () => validationClient.codexRuntime('session')],
    ['Claude runtime', () => validationClient.claudeRuntime('session')],
    ['Claude MCP status', () => validationClient.claudeMcp('session')],
    ['Claude MCP control', () => validationClient.controlClaudeMcp('session', { version: 1, action: 'reconnect', server_name: 'calendar', expected_generation: 'generation' })],
    ['refresh Claude context usage', () => validationClient.refreshClaudeContextUsage('session')],
    ['resolve Codex interaction', () => validationClient.resolveCodexInteraction('session', 'interaction', {})],
    ['Codex permission profiles', () => validationClient.codexPermissionProfiles('session')],
    ['Codex goal', () => validationClient.codexGoal('session')],
    ['set Codex goal', () => validationClient.setCodexGoal('session', {})],
    ['clear Codex goal', () => validationClient.clearCodexGoal('session')],
    ['server Codex goals', () => validationClient.codexServerGoals()],
    ['set server Codex goals', () => validationClient.setCodexServerGoals(false)],
    ['compact Codex thread', () => validationClient.compactCodexThread('session')],
    ['rollback Codex thread', () => validationClient.rollbackCodexThread('session', { num_turns: 1, confirmed: true })],
    ['review Codex thread', () => validationClient.reviewCodexThread('session', { target: { type: 'uncommittedChanges' } })],
    ['Codex shell command', () => validationClient.shellCodexThread('session', { command: 'pwd', confirmed: true })],
    ['Codex background terminals', () => validationClient.codexBackgroundTerminals('session')],
    ['terminate Codex background terminal', () => validationClient.terminateCodexBackgroundTerminal('session', { process_id: 'process', confirmed: true })],
    ['clean Codex background terminals', () => validationClient.cleanCodexBackgroundTerminals('session', { confirmed: true })],
    ['queue', () => validationClient.queue('session')],
    ['update queued turn', () => validationClient.updateQueued('session', 'queued', 'prompt')],
    ['cross-chat handoff', () => validationClient.crossChatHandoff('handoff')],
    ['cancel cross-chat handoff', () => validationClient.cancelCrossChatHandoff('handoff')],
    ['cross-chat exchange', () => validationClient.crossChatExchange('exchange')],
    ['cancel cross-chat exchange', () => validationClient.cancelCrossChatExchange('exchange')],
    ['skip exact queued cross-chat delivery', () => validationClient.skipQueuedCrossChatDelivery('session', 'queued', { cross_chat_exchange_id: 'exchange', cross_chat_exchange_leg_id: 'leg' })],
    ['Team Network get', () => validationClient.teamNetworkGet('/api/team-hub-server', '/v1/server-session')],
    ['Team Network post', () => validationClient.teamNetworkPost('/api/team-hub-server', '/v1/teams/team/network/messages', {})],
    ['remove queued turn', () => validationClient.removeQueued('session', 'queued')],
    ['move queued turn', () => validationClient.moveQueued('session', 'queued', 'up')],
    ['run queued turn', () => validationClient.runQueuedNow('session', 'queued')],
    ['create job', () => validationClient.createJob({} as never)],
    ['update job', () => validationClient.updateJob('job', {} as never)],
    ['delete job', () => validationClient.deleteJob('job')],
    ['run job', () => validationClient.runJob('job')],
    ['files', () => validationClient.files('session')],
    ['workspace file write', () => validationClient.workspaceWriteFile('session', 'notes.md', 'content', 'a'.repeat(64))],
    ['upload', () => validationClient.upload('session', {} as never)],
    ['processes', () => validationClient.processes('session')],
    ['process log', () => validationClient.processLog('session', '/tmp/log')],
    ['tmux panes', () => validationClient.tmux('session')],
    ['tmux capture', () => validationClient.captureTmux('session', 'pane')],
    ['terminal windows', () => validationClient.terminalWindows('session')],
    ['terminal action', () => validationClient.terminalAction('session', 'new-window')],
    ['delete terminal', () => validationClient.deleteTerminal('session')],
    ['preview digest', () => validationClient.previewDigest('source', 'target', 'normal', '')],
    ['send digest', () => validationClient.sendDigest('source', 'target', 'normal', '')],
  ]
  for (const [name, action] of blockedHTTPCalls) {
    await assertRejects(
      Promise.resolve().then(action),
      error => error instanceof AgentServerClientUnvalidatedError,
      `Unvalidated clients should reject ${name}`,
    )
  }
  assert(fetchRecords.length === fetchesAfterHealth, 'Blocked HTTP calls must not reach fetch')
  for (const [name, action] of [
    ['URL access', () => validationClient.url('/api/sessions')],
    ['file URL access', () => validationClient.fileURL('chat', 'file')],
    ['auth header access', () => validationClient.authHeaders()],
    ['timeline stream', () => validationClient.stream('session', 0, () => undefined, () => undefined)],
    ['terminal socket', () => validationClient.terminal('session', 80, 24, null, () => undefined, () => undefined)],
  ] satisfies Array<[string, () => unknown]>) {
    assertThrows(
      action,
      error => error instanceof AgentServerClientUnvalidatedError,
      `Unvalidated clients should reject ${name}`,
    )
  }
  validationClient.markValidated()
  assert(validationClient.isValidated, 'markValidated should unlock a validation-required client')
  assert(validationClient.fileURL('chat', 'file') === 'https://validation.example/api/sessions/chat/files/file', 'Validated clients should expose scoped file URLs')
  assert(validationClient.authHeaders()['X-ZenithDock-Token'] === 'validation-token', 'Validated clients should expose their auth header')
  assert((await validationClient.sessions()).length === 0, 'Validated clients should allow non-health HTTP requests')
  validationClient.configure('https://revoke.example', 'revoke-token')
  validationClient.markValidated()
  const pendingRevocationRequest = validationClient.sessions()
  validationClient.revokeValidation()
  assert(!validationClient.isValidated, 'Revocation should return validation-required clients to health-only mode')
  await assertRejects(
    pendingRevocationRequest,
    error => error instanceof AgentServerClientUnvalidatedError,
    'Revocation should abort authenticated HTTP requests with an unvalidated error',
  )
  validationClient.revokeValidation()
  assert(!validationClient.isValidated, 'Repeated revocation should be idempotent')
  const healthAfterRevocation = await validationClient.health()
  assert(healthAfterRevocation.server_identity === 'revoke-server', 'Health should remain available after revocation')
  validationClient.markValidated()
  validationClient.configure('https://validation.example', 'validation-token')
  validationClient.markValidated()
  validationClient.configure('https://validation-next.example', 'next-token')
  assert(!validationClient.isValidated, 'Changing a validation-required client connection should revoke validation')
  assertThrows(
    () => validationClient.url('/api/sessions'),
    error => error instanceof AgentServerClientUnvalidatedError,
    'Reconfigured validation-required clients should return to health-only mode',
  )
  validationClient.dispose()
  assertThrows(
    () => validationClient.revokeValidation(),
    error => error instanceof AgentServerClientDisposedError,
    'Disposed validation-required clients should reject revocation',
  )
  assertThrows(
    () => validationClient.markValidated(),
    error => error instanceof AgentServerClientDisposedError,
    'Disposal should take precedence over validation state',
  )
  await assertRejects(
    validationClient.health(),
    error => error instanceof AgentServerClientDisposedError,
    'Disposed health-only clients should reject health checks',
  )

  const authorizationFailures: Array<ServerError | WebSocketConnectionError> = []
  const authenticationClient = new AgentServerClient(
    'https://auth-reject.example',
    'expired-token',
    { requireValidation: true, onAuthorizationFailure: error => authorizationFailures.push(error) },
  )
  const initialAuthenticationRevision = authenticationClient.validationRevision
  authenticationClient.markValidated()
  const validatedAuthenticationRevision = authenticationClient.validationRevision
  assert(validatedAuthenticationRevision === initialAuthenticationRevision, 'Successful validation should preserve the invalidation epoch')
  await assertRejects(
    authenticationClient.sessions(),
    error => {
      assert(!authenticationClient.isValidated, 'An authenticated 401 must revoke validation before the request rejects')
      assert(authorizationFailures.length === 1, 'An authenticated 401 must notify its owner before the request rejects')
      return error instanceof ServerError && error.status === 401
    },
    'An authenticated 401 should preserve the server rejection',
  )
  const revokedAuthenticationRevision = authenticationClient.validationRevision
  assert(revokedAuthenticationRevision > validatedAuthenticationRevision, 'An authenticated 401 revocation should advance the validation revision')
  const fetchesBeforeRejectedHealth = fetchRecords.length
  await assertRejects(
    authenticationClient.health(),
    error => error instanceof ServerError && error.status === 401,
    'Health should remain callable while an authentication client is unvalidated',
  )
  assert(fetchRecords.length === fetchesBeforeRejectedHealth + 1, 'An unvalidated health request should still reach fetch')
  assert(!authenticationClient.isValidated, 'A rejected health check must not restore validation')
  assert(authenticationClient.validationRevision > revokedAuthenticationRevision, 'Every explicit authentication rejection should advance the invalidation epoch')
  assert(authorizationFailures.length === 2, 'Health authentication rejection should notify the client owner')
  authenticationClient.dispose()

  const ungatedClient = new AgentServerClient('https://ungated.example')
  ungatedClient.revokeValidation()
  assert(ungatedClient.isValidated, 'Revocation should not lock a client that does not require validation')
  assert(ungatedClient.url('/api/health') === 'https://ungated.example/api/health', 'Ungated clients should remain usable after revocation')
  ungatedClient.dispose()
} finally {
  globalThis.fetch = originalFetch
}

interface FakeCloseEvent {
  code: number
  reason: string
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  closeCalls = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: FakeCloseEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: unknown): void { this.sent.push(data) }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.closeCalls += 1
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

const originalWebSocket = globalThis.WebSocket
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

try {
  FakeWebSocket.instances = []
  const captured = new AgentServerClient('https://captured.example', 'captured-token')
  captured.stream('session-one', 4, () => undefined, () => undefined)
  const firstSocket = FakeWebSocket.instances[0]
  assert(firstSocket, 'Timeline stream should create a socket')
  assert(new URL(firstSocket.url).searchParams.get('visible') === 'true', 'Timeline streams should identify themselves as visible clients')
  firstSocket.emitClose(1006)
  ;(captured as unknown as { configuration: { baseURL: string; token: string } }).configuration = {
    baseURL: 'https://mutated.example',
    token: 'mutated-token',
  }
  await delay(550)
  const retrySocket = FakeWebSocket.instances[1]
  assert(retrySocket, 'Retryable close should create a replacement socket')
  assert(retrySocket.url.startsWith('wss://captured.example/'), 'Timeline retry should retain the captured server URL')
  assert(new URL(retrySocket.url).searchParams.get('token') === 'captured-token', 'Timeline retry should retain the captured token')
  retrySocket.emitOpen()
  retrySocket.emitClose(1006)
  await delay(550)
  assert(FakeWebSocket.instances.length === 2, 'An immediately dropped handshake must not reset timeline retry backoff')
  await delay(500)
  assert(Number(FakeWebSocket.instances.length) === 3, 'Timeline retry should continue after its increased backoff delay')
  captured.dispose()

  FakeWebSocket.instances = []
  const runtimeClient = new AgentServerClient('https://runtime.example', 'runtime-token')
  const runtimePackets: Array<{ session_id: string; usage_generation?: number | null }> = []
  const runtimeTimelineSeqs: number[] = []
  runtimeClient.stream(
    'session-runtime',
    5,
    event => { runtimeTimelineSeqs.push(event.seq) },
    () => undefined,
    event => { runtimePackets.push(event) },
  )
  const runtimeSocket = FakeWebSocket.instances[0]
  assert(runtimeSocket, 'Provider runtime test should create a timeline socket')
  runtimeSocket.onmessage?.({ data: JSON.stringify({
    type: 'provider_runtime_changed',
    session_id: 'session-runtime',
    backend: 'claude',
    runtime: 'context_usage',
    ephemeral: true,
    usage_generation: 7,
  }) })
  runtimeSocket.onmessage?.({ data: JSON.stringify({
    type: 'provider_runtime_changed',
    session_id: 'another-session',
    backend: 'claude',
    runtime: 'context_usage',
    ephemeral: true,
    usage_generation: 8,
  }) })
  runtimeSocket.onmessage?.({ data: JSON.stringify({
    id: 'event-6',
    session_id: 'session-runtime',
    seq: 6,
    type: 'assistant_text',
    ts: 'now',
  }) })
  runtimeSocket.emitClose(1006)
  await delay(550)
  assert(runtimePackets.length === 1, 'Only matching Claude runtime invalidations should reach the separate callback')
  assert(runtimePackets[0]?.usage_generation === 7, 'Runtime invalidation should retain its generation metadata')
  assert(runtimeTimelineSeqs.length === 1 && runtimeTimelineSeqs[0] === 6, 'Ephemeral runtime packets must never enter the durable timeline')
  assert(
    new URL(FakeWebSocket.instances[1]?.url ?? '').searchParams.get('after') === '6',
    'Ephemeral runtime packets must not advance the reconnect cursor',
  )
  runtimeClient.dispose()

  FakeWebSocket.instances = []
  const revoked = new AgentServerClient('https://revoked.example', 'revoked-token', { requireValidation: true })
  revoked.markValidated()
  revoked.stream('session-revoked', 0, () => undefined, () => undefined)
  const revokedTimelineSocket = FakeWebSocket.instances[0]
  const revokedTerminal = revoked.terminal('session-revoked', 80, 24, null, () => undefined, () => undefined)
  const revokedTerminalSocket = FakeWebSocket.instances[1]
  assert(revokedTimelineSocket && revokedTerminalSocket, 'Validated client should create both authenticated transports')
  revoked.revokeValidation()
  assert(revokedTimelineSocket.closeCalls === 1, 'Revocation should close the timeline socket')
  assert(revokedTerminalSocket.closeCalls === 1, 'Revocation should close the terminal socket')
  revoked.revokeValidation()
  assert(revokedTimelineSocket.closeCalls === 1 && revokedTerminalSocket.closeCalls === 1, 'Repeated revocation should not close transports twice')
  await delay(550)
  assert(FakeWebSocket.instances.length === 2, 'Revocation should cancel authenticated transport retries')
  revokedTerminal.close()
  revoked.dispose()

  FakeWebSocket.instances = []
  const states: Array<{ connected: boolean; detail?: WebSocketStateDetail }> = []
  const fatal = new AgentServerClient('https://fatal.example', 'fatal-token', { requireValidation: true })
  fatal.markValidated()
  fatal.stream('session-two', 0, () => undefined, (connected, detail) => states.push({ connected, detail }))
  const fatalSocket = FakeWebSocket.instances[0]
  assert(fatalSocket, 'Fatal timeline test should create a socket')
  fatalSocket.emitClose(4401)
  await delay(550)
  assert(FakeWebSocket.instances.length === 1, 'Fatal WebSocket close should not retry')
  const fatalState = states.at(-1)
  assert(fatalState?.connected === false, 'Fatal WebSocket close should report disconnected')
  assert(fatalState.detail?.fatal === true, 'Fatal WebSocket close should expose fatal detail')
  assert(fatalState.detail?.code === 4401, 'Fatal WebSocket close should expose its close code')
  assert(fatalState.detail?.retrying === false, 'Fatal WebSocket close should report that it will not retry')
  assert(!fatal.isValidated, 'An authentication close should revoke client validation before returning control')
  fatal.dispose()

  FakeWebSocket.instances = []
  const retrying = new AgentServerClient('https://retry.example', 'retry-token')
  let disposedTimelineEvents = 0
  retrying.stream('session-retry', 0, () => { disposedTimelineEvents += 1 }, () => undefined)
  const retryingSocket = FakeWebSocket.instances[0]
  assert(retryingSocket, 'Retry disposal test should create a socket')
  retryingSocket.emitClose(1006)
  retrying.dispose()
  retryingSocket.onmessage?.({ data: '{"seq":1}' })
  await delay(550)
  assert(FakeWebSocket.instances.length === 1, 'Client disposal should cancel a pending timeline retry')
  assert(disposedTimelineEvents === 0, 'Timeline should ignore packets queued after disposal')

  FakeWebSocket.instances = []
  const terminalStates: boolean[] = []
  let terminalData = ''
  const terminalClient = new AgentServerClient('https://terminal.example', 'terminal-token')
  const terminal = terminalClient.terminal('session-three', 80, 24, null, data => { terminalData += data }, connected => terminalStates.push(connected))
  const terminalSocket = FakeWebSocket.instances[0]
  assert(terminalSocket, 'Terminal should create a socket')
  terminalClient.dispose()
  terminalSocket.onmessage?.({ data: 'queued terminal data' })
  terminalSocket.onmessage?.({ data: '{"type":"ready","name":"stale"}' })
  assert(terminalSocket.closeCalls === 1, 'Client disposal should close the terminal socket')
  assert(terminalStates.filter(connected => !connected).length === 1, 'Terminal disposal should report one disconnect')
  assert(!terminalStates.includes(true), 'Terminal should ignore ready packets queued after disposal')
  assert(terminalData === '', 'Terminal should ignore data packets queued after disposal')
  terminal.close()
  assert(terminalSocket.closeCalls === 1, 'Terminal close should remain idempotent after client disposal')
} finally {
  globalThis.WebSocket = originalWebSocket
}

console.log('agent server client scope regressions passed')
