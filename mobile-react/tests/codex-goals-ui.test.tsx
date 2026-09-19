import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { useLayoutEffect } from 'react'
import { create, act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'
import { AppTypographyProvider } from '../src/components/AppText'
import { CodexGoalBar, CodexGoalEditor } from '../src/components/CodexGoalBar'
import { CodexStatusButton } from '../src/components/CodexControls'
import { CodexRuntimeProvider, useCodexRuntime } from '../src/components/CodexRuntimeContext'
import { announceCodexGoalsConfigurationChanged } from '../src/lib/codex-goals-configuration'
import type { CodexGoal, CodexGoalInput, CodexGoalSnapshot, CodexRuntimeSnapshot, Health, Session } from '../src/types'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { Alert, Keyboard, StyleSheet } from './component-mocks/react-native'

const goal: CodexGoal = { threadId: 'thread-a', objective: 'Finish the mobile goal controls', status: 'active', tokenBudget: 1000, tokensUsed: 120, timeUsedSeconds: 20, createdAt: 1, updatedAt: 2 }
const health = { ok: true, capabilities: { codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1', features: { goals: true } } } } as Health
const session = { id: 'chat-a', backend: 'codex', codex_thread_id: 'thread-a', codex_goal: goal } as Session
function runtime(value: CodexGoal | null = goal): CodexRuntimeSnapshot {
  return { available: true, transport: 'app-server', interactive_capability: 'codex_interactive_v1', thread_loaded: true, status: { type: 'idle' }, goal: value, goals_enabled: true, time_budget_seconds: 600, pending_interactions: [], permission_profiles: [], background_terminals_supported: false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let context: ReturnType<typeof useCodexRuntime>
const observations: Array<string | null> = []
function Probe() { context = useCodexRuntime(); observations.push(context.runtime?.goal?.status ?? null); return null }
const mounted: ReactTestRenderer[] = []
function goalTree(content: 'bar' | 'editor' | 'status' = 'bar', sessionId = 'chat-a') {
  return <AppTypographyProvider><CodexRuntimeProvider sessionId={sessionId}><Probe />{content === 'bar' ? <CodexGoalBar /> : content === 'editor' ? <CodexGoalEditor /> : <CodexStatusButton compact={false} />}</CodexRuntimeProvider></AppTypographyProvider>
}
async function mount(content: 'bar' | 'editor' | 'status' = 'bar') {
  let tree!: ReactTestRenderer
  await act(async () => { tree = create(goalTree(content)) })
  mounted.push(tree)
  return tree
}
function nodes(tree: ReactTestRenderer, id: string) { return tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === id) }
function node(tree: ReactTestRenderer, id: string) { const found = nodes(tree, id); assert.equal(found.length, 1, `Expected one ${id}`); return found[0] }
function contents(value: ReactTestInstance | string): string { return typeof value === 'string' ? value : value.children.map(child => contents(child)).join('') }
async function press(tree: ReactTestRenderer, id: string) { await act(async () => { node(tree, id).props.onPress() }) }
async function change(tree: ReactTestRenderer, id: string, value: string) { await act(async () => { node(tree, id).props.onChangeText(value) }) }
beforeEach(() => {
  observations.length = 0
  Alert.__reset()
  resetComponentStore({ health, sessions: [session], selectedSessionId: 'chat-a', switchingProfileId: null })
  setTestClient({ codexRuntime: async () => runtime(), codexPermissionProfiles: async () => [] })
})
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => tree.unmount()) })

test('goal starts as one accessible compact header and only mounts progress and controls when expanded', async () => {
  const tree = await mount()
  const header = node(tree, 'codex-goal-details')
  assert.equal(header.props.accessibilityRole, 'button')
  assert.equal(header.props.accessibilityState.expanded, false)
  assert.match(header.props.accessibilityLabel, /Show goal details\. Pursuing goal\./)
  assert.ok(Number(StyleSheet.flatten(header.props.style)?.minHeight) >= 44)
  assert.equal(node(tree, 'codex-goal-objective').props.numberOfLines, 1)
  assert.equal(node(tree, 'codex-goal-objective').props.ellipsizeMode, 'tail')
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal')
  for (const id of ['codex-goal-body', 'codex-goal-progress', 'codex-goal-toggle', 'codex-goal-edit', 'codex-goal-clear', 'codex-goal-objective-full']) assert.equal(nodes(tree, id).length, 0)
  const chevrons = header.findAll(child => child.type === 'ChevronDown')
  assert.equal(chevrons.length, 1)
  assert.deepEqual(chevrons[0].props.style.transform, [{ rotate: '-90deg' }])
  await press(tree, 'codex-goal-details')
  assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, true)
  const body = node(tree, 'codex-goal-body')
  assert.ok(Number(StyleSheet.flatten(body.props.style)?.maxHeight) >= 120)
  assert.ok(Number(StyleSheet.flatten(body.props.style)?.maxHeight) <= 160)
  for (const id of ['codex-goal-progress', 'codex-goal-toggle', 'codex-goal-edit', 'codex-goal-clear', 'codex-goal-objective-full']) assert.equal(body.findAll(child => typeof child.type === 'string' && child.props.testID === id).length, 1)
  await press(tree, 'codex-goal-details')
  assert.equal(nodes(tree, 'codex-goal-body').length, 0)
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal')
})

