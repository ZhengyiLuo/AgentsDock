// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale, type Locale } from '../lib/i18n'
import { createContext, memo, useCallback, useContext, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type Options as ReactMarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Check, ChevronDown, ChevronUp, Copy, FileCode2 } from 'lucide-react'
import { isEditorTextFile } from '@shared/file-content-type'
import { internalWorkspaceLinkURL } from '@shared/workspace-link-url'
import { normalizeSecurePeerJoinTarget } from '@shared/secure-peer'
import type { AgentFile, ChatReference, TeamReference } from '@shared/types'
import { chatReferenceDisplayText, parseStoredChatReferences } from '../lib/chat-references'
import { saveAgentFile } from '../lib/file-actions'
import { parseStoredTeamReferences, teamReferenceText } from '../lib/team-references'
import { openTeamMessageLink, parseTeamMessageLink } from '../lib/team-message-links'
import {
  parseWorkspaceCodeReference,
  requestOpenAgentFile,
  requestOpenWorkspaceReference
} from '../lib/workspace-file-links'
import { useAppStore } from '../store/app-store'

const COLLAPSED_CHARACTERS = 6300
const COLLAPSED_LINES = 72
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeHighlight, rehypeKatex]
const EMPTY_FILES: AgentFile[] = []
const EMPTY_CHAT_REFERENCES: readonly ChatReference[] = []
const EMPTY_TEAM_REFERENCES: readonly TeamReference[] = []
const MarkdownLocaleContext = createContext<Locale>('en')

