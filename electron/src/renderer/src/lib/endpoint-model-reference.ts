type ModelReference = { provider: string; url: string }

// Match the API service, not the agent using it. Links are fixed documentation
// URLs; never send the user's endpoint, credentials or draft to an external site.
export function endpointModelReference(baseURL: string): ModelReference | null {
  let endpoint: URL
  try { endpoint = new URL(baseURL.trim()) } catch { return null }
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) return null
  const path = endpoint.pathname.replace(/\/$/, '')
  if (endpoint.hostname === 'opencode.ai') {
    if (path === '/zen' || path === '/zen/v1') {
      return { provider: 'OpenCode Zen', url: 'https://opencode.ai/docs/zen/#endpoints' }
    }
    if (path === '/zen/go' || path === '/zen/go/v1') {
      return { provider: 'OpenCode Go', url: 'https://opencode.ai/docs/go/#endpoints' }
    }
  }
  if (endpoint.hostname === 'api.anthropic.com' && (path === '' || path === '/v1')) {
    return { provider: 'Anthropic', url: 'https://platform.claude.com/docs/en/models/overview' }
  }
  if (['openrouter.ai', 'eu.openrouter.ai'].includes(endpoint.hostname) && (path === '/api' || path === '/api/v1')) {
    return { provider: 'OpenRouter', url: 'https://openrouter.ai/models' }
  }
  return null
}
