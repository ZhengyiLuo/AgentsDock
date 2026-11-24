import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { AppTypographyProvider } from '../src/components/AppText'
import { SideChatSheetView } from '../src/components/SideChatSheet'
import type { useSideChat } from '../src/hooks/useSideChat'
import type { SyncedSideChat } from '../src/lib/side-chat'
import { useAppearanceStore } from '../src/store/useAppearanceStore'
import { useLanguageStore } from '../src/store/useLanguageStore'
import { dark, light } from '../src/theme'
import { resetComponentStore } from './component-mocks/app-store'
import { Alert, Keyboard, StyleSheet } from './component-mocks/react-native'
import { KeyboardController } from './component-mocks/native-wrappers'

type State = ReturnType<typeof useSideChat>
type Exchange = SyncedSideChat['exchanges'][number]
const snapshot: SyncedSideChat = { session_id: 'chat-a', side_chat_id: 'side-a', revision: 0, last_request_id: null, exchanges: [] }
const completed: Exchange = { request_id: 'request-a', question: 'What did the tool return?', answer: 'The tool returned a result.', status: 'completed', created_at: '', updated_at: '' }
const running: Exchange = { ...completed, answer: undefined, status: 'running' }
let state: State
let refreshes = 0
let clears = 0
let closes = 0
let questions: string[] = []
let stops: string[] = []
let fontScale = 1
let questionLimit = 512 * 1024
const mounted: ReactTestRenderer[] = []
function content(onClose = () => { closes++ }) { return <AppTypographyProvider><SideChatSheetView state={state} title="Disposable chat" fontScale={fontScale} questionLimit={questionLimit} onClose={onClose} /></AppTypographyProvider> }
async function mount(options: { onClose?: () => void; onBlur?: () => void } = {}) {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(content(options.onClose), { createNodeMock: element => element.type === 'TextInput' ? { blur: () => options.onBlur?.() } : null })
  })
  mounted.push(tree)
  return tree
}
async function update(tree: ReactTestRenderer, changes: Partial<State>) { state = { ...state, ...changes }; await act(async () => { tree.update(content()) }) }
function nodes(tree: ReactTestRenderer, id: string) { return tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === id) }
function node(tree: ReactTestRenderer, id: string) { const found = nodes(tree, id); assert.equal(found.length, 1, `Expected one ${id}`); return found[0] }
async function press(tree: ReactTestRenderer, id: string) { const target = node(tree, id); assert.notEqual(target.props.disabled, true, `${id} is disabled`); await act(async () => { target.props.onPress() }) }
async function type(tree: ReactTestRenderer, value: string) { await act(async () => { node(tree, 'side-chat-question').props.onChangeText(value) }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

beforeEach(() => {
  refreshes = 0; clears = 0; closes = 0; questions = []; stops = []; fontScale = 1; questionLimit = 512 * 1024
  Alert.__reset()
  resetComponentStore({ fontScale: 1 })
  useLanguageStore.setState({ locale: 'en' })
  useAppearanceStore.setState({ preference: 'dark' })
  state = { supported: true, available: true, offline: false, loading: false, mutating: false, error: null, snapshot,
    refresh: async () => { refreshes++ }, submit: async question => { questions.push(question); return true }, stop: async id => { stops.push(id) }, clear: async () => { clears++ } }
})
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => { tree.unmount() }) })

test('empty panel is explicit about native context; typing invokes no network action', async () => {
  const tree = await mount()
  assert.equal(nodes(tree, 'side-chat-empty').length, 1)
  assert.equal(node(tree, 'side-chat-send').props.disabled, true)
  assert.equal(node(tree, 'side-chat-clear').props.disabled, true)
  await type(tree, 'A side question')
  assert.equal(node(tree, 'side-chat-send').props.disabled, false)
  assert.equal(refreshes, 0); assert.deepEqual(questions, []); assert.deepEqual(stops, []); assert.equal(clears, 0)
  assert.equal(tree.root.findAllByType('KeyboardAvoidingView')[0].props.automaticOffset, true)
  assert.equal(node(tree, 'side-chat-scroll').props.keyboardShouldPersistTaps, 'handled')
  assert.match(JSON.stringify(tree.toJSON()), /Side replies may use tools in the same workspace/)
})

test('failed acceptance retains the draft, accepted submission clears it and double taps are single-flight', async () => {
  state.submit = async question => { questions.push(question); return false }
  const tree = await mount()
  await type(tree, '  retained question  ')
  await press(tree, 'side-chat-send')
  assert.equal(node(tree, 'side-chat-question').props.value, '  retained question  ')
  const accepted = deferred<boolean>()
  await update(tree, { submit: async question => { questions.push(question); return accepted.promise } })
  const tap = node(tree, 'side-chat-send').props.onPress
  await act(async () => { tap(); tap() })
  assert.deepEqual(questions, ['retained question', 'retained question'])
  assert.equal(node(tree, 'side-chat-send').props.disabled, true)
  await act(async () => accepted.resolve(true))
  assert.equal(node(tree, 'side-chat-question').props.value, '')
})

