import { afterEach, describe, expect, it, vi } from 'vitest'
import { secureRandomUUID } from '../lib/browser-crypto'
import { verifyLocalStorageWritable } from '../lib/local-storage'
import { copySharedChatText } from './clipboard'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('non-secure HTTP browser compatibility', () => {
  it('uses cryptographic random bytes when randomUUID is absent, including the storage probe', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(0xff); return bytes })
    vi.stubGlobal('crypto', { getRandomValues })
    expect(secureRandomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    const before = localStorage.length
    expect(() => verifyLocalStorageWritable()).not.toThrow()
    expect(localStorage.length).toBe(before)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
  })

  it('copies explicitly without Clipboard API and restores focus/selection with no leftover textarea', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined })
    const input = document.createElement('textarea')
    input.value = 'Preserved draft'
    document.body.append(input); input.focus(); input.setSelectionRange(2, 6)
    const copy = vi.fn(() => {
      const selected = document.activeElement as HTMLTextAreaElement
      expect(selected.value).toBe('Synthetic copied text')
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy })
    try {
      await copySharedChatText('Synthetic copied text')
      expect(copy).toHaveBeenCalledExactlyOnceWith('copy')
      expect(document.activeElement).toBe(input)
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
      expect(document.querySelectorAll('textarea')).toHaveLength(1)
    } finally { Reflect.deleteProperty(document, 'execCommand') }
  })

  it('does not bypass an explicit Clipboard API denial', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copySharedChatText('Synthetic text')).rejects.toThrow('Permission denied')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