interface MarkdownContentProps {
  text: string
  files?: AgentFile[]
  sessionId?: string
  inlineChatReferences?: readonly ChatReference[]
  inlineTeamReferences?: readonly TeamReference[]
  onChatReferenceClick?: (reference: ChatReference) => void
  compact?: boolean
  fold?: boolean
  rehypePlugins?: NonNullable<ReactMarkdownOptions['rehypePlugins']>
  resolveImageSource?: (source: string) => string | undefined
  preserveEnglishUI?: boolean
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  files = EMPTY_FILES,
  sessionId,
  inlineChatReferences = EMPTY_CHAT_REFERENCES,
  inlineTeamReferences = EMPTY_TEAM_REFERENCES,
  onChatReferenceClick,
  compact = false,
  fold = true,
  rehypePlugins = REHYPE_PLUGINS,
  resolveImageSource,
  preserveEnglishUI = false
}: MarkdownContentProps) {
  const locale = useLocale()
  const uiLocale = preserveEnglishUI ? 'en' : locale
  const [expanded, setExpanded] = useState(false)
  const preparedChatReferences = useMemo(
    () => prepareInlineChatReferences(text, inlineChatReferences, inlineTeamReferences, sessionId),
    [inlineChatReferences, inlineTeamReferences, sessionId, text]
  )
  const normalized = useMemo(
    () => normalizeMathDelimiters(stripDecorativeEmojiPrefixes(preparedChatReferences.text)),
    [preparedChatReferences.text]
  )
  const restoredNormalized = useMemo(
    () => restoreInlineChatReferenceText(normalized, preparedChatReferences.markers),
    [normalized, preparedChatReferences.markers]
  )
  const clipped = useMemo(
    () => clipText(normalized, preparedChatReferences.markers),
    [normalized, preparedChatReferences.markers]
  )
  const shouldFold = fold && clipped.hidden > 0
  const shown = shouldFold && !expanded ? clipped.text : normalized
  const remarkPlugins = useMemo<NonNullable<ReactMarkdownOptions['remarkPlugins']>>(() => (
    preparedChatReferences.markers.length > 0
      ? [...REMARK_PLUGINS, remarkInlineChatReferences(preparedChatReferences.markers)]
      : REMARK_PLUGINS
  ) as NonNullable<ReactMarkdownOptions['remarkPlugins']>, [preparedChatReferences.markers])
  const onLink = useCallback((event: MouseEvent<HTMLElement>, href?: string) => {
    event.preventDefault()
    if (!href) return
    if (openTeamMessageLink(href)) return
    if (/^(?:https?:\/\/|mailto:)/i.test(href)) { void window.agentsDock.native.openExternal(href); return }
    if (canonicalSecurePeerInvite(href)) {
      window.dispatchEvent(new CustomEvent('agentsdock:open-secure-peer-invite', { detail: { invite: href } }))
      return
    }
    if (href.startsWith('#')) return
    const decoded = decodeLinkTarget(href)
    const reference = parseWorkspaceCodeReference(decoded)
    const clean = (reference?.path ?? decoded).replace(/^\.\//, '')
    const file = files.find(candidate => (
      candidate.path === clean
      || candidate.source_path === clean
      || candidate.filename === clean
      || candidate.path?.endsWith(`/${clean}`)
      || candidate.source_path?.endsWith(`/${clean}`)
    ))
    if (file) {
      if (!sessionId) return
      if (window.agentsDock.sharedChat) void saveAgentFile(sessionId, file)
      else if (isEditorTextFile(file)) requestOpenAgentFile(sessionId, file, reference ?? {})
      else void window.agentsDock.files.open(sessionId, file)
      return
    }
    if (sessionId && reference) {
      requestOpenWorkspaceReference(sessionId, reference)
      return
    }
    if (sessionId) void window.agentsDock.files.openLinked(sessionId, href)
  }, [files, sessionId])
  // Locale travels through context so updating labels does not replace these
  // React component types and discard selection, scroll or code-block state.
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => isWorkspaceLink(href)
      ? <a
        href={internalWorkspaceLinkURL(href!)}
        className="workspace-reference-link"
        title={`Open ${decodeLinkTarget(href!)}`}
        onClick={event => onLink(event, href)}
      >{children}</a>
      : <a href={href} onClick={event => onLink(event, href)}>{children}</a>,
    img: ({ src, alt, node: _node, ...props }) => {
      const resolved = src && resolveImageSource ? resolveImageSource(src) : src
      return resolved ? <img {...props} src={resolved} alt={alt ?? ''} loading="lazy" /> : null
    },
    code: ({ className, children, node, ...props }) => {
      if (className) return <code className={className} {...props}>{children}</code>
      const value = textFromNode(children)
      const isInline = (
        node?.position?.start.line === node?.position?.end.line
        && !isIndentedCodeBlock(shown, node?.position)
      )
      const isLinkLabel = isCodeInsideMarkdownLink(shown, node?.position)
      const reference = sessionId && isInline && !isLinkLabel
        ? parseWorkspaceCodeReference(value)
        : null
      return reference
        ? <button
          type="button"
          className="inline-code inline-code-link"
          title={`Open ${reference.path}${reference.line ? ` at line ${reference.line}` : ''}`}
          onClick={() => { if (sessionId) requestOpenWorkspaceReference(sessionId, reference) }}
        >{children}</button>
        : <code className="inline-code" {...props}>{children}</code>
    },
    pre: ({ children }) => <CodeBlock fullSource={restoredNormalized}>{children}</CodeBlock>,
    span: function MarkdownSpan({ className, children, ...props }) {
      const uiLocale = useContext(MarkdownLocaleContext)
      const referenceIndex = inlineChatReferenceIndex(className)
      const marker = referenceIndex === null ? undefined : preparedChatReferences.markers[referenceIndex]
      if (marker) {
        const insideMarkdownLink = className?.split(/\s+/).includes('inside-markdown-link') === true
        if (marker.kind === 'team') {
          const title = insideMarkdownLink
            ? t('teamNetwork.reference.insideLink', { name: marker.displayText }, uiLocale)
            : teamReferenceTitle(marker.reference, uiLocale)
          return <span className={className} title={title} aria-label={title}>{children}</span>
        }
        const remote = marker.reference.target_kind === 'secure_peer'
        const title = insideMarkdownLink
          ? `${marker.displayText} · Route hint inside link text`
          : remote
          ? `${marker.displayText} · Secure route on paired server`
          : `${marker.displayText} · Route hint`
        if (insideMarkdownLink) {
          return <span className={className} title={title}>{children}</span>
        }
        if (remote || !onChatReferenceClick) {
          return <span className={className} title={title} aria-label={title}>{children}</span>
        }
        const activate = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
          event.preventDefault()
          event.stopPropagation()
          onChatReferenceClick(marker.reference)
        }
        return <span
          className={className}
          role="link"
          tabIndex={0}
          title={title}
          aria-label={t("ui.MarkdownContent.route_hint_for_0284c82", { "chat": String(marker.reference.display_title_snapshot) }, uiLocale)}
          onClick={activate}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event)
          }}
        >{children}</span>
      }
      return className?.split(/\s+/).includes('katex-error')
        ? <code className="math-fallback" title={t("ui.MarkdownContent.this_equation_could_not_be_rendered_0390d07", undefined, uiLocale)}>{children}</code>
        : <span className={className} {...props}>{children}</span>
    },
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    input: props => <input {...props} readOnly />
  }), [onChatReferenceClick, onLink, preparedChatReferences.markers, resolveImageSource, restoredNormalized, sessionId, shown])
  return (
    <div className={`markdown ${compact ? 'compact' : ''}`}>
      <MarkdownLocaleContext.Provider value={uiLocale}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={secureMarkdownURL}
        >{shown}</ReactMarkdown>
      </MarkdownLocaleContext.Provider>
      {shouldFold && (
        <button className="fold-notice" onClick={() => setExpanded(value => !value)}>
          <FileCode2 size={13} />
          <strong>{expanded ? t("ui.MarkdownContent.MarkdownContent.full_text_shown_inline_4b88701", undefined, uiLocale) : t("ui.MarkdownContent.MarkdownContent.characters_hidden_28f43d6", { "count": String(clipped.hidden.toLocaleString()) }, uiLocale)}</strong>
          <span>{t("ui.MarkdownContent.MarkdownContent.copy_always_uses_the_complete_message_a2782f5", undefined, uiLocale)}</span>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
    </div>
  )
}, markdownContentPropsEqual)

