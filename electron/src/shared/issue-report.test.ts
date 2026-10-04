import { describe, expect, it } from 'vitest'
import { issueReportURL, type IssueReportEnvironment } from './issue-report'

const environment: IssueReportEnvironment = {
  platform: 'darwin', systemVersion: '15.7', architecture: 'arm64', appVersion: '1.0.9-beta.2', appBuild: '1200'
}

describe('issue report prefill', () => {
  it.each([
    ['darwin', 'macOS (desktop)'], ['win32', 'Windows (desktop)'], ['linux', 'Linux (desktop)']
  ])('fills the existing public form for %s without private context or a description', (platform, label) => {
    const context = {
      backend: 'codex' as const, model: 'custom/model & variant', serverVersion: '1.0.9', serverConnected: true,
      sessionId: 'private-chat', title: 'private-title', cwd: '/private/work', token: 'secret', serverUrl: 'http://private-host'
    }
    const url = new URL(issueReportURL({ ...environment, platform }, context))
    expect(url.origin + url.pathname).toBe('https://github.com/ZhengyiLuo/AgentsDock/issues/new')
    expect([...url.searchParams.keys()]).toEqual(['template', 'platform', 'app-version', 'extra'])
    expect(url.searchParams.get('template')).toBe('bug_report.yml')
    expect(url.searchParams.get('platform')).toBe(label)
    expect(url.searchParams.get('app-version')).toBe('1.0.9-beta.2')
    const extra = url.searchParams.get('extra')!
    for (const field of ['OS version: 15.7', 'App architecture: arm64', 'App build: 1200', 'AgentsServer version: 1.0.9', 'Agent: Codex', 'Model: custom/model & variant']) {
      expect(extra).toContain(field)
    }
    for (const privateValue of [context.sessionId, context.title, context.cwd, context.token, context.serverUrl]) {
      expect(decodeURIComponent(url.toString())).not.toContain(privateValue)
    }
  })

  it('marks offline server versions as last known and does not guess missing values', () => {
    const extra = (serverVersion?: string) => new URL(issueReportURL(environment, {
      backend: 'claude', serverVersion, serverConnected: false, model: null
    })).searchParams.get('extra')!
    expect(extra('1.0.8')).toContain('AgentsServer version: 1.0.8 (last known; disconnected)')
    expect(extra()).toContain('AgentsServer version: Unknown')
    expect(extra()).toContain('Model: Unknown')
  })
})
