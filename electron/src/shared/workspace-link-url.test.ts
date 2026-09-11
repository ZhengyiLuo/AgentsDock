import { describe, expect, it } from 'vitest'
import { internalWorkspaceLinkURL, workspacePathFromInternalLink } from './workspace-link-url'

describe('internal workspace links', () => {
  it('round trips a relative path without involving the renderer file URL', () => {
    const path = 'runs/080126/run016/summary.json#L12'
    const link = internalWorkspaceLinkURL(path)

    expect(link).toBe('agentsdock-workspace:runs%2F080126%2Frun016%2Fsummary.json%23L12')
    expect(workspacePathFromInternalLink(link)).toBe(path)
    expect(link).not.toContain('app.asar')
  })

  it('rejects unrelated and malformed links', () => {
    expect(workspacePathFromInternalLink('https://example.com')).toBeNull()
    expect(workspacePathFromInternalLink('agentsdock-workspace:%E0%A4%A')).toBeNull()
    expect(workspacePathFromInternalLink('agentsdock-workspace:bad%0Apath')).toBeNull()
  })
})
