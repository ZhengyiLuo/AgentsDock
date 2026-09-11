import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { create, act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { CodexGoalBar, CodexGoalEditor } from '../src/components/CodexGoalBar'
import { CodexStatusButton } from '../src/components/CodexControls'
import { CodexRuntimeProvider, useCodexRuntime } from '../src/components/CodexRuntimeContext'
import { announceCodexGoalsConfigurationChanged } from '../src/lib/codex-goals-configuration'
import type { CodexGoal, CodexGoalInput, CodexGoalSnapshot, CodexRuntimeSnapshot, Health, Session } from '../src/types'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { Alert } from './component-mocks/react-native'

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
async function mount(content: 'bar' | 'editor' | 'status' = 'bar') {
  let tree!: ReactTestRenderer
  await act(async () => { tree = create(<CodexRuntimeProvider sessionId="chat-a"><Probe />{content === 'bar' ? <CodexGoalBar /> : content === 'editor' ? <CodexGoalEditor /> : <CodexStatusButton compact={false} />}</CodexRuntimeProvider>) })
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

test('Pause is single-flight and applies the returned snapshot before stale refreshes settle', async () => {
  const staleRead = deferred<CodexRuntimeSnapshot>()
  const freshRead = deferred<CodexRuntimeSnapshot>()
  const save = deferred<CodexGoalSnapshot>()
  const inputs: CodexGoalInput[] = []
  let reads = 0
  setTestClient({ codexRuntime: () => ++reads === 1 ? Promise.resolve(runtime()) : reads === 2 ? staleRead.promise : freshRead.promise, setCodexGoal: async (id, input) => { assert.equal(id, 'chat-a'); inputs.push(input); return save.promise } })
  const tree = await mount()
  await act(async () => { void context.refresh() })
  const tap = node(tree, 'codex-goal-toggle').props.onPress
  await act(async () => { tap(); tap() })
  assert.deepEqual(inputs, [{ status: 'paused' }])
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, true)
  const paused = { ...goal, status: 'paused' as const, updatedAt: 3 }
  await act(async () => save.resolve({ goal: paused, time_budget_seconds: 600 }))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goal paused')
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
  await act(async () => announceCodexGoalsConfigurationChanged('another-profile', 1, false))
  assert.equal(nodes(tree, 'codex-goal-toggle').length, 1)
  await act(async () => announceCodexGoalsConfigurationChanged('profile-a', 1, false))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goals disabled')
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
  assert.equal(node(tree, 'codex-goal-toggle').props.disabled, true)
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
  await act(async () => useAppStore.setState({ health: { ...health, capabilities: { codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1', features: { goals: false } } } } as Health }))
  assert.equal(contents(node(tree, 'codex-goal-state')), 'Goals unavailable')
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
    assert.match(contents(node(tree, 'codex-goal-progress')), /^20s \/ 10m elapsed/)
    now += 120_000
    await act(async () => useAppStore.setState({ activeSessionIds: new Set(['chat-a']) }))
    assert.match(contents(node(tree, 'codex-goal-progress')), /^20s \/ 10m elapsed/)
  } finally {
    Date.now = originalNow
  }
})
