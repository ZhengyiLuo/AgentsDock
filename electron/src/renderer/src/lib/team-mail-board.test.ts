import { describe, expect, it } from 'vitest'
import type { TeamNetworkMailboxEntry } from '@shared/team-network'
import { buildTeamMailBundles } from './team-mail-board'

function mail({
  id,
  sequence,
  senderId,
  senderName,
  state = 'read',
  body = id
}: {
  id: string
  sequence: number
  senderId: string
  senderName: string
  state?: TeamNetworkMailboxEntry['delivery']['state']
  body?: string
}): TeamNetworkMailboxEntry {
  return {
    item: {
      id,
      sequence,
      kind: 'message',
      from: {
        kind: 'server',
        id: senderId,
        server_identity: `identity-${senderId}`,
        display_name: senderName
      },
      to: {
        kind: 'server',
        id: 'receiver',
        server_identity: 'identity-receiver',
        display_name: 'Receiver'
      },
      body_format: 'plain',
      body,
      request_id: null,
      created_at: `2026-09-01T00:00:${String(sequence).padStart(2, '0')}Z`,
      expires_at: null
    },
    delivery: {
      id: `delivery-${id}`,
      state,
      available_at: '2026-09-01T00:00:00Z',
      delivered_at: state === 'available' ? null : '2026-09-01T00:00:01Z',
      read_at: state === 'read' ? '2026-09-01T00:00:02Z' : null
    }
  }
}

describe('Team Mail Board bundles', () => {
  it('groups by sender, orders bundles latest-first, and orders their mail chronologically', () => {
    const bundles = buildTeamMailBundles({ kind: 'server', id: 'receiver' }, [
      mail({ id: 'a-3', sequence: 3, senderId: 'alpha', senderName: 'Alpha' }),
      mail({ id: 'b-4', sequence: 4, senderId: 'beta', senderName: 'Beta', state: 'delivered' }),
      mail({ id: 'a-1', sequence: 1, senderId: 'alpha', senderName: 'Alpha', state: 'available' })
    ])

    expect(bundles.map(bundle => bundle.sender.display_name)).toEqual(['Beta', 'Alpha'])
    expect(bundles[1].entries.map(entry => entry.item.id)).toEqual(['a-1', 'a-3'])
    expect(bundles[1].latest.item.id).toBe('a-3')
    expect(bundles[1].unreadCount).toBe(1)
  })

  it('uses ids rather than display names and fences keys by receiving mailbox', () => {
    const entries = [
      mail({ id: 'one', sequence: 1, senderId: 'first', senderName: 'Shared name' }),
      mail({ id: 'two', sequence: 2, senderId: 'second', senderName: 'Shared name' })
    ]
    const serverBundles = buildTeamMailBundles({ kind: 'server', id: 'receiver' }, entries)
    const agentBundles = buildTeamMailBundles({ kind: 'agent', id: 'receiver' }, entries)

    expect(serverBundles).toHaveLength(2)
    expect(new Set(serverBundles.map(bundle => bundle.key)).size).toBe(2)
    expect(agentBundles.map(bundle => bundle.key)).not.toEqual(serverBundles.map(bundle => bundle.key))
  })

  it('uses item id as the deterministic tie-breaker and handles no selected mailbox', () => {
    const bundles = buildTeamMailBundles({ kind: 'server', id: 'receiver' }, [
      mail({ id: 'z', sequence: 7, senderId: 'same', senderName: 'Same' }),
      mail({ id: 'a', sequence: 7, senderId: 'same', senderName: 'Same' })
    ])

    expect(bundles[0].entries.map(entry => entry.item.id)).toEqual(['a', 'z'])
    expect(buildTeamMailBundles(null, bundles[0].entries)).toEqual([])
  })

  it('uses the latest sender metadata when a server is renamed', () => {
    const bundles = buildTeamMailBundles({ kind: 'server', id: 'receiver' }, [
      mail({ id: 'old', sequence: 1, senderId: 'same', senderName: 'Old name' }),
      mail({ id: 'new', sequence: 2, senderId: 'same', senderName: 'New name' })
    ])

    expect(bundles).toHaveLength(1)
    expect(bundles[0].sender.display_name).toBe('New name')
  })
})
