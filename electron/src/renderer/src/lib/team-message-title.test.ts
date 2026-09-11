import { describe, expect, it } from 'vitest'
import { teamMailDisplayTitle } from './team-message-title'

const sender = { kind: 'server' as const, id: 'server-1', display_name: 'Studio' }

describe('teamMailDisplayTitle', () => {
  it('preserves an authored title as literal text and leaves the source untouched', () => {
    const mail = Object.freeze({ title: '<b>**Release** & review</b>', body: 'A different heading', sender })
    expect(teamMailDisplayTitle(mail)).toBe('<b>**Release** & review</b>')
    expect(mail).toEqual({ title: '<b>**Release** & review</b>', body: 'A different heading', sender })
  })

  it.each([
    ['\n## Please review the **rollout**.\nMore context.', 'Please review the rollout.'],
    ['> - [x] Review `release_notes` today', 'Review release_notes today'],
    ['Read [the guide](https://example.com/a_(b)) today.', 'Read the guide today.'],
    ['Read [the guide](https://example.com/a_(b_(c))) today.', 'Read the guide'],
    ['Read [the guide](https://example.com/a-long-cut-off-target', 'Read the guide'],
    ['[guide]: https://example.com/private-target\nRead [the guide][guide].', 'Read the guide.'],
    ['![Architecture diagram](./private/image.png)', 'Architecture diagram'],
    ['https://example.com/only-a-target\nA useful heading', 'A useful heading'],
    ['<https://example.com/private>\nA useful heading', 'A useful heading'],
    ['<!-- Hidden heading -->\n<script>hidden()</script>\n<div>Visible &amp; useful</div>', 'Visible & useful'],
    ['<a title="not > a heading" href="./private-target">Visible heading</a>', 'Visible heading'],
    ['&lt;b&gt;Launch &#x1f680; &#128075;&lt;/b&gt;', 'Launch 🚀 👋'],
    ['```typescript\nconst secret = "not a heading"\n```\n## Review status', 'Review status'],
    ['~~~text\nNot a subject\n~~~\nReview status', 'Review status'],
    ['---\n***\n| Status | Ready |\n| --- | --- |', 'Status · Ready'],
    ['### 中文更新 👩🏽‍💻\nMore text', '中文更新 👩🏽‍💻'],
    ['\u0000  Ready\t for review', 'Ready for review']
  ])('derives readable text from %j', (body, expected) => {
    expect(teamMailDisplayTitle({ title: null, body, sender })).toBe(expected)
  })

  it('uses a preview when the full body is unavailable and ignores a blank title', () => {
    expect(teamMailDisplayTitle({ title: '  ', preview: '# Preview heading\nMore context', sender })).toBe('Preview heading')
    expect(teamMailDisplayTitle({ title: null, body: 'Body heading', preview: 'Preview heading', sender })).toBe('Body heading')
  })

  it.each(['', '---\n***', 'https://example.com/attachment', '```\nCode only\n```', '<img src="private.png">'])('has a sender fallback when no readable heading remains: %j', body => {
    expect(teamMailDisplayTitle({ title: null, body, sender })).toBe('Message from Studio')
  })

  it('bounds derived headings without splitting emoji, combining marks, or surrogate pairs', () => {
    const exact = '😀'.repeat(120)
    expect(teamMailDisplayTitle({ title: null, body: exact, sender })).toBe(exact)
    expect(teamMailDisplayTitle({ title: null, body: `${'a'.repeat(118)}👩🏽‍💻 tail`, sender })).toBe(`${'a'.repeat(118)}…`)
    expect(teamMailDisplayTitle({ title: null, body: 'e\u0301'.repeat(80), sender })).toBe(`${'e\u0301'.repeat(59)}…`)
    expect([...teamMailDisplayTitle({ title: null, body: '😀'.repeat(500), sender })]).toHaveLength(120)
  })

  it('bounds source scanning as well as the resulting heading', () => {
    expect(teamMailDisplayTitle({ title: null, body: `${'\n'.repeat(8_192)}Too late`, sender })).toBe('Message from Studio')
  })
})
