import { createElement } from 'react'

/** Native rich-text boundary only; no request/store or action implementation. */
export function MarkdownContent(props: { value: string; fontScale?: number }) {
  return createElement('MarkdownContent', props, props.value)
}
