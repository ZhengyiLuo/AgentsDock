type AppStateListener = (state: string) => void
const appStateListeners = new Set<AppStateListener>()

export const Platform = { OS: 'ios' as const }

export const AppState = {
  currentState: 'active' as string,
  addEventListener(_event: string, listener: AppStateListener) {
    appStateListeners.add(listener)
    return { remove() { appStateListeners.delete(listener) } }
  },
  __emitAppState(state: string) {
    AppState.currentState = state
    for (const listener of appStateListeners) listener(state)
  },
}
