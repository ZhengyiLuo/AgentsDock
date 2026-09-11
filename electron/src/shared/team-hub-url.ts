/**
 * Build the Team Hub API base from an already verified AgentsServer origin and
 * an authenticated discovery response. Discovery is routing metadata, not an
 * authority to select a second origin.
 */
export function deriveMountedTeamHubURL(serverURL: string, apiBasePath: string): string {
  let server: URL
  try {
    server = new URL(serverURL)
  } catch {
    throw new Error('The active AgentsServer URL is invalid.')
  }
  if (server.username || server.password || server.search || server.hash) {
    throw new Error('The active AgentsServer URL is invalid.')
  }
  if (server.protocol !== 'http:' || !isLoopbackHostname(server.hostname)) {
    throw new Error('This Teamspace preview is available only from the designated host through a loopback AgentsServer profile.')
  }
  if (apiBasePath !== '/api/team-hub') {
    throw new Error('AgentsServer advertised an invalid Team Hub API path.')
  }
  const prefix = server.pathname === '/' ? '' : validatePath(server.pathname, 'active AgentsServer base path')
  return `${server.origin}${prefix}${apiBasePath}`
}

/**
 * Validate the distinct private Tailscale Serve origin advertised by an
 * authenticated AgentsServer capability. Port 8444 is intentionally outside
 * Tailscale Funnel's public ingress ports.
 */
export function normalizeTailscaleServeTeamHubURL(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('The advertised Team Hub URL is invalid.')
  }
  const url = parseURL(value, 'The advertised Team Hub URL is invalid.')
  if (
    url.protocol !== 'https:'
    || url.port !== '8444'
    || !isCanonicalTailscaleHostname(url.hostname)
    || url.pathname !== '/api/team-hub'
  ) throw new Error('AgentsServer advertised an invalid private Tailscale Serve Team Hub URL.')
  const canonical = `${url.protocol}//${url.host}${url.pathname}`
  if (value !== canonical) throw new Error('AgentsServer advertised a non-canonical private Tailscale Serve Team Hub URL.')
  return canonical
}

/** Validate the explicitly unsafe, same-origin raw IPv4 Team Hub route. */
export function normalizeDirectIPTeamHubURL(value: string, serverURL?: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('The advertised direct-IP Team Hub URL is invalid.')
  }
  const url = parseURL(value, 'The advertised direct-IP Team Hub URL is invalid.')
  if (
    url.protocol !== 'http:'
    || !url.port
    || !isCanonicalIPv4Address(url.hostname)
    || url.pathname !== '/api/team-hub'
  ) throw new Error('AgentsServer advertised an invalid direct-IP Team Hub URL.')
  const canonical = `${url.protocol}//${url.host}${url.pathname}`
  if (value !== canonical) throw new Error('AgentsServer advertised a non-canonical direct-IP Team Hub URL.')
  if (serverURL !== undefined) {
    const server = parseURL(serverURL, 'The active AgentsServer URL is invalid.')
    if (
      server.protocol !== 'http:'
      || !isCanonicalIPv4Address(server.hostname)
      || server.origin !== url.origin
      || server.pathname !== '/'
    ) throw new Error('Direct-IP Teamspace must use the exact active AgentsServer origin.')
  }
  return canonical
}

/** Derive a secure-peer Hub proxy only from the authenticated active AgentsServer origin. */
export function deriveSecurePeerTeamHubURL(
  serverURL: string,
  basePath: string,
  advertisedURL?: string | null
): string {
  const server = parseURL(serverURL, 'The active AgentsServer URL is invalid.')
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('The active AgentsServer URL is invalid.')
  const path = normalizeSecurePeerBasePath(basePath)
  const prefix = server.pathname === '/' ? '' : validatePath(server.pathname, 'active AgentsServer base path')
  const expected = `${server.origin}${prefix}${path}`
  if (advertisedURL != null && advertisedURL !== expected) {
    throw new Error('AgentsServer advertised a secure Teamspace proxy outside the active control origin.')
  }
  return expected
}

