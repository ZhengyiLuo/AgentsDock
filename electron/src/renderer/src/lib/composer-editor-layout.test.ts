import { describe, expect, it, vi } from 'vitest'
import { cancelComposerEditorLayout, composerTextCanUseMirror, layoutComposerEditor, scheduleComposerEditorLayout, syncComposerEditorMirror } from './composer-editor-layout'

function metric<T extends HTMLElement>(element: T, property: keyof T, value: () => number): void {
  Object.defineProperty(element, property, { configurable: true, get: value })
}

function reference(start: number, end: number): { source_text_start: number; source_text_end: number } {
  return { source_text_start: start, source_text_end: end }
}

describe('composer editor layout', () => {
  it('leaves native content sizing off the per-keystroke layout path', () => {
    const textarea = document.createElement('textarea')
    textarea.style.height = '92px'
    textarea.style.overflowY = 'hidden'
    const callbacks: FrameRequestCallback[] = []
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callbacks.push(callback)
      return callbacks.length
    })
    const css = window.CSS
    const cssDescriptor = Object.getOwnPropertyDescriptor(window, 'CSS')
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { ...css, supports: vi.fn(() => true) }
    })

    try {
      scheduleComposerEditorLayout(textarea, null, { current: null })

      expect(request).not.toHaveBeenCalled()
      expect(callbacks).toHaveLength(0)
      expect(textarea.style.height).toBe('')
      expect(textarea.style.overflowY).toBe('')
    } finally {
      if (cssDescriptor) Object.defineProperty(window, 'CSS', cssDescriptor)
      else Reflect.deleteProperty(window, 'CSS')
      request.mockRestore()
    }
  })

  it('syncs a native-sized mirror without scheduling or reading layout geometry', () => {
    const textarea = document.createElement('textarea')
    const mirror = document.createElement('div')
    const request = vi.spyOn(window, 'requestAnimationFrame')
    const css = window.CSS
    const cssDescriptor = Object.getOwnPropertyDescriptor(window, 'CSS')
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { ...css, supports: vi.fn(() => true) }
    })
    textarea.scrollTop = 18
    textarea.scrollLeft = 3
    mirror.style.width = '470px'
    mirror.style.height = '92px'
    for (const [element, property] of [
      [textarea, 'clientWidth'],
      [textarea, 'clientHeight'],
      [textarea, 'scrollWidth'],
      [textarea, 'scrollHeight'],
      [mirror, 'scrollWidth'],
      [mirror, 'scrollHeight']
    ] as const) {
      Object.defineProperty(element, property, {
        configurable: true,
        get: () => { throw new Error(`unexpected ${property} read`) }
      })
    }

    try {
      const aligned = vi.fn()
      scheduleComposerEditorLayout(textarea, mirror, { current: null }, aligned)

      expect(request).not.toHaveBeenCalled()
      expect(mirror.style.width).toBe('')
      expect(mirror.style.height).toBe('')
      expect(mirror.scrollTop).toBe(18)
      expect(mirror.scrollLeft).toBe(3)
      expect(mirror).toHaveAttribute('data-composer-mirror-aligned', 'true')
      expect(mirror).toHaveStyle({ visibility: 'visible' })
      expect(aligned).toHaveBeenCalledWith(true)
      expect(syncComposerEditorMirror(textarea, mirror)).toBe(true)
    } finally {
      if (cssDescriptor) Object.defineProperty(window, 'CSS', cssDescriptor)
      else Reflect.deleteProperty(window, 'CSS')
      request.mockRestore()
    }
  })

  it('coalesces repeated layout requests into one animation frame', () => {
    const textarea = document.createElement('textarea')
    const callbacks: FrameRequestCallback[] = []
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callbacks.push(callback)
      return callbacks.length
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const frame = { current: null as number | null }

    scheduleComposerEditorLayout(textarea, null, frame)
    scheduleComposerEditorLayout(textarea, null, frame)
    scheduleComposerEditorLayout(textarea, null, frame)

    expect(request).toHaveBeenCalledOnce()
    expect(frame.current).toBe(1)
    callbacks[0](16)
    expect(frame.current).toBeNull()

    scheduleComposerEditorLayout(textarea, null, frame)
    cancelComposerEditorLayout(textarea, frame)
    expect(cancel).toHaveBeenCalledWith(2)
    expect(frame.current).toBeNull()
    request.mockRestore()
    cancel.mockRestore()
  })

  it('caps a pasted multiline draft while preserving its end caret', () => {
    const textarea = document.createElement('textarea')
    textarea.style.minHeight = '46px'
    textarea.style.maxHeight = '190px'
    textarea.style.height = '46px'
    textarea.value = 'first\nsecond\nthird\nfourth'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.scrollTop = 214
    metric(textarea, 'scrollHeight', () => 260)
    metric(textarea, 'clientHeight', () => Number.parseFloat(textarea.style.height) || 46)

    layoutComposerEditor(textarea, null)

    expect(textarea.style.height).toBe('190px')
    expect(textarea.style.overflowY).toBe('auto')
    expect(textarea.scrollTop).toBe(70)
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(textarea.selectionEnd).toBe(textarea.value.length)
  })

  it('preserves a non-terminal selection and scroll position while reflowing', () => {
    const textarea = document.createElement('textarea')
    textarea.style.minHeight = '46px'
    textarea.style.maxHeight = '190px'
    textarea.style.height = '120px'
    textarea.value = 'alpha beta gamma delta'
    textarea.setSelectionRange(6, 10, 'backward')
    textarea.scrollTop = 24
    metric(textarea, 'scrollHeight', () => 260)
    metric(textarea, 'clientHeight', () => Number.parseFloat(textarea.style.height) || 46)

    layoutComposerEditor(textarea, null)

    expect(textarea.scrollTop).toBe(24)
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(10)
    expect(textarea.selectionDirection).toBe('backward')
  })

  it('shrinks below the cap and removes an unnecessary scrollbar', () => {
    const textarea = document.createElement('textarea')
    textarea.style.minHeight = '46px'
    textarea.style.maxHeight = '190px'
    textarea.style.height = '190px'
    textarea.value = 'short again'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    metric(textarea, 'scrollHeight', () => 72)
    metric(textarea, 'clientHeight', () => Number.parseFloat(textarea.style.height) || 46)

    layoutComposerEditor(textarea, null)

    expect(textarea.style.height).toBe('72px')
    expect(textarea.style.overflowY).toBe('hidden')
    expect(textarea.scrollTop).toBe(0)
  })

  it('hides the decoration mirror when its measured geometry diverges', () => {
    const textarea = document.createElement('textarea')
    const mirror = document.createElement('div')
    mirror.style.border = '1px solid transparent'
    textarea.scrollTop = 43
    textarea.scrollLeft = 2
    metric(textarea, 'clientWidth', () => 470)
    metric(textarea, 'clientHeight', () => 190)
    metric(textarea, 'scrollHeight', () => 260)
    metric(textarea, 'scrollWidth', () => 470)
    let mirrorScrollHeight = 260
    metric(mirror, 'scrollHeight', () => mirrorScrollHeight)
    metric(mirror, 'scrollWidth', () => 470)

    expect(syncComposerEditorMirror(textarea, mirror)).toBe(true)
    expect(mirror).toHaveAttribute('data-composer-mirror-aligned', 'true')
    expect(mirror.style.visibility).toBe('visible')

    mirrorScrollHeight = 281
    expect(syncComposerEditorMirror(textarea, mirror)).toBe(false)
    expect(mirror).toHaveAttribute('data-composer-mirror-aligned', 'false')
    expect(mirror.style.visibility).toBe('hidden')
  })

  it('routes ambiguous long-token and invisible-control geometry away from the inline mirror', () => {
    const multiline = 'First wrapped line\nAsk @@Studio for a review'
    const mentionStart = multiline.indexOf('@@Studio')
    expect(composerTextCanUseMirror(multiline, [reference(mentionStart, mentionStart + 8)])).toBe(true)

    const path = `/Volumes/Dev/${'nested/'.repeat(8)}file.ts @Training`
    const pathMention = path.indexOf('@Training')
    expect(composerTextCanUseMirror(path, [reference(pathMention, pathMention + 9)])).toBe(false)

    for (const control of ['\t', '\u200b', '\u200c', '\u200d', '\ufeff']) {
      const text = `Ask${control}@Training`
      const start = text.indexOf('@Training')
      expect(composerTextCanUseMirror(text, [reference(start, start + 9)])).toBe(false)
    }
  })
})
