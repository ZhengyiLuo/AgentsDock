import { resolve } from 'node:path'
import { normalizeSecurePeerJoinTarget } from '../shared/secure-peer'

export const SECURE_PEER_INVITE_EVENT = 'native:secure-peer-invite' as const
export const SECURE_PEER_PROTOCOL = 'agentsdock' as const

export interface SecurePeerInvitePayload {
  invite: string
}

export interface SecurePeerDeepLinkLifecycleOptions {
  packaged: boolean
  platform: NodeJS.Platform
  defaultApp: boolean | undefined
  execPath: string
  argv: readonly string[]
  router: SecurePeerDeepLinkRouter
  showMainWindow: () => void
  registerOpenURL: (listener: (event: { preventDefault(): void }, url: string) => void) => void
  registerSecondInstance: (listener: (commandLine: readonly string[]) => void) => void
  setDefaultProtocolClient: (scheme: string, executable?: string, args?: string[]) => boolean
}

type InviteDelivery = (payload: SecurePeerInvitePayload) => boolean

/**
 * Keeps at most one validated server invite while the renderer is unavailable.
 * A newer valid invite deterministically replaces an older pending invite.
 */
export class SecurePeerDeepLinkRouter {
  private pendingInvite: string | null = null
  private delivery: InviteDelivery | null = null

  offer(candidate: unknown): boolean {
    const invite = canonicalSecurePeerInvite(candidate)
    if (!invite) return false
    this.pendingInvite = invite
    this.flush()
    return true
  }

  offerArgv(argv: readonly string[]): boolean {
    const invite = newestSecurePeerInviteFromArgv(argv)
    return invite ? this.offer(invite) : false
  }

  rendererReady(delivery: InviteDelivery): void {
    this.delivery = delivery
    this.flush()
  }

  rendererUnavailable(): void {
    this.delivery = null
  }

  pending(): string | null {
    return this.pendingInvite
  }

  private flush(): void {
    if (!this.delivery || !this.pendingInvite) return
    const invite = this.pendingInvite
    if (this.delivery({ invite })) this.pendingInvite = null
  }
}

export function canonicalSecurePeerInvite(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.startsWith('agentsdock://')) return null
  try {
    const target = normalizeSecurePeerJoinTarget(candidate)
    if (!target.expectedCaFingerprint) return null
    return `agentsdock://secure-peer/join?host=${target.host}&port=${target.port}&fingerprint=${encodeURIComponent(target.expectedCaFingerprint)}`
  } catch {
    return null
  }
}

export function newestSecurePeerInviteFromArgv(argv: readonly string[]): string | null {
  let newest: string | null = null
  for (const argument of argv) {
    const invite = canonicalSecurePeerInvite(argument)
    if (invite) newest = invite
  }
  return newest
}

export function securePeerProtocolRegistration(
  packaged: boolean,
  platform: NodeJS.Platform,
  defaultApp: boolean | undefined,
  execPath: string,
  argv: readonly string[]
): { scheme: typeof SECURE_PEER_PROTOCOL; executable?: string; args?: string[] } | null {
  if (packaged) return { scheme: SECURE_PEER_PROTOCOL }
  if (platform !== 'win32' || !defaultApp || typeof argv[1] !== 'string' || !argv[1].trim()) return null
  return {
    scheme: SECURE_PEER_PROTOCOL,
    executable: execPath,
    args: [resolve(argv[1])]
  }
}

/** Install the OS-facing launch hooks without granting them any network capability. */
export function installSecurePeerDeepLinkLifecycle(options: SecurePeerDeepLinkLifecycleOptions): boolean | null {
  const registration = securePeerProtocolRegistration(
    options.packaged,
    options.platform,
    options.defaultApp,
    options.execPath,
    options.argv
  )
  const registered = registration
    ? options.setDefaultProtocolClient(registration.scheme, registration.executable, registration.args)
    : null

  options.router.offerArgv(options.argv)
  options.registerOpenURL((event, url) => {
    event.preventDefault()
    if (options.router.offer(url)) options.showMainWindow()
  })
  options.registerSecondInstance(commandLine => {
    options.router.offerArgv(commandLine)
    options.showMainWindow()
  })
  return registered
}