test('both fold choices survive repeated counter, objective and status refreshes', async () => {
  let value = runtime()
  setTestClient({ codexRuntime: async () => value })
  const tree = await mount()
  for (const expanded of [false, true, false]) {
    if (node(tree, 'codex-goal-details').props.accessibilityState.expanded !== expanded) await press(tree, 'codex-goal-details')
    for (const [index, status] of (['active', 'blocked', 'paused', 'complete'] as const).entries()) {
      value = runtime({ ...goal, objective: `Updated objective ${expanded} ${index}`, status, updatedAt: 10 + index, tokensUsed: 200 + index, timeUsedSeconds: 30 + index })
      await act(async () => { await context.refresh() })
      assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, expanded)
      assert.equal(nodes(tree, 'codex-goal-body').length, Number(expanded))
      assert.equal(contents(node(tree, 'codex-goal-objective')), value.goal?.objective)
      assert.ok(contents(node(tree, 'codex-goal-state')).length > 0)
    }
  }
})

test('fold choice resets on profile generation and chat changes but survives reconnects', async () => {
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await act(async () => useAppStore.setState({ connected: false }))
  await act(async () => useAppStore.setState({ connected: true }))
  assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, true)
  for (const next of [{ activeProfileId: 'profile-b' }, { profileGeneration: 2 }]) {
    await act(async () => useAppStore.setState(next))
    assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, false)
    await press(tree, 'codex-goal-details')
  }
  await act(async () => {
    useAppStore.setState({ sessions: [session, { ...session, id: 'chat-b' }], selectedSessionId: 'chat-b' })
    tree.update(goalTree('bar', 'chat-b'))
  })
  assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, false)
  assert.equal(nodes(tree, 'codex-goal-toggle').length, 0)
})

