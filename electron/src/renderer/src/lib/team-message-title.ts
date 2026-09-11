import type { TeamMessageBase } from '@shared/team-network'

type TitledMail = Pick<TeamMessageBase, 'title' | 'sender'> & { body?: string; preview?: string }

const MAX_HEADING_POINTS = 120
const MAX_SOURCE_UNITS = 8_192
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** A display-only fallback for direct mail. Never write it back to the message. */
export function teamMailDisplayTitle(message: TitledMail): string {
  // Authored subjects are literal text, not Markdown or HTML.
  if (message.title?.trim()) return message.title
  const source = (message.body ?? message.preview ?? '').slice(0, MAX_SOURCE_UNITS).replace(/[\uD800-\uDBFF]$/, '')
  const text = stripHtml(source)
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (fence || /^\s*\[[^\]]+\]:\s*/.test(line)) continue
    const heading = readableLine(line)
    if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(heading)) return boundHeading(heading)
  }
  return boundHeading(`Message from ${message.sender.display_name}`)
}

function readableLine(line: string): string {
  return stripHtml(decodeEntities(line))
    // Keep link/image labels, including when a bounded server preview cuts off the target.
    .replace(/!?\[([^\]\n]*)\]\((?:\\.|[^()\\]|\([^()]*\))*\)/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^\n]*$/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/(?:https?:\/\/|mailto:|www\.)\S+/gi, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    .replace(/[*`~\[\]]/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*\||\|\s*$/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// This is a text projection, not an HTML sanitizer. Its output is rendered as text only.
function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, tag => /^<\/?(?:p|div|h[1-6]|li|br|hr)\b/i.test(tag) ? '\n' : '')
    .replace(/<\/?[a-z][^>\n]*$/gi, '')
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ''
  })
}

function boundHeading(value: string): string {
  if ([...value].length <= MAX_HEADING_POINTS) return value
  let title = ''
  let points = 0
  for (const { segment } of graphemes.segment(value)) {
    const length = [...segment].length
    if (points + length >= MAX_HEADING_POINTS) break
    title += segment
    points += length
  }
  return `${title.trimEnd()}…`
}
