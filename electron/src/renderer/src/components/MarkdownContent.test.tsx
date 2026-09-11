import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { MarkdownContent } from './MarkdownContent'
import SafeHtmlMarkdownContent from './SafeHtmlMarkdownContent'

describe('MarkdownContent', () => {
  const openLinked = vi.fn().mockResolvedValue(undefined)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const writeClipboard = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    openLinked.mockClear()
    openExternal.mockClear()
    writeClipboard.mockClear()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: { open: vi.fn(), openLinked },
        native: { openExternal, writeClipboard }
      } as unknown as AgentsDockAPI
    })
  })

  afterEach(cleanup)

  it('opens an exact Team Message hyperlink locally without file or external dispatch', () => {
    const href = 'agentsdock://team-message?section=mail&teamId=team-1&messageId=message-7&mailboxBox=inbox'
    const open = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', open, { once: true })
    render(<MarkdownContent text={`Read [the source message](${href})`} sessionId="chat-7" />)
    const link = screen.getByRole('link', { name: 'the source message' })
    expect(link).toHaveAttribute('href', href)
    fireEvent.click(link)
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'mail', teamId: 'team-1', messageId: 'message-7', mailboxBox: 'inbox' })
    expect(openLinked).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens unresolved relative links through the authorized session endpoint', () => {
    render(<MarkdownContent text="[report](out/run/report.csv)" sessionId="chat-7" />)
    const link = screen.getByRole('link', { name: 'report' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', 'agentsdock-workspace:out%2Frun%2Freport.csv')
    fireEvent.click(link)
    expect(openLinked).toHaveBeenCalledWith('chat-7', 'out/run/report.csv')
  })

  it('does not resolve workspace links against Electron’s packaged renderer URL', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent
      text="[Run summary](runs/080126/run016/summary.json)"
      sessionId="chat-7"
    />)

    const link = screen.getByRole('link', { name: 'Run summary' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute(
      'href',
      'agentsdock-workspace:runs%2F080126%2Frun016%2Fsummary.json'
    )
    expect(link.getAttribute('href')).not.toContain('app.asar')
    fireEvent.click(link)

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: 'runs/080126/run016/summary.json',
      line: undefined,
      column: undefined,
      resolve: true
    })
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('keeps web links as real anchors', () => {
    render(<MarkdownContent text="[OpenAI](https://openai.com)" sessionId="chat-7" />)
    const link = screen.getByRole('link', { name: 'OpenAI' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', 'https://openai.com')
  })

  it('renders only a validated structured chat reference as an inline route chip', () => {
    const onChatReferenceClick = vi.fn()
    const text = ':wave: Ask @Training for **input**.'
    const start = text.indexOf('@Training')
    const reference = {
      session_id: 'chat-8', display_title_snapshot: 'Training',
      source_text_start: start, source_text_end: start + '@Training'.length,
      action: 'route' as const
    }

    render(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[reference]}
      onChatReferenceClick={onChatReferenceClick}
    />)

    const chip = screen.getByRole('link', { name: 'Route hint for Training' })
    expect(chip).toHaveTextContent('@Training')
    expect(screen.getByText('input').closest('strong')).not.toBeNull()
    fireEvent.click(chip)
    expect(onChatReferenceClick).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'chat-8' }))
  })

  it('keeps an invalid structured span and an @Chat inside code non-interactive', () => {
    const text = 'Use ` @Training ` literally.'
    const start = text.indexOf('@Training')
    const { container } = render(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[{
        session_id: 'chat-8', display_title_snapshot: 'Training',
        source_text_start: start, source_text_end: start + '@Training'.length,
        action: 'route'
      }]}
      onChatReferenceClick={vi.fn()}
    />)

    expect(screen.getByText('@Training').tagName).toBe('CODE')
    expect(container.querySelector('.timeline-inline-chat-reference')).not.toBeInTheDocument()
    expect(container.textContent).not.toMatch(/[\uE000-\uF8FF]/u)
  })

  it('keeps a structured route inside Markdown link text non-nested and noninteractive', () => {
    const text = 'Read [about @Training ](https://example.com/training).'
    const start = text.indexOf('@Training')
    const onChatReferenceClick = vi.fn()
    const { container } = render(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[{
        session_id: 'chat-8', display_title_snapshot: 'Training',
        source_text_start: start, source_text_end: start + '@Training'.length,
        action: 'route'
      }]}
      onChatReferenceClick={onChatReferenceClick}
    />)

    const outerLink = screen.getByRole('link', { name: 'about @Training' })
    expect(outerLink.querySelector('.timeline-inline-chat-reference.inside-markdown-link')).not.toBeNull()
    expect(outerLink.querySelector('[role="link"]')).toBeNull()
    expect(container.querySelectorAll('a')).toHaveLength(1)
    fireEvent.click(screen.getByTitle('@Training · Route hint inside link text'))
    expect(onChatReferenceClick).not.toHaveBeenCalled()
  })

  it('does not memoize a stale structured route object', () => {
    const text = 'Ask @Training for input.'
    const start = text.indexOf('@Training')
    const onChatReferenceClick = vi.fn()
    const baseReference = {
      session_id: 'chat-8', display_title_snapshot: 'Training',
      source_text_start: start, source_text_end: start + '@Training'.length,
      action: 'route' as const
    }
    const { rerender } = render(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[baseReference]}
      onChatReferenceClick={onChatReferenceClick}
    />)
    rerender(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[{ ...baseReference, grant_intent: true, route_action: 'request_reply' }]}
      onChatReferenceClick={onChatReferenceClick}
    />)

    fireEvent.click(screen.getByRole('link', { name: 'Route hint for Training' }))
    expect(onChatReferenceClick).toHaveBeenCalledWith(expect.objectContaining({
      grant_intent: true,
      route_action: 'request_reply'
    }))
  })

  it('never exposes a partial route marker at the folded-message boundary', () => {
    const prefix = 'a'.repeat(6298) + ' '
    const text = `${prefix}@X trailing`
    const start = prefix.length
    const { container } = render(<MarkdownContent
      text={text}
      sessionId="chat-7"
      inlineChatReferences={[{
        session_id: 'chat-8', display_title_snapshot: 'X',
        source_text_start: start, source_text_end: start + 2,
        action: 'route'
      }]}
      onChatReferenceClick={vi.fn()}
    />)

    expect(container.textContent).not.toMatch(/[\uE000-\uF8FF]/u)
    expect(screen.queryByRole('link', { name: 'Route hint for X' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /characters hidden/i }))
    expect(screen.getByRole('link', { name: 'Route hint for X' })).toBeInTheDocument()
  })

  it('opens only a canonical secure-peer invite through the local Team Network handoff', () => {
    const invite = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`
    const open = vi.fn()
    window.addEventListener('agentsdock:open-secure-peer-invite', open)
    try {
      render(<MarkdownContent text={`[Connect server](${invite})`} sessionId="chat-7" />)
      const link = screen.getByRole('link', { name: 'Connect server' })
      expect(link).toHaveAttribute('href', invite)

      fireEvent.click(link)

      expect(open).toHaveBeenCalledOnce()
      expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ invite })
      expect(openExternal).not.toHaveBeenCalled()
      expect(openLinked).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:open-secure-peer-invite', open)
    }
  })

  it('keeps a noncanonical secure-peer Markdown URL inert', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-secure-peer-invite', open)
    try {
      render(<MarkdownContent text={`[Blocked](agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}&secret=x)`} sessionId="chat-7" />)
      const anchor = screen.getByText('Blocked').closest('a')
      expect(anchor).toHaveAttribute('href', '')
      fireEvent.click(anchor!)
      expect(open).not.toHaveBeenCalled()
      expect(openExternal).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:open-secure-peer-invite', open)
    }
  })

  it('makes inline workspace file references clickable without an agent-authored link', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent text={'`launcher.py:72` defines `TrainCommand`.'} sessionId="chat-7" />)

    fireEvent.click(screen.getByRole('button', { name: 'launcher.py:72' }))

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: 'launcher.py',
      line: 72,
      column: undefined,
      resolve: true
    })
    expect(screen.queryByRole('button', { name: 'TrainCommand' })).not.toBeInTheDocument()
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('routes explicit workspace file links into the internal editor at the requested line', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent
      text="[policy runner](robot/control/atlas_vla/policy_runner.py#L167)"
      sessionId="chat-7"
    />)

    fireEvent.click(screen.getByRole('link', { name: 'policy runner' }))

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: 'robot/control/atlas_vla/policy_runner.py',
      line: 167,
      column: undefined,
      resolve: true
    })
    expect(openLinked).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('routes an explicit absolute Markdown file link through the same internal editor request', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent
      text="[project notes](/home/dev/project/README.md#L12)"
      sessionId="chat-7"
    />)

    fireEvent.click(screen.getByRole('link', { name: 'project notes' }))

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: '/home/dev/project/README.md',
      line: 12,
      column: undefined,
      resolve: true
    })
    expect(openLinked).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('routes a server-home Markdown file link through the internal editor request', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent
      text="[Claude settings](~/.claude/settings.local.json#L4)"
      sessionId="chat-7"
    />)

    fireEvent.click(screen.getByRole('link', { name: 'Claude settings' }))

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: '~/.claude/settings.local.json',
      line: 4,
      column: undefined,
      resolve: true
    })
    expect(openLinked).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('keeps an inline-code link label inert and opens the reference exactly once', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent text={'[`file.py:10`](file.py#L10)'} sessionId="chat-7" />)

    expect(screen.queryByRole('button', { name: 'file.py:10' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'file.py:10' }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: 'file.py',
      line: 10,
      column: undefined,
      resolve: true
    })
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('keeps a reference-style inline-code link label inert and opens exactly once', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)
    render(<MarkdownContent
      text={'[`file.py:10`][source]\n\n[source]: file.py#L10'}
      sessionId="chat-7"
    />)

    expect(screen.queryByRole('button', { name: 'file.py:10' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'file.py:10' }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      path: 'file.py',
      line: 10,
      column: undefined,
      resolve: true
    })
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })

  it('does not make fenced code file references clickable', () => {
    render(<MarkdownContent text={'```\nlauncher.py:72\n```'} sessionId="chat-7" />)
    expect(screen.queryByRole('button', { name: 'launcher.py:72' })).not.toBeInTheDocument()
    expect(screen.getByText('launcher.py:72')).toBeInTheDocument()
  })

  it('does not make a one-line indented code block clickable', () => {
    render(<MarkdownContent text={'    launcher.py:72'} sessionId="chat-7" />)
    expect(screen.queryByRole('button', { name: 'launcher.py:72' })).not.toBeInTheDocument()
    expect(screen.getByText('launcher.py:72')).toBeInTheDocument()
  })

  it('opens a matched text artifact in the internal file viewer', () => {
    const file = {
      id: 'artifact-1',
      filename: 'migration-audit.md',
      path: 'migration-audit.md',
      source_path: '/Users/dev/.agentsdock/files/artifact-1/migration-audit.md',
      content_type: 'text/markdown'
    }
    const open = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', open)

    render(<MarkdownContent
      text="[Migration audit](/Users/dev/.agentsdock/files/artifact-1/migration-audit.md)"
      files={[file]}
      sessionId="chat-7"
    />)
    fireEvent.click(screen.getByRole('link', { name: 'Migration audit' }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-7',
      file
    })
    expect(window.agentsDock.files.open).not.toHaveBeenCalled()
    expect(openLinked).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-agent-file', open)
  })

  it('keeps raw HTML inert unless a trusted preview explicitly enables it', () => {
    const resolveImageSource = vi.fn((source: string) => `agentsdock-media:${source}`)
    const { container } = render(<MarkdownContent
      text={'<div align="center"><img src="media/header.png" alt="Header"></div>'}
      resolveImageSource={resolveImageSource}
    />)

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('<div align="center">')
    expect(resolveImageSource).not.toHaveBeenCalled()
  })

  it('renders sanitized GitHub-style HTML and resolves its relative images', () => {
    const resolveImageSource = vi.fn((source: string) => (
      `agentsdock-media://workspace/profile-a/1/chat-7/${encodeURIComponent(source)}`
    ))
    const { container } = render(<SafeHtmlMarkdownContent
      text={'<div align="center"><img src="media/robot_wbc.png" width="800" alt="DEMO ATLAS Header"><!-- hidden marker --></div>'}
      sessionId="chat-7"
      fold={false}
      resolveImageSource={resolveImageSource}
    />)

    const image = screen.getByRole('img', { name: 'DEMO ATLAS Header' })
    expect(resolveImageSource).toHaveBeenCalledWith('media/robot_wbc.png')
    expect(image).toHaveAttribute(
      'src',
      'agentsdock-media://workspace/profile-a/1/chat-7/media%2Frobot_wbc.png'
    )
    expect(image).toHaveAttribute('width', '800')
    expect(image.closest('div')).toHaveAttribute('align', 'center')
    expect(container.innerHTML).not.toContain('hidden marker')
  })

  it('removes executable HTML and unsafe attributes from trusted previews', () => {
    const resolveImageSource = vi.fn((source: string) => `agentsdock-media:${source}`)
    const { container } = render(<SafeHtmlMarkdownContent
      text={'<script>window.pwned = true</script><iframe src="https://example.com"></iframe><img src="media/safe.png" alt="Safe" onerror="window.pwned = true"><a href="javascript:window.pwned = true">unsafe</a>'}
      resolveImageSource={resolveImageSource}
    />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('img', { name: 'Safe' })).not.toHaveAttribute('onerror')
    expect(container.querySelector('a')).not.toHaveAttribute('href')
    expect(resolveImageSource).toHaveBeenCalledWith('media/safe.png')
  })

  it('copies the complete fenced block when its rendered message is folded', async () => {
    const code = `echo start\n${'x'.repeat(7000)}\necho done`
    render(<MarkdownContent text={`\`\`\`bash\n${code}\n\`\`\``} />)
    fireEvent.click(screen.getByTitle('Copy full code'))
    expect(writeClipboard).toHaveBeenCalledWith(code)
  })

  it('renders inline LaTeX with standard dollar delimiters', () => {
    const { container } = render(<MarkdownContent text={'Energy is $E = mc^2$.'} />)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('Energy is')
  })

  it('renders legacy display LaTeX delimiters used by existing agent messages', () => {
    const { container } = render(<MarkdownContent text={'\\[ h_t = \\mathrm{Fuse}(E_t) \\]'} />)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('Fuse')
  })

  it('renders multiline matrix equations from agent messages', () => {
    const equation = String.raw`$$v_{\text{G1}}=\frac{s}{100}
\begin{bmatrix}
1&0&0\\
0&0&-1\\
0&1&0
\end{bmatrix}
v_{\text{OBJ}}$$`
    const { container } = render(<MarkdownContent text={equation} />)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.textContent).toContain('OBJ')
  })

  it('shows malformed equations as a quiet readable fallback', () => {
    const { container } = render(<MarkdownContent text={String.raw`$$\frac{1}{$$`} />)
    const fallback = container.querySelector('.math-fallback')
    expect(fallback).not.toBeNull()
    expect(fallback?.getAttribute('style')).toBeNull()
    expect(fallback?.textContent).toContain('\\frac')
  })

  it('keeps LaTeX delimiters literal inside fenced code', () => {
    const { container } = render(<MarkdownContent text={'```tex\n\\[ h_t = 1 \\]\n```'} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('\\[ h_t = 1 \\]')
  })
})
