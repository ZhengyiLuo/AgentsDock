import type { Palette } from '../theme'
import { scaleChatFont } from './typography'

export const MARKDOWN_TABLE_MIN_COLUMN_WIDTH = 112
export const MARKDOWN_TABLE_MAX_LAYOUT_COLUMNS = 32
export const MARKDOWN_TABLE_MIN_WIDTH = 320
export const MARKDOWN_TABLE_MAX_WIDTH = 4096

type MarkdownTableNode = {
  type?: unknown
  children?: readonly MarkdownTableNode[]
}

export function markdownTableColumnCount(node: MarkdownTableNode): number {
  let maximum = 0

  const visit = (candidate: MarkdownTableNode): void => {
    if (candidate.type === 'tr') {
      const cells = candidate.children?.filter(child => child.type === 'th' || child.type === 'td').length ?? 0
      maximum = Math.max(maximum, cells)
    }
    candidate.children?.forEach(visit)
  }

  visit(node)
  return Math.min(MARKDOWN_TABLE_MAX_LAYOUT_COLUMNS, Math.max(1, maximum))
}

export function markdownTableMinimumWidth(columnCount: unknown, fontScale: number): number {
  const parsed = typeof columnCount === 'number' && Number.isFinite(columnCount)
    ? Math.floor(columnCount)
    : 1
  const bounded = Math.min(MARKDOWN_TABLE_MAX_LAYOUT_COLUMNS, Math.max(1, parsed))
  return Math.min(
    MARKDOWN_TABLE_MAX_WIDTH,
    Math.max(MARKDOWN_TABLE_MIN_WIDTH, scaleChatFont(bounded * MARKDOWN_TABLE_MIN_COLUMN_WIDTH, fontScale)),
  )
}

export function createMarkdownStyle(colors: Palette, fontScale: number, compact = false): Record<string, Record<string, string | number>> {
  const bodySize = scaleChatFont(compact ? 12 : 15.5, fontScale)
  const bodyLineHeight = scaleChatFont(compact ? 19 : 23, fontScale)
  const codeSize = scaleChatFont(compact ? 11 : 12.5, fontScale)
  const codeLineHeight = scaleChatFont(compact ? 16 : 18, fontScale)
  const blockSpacing = compact ? 6 : 10

  return {
    body: {
      color: colors.text,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
    },
    paragraph: {
      color: colors.text,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
      marginTop: 0,
      marginBottom: blockSpacing,
      minWidth: 0,
    },
    heading1: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 18 : 23, fontScale),
      lineHeight: scaleChatFont(compact ? 24 : 30, fontScale),
      fontWeight: '800',
      marginTop: compact ? 8 : 10,
      marginBottom: compact ? 6 : 8,
    },
    heading2: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 15 : 19, fontScale),
      lineHeight: scaleChatFont(compact ? 21 : 26, fontScale),
      fontWeight: '800',
      marginTop: compact ? 8 : 10,
      marginBottom: compact ? 5 : 7,
    },
    heading3: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 13.5 : 17, fontScale),
      lineHeight: scaleChatFont(compact ? 20 : 24, fontScale),
      fontWeight: '700',
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 4 : 6,
    },
    heading4: {
      color: colors.text,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
      fontWeight: '700',
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 4 : 6,
    },
    heading5: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, fontWeight: '700' },
    heading6: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, fontWeight: '700' },
    text: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    // react-native-markdown-display places list content in a flex row. Without
    // an explicit shrinkable width, iOS can measure the selectable UITextView
    // against the unindented paragraph width and then render it in the narrower
    // list slot. UIKit responds by tail-truncating the final wrapped line even
    // though numberOfLines is unlimited.
    textgroup: { flexShrink: 1, minWidth: 0, maxWidth: '100%', width: '100%' },
    link: { color: colors.blue, textDecorationLine: 'underline' },
    strong: { color: colors.text },
    em: { color: colors.text },
    code_inline: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
      fontFamily: 'Menlo',
      fontSize: codeSize,
    },
    code_block: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: compact ? 8 : 10,
      fontFamily: 'Menlo',
      fontSize: codeSize,
      lineHeight: codeLineHeight,
      marginBottom: blockSpacing,
    },
    fence: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: compact ? 8 : 10,
      fontFamily: 'Menlo',
      fontSize: codeSize,
      lineHeight: codeLineHeight,
      marginBottom: blockSpacing,
    },
    blockquote: {
      backgroundColor: colors.raised,
      borderColor: colors.blue,
      borderLeftWidth: 3,
      paddingHorizontal: compact ? 8 : 10,
      marginBottom: blockSpacing,
    },
    list_item: { flexDirection: 'row', justifyContent: 'flex-start', minWidth: 0, width: '100%' },
    bullet_list_icon: { color: colors.muted, marginLeft: 8, marginRight: 8 },
    bullet_list_content: { flex: 1, flexShrink: 1, minWidth: 0 },
    ordered_list_icon: { color: colors.muted, marginLeft: 8, marginRight: 8 },
    ordered_list_content: { flex: 1, flexShrink: 1, minWidth: 0 },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 8 : 12,
    },
    table: {
      borderColor: colors.border,
      borderWidth: 1,
      marginBottom: 0,
    },
    tr: { borderBottomWidth: 1, borderColor: colors.border, flexDirection: 'row' },
    th: { flex: 1, padding: compact ? 4 : 6, backgroundColor: colors.raised },
    td: { flex: 1, padding: compact ? 4 : 6, backgroundColor: colors.surface },
  }
}
