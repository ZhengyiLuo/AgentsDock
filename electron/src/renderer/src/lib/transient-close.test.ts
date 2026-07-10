import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTopTransient, registerTransientClose, resetTransientCloseStackForTests } from './transient-close'

describe('transient close stack', () => {
  afterEach(resetTransientCloseStackForTests)

  it('closes only the most recently opened surface', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerTransientClose(first)
    const unregisterSecond = registerTransientClose(second)

    expect(closeTopTransient()).toBe(true)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()

    unregisterSecond()
    expect(closeTopTransient()).toBe(true)
    expect(first).toHaveBeenCalledOnce()
    unregisterFirst()
    expect(closeTopTransient()).toBe(false)
  })
})
