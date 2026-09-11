/**
 * A title match represents the chat itself, while a history-only match
 * represents one exact timeline result. Never attach both meanings to the
 * same visible row: doing so makes a correct title result open an unrelated
 * older message from that chat.
 */
export function sidebarContentResult<T>(
  title: string,
  normalizedLowercaseQuery: string,
  contentResult: T | undefined,
): T | undefined {
  return title.toLowerCase().includes(normalizedLowercaseQuery)
    ? undefined
    : contentResult
}
