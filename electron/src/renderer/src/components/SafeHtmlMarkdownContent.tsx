import type { ComponentProps } from 'react'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as RehypeSanitizeOptions } from 'rehype-sanitize'
import type { Options as ReactMarkdownOptions } from 'react-markdown'
import { MarkdownContent } from './MarkdownContent'

const SAFE_HTML_SCHEMA: RehypeSanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'agentsdock-media', 'data']
  }
}

const SAFE_HTML_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, SAFE_HTML_SCHEMA],
  rehypeHighlight,
  rehypeKatex
]

type SafeHtmlMarkdownContentProps = Omit<ComponentProps<typeof MarkdownContent>, 'rehypePlugins'>

export default function SafeHtmlMarkdownContent(props: SafeHtmlMarkdownContentProps) {
  return <MarkdownContent {...props} rehypePlugins={SAFE_HTML_REHYPE_PLUGINS} />
}