test('a collapsed goal keeps a truncated alert and exposes the full error on expansion', async () => {
  const message = 'Goal update failed. '.repeat(80)
  setTestClient({ codexRuntime: async () => runtime(), setCodexGoal: async () => { throw new Error(message) } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await press(tree, 'codex-goal-toggle')
  assert.equal(contents(node(tree, 'codex-goal-error')), `Could not pause goal: ${message}`)
  assert.equal(node(tree, 'codex-goal-error').props.numberOfLines, undefined)
  await press(tree, 'codex-goal-details')
  assert.equal(node(tree, 'codex-goal-error').props.accessibilityRole, 'alert')
  assert.equal(node(tree, 'codex-goal-error').props.numberOfLines, 1)
  assert.equal(node(tree, 'codex-goal-error').props.ellipsizeMode, 'tail')
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal')
  assert.match(node(tree, 'codex-goal-details').props.accessibilityHint, /Goal alert/)
  await press(tree, 'codex-goal-details')
  assert.equal(contents(node(tree, 'codex-goal-error')), `Could not pause goal: ${message}`)
  assert.equal(node(tree, 'codex-goal-error').props.numberOfLines, undefined)
})

test('long goals keep bounded scrolling and reachable keyboard-safe controls in a narrow large-text host', async () => {
  const objective = 'Long objective with details for a narrow phone. '.repeat(80)
  setTestClient({ codexRuntime: async () => runtime({ ...goal, objective }) })
  useAppStore.setState({ fontScale: 1.6 })
  const tree = await mount()
  await act(async () => tree.update(<View testID="narrow-keyboard-host" style={{ width: 280, maxHeight: 220 }}>{goalTree()}</View>))
  assert.equal(node(tree, 'codex-goal-objective').props.numberOfLines, 1)
  assert.ok(Number(StyleSheet.flatten(node(tree, 'codex-goal-objective').props.style)?.fontSize) > 12)
  await press(tree, 'codex-goal-details')
  const body = node(tree, 'codex-goal-body')
  assert.equal(body.props.nestedScrollEnabled, true)
  assert.equal(body.props.keyboardShouldPersistTaps, 'always')
  assert.equal(StyleSheet.flatten(body.props.style)?.maxHeight, 152)
  assert.equal(contents(node(tree, 'codex-goal-objective-full')), objective)
  assert.equal(node(tree, 'codex-goal-objective-full').props.numberOfLines, undefined)
  for (const id of ['codex-goal-toggle', 'codex-goal-edit', 'codex-goal-clear']) {
    const control = node(tree, id)
    const style = StyleSheet.flatten(control.props.style({ pressed: false }))
    assert.ok(Number(style?.minHeight) >= 44)
    assert.ok(Number(style?.minWidth) >= 44)
  }
  const originalDismiss = Keyboard.dismiss
  let dismissals = 0
  Keyboard.dismiss = () => { dismissals++ }
  try {
    await press(tree, 'codex-goal-edit')
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    assert.equal(nodes(tree, 'codex-goal-editor').length, 1)
    assert.ok(dismissals > 0)
    await press(tree, 'codex-goal-editor-close')
    assert.equal(nodes(tree, 'codex-goal-editor').length, 0)
    assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, true)
  } finally { Keyboard.dismiss = originalDismiss }
})

test('Pause is single-flight and applies the returned snapshot before stale refreshes settle', async () => {
  const staleRead = deferred<CodexRuntimeSnapshot>()
  const freshRead = deferred<CodexRuntimeSnapshot>()
  const save = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  let reads = 0
  setTestClient({ codexRuntime: () => ++reads === 1 ? Promise.resolve(runtime()) : reads === 2 ? staleRead.promise : freshRead.promise, setCodexGoal: async (id, input) => { assert.equal(id, 'chat-a'); inputs.push(input); return save.promise } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await act(async () => { void context.refresh() })
  const tap = node(tree, 'codex-goal-toggle').props.onPress
  await act(async () => { tap(); tap() })
  assert.deepEqual(inputs, [{ status: 'paused' }])
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, true)
  await press(tree, 'codex-goal-details')
  const paused = { ...goal, status: 'paused' as const, updatedAt: 3 }
  await act(async () => save.resolve({ goal: paused, time_budget_seconds: 600 }))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
  assert.equal(node(tree, 'codex-goal-details').props.accessibilityState.expanded, false)
  const applied = observations.length
  await act(async () => staleRead.resolve(runtime(goal)))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
  assert.ok(!observations.slice(applied).includes('active'))
  await act(async () => freshRead.resolve(runtime(paused)))
})

test('Resume sends only status; Clear requires confirmation and rejects duplicate alert taps', async () => {
  let value = runtime({ ...goal, status: 'paused' })
  const inputs: CodexGoalInput[] = []
  let cleared = 0
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => { inputs.push(input); value = runtime({ ...goal, status: 'active' }); return { goal: value.goal, time_budget_seconds: 600 } }, clearCodexGoal: async () => { cleared++; value = { ...runtime(null), time_budget_seconds: null }; return { goal: null, time_budget_seconds: null } } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Resume goal')
  await press(tree, 'codex-goal-toggle')
  assert.deepEqual(inputs, [{ status: 'active' }])
  const clearTap = node(tree, 'codex-goal-clear').props.onPress
  await act(async () => { clearTap(); clearTap() })
  assert.equal(Alert.__calls.length, 1)
  assert.equal(cleared, 0)
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'cancel')?.onPress?.())
  assert.equal(cleared, 0)
  await press(tree, 'codex-goal-clear')
  await act(async () => Alert.__calls[1].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(cleared, 1)
  assert.equal(nodes(tree, 'codex-goal-bar').length, 0)
})

test('Resume immediately reports progress, keeps failures through refresh, and retries the same status-only action', async () => {
  let value = runtime({ ...goal, status: 'paused' })
  const pending = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => {
    inputs.push(input)
    if (inputs.length === 1) return pending.promise
    value = runtime({ ...goal, status: 'active' })
    return { goal: value.goal, time_budget_seconds: 600 }
  } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  const resume = node(tree, 'codex-goal-toggle').props.onPress
  await act(async () => { resume(); resume() })
  assert.deepEqual(inputs, [{ status: 'active' }])
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Resuming goal…')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Resuming goal…')
  assert.deepEqual(node(tree, 'codex-goal-toggle').props.accessibilityState, { disabled: true, busy: true })
  await press(tree, 'codex-goal-details')
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Resuming goal…')
  await act(async () => pending.reject(new Error('Goal owner could not start')))
  assert.equal(contents(node(tree, 'codex-goal-error')), 'Could not resume goal: Goal owner could not start')
  await act(async () => { await context.refresh() })
  assert.equal(contents(node(tree, 'codex-goal-error')), 'Could not resume goal: Goal owner could not start')
  await press(tree, 'codex-goal-details')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Retry resume goal')
  await press(tree, 'codex-goal-toggle')
  assert.deepEqual(inputs, [{ status: 'active' }, { status: 'active' }])
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Pause goal')
  assert.equal(nodes(tree, 'codex-goal-error').length, 0)
})

