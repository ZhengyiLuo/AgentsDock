import type { CodeEditorViewState } from './codeEditorProtocol'

const MAX_CACHED_PATHS = 24
const viewStates = new Map<string, CodeEditorViewState>()

export function cachedMobileCodeEditorViewState(path: string): CodeEditorViewState | undefined {
  const cached = viewStates.get(path)
  if (!cached) return undefined
  viewStates.delete(path)
  viewStates.set(path, cached)
  return cloneViewState(cached)
}

export function rememberMobileCodeEditorViewState(path: string, state: CodeEditorViewState): void {
  if (!path) return
  viewStates.delete(path)
  viewStates.set(path, cloneViewState(state))
  while (viewStates.size > MAX_CACHED_PATHS) {
    const oldest = viewStates.keys().next().value
    if (typeof oldest !== 'string') break
    viewStates.delete(oldest)
  }
}

export function clearMobileCodeEditorViewStateCache(): void {
  viewStates.clear()
}

function cloneViewState(state: CodeEditorViewState): CodeEditorViewState {
  return {
    anchor: state.anchor,
    head: state.head,
    scrollTop: state.scrollTop,
    scrollLeft: state.scrollLeft,
    ...(state.folds ? { folds: state.folds.map(range => ({ ...range })) } : {}),
    ...(state.foldDocument ? { foldDocument: state.foldDocument } : {}),
  }
}
