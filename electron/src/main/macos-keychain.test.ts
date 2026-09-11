import { describe, expect, it, vi } from 'vitest'

import {
  buildMacOSKeychainWriteCommand,
  writeMacOSKeychainPassword,
  type MacOSKeychainCommandRunner
} from './macos-keychain'

describe('macOS Keychain command transport', () => {
  it.each([
    ['AgentsServer admin token', 'com.zhengyiluo.AgentsDock', 'agent-access-token:profile-a', 'a'.repeat(64)],
    ['Team Hub refresh token', 'com.zhengyiluo.AgentsDock.TeamHub', 'refresh-token:profile-a', 'refresh.abcDEF123_-xyz']
  ])('keeps the %s out of argv and sends it only through stdin', (_label, service, account, token) => {
    const command = buildMacOSKeychainWriteCommand(service, account, token)

    expect(command).toEqual({
      args: ['-i'],
      input: `add-generic-password -U -s ${service} -a ${account} -w ${token}\n`
    })
    expect(command?.args.join(' ')).not.toContain(token)
  })

  it.each([
    ['space', 'refresh token'],
    ['quote', 'refresh."token'],
    ['backslash', 'refresh.abc\\def'],
    ['newline', 'refresh.abc\ndef'],
    ['oversized value', `refresh.${'a'.repeat(505)}`]
  ])('rejects a %s rather than interpolating it into the interactive command', (_label, token) => {
    expect(buildMacOSKeychainWriteCommand(
      'com.zhengyiluo.AgentsDock.TeamHub',
      'refresh-token:profile-a',
      token
    )).toBeNull()
  })

  it('invokes only security interactive mode and reports command failures', () => {
    const run = vi.fn<MacOSKeychainCommandRunner>()
    const token = 'refresh.abcDEF123_-xyz'

    expect(writeMacOSKeychainPassword(
      'com.zhengyiluo.AgentsDock.TeamHub',
      'refresh-token:profile-a',
      token,
      run
    )).toBe(true)
    expect(run).toHaveBeenCalledWith('/usr/bin/security', ['-i'], {
      encoding: 'utf8',
      input: `add-generic-password -U -s com.zhengyiluo.AgentsDock.TeamHub -a refresh-token:profile-a -w ${token}\n`,
      timeout: 3_000,
      stdio: ['pipe', 'ignore', 'pipe']
    })

    const failingRun = vi.fn<MacOSKeychainCommandRunner>(() => { throw new Error('keychain locked') })
    expect(writeMacOSKeychainPassword(
      'com.zhengyiluo.AgentsDock.TeamHub',
      'refresh-token:profile-a',
      token,
      failingRun
    )).toBe(false)
  })

  it('does not invoke security for a non-literal account or secret', () => {
    const run = vi.fn<MacOSKeychainCommandRunner>()

    expect(writeMacOSKeychainPassword(
      'com.zhengyiluo.AgentsDock.TeamHub',
      'refresh-token:profile with space',
      'refresh.valid',
      run
    )).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