test('a newer draft survives accepting an earlier request', async () => {
  const accepted = deferred<boolean>()
  state.submit = async () => accepted.promise
  const tree = await mount()
  await type(tree, 'First question')
  await press(tree, 'side-chat-send')
  await type(tree, 'Next question')
  await act(async () => accepted.resolve(true))
  assert.equal(node(tree, 'side-chat-question').props.value, 'Next question')
})

test('running reply exposes request-specific Stop, blocks Clear/Send, and close never cancels', async () => {
  state.snapshot = { ...snapshot, exchanges: [running] }
  const tree = await mount()
  await type(tree, 'Ready for a follow-up')
  assert.equal(node(tree, 'side-chat-send').props.disabled, true)
  assert.equal(node(tree, 'side-chat-clear').props.disabled, true)
  await press(tree, 'side-chat-stop')
  assert.deepEqual(stops, ['request-a'])
  await press(tree, 'side-chat-close')
  assert.equal(closes, 1)
  assert.deepEqual(stops, ['request-a'])
  assert.equal(clears, 0)
  await act(async () => tree.root.findByType('Modal').props.onRequestClose())
  assert.equal(closes, 1)
  assert.deepEqual(stops, ['request-a'])
})

for (const action of ['button', 'native-request', 'accessibility-escape'] as const) {
  test(`${action} close blurs and dismisses before unmount, with no late dismissal or cancellation`, async context => {
    state.snapshot = { ...snapshot, exchanges: [running] }
    const events: string[] = []
    context.mock.method(Keyboard, 'dismiss', () => { events.push('rn-dismiss') })
    context.mock.method(KeyboardController, 'dismiss', async () => { events.push('controller-dismiss') })
    context.mock.method(globalThis, 'requestAnimationFrame', () => { events.push('animation-frame'); return 0 })
    const tree = await mount({ onBlur: () => { events.push('input-blur') }, onClose: () => { events.push('close') } })
    await type(tree, 'Unsent side draft')
    const close = action === 'button' ? node(tree, 'side-chat-close').props.onPress
      : action === 'native-request' ? tree.root.findByType('Modal').props.onRequestClose
        : node(tree, 'side-chat-sheet').props.onAccessibilityEscape
    await act(async () => { close(); close() })
    assert.deepEqual(events, ['input-blur', 'rn-dismiss', 'controller-dismiss', 'close'])
    assert.deepEqual(questions, [])
    assert.deepEqual(stops, [])
    assert.equal(clears, 0)
  })
}

test('clearing requires explicit confirmation and ignores duplicate/stale confirmation callbacks', async () => {
  state.snapshot = { ...snapshot, exchanges: [completed] }
  const tree = await mount()
  await press(tree, 'side-chat-clear')
  await press(tree, 'side-chat-clear')
  assert.equal(Alert.__calls.length, 1); assert.equal(clears, 0)
  assert.match(Alert.__calls[0].message ?? '', /all connected devices/)
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'cancel')?.onPress?.())
  assert.equal(clears, 0)
  await press(tree, 'side-chat-clear')
  const confirm = Alert.__calls[1].buttons?.find(button => button.style === 'destructive')?.onPress
  await act(async () => { confirm?.(); confirm?.() })
  assert.equal(clears, 1)
  await press(tree, 'side-chat-clear')
  await update(tree, { snapshot: { ...snapshot, side_chat_id: 'side-new', exchanges: [completed] } })
  await act(async () => Alert.__calls[2].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 1)
})

test('a clear confirmation cannot mutate after the sheet unmounts', async () => {
  state.snapshot = { ...snapshot, exchanges: [completed] }
  const tree = await mount()
  await press(tree, 'side-chat-clear')
  await act(async () => tree.unmount())
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 0)
})