test('the first Resume tap on a replacement goal survives the commit before passive effects', async () => {
  let value = runtime()
  const pending = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => { inputs.push(input); return pending.promise } })
  let tree!: ReactTestRenderer
  function FirstCommittedTap() {
    const current = useCodexRuntime()
    useLayoutEffect(() => {
      if (current.runtime?.goal?.createdAt === 42) node(tree, 'codex-goal-toggle').props.onPress()
    }, [current.runtime?.goal?.createdAt])
    return null
  }
  await act(async () => {
    tree = create(<AppTypographyProvider><CodexRuntimeProvider sessionId="chat-a"><Probe /><CodexGoalBar /><FirstCommittedTap /></CodexRuntimeProvider></AppTypographyProvider>)
  })
  mounted.push(tree)
  await press(tree, 'codex-goal-details')
  value = runtime({ ...goal, objective: 'Replacement goal', createdAt: 42, status: 'paused' })
  await act(async () => { await context.refresh() })
  assert.deepEqual(inputs, [{ status: 'active' }])
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Resuming goal…')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityState.busy, true)
  value = runtime({ ...value.goal!, status: 'active' })
  await act(async () => pending.resolve({ goal: value.goal, time_budget_seconds: 600 }))
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Pause goal')
})

test('authoritative activation reconciles a lost Resume reply without hiding a later runtime error', async () => {
  let value = runtime({ ...goal, status: 'paused' })
  let readError: Error | null = null
  const pending = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  setTestClient({ codexRuntime: async () => { if (readError) throw readError; return value }, setCodexGoal: async (_id, input) => {
    inputs.push(input)
    if (inputs.length === 1) return pending.promise
    value = runtime({ ...goal, status: 'paused' })
    return { goal: value.goal, time_budget_seconds: 600 }
  } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await press(tree, 'codex-goal-toggle')
  value = runtime({ ...goal, status: 'active' })
  await act(async () => pending.reject(new Error('Goal response disconnected')))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Pause goal')
  assert.equal(nodes(tree, 'codex-goal-error').length, 0)
  readError = new Error('Runtime unreachable')
  await act(async () => { await context.refresh() })
  assert.equal(contents(node(tree, 'codex-goal-error')), 'Runtime unreachable')
  readError = null
  await press(tree, 'codex-goal-toggle')
  assert.deepEqual(inputs, [{ status: 'active' }, { status: 'paused' }])
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
  assert.equal(nodes(tree, 'codex-goal-error').length, 0)
})

test('a replaced or cleared goal retires only the old goal status failure', async () => {
  for (const replacement of [
    { ...goal, status: 'paused' as const, threadId: 'replacement-thread' },
    { ...goal, status: 'paused' as const, createdAt: 42 },
    { ...goal, status: 'paused' as const, objective: 'Replacement objective' },
    null,
  ]) {
    let value = runtime({ ...goal, status: 'paused' })
    setTestClient({ codexRuntime: async () => value, setCodexGoal: async () => { throw new Error('Old goal failed to resume') } })
    const tree = await mount()
    await press(tree, 'codex-goal-details')
    await press(tree, 'codex-goal-toggle')
    assert.match(context.error ?? '', /Old goal failed/)
    value = { ...runtime(null), available: false }
    await act(async () => { await context.refresh() })
    assert.match(context.error ?? '', /Old goal failed/, 'an unavailable runtime cannot prove the goal was cleared')
    value = runtime(replacement)
    await act(async () => { await context.refresh() })
    assert.equal(context.error, null)
    assert.equal(nodes(tree, 'codex-goal-error').length, 0)
    value = runtime({ ...goal, status: 'paused' })
    await act(async () => { await context.refresh() })
    assert.equal(context.error, null, 'a retired error must not return if the former objective is restored')
    await act(async () => tree.unmount())
    mounted.splice(mounted.indexOf(tree), 1)
  }
})

test('goal replacement preserves unrelated operation failures and subsequent refresh failures', async () => {
  let value = runtime()
  let readError: Error | null = null
  setTestClient({ codexRuntime: async () => { if (readError) throw readError; return value } })
  const tree = await mount()
  await act(async () => {
    await assert.rejects(context.run(async () => { throw new Error('Thread control failed') }), /Thread control failed/)
  })
  value = runtime({ ...goal, objective: 'Replacement goal', createdAt: 42 })
  await act(async () => { await context.refresh() })
  assert.equal(context.error, 'Thread control failed')
  value = runtime(null)
  await act(async () => { await context.refresh() })
  assert.equal(context.error, 'Thread control failed')
  await act(async () => { await context.run(async () => undefined) })
  readError = new Error('Runtime refresh failed')
  await act(async () => { await context.refresh() })
  assert.equal(context.error, 'Runtime refresh failed')
  assert.equal(nodes(tree, 'codex-goal-bar').length, 0)
})

test('captured goal toggle callbacks cannot mutate a replacement goal or a newer scope', async () => {
  for (const replacement of [
    { ...goal, status: 'paused' as const, threadId: 'replacement-thread' },
    { ...goal, status: 'paused' as const, createdAt: 42 },
    { ...goal, status: 'paused' as const, objective: 'Replacement objective' },
    { ...goal, status: 'active' as const },
    null,
  ]) {
    let value = runtime({ ...goal, status: 'paused' })
    let writes = 0
    setTestClient({ codexRuntime: async () => value, setCodexGoal: async () => { writes++; return { goal: value.goal, time_budget_seconds: 600 } } })
    const tree = await mount()
    await press(tree, 'codex-goal-details')
    const stale = node(tree, 'codex-goal-toggle').props.onPress
    value = runtime(replacement)
    await act(async () => { await context.refresh() })
    await act(async () => stale())
    assert.equal(writes, 0)
    if (replacement) {
      const previousScope = node(tree, 'codex-goal-toggle').props.onPress
      await act(async () => useAppStore.setState({ profileGeneration: useAppStore.getState().profileGeneration + 1 }))
      await act(async () => previousScope())
      assert.equal(writes, 0)
      await press(tree, 'codex-goal-details')
      await press(tree, 'codex-goal-toggle')
      assert.equal(writes, 1, 'the current goal control remains usable')
    }
    await act(async () => tree.unmount())
    mounted.splice(mounted.indexOf(tree), 1)
  }
})

test('an exhausted paused goal delegates Resume to the server and shows its refusal without resetting budgets', async () => {
  const value = { ...runtime({ ...goal, status: 'paused', tokensUsed: 1000 }), time_budget_seconds: 20, time_budget_exhausted: true }
  const inputs: CodexGoalInput[] = []
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => { inputs.push(input); throw new Error('Increase the time budget to continue') } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, false)
  await press(tree, 'codex-goal-toggle')
  assert.deepEqual(inputs, [{ status: 'active' }])
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
  assert.equal(contents(node(tree, 'codex-goal-error')), 'Could not resume goal: Increase the time budget to continue')
  assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Retry resume goal')
  assert.equal(context.runtime?.time_budget_seconds, 20)
  assert.equal(context.runtime?.goal?.tokensUsed, 1000)
})

test('inactive goal status distinguishes ordinary live messages without resuming or advancing goal time', async () => {
  let value = runtime({ ...goal, status: 'paused' })
  let writes = 0
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async () => { writes++; return { goal, time_budget_seconds: 600 } } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  for (const threadStatus of ['idle', 'active'] as const) {
    for (const [status, label] of [['paused', 'Goal paused'], ['blocked', 'Goal blocked'], ['complete', 'Goal complete'], ['budgetLimited', 'Budget limited']] as const) {
      value = { ...runtime({ ...goal, status }), status: threadStatus === 'active' ? { type: 'active', activeFlags: [] } : { type: 'idle' } }
      await act(async () => { useAppStore.setState({ activeSessionIds: new Set(['chat-a']) }); await context.refresh() })
      assert.equal(contents(node(tree, 'codex-goal-state')), `${label} · Message running`)
      assert.match(contents(node(tree, 'codex-goal-progress')), /^20s \/ 10m elapsed/)
      if (status === 'paused') assert.equal(node(tree, 'codex-goal-toggle').props.accessibilityLabel, 'Resume goal')
      else assert.equal(nodes(tree, 'codex-goal-toggle').length, 0)
      await act(async () => useAppStore.setState({ activeSessionIds: new Set() }))
      assert.equal(contents(node(tree, 'codex-goal-state')), label)
    }
  }
  assert.equal(writes, 0)
})

test('complete and budget-limited goals can explicitly start a new objective through Edit without an implicit reset', async () => {
  for (const status of ['complete', 'budgetLimited'] as const) {
    let value = runtime({ ...goal, status })
    const inputs: CodexGoalInput[] = []
    setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => {
      inputs.push(input)
      value = { ...runtime({ ...goal, objective: input.objective!, status: input.status!, tokenBudget: input.token_budget!, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 3 }), time_budget_seconds: input.time_budget_seconds! }
      return { goal: value.goal, time_budget_seconds: value.time_budget_seconds }
    } })
    const tree = await mount()
    await press(tree, 'codex-goal-details')
    await press(tree, 'codex-goal-edit')
    await change(tree, 'codex-goal-objective-input', `Next ${status} objective`)
    await press(tree, 'codex-goal-status')
    await press(tree, 'codex-goal-status-active')
    await change(tree, 'codex-goal-token-budget', '2000')
    await change(tree, 'codex-goal-time-budget', '900')
    assert.equal(inputs.length, 0)
    assert.equal(context.runtime?.goal?.objective, goal.objective)
    assert.equal(context.runtime?.goal?.status, status)
    await press(tree, 'codex-goal-save')
    assert.deepEqual(inputs, [{ objective: `Next ${status} objective`, status: 'active', token_budget: 2000, time_budget_seconds: 900 }])
    assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal')
    assert.equal(node(tree, 'codex-goal-objective-input').props.value, `Next ${status} objective`)
    assert.equal(context.runtime?.goal?.tokensUsed, 0)
    await act(async () => tree.unmount())
    mounted.splice(mounted.indexOf(tree), 1)
  }
})

