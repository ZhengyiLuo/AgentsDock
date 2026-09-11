import { inferServerConfigured } from './server-setup'

export function isServerSetupRequired(state: {
  serverConfigured: boolean
  serverURL: string
}): boolean {
  return !state.serverConfigured && !inferServerConfigured(state.serverURL, undefined)
}

export function shouldAutoConnectServer(state: {
  activeProfileId: string | null
  serverConfigured: boolean
  serverURL: string
}): boolean {
  return Boolean(state.activeProfileId && !isServerSetupRequired(state))
}

export function shouldPresentServerSetup(state: {
  initialized: boolean
  connected: boolean
  serverConfigured: boolean
  serverURL: string
  setupDismissed: boolean
}): boolean {
  return state.initialized
    && !state.connected
    && isServerSetupRequired(state)
    && !state.setupDismissed
}