function canonicalSecurePeerInvite(value: string): boolean {
  if (!value.startsWith('agentsdock://')) return false
  try { return normalizeSecurePeerJoinTarget(value).expectedCaFingerprint !== null } catch { return false }
}

function secureMarkdownURL(value: string): string {
  return parseTeamMessageLink(value) || canonicalSecurePeerInvite(value) ? value : defaultUrlTransform(value)
}

function markdownContentPropsEqual(previous: MarkdownContentProps, next: MarkdownContentProps): boolean {
  if (previous.text !== next.text || previous.sessionId !== next.sessionId ||
    previous.onChatReferenceClick !== next.onChatReferenceClick ||
    previous.resolveImageSource !== next.resolveImageSource ||
    (previous.preserveEnglishUI ?? false) !== (next.preserveEnglishUI ?? false) ||
    previous.rehypePlugins !== next.rehypePlugins ||
    (previous.compact ?? false) !== (next.compact ?? false) || (previous.fold ?? true) !== (next.fold ?? true) ||
    !chatReferencesEqual(previous.inlineChatReferences ?? [], next.inlineChatReferences ?? []) ||
    !teamReferencesEqual(previous.inlineTeamReferences ?? [], next.inlineTeamReferences ?? [])) return false
  const previousFiles = previous.files ?? []
  const nextFiles = next.files ?? []
  return previousFiles.length === nextFiles.length && previousFiles.every((file, index) => {
    const candidate = nextFiles[index]
    return file.id === candidate?.id
      && file.filename === candidate.filename
      && file.path === candidate.path
      && file.source_path === candidate.source_path
      && file.content_type === candidate.content_type
  })
}

function chatReferencesEqual(previous: readonly ChatReference[], next: readonly ChatReference[]): boolean {
  return previous.length === next.length && previous.every((reference, index) => {
    const candidate = next[index]
    return reference.session_id === candidate?.session_id
      && reference.display_title_snapshot === candidate.display_title_snapshot
      && reference.source_text_start === candidate.source_text_start
      && reference.source_text_end === candidate.source_text_end
      && reference.action === candidate.action
      && reference.grant_intent === candidate.grant_intent
      && reference.route_action === candidate.route_action
      && reference.target_kind === candidate.target_kind
      && reference.target_server_identity === candidate.target_server_identity
      && reference.target_connection_id === candidate.target_connection_id
      && reference.target_route_id === candidate.target_route_id
      && reference.target_route_revision === candidate.target_route_revision
  })
}

