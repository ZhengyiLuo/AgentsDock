import { memo, useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, ChevronDown, ChevronUp, Copy, FileCode2 } from 'lucide-react'
import type { AgentFile } from '@shared/types'

const COLLAPSED_CHARACTERS = 6300
const COLLAPSED_LINES = 72
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

interface MarkdownContentProps {
  text: string; files?: AgentFile[]; sessionId?: string; compact?: boolean; fold?: boolean
}

export const MarkdownContent = memo(function MarkdownContent({ text, files = [], sessionId, compact = false, fold = true }: MarkdownContentProps) {
  const [expanded, setExpanded] = useState(false)
  const normalized = useMemo(() => stripDecorativeEmojiPrefixes(text), [text])
  const clipped = useMemo(() => clipText(normalized), [normalized])
  const shouldFold = fold && clipped.hidden > 0
  const shown = shouldFold && !expanded ? clipped.text : normalized
  const onLink = useCallback((event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    event.preventDefault()
    if (!href) return
    if (/^(?:https?:\/\/|mailto:)/i.test(href)) { void window.agentsDock.native.openExternal(href); return }
    if (href.startsWith('#')) return
    const clean = decodeURIComponent(href.replace(/^file:\/\//, '')).replace(/^\.\//, '')
    const file = files.find(candidate => candidate.path === clean || candidate.filename === clean || candidate.path?.endsWith(`/${clean}`))
    if (file) { void window.agentsDock.files.open(file); return }
    if (sessionId) void window.agentsDock.files.openLinked(sessionId, href)
  }, [files, sessionId])
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => <a href={href} onClick={event => onLink(event, href)}>{children}</a>,
    code: ({ className, children, ...props }) => className
      ? <code className={className} {...props}>{children}</code>
      : <code className="inline-code" {...props}>{children}</code>,
    pre: ({ children }) => <CodeBlock fullSource={normalized}>{children}</CodeBlock>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    input: props => <input {...props} readOnly />
  }), [normalized, onLink])
  return (
    <div className={`markdown ${compact ? 'compact' : ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >{shown}</ReactMarkdown>
      {shouldFold && (
        <button className="fold-notice" onClick={() => setExpanded(value => !value)}>
          <FileCode2 size={13} />
          <strong>{expanded ? 'Full text shown inline' : `${clipped.hidden.toLocaleString()} characters hidden`}</strong>
          <span>Copy always uses the complete message.</span>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
    </div>
  )
}, markdownContentPropsEqual)

function markdownContentPropsEqual(previous: MarkdownContentProps, next: MarkdownContentProps): boolean {
  if (previous.text !== next.text || previous.sessionId !== next.sessionId ||
    (previous.compact ?? false) !== (next.compact ?? false) || (previous.fold ?? true) !== (next.fold ?? true)) return false
  const previousFiles = previous.files ?? []
  const nextFiles = next.files ?? []
  return previousFiles.length === nextFiles.length && previousFiles.every((file, index) => file.id === nextFiles[index]?.id)
}

function CodeBlock({ children, fullSource }: { children: ReactNode; fullSource: string }) {
  const [copied, setCopied] = useState(false)
  const visibleText = textFromNode(children).replace(/\n$/, '')
  const text = fullCodeForVisible(fullSource, visibleText)
  const copy = async () => {
    await navigator.clipboard.writeText(normalizeShellContinuations(text))
    setCopied(true); window.setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>code</span><button title="Copy full code" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
      <pre>{children}</pre>
    </div>
  )
}

function fullCodeForVisible(source: string, visible: string): string {
  const blocks = [...source.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\1(?:\n|$)|$)/g)]
  const match = blocks.find(candidate => {
    const body = candidate[2].replace(/\n$/, '')
    return body === visible || body.startsWith(visible) || visible.startsWith(body)
  })
  return (match?.[2] ?? visible).replace(/\n$/, '')
}

function clipText(text: string): { text: string; hidden: number } {
  const lines = text.split('\n')
  let visible = lines.slice(0, COLLAPSED_LINES).join('\n')
  if (visible.length > COLLAPSED_CHARACTERS) visible = visible.slice(0, COLLAPSED_CHARACTERS)
  return { text: visible.trimEnd(), hidden: Math.max(0, text.length - visible.length) }
}

function stripDecorativeEmojiPrefixes(text: string): string {
  return text.replace(/^[ \t]*(?::[A-Za-z0-9_+\-]+:[ \t]*)+/gm, '')
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (node && typeof node === 'object' && 'props' in node) return textFromNode((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function normalizeShellContinuations(text: string): string {
  return text.replace(/\\\\(?=\s*\n)/g, '\\')
}
