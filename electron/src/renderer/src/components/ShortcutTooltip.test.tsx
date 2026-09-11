import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { afterEach, describe, expect, it } from 'vitest'
import { ShortcutKey, ShortcutTooltip } from './ShortcutTooltip'

describe('ShortcutTooltip', () => {
  afterEach(cleanup)
  it('shows the feature name and shortcut on hover', async () => {
    const user = userEvent.setup()
    render(<TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <ShortcutTooltip shortcut="newChat" platform="mac">
        <button aria-label="New chat">+</button>
      </ShortcutTooltip>
    </TooltipProvider>)

    await user.hover(screen.getByRole('button', { name: 'New chat' }))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('New chat')
    expect(tooltip).toHaveTextContent('⌘N')
  })

  it('can display both directions for a cycling control', async () => {
    const user = userEvent.setup()
    render(<TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <ShortcutTooltip label="Switch server" shortcut={['previousServer', 'nextServer']} platform="mac">
        <button>Server</button>
      </ShortcutTooltip>
    </TooltipProvider>)

    await user.hover(screen.getByRole('button', { name: 'Server' }))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Switch server')
    expect(tooltip).toHaveTextContent('⇧⌘[')
    expect(tooltip).toHaveTextContent('⇧⌘]')
  })

  it('renders the platform-specific key outside a tooltip', () => {
    const { rerender } = render(<ShortcutKey shortcut="findChat" platform="other" />)
    expect(screen.getByText('Ctrl+P')).toBeInTheDocument()

    rerender(<ShortcutKey shortcut="openWorkspaceFile" platform="mac" />)
    expect(screen.getByText('⌘O')).toBeInTheDocument()
  })
})