function teamReferencesEqual(previous: readonly TeamReference[], next: readonly TeamReference[]): boolean {
  return previous.length === next.length && previous.every((reference, index) => {
    const candidate = next[index]
    return reference.kind === candidate?.kind
      && ('recipient_kind' in reference ? reference.recipient_kind : undefined)
        === (candidate && 'recipient_kind' in candidate ? candidate.recipient_kind : undefined)
      && reference.team_id === candidate.team_id
      && reference.target_id === candidate.target_id
      && reference.display_name_snapshot === candidate.display_name_snapshot
      && reference.source_text_start === candidate.source_text_start
      && reference.source_text_end === candidate.source_text_end
      && reference.grant_intent === candidate.grant_intent
  })
}

function teamReferenceTitle(reference: TeamReference, locale: Locale): string {
  const key = reference.kind === 'skill' ? 'teamNetwork.reference.skill'
    : reference.recipient_kind === 'all_servers' ? 'teamNetwork.reference.allInboxes'
      : reference.recipient_kind === 'server' ? 'teamNetwork.reference.serverInbox'
        : reference.recipient_kind === 'human' ? 'teamNetwork.reference.person' : 'teamNetwork.bulletin'
  return `${teamReferenceText(reference)} · ${t(key, undefined, locale)}`
}

type InlineChatReferenceMarker = {
  marker: string
  displayText: string
  kind: 'chat'
  reference: ChatReference
} | {
  marker: string
  displayText: string
  kind: 'team'
  reference: TeamReference
}

interface MarkdownAstNode {
  type: string
  value?: string
  children?: MarkdownAstNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
  }
}

function prepareInlineChatReferences(
  text: string,
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[],
  sourceSessionId?: string
): { text: string; markers: InlineChatReferenceMarker[] } {
  const valid: Array<
    { kind: 'chat'; reference: ChatReference }
    | { kind: 'team'; reference: TeamReference }
  > = [
    ...parseStoredChatReferences(chatReferences, text, sourceSessionId)
      .map(reference => ({ kind: 'chat' as const, reference })),
    ...parseStoredTeamReferences(teamReferences, text)
      .map(reference => ({ kind: 'team' as const, reference }))
  ].sort((left, right) => (
    left.reference.source_text_start - right.reference.source_text_start
    || left.reference.source_text_end - right.reference.source_text_end
  ))
  if (valid.length === 0) return { text, markers: [] }

  const markers: InlineChatReferenceMarker[] = []
  let nextMarkerCodePoint = 0xe000
  let output = ''
  let cursor = 0
  for (const item of valid) {
    const { reference } = item
    while (
      nextMarkerCodePoint <= 0xf8ff
      && (text.includes(String.fromCharCode(nextMarkerCodePoint))
        || markers.some(candidate => candidate.marker[0] === String.fromCharCode(nextMarkerCodePoint)))
    ) nextMarkerCodePoint += 1
    if (nextMarkerCodePoint > 0xf8ff) break

    const markerCharacter = String.fromCharCode(nextMarkerCodePoint)
    nextMarkerCodePoint += 1
    const displayText = item.kind === 'chat'
      ? chatReferenceDisplayText(text, item.reference)
      : teamReferenceText(item.reference)
    const marker = markerCharacter.repeat(reference.source_text_end - reference.source_text_start)
    output += text.slice(cursor, reference.source_text_start)
    output += marker
    cursor = reference.source_text_end
    markers.push({ marker, displayText, kind: item.kind, reference } as InlineChatReferenceMarker)
  }
  output += text.slice(cursor)
  return { text: output, markers }
}

function remarkInlineChatReferences(markers: readonly InlineChatReferenceMarker[]) {
  return () => (tree: MarkdownAstNode) => restoreInlineChatReferenceNodes(tree, markers)
}

