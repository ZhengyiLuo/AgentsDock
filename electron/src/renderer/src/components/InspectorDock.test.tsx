import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_DOCK_ANIMATION_MS, InspectorDock } from './InspectorDock'

vi.mock('./Inspector', () => ({
  Inspector: () => <div data-testid="inspector" />
}))

describe('InspectorDock', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('keeps inspector content mounted until the closing motion completes', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<InspectorDock open={false} contentKey="chat" />)
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument()

    rerender(<InspectorDock open contentKey="chat" />)
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(40))
    expect(container.querySelector('.inspector-dock-shell')).toHaveClass('open')

    rerender(<InspectorDock open={false} contentKey="chat" />)
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(INSPECTOR_DOCK_ANIMATION_MS))
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument()
  })

  it('hosts alternate dock content in place of the details inspector', () => {
    render(<InspectorDock open contentKey="review" content={<div data-testid="review" />} />)
    expect(screen.getByTestId('review')).toBeInTheDocument()
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument()
  })
})
