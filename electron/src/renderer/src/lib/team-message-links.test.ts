import { describe, expect, it } from 'vitest'
import { escapeTeamMessageLinkLabel, parseTeamMessageLink, teamMessageLinksInText, teamMessageLinkURL } from './team-message-links'

describe('Team message Markdown labels', () => {
  const target = { section: 'mail' as const, teamId: 'team-1', messageId: 'message-1', mailboxBox: 'inbox' as const, serverIdentity: 'server-1' }
  const href = teamMessageLinkURL(target)

  it.each([
    'Review [phase 1]',
    'Backslash \\ and [brackets] & more',
    '**Literal** _subject_ `code` <b>not HTML</b> &amp;',
    'Release 🚀 👩🏽‍💻 中文',
    'Trailing slash \\',
    'All punctuation !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
  ])('round-trips %j without changing the exact target or draft offsets', label => {
    const markdown = `[${escapeTeamMessageLinkLabel(label)}](${href})`
    const prefix = 'Existing draft\n\nRead '
    const source = `${prefix}${markdown} from @@Studio`
    const links = teamMessageLinksInText(source)
    expect(links).toEqual([{ href, label, start: prefix.length, end: prefix.length + markdown.length }])
    expect(parseTeamMessageLink(links[0].href)).toEqual(target)
    expect(source.slice(links[0].start, links[0].end)).toBe(markdown)
    expect(source).toBe(`${prefix}${markdown} from @@Studio`)
  })

  it('preserves existing unescaped labels and non-Markdown backslashes', () => {
    expect(teamMessageLinksInText(`[Review request](${href})`)[0].label).toBe('Review request')
    expect(teamMessageLinksInText(`[Path \\name](${href})`)[0].label).toBe('Path \\name')
  })

  it('does not interpret a bracket or URL embedded in a subject as another target', () => {
    const label = `[fake](agentsdock://team-message?section=mail&teamId=wrong&messageId=wrong)`
    expect(teamMessageLinksInText(`[${escapeTeamMessageLinkLabel(label)}](${href})`)).toEqual([
      { href, label, start: 0, end: `[${escapeTeamMessageLinkLabel(label)}](${href})`.length }
    ])
  })

  it('rejects invalid targets and multiline labels', () => {
    expect(teamMessageLinksInText('[Subject](agentsdock://team-message?section=mail&teamId=team-1)')).toEqual([])
    expect(teamMessageLinksInText(`[Two\nlines](${href})`)).toEqual([])
    expect(teamMessageLinksInText(`[Two\\\nlines](${href})`)).toEqual([])
  })
})
