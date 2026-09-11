import {
  awaitAllClaudePermissionUpdates,
  awaitClaudePermissionUpdates,
  queueClaudePermissionUpdate,
  type ClaudePermissionUpdateScope,
} from './claude-permission-updates'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const firstScope: ClaudePermissionUpdateScope = { profileId: 'server-a', profileGeneration: 4, sessionId: 'chat-1' }
const secondScope: ClaudePermissionUpdateScope = { profileId: 'server-b', profileGeneration: 5, sessionId: 'chat-1' }
const firstGate = deferred()
const secondGate = deferred()
const started: string[] = []
const first = queueClaudePermissionUpdate(firstScope, async () => { started.push('first'); await firstGate.promise })
const second = queueClaudePermissionUpdate(firstScope, async () => { started.push('second'); await secondGate.promise })
const otherServer = queueClaudePermissionUpdate(secondScope, async () => { started.push('other-server') })
await new Promise(resolve => setTimeout(resolve, 0))
assert(started.join(',') === 'first,other-server', 'updates must serialize within a server/chat scope only')
firstGate.resolve()
await first
await new Promise(resolve => setTimeout(resolve, 0))
assert(started.join(',') === 'first,other-server,second', 'the second update must wait for the first')
let sendReleased = false
const pendingSend = awaitClaudePermissionUpdates(firstScope).then(() => { sendReleased = true })
await Promise.resolve()
assert(!sendReleased, 'send must wait for the final permission update')
secondGate.resolve()
await Promise.all([second, otherServer, pendingSend])
assert(sendReleased, 'send must resume when permission writes finish')
await awaitAllClaudePermissionUpdates()

const failingScope: ClaudePermissionUpdateScope = { profileId: 'server-a', profileGeneration: 4, sessionId: 'failure' }
let failed = false
try {
  await queueClaudePermissionUpdate(failingScope, async () => { throw new Error('permission denied') })
} catch (error) {
  failed = error instanceof Error && error.message === 'permission denied'
}
assert(failed, 'permission failures must reach the initiating UI')
let recovered = false
await queueClaudePermissionUpdate(failingScope, async () => { recovered = true })
assert(recovered, 'one failure must not poison later updates')
await awaitAllClaudePermissionUpdates()

console.log('Claude permission update tests passed')
