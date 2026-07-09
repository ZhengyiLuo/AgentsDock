import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { MarkdownContent } from './MarkdownContent'

describe('MarkdownContent', () => {
  const openLinked = vi.fn().mockResolvedValue(undefined)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    openLinked.mockClear()
    openExternal.mockClear()
    writeText.mockClear()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: { open: vi.fn(), openLinked },
        native: { openExternal }
      } as unknown as AgentsDockAPI
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  it('opens unresolved relative links through the authorized session endpoint', () => {
    render(<MarkdownContent text="[report](out/run/report.csv)" sessionId="chat-7" />)
    fireEvent.click(screen.getByRole('link', { name: 'report' }))
    expect(openLinked).toHaveBeenCalledWith('chat-7', 'out/run/report.csv')
  })

  it('copies the complete fenced block when its rendered message is folded', async () => {
    const code = `echo start\n${'x'.repeat(7000)}\necho done`
    render(<MarkdownContent text={`\`\`\`bash\n${code}\n\`\`\``} />)
    fireEvent.click(screen.getByTitle('Copy full code'))
    expect(writeText).toHaveBeenCalledWith(code)
  })
})
