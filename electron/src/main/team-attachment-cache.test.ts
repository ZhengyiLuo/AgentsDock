import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamAttachment } from '../shared/team-network'
import { TeamAttachmentCache, type TeamAttachmentCacheIdentity } from './team-attachment-cache'

const roots: string[] = []

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-team-attachment-cache-'))
  roots.push(root)
  return root
}

function fixture(bytes: Uint8Array, attachmentId = 'attachment-1', fileName = 'sample.bin'): TeamAttachment {
  return {
    id: attachmentId,
    team_id: 'team-1',
    message_id: 'message-1',
    file_name: fileName,
    media_type: 'application/octet-stream',
    byte_size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    state: 'ready',
    received_bytes: bytes.byteLength,
    created_at: '2026-09-03T12:00:00Z',
    ready_at: '2026-09-03T12:00:01Z'
  }
}

function identity(
  profileId: string,
  attachmentId = 'attachment-1',
  serverIdentity = 'server-1'
): TeamAttachmentCacheIdentity {
  return {
    profileId,
    profileGeneration: 3,
    authGeneration: 5,
    authCacheEpoch: '11111111-1111-4111-8111-111111111111',
    serverIdentity,
    hubId: 'hub-1',
    teamId: 'team-1',
    attachmentId
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('TeamAttachmentCache', () => {
  it('reuses one profile-scoped file across restart generations and purges no other profile', async () => {
    const bytes = Buffer.from('stable-across-restarts')
    const attachment = fixture(bytes)
    const download = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    const root = cacheRoot()
    const cache = new TeamAttachmentCache(root, 1_024)
    const firstIdentity = identity('profile-a')
    const restartedIdentity = { ...firstIdentity, profileGeneration: 47 }
    const firstPath = await cache.cache(firstIdentity, attachment, bytes.byteLength, download)
    const restartedPath = await cache.cache(restartedIdentity, attachment, bytes.byteLength, download)
    expect(restartedPath).toBe(firstPath)
    expect(download).toHaveBeenCalledOnce()
    expect((await cache.response(restartedIdentity, new Request('https://local.invalid/media'))).status).toBe(200)

    const profileBPath = await cache.cache(identity('profile-b'), attachment, bytes.byteLength, download)
    const profileADirectory = dirname(dirname(dirname(dirname(firstPath))))
    const legacySecret = join(
      profileADirectory,
      '99',
      Buffer.from('hub-1').toString('base64url'),
      Buffer.from('team-1').toString('base64url'),
      Buffer.from('legacy-attachment').toString('base64url'),
      'content.bin'
    )
    await mkdir(dirname(legacySecret), { recursive: true })
    await writeFile(legacySecret, 'legacy plaintext')

    await cache.purgeProfile('profile-a')
    expect(existsSync(profileADirectory)).toBe(false)
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(legacySecret)).toBe(false)
    expect(existsSync(profileBPath)).toBe(true)
    expect((await cache.response(identity('profile-b'), new Request('https://local.invalid/media'))).status).toBe(200)
  })

  it('never reuses attachment bytes across an AgentsServer identity reset', async () => {
    const bytes = Buffer.from('same-hub-object-declaration')
    const attachment = fixture(bytes)
    const download = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const oldAuthority = identity('profile-a', attachment.id, 'server-a')
    const replacementAuthority = {
      ...identity('profile-a', attachment.id, 'server-b'),
      profileGeneration: oldAuthority.profileGeneration + 1
    }

    const oldPath = await cache.cache(oldAuthority, attachment, bytes.byteLength, download)
    const replacementPath = await cache.cache(replacementAuthority, attachment, bytes.byteLength, download)

    expect(replacementPath).not.toBe(oldPath)
    expect(download).toHaveBeenCalledTimes(2)
    expect((await cache.response(oldAuthority, new Request('https://local.invalid/media'))).status).toBe(200)
    expect((await cache.response(replacementAuthority, new Request('https://local.invalid/media'))).status).toBe(200)
  })

  it('cancels an active profile transfer before its purge barrier and permits a post-purge generation', async () => {
    const bytes = Buffer.from('purge-barrier')
    const attachment = fixture(bytes)
    let startedFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { startedFirst = resolve })
    const download = vi.fn(async (start: number, end: number) => {
      if (download.mock.calls.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(start, start + 1))
            startedFirst()
            // Deliberately never close: purge must cancel the pending read.
          }
        }), {
          status: 206,
          headers: {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
          }
        })
      }
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    })
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const first = cache.cache(identity('profile-a'), attachment, bytes.byteLength, download)
    await firstStarted
    const purge = cache.purgeProfile('profile-a')
    const afterPurge = cache.cache(
      { ...identity('profile-a'), profileGeneration: 88 },
      attachment,
      bytes.byteLength,
      download
    )
    await expect(first).rejects.toThrow(/purged/i)
    await purge
    const finalPath = await afterPurge
    expect(download).toHaveBeenCalledTimes(2)
    expect(existsSync(finalPath)).toBe(true)
  })

  it('aborts an admitted media response before purging its retired profile bytes', async () => {
    const bytes = Buffer.alloc(128 * 1024, 0x61)
    const attachment = fixture(bytes)
    const cache = new TeamAttachmentCache(cacheRoot(), 256 * 1024)
    await cache.cache(identity('profile-a'), attachment, bytes.byteLength, async (start, end) => (
      new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    ))
    const response = await cache.response(identity('profile-a'), new Request('https://local.invalid/media'))
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value?.byteLength).toBe(64 * 1024)

    await cache.purgeProfile('profile-a')

    await expect(reader.read()).rejects.toThrow(/purged/i)
  })

  it('denies retained GET, HEAD, and range media requests after a profile purge', async () => {
    const bytes = Buffer.from('private attachment bytes')
    const attachment = fixture(bytes)
    const cacheIdentity = identity('profile-a')
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    await cache.cache(cacheIdentity, attachment, bytes.byteLength, async (start, end) => (
      new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    ))

    await cache.purgeProfile(cacheIdentity.profileId)

    const requests = [
      new Request('https://local.invalid/media'),
      new Request('https://local.invalid/media', { method: 'HEAD' }),
      new Request('https://local.invalid/media', { headers: { Range: 'bytes=0-3' } })
    ]
    for (const request of requests) {
      const response = await cache.response(cacheIdentity, request)
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('does not queue one profile purge behind an unrelated profile download', async () => {
    const bytes = Buffer.from('profile-isolated-transfer')
    const attachment = fixture(bytes)
    let releaseDownload!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseDownload = resolve })
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const profileADownload = cache.cache(identity('profile-a'), attachment, bytes.byteLength, async (start, end) => {
      markStarted()
      await gate
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    })
    await started

    await expect(cache.purgeProfile('profile-b')).resolves.toBeUndefined()
    const profileBDownload = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    const profileB = cache.cache(identity('profile-b'), attachment, bytes.byteLength, profileBDownload)
    await Promise.resolve()
    expect(profileBDownload).not.toHaveBeenCalled()

    releaseDownload()
    const [profileAPath, profileBPath] = await Promise.all([profileADownload, profileB])
    expect(profileBDownload).toHaveBeenCalledOnce()
    expect(existsSync(profileAPath)).toBe(true)
    expect(existsSync(profileBPath)).toBe(true)
  })

  it('lets purge cancel a same-profile cache waiting behind another profile global transfer', async () => {
    const bytes = Buffer.from('queued-profile-purge')
    const attachment = fixture(bytes)
    let releaseA!: () => void
    let startedA!: () => void
    const aStarted = new Promise<void>(resolve => { startedA = resolve })
    const aGate = new Promise<void>(resolve => { releaseA = resolve })
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const cacheA = cache.cache(identity('profile-a'), attachment, bytes.byteLength, async (start, end) => {
      startedA()
      await aGate
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    })
    await aStarted
    const downloadB = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    const staleB = cache.cache(identity('profile-b'), attachment, bytes.byteLength, downloadB)

    const purgeB = cache.purgeProfile('profile-b')
    await expect(staleB).rejects.toThrow(/purged/i)
    await expect(purgeB).resolves.toBeUndefined()
    expect(downloadB).not.toHaveBeenCalled()
    const currentB = cache.cache(
      { ...identity('profile-b'), profileGeneration: 4 },
      attachment,
      bytes.byteLength,
      downloadB
    )

    releaseA()
    const [pathA, pathB] = await Promise.all([cacheA, currentB])
    expect(downloadB).toHaveBeenCalledOnce()
    expect(existsSync(pathA)).toBe(true)
    expect(existsSync(pathB)).toBe(true)
  })

  it('removes legacy generation plaintext during the first stable-cache maintenance pass', async () => {
    const root = cacheRoot()
    const legacyPayload = join(
      root,
      Buffer.from('profile-a').toString('base64url'),
      '3',
      Buffer.from('hub-1').toString('base64url'),
      Buffer.from('team-1').toString('base64url'),
      Buffer.from('legacy-attachment').toString('base64url'),
      'content.bin'
    )
    await mkdir(dirname(legacyPayload), { recursive: true })
    await writeFile(legacyPayload, 'legacy generation plaintext')

    const bytes = Buffer.from('new stable payload')
    const attachment = fixture(bytes)
    const cache = new TeamAttachmentCache(root, 1_024)
    await cache.cache(identity('profile-a'), attachment, bytes.byteLength, async (start, end) => (
      new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    ))

    expect(existsSync(legacyPayload)).toBe(false)
  })

  it('does not deduplicate changed attachment metadata across restart generations', async () => {
    const firstBytes = Buffer.from('old declaration')
    const replacementBytes = Buffer.from('replacement declaration')
    const firstAttachment = fixture(firstBytes)
    const replacementAttachment = fixture(replacementBytes)
    let releaseFirst!: () => void
    let startedFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { startedFirst = resolve })
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const responseFor = (bytes: Buffer, start: number, end: number) => {
      const body = new Uint8Array(end - start + 1)
      body.set(bytes.subarray(start, end + 1))
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    }
    const firstDownload = vi.fn(async (start: number, end: number) => {
      startedFirst()
      await firstGate
      return responseFor(firstBytes, start, end)
    })
    const replacementDownload = vi.fn(async (start: number, end: number) => (
      responseFor(replacementBytes, start, end)
    ))
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const first = cache.cache(identity('profile-a'), firstAttachment, firstBytes.byteLength, firstDownload)
    await firstStarted
    const replacementIdentity = { ...identity('profile-a'), profileGeneration: 4 }
    const replacement = cache.cache(
      replacementIdentity,
      replacementAttachment,
      replacementBytes.byteLength,
      replacementDownload
    )
    releaseFirst()
    await first
    const replacementPath = await replacement

    expect(firstDownload).toHaveBeenCalledOnce()
    expect(replacementDownload).toHaveBeenCalledOnce()
    expect(Buffer.from(await (await cache.response(
      replacementIdentity,
      new Request('https://local.invalid/media')
    )).arrayBuffer())).toEqual(replacementBytes)
    expect(existsSync(replacementPath)).toBe(true)
  })

  it('does not lend a failing stale-generation transfer to the current generation', async () => {
    const bytes = Buffer.from('same declaration after reconnect')
    const attachment = fixture(bytes)
    let releaseStale!: () => void
    let startedStale!: () => void
    const staleStarted = new Promise<void>(resolve => { startedStale = resolve })
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve })
    const staleDownload = vi.fn(async () => {
      startedStale()
      await staleGate
      return new Response(null, { status: 503 })
    })
    const currentDownload = vi.fn(async (start: number, end: number) => (
      new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
        }
      })
    ))
    const cache = new TeamAttachmentCache(cacheRoot(), 1_024)
    const stale = cache.cache(identity('profile-a'), attachment, bytes.byteLength, staleDownload)
    await staleStarted
    const currentIdentity = { ...identity('profile-a'), profileGeneration: 4 }
    const current = cache.cache(currentIdentity, attachment, bytes.byteLength, currentDownload)
    releaseStale()

    await expect(stale).rejects.toThrow('did not honor')
    const currentPath = await current
    expect(currentDownload).toHaveBeenCalledOnce()
    expect(existsSync(currentPath)).toBe(true)
  })

  it('isolates profiles, serves byte ranges, and invalidates a hash-mismatched cached file', async () => {
    const bytes = Buffer.from('verified-team-attachment')
    const attachment = fixture(bytes)
    const download = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    const root = cacheRoot()
    const cache = new TeamAttachmentCache(root, 1_024)
    const profileAPath = await cache.cache(identity('profile-a'), attachment, 7, download)
    const profileBPath = await cache.cache(identity('profile-b'), attachment, 7, download)
    expect(profileAPath).not.toBe(profileBPath)

    const ranged = await cache.response(identity('profile-a'), new Request('https://local.invalid/media', {
      headers: { Range: 'bytes=2-8' }
    }))
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('Cache-Control')).toBe('no-store')
    expect(ranged.headers.get('Content-Range')).toBe(`bytes 2-8/${bytes.byteLength}`)
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(2, 9))

    await writeFile(profileAPath, Buffer.from('x'.repeat(bytes.byteLength)))
    const coldCache = new TeamAttachmentCache(root, 1_024)
    const invalidated = await coldCache.response(identity('profile-a'), new Request('https://local.invalid/media'))
    expect(invalidated.status).toBe(404)
    expect(invalidated.headers.get('Cache-Control')).toBe('no-store')
    expect(existsSync(profileAPath)).toBe(false)
    expect((await coldCache.response(identity('profile-b'), new Request('https://local.invalid/media', {
      method: 'HEAD'
    }))).status).toBe(200)
  })

  it('enforces bounded serialized downloads, cleans orphan bytes, and requires an exact declared chunk length', async () => {
    const bytes = Buffer.from('123456')
    const attachment = fixture(bytes)
    const oversizedDownload = vi.fn()
    await expect(new TeamAttachmentCache(cacheRoot(), 5).cache(
      identity('profile-a'), attachment, 4, oversizedDownload
    )).rejects.toThrow('larger than the local')
    expect(oversizedDownload).not.toHaveBeenCalled()

    const wrongLength = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 2),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      }
    }))
    await expect(new TeamAttachmentCache(cacheRoot(), 100).cache(
      identity('profile-a'), attachment, 4, wrongLength
    )).rejects.toThrow('mismatched attachment chunk length')

    const missingLength = vi.fn(async (start: number, end: number) => new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}` }
    }))
    await expect(new TeamAttachmentCache(cacheRoot(), 100).cache(
      identity('profile-a'), attachment, 4, missingLength
    )).rejects.toThrow('mismatched attachment chunk length')

    const boundedRoot = cacheRoot()
    const boundedCache = new TeamAttachmentCache(boundedRoot, 6)
    const oldBytes = Buffer.from('old!')
    const oldAttachment = fixture(oldBytes, 'attachment-old', 'metadata.json')
    const downloadResponse = (source: Uint8Array, start: number, end: number) => {
      const body = new Uint8Array(end - start + 1)
      body.set(source.subarray(start, end + 1))
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${source.byteLength}`
        }
      })
    }
    const oldPath = await boundedCache.cache(
      identity('profile-a', oldAttachment.id),
      oldAttachment,
      4,
      async (start, end) => downloadResponse(oldBytes, start, end)
    )
    expect(basename(oldPath)).toBe('content.bin')
    const orphan = join(dirname(oldPath), '.download-orphan.part')
    await writeFile(orphan, Buffer.alloc(32))

    const firstBytes = Buffer.from('one!')
    const secondBytes = Buffer.from('two!')
    const firstAttachment = fixture(firstBytes, 'attachment-first')
    const secondAttachment = fixture(secondBytes, 'attachment-second')
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstDownload = vi.fn(async (start: number, end: number) => {
      markFirstStarted()
      await firstGate
      return downloadResponse(firstBytes, start, end)
    })
    const secondDownload = vi.fn(async (start: number, end: number) => downloadResponse(secondBytes, start, end))
    const first = boundedCache.cache(
      identity('profile-a', firstAttachment.id), firstAttachment, 4, firstDownload
    )
    await firstStarted
    const second = boundedCache.cache(
      identity('profile-a', secondAttachment.id), secondAttachment, 4, secondDownload
    )
    await Promise.resolve()
    expect(secondDownload).not.toHaveBeenCalled()
    releaseFirst()
    const firstPath = await first
    const secondPath = await second
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(true)
  })
})