function restoreInlineChatReferenceNodes(
  node: MarkdownAstNode,
  markers: readonly InlineChatReferenceMarker[],
  insideMarkdownLink = false
): void {
  if (!node.children) {
    // Code/math leaves cannot contain inline children. Restore the authored
    // marker there as ordinary text so an unusual @Chat inside code never
    // leaks the private placeholder or becomes an interactive route.
    if (typeof node.value === 'string' && node.type !== 'text') {
      node.value = restoreInlineChatReferenceText(node.value, markers)
    }
    return
  }
  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      restoreInlineChatReferenceNodes(child, markers, insideMarkdownLink || child.type === 'link')
      return [child]
    }
    return splitInlineChatReferenceText(child.value, markers, insideMarkdownLink)
  })
}

function splitInlineChatReferenceText(
  value: string,
  markers: readonly InlineChatReferenceMarker[],
  insideMarkdownLink = false
): MarkdownAstNode[] {
  const output: MarkdownAstNode[] = []
  let cursor = 0
  while (cursor < value.length) {
    let nextIndex = -1
    let nextMarkerIndex = -1
    markers.forEach((candidate, index) => {
      const found = value.indexOf(candidate.marker, cursor)
      if (found >= 0 && (nextIndex < 0 || found < nextIndex)) {
        nextIndex = found
        nextMarkerIndex = index
      }
    })
    if (nextIndex < 0 || nextMarkerIndex < 0) break
    if (nextIndex > cursor) output.push({ type: 'text', value: value.slice(cursor, nextIndex) })
    const candidate = markers[nextMarkerIndex]
    output.push({
      type: 'emphasis',
      children: [{ type: 'text', value: candidate.displayText }],
      data: {
        hName: 'span',
        hProperties: {
          className: [
            'timeline-inline-chat-reference',
            candidate.kind === 'chat' ? 'action-route' : 'action-team',
            ...(candidate.kind === 'team' ? ['team'] : []),
            `chat-reference-${nextMarkerIndex}`,
            ...(candidate.kind === 'chat' && candidate.reference.target_kind === 'secure_peer' ? ['remote'] : []),
            ...(insideMarkdownLink ? ['inside-markdown-link'] : [])
          ]
        }
      }
    })
    cursor = nextIndex + candidate.marker.length
  }
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) })
  return output.length > 0 ? output : [{ type: 'text', value }]
}

function restoreInlineChatReferenceText(
  value: string,
  markers: readonly InlineChatReferenceMarker[]
): string {
  return markers.reduce(
    (restored, candidate) => restored.replaceAll(candidate.marker, candidate.displayText),
    value
  )
}

function inlineChatReferenceIndex(className?: string): number | null {
  const value = /(?:^|\s)chat-reference-(\d+)(?:\s|$)/u.exec(className ?? '')?.[1]
  if (value === undefined) return null
  const index = Number(value)
  return Number.isSafeInteger(index) && index >= 0 ? index : null
}

