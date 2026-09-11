import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const client = await readFile(resolve('src/api/AgentServerClient.ts'), 'utf8')
const store = await readFile(resolve('src/store/useAppStore.ts'), 'utf8')
const provider = await readFile(resolve('src/components/ClaudeRuntimeContext.tsx'), 'utf8')

test('ephemeral Claude runtime packets bypass timeline sequencing', () => {
  const messageHandler = client.slice(
    client.indexOf('socket.onmessage = message =>'),
    client.indexOf('socket.onclose = event =>'),
  )
  assert.match(messageHandler, /isProviderRuntimeChanged\(packet\)/)
  assert.match(messageHandler, /onProviderRuntime\?\.\(packet\)[\s\S]*?return/)
  assert.ok(
    messageHandler.indexOf('isProviderRuntimeChanged(packet)') < messageHandler.indexOf('Number.isFinite(event.seq)'),
    'runtime invalidations must be routed before the durable sequence gate',
  )
})

test('selected-stream runtime notifications retain connection and selection fences', () => {
  const selectedStream = store.slice(
    store.indexOf('function startSelectedStream('),
    store.indexOf('function hasSelectedStream('),
  )
  assert.match(selectedStream, /publishProviderRuntimeChanged/)
  assert.match(selectedStream, /!connectionIsCurrent\(scope\)/)
  assert.match(selectedStream, /generation !== streamGeneration/)
  assert.match(selectedStream, /epoch !== selectionEpoch/)
  assert.match(selectedStream, /get\(\)\.selectedSessionId !== sessionId/)
  assert.match(selectedStream, /event\.session_id !== sessionId/)
})

test('Claude runtime provider refreshes only its exact profile-generation session scope', () => {
  const subscription = provider.slice(
    provider.indexOf('subscribeProviderRuntimeChanged(notification =>'),
    provider.indexOf("const subscription = NativeAppState.addEventListener('change'"),
  )
  assert.match(subscription, /notification\.connection !== client/)
  assert.match(subscription, /notification\.profileId !== activeProfileId/)
  assert.match(subscription, /notification\.profileGeneration !== profileGeneration/)
  assert.match(subscription, /notification\.event\.session_id !== sessionId/)
  assert.match(subscription, /notification\.event\.backend !== 'claude'/)
  assert.match(subscription, /contextUsageRefreshEpoch\.current !== null/)
  assert.match(subscription, /void refresh\(\)/)
})

test('manual Claude context sampling owns the refresh epoch and suppresses stale GET races', () => {
  const manualRefresh = provider.slice(
    provider.indexOf('const refreshContextUsage = useCallback'),
    provider.indexOf('\n  useEffect(() => {', provider.indexOf('const refreshContextUsage = useCallback')),
  )
  assert.match(manualRefresh, /const expectedScopeKey = scopeKeyRef\.current/)
  assert.match(manualRefresh, /if \(contextUsageRefreshEpoch\.current !== null\) return runtimeRef\.current/)
  assert.match(manualRefresh, /const epoch = \+\+requestEpoch\.current/)
  assert.match(manualRefresh, /contextUsageRefreshEpoch\.current = epoch/)
  assert.match(manualRefresh, /connection\.refreshClaudeContextUsage\(expectedSessionId\)/)
  assert.match(manualRefresh, /epoch !== requestEpoch\.current/)
  assert.match(manualRefresh, /scopeKeyRef\.current !== expectedScopeKey/)
  assert.match(manualRefresh, /runtimeScopeIsCurrent/)
  assert.doesNotMatch(manualRefresh, /setRuntime\(null\)/, 'a failed sample must retain the last good context snapshot')
  assert.match(manualRefresh, /if \(refreshAfterContextUsage\.current\)[\s\S]*?refreshAfterContextUsage\.current = false[\s\S]*?void refresh\(\)/)

  const foregroundRefresh = provider.slice(
    provider.indexOf("const subscription = NativeAppState.addEventListener('change'"),
    provider.indexOf('\n  useEffect(() => () => {'),
  )
  assert.match(foregroundRefresh, /state === 'active' && supported[\s\S]*?void refresh\(\)/)
  assert.match(provider, /if \(contextUsageRefreshEpoch\.current !== null\) \{[\s\S]*?refreshAfterContextUsage\.current = true[\s\S]*?Promise\.resolve\(runtimeRef\.current\)/)
  assert.match(provider, /previousRefreshSignal\.current = refreshSignal[\s\S]*?contextUsageRefreshEpoch\.current !== null[\s\S]*?refreshAfterContextUsage\.current = true/)
  assert.match(provider, /notification\.event\.runtime !== 'context_usage'[\s\S]*?contextUsageRefreshEpoch\.current !== null[\s\S]*?refreshAfterContextUsage\.current = true/)
  const scopeReset = provider.slice(
    provider.indexOf('requestEpoch.current += 1', provider.indexOf('\n  useEffect(() => {')),
    provider.indexOf('\n  }, [activeProfileId, profileGeneration, refresh, sessionId, supported])'),
  )
  assert.match(scopeReset, /setLoading\(false\)/)
  assert.match(scopeReset, /setRefreshing\(false\)/)
})