test('new replies arriving after Clear confirmation require a fresh review', async () => {
  state.snapshot = { ...snapshot, exchanges: [completed] }
  const tree = await mount()
  await press(tree, 'side-chat-clear')
  await update(tree, { snapshot: { ...snapshot, revision: 1, exchanges: [completed, { ...completed, request_id: 'new-reply' }] } })
  await act(async () => Alert.__calls[0].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(clears, 0)
  assert.equal(Alert.__calls[1].title, 'Side chat changed')
})

test('offline/unsupported states disable requests and reconnection can restore controls', async () => {
  state.available = false; state.offline = true; state.snapshot = { ...snapshot, exchanges: [running] }
  const tree = await mount()
  assert.equal(nodes(tree, 'side-chat-offline').length, 1)
  for (const id of ['side-chat-send', 'side-chat-clear', 'side-chat-refresh', 'side-chat-stop']) assert.equal(node(tree, id).props.disabled, true)
  assert.equal(node(tree, 'side-chat-question').props.editable, false)
  await update(tree, { supported: false, offline: false })
  assert.equal(nodes(tree, 'side-chat-unsupported').length, 1)
  await update(tree, { supported: true, available: true, offline: false, snapshot })
  assert.equal(node(tree, 'side-chat-question').props.editable, true)
  await type(tree, 'Connected again')
  assert.equal(node(tree, 'side-chat-send').props.disabled, false)
})

test('health loss keeps the draft in the already-open sheet and shows offline, not unsupported', async () => {
  const tree = await mount()
  await type(tree, 'Keep my unsent question')
  await update(tree, { supported: false, available: false, offline: true, snapshot: null })
  assert.equal(nodes(tree, 'side-chat-offline').length, 1)
  assert.equal(nodes(tree, 'side-chat-unsupported').length, 0)
  assert.equal(node(tree, 'side-chat-question').props.value, 'Keep my unsent question')
  assert.equal(node(tree, 'side-chat-send').props.disabled, true)
  await update(tree, { supported: true, available: true, offline: false, snapshot })
  assert.equal(node(tree, 'side-chat-question').props.value, 'Keep my unsent question')
  assert.equal(node(tree, 'side-chat-send').props.disabled, false)
  assert.deepEqual(questions, [])
})

test('error retry only reloads and never silently resends a mutation', async () => {
  state.error = 'Connection interrupted'
  const tree = await mount()
  await type(tree, 'Keep this question')
  await press(tree, 'side-chat-retry')
  assert.equal(refreshes, 1); assert.deepEqual(questions, [])
  assert.equal(node(tree, 'side-chat-question').props.value, 'Keep this question')
  assert.match(JSON.stringify(tree.toJSON()), /does not resend your question/)
})

test('a failed reply can restore its question for explicit review and Send', async () => {
  state.snapshot = { ...snapshot, exchanges: [{ ...completed, status: 'failed', answer: undefined, error: 'Provider disconnected' }] }
  const tree = await mount()
  await press(tree, 'side-chat-reuse-request-a')
  assert.equal(node(tree, 'side-chat-question').props.value, completed.question)
  assert.equal(nodes(tree, 'side-chat-reuse-request-a').length, 0)
  assert.deepEqual(questions, [])
  await press(tree, 'side-chat-send')
  assert.deepEqual(questions, [completed.question])
})

test('native activity preserves chronology, retained details and one final answer', async () => {
  fontScale = 1.4
  state.snapshot = { ...snapshot, exchanges: [{ ...completed, answer: 'Final answer', activity: [
    { id: 'thought-a', kind: 'reasoning_summary', text: 'Inspecting tool context', status: 'completed' },
    { id: 'commentary-a', kind: 'commentary', text: 'I found the tool output.', status: 'completed' },
    { id: 'tool-a', kind: 'tool', text: 'Read canary.txt', status: 'completed' },
    { id: 'answer-a', kind: 'answer', text: 'Final answer', status: 'completed' },
  ] }] }
  const tree = await mount()
  const markdown = () => tree.root.findAllByType('MarkdownContent')
  assert.deepEqual(markdown().map(value => value.props.value), ['I found the tool output.', 'Final answer'])
  await press(tree, 'side-chat-activity-thought-a')
  assert.deepEqual(markdown().map(value => value.props.value), ['Inspecting tool context', 'I found the tool output.', 'Final answer'])
  assert.ok(markdown().every(value => value.props.fontScale === 1.4))
  await press(tree, 'side-chat-activity-tool-a')
  assert.match(JSON.stringify(tree.toJSON()), /Read canary.txt/)
  await update(tree, { snapshot: { ...snapshot, exchanges: [{ ...completed, answer: 'Authoritative final', activity: [{ id: 'partial', kind: 'answer', text: 'Partial', status: 'completed' }] }] } })
  assert.deepEqual(markdown().map(value => value.props.value), ['Authoritative final'])
})

test('question limits count Unicode code points and never truncate surrogate pairs', async () => {
  questionLimit = 2
  const tree = await mount()
  await type(tree, '🧪🧪')
  assert.equal(node(tree, 'side-chat-question').props.maxLength, undefined)
  assert.equal(node(tree, 'side-chat-send').props.disabled, false)
  await type(tree, '🧪🧪🧪')
  assert.equal(node(tree, 'side-chat-send').props.disabled, true)
  assert.equal(nodes(tree, 'side-chat-limit').length, 1)
  assert.equal(node(tree, 'side-chat-question').props.value, '🧪🧪🧪')
})

test('shared typography, palette and Chinese labels remain wired to the production presentation', async () => {
  resetComponentStore({ fontScale: 1.4 })
  useLanguageStore.setState({ locale: 'zh-CN' })
  useAppearanceStore.setState({ preference: 'light' })
  const tree = await mount()
  assert.equal(node(tree, 'side-chat-send').props.accessibilityLabel, '发送侧边问题')
  assert.equal(node(tree, 'side-chat-question').props.accessibilityLabel, '侧边对话问题')
  assert.equal(StyleSheet.flatten(node(tree, 'side-chat-sheet').props.style)?.backgroundColor, light.background)
  assert.equal(StyleSheet.flatten(node(tree, 'side-chat-question').props.style)?.fontSize, 21)
  assert.ok(Number(StyleSheet.flatten(node(tree, 'side-chat-question').props.style)?.minHeight) >= 44)
  await act(async () => useAppearanceStore.setState({ preference: 'dark' }))
  assert.equal(StyleSheet.flatten(node(tree, 'side-chat-sheet').props.style)?.backgroundColor, dark.background)
})
