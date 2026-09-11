type Listener<T> = (state: T, previous: T) => void
type SetState<T> = (value: Partial<T> | T | ((state: T) => Partial<T> | T), replace?: boolean) => void

export function create<T>(initializer: (set: SetState<T>, get: () => T, api: unknown) => T) {
  let state: T
  const listeners = new Set<Listener<T>>()
  const getState = () => state
  const setState: SetState<T> = (value, replace = false) => {
    const previous = state
    const next = typeof value === 'function'
      ? (value as (current: T) => Partial<T> | T)(state)
      : value
    state = replace ? next as T : Object.assign({}, state, next)
    for (const listener of listeners) listener(state, previous)
  }
  const api = {
    setState,
    getState,
    getInitialState: () => state,
    subscribe(listener: Listener<T>) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  state = initializer(setState, getState, api)
  const useStore = (<U = T>(selector: (value: T) => U = value => value as unknown as U) => selector(state)) as {
    <U = T>(selector?: (value: T) => U): U
    setState: SetState<T>
    getState(): T
    getInitialState(): T
    subscribe(listener: Listener<T>): () => boolean
  }
  return Object.assign(useStore, api)
}
