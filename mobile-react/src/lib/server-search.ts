export const SERVER_SEARCH_MIN_CHARACTERS = 2

export function serverSearchQuery(value: string): string | null {
  const clean = value.trim()
  return Array.from(clean).length >= SERVER_SEARCH_MIN_CHARACTERS ? clean : null
}
