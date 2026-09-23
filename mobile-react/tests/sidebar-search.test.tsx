import assert from 'node:assert/strict'
import { act, create } from 'react-test-renderer'
import { Sidebar } from '../src/components/Sidebar'
import type { Session, TimelineSearchResult } from '../src/types'
import { resetComponentStore, useAppStore } from './component-mocks/app-store'

const sessions: Session[] = [
  { id: 'pinned', title: 'Pinned history match', backend: 'codex', pinned: true, sort_order: 0 },
  { id: 'job', title: 'Cluster monitor', backend: 'claude', folder: 'Jobs', sort_order: 0 },
  { id: 'name', title: 'Zenith', backend: 'codex', folder: 'General', sort_order: 50 },
  { id: 'prefix', title: 'Zenith app', backend: 'codex', folder: 'General', sort_order: 1 },
  { id: 'other', title: 'Unrelated', backend: 'codex', folder: 'General', sort_order: 0 },
]
const hit = (id: string): TimelineSearchResult => ({ session_id: id, event_id: `${id}-old`, seq: 12, role: 'assistant', snippet: 'ZenithDock Context Digest' })
let calls: string[] = []
let selections: string[] = []
let seeks: TimelineSearchResult[] = []
let opened = 0
let failSearch = false
let delaySearch = false
let finishSearch: (() => void) | undefined
let delaySeek = false
let finishSeek: (() => void) | undefined
let canceledSeeks = 0
resetComponentStore({
  sessions,
  folderOrder: ['Jobs'],
  collapsedFolders: ['General'],
  serverConfigured: true,
  serverURL: 'https://search.test',
  switchingProfileId: null,
  selectedSessionId: null,
  stoppingSessionIds: new Set(),
  sendingSessionIds: new Set(),
  pendingQueuedRunIds: new Set(),
  turnAdmissionTokens: {},
  searchResults: [],
  searchBusy: false,
  searchError: null,
  clearSearch: () => useAppStore.setState({ searchResults: [], searchBusy: false, searchError: null }),
  search: async query => {
    calls.push(query)
    useAppStore.setState({ searchBusy: true, searchError: null })
    if (delaySearch) await new Promise<void>(resolve => { finishSearch = resolve })
    useAppStore.setState(failSearch
      ? { searchBusy: false, searchResults: [], searchError: 'Synthetic search failure' }
      : { searchBusy: false, searchResults: [hit('pinned'), hit('job'), hit('name')] })
  },
  selectSession: async id => { selections.push(id); useAppStore.setState({ selectedSessionId: id }) },
  seekTimelineResult: async result => {
    seeks.push(result)
    if (delaySeek) await new Promise<void>(resolve => { finishSeek = resolve })
    return true
  },
  cancelTimelineSeek: () => { canceledSeeks += 1 },
})
const props = {
  profiles: [], activeProfileId: 'profile-a', onSwitchServer: async () => true,
  onAddServer() {}, onManageServers() {}, onSettings() {}, onTeamNetwork() {}, onNewChat() {},
  onOpenChat() { opened += 1 },
}
let renderer!: ReturnType<typeof create>
await act(async () => { renderer = create(<Sidebar {...props} />) })
const input = () => renderer.root.findAll(node => node.type === 'TextInput' && node.props.testID === 'sidebar-search-input')[0]
const visibleChatIds = () => renderer.root.findAll(node => node.type === 'Pressable' && node.props.testID?.startsWith('chat-row-')).map(node => node.props.testID.slice(9))
const type = async (value: string) => { await act(async () => input().props.onChangeText(value)) }
const pauseForSearch = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 290)) }) }
const pressChat = async (id: string) => { await act(async () => renderer.root.findByProps({ testID: `chat-row-${id}` }).props.onPress()) }
const text = () => JSON.stringify(renderer.toJSON())

