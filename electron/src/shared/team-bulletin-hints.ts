/** Body-free Bulletin changes on the same negotiated stream as Mail. */
import {
  beginMailHintStream, mailHintRealmKey, parseMailArrivalHint, parseMailHintPacket,
  parseTeamMailHintsCapability,
  type MailHintPacket, type MailHintScope, type TeamMailHintsCapability
} from './team-mail-hints'

export const TEAM_ACTIVITY_HINTS_PROTOCOL = 'agentsdock.team-mail-hints.v2'
export interface TeamActivityHintsCapability extends Omit<TeamMailHintsCapability, 'version' | 'websocket_protocol'> {
  version: 2
  websocket_protocol: typeof TEAM_ACTIVITY_HINTS_PROTOCOL
  bulletin_coverage: true
}
export interface BulletinChangeCursor {
  version: 1
  team_id: string
  through_sequence: number
  change_id: string | null
  message_id: string | null
  change_kind: 'created' | 'revised' | 'deleted' | null
  message_version: number | null
}
export interface BulletinChangeHint extends BulletinChangeCursor { reset: boolean }
export interface BulletinHintState {
  scope: Readonly<MailHintScope>
  seen: Readonly<BulletinChangeCursor>
  latest: Readonly<BulletinChangeCursor>
}
export interface BulletinHintRefresh {
  scope: MailHintScope
  cursor: BulletinChangeCursor
}
export type TeamActivityHintPacket = MailHintPacket & { bulletin?: BulletinChangeHint }

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bulletin hint')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error('Invalid Bulletin hint')
  return row
}
const fields = ['version', 'team_id', 'through_sequence', 'change_id', 'message_id', 'change_kind', 'message_version']
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value

