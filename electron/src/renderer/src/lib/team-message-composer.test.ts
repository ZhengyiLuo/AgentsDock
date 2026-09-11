import { describe, expect, it } from 'vitest'
import { applyTeamMessageComposerEdit, composerDisplayToSource, composerSourceToDisplay, projectTeamMessageComposer } from './team-message-composer'
import { escapeTeamMessageLinkLabel, teamMessageLinkURL } from './team-message-links'

const href = (id: string) => teamMessageLinkURL({
  section: 'feed', teamId: 'team-1', messageId: id, serverIdentity: `server-${'a'.repeat(60)}`
})
const markdown = (label: string, id = 'message-1') => `[${label}](${href(id)})`

describe('team message composer projection', () => {
  it('projects escaped mail subjects literally while preserving the canonical draft through edits', () => {
    const label = 'Review [phase 1] \\ details & **literal** 🚀'
    const link = markdown(escapeTeamMessageLinkLabel(label))
    const source = `Read ${link} from @@Studio`
    const projection = projectTeamMessageComposer(source)
    expect(projection.text).toBe(`Read ${label} from @@Studio`)
    expect(projection.source).toBe(source)
    expect(projection.links[0].href).toBe(href('message-1'))
    expect(composerDisplayToSource(projection, projection.text.indexOf(' from '))).toBe(source.indexOf(' from '))
    const editedText = `Notes\n${projection.text}`
    const edited = applyTeamMessageComposerEdit(projection, editedText, editedText.length)
    expect(edited.source).toBe(`Notes\n${source}`)
    expect(projectTeamMessageComposer(edited.source).text).toBe(editedText)
    expect(projectTeamMessageComposer(edited.source).links[0].href).toBe(href('message-1'))
  })

  it('keeps exact canonical URLs while projecting multiline labels and UTF-16 offsets', () => {
    const label = 'DEMO-A Run01 runbook (queue-driven ATLAS integration-test recovery)'
    const source = `🧭 Notes\n\nRead ${markdown(label)} from @@bulletin\nDone`
    const projection = projectTeamMessageComposer(source)
    expect(projection.text).toBe(`🧭 Notes\n\nRead ${label} from @@bulletin\nDone`)
    expect(projection.source).toBe(source)
    for (const text of ['Read ', ' from ', '@@bulletin', 'Done']) {
      const displayed = projection.text.indexOf(text)
      const canonical = source.indexOf(text)
      expect(composerDisplayToSource(projection, displayed)).toBe(canonical)
      expect(composerSourceToDisplay(projection, canonical)).toBe(displayed)
    }
    expect(composerDisplayToSource(projection, projection.text.length)).toBe(source.length)
    expect(composerSourceToDisplay(projection, source.length)).toBe(projection.text.length)
  })

  it('preserves separate targets with duplicate titles through edits before, between and after links', () => {
    let source = `Read ${markdown('Same', 'first')} and ${markdown('Same', 'second')}`
    for (const [before, after] of [
      ['Read ', '🧭 Read '], [' and ', '\nthen '], ['Same', 'Same']
    ]) {
      const projection = projectTeamMessageComposer(source)
      const next = projection.text.replace(before, after)
      const edit = applyTeamMessageComposerEdit(projection, next, next.length)
      source = edit.source
      expect(projectTeamMessageComposer(source).text).toBe(next)
      expect(projectTeamMessageComposer(source).links.map(link => link.href)).toEqual([href('first'), href('second')])
      expect(edit.selectionStart).toBe(source.length)
    }
    const projection = projectTeamMessageComposer(source)
    const edit = applyTeamMessageComposerEdit(projection, `${projection.text}\nFinished 🧪`, projection.text.length + 12)
    expect(edit.source).toBe(`${source}\nFinished 🧪`)
  })

  it('removes complete target syntax for a native cut or selection replacement touching a label', () => {
    const projection = projectTeamMessageComposer(`Read ${markdown('Original')} from @@bulletin`)
    const start = projection.text.indexOf('rig')
    const next = projection.text.slice(0, start) + 'new' + projection.text.slice(start + 3)
    const edit = applyTeamMessageComposerEdit(projection, next, start + 3)
    expect(edit.source).toBe('Read new from @@bulletin')
    expect(edit.selectionStart).toBe('Read new'.length)
    expect(projectTeamMessageComposer(edit.source).links).toHaveLength(0)
  })

  it.each([
    [0, 'second'], [4, 'first']
  ])('uses the native cut caret at %i to preserve the correct duplicate-label target', (caret, remaining) => {
    const projection = projectTeamMessageComposer(`${markdown('Same', 'first')}${markdown('Same', 'second')}`)
    const edit = applyTeamMessageComposerEdit(projection, 'Same', caret)
    expect(edit.source).toBe(markdown('Same', remaining))
    expect(projectTeamMessageComposer(edit.source).links[0].href).toBe(href(remaining))
    expect(composerSourceToDisplay(projectTeamMessageComposer(edit.source), edit.selectionStart)).toBe(caret)
  })

  it.each([0, 4, 8])('preserves the exact linked occurrences when inserting an identical label at %i', offset => {
    const first = markdown('Same', 'first')
    const second = markdown('Same', 'second')
    const projection = projectTeamMessageComposer(first + second)
    const next = projection.text.slice(0, offset) + 'Same' + projection.text.slice(offset)
    const expected = offset === 0 ? `Same${first}${second}` : offset === 4 ? `${first}Same${second}` : `${first}${second}Same`
    for (const beforeEdit of [undefined, { source: projection.source, start: offset, end: offset }]) {
      expect(applyTeamMessageComposerEdit(projection, next, offset + 4, offset + 4, beforeEdit).source).toBe(expected)
    }
  })

  it('uses a known native replacement range even when the readable text is identical', () => {
    const first = markdown('Same', 'first')
    const second = markdown('Same', 'second')
    const projection = projectTeamMessageComposer(first + second)
    expect(applyTeamMessageComposerEdit(projection, projection.text, 4, 4, {
      source: projection.source, start: 0, end: 4
    }).source).toBe(`Same${second}`)
  })

  it('does not consume a link when inserting immediately before or after it', () => {
    const source = `Read ${markdown('Original')} now`
    const projection = projectTeamMessageComposer(source)
    for (const offset of [projection.links[0].displayStart, projection.links[0].displayEnd]) {
      const next = projection.text.slice(0, offset) + '🧪\n' + projection.text.slice(offset)
      const edit = applyTeamMessageComposerEdit(projection, next, offset + 3)
      expect(projectTeamMessageComposer(edit.source).text).toBe(next)
      expect(projectTeamMessageComposer(edit.source).links[0].href).toBe(href('message-1'))
      expect(composerSourceToDisplay(projectTeamMessageComposer(edit.source), edit.selectionStart)).toBe(offset + 3)
    }
  })

  it('moves native insertion from inside an atomic label to its nearest boundary', () => {
    const projection = projectTeamMessageComposer(`Read ${markdown('Original')} now`)
    const offset = projection.links[0].displayStart + 1
    const next = projection.text.slice(0, offset) + 'X' + projection.text.slice(offset)
    const edit = applyTeamMessageComposerEdit(projection, next, offset + 1)
    expect(edit.source).toBe(`Read X${markdown('Original')} now`)
    expect(edit.selectionStart).toBe('Read X'.length)
  })

  it('preserves a backward selection outside the edited range in source coordinates', () => {
    const source = `Read ${markdown('Original')} then review 🧪`
    const projection = projectTeamMessageComposer(source)
    const next = `🧭\n${projection.text}`
    const selectionStart = next.indexOf('then')
    const edit = applyTeamMessageComposerEdit(projection, next, selectionStart, next.length)
    expect(edit.source).toBe(`🧭\n${source}`)
    expect(edit.selectionStart).toBe(edit.source.indexOf('then'))
    expect(edit.selectionEnd).toBe(edit.source.length)
  })

  it('passes ordinary Markdown and invalid internal targets through without interpretation', () => {
    const source = '[web](https://example.com) and [broken](agentsdock://team-message?section=wrong)'
    const projection = projectTeamMessageComposer(source)
    expect(projection.text).toBe(source)
    expect(projection.links).toHaveLength(0)
    expect(applyTeamMessageComposerEdit(projection, source + '!', source.length + 1).source).toBe(source + '!')
  })
})
