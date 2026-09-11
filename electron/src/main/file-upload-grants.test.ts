import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileUploadGrantRegistry } from './file-upload-grants'

const roots: string[] = []
const scope = { profileId: 'profile-a', profileGeneration: 7, rendererId: 41 }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; first: string; second: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-upload-grant-'))
  roots.push(root)
  const first = join(root, 'first.txt')
  const second = join(root, 'second.txt')
  writeFileSync(first, 'first')
  writeFileSync(second, 'second')
  return { root, first, second }
}

function admitPaths(
  grants: FileUploadGrantRegistry,
  paths: readonly string[],
  grantScope = scope,
  sessionId = 'chat-a'
): string[] {
  const admitted = grants.admit(paths, grantScope, sessionId)
  try {
    return admitted.map(file => file.canonicalPath)
  } finally {
    for (const file of admitted) file.close()
  }
}

describe('FileUploadGrantRegistry', () => {
  it('bounds renderer batches and path strings before filesystem resolution', () => {
    const { first, second } = fixture()
    const realpath = vi.fn((path: string) => realpathSync(path))
    const grants = new FileUploadGrantRegistry({ maxEntries: 2, realpath })

    expect(() => grants.register([first, second, '/not-resolved'], scope)).toThrow(/too many files/i)
    expect(realpath).not.toHaveBeenCalled()
    expect(() => grants.admit([first, second, '/not-resolved'], scope, 'chat-a')).toThrow(/too many files/i)
    expect(() => grants.register(['x'.repeat(4_097)], scope)).toThrow(/choose this file again/i)
    expect(realpath).not.toHaveBeenCalled()
  })

  it('rejects arbitrary paths and atomically binds a chosen batch to one exact scope and chat', () => {
    const { first, second } = fixture()
    const grants = new FileUploadGrantRegistry()
    expect(() => grants.admit([first], scope, 'chat-a')).toThrow(/choose this file again/i)

    grants.register([first, second], scope)
    expect(admitPaths(grants, [first, second])).toEqual([realpathSync(first), realpathSync(second)])
    expect(admitPaths(grants, [first, second])).toEqual([realpathSync(first), realpathSync(second)])
    expect(() => grants.admit([first], scope, 'chat-b')).toThrow(/choose this file again/i)
    expect(() => grants.admit([second], { ...scope, profileGeneration: 8 }, 'chat-a')).toThrow(/choose this file again/i)
    expect(() => grants.admit([second], { ...scope, rendererId: 42 }, 'chat-a')).toThrow(/choose this file again/i)
  })

  it('allows only a bounded number of same-chat retries and expires grants', () => {
    const { first } = fixture()
    let now = 1_000
    const grants = new FileUploadGrantRegistry({ now: () => now, ttlMs: 100, maxAdmissions: 2 })
    grants.register([first], scope)
    expect(admitPaths(grants, [first])).toEqual([realpathSync(first)])
    expect(admitPaths(grants, [first])).toEqual([realpathSync(first)])
    expect(() => grants.admit([first], scope, 'chat-a')).toThrow(/choose this file again/i)

    grants.register([first], scope)
    now += 100
    expect(() => grants.admit([first], scope, 'chat-a')).toThrow(/choose this file again/i)
  })

  it('does not partially bind a batch when another path is unauthorized', () => {
    const { first, second } = fixture()
    const grants = new FileUploadGrantRegistry()
    grants.register([first], scope)
    expect(() => grants.admit([first, second], scope, 'chat-a')).toThrow(/choose this file again/i)
    expect(admitPaths(grants, [first], scope, 'chat-b')).toEqual([realpathSync(first)])
  })

  it('rejects a chooser symlink if its target changes before upload and uploads the original canonical target', () => {
    const { root, first, second } = fixture()
    const link = join(root, 'chosen.txt')
    symlinkSync(first, link)
    const grants = new FileUploadGrantRegistry()
    grants.register([link], scope)
    const admitted = grants.admit([link], scope, 'chat-a')
    expect(admitted.map(file => file.canonicalPath)).toEqual([realpathSync(first)])
    expect(readFileSync(admitted[0].fd, 'utf8')).toBe('first')
    admitted[0].close()

    grants.register([link], scope)
    unlinkSync(link)
    symlinkSync(second, link)
    expect(() => grants.admit([link], scope, 'chat-a')).toThrow(/choose this file again/i)
  })

  it('binds a Team attachment grant to one renderer, profile generation, team, and declaration', () => {
    const { first } = fixture()
    const grants = new FileUploadGrantRegistry()
    grants.register([first], scope)
    grants.reserveDeclaration(first, scope, 'team:team-a').close()
    grants.bindDeclaration(first, scope, 'team:team-a', 'attachment-a')

    expect(() => grants.admit([first], scope, 'team:team-a', 'attachment-b')).toThrow(/choose this file again/i)
    expect(() => grants.admit([first], scope, 'team:team-b', 'attachment-a')).toThrow(/choose this file again/i)
    expect(() => grants.admit([first], { ...scope, rendererId: 42 }, 'team:team-a', 'attachment-a')).toThrow(/choose this file again/i)
    expect(() => grants.admit([first], { ...scope, profileGeneration: 8 }, 'team:team-a', 'attachment-a')).toThrow(/choose this file again/i)
    const admitted = grants.admit([first], scope, 'team:team-a', 'attachment-a')
    expect(admitted[0].canonicalPath).toBe(realpathSync(first))
    admitted[0].close()
  })

  it('serializes declaration creation while permitting a bounded deliberate retry', () => {
    const { first } = fixture()
    const grants = new FileUploadGrantRegistry({ maxAdmissions: 4 })
    grants.register([first], scope)

    const firstReservation = grants.reserveDeclaration(first, scope, 'team:team-a')
    expect(() => grants.reserveDeclaration(first, scope, 'team:team-a')).toThrow(/choose this file again/i)
    grants.bindDeclaration(first, scope, 'team:team-a', 'attachment-a')
    firstReservation.close()

    const retryReservation = grants.reserveDeclaration(first, scope, 'team:team-a')
    grants.bindDeclaration(first, scope, 'team:team-a', 'attachment-b')
    retryReservation.close()
    expect(() => grants.admit([first], scope, 'team:team-a', 'attachment-a')).toThrow(/choose this file again/i)
    const retryUpload = grants.admit([first], scope, 'team:team-a', 'attachment-b')
    retryUpload[0].close()
  })

  it('closes an admitted descriptor when its renderer grant is revoked', () => {
    const { first } = fixture()
    const grants = new FileUploadGrantRegistry()
    grants.register([first], scope)
    const admitted = grants.reserveDeclaration(first, scope, 'team:team-a')

    grants.revokeRenderer(scope.rendererId)

    expect(() => readFileSync(admitted.fd, 'utf8')).toThrow()
    expect(() => grants.bindDeclaration(first, scope, 'team:team-a', 'attachment-a'))
      .toThrow(/choose this file again/i)
  })

  it('revokes grants on renderer and profile teardown', () => {
    const { first, second } = fixture()
    const grants = new FileUploadGrantRegistry()
    grants.register([first], scope)
    grants.register([second], { ...scope, rendererId: 42 })
    grants.revokeRenderer(scope.rendererId)
    expect(() => grants.admit([first], scope, 'chat-a')).toThrow(/choose this file again/i)
    expect(admitPaths(grants, [second], { ...scope, rendererId: 42 })).toEqual([realpathSync(second)])
    grants.clear()
    expect(() => grants.admit([second], { ...scope, rendererId: 42 }, 'chat-a')).toThrow(/choose this file again/i)
  })

  it('cleans managed staged files on release and expiry', () => {
    const { first, second } = fixture()
    let now = 1_000
    const firstCleanup = vi.fn()
    const secondCleanup = vi.fn()
    const grants = new FileUploadGrantRegistry({ now: () => now, ttlMs: 100 })
    grants.registerManaged(first, scope, firstCleanup)
    grants.registerManaged(second, scope, secondCleanup)
    for (const admitted of grants.admit([first], scope, 'chat-a')) admitted.close()
    grants.releaseManaged(first, scope)
    expect(firstCleanup).toHaveBeenCalledOnce()

    now += 100
    expect(() => grants.admit([second], scope, 'chat-a')).toThrow(/choose this file again/i)
    expect(secondCleanup).toHaveBeenCalledOnce()
  })
})
