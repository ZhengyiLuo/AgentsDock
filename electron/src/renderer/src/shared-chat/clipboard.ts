/** Called by explicit Copy controls; never reads the clipboard or requests permissions. */
export async function copySharedChatText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    // A supported API denial remains a denial, not a reason to bypass it.
    await navigator.clipboard.writeText(text)
    return
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null
  const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'
  document.body.append(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) throw new Error('Copy was unavailable. Select the text and copy it manually.')
  } finally {
    textarea.remove()
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    if (input?.isConnected && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
      input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? undefined)
    } else if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range)
    }
  }
}
