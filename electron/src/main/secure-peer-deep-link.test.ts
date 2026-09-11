import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  canonicalSecurePeerInvite,
  installSecurePeerDeepLinkLifecycle,
  newestSecurePeerInviteFromArgv,
  securePeerProtocolRegistration,
  SecurePeerDeepLinkRouter
} from './secure-peer-deep-link'

const first = 'agentsdock://secure-peer/join?host=192.168.50.10&port=7851&fingerprint=sha256%3Aee2a25490c9866b9073e8fbcc4feb252a12b432586269979c06648d27d9a4752'
const second = 'agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A112a25490c9866b9073e8fbcc4feb252a12b432586269979c06648d27d9a4752'

describe('secure peer deep-link boundary', () => {
  it('accepts only the exact canonical invite and ignores malformed or expanded URLs', () => {
    expect(canonicalSecurePeerInvite(first)).toBe(first)
    expect(canonicalSecurePeerInvite(first.replace('host=', 'secret=x&host='))).toBeNull()
    expect(canonicalSecurePeerInvite(first.replace('%3A', ':'))).toBeNull()
    expect(canonicalSecurePeerInvite('agentsdock://secure-peer/join?host=127.0.0.1&port=7851&fingerprint=sha256%3A' + 'a'.repeat(64))).toBeNull()
    expect(canonicalSecurePeerInvite('192.168.50.10:7851')).toBeNull()
    expect(canonicalSecurePeerInvite({ invite: first })).toBeNull()
  })

  it('chooses the newest valid argv invite without interpreting neighboring arguments', () => {
    expect(newestSecurePeerInviteFromArgv(['AgentsDock', first, '--flag', second])).toBe(second)
    expect(newestSecurePeerInviteFromArgv(['AgentsDock', `${first} extra`])).toBeNull()
  })

  it('queues exactly one newest invite until renderer readiness and never calls a network API', () => {
    const router = new SecurePeerDeepLinkRouter()
    const deliver = vi.fn(() => true)
    const network = vi.fn()

    expect(router.offer(first)).toBe(true)
    expect(router.offer('agentsdock://wrong')).toBe(false)
    expect(router.offer(second)).toBe(true)
    expect(router.pending()).toBe(second)

    router.rendererReady(deliver)
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith({ invite: second })
    expect(router.pending()).toBeNull()
    expect(network).not.toHaveBeenCalled()
  })

  it('retains an invite across a failed delivery and renderer reload', () => {
    const router = new SecurePeerDeepLinkRouter()
    router.rendererReady(() => false)
    router.offer(first)
    expect(router.pending()).toBe(first)

    router.rendererUnavailable()
    const deliver = vi.fn(() => true)
    router.rendererReady(deliver)
    expect(deliver).toHaveBeenCalledWith({ invite: first })
    expect(router.pending()).toBeNull()
  })

  it('registers packaged apps directly and only uses the Electron dev shim on Windows', () => {
    expect(securePeerProtocolRegistration(true, 'darwin', false, '/Applications/AgentsDock', [])).toEqual({ scheme: 'agentsdock' })
    expect(securePeerProtocolRegistration(false, 'darwin', true, '/Electron', ['/Electron', './main.js'])).toBeNull()
    expect(securePeerProtocolRegistration(false, 'win32', true, 'C:\\Electron.exe', ['Electron.exe', './main.js'])).toEqual({
      scheme: 'agentsdock',
      executable: 'C:\\Electron.exe',
      args: [expect.stringMatching(/main\.js$/)]
    })
  })

  it('declares the agentsdock scheme in the packaged Electron metadata', () => {
    const packageJSON = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      build?: { protocols?: Array<{ name?: string; schemes?: string[] }> }
    }
    expect(packageJSON.build?.protocols).toEqual([{
      name: 'AgentsDock secure server invite',
      schemes: ['agentsdock']
    }])
  })

  it('covers cold argv, macOS open-url, and second-instance lifecycle delivery without network work', () => {
    const router = new SecurePeerDeepLinkRouter()
    let openURL!: (event: { preventDefault(): void }, url: string) => void
    let secondInstance!: (commandLine: readonly string[]) => void
    const show = vi.fn()
    const setDefault = vi.fn(() => true)

    expect(installSecurePeerDeepLinkLifecycle({
      packaged: true,
      platform: 'darwin',
      defaultApp: false,
      execPath: '/Applications/AgentsDock.app/Contents/MacOS/AgentsDock',
      argv: ['AgentsDock', first],
      router,
      showMainWindow: show,
      registerOpenURL: listener => { openURL = listener },
      registerSecondInstance: listener => { secondInstance = listener },
      setDefaultProtocolClient: setDefault
    })).toBe(true)

    expect(router.pending()).toBe(first)
    expect(setDefault).toHaveBeenCalledWith('agentsdock', undefined, undefined)

    const malformedEvent = { preventDefault: vi.fn() }
    openURL(malformedEvent, `${second}&extra=blocked`)
    expect(malformedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(router.pending()).toBe(first)
    expect(show).not.toHaveBeenCalled()

    const validEvent = { preventDefault: vi.fn() }
    openURL(validEvent, second)
    expect(router.pending()).toBe(second)
    expect(show).toHaveBeenCalledTimes(1)

    secondInstance(['AgentsDock', first])
    expect(router.pending()).toBe(first)
    expect(show).toHaveBeenCalledTimes(2)
  })
})
