import { describe, expect, it, vi } from 'vitest'
import {
  parseWorkspaceCodeReference,
  requestOpenAgentFile,
  requestOpenWorkspaceReference,
  workspacePathForAgentFile
} from './workspace-file-links'

describe('workspacePathForAgentFile', () => {
  it('maps an agent artifact source back to its workspace-relative path', () => {
    expect(workspacePathForAgentFile(
      { source_path: '/Volumes/Dev_Storage/agi/ZenithDock/electron/src/main/index.ts' },
      '/Volumes/Dev_Storage/agi/ZenithDock'
    )).toBe('electron/src/main/index.ts')
  })

  it('does not expose the artifact cache or files outside the workspace', () => {
    expect(workspacePathForAgentFile(
      { source_path: '/Users/dev/.agentsdock/files/artifact/index.ts' },
      '/Volumes/Dev_Storage/agi/ZenithDock'
    )).toBeNull()
    expect(workspacePathForAgentFile(
      { source_path: '/Volumes/Dev_Storage/agi/ZenithDock-other/index.ts' },
      '/Volumes/Dev_Storage/agi/ZenithDock'
    )).toBeNull()
  })

  it('supports Windows paths without case-sensitive drive matching', () => {
    expect(workspacePathForAgentFile(
      { source_path: 'C:\\Work\\AgentsDock\\src\\main.ts' },
      'c:\\work\\agentsdock'
    )).toBe('src/main.ts')
  })
})

describe('requestOpenAgentFile', () => {
  it('requests the internal artifact viewer with the complete agent file record', () => {
    const artifactOpen = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', artifactOpen)
    const file = {
      id: 'artifact-1',
      filename: 'migration-audit.md',
      source_path: '/Users/dev/.agentsdock/files/artifact-1/migration-audit.md',
      content_type: 'application/octet-stream'
    }

    requestOpenAgentFile('chat-1', file)

    expect(artifactOpen).toHaveBeenCalledOnce()
    expect((artifactOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file
    })

    window.removeEventListener('agentsdock:open-agent-file', artifactOpen)
  })
})

describe('workspace code references', () => {
  it('parses line and column references in common agent formats', () => {
    expect(parseWorkspaceCodeReference('launcher.py:72')).toEqual({
      path: 'launcher.py',
      line: 72
    })
    expect(parseWorkspaceCodeReference('robot/control/policy_runner.py:167:9')).toEqual({
      path: 'robot/control/policy_runner.py',
      line: 167,
      column: 9
    })
    expect(parseWorkspaceCodeReference('./src/App.tsx#L14C3')).toEqual({
      path: 'src/App.tsx',
      line: 14,
      column: 3
    })
    expect(parseWorkspaceCodeReference('C:\\Work\\src\\main.ts:8')).toEqual({
      path: 'C:/Work/src/main.ts',
      line: 8
    })
    expect(parseWorkspaceCodeReference('BUILD:12')).toEqual({
      path: 'BUILD',
      line: 12
    })
  })

  it('keeps ordinary inline code inert and rejects unsafe references', () => {
    expect(parseWorkspaceCodeReference('ot train')).toBeNull()
    expect(parseWorkspaceCodeReference('torch.distributed')).toBeNull()
    expect(parseWorkspaceCodeReference('https://example.com/main.py:8')).toBeNull()
    expect(parseWorkspaceCodeReference('../secret.py:4')).toBeNull()
    expect(parseWorkspaceCodeReference('main.py:0')).toBeNull()
    expect(parseWorkspaceCodeReference('main.py:4:0')).toBeNull()
  })

  it('dispatches a resolvable workspace reference with its location', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', open)

    requestOpenWorkspaceReference('chat-1', {
      path: 'launcher.py',
      line: 72,
      column: 4
    })

    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      path: 'launcher.py',
      line: 72,
      column: 4,
      resolve: true
    })
    window.removeEventListener('agentsdock:open-workspace-path', open)
  })
})