test('confirmed editor Clear resets the form so a new goal starts with explicitly saved budgets', async () => {
  let value = runtime({ ...goal, status: 'complete' })
  const inputs: CodexGoalInput[] = []
  let clears = 0
  setTestClient({ codexRuntime: async () => value, clearCodexGoal: async () => {
    clears++
    value = { ...runtime(null), time_budget_seconds: null }
    return { goal: null, time_budget_seconds: null }
  }, setCodexGoal: async (_id, input) => {
    inputs.push(input)
    value = { ...runtime({ ...goal, objective: input.objective!, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 3 }), time_budget_seconds: null }
    return { goal: value.goal, time_budget_seconds: null }
  } })
  const tree = await mount('editor')
  await press(tree, 'codex-goal-editor-clear')
  assert.equal(clears, 0)
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'cancel')?.onPress?.())
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, goal.objective)
  await press(tree, 'codex-goal-editor-clear')
  await act(async () => Alert.__calls[1].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 1)
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, '')
  assert.equal(node(tree, 'codex-goal-token-budget').props.value, '')
  assert.equal(node(tree, 'codex-goal-time-budget').props.value, '')
  assert.equal(node(tree, 'codex-goal-status').props.accessibilityLabel, 'Goal status: Pursuing goal')
  await change(tree, 'codex-goal-objective-input', 'A fresh objective')
  await press(tree, 'codex-goal-save')
  assert.deepEqual(inputs, [{ objective: 'A fresh objective', status: 'active', token_budget: null, time_budget_seconds: null }])
})

