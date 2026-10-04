import type { Backend } from './types'

export interface IssueReportEnvironment {
  platform: string
  systemVersion: string
  architecture: string
  appVersion: string
  appBuild: string
}

export interface IssueReportContext {
  serverVersion?: string | null
  serverConnected: boolean
  backend: Backend
  model?: string | null
}

const platforms: Record<string, string> = {
  darwin: 'macOS (desktop)', win32: 'Windows (desktop)', linux: 'Linux (desktop)'
}
const agents: Record<Backend, string> = {
  codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode'
}

function value(text: string | null | undefined): string {
  return text?.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 160) || 'Unknown'
}

/** Explicit allowlist: never serialize a session, health response or server profile. */
export function issueReportURL(environment: IssueReportEnvironment, context: IssueReportContext): string {
  const url = new URL('https://github.com/ZhengyiLuo/AgentsDock/issues/new')
  const platform = platforms[environment.platform] ?? 'Not sure'
  url.searchParams.set('template', 'bug_report.yml')
  url.searchParams.set('platform', platform)
  url.searchParams.set('app-version', value(environment.appVersion))
  // Use the existing form field so locally built clients work before a template rollout.
  url.searchParams.set('extra', [
    '### Environment (automatically filled; please review)',
    `- Platform: ${platform}`,
    `- OS version: ${value(environment.systemVersion)}`,
    `- App architecture: ${value(environment.architecture)}`,
    `- App version: ${value(environment.appVersion)}`,
    `- App build: ${value(environment.appBuild)}`,
    `- AgentsServer version: ${value(context.serverVersion)}${!context.serverConnected && context.serverVersion ? ' (last known; disconnected)' : ''}`,
    `- Agent: ${agents[context.backend] ?? 'Unknown'}`,
    `- Model: ${value(context.model)}`
  ].join('\n'))
  return url.toString()
}
