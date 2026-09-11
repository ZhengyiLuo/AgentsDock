import type { Health } from '../types'
import {
  isTeamMailCommandCandidate,
  TEAM_MAIL_COMMAND_TEMPLATE,
  teamMailCapabilityError,
  teamMailCommandError,
} from './team-mail-command'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const capable: Health = {
  ok: true,
  capabilities: {
    agent_team_mail_v1: {
      available: true,
      version: 1,
      explicit_command: '/mail',
      command_syntax: '/mail server <name> <message>',
      features: { deterministic_server_message_command: true },
    },
  },
}

assert(isTeamMailCommandCandidate('/'), 'typing slash must discover the mail command')
assert(isTeamMailCommandCandidate('/ma'), 'a partial mail token must retain the command suggestion')
assert(isTeamMailCommandCandidate('/MAIL'), 'command discovery may normalize case before inserting the exact token')
assert(!isTeamMailCommandCandidate('/mail '), 'the suggestion must close once command arguments begin')
assert(TEAM_MAIL_COMMAND_TEMPLATE === '/mail server ', 'the inserted command must use the exact server-addressed syntax')
assert(teamMailCapabilityError(capable) === null, 'the deterministic mail capability must enable the command')
assert(
  teamMailCapabilityError({ ok: true, capabilities: { agent_team_mail_v1: { available: true, version: 1, features: {} } } })
    === 'Update AgentsServer to send deterministic Team Network mail from Chat.',
  'a partial capability must fail closed',
)
assert(
  teamMailCapabilityError({ ok: true, capabilities: { agent_team_mail_v1: { available: false, version: 1, message: 'Mail is disabled.' } } }) === 'Mail is disabled.',
  'an unavailable capability must preserve the server diagnostic',
)
assert(teamMailCommandError(capable, 'ordinary prompt') === null, 'ordinary prompts must bypass the mail gate')
assert(teamMailCommandError(capable, '/mail server Studio hello') === null, 'a valid deterministic mail command must pass')
assert(teamMailCommandError(capable, '/mail server Studio hello\nfrom mobile') === null, 'a multiline non-empty message must pass')
assert(teamMailCommandError(capable, '/mail server Studio')?.startsWith('Use /mail server') === true, 'a missing message must fail')
assert(teamMailCommandError(capable, '/mail Studio hello')?.startsWith('Use /mail server') === true, 'a missing server target kind must fail')
assert(teamMailCommandError(null, '/mail server Studio hello') === 'Update AgentsServer to send Team Network mail from Chat.', 'an old server must fail closed')

console.log('team mail command regressions passed')