test('goal drafts survive polling and newer edits survive a pending save', async () => {
  let value = runtime({ ...goal, status: 'paused' })
  const saved = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async (_id, input) => { inputs.push(input); return saved.promise } })
  const tree = await mount('editor')
  await change(tree, 'codex-goal-objective-input', 'Draft objective')
  await change(tree, 'codex-goal-token-budget', '2400')
  await change(tree, 'codex-goal-time-budget', '900')
  value = runtime({ ...goal, status: 'paused', objective: 'Another device update', tokensUsed: 180, updatedAt: 5 })
  await act(async () => { await context.refresh() })
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, 'Draft objective')
  assert.equal(node(tree, 'codex-goal-token-budget').props.value, '2400')
  const tap = node(tree, 'codex-goal-save').props.onPress
  await act(async () => { tap(); tap() })
  assert.deepEqual(inputs, [{ objective: 'Draft objective', status: 'paused', token_budget: 2400, time_budget_seconds: 900 }])
  await change(tree, 'codex-goal-objective-input', 'Newer unsaved objective')
  value = { ...runtime({ ...goal, objective: 'Draft objective', status: 'paused', tokenBudget: 2400 }), time_budget_seconds: 900 }
  await act(async () => saved.resolve({ goal: value.goal, time_budget_seconds: 900 }))
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, 'Newer unsaved objective')
  assert.match(contents(node(tree, 'codex-goal-feedback')), /newer edits are still unsaved/)
})

