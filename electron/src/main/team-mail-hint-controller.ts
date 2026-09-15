import {
  applyMailArrivalHint, applyMailPageCoverage, beginMailHintStream, mailHintRealmKey,
  parseMailArrivalCursor, parseTeamMailHintsCapability,
  type MailArrivalCursor, type MailboxCoverage, type MailHintMailbox, type MailHintPageAcknowledgment,
  type MailHintProjection, type MailHintScope, type MailHintState
} from '../shared/team-mail-hints'
import type { AgentServerClient } from './server-client'
import { acknowledgeBulletinHint, applyBulletinHint, emptyBulletinCursor, parseBulletinCursor,
  parseTeamActivityHintsCapability, type BulletinHintRefresh, type BulletinHintState } from '../shared/team-bulletin-hints'

interface Binding {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  namespace: string
  authorityKey?: string
  client: AgentServerClient
  isCurrent(): boolean
}

interface Preferences {
  preference<T>(namespace: string, key: string, fallback: T): T
  putPreference(namespace: string, key: string, value: unknown): void
}

const EMPTY: MailArrivalCursor = { through_sequence: 0, arrival_id: null }

/** Main-process singleton. It has no mailbox, roster, receipt, or agent client. */
export class TeamMailHintController {
  private binding: Binding | null = null
  private mailbox: MailHintMailbox | null = null
  private state: MailHintState | null = null
  private stopStream: (() => void) | null = null
  private epoch = 0
  private revision = 0
  private key: string | null = null
  private streamAuthenticated = false
  private bulletin: BulletinHintState | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly enabled: boolean,
    private readonly preferences: Preferences,
    private readonly emit: (projection: MailHintProjection) => void
  ) {}

  projection(profileId: string, profileGeneration: number): MailHintProjection | null {
    if (!this.binding || this.binding.profileId !== profileId || this.binding.profileGeneration !== profileGeneration) return null
    return structuredClone({ profileId, profileGeneration, revision: this.revision, state: this.state, bulletin: this.bulletin })
  }

  currentScope(): MailHintScope | null {
    return this.streamAuthenticated && this.stopStream && this.binding?.isCurrent() && this.state?.initialized && !this.state.invalid
      ? { ...this.state.scope } : null
  }

  ensure(binding: Binding, rawCapability: unknown, rawActivityCapability?: unknown): void {
    if (!this.enabled || !binding.isCurrent()) { this.retire(); return }
    let mailbox: MailHintMailbox
    let activity = false
    try {
      const newer = rawActivityCapability === undefined ? null : parseTeamActivityHintsCapability(rawActivityCapability)
      const capability = newer?.enabled ? newer : parseTeamMailHintsCapability(rawCapability)
      if (!capability.enabled || !capability.mailbox) { this.retire(); return }
      mailbox = capability.mailbox
      activity = capability.version === 2
    } catch { this.retire(); return }
    const key = JSON.stringify([binding.profileId, binding.profileGeneration, binding.serverIdentity, binding.authorityKey, mailbox, activity])
    if (this.key === key && this.stopStream) return
    this.suspend()
    const previousState = this.state
    const previousBulletin = this.bulletin
    if (this.binding?.profileId !== binding.profileId || this.binding.profileGeneration !== binding.profileGeneration
      || this.binding.serverIdentity !== binding.serverIdentity || this.mailbox?.hub_id !== mailbox.hub_id
      || this.mailbox.team_id !== mailbox.team_id
        || (mailbox.recipient_server_id !== null && this.state?.scope.recipientServerId !== mailbox.recipient_server_id)) {
      this.state = null
      this.bulletin = null
    }
    if (!activity) this.bulletin = null
    this.binding = binding
    this.mailbox = mailbox
    this.key = key
    if ((previousState && !this.state) || (previousBulletin && !this.bulletin)) this.publish()
    const epoch = this.epoch
    const current = (): boolean => this.epoch === epoch && binding.isCurrent()
    const previous = (): MailboxCoverage | null => {
      const recipient = mailbox.recipient_server_id ?? this.state?.scope.recipientServerId ?? this.rememberedRecipient(binding, mailbox)
      if (!recipient) return null
      const scope = this.makeScope(binding, mailbox, recipient, '00000000000000000000000000000000')
      const cursor = this.state && mailHintRealmKey(this.state.scope) === mailHintRealmKey(scope)
        ? this.state.seen : this.retained(binding, scope)
      return { version: 1, team_id: mailbox.team_id, recipient_server_id: recipient, ...cursor }
    }
    const stop = binding.client.mailHintStream(binding.serverIdentity, mailbox, previous, packet => {
      if (!current()) return
      const scope = this.makeScope(binding, mailbox, packet.cursor.recipient_server_id, packet.stream_id)
      if (packet.type === 'snapshot') {
        const retained = this.state && mailHintRealmKey(this.state.scope) === mailHintRealmKey(scope)
          ? this.state.seen : this.retained(binding, scope)
        this.state = beginMailHintStream(scope, retained, this.state ?? undefined)
        this.streamAuthenticated = true
      }
      if (!this.state) return
      const next = applyMailArrivalHint(this.state, scope, packet.type, packet.cursor)
      const priorBulletin = this.bulletin
      if (activity) {
        try {
          if (!packet.bulletin) throw new Error('Missing Bulletin cursor')
          const retained = this.bulletin && mailHintRealmKey(this.bulletin.scope) === mailHintRealmKey(scope)
            ? this.bulletin.seen : this.retainedBulletin(binding, scope)
          this.bulletin = applyBulletinHint(this.bulletin, scope, packet.type, packet.bulletin, retained)
        } catch { this.retire(); return }
      }
      if (next === this.state && priorBulletin === this.bulletin) return
      this.state = next
      if (next.invalid) { this.suspend(); this.publish(); return }
      if (packet.type === 'snapshot') {
        this.rememberRecipient(binding, mailbox, scope.recipientServerId)
        // A rejected restore anchor is no longer a durable acknowledgment.
        if (packet.cursor.reset) this.persistSeen(binding, next)
      }
      if (packet.type === 'snapshot') this.publish()
      else this.publishSoon()
    }, () => {
      if (!current()) return
      // Fatal auth/scope/protocol errors retire authority, not just connectivity.
      this.retire()
    }, () => { if (current()) this.streamAuthenticated = false }, activity ? {
      previousBulletin: () => {
        const recipient = mailbox.recipient_server_id ?? this.state?.scope.recipientServerId ?? this.rememberedRecipient(binding, mailbox)
        if (!recipient) return null
        const scope = this.makeScope(binding, mailbox, recipient, '00000000000000000000000000000000')
        return this.bulletin && mailHintRealmKey(this.bulletin.scope) === mailHintRealmKey(scope)
          ? { ...this.bulletin.seen } : this.retainedBulletin(binding, scope)
      }
    } : undefined)
    // A synchronous test transport may have rejected its first frame already.
    if (current()) this.stopStream = stop
    else stop()
  }

  acknowledgePage(input: MailHintPageAcknowledgment): MailHintProjection | null {
    const binding = this.binding
    if (!binding || !this.currentScope() || !this.state) return null
    const next = applyMailPageCoverage(this.state, input?.scope, input?.requestedAfter, input?.coverage)
    if (next !== this.state) {
      this.state = next
      if (next.invalid) this.suspend()
      else this.persistSeen(binding, next)
      this.publish()
    }
    return this.projection(binding.profileId, binding.profileGeneration)
  }

  acknowledgeBulletinRefresh(input: BulletinHintRefresh): MailHintProjection | null {
    const binding = this.binding
    if (!binding || !this.currentScope() || !this.bulletin) return null
    const next = acknowledgeBulletinHint(this.bulletin, input)
    if (next !== this.bulletin) {
      this.bulletin = next
      try { this.preferences.putPreference(binding.namespace, `teamBulletinHintSeen:${mailHintRealmKey(next.scope)}`, next.seen) }
      catch { /* Cache failure may repeat an indicator, never hide new content. */ }
      this.publish()
    }
    return this.projection(binding.profileId, binding.profileGeneration)
  }

  /** Unverified health stops transport but retains the quiet offline watermark. */
  suspend(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.epoch += 1
    this.streamAuthenticated = false
    const stop = this.stopStream
    this.stopStream = null
    this.key = null
    stop?.()
  }

  retire(): void {
    this.suspend()
    if (this.binding) {
      this.state = null
      this.bulletin = null
      this.publish()
    }
    this.binding = null
    this.mailbox = null
  }

  private publish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    if (!this.binding) return
    this.revision += 1
    this.emit(this.projection(this.binding.profileId, this.binding.profileGeneration)!)
  }

  private publishSoon(): void {
    // One trailing metadata publication per burst, no recurring idle timer.
    if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 100)
  }

  private retainedBulletin(binding: Binding, scope: MailHintScope) {
    try { return parseBulletinCursor(this.preferences.preference(binding.namespace, `teamBulletinHintSeen:${mailHintRealmKey(scope)}`, emptyBulletinCursor(scope.teamId))) }
    catch { return emptyBulletinCursor(scope.teamId) }
  }

  private makeScope(binding: Binding, mailbox: MailHintMailbox, recipientServerId: string, streamId: string): MailHintScope {
    return { profileId: binding.profileId, profileGeneration: binding.profileGeneration, serverIdentity: binding.serverIdentity,
      hubId: mailbox.hub_id, teamId: mailbox.team_id, recipientServerId, streamId }
  }

  private recipientKey(binding: Binding, mailbox: MailHintMailbox): string {
    return `teamMailHintRecipient:${JSON.stringify([binding.profileId, binding.serverIdentity, mailbox.hub_id, mailbox.team_id])}`
  }

  private rememberedRecipient(binding: Binding, mailbox: MailHintMailbox): string | null {
    try {
      const value = this.preferences.preference<unknown>(binding.namespace, this.recipientKey(binding, mailbox), null)
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value ? value : null
    } catch { return null }
  }

  private rememberRecipient(binding: Binding, mailbox: MailHintMailbox, recipient: string): void {
    if (this.rememberedRecipient(binding, mailbox) === recipient) return
    try { this.preferences.putPreference(binding.namespace, this.recipientKey(binding, mailbox), recipient) } catch { /* Metadata cache is best effort. */ }
  }

  private retained(binding: Binding, scope: MailHintScope): MailArrivalCursor {
    try { return parseMailArrivalCursor(this.preferences.preference(binding.namespace, `teamMailHintSeen:${mailHintRealmKey(scope)}`, EMPTY)) }
    catch { return EMPTY }
  }

  private persistSeen(binding: Binding, state: MailHintState): void {
    try { this.preferences.putPreference(binding.namespace, `teamMailHintSeen:${mailHintRealmKey(state.scope)}`, state.seen) }
    catch { /* Failing to cache review state may repeat a badge, never suppress it. */ }
  }
}
