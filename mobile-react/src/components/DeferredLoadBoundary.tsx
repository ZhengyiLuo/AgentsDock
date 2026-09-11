import { Component, type ReactNode } from 'react'

interface DeferredLoadBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  onError?: () => void
  resetKey: string
}

interface DeferredLoadBoundaryState {
  failed: boolean
}

// Lazy module failures must degrade to app-owned controls instead of escaping
// through the React root. Changing/closing the requested surface resets the
// boundary so another file can still be opened.
export class DeferredLoadBoundary extends Component<DeferredLoadBoundaryProps, DeferredLoadBoundaryState> {
  state: DeferredLoadBoundaryState = { failed: false }

  static getDerivedStateFromError(): DeferredLoadBoundaryState {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError?.()
  }

  componentDidUpdate(previous: DeferredLoadBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
