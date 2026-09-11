export interface ComposerCommandMetadata {
  id: string
  label: string
  description: string
  keywords?: readonly string[]
  /** Section this command is grouped under in the palette (e.g. 'agentsdock', 'skills'). */
  category?: string
}

export interface ComposerCommandTrigger {
  /** UTF-16 offset of the leading slash in the textarea value. */
  start: number
  /** UTF-16 caret offset immediately after the command query. */
  end: number
  /** Text after the slash, preserving the user's casing. */
  query: string
}

export interface ComposerCommandMatch<T extends ComposerCommandMetadata> {
  trigger: ComposerCommandTrigger
  commands: T[]
}

export type ComposerCommandAvailability<T extends ComposerCommandMetadata> = (command: T) => boolean

/**
 * Finds a slash command only when it is the first non-whitespace token in the
 * composer and the caret is at the end of that token. Arguments intentionally
 * end discovery: `/chat ` and `/chat/…` are then handled by the established
 * cross-chat mention parser instead of the command palette.
 */
export function composerCommandTrigger(text: string, caret: number): ComposerCommandTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  if (safeCaret !== text.length) return null

  const slash = text.search(/\S/u)
  if (slash < 0 || text[slash] !== '/') return null
  const token = text.slice(slash, safeCaret)
  const match = /^\/([\p{L}\p{N}_.:-]*)$/u.exec(token)
  if (!match) return null

  return {
    start: slash,
    end: safeCaret,
    query: match[1]
  }
}

/** Filters in declaration order so the product-owned command ordering stays stable. */
export function filterComposerCommands<T extends ComposerCommandMetadata>(
  commands: readonly T[],
  query: string,
  isAvailable: ComposerCommandAvailability<T> = () => true
): T[] {
  if (/\s/u.test(query)) return []
  const normalizedQuery = normalize(query)
  return commands.filter(command => (
    isAvailable(command)
    && (
      normalizedQuery.length === 0
      || commandSearchTerms(command).some(term => term.startsWith(normalizedQuery))
    )
  ))
}

/**
 * Resolves the textarea trigger and visible commands in one step. Returning
 * null when nothing matches prevents paths such as `/Users/…` from opening an
 * empty command surface.
 */
export function matchComposerCommands<T extends ComposerCommandMetadata>(
  text: string,
  caret: number,
  commands: readonly T[],
  isAvailable: ComposerCommandAvailability<T> = () => true
): ComposerCommandMatch<T> | null {
  const trigger = composerCommandTrigger(text, caret)
  if (!trigger) return null
  const matches = filterComposerCommands(commands, trigger.query, isAvailable)
  return matches.length ? { trigger, commands: matches } : null
}

export interface ComposerCommandCategory {
  id: string
  heading: string
}

export interface ComposerCommandGroup<T extends ComposerCommandMetadata> {
  id: string
  heading: string
  /** False when only one category is present, so a narrowed search doesn't show a lone redundant header. */
  showHeading: boolean
  items: { command: T; index: number }[]
}

/**
 * Groups already-filtered commands by category, preserving each command's
 * original flat index (needed by callers that drive keyboard navigation off
 * that index) and declaration order within each group.
 */
export function groupComposerCommandsByCategory<T extends ComposerCommandMetadata>(
  commands: readonly T[],
  categories: readonly ComposerCommandCategory[],
  fallbackCategory = 'agentsdock'
): ComposerCommandGroup<T>[] {
  const byCategory = new Map<string, { command: T; index: number }[]>()
  commands.forEach((command, index) => {
    const category = command.category ?? fallbackCategory
    const bucket = byCategory.get(category) ?? []
    bucket.push({ command, index })
    byCategory.set(category, bucket)
  })
  const knownIds = categories.map(entry => entry.id)
  const orderedIds = [...knownIds, ...[...byCategory.keys()].filter(categoryId => !knownIds.includes(categoryId))]
  const groups = orderedIds
    .map(categoryId => ({
      id: categoryId,
      heading: categories.find(entry => entry.id === categoryId)?.heading ?? categoryId,
      items: byCategory.get(categoryId) ?? []
    }))
    .filter(group => group.items.length > 0)
  return groups.map(group => ({ ...group, showHeading: groups.length > 1 }))
}

function commandSearchTerms(command: ComposerCommandMetadata): string[] {
  const terms = [command.id, command.label, ...(command.keywords ?? [])]
  return [...new Set(terms.flatMap(value => {
    const normalized = normalize(value)
    if (!normalized) return []
    const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    return [normalized, normalized.replace(/[^\p{L}\p{N}]+/gu, ''), ...words]
  }))]
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}
