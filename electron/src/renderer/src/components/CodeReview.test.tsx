import { forwardRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { CodeReview } from './CodeReview'

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function MockVirtuoso(props: {
    data: unknown[]
    computeItemKey: (index: number, item: unknown) => string
    itemContent: (index: number, item: unknown) => React.ReactNode
    className?: string
  }, _ref) {
    return <div className={props.className}>{props.data.map((item, index) => <div key={props.computeItemKey(index, item)}>{props.itemContent(index, item)}</div>)}</div>
  })
}))

describe('CodeReview', () => {
  afterEach(() => {
    cleanup()
    resetTransientCloseStackForTests()
    vi.restoreAllMocks()
  })

  it('renders the canonical patch as line-level code and a changed-file tree', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        diffs: { get: vi.fn().mockResolvedValue('diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -4 +4 @@\n-oldValue\n+newValue') },
        native: { writeClipboard: vi.fn() }
      } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', runId: 'run-1', files: [{ path: 'src/example.ts', additions: 1, deletions: 1 }], additions: 1, deletions: 1, repositoryRoot: '/work/project' }} onClose={vi.fn()} />)

    expect(await screen.findByText('+newValue')).toBeInTheDocument()
    expect(screen.getByText('-oldValue')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Changed files' })).toBeInTheDocument()
    expect(screen.getAllByText('example.ts').length).toBeGreaterThan(0)
  })

  it('refuses to dress a git status inventory up as a code diff', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        diffs: { get: vi.fn() },
        native: { writeClipboard: vi.fn() }
      } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', source: ' M src/example.ts\n?? src/new.ts' }} onClose={vi.fn()} />)

    expect(screen.getByText(/recorded a file list, but no line-level patch/i)).toBeInTheDocument()
    expect(screen.queryByText(' M src/example.ts')).not.toBeInTheDocument()
  })
})
