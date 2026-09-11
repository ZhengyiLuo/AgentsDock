import type { Palette } from '../theme'
import {
  MARKDOWN_TABLE_MAX_LAYOUT_COLUMNS,
  MARKDOWN_TABLE_MAX_WIDTH,
  MARKDOWN_TABLE_MIN_COLUMN_WIDTH,
  MARKDOWN_TABLE_MIN_WIDTH,
  createMarkdownStyle,
  markdownTableColumnCount,
  markdownTableMinimumWidth,
} from './markdown'
import { scaleChatFont } from './typography'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const lightPalette: Palette = {
  background: '#f6f7f8', surface: '#ffffff', raised: '#eef0f2', border: '#d9dce1',
  text: '#18191b', muted: '#686b72', blue: '#0879f9', green: '#168c4b',
  red: '#d92d38', orange: '#c66b14', yellow: '#8d7200', user: '#dff5e7', queued: '#fff6cf',
}
const darkPalette: Palette = {
  background: '#101112', surface: '#18191b', raised: '#202225', border: '#2b2d31',
  text: '#f4f4f5', muted: '#9a9ca2', blue: '#2f8cff', green: '#28c76f',
  red: '#ff5d64', orange: '#ff9f43', yellow: '#e2bd38', user: '#163f2a', queued: '#3a3214',
}

const lightStyle = createMarkdownStyle(lightPalette, 1)
assert(lightStyle.code_block?.backgroundColor === lightPalette.raised, 'light code blocks must use the light raised surface')
assert(lightStyle.fence?.backgroundColor === lightPalette.raised, 'light fenced blocks must use the light raised surface')
assert(lightStyle.code_inline?.color === lightPalette.text, 'light inline code must remain readable')
assert(lightStyle.list_item?.width === '100%', 'list rows must own a bounded width')
assert(lightStyle.ordered_list_content?.minWidth === 0, 'ordered-list content must be allowed to shrink below its intrinsic width')
assert(lightStyle.bullet_list_content?.minWidth === 0, 'bullet-list content must be allowed to shrink below its intrinsic width')
assert(lightStyle.textgroup?.width === '100%', 'selectable Markdown text must measure against its rendered slot')
assert(lightStyle.textgroup?.maxWidth === '100%', 'selectable Markdown text must not overflow an indented list slot')
assert(lightStyle.table?.marginBottom === 0, 'the horizontal table wrapper must own block spacing')

const tableNode = {
  type: 'table',
  children: [
    { type: 'thead', children: [{ type: 'tr', children: [{ type: 'th' }, { type: 'th' }, { type: 'th' }] }] },
    { type: 'tbody', children: [{ type: 'tr', children: [{ type: 'td' }, { type: 'td' }] }] },
  ],
}
assert(markdownTableColumnCount(tableNode) === 3, 'table layout must use the widest parsed row')
assert(markdownTableColumnCount({ type: 'table', children: [] }) === 1, 'empty tables need a safe minimum layout column')
assert(
  markdownTableMinimumWidth(3, 1) === MARKDOWN_TABLE_MIN_COLUMN_WIDTH * 3,
  'each Markdown table column must receive a readable minimum width',
)
assert(
  markdownTableMinimumWidth(1, 1) === MARKDOWN_TABLE_MIN_WIDTH,
  'narrow tables must still fill a readable phone-width surface',
)
assert(
  markdownTableMinimumWidth(3, 1.2) > markdownTableMinimumWidth(3, 1),
  'table column width must respect the mobile font scale',
)
assert(
  markdownTableMinimumWidth(Number.POSITIVE_INFINITY, 1) === MARKDOWN_TABLE_MIN_WIDTH,
  'invalid table widths must fail closed to one column',
)
assert(
  markdownTableMinimumWidth(MARKDOWN_TABLE_MAX_LAYOUT_COLUMNS + 10, 1.4) === MARKDOWN_TABLE_MAX_WIDTH,
  'pathological tables must have a bounded native layout width',
)

const darkStyle = createMarkdownStyle(darkPalette, 1)
assert(darkStyle.code_block?.backgroundColor === darkPalette.raised, 'dark code blocks must follow the active palette')
assert(darkStyle.body?.color === darkPalette.text, 'dark Markdown text must remain readable')

const scaledStyle = createMarkdownStyle(darkPalette, 1.2)
assert(
  Number(scaledStyle.paragraph?.fontSize) > Number(darkStyle.paragraph?.fontSize),
  'Markdown must respect the mobile chat font scale',
)

assert(JSON.stringify(darkStyle) === JSON.stringify(createMarkdownStyle(darkPalette, 1, false)), 'omitting compact must preserve the default Markdown styles')
assert(darkStyle.body?.fontSize === 15.5 && darkStyle.body?.lineHeight === 23, 'default body typography must remain unchanged')
assert(darkStyle.heading1?.fontSize === 23 && darkStyle.fence?.fontSize === 12.5, 'default heading and code typography must remain unchanged')
for (const scale of [0.8, 1, 1.2, 1.4]) {
  const compactStyle = createMarkdownStyle(darkPalette, scale, true)
  assert(compactStyle.body?.fontSize === scaleChatFont(12, scale), 'compact text must scale its own 12-point base with the original user preference')
  assert(compactStyle.body?.lineHeight === scaleChatFont(19, scale), 'compact line height must scale its own 19-point base')
  assert(compactStyle.paragraph?.fontSize === compactStyle.body?.fontSize, 'compact paragraphs must match body typography')
  assert(Number(compactStyle.heading1?.fontSize) > Number(compactStyle.heading2?.fontSize), 'compact heading hierarchy must remain visible')
  assert(Number(compactStyle.heading2?.fontSize) > Number(compactStyle.body?.fontSize), 'compact headings must remain larger than body text')
  assert(compactStyle.fence?.fontSize === scaleChatFont(11, scale), 'compact code must follow the original font scale')
  assert(compactStyle.fence?.lineHeight === scaleChatFont(16, scale), 'compact code needs readable line spacing')
  assert(compactStyle.th?.padding === 4 && compactStyle.td?.padding === 4, 'compact table cells must retain consistent padding')
  assert(compactStyle.textgroup?.width === '100%' && compactStyle.textgroup?.minWidth === 0, 'compact selectable text must retain bounded layout')
}
const compactTint = createMarkdownStyle({ ...lightPalette, text: '#503e68' }, 1, true)
assert(compactTint.body?.color === '#503e68' && compactTint.fence?.color === '#503e68', 'compact content must accept the conversation body color')
assert(compactTint.link?.color === lightPalette.blue, 'body tint must preserve distinguishable links')

console.log('Markdown theme and typography regressions passed')