function CodeBlock({ children, fullSource }: { children: ReactNode; fullSource: string }) {
  const uiLocale = useContext(MarkdownLocaleContext)
  const [copied, setCopied] = useState(false)
  const visibleText = textFromNode(children).replace(/\n$/, '')
  const text = fullCodeForVisible(fullSource, visibleText)
  const copy = async () => {
    try {
      await window.agentsDock.native.writeClipboard(normalizeShellContinuations(text))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>code</span><button type="button" title={t("ui.MarkdownContent.CodeBlock.copy_full_code_e0bb5a9", undefined, uiLocale)} onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
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

function clipText(
  text: string,
  markers: readonly InlineChatReferenceMarker[] = []
): { text: string; hidden: number } {
  const lines = text.split('\n')
  let visible = lines.slice(0, COLLAPSED_LINES).join('\n')
  if (visible.length > COLLAPSED_CHARACTERS) visible = visible.slice(0, COLLAPSED_CHARACTERS)
  // Never expose a partial private marker at the fold boundary. The complete
  // inline route appears after expansion instead.
  for (const candidate of markers) {
    const start = text.indexOf(candidate.marker)
    if (start >= 0 && start < visible.length && start + candidate.marker.length > visible.length) {
      visible = visible.slice(0, start)
    }
  }
  return { text: visible.trimEnd(), hidden: Math.max(0, text.length - visible.length) }
}

function stripDecorativeEmojiPrefixes(text: string): string {
  return text.replace(/^[ \t]*(?::[A-Za-z0-9_+\-]+:[ \t]*)+/gm, '')
}

function normalizeMathDelimiters(text: string): string {
  let output = ''
  let index = 0
  let lineStart = true
  let fence: { character: string; length: number } | null = null
  let inlineTicks = 0

  while (index < text.length) {
    if (lineStart) {
      const lineEnd = text.indexOf('\n', index)
      const end = lineEnd < 0 ? text.length : lineEnd
      const marker = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(index, end))?.[1]
      if (fence || marker) {
        if (marker) {
          if (!fence) fence = { character: marker[0], length: marker.length }
          else if (marker[0] === fence.character && marker.length >= fence.length) fence = null
        }
        output += text.slice(index, end)
        if (lineEnd >= 0) output += '\n'
        index = lineEnd < 0 ? text.length : lineEnd + 1
        lineStart = true
        continue
      }
    }

    if (text[index] === '`') {
      let runLength = 1
      while (text[index + runLength] === '`') runLength += 1
      inlineTicks = inlineTicks === 0 ? runLength : runLength === inlineTicks ? 0 : inlineTicks
      output += text.slice(index, index + runLength)
      index += runLength
      lineStart = false
      continue
    }

    if (inlineTicks === 0 && text.startsWith('\\[', index)) {
      const closing = text.indexOf('\\]', index + 2)
      if (closing >= 0) {
        output += `\n\n$$\n${text.slice(index + 2, closing).trim()}\n$$\n\n`
        index = closing + 2
        lineStart = text[index - 1] === '\n'
        continue
      }
    }

    if (inlineTicks === 0 && text.startsWith('$$', index) && text[index - 1] !== '\\') {
      const closing = text.indexOf('$$', index + 2)
      if (closing >= 0) {
        output += `\n\n$$\n${text.slice(index + 2, closing).trim()}\n$$\n\n`
        index = closing + 2
        lineStart = true
        continue
      }
    }

    if (inlineTicks === 0 && text.startsWith('\\(', index)) {
      const closing = text.indexOf('\\)', index + 2)
      if (closing >= 0) {
        output += `$${text.slice(index + 2, closing).trim()}$`
        index = closing + 2
        lineStart = text[index - 1] === '\n'
        continue
      }
    }

    const character = text[index]
    output += character
    index += 1
    lineStart = character === '\n'
  }

  return output
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (node && typeof node === 'object' && 'props' in node) return textFromNode((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function decodeLinkTarget(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//, '')
  try {
    return decodeURIComponent(withoutScheme)
  } catch {
    return withoutScheme
  }
}

function isWorkspaceLink(href?: string): boolean {
  if (!href) return false
  if (/^agentsdock:/i.test(href)) return false
  return !/^(?:https?:\/\/|mailto:)/i.test(href)
    && !href.startsWith('#')
}

function isCodeInsideMarkdownLink(
  source: string,
  position?: { start: { offset?: number }; end: { offset?: number } }
): boolean {
  const start = position?.start.offset
  const end = position?.end.offset
  if (typeof start !== 'number' || typeof end !== 'number') return false

  const labelStart = source.lastIndexOf('[', start)
  if (labelStart < 0 || source.slice(labelStart + 1, start).includes(']')) return false
  return /^\s*\]\s*(?:\(|\[)/.test(source.slice(end))
}

function isIndentedCodeBlock(
  source: string,
  position?: { start: { offset?: number } }
): boolean {
  const start = position?.start.offset
  if (typeof start !== 'number') return false
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  return /^(?: {4}|\t)/.test(source.slice(lineStart))
}

function normalizeShellContinuations(text: string): string {
  return text.replace(/\\\\(?=\s*\n)/g, '\\')
}
