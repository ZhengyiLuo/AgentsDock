export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7850'

export function normalizeServerURL(value: string): string {
  let clean = value.trim()
  if (!clean) return DEFAULT_SERVER_URL
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`
  const url = new URL(clean)
  url.pathname = url.pathname.replace(/\/(api\/health)?\/?$/, '') || ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
