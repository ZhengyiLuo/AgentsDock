import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('Sidebar.tsx', fs.readFileSync('src/components/Sidebar.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function callback(name, bindings) {
  let handler
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      handler = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler, `Missing ${name} callback`)
  const js = ts.transpileModule(`const handler = ${handler.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  return new Function(...Object.keys(bindings), `${js}; return handler`)(...Object.values(bindings))
}

test('closing search cancels debounce, invalidates old results, clears input and dismisses keyboard', () => {
  const calls = []
  const searchTimer = { current: 123 }
  const handleSearchChange = callback('handleSearchChange', {
    openingSearchResult: { current: null },
    setOpeningSearchResultId: () => {},
    profileScope: {},
    profileScopeIsCurrent: () => true,
    cancelTimelineSeek: () => calls.push('cancel-seek'),
    clearSearch: () => calls.push('invalidate-results'),
    setQuery: value => calls.push(['query', value]),
  })
  callback('closeSearch', {
    searchTimer,
    clearTimeout: timer => calls.push(['cancel', timer]),
    handleSearchChange,
    setSearchVisible: visible => calls.push(['visible', visible]),
    dismissSearchKeyboard: () => calls.push('dismiss-keyboard'),
  })()
  assert.equal(searchTimer.current, null)
  assert.deepEqual(calls, [
    ['cancel', 123], 'invalidate-results', ['query', ''], ['visible', false], 'dismiss-keyboard',
  ])
})

function navigation({ welcome = false } = {}) {
  const calls = []
  const session = { id: 'fixture' }
  let current = true
  let resolveSeek
  let busyResult = null
  const openingSearchResult = { current: null }
  let state = { sessions: [session], snapshots: {}, selectedSessionId: null }
  const open = callback('openSessionRow', {
    profileScope: { profileGeneration: 1 },
    sessionScopeIsCurrent: () => current,
    profileScopeIsCurrent: () => current,
    openingSearchResult,
    dismissSearchKeyboard: () => {},
    closeSearch: () => calls.push('close-search'),
    onOpenChat: () => calls.push('open-chat'),
    isWelcomeSession: () => welcome,
    useAppStore: { getState: () => state, setState: update => { state = { ...state, ...update(state) } } },
    select: id => { state.selectedSessionId = id; return new Promise(() => {}) },
    setOpeningSearchResultId: value => { busyResult = value },
    seekTimelineResult: () => new Promise(resolve => { resolveSeek = resolve }),
  })
  const editQuery = callback('handleSearchChange', {
    openingSearchResult,
    profileScope: {},
    profileScopeIsCurrent: () => current,
    cancelTimelineSeek: () => calls.push('cancel-seek'),
    setOpeningSearchResultId: () => {},
    clearSearch: () => {},
    setQuery: () => {},
  })
  return { open, editQuery, calls, session, get busyResult() { return busyResult }, settle: opened => resolveSeek(opened), invalidate: () => { current = false } }
}

for (const welcome of [false, true]) {
  test(`${welcome ? 'welcome' : 'ordinary'} chat closes search before navigation without waiting for timeline sync`, () => {
    const fixture = navigation({ welcome })
    fixture.open(fixture.session)
    assert.deepEqual(fixture.calls, ['close-search', 'open-chat'])
  })
}

for (const outcome of ['success', 'failed', 'stale']) {
  test(`history navigation ${outcome} only clears search on a successful current-server open`, async () => {
    const fixture = navigation()
    fixture.open(fixture.session, { event_id: 'event-fixture' })
    assert.deepEqual(fixture.calls, [])
    if (outcome === 'stale') fixture.invalidate()
    fixture.settle(outcome !== 'failed')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fixture.calls, outcome === 'success' ? ['close-search', 'open-chat'] : [])
    if (outcome !== 'stale') assert.equal(fixture.busyResult, null)
  })
}

test('editing a query cancels its pending history navigation and permits a new name selection', async () => {
  const fixture = navigation()
  fixture.open(fixture.session, { event_id: 'old-result' })
  fixture.editQuery('new name')
  fixture.open(fixture.session)
  assert.deepEqual(fixture.calls, ['cancel-seek', 'close-search', 'open-chat'])
  fixture.settle(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.calls, ['cancel-seek', 'close-search', 'open-chat'], 'old completion must not reopen the previous result')
})
