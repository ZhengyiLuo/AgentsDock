import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { create } from 'zustand'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const store = create(() => ({}))
const preferences = create(() => ({ preference: 'compact' }))
globalThis.__reasoningTrace = { store, preferences, renderedMarkdown: [] }
const icons = ['AlertTriangle', 'Check', 'ChevronDown', 'ChevronRight', 'Clock3', 'Code2', 'Copy', 'History', 'Pin', 'Siren', 'Sparkles', 'Wrench', 'X']
const mocks = {
  'react-native': `export const View='View',Text='Text',TextInput='TextInput',Pressable='Pressable',ActivityIndicator='ActivityIndicator',ScrollView='ScrollView';export const StyleSheet={create:x=>x,flatten:value=>Object.assign({},...[value].flat(Infinity).filter(Boolean)),hairlineWidth:1};export const AccessibilityInfo={announceForAccessibility(){}}`,
  '@shopify/flash-list': `import {useEffect,useState} from 'react';export function useRecyclingState(initial,deps){const [value,setValue]=useState(initial);useEffect(()=>setValue(initial),deps);return [value,setValue]}`,
  'lucide-react-native': icons.map(name => `export const ${name}='${name}'`).join(';'),
  'expo-clipboard': `export const setStringAsync=async()=>{}`,
  'expo-haptics': `export const NotificationFeedbackType={Success:'Success'};export const notificationAsync=async()=>{}`,
  '../store/useReasoningDisplayStore': `export const useReasoningDisplayStore=globalThis.__reasoningTrace.preferences`,
  '../store/useAppStore': `export const useAppStore=globalThis.__reasoningTrace.store`,
  '../theme': `export const spacing={xs:4,sm:8,md:12,lg:16},radius={sm:6,md:8,lg:12},typography={caption:{fontSize:12,lineHeight:16},label:{fontSize:13,lineHeight:18},body:{fontSize:15,lineHeight:22}},fontWeight={medium:'500',semibold:'600'};export const usePalette=()=>({blue:'blue',raised:'gray',surface:'white',border:'gray',text:'black',muted:'gray',orange:'orange',red:'red'})`,
  './MarkdownContent': `import {createElement} from 'react';export const MarkdownContent=props=>{globalThis.__reasoningTrace.renderedMarkdown.push(props.value);return createElement('MarkdownContent',props,props.value)}`,
  './MediaGrid': `export const MediaGrid='MediaGrid'`,
  './CrossChatTimelineCards': `export const ChatReferenceChips='ChatReferenceChips',CrossChatExchangeCard='CrossChatExchangeCard',CrossChatHandoffCard='CrossChatHandoffCard',CrossChatMessageCard='CrossChatMessageCard'`,
  './ImportedCrossChatDeliveryCard': `export const ImportedCrossChatDeliveryCard='ImportedCrossChatDeliveryCard'`,
  './ChatInboxGroupCard': `export const ChatInboxGroupCard='ChatInboxGroupCard'`,
  './TeamMessageTimelineCard': `export const TeamMessageTimelineCard='TeamMessageTimelineCard',TeamReferenceChips='TeamReferenceChips'`,
}
const outfile = path.resolve('build/tmp', `reasoning-trace-rendering-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({ stdin: { contents: `export {TimelineRowView} from './src/components/TimelineRows';export {AppTypographyProvider} from './src/components/AppText';export {projectTimeline} from './src/lib/timeline'`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'reasoning-native-hosts', setup(context) {
  context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true } : mocks[args.path] ? { path: args.path, namespace: 'reasoning-mock' } : undefined)
  context.onLoad({ filter: /.*/, namespace: 'reasoning-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
} }] })
after(async () => { await unlink(outfile); delete globalThis.__reasoningTrace })
const { TimelineRowView, AppTypographyProvider, projectTimeline } = await import(pathToFileURL(outfile).href)
const event = (patch = {}) => ({ id: 'thought', session_id: 'chat', run_id: 'run', seq: 2, type: 'reasoning_summary', ts: '2026-10-10T12:00:00Z', text: 'Received thinking summary.', ...patch })
const row = events => ({ kind: 'trace', key: 'trace-run', seq: 2, runId: 'run', events, active: false, promotedCommentaryIds: [] })
const props = current => ({ row: current, sessionId: 'chat', onReview() {}, fontScale: 1, layoutWidth: 390 })
const view = currentProps => React.createElement(AppTypographyProvider, null, React.createElement(TimelineRowView, currentProps))
const byID = (tree, id) => tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const press = (tree, id) => act(async () => { const target = byID(tree, id); assert.ok(target, `${id} must exist`); assert.notEqual(target.props.disabled, true); target.props.onPress() })
const plain = tree => {
  const text = node => typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(text) : node?.children ? node.children.flatMap(text) : []
  return text(tree.toJSON()).join('\n')
}
async function render(current, fontScale = 1) {
  const reads = []
  preferences.setState({ preference: 'compact' });
  store.setState({ sessions: [], snapshots: {}, fontScale, profileGeneration: 1, selectedSessionId: 'chat', loadRunTrace: async (...args) => { reads.push(args); return { events: [], has_more: false, next_after: 0 } } }, true)
  let tree; await act(async () => { tree = TestRenderer.create(view({ ...props(current), fontScale })) })
  return { tree, reads }
}
const unmount = tree => act(async () => tree.unmount())

for (const backend of ['codex', 'claude']) {
  test(`${backend} full available reasoning is reachable beyond the old 4k cutoff without extra requests`, async () => {
    const source = `**Received summary**\n\n${'Provider text. '.repeat(1_500)}END_OF_AVAILABLE_TRACE`
    const { tree, reads } = await render(row([event({ backend, text: source, partial: true })]))
    try {
      await act(async () => tree.root.findAll(node => node.type === 'Pressable' && node.props.accessibilityState?.expanded === false)[0].props.onPress())
      assert.ok(plain(tree).includes('Partial thinking summary'))
      await press(tree, 'trace-event-full-thought')
      const pages = []
      for (;;) {
        const content = byID(tree, 'trace-event-content-thought')
        assert.ok(content); pages.push(content.props.children)
        assert.ok(content.props.children.length <= 12_000)
        const next = byID(tree, 'trace-event-next-thought')
        if (next.props.disabled) break
        await press(tree, 'trace-event-next-thought')
      }
      assert.equal(pages.join(''), source, 'every available character is readable once, in order')
      assert.ok(plain(tree).includes('END_OF_AVAILABLE_TRACE'))
      await press(tree, 'trace-event-prev-thought')
      await press(tree, 'trace-event-close-thought')
      assert.equal(byID(tree, 'trace-event-content-thought'), undefined)
      await press(tree, 'trace-event-full-thought')
      assert.match(byID(tree, 'trace-event-page-thought').props.children, /Part 1 of/)
      assert.equal(reads.length, 1, 'opening history loads one bounded page; text-only disclosure and paging make no further requests')
    } finally { await unmount(tree) }
  })
}

test('summary and provider-supplied reasoning have separate truthful labels, including interrupted text', async () => {
  const { tree } = await render(row([event({ phase: 'summary' }), event({ id: 'supplied', seq: 3, type: 'reasoning_text', phase: 'reasoning', partial: true, text: 'Provider text only.' })]))
  try {
    await act(async () => tree.root.findAll(node => node.type === 'Pressable' && node.props.accessibilityState?.expanded === false)[0].props.onPress())
    assert.match(plain(tree), /Thinking summary/)
    assert.match(plain(tree), /Partial provider-supplied reasoning/)
    assert.match(plain(tree), /Provider text only\./)
  } finally { await unmount(tree) }
})

for (const includeTool of [false, true]) {
  test(`compact Codex never substitutes its plaintext-only lane for a summary${includeTool ? ' or earlier tool' : ''}`, async () => {
    const supplied = 'PROVIDER_PLAINTEXT_ONLY_MUST_REQUIRE_DISCLOSURE'
    const events = [
      ...(includeTool ? [event({ id: 'earlier-tool', seq: 1, type: 'tool_started', backend: 'codex', text: '', tool: { name: 'Bash', input: { command: 'echo known tool headline' } } })] : []),
      event({ backend: 'codex', type: 'reasoning_text', phase: 'reasoning', text: supplied }),
    ]
    const active = { ...row(events), active: true, runActive: true }
    const { tree, reads } = await render(active)
    try {
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
      assert.ok(!plain(tree).includes(supplied), 'compact native Codex must not expose plaintext as its current headline')
      if (includeTool) assert.match(plain(tree), /echo known tool headline/)
      await press(tree, 'trace-open-trace-run')
      assert.ok(plain(tree).includes(supplied), 'the exact provider text remains available through explicit disclosure')
      assert.deepEqual(reads, [], 'explicit live disclosure uses received text without a detail request')
      await act(async () => tree.update(view(props({ ...active, active: false, runActive: false }))))
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
      assert.ok(!plain(tree).includes(supplied), 'terminal compact history also keeps plaintext behind disclosure')
      await press(tree, 'trace-open-trace-run')
      assert.ok(plain(tree).includes(supplied))
      assert.equal(reads.length, 1)
    } finally { await unmount(tree) }
  })
}

test('recycled rows close full text and do not expose another chat or event body', async () => {
  const { tree } = await render(row([event({ text: 'Original text '.repeat(600) })]))
  try {
    await act(async () => tree.root.findAll(node => node.type === 'Pressable' && node.props.accessibilityState?.expanded === false)[0].props.onPress())
    await press(tree, 'trace-event-full-thought')
    await act(async () => tree.update(view({ ...props({ ...row([event({ id: 'other', text: 'Other available text.' })]), key: 'other-trace' }), sessionId: 'other-chat' })))
    assert.equal(byID(tree, 'trace-event-content-thought'), undefined)
    assert.equal(byID(tree, 'trace-event-content-other'), undefined)
  } finally { await unmount(tree) }
})

test('recycling rejects loaded detail synchronously before even one new-chat render', async () => {
  const { tree } = await render(row([event()]))
  await act(async () => store.setState({ loadRunTrace: async () => ({ events: [event({ id: 'private-loaded', text: 'OLD_LOADED_ONLY' })], has_more: false, next_after: 2 }) }))
  try {
    await press(tree, 'trace-open-trace-run')
    assert.match(plain(tree), /OLD_LOADED_ONLY/)
    await act(async () => preferences.setState({ preference: 'expanded' }))
    globalThis.__reasoningTrace.renderedMarkdown.length = 0
    const next = { ...row([event({ id: 'new-chat-thought', session_id: 'new-chat', text: 'New chat supplied text.' })]), runActive: true, active: true }
    await act(async () => tree.update(view({ ...props(next), sessionId: 'new-chat' })))
    assert.ok(globalThis.__reasoningTrace.renderedMarkdown.includes('New chat supplied text.'))
    assert.ok(globalThis.__reasoningTrace.renderedMarkdown.every(value => !value.includes('OLD_LOADED_ONLY')), 'even the pre-effect render must not merge detail owned by another chat')
  } finally { await unmount(tree) }
})

test('reader page survives transient-to-durable identity replacement without duplication or a GET', async () => {
  const source = `Live available text. ${'provider detail '.repeat(2_000)}END_OF_AVAILABLE_TEXT`
  const transient = event({ id: 'stream:live', item_id: 'provider-item', phase: 'summary', seq: 1.5, reasoning_after_seq: 1, text: source })
  const current = { ...row([transient]), runActive: true, active: true }
  const { tree, reads } = await render(current)
  try {
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-event-full-stream:live')
    await press(tree, 'trace-event-next-stream:live')
    const selectedText = byID(tree, 'trace-event-content-stream:live').props.children
    const durable = { ...transient, id: 'persisted-thought', seq: 3 }
    await act(async () => tree.update(view(props({ ...current, events: [transient, durable] }))))
    assert.equal(byID(tree, 'trace-event-content-persisted-thought').props.children, selectedText)
    assert.match(byID(tree, 'trace-event-page-persisted-thought').props.children, /Part 2 of/)
    assert.equal(byID(tree, 'trace-event-content-stream:live'), undefined)
    assert.deepEqual(reads, [])
  } finally { await unmount(tree) }
})

test('reported server truncation stays explicit and a prompt is never used as reasoning', async () => {
  const { tree } = await render(row([event({ text: 'Only this text arrived.', output_truncated: true, output_chars: 20_000 }),
    event({ id: 'empty', text: '', prompt: 'Internal prompt must remain invisible', raw: { text: 'Raw transport data' } })]))
  try {
    await press(tree, 'trace-open-trace-run')
    assert.match(plain(tree), /Only the available text window is shown/)
    await press(tree, 'trace-event-full-thought')
    assert.equal(byID(tree, 'trace-event-content-thought').props.children, 'Only this text arrived.')
    assert.equal(byID(tree, 'trace-event-next-thought').props.disabled, true)
    assert.equal(byID(tree, 'trace-event-full-empty'), undefined)
    assert.ok(!JSON.stringify(tree.toJSON()).includes('Internal prompt must remain invisible'))
    assert.ok(!JSON.stringify(tree.toJSON()).includes('Raw transport data'))
  } finally { await unmount(tree) }
})

test('an explicit history load reveals received earlier text once without turning disclosure into polling', async () => {
  const oldText = `Earlier received text. ${'detail '.repeat(2_000)}EARLIER_END`
  const current = row([event({ id: 'latest', seq: 5, text: 'Latest retained anchor.' })])
  const { tree, reads } = await render(current)
  await act(async () => store.setState({ loadRunTrace: async (...args) => { reads.push(args); return { events: [event({ id: 'earlier', seq: 2, text: oldText, partial: true }), ...current.events], has_more: false, next_after: 5 } } }))
  try {
    await press(tree, 'trace-open-trace-run')
    assert.equal(reads.length, 1, 'first explicit history expansion loads one bounded page')
    await press(tree, 'trace-event-full-earlier')
    await press(tree, 'trace-event-next-earlier')
    assert.ok(byID(tree, 'trace-event-content-earlier').props.children.endsWith('EARLIER_END'))
    await press(tree, 'trace-event-close-earlier')
    await press(tree, 'trace-event-full-earlier')
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-open-trace-run')
    assert.equal(reads.length, 1)
  } finally { await unmount(tree) }
})

test('switching profile closes the full reader even when a different server reuses event identities', async () => {
  const current = row([event({ text: 'First server source. '.repeat(500) })])
  const { tree } = await render(current)
  try {
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-event-full-thought')
    await act(async () => store.setState({ profileGeneration: 2 }))
    assert.equal(byID(tree, 'trace-event-content-thought'), undefined)
    assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
  } finally { await unmount(tree) }
})

for (const fontScale of [0.8, 1.4]) {
  test(`full reasoning text applies the app-wide ${fontScale} font scale exactly once`, async () => {
    const { tree } = await render(row([event({ text: 'Available text. '.repeat(1_000) })]), fontScale)
    try {
      await press(tree, 'trace-open-trace-run')
      await press(tree, 'trace-event-full-thought')
      const text = byID(tree, 'trace-event-content-thought')
      const style = Object.assign({}, ...[text.props.style].flat(Infinity).filter(Boolean))
      assert.equal(style.fontSize, Math.round(15 * fontScale * 2) / 2, 'the real AppText provider owns font scaling')
      assert.equal(style.lineHeight, Math.round(22 * fontScale * 2) / 2, 'line height must scale only once too')
      const readerStyle = Object.assign({}, ...[byID(tree, 'trace-event-reader-thought').props.style].flat(Infinity).filter(Boolean))
      assert.equal(readerStyle.height, 300, 'larger text remains inside the bounded scrollable reader')
      await press(tree, 'trace-event-next-thought')
      await press(tree, 'trace-event-close-thought')
      assert.equal(byID(tree, 'trace-event-content-thought'), undefined)
    } finally { await unmount(tree) }
  })
}

for (const backend of ['codex', 'claude']) {
  test(`${backend} saved expansion applies only while active and never fetches by itself`, async () => {
    const active = { ...row([event({ backend, text: 'Live supplied thinking.' })]), active: true, runActive: true }
    const { tree, reads } = await render(active)
    try {
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
      await act(async () => preferences.setState({ preference: 'expanded' }))
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, true)
      assert.equal(byID(tree, 'trace-event-preview-thought').props.collapsable, false, 'native acceptance measures the actual text preview, not only the disclosure label')
      assert.ok(tree.root.findAll(node => node.type === 'MarkdownContent').some(node => node.props.value === 'Live supplied thinking.'))
      assert.deepEqual(reads, [])
      await act(async () => preferences.setState({ preference: 'compact' }))
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
      await act(async () => preferences.setState({ preference: 'expanded' }))
      const completed = { ...active, active: false, runActive: false }
      await act(async () => tree.update(view(props(completed))))
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
      await press(tree, 'trace-open-trace-run')
      assert.equal(reads.length, 1)
      await act(async () => preferences.setState({ preference: 'compact' }))
      await act(async () => preferences.setState({ preference: 'expanded' }))
      assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, true, 'manual historical choice survives later preference changes')
      assert.equal(reads.length, 1)
    } finally { await unmount(tree) }
  })
}

test('a live run stays expanded across an intermediate assistant item and closes after stop', async () => {
  const active = { ...row([event({ partial: true })]), active: false, runActive: true }
  const { tree, reads } = await render(active)
  try {
    await act(async () => preferences.setState({ preference: 'expanded' }))
    assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, true)
    assert.match(plain(tree), /Partial thinking summary/)
    await act(async () => tree.update(view(props({ ...active, runActive: false }))))
    assert.equal(byID(tree, 'trace-open-trace-run').props.accessibilityState.expanded, false)
    assert.deepEqual(reads, [])
    await press(tree, 'trace-open-trace-run')
    assert.match(plain(tree), /Partial thinking summary/)
    assert.equal(reads.length, 1)
  } finally { await unmount(tree) }
})

test('scheduled job traces stay compact under expanded preference, including after a human goal input', async () => {
  const source = [event({ id: 'job-status', seq: 1, type: 'job_summary', job_id: 'job', job_status: 'running', text: '' }),
    event({ backend: 'codex', type: 'reasoning_text', phase: 'reasoning', text: 'Scheduled provider text remains manually readable.' })]
  const before = projectTimeline(source, []).find(current => current.kind === 'job')
  assert.ok(before)
  const { tree, reads } = await render(before)
  const disclosure = () => tree.root.findAll(node => node.type === 'Pressable'
    && node.props.testID?.startsWith('trace-open-'))[0]
  try {
    await act(async () => preferences.setState({ preference: 'expanded' }))
    assert.equal(disclosure().props.accessibilityState.expanded, false, 'desktop keeps even running job traces compact')
    assert.deepEqual(reads, [])
    const after = projectTimeline([...source, event({ id: 'human-input', seq: 5, type: 'turn_steered', backend: 'codex',
      native_goal_steer: true, native_steer: true, provider_user_authored: true, purpose: 'codex_goal_resume',
      prompt: 'Accepted human follow-up', text: '' })], []).find(current => current.kind === 'job')
    await act(async () => tree.update(view(props(after))))
    assert.equal(disclosure().props.accessibilityState.expanded, false, 'stale running metadata must not autoexpand old job reasoning')
    assert.match(plain(tree), /Running/, 'reasoning presentation must not rewrite scheduler status')
    assert.deepEqual(reads, [])
    await press(tree, disclosure().props.testID)
    assert.equal(disclosure().props.accessibilityState.expanded, true)
    assert.match(plain(tree), /Scheduled provider text remains manually readable\./)
    assert.equal(reads.length, 1, 'manual disclosure loads one bounded detail page')
    await press(tree, disclosure().props.testID)
    assert.equal(disclosure().props.accessibilityState.expanded, false)
    assert.equal(reads.length, 1)
  } finally { await unmount(tree) }
})

test('first explicit history expansion has one in-flight request and preserves scoped rejection', async () => {
  const { tree, reads } = await render(row([event()]))
  let settle
  await act(async () => store.setState({ loadRunTrace: (...args) => { reads.push(args); return new Promise(resolve => { settle = resolve }) } }))
  try {
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-open-trace-run')
    assert.equal(reads.length, 1)
    await act(async () => store.setState({ selectedSessionId: 'another-chat', profileGeneration: 2 }))
    await act(async () => settle({ events: [event({ id: 'late-private', text: 'Late old server text' })], has_more: false, next_after: 5 }))
    assert.ok(!JSON.stringify(tree.toJSON()).includes('Late old server text'))
  } finally { await unmount(tree) }
})

test('oversized detail is explicitly bounded, not presented as a complete trace', async () => {
  const { tree } = await render(row([event({ text: 'Sample retained.' })]))
  await act(async () => store.setState({ loadRunTrace: async () => ({ events: [event({ id: 'oversized', text: 'x'.repeat(1_100_000) })], has_more: true, next_after: 6 }) }))
  try {
    await press(tree, 'trace-open-trace-run')
    assert.match(plain(tree), /Trace detail is bounded/)
    assert.ok(byID(tree, 'trace-event-full-oversized'))
    await press(tree, 'trace-event-full-oversized')
    assert.ok(byID(tree, 'trace-event-content-oversized').props.children.length > 0)
    assert.match(plain(tree), /Some provider text was omitted/)
    assert.equal(byID(tree, 'trace-show-more-trace-run'), undefined)
  } finally { await unmount(tree) }
})

test('a bounded source window remains labeled after opening every available page', async () => {
  const { tree } = await render(row([event({ text: 'Window retained.', reasoning_text_truncated: true, reasoning_text_chars: 50_000 })]))
  try {
    await press(tree, 'trace-open-trace-run')
    await press(tree, 'trace-event-full-thought')
    assert.match(plain(tree), /Some provider text was omitted/)
    assert.equal(byID(tree, 'trace-event-content-thought').props.children, 'Window retained.')
    assert.equal(byID(tree, 'trace-event-next-thought').props.disabled, true)
  } finally { await unmount(tree) }
})
