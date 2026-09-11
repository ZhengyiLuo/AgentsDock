import type { Health } from '../types'

export const TEAM_MAIL_COMMAND = '/mail'
export const TEAM_MAIL_COMMAND_TEMPLATE = '/mail server '
export const TEAM_MAIL_COMMAND_SYNTAX = '/mail server <name> <message>'

const TEAM_MAIL_COMMAND_PATTERN = /^\/mail server \S+\s+[\s\S]*\S$/

/** Show the mobile command suggestion while the user types the `/mail` token. */
export function isTeamMailCommandCandidate(value: string): boolean {
  const query = value.trimStart()
  return query.length > 0
    && !/\s/u.test(query)
    && TEAM_MAIL_COMMAND.startsWith(query.toLocaleLowerCase())
}

/** Mirror the desktop capability gate without exposing provider credentials. */
export function teamMailCapabilityError(health: Health | null | undefined): string | null {
  const capability = health?.capabilities?.agent_team_mail_v1
  if (
    capability?.available === true
    && capability.features?.deterministic_server_message_command === true
  ) return null
  return capability?.available === true
    ? 'Update AgentsServer to send deterministic Team Network mail from Chat.'
    : capability?.message || 'Update AgentsServer to send Team Network mail from Chat.'
}

/** Return a blocking error only when the outgoing prompt invokes exact `/mail`. */
export function teamMailCommandError(health: Health | null | undefined, value: string): string | null {
  const command = value.trim()
  if (command.split(/\s/u, 1)[0] !== TEAM_MAIL_COMMAND) return null
  const capabilityError = teamMailCapabilityError(health)
  if (capabilityError) return capabilityError
  return TEAM_MAIL_COMMAND_PATTERN.test(command)
    ? null
    : `Use ${TEAM_MAIL_COMMAND_SYNTAX}. Server names must be one word and the message cannot be empty.`
}
