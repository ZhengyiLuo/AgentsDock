import type {
  TeamNetworkMailboxAddress,
  TeamNetworkMailboxEntry,
  TeamNetworkPublicAddress
} from '@shared/team-network'

export interface TeamMailBundle {
  key: string
  sender: TeamNetworkPublicAddress
  entries: TeamNetworkMailboxEntry[]
  latest: TeamNetworkMailboxEntry
  unreadCount: number
}

/**
 * Build presentation-only mail bundles without inventing a server-side thread.
 * A bundle is one sender delivering to one owned mailbox. Including the receiver
 * in the key prevents a same-named sender from carrying selection across a
 * mailbox switch.
 */
export function buildTeamMailBundles(
  receiver: TeamNetworkMailboxAddress | null,
  entries: readonly TeamNetworkMailboxEntry[]
): TeamMailBundle[] {
  if (!receiver) return []
  const grouped = new Map<string, { sender: TeamNetworkPublicAddress; entries: TeamNetworkMailboxEntry[] }>()
  for (const entry of entries) {
    const key = teamMailBundleKey(receiver, entry.item.from)
    const group = grouped.get(key)
    if (group) group.entries.push(entry)
    else grouped.set(key, { sender: entry.item.from, entries: [entry] })
  }
  return [...grouped.entries()].map(([key, group]) => {
    const sorted = [...group.entries].sort(compareMailboxEntries)
    const latest = sorted.at(-1)!
    return {
      key,
      sender: latest.item.from,
      entries: sorted,
      latest,
      unreadCount: sorted.filter(entry => entry.delivery.state !== 'read').length
    }
  }).sort((left, right) => {
    const byLatest = compareMailboxEntries(right.latest, left.latest)
    return byLatest || left.key.localeCompare(right.key)
  })
}

export function teamMailBundleKey(
  receiver: TeamNetworkMailboxAddress,
  sender: TeamNetworkPublicAddress
): string {
  return `${receiver.kind}:${receiver.id}|${sender.kind}:${sender.id}`
}

function compareMailboxEntries(
  left: TeamNetworkMailboxEntry,
  right: TeamNetworkMailboxEntry
): number {
  return left.item.sequence - right.item.sequence || left.item.id.localeCompare(right.item.id)
}
