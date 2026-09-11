import { forwardRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByRole('region', { name: 'Code review' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Changed files' })).toBeInTheDocument()
    expect(screen.getAllByText('example.ts').length).toBeGreaterThan(0)
  })

  it('highlights complete merge conflicts throughout the review surface', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = [
      'diff --git a/src/conflicted.ts b/src/conflicted.ts', '--- a/src/conflicted.ts', '+++ b/src/conflicted.ts', '@@ -1,7 +1,7 @@',
      ' <<<<<<< HEAD', ' ours', ' ||||||| parent', ' base', ' =======', ' theirs', ' >>>>>>> feature',
      'diff --git a/src/clean.ts b/src/clean.ts', '--- a/src/clean.ts', '+++ b/src/clean.ts', '@@ -1 +1 @@', '-old', '+new'
    ].join('\n')

    const view = render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('1 conflicted file · 1 conflict')
    const conflicted = screen.getByRole('button', { name: 'src/conflicted.ts, 1 conflict, 0 additions, 0 deletions' })
    const clean = screen.getByRole('button', { name: 'src/clean.ts, 1 additions, 1 deletions' })
    expect(screen.getByRole('separator', { name: 'Merge conflict: ours section begins, HEAD' })).toHaveAttribute('data-conflict-side', 'ours')
    expect(screen.getByRole('separator', { name: 'Merge conflict: base section begins, parent' })).toHaveAttribute('data-conflict-side', 'base')
    expect(screen.getByRole('separator', { name: 'Merge conflict: theirs section begins' })).toHaveAttribute('data-conflict-side', 'theirs')
    expect(screen.getByRole('separator', { name: 'Merge conflict ends, feature' })).toHaveAttribute('data-conflict-side', 'theirs')
    expect(view.container.querySelectorAll('.diff-line[data-conflict-side]')).toHaveLength(7)
    fireEvent.click(clean)
    expect(clean).toHaveAttribute('aria-current', 'true')
    expect(conflicted).not.toHaveAttribute('aria-current')
  })

  it('does not style an incomplete conflict marker as a conflict', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+<<<<<<< HEAD\n+unfinished'

    const view = render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-conflict-side]')).not.toBeInTheDocument()
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

  it('ignores a late diff response after the review switches chats', async () => {
    let resolveFirst: (value: string) => void = () => undefined
    const first = new Promise<string>(resolve => { resolveFirst = resolve })
    const get = vi.fn((sessionId: string) => sessionId === 'chat-1'
      ? first
      : Promise.resolve('diff --git a/chat-two.ts b/chat-two.ts\n--- a/chat-two.ts\n+++ b/chat-two.ts\n@@ -1 +1 @@\n-old\n+chatTwo'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })

    const view = render(<CodeReview target={{ sessionId: 'chat-1', runId: 'run-1' }} onClose={vi.fn()} />)
    view.rerender(<CodeReview target={{ sessionId: 'chat-2', runId: 'run-2' }} onClose={vi.fn()} />)
    expect(await screen.findByText('+chatTwo')).toBeInTheDocument()

    resolveFirst('diff --git a/chat-one.ts b/chat-one.ts\n--- a/chat-one.ts\n+++ b/chat-one.ts\n@@ -1 +1 @@\n-old\n+chatOne')
    await waitFor(() => expect(screen.queryByText('+chatOne')).not.toBeInTheDocument())
    expect(screen.getByText('+chatTwo')).toBeInTheDocument()
  })
})
