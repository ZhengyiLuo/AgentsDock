import { teamMessageLinksInText } from './team-message-links'

export interface ComposerMessageLink {
  href: string
  label: string
  start: number
  end: number
  displayStart: number
  displayEnd: number
}

export interface TeamMessageComposerProjection {
  source: string
  text: string
  links: ComposerMessageLink[]
}

export interface ComposerNativeEditSelection {
  source: string
  start: number
  end: number
}

/** The native editor sees labels; persistence and submission retain exact URLs. */
export function projectTeamMessageComposer(source: string): TeamMessageComposerProjection {
  let text = ''
  let offset = 0
  const links = teamMessageLinksInText(source).map(link => {
    text += source.slice(offset, link.start)
    const displayStart = text.length
    text += link.label
    offset = link.end
    return { ...link, displayStart, displayEnd: text.length }
  })
  return { source, text: text + source.slice(offset), links }
}

type OffsetBias = 'start' | 'end' | 'nearest'

function boundary(offset: number, start: number, end: number, bias: OffsetBias): boolean {
  return bias === 'start' || (bias === 'nearest' && offset - start < end - offset)
}

export function composerDisplayToSource(
  projection: TeamMessageComposerProjection, offset: number, bias: OffsetBias = 'nearest'
): number {
  let delta = 0
  for (const link of projection.links) {
    if (offset <= link.displayStart) break
    if (offset < link.displayEnd) {
      return boundary(offset, link.displayStart, link.displayEnd, bias) ? link.start : link.end
    }
    delta = link.end - link.displayEnd
  }
  return Math.max(0, Math.min(projection.source.length, offset + delta))
}

export function composerSourceToDisplay(
  projection: TeamMessageComposerProjection, offset: number, bias: OffsetBias = 'nearest'
): number {
  let delta = 0
  for (const link of projection.links) {
    if (offset <= link.start) break
    if (offset < link.end) {
      return boundary(offset, link.start, link.end, bias) ? link.displayStart : link.displayEnd
    }
    delta = link.end - link.displayEnd
  }
  return Math.max(0, Math.min(projection.text.length, offset - delta))
}

/**
 * Apply one native edit. Links are atomic, like @/@@ references: a replacement
 * touching a label removes that complete link, never a fragment of its URL.
 * This also handles native cut, selection replacement and IME input without
 * intercepting plain paste or reconstructing targets from duplicate labels.
 */
export function applyTeamMessageComposerEdit(
  projection: TeamMessageComposerProjection,
  nextText: string,
  selectionStart: number,
  selectionEnd = selectionStart,
  beforeEdit?: ComposerNativeEditSelection | null
): { source: string; selectionStart: number; selectionEnd: number } {
  const previous = projection.text
  if (!projection.links.length) return { source: nextText, selectionStart, selectionEnd }
  let start = 0
  while (start < previous.length && start < nextText.length && previous[start] === nextText[start]) start += 1
  // Equal neighboring labels must retain the target actually left in place.
  // A native replacement ends at its caret, even when equal suffix characters
  // make a text-only longest-prefix diff appear to edit a later link.
  if (selectionStart === selectionEnd) {
    start = Math.min(start, Math.max(0, selectionStart - Math.max(0, nextText.length - previous.length)))
  }
  let suffix = 0
  while (suffix < previous.length - start && suffix < nextText.length - start
    && previous[previous.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1
  let end = previous.length - suffix
  let nextEnd = nextText.length - suffix
  if (beforeEdit?.source === projection.source) {
    const selectedNextEnd = nextText.length - (previous.length - beforeEdit.end)
    if (selectedNextEnd >= beforeEdit.start
      && previous.slice(0, beforeEdit.start) === nextText.slice(0, beforeEdit.start)
      && previous.slice(beforeEdit.end) === nextText.slice(selectedNextEnd)) {
      start = beforeEdit.start
      end = beforeEdit.end
      nextEnd = selectedNextEnd
    }
  }
  if (start === end && start === nextEnd) return {
    source: projection.source,
    selectionStart: composerDisplayToSource(projection, selectionStart),
    selectionEnd: composerDisplayToSource(projection, selectionEnd)
  }

  let editStart = start
  let editEnd = end
  for (const link of projection.links) {
    if (start === end && start > link.displayStart && start < link.displayEnd) {
      // Native Home/End or IME can place a caret inside an atomic label.
      editStart = editEnd = boundary(start, link.displayStart, link.displayEnd, 'nearest')
        ? link.displayStart : link.displayEnd
    } else if (start < link.displayEnd && end > link.displayStart) {
      editStart = Math.min(editStart, link.displayStart)
      editEnd = Math.max(editEnd, link.displayEnd)
    }
  }
  const sourceStart = composerDisplayToSource(projection, editStart, 'start')
  const sourceEnd = composerDisplayToSource(projection, editEnd, 'end')
  const inserted = nextText.slice(start, nextEnd)
  const source = projection.source.slice(0, sourceStart) + inserted + projection.source.slice(sourceEnd)
  const sourceDelta = inserted.length - (sourceEnd - sourceStart)
  const selectionOffset = (offset: number): number => {
    if (offset < start) return composerDisplayToSource(projection, Math.min(offset, editStart))
    if (offset <= nextEnd) return sourceStart + Math.max(0, offset - start)
    const previousOffset = Math.max(editEnd, offset - (nextEnd - end))
    return composerDisplayToSource(projection, previousOffset) + sourceDelta
  }
  return { source, selectionStart: selectionOffset(selectionStart), selectionEnd: selectionOffset(selectionEnd) }
}
