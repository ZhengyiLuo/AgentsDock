import { describe, expect, it, vi } from 'vitest'
import { CodeIntelligenceConnections } from './code-intelligence-connections'
import { CODE_INTELLIGENCE_PROTOCOL } from '../shared/code-intelligence'

class Socket extends EventTarget {
  readyState = 0
  protocol = CODE_INTELLIGENCE_PROTOCOL
  sent: string[] = []
  close = vi.fn(() => { this.readyState = 3 })
  send(message: string) { this.sent.push(message) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(data: string) { this.dispatchEvent(new MessageEvent('message', { data })) }
  socket() { return this as unknown as WebSocket }
}
const scope = { profileId: 'server-a', profileGeneration: 7, serverIdentity: 'a' }
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe('code intelligence transport ownership', () => {
  it('delivers to its editor and ignores wrong windows, chats and profile generations', async () => {
    const hub = new CodeIntelligenceConnections(), socket = new Socket(), notify = vi.fn()
    const ready = hub.connect(1, scope, 'chat-a', 'editor', 'python', async () => socket.socket(), notify)
    await tick(); socket.open(); await ready
    const message = '{"jsonrpc":"2.0","method":"initialized","params":{}}'
    hub.send(2, scope, 'chat-a', 'editor', message)
    hub.send(1, scope, 'chat-b', 'editor', message)
    hub.send(1, { ...scope, profileGeneration: 8 }, 'chat-a', 'editor', message)
    hub.disconnect(1, scope, 'chat-b', 'editor')
    expect(socket.sent).toEqual([]); expect(socket.close).not.toHaveBeenCalled()
    hub.send(1, scope, 'chat-a', 'editor', message)
    expect(socket.sent).toEqual([message])
    socket.message('{"jsonrpc":"2.0","id":1,"result":{}}')
    expect(notify).toHaveBeenCalledWith({ ...scope, serverIdentity: undefined,
      sessionId: 'chat-a', connectionId: 'editor', type: 'message', message: '{"jsonrpc":"2.0","id":1,"result":{}}' })
    hub.disconnect(1, scope, 'chat-a', 'editor')
    socket.message('{"id":2,"result":"late"}')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('cancels a pending health check and closes only its late socket', async () => {
    const hub = new CodeIntelligenceConnections(), old = new Socket(), fresh = new Socket()
    let finish!: (socket: WebSocket) => void
    const pending = hub.connect(1, scope, 'a', 'old', 'python', () => new Promise(resolve => { finish = resolve }), vi.fn())
    const rejection = expect(pending).rejects.toThrow('Code editor closed')
    hub.disconnect(1, scope, 'a', 'old'); await rejection
    const next = hub.connect(1, scope, 'a', 'new', 'python', async () => fresh.socket(), vi.fn())
    await tick(); fresh.open(); await next
    finish(old.socket()); await tick()
    expect(old.close).toHaveBeenCalledOnce(); expect(fresh.close).not.toHaveBeenCalled()
    hub.closeOwner(1)
  })

  it('window destruction settles pending opens without touching another window', async () => {
    const hub = new CodeIntelligenceConnections(), one = new Socket(), two = new Socket()
    const a = hub.connect(1, scope, 'a', 'same-id', 'python', async () => one.socket(), vi.fn())
    const b = hub.connect(2, scope, 'b', 'same-id', 'python', async () => two.socket(), vi.fn())
    const rejected = expect(a).rejects.toThrow('Window closed')
    await tick(); two.open(); await b; hub.closeOwner(1); await rejected
    expect(one.close).toHaveBeenCalledOnce(); expect(two.close).not.toHaveBeenCalled()
    hub.closeOwner(2)
  })

  it.each(['protocol', 'bridge', 'socket', 'malformed'])('reports %s failure once and never retries', async kind => {
    const hub = new CodeIntelligenceConnections(), socket = new Socket(), notify = vi.fn(), open = vi.fn(async () => socket.socket())
    const pending = hub.connect(1, scope, 'a', 'editor', 'python', open, notify)
    const rejected = expect(pending).rejects.toThrow()
    await tick()
    if (kind === 'protocol') { socket.protocol = ''; socket.open() }
    if (kind === 'bridge') socket.message('{"type":"intelligence_error","message":"Install pyright on this server"}')
    if (kind === 'socket') socket.dispatchEvent(new Event('error'))
    if (kind === 'malformed') socket.message('not JSON')
    await rejected
    socket.dispatchEvent(new Event('error'))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].type).toBe('error')
    expect(open).toHaveBeenCalledOnce(); expect(socket.close).toHaveBeenCalledOnce()
  })

  it('rejects missing scope before starting any network work', async () => {
    const hub = new CodeIntelligenceConnections(), open = vi.fn()
    await expect(hub.connect(1, null as never, 'a', 'editor', 'python', open, vi.fn())).rejects.toThrow('missing its chat or server')
    expect(open).not.toHaveBeenCalled()
  })
})