try {
  await type('Z')
  await pauseForSearch()
  assert.deepEqual(calls, [], 'one-character queries filter locally without contacting the server')
  await type('Ze')
  await type('Zen')
  await type('Zenith')
  assert.deepEqual(calls, [], 'typing filters names immediately without one network request per keystroke')
  assert.deepEqual(visibleChatIds().sort(), ['name', 'prefix'], 'matching names appear immediately, including inside collapsed folders')
  await pauseForSearch()
  assert.deepEqual(calls, ['Zenith'], 'only the settled query searches server history')
  assert.deepEqual(visibleChatIds(), ['name', 'prefix', 'pinned', 'job'], 'history matches in Pinned and Jobs must not bury matching names')
  assert.match(text(), /4 matches/, 'the footer reports search matches, not all chats')
  assert.doesNotMatch(text(), /Collapse Pinned|Collapse Jobs/, 'search results are not regrouped into ordinary folders')
  await pressChat('name')
  assert.deepEqual(selections, ['name'], 'a name hit opens the live chat even when history also matches')
  assert.equal(seeks.length, 0)
  await pressChat('pinned')
  assert.equal(seeks[0]?.event_id, 'pinned-old', 'a content-only hit opens the matching timeline event')
  assert.equal(opened, 2)

  await type('no-match')
  assert.deepEqual(visibleChatIds(), [], 'old history matches disappear as soon as the query changes')
  assert.match(text(), /No matching chats/)
  await type('')
  assert.deepEqual(visibleChatIds(), ['pinned', 'job'], 'clearing search restores the original collapsed folders')
  await pauseForSearch()
  assert.deepEqual(calls, ['Zenith'], 'clearing cancels the pending history request')

  delaySearch = true
  await type('history-only')
  await pauseForSearch()
  assert.match(text(), /Searching history/, 'an in-flight content search has a visible pending state')
  await act(async () => finishSearch?.())
  delaySearch = false

  failSearch = true
  await type('Zenith')
  await pauseForSearch()
  assert.match(text(), /History search failed/)
  assert.deepEqual(visibleChatIds(), ['name', 'prefix'], 'history failure leaves local matching names usable')
  failSearch = false
  await act(async () => renderer.root.findByProps({ testID: 'sidebar-search-retry' }).props.onPress())
  assert.deepEqual(visibleChatIds(), ['name', 'prefix', 'pinned', 'job'], 'retry restores content matches without losing title rank')
  assert.doesNotMatch(text(), /History search failed/)
  await type('')
  await type('Zenith')
  await pauseForSearch()
  assert.deepEqual(visibleChatIds(), ['name', 'prefix', 'pinned', 'job'], 'a repeated query works after clearing')
  delaySeek = true
  await pressChat('pinned')
  await type('Zenith app')
  assert.equal(canceledSeeks, 1, 'editing the query cancels its pending history navigation')
  await pressChat('prefix')
  assert.deepEqual(selections, ['name', 'prefix'], 'a pending obsolete history jump cannot block a new name selection')
  assert.equal(opened, 3)
  await act(async () => finishSeek?.())
  assert.equal(opened, 3, 'an obsolete history completion cannot reopen the pane for the old result')
  delaySeek = false
  const callsBeforeSwitch = calls.length
  await act(async () => {
    useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2, switchingProfileId: 'profile-b', searchResults: [] })
    renderer.update(<Sidebar {...props} activeProfileId="profile-b" switchingProfileId="profile-b" />)
  })
  await pauseForSearch()
  assert.equal(calls.length, callsBeforeSwitch, 'switching server cancels the old profile search before transport')
  await act(async () => {
    useAppStore.setState({ switchingProfileId: null, workspaceAdopting: true })
    renderer.update(<Sidebar {...props} activeProfileId="profile-b" />)
  })
  await pauseForSearch()
  assert.equal(calls.length, callsBeforeSwitch, 'workspace adoption keeps the search transport paused')
  await act(async () => { useAppStore.setState({ workspaceAdopting: false }) })
  await pauseForSearch()
  assert.equal(calls.length, callsBeforeSwitch + 1, 'search resumes once the new profile workspace is ready')
} finally {
  await act(async () => renderer.unmount())
}
console.log('rendered sidebar search regressions passed (native rendering and store transport mocked)')