/** Derive the server-scoped Hub proxy only from the authenticated AgentsServer origin. */
export function deriveServerTeamHubURL(serverURL: string, basePath: string): string {
  const server = parseURL(serverURL, 'The active AgentsServer URL is invalid.')
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('The active AgentsServer URL is invalid.')
  if (basePath !== '/api/team-hub-server') {
    throw new Error('AgentsServer advertised an invalid server Teamspace proxy path.')
  }
  const prefix = server.pathname === '/' ? '' : validatePath(server.pathname, 'active AgentsServer base path')
  return `${server.origin}${prefix}${basePath}`
}

export function normalizeSecurePeerBasePath(value: string): string {
  const path = validatePath(value, 'secure Teamspace proxy path')
  if (!/^\/api\/team-hub-secure\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path)) {
    throw new Error('AgentsServer advertised an invalid secure Teamspace proxy path.')
  }
  return path
}

export function deriveTeamHubBootstrapControlURL(hubURL: string): string {
  const url = new URL(
    hubURL.startsWith('https:')
      ? normalizeTailscaleServeTeamHubURL(hubURL)
      : normalizeDirectIPTeamHubURL(hubURL)
  )
  url.pathname = '/api/admin/team-hub/bootstrap-proof'
  return url.toString()
}

/** Validate a fully derived Hub base URL before the Hub client adopts it. */
export function normalizeMountedTeamHubURL(value: string): string {
  const url = parseURL(value, 'The discovered Team Hub URL is invalid.')
  const loopback = url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  const privateServe = url.protocol === 'https:' && url.port === '8444' && isCanonicalTailscaleHostname(url.hostname)
  const directIP = url.protocol === 'http:' && Boolean(url.port) && isCanonicalIPv4Address(url.hostname)
  const securePeer = ['http:', 'https:'].includes(url.protocol)
    // The secure proxy is mounted beneath the already-authenticated
    // AgentsServer base URL. Profiles may use a reverse-proxy prefix, so the
    // fixed connection-bound suffix need not begin at the origin root.
    && /(?:^|\/)api\/team-hub-secure\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(url.pathname)
  const serverProxy = ['http:', 'https:'].includes(url.protocol)
    && /(?:^|\/)api\/team-hub-server$/.test(url.pathname)
  if (!loopback && !privateServe && !directIP && !securePeer && !serverProxy) throw new Error('The discovered Team Hub URL is not an approved Teamspace transport.')
  const path = validatePath(url.pathname, 'discovered Team Hub URL')
  if (!securePeer && !serverProxy && (
    privateServe || directIP ? path !== '/api/team-hub' : !path.endsWith('/api/team-hub')
  )) {
    throw new Error('The discovered Team Hub URL is invalid.')
  }
  const canonical = `${url.origin}${path}`
  if ((privateServe || directIP || securePeer || serverProxy) && value !== canonical) throw new Error('The discovered Team Hub URL is not canonical.')
  return canonical
}

function parseURL(value: string, message: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) throw new Error(message)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(message) }
  if (url.username || url.password || url.search || url.hash) throw new Error(message)
  return url
}

export function isCanonicalTailscaleHostname(hostname: string): boolean {
  if (hostname !== hostname.toLowerCase() || hostname.endsWith('.')) return false
  const labels = hostname.split('.')
  if (labels.length < 4 || labels.at(-2) !== 'ts' || labels.at(-1) !== 'net') return false
  return labels.every(label => (
    label.length >= 1
    && label.length <= 63
    && !label.startsWith('xn--')
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))
}

export function isCanonicalIPv4Address(hostname: string): boolean {
  const parts = hostname.split('.')
  const valid = parts.length === 4 && parts.every(part => (
    /^(?:0|[1-9][0-9]{0,2})$/.test(part)
    && Number(part) <= 255
  ))
  if (!valid) return false
  const first = Number(parts[0])
  return first > 0 && first !== 127 && first < 224
}

function validatePath(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.length < 2
    || value.length > 240
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('%')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${label} is invalid.`)
  const segments = value.slice(1).split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}
