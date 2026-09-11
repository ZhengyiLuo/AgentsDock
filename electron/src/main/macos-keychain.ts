import { execFileSync } from 'node:child_process'

const SECURITY_TOOL = '/usr/bin/security'
const MAX_INTERACTIVE_LITERAL_LENGTH = 512
const INTERACTIVE_LITERAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-]*$/

export interface MacOSKeychainWriteCommand {
  args: ['-i']
  input: string
}

export type MacOSKeychainCommandRunner = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8'
    input: string
    timeout: number
    stdio: ['pipe', 'ignore', 'pipe']
  }
) => unknown

/**
 * Build one command for `security -i`. The interactive parser treats spaces,
 * quotes, and backslashes as syntax, so only bounded literal tokens are
 * accepted. Callers can fall back to Electron safeStorage for any other value.
 */
export function buildMacOSKeychainWriteCommand(
  service: string,
  account: string,
  value: string
): MacOSKeychainWriteCommand | null {
  if (![service, account, value].every(isInteractiveLiteral)) return null
  return {
    args: ['-i'],
    input: `add-generic-password -U -s ${service} -a ${account} -w ${value}\n`
  }
}

/** Store a generic password without ever placing the password in process argv. */
export function writeMacOSKeychainPassword(
  service: string,
  account: string,
  value: string,
  run: MacOSKeychainCommandRunner = runSecurityCommand
): boolean {
  const command = buildMacOSKeychainWriteCommand(service, account, value)
  if (!command) return false
  try {
    run(SECURITY_TOOL, command.args, {
      encoding: 'utf8',
      input: command.input,
      timeout: 3_000,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    return true
  } catch {
    return false
  }
}

function isInteractiveLiteral(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_INTERACTIVE_LITERAL_LENGTH
    && INTERACTIVE_LITERAL_PATTERN.test(value)
}

const runSecurityCommand: MacOSKeychainCommandRunner = (file, args, options) => {
  return execFileSync(file, args, options)
}
