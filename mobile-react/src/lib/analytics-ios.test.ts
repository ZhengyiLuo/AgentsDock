import * as SecureStore from 'expo-secure-store'
import { trackEvent } from './analytics.ios'

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
await SecureStore.setItemAsync('agentsdock.analytics.distinct_id', 'legacy-install-id')

let requests = 0
globalThis.fetch = (async () => {
  requests += 1
  throw new Error('iOS analytics must not perform a request')
}) as typeof fetch

trackEvent('app_launched')
trackEvent('server_added', { success: true })
await new Promise(resolve => setTimeout(resolve, 0))

assertEqual(requests, 0, 'iOS analytics request count')
assertEqual(await SecureStore.getItemAsync('agentsdock.analytics.distinct_id'), null, 'legacy iOS analytics ID is removed')

console.log('iOS analytics no-op regressions passed')
