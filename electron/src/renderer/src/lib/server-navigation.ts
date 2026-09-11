import type { PublicServerProfile } from '@shared/types'

export function adjacentServerProfileId(
  profiles: readonly Pick<PublicServerProfile, 'id'>[],
  activeProfileId: string | null,
  direction: 1 | -1
): string | null {
  if (profiles.length < 2 || !activeProfileId) return null
  const current = profiles.findIndex(profile => profile.id === activeProfileId)
  if (current < 0) return null
  return profiles[(current + direction + profiles.length) % profiles.length]?.id ?? null
}