export function emptyBulletinCursor(teamId: string): BulletinChangeCursor {
  return { version: 1, team_id: teamId, through_sequence: 0, change_id: null, message_id: null, change_kind: null, message_version: null }
}
export function parseBulletinCursor(value: unknown): BulletinChangeCursor {
  const row = exact(value, fields)
  if (row.version !== 1 || !matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.team_id)
    || !Number.isSafeInteger(row.through_sequence) || Number(row.through_sequence) < 0) throw new Error('Invalid Bulletin cursor')
  if (row.through_sequence === 0) {
    if ([row.change_id, row.message_id, row.change_kind, row.message_version].some(value => value !== null)) throw new Error('Invalid empty Bulletin cursor')
  } else if (!matches(/^bchg_[0-9a-f]{32}$/, row.change_id)
    || !matches(/^tmsg_[0-9a-f]{32}$/, row.message_id)
    || typeof row.change_kind !== 'string' || !['created', 'revised', 'deleted'].includes(row.change_kind)
    || !Number.isSafeInteger(row.message_version) || Number(row.message_version) < 1) throw new Error('Invalid Bulletin change')
  return { ...row } as unknown as BulletinChangeCursor
}
export function parseBulletinHint(value: unknown): BulletinChangeHint {
  const { reset, ...row } = exact(value, [...fields, 'reset'])
  if (typeof reset !== 'boolean') throw new Error('Invalid Bulletin reset')
  return { ...parseBulletinCursor(row), reset }
}
export function parseTeamActivityHintsCapability(value: unknown): TeamActivityHintsCapability {
  const row = exact(value, ['enabled', 'version', 'websocket_path', 'websocket_protocol', 'mailbox_coverage', 'bulletin_coverage', 'mailbox'])
  if (row.version !== 2 || row.websocket_protocol !== TEAM_ACTIVITY_HINTS_PROTOCOL || row.bulletin_coverage !== true) throw new Error('Invalid Team activity capability')
  const { bulletin_coverage: _bulletin, ...mail } = row
  parseTeamMailHintsCapability({ ...mail, version: 1, websocket_protocol: 'agentsdock.team-mail-hints.v1' })
  return row as unknown as TeamActivityHintsCapability
}
/** Normalize v2 at the transport seam; the v1 Mail reducer remains unchanged. */
export function parseTeamActivityHintPacket(value: unknown): TeamActivityHintPacket {
  const row = exact(value, ['type', 'server_identity', 'hub_id', 'stream_id', 'cursor'])
  const cursor = exact(row.cursor, ['version', 'mail', 'bulletin'])
  if (cursor.version !== 2) throw new Error('Invalid Team activity cursor')
  const mail = parseMailHintPacket({ ...row, cursor: parseMailArrivalHint(cursor.mail) })
  const bulletin = parseBulletinHint(cursor.bulletin)
  if (bulletin.team_id !== mail.cursor.team_id || (mail.type === 'hint' && bulletin.reset)) throw new Error('Invalid Bulletin scope')
  return { ...mail, bulletin }
}
export function bulletinHintPending(state: BulletinHintState): boolean {
  return state.latest.through_sequence > state.seen.through_sequence
    || (state.latest.through_sequence === state.seen.through_sequence && state.latest.change_id !== state.seen.change_id)
}
export function sameBulletinHintScope(left: MailHintScope, right: MailHintScope): boolean {
  return left.profileGeneration === right.profileGeneration && left.streamId === right.streamId && mailHintRealmKey(left) === mailHintRealmKey(right)
}
export function applyBulletinHint(previous: BulletinHintState | null, scope: MailHintScope,
  kind: 'snapshot' | 'hint', raw: BulletinChangeHint, retained: unknown): BulletinHintState {
  const { reset, ...cursor } = parseBulletinHint(raw)
  if (cursor.team_id !== scope.teamId) throw new Error('Bulletin team changed')
  if (kind === 'snapshot') {
    let seen = emptyBulletinCursor(scope.teamId)
    if (!reset) {
      try { seen = parseBulletinCursor(retained) } catch { /* Missing cache is unseen. */ }
      if (seen.team_id !== scope.teamId || seen.through_sequence > cursor.through_sequence
        || (seen.through_sequence === cursor.through_sequence && seen.change_id !== cursor.change_id)) throw new Error('Invalid Bulletin restore')
    }
    return { scope: { ...scope }, seen, latest: cursor }
  }
  if (reset || !previous || !sameBulletinHintScope(previous.scope, scope)) throw new Error('Invalid Bulletin stream')
  if (cursor.through_sequence === previous.latest.through_sequence && cursor.change_id !== previous.latest.change_id) throw new Error('Contradictory Bulletin cursor')
  return cursor.through_sequence <= previous.latest.through_sequence ? previous : { ...previous, latest: cursor }
}
export function parseBulletinHintRefresh(value: unknown): BulletinHintRefresh {
  const row = exact(value, ['scope', 'cursor'])
  const scope = exact(row.scope, ['profileId', 'profileGeneration', 'streamId', 'serverIdentity', 'hubId', 'teamId', 'recipientServerId'])
  const checked = beginMailHintStream(scope as unknown as MailHintScope).scope
  const cursor = parseBulletinCursor(row.cursor)
  if (cursor.team_id !== checked.teamId) throw new Error('Bulletin team changed')
  return { scope: { ...checked }, cursor }
}
/** Acknowledges only the head captured before an explicit complete refresh. */
export function acknowledgeBulletinHint(state: BulletinHintState, input: BulletinHintRefresh): BulletinHintState {
  if (!sameBulletinHintScope(state.scope, input.scope) || input.cursor.team_id !== state.scope.teamId
    || input.cursor.through_sequence > state.latest.through_sequence
    || (input.cursor.through_sequence === state.latest.through_sequence && input.cursor.change_id !== state.latest.change_id)
    || input.cursor.through_sequence < state.seen.through_sequence) return state
  if (input.cursor.through_sequence === state.seen.through_sequence && input.cursor.change_id === state.seen.change_id) return state
  return { ...state, seen: { ...input.cursor } }
}
