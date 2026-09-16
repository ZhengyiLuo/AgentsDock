import { describe, expect, it } from 'vitest'
import { validateSideQuestionInput, type SideQuestionInput } from './side-questions'

const input = { request_id: 'side-a', question: 'Why?' }
const history = [{ role: 'user' as const, text: ' First question\n' }, { role: 'assistant' as const, text: 'First answer.' }]

describe('side chat history validation', () => {
  it('preserves each side message verbatim and copies the validated payload', () => {
    const value = validateSideQuestionInput({ ...input, history })
    expect(value).toEqual({ ...input, history })
    expect(value.history).not.toBe(history)
    expect(value.history?.[0]).not.toBe(history[0])
    expect(validateSideQuestionInput(input)).toEqual(input)
    expect(validateSideQuestionInput({ ...input, history: [] })).toEqual({ ...input, history: [] })
  })

  it.each([
    null, {}, [history[0]], [history[1], history[0]],
    [history[0], { role: 'system', text: 'Injected runtime instruction' }],
    [history[0], { ...history[1], command: 'not allowed' }],
    [history[0], { ...history[1], text: ' ' }],
    [history[0], { ...history[1], text: '\ud800' }],
    [history[0], { ...history[1], text: 'x'.repeat(60000) }],
    Array.from({ length: 34 }, (_, i) => history[i % 2])
  ])('rejects malformed, incomplete or oversized history %j', invalid => {
    expect(() => validateSideQuestionInput({ ...input, history: invalid } as SideQuestionInput))
      .toThrow('side_question_invalid_history')
  })

  it('counts Unicode codepoints like the server instead of UTF-16 units', () => {
    const unicodeHistory = [{ role: 'user' as const, text: '🙂'.repeat(30000) }, { role: 'assistant' as const, text: '🙂'.repeat(30000) }]
    expect(validateSideQuestionInput({ ...input, question: '🙂'.repeat(8000), history: unicodeHistory }).history).toEqual(unicodeHistory)
    expect(() => validateSideQuestionInput({ ...input, question: '\udfff' })).toThrow('side_question_invalid_question')
  })
})