test('initial runtime loading cannot turn unknown budgets into an editable empty draft', async () => {
  const read = deferred<CodexRuntimeSnapshot>()
  setTestClient({ codexRuntime: () => read.promise })
  const tree = await mount('editor')
  assert.equal(node(tree, 'codex-goal-objective-input').props.editable, false)
  assert.equal(node(tree, 'codex-goal-time-budget').props.editable, false)
  await change(tree, 'codex-goal-objective-input', 'Premature draft')
  await act(async () => read.resolve(runtime({ ...goal, status: 'paused' })))
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, goal.objective)
  assert.equal(node(tree, 'codex-goal-time-budget').props.value, '600')
  assert.equal(node(tree, 'codex-goal-objective-input').props.editable, true)
})

test('invalid budgets and failed saves are visible without clearing the draft', async () => {
  let writes = 0
  setTestClient({ codexRuntime: async () => runtime(), setCodexGoal: async () => { writes++; throw new Error('Server refused this goal') } })
  const tree = await mount('editor')
  await change(tree, 'codex-goal-token-budget', '1.5')
  await press(tree, 'codex-goal-save')
  assert.match(contents(node(tree, 'codex-goal-save-error')), /positive whole number/)
  assert.equal(writes, 0)
  await change(tree, 'codex-goal-token-budget', '2000')
  await press(tree, 'codex-goal-save')
  assert.equal(writes, 1)
  assert.match(contents(node(tree, 'codex-goal-save-error')), /Server refused this goal/)
  await act(async () => { await context.refresh() })
  assert.match(contents(node(tree, 'codex-goal-save-error')), /Server refused this goal/)
  assert.equal(node(tree, 'codex-goal-token-budget').props.value, '2000')
})

test('server configuration immediately disables actions and ignores other server scopes', async () => {
  const read = deferred<CodexRuntimeSnapshot>()
  let reads = 0
  let writes = 0
  setTestClient({ codexRuntime: () => ++reads === 1 ? Promise.resolve(runtime()) : read.promise, setCodexGoal: async () => { writes++; return { goal, time_budget_seconds: 600 } } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await act(async () => announceCodexGoalsConfigurationChanged('another-profile', 1, false))
  assert.equal(nodes(tree, 'codex-goal-toggle').length, 1)
  await act(async () => announceCodexGoalsConfigurationChanged('profile-a', 1, false))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal · Goals disabled')
  assert.equal(nodes(tree, 'codex-goal-toggle').length, 0)
  await act(async () => { await assert.rejects(context.updateGoal({ status: 'active' }), /disabled on this server/) })
  assert.equal(writes, 0)
  await act(async () => read.resolve({ ...runtime(), goals_enabled: false }))
})

test('goal writes reject stale callbacks and pending server switches', async () => {
  let writes = 0
  setTestClient({ codexRuntime: async () => runtime(), setCodexGoal: async () => { writes++; return { goal, time_budget_seconds: 600 } } })
  await mount()
  const update = context.updateGoal
  await act(async () => useAppStore.setState({ switchingProfileId: 'profile-b' }))
  await act(async () => { await assert.rejects(update({ status: 'paused' }), /selected server or Codex chat changed/) })
  assert.equal(writes, 0)
  await act(async () => useAppStore.setState({ switchingProfileId: null, activeProfileId: 'profile-b', profileGeneration: 2 }))
  await act(async () => { await assert.rejects(update({ status: 'paused' }), /selected server or Codex chat changed/) })
  assert.equal(writes, 0)
})

test('late goal mutation results cannot replace the newly selected server snapshot', async () => {
  const save = deferred<CodexGoalSnapshot>()
  setTestClient({ codexRuntime: async () => runtime(), setCodexGoal: () => save.promise })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await press(tree, 'codex-goal-toggle')
  const otherGoal = { ...goal, objective: 'Other server goal', status: 'blocked' as const }
  await act(async () => { setTestClient({ codexRuntime: async () => runtime(otherGoal) }); useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2 }) })
  await act(async () => save.resolve({ goal: { ...goal, status: 'paused' }, time_budget_seconds: 600 }))
  assert.equal(contents(node(tree, 'codex-goal-objective')), 'Other server goal')
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal blocked')
})

test('Clear confirmation cannot delete a replacement goal or another selected server goal', async () => {
  let value = runtime()
  let clears = 0
  setTestClient({ codexRuntime: async () => value, clearCodexGoal: async () => { clears++; return { goal: null, time_budget_seconds: null } } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await press(tree, 'codex-goal-clear')
  value = runtime({ ...goal, objective: 'Replacement goal', createdAt: 100 })
  await act(async () => { await context.refresh() })
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 0)
  assert.match(contents(node(tree, 'codex-goal-error')), /goal changed/)
  await act(async () => { await assert.rejects(context.clearGoal(goal), /goal changed/) })
  assert.equal(clears, 0)
  await press(tree, 'codex-goal-clear')
  await act(async () => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2 }))
  await act(async () => Alert.__calls[1].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 0)
})

