import { describe, expect, it, vi } from 'vitest'
import { SecurePeerRequestAdmission } from './secure-peer-request-admission'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('exact-peer request admission', () => {
  it('starts four warm-opening reads and admits the fifth in FIFO order after a full request settles', async () => {
    const queue = new SecurePeerRequestAdmission()
    const jobs = Array.from({ length: 6 }, deferred)
    const starts: number[] = []
    const results = jobs.map((job, index) => queue.run('json', new AbortController().signal, async () => {
      starts.push(index)
      await job.promise
    }))
    await flush()
    expect(starts).toEqual([0, 1, 2, 3])
    jobs[1].resolve()
    await flush()
    expect(starts).toEqual([0, 1, 2, 3, 4])
    jobs[0].resolve()
    await flush()
    expect(starts).toEqual([0, 1, 2, 3, 4, 5])
    jobs.forEach(job => job.resolve())
    await Promise.all(results)
    expect(queue.idle).toBe(true)
  })

  it('allows one binary body while JSON controls bypass its waiting binary followers', async () => {
    const queue = new SecurePeerRequestAdmission()
    const jobs = Array.from({ length: 6 }, deferred)
    const lanes = ['binary', 'binary', 'json', 'json', 'json', 'json'] as const
    const starts: number[] = []
    const results = jobs.map((job, index) => queue.run(lanes[index], new AbortController().signal, async () => {
      starts.push(index)
      await job.promise
    }))
    await flush()
    expect(starts).toEqual([0, 2, 3, 4])
    jobs[0].resolve()
    await flush()
    expect(starts).toEqual([0, 2, 3, 4, 1])
    jobs[2].resolve()
    await flush()
    expect(starts).toEqual([0, 2, 3, 4, 1, 5])
    jobs.forEach(job => job.resolve())
    await Promise.all(results)
  })

  it.each(['cancel', 'deadline'] as const)('removes a queued %s request and its listener without invoking its operation', async cause => {
    const queue = new SecurePeerRequestAdmission()
    const job = deferred()
    const active = Array.from({ length: 4 }, () => queue.run('json', new AbortController().signal, () => job.promise))
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const operation = vi.fn()
    const queued = queue.run('json', controller.signal, operation)
    const reason = new DOMException(cause, cause === 'deadline' ? 'TimeoutError' : 'AbortError')
    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    job.resolve()
    await Promise.all(active)
    expect(operation).not.toHaveBeenCalled()
    expect(queue.idle).toBe(true)
  })

  it('releases capacity after an operation error and after abort between grant and execution', async () => {
    const queue = new SecurePeerRequestAdmission()
    const controller = new AbortController()
    const operation = vi.fn()
    const neverStarted = queue.run('json', controller.signal, operation)
    controller.abort()
    await expect(neverStarted).rejects.toThrow()
    expect(operation).not.toHaveBeenCalled()
    await expect(queue.run('binary', new AbortController().signal, async () => { throw new Error('transport failed') })).rejects.toThrow('transport failed')
    expect(queue.idle).toBe(true)
    await expect(queue.run('binary', new AbortController().signal, async () => 'next')).resolves.toBe('next')
  })

  it('caps total and binary queued memory independently', async () => {
    const queue = new SecurePeerRequestAdmission()
    const controller = new AbortController()
    const job = deferred()
    const active = queue.run('binary', controller.signal, () => job.promise)
    const binaries = Array.from({ length: 4 }, () => queue.run('binary', controller.signal, () => job.promise))
    const binaryResults = Promise.allSettled(binaries)
    await expect(queue.run('binary', controller.signal, vi.fn())).rejects.toThrow(/Too many pending/)
    const json = Array.from({ length: 31 }, () => queue.run('json', controller.signal, () => job.promise))
    const jsonResults = Promise.allSettled(json)
    // One active binary + three active JSON; 4 binary + 28 JSON waiting.
    await expect(queue.run('json', controller.signal, vi.fn())).rejects.toThrow(/Too many pending/)
    controller.abort()
    job.resolve()
    await Promise.allSettled([active, binaryResults, jsonResults])
    expect(queue.idle).toBe(true)
  })
})
