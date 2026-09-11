import { shouldAutoConnectServer, shouldPresentServerSetup } from './first-launch'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(shouldPresentServerSetup({
  initialized: true,
  connected: false,
  serverConfigured: false,
  serverURL: 'http://127.0.0.1:7850',
  setupDismissed: false,
}), 'a pristine initialized install must present server setup immediately')

assert(!shouldPresentServerSetup({
  initialized: false,
  connected: false,
  serverConfigured: false,
  serverURL: 'http://127.0.0.1:7850',
  setupDismissed: false,
}), 'setup must wait only for local bootstrap')

assert(!shouldPresentServerSetup({
  initialized: true,
  connected: false,
  serverConfigured: false,
  serverURL: 'http://localhost:7850',
  setupDismissed: true,
}), 'a user-dismissed setup sheet must remain dismissed')

assert(!shouldPresentServerSetup({
  initialized: true,
  connected: true,
  serverConfigured: true,
  serverURL: 'https://review.example:7850',
  setupDismissed: false,
}), 'a connected configured profile must not present setup')

assert(!shouldAutoConnectServer({
  activeProfileId: 'default-profile',
  serverConfigured: false,
  serverURL: 'http://127.0.0.1:7850',
}), 'the unconfigured localhost placeholder must never start a health request')

assert(shouldAutoConnectServer({
  activeProfileId: 'configured-profile',
  serverConfigured: true,
  serverURL: 'https://review.example:7850',
}), 'a configured active profile must retain automatic reconnection')

assert(shouldAutoConnectServer({
  activeProfileId: 'legacy-profile',
  serverConfigured: false,
  serverURL: 'https://legacy.example:7850',
}), 'a custom legacy endpoint must reconnect once to adopt its server identity')

console.log('first-launch regressions passed')