test('blocked, budget-limited and complete goals show honest states without a resume shortcut', async () => {
  let value = runtime({ ...goal, status: 'blocked' })
  setTestClient({ codexRuntime: async () => value })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  for (const [status, label] of [['blocked', 'Goal blocked'], ['budgetLimited', 'Budget limited'], ['complete', 'Goal complete']] as const) {
    value = runtime({ ...goal, status })
    await act(async () => { await context.refresh() })
    assert.equal(contents(node(tree, 'codex-goal-state')), label)
    assert.equal(nodes(tree, 'codex-goal-toggle').length, 0)
    assert.equal(nodes(tree, 'codex-goal-edit').length, 1)
  }
  value = { ...runtime({ ...goal, status: 'paused' }), time_budget_seconds: 20 }
  await act(async () => { await context.refresh() })
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, false)
})

test('lifecycle Running overrides an idle provider snapshot and opening controls refreshes runtime', async () => {
  let reads = 0
  setTestClient({ codexRuntime: async () => { reads++; return runtime() }, codexPermissionProfiles: async () => [] })
  useAppStore.setState({ activeSessionIds: new Set(['chat-a']) })
  const tree = await mount('status')
  assert.equal(node(tree, 'codex-status').props.accessibilityLabel, 'Codex controls: Running')
  const before = reads
  await press(tree, 'codex-status')
  assert.ok(reads > before)
})

test('direct Edit opens the goal editor and refreshes the current chat', async () => {
  let reads = 0
  setTestClient({ codexRuntime: async () => { reads++; return runtime({ ...goal, status: 'paused' }) } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  const before = reads
  await press(tree, 'codex-goal-edit')
  assert.equal(nodes(tree, 'codex-goal-editor').length, 1)
  assert.ok(reads > before)
  assert.equal(node(tree, 'codex-goal-objective-input').props.value, goal.objective)
  assert.equal(node(tree, 'codex-goal-status').props.accessibilityLabel, 'Goal status: Goal paused')
})

test('explicitly unsupported goals stay read-only and unavailable runtime actions stay disabled', async () => {
  let value = runtime()
  let writes = 0
  setTestClient({ codexRuntime: async () => value, setCodexGoal: async () => { writes++; return { goal, time_budget_seconds: 600 } } })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await act(async () => useAppStore.setState({ health: { ...health, capabilities: { codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1', features: { goals: false } } } } as Health }))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Pursuing goal · Goals unavailable')
  assert.equal(nodes(tree, 'codex-goal-toggle').length, 0)
  await act(async () => { await assert.rejects(context.updateGoal({ status: 'active' }), /unavailable/) })
  assert.equal(writes, 0)
  await act(async () => useAppStore.setState({ health }))
  value = { ...runtime(), available: false }
  await act(async () => { await context.refresh() })
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, true)
  assert.equal(node(tree, 'codex-goal-edit').props.disabled, true)
})

test('a late pre-reconnect failure cannot clear a newer mutation or report a stale error', async () => {
  const first = deferred<CodexGoalSnapshot>()
  const second = deferred<CodexGoalSnapshot>()
  let writes = 0
  setTestClient({ codexRuntime: async () => runtime(), setCodexGoal: () => ++writes === 1 ? first.promise : second.promise })
  const tree = await mount()
  await press(tree, 'codex-goal-details')
  await press(tree, 'codex-goal-toggle')
  await act(async () => useAppStore.setState({ connected: false }))
  await act(async () => useAppStore.setState({ connected: true }))
  await press(tree, 'codex-goal-toggle')
  assert.equal(writes, 2)
  await act(async () => first.reject(new Error('Late failure from the previous connection')))
  assert.equal(context.mutating, true)
  assert.equal(nodes(tree, 'codex-goal-error').length, 0)
  await act(async () => second.resolve({ goal: { ...goal, status: 'paused' }, time_budget_seconds: 600 }))
})

test('a lifecycle start does not count the preceding idle interval as goal time', async () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const tree = await mount()
    await press(tree, 'codex-goal-details')
    assert.match(contents(node(tree, 'codex-goal-progress')), /^20s \/ 10m elapsed/)
    now += 120_000
    await act(async () => useAppStore.setState({ activeSessionIds: new Set(['chat-a']) }))
    assert.match(contents(node(tree, 'codex-goal-progress')), /^20s \/ 10m elapsed/)
  } finally {
    Date.now = originalNow
  }
})
