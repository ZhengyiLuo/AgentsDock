import {
  awaitAllCodexPermissionUpdates,
  awaitCodexPermissionUpdates,
  queueCodexPermissionUpdate,
  type CodexPermissionUpdateScope,
} from './codex-permission-updates'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const firstScope: CodexPermissionUpdateScope = {
  profileId: 'server-a',
  profileGeneration: 4,
  sessionId: 'chat-1',
}
const secondScope: CodexPermissionUpdateScope = {
  profileId: 'server-b',
  profileGeneration: 5,
  sessionId: 'chat-1',
}
const firstGate = deferred()
const secondGate = deferred()
const started: string[] = []

const first = queueCodexPermissionUpdate(firstScope, async () => {
  started.push('first')
  await firstGate.promise
})
const second = queueCodexPermissionUpdate(firstScope, async () => {
  started.push('second')
  await secondGate.promise
})
const otherServer = queueCodexPermissionUpdate(secondScope, async () => {
  started.push('other-server')
})

await new Promise(resolve => setTimeout(resolve, 0))
assert(started.join(',') === 'first,other-server', 'updates must serialize per server/chat scope without blocking another server')

firstGate.resolve()
await first
await new Promise(resolve => setTimeout(resolve, 0))
assert(started.join(',') === 'first,other-server,second', 'the next update must start only after the prior update finishes')

let sendReleased = false
const pendingSend = awaitCodexPermissionUpdates(firstScope).then(() => { sendReleased = true })
await Promise.resolve()
assert(!sendReleased, 'send must remain blocked behind the latest permission update')

secondGate.resolve()
await Promise.all([second, otherServer, pendingSend])
assert(sendReleased, 'send must resume after the final permission update')
await awaitAllCodexPermissionUpdates()

const failingScope: CodexPermissionUpdateScope = {
  profileId: 'server-a',
  profileGeneration: 4,
  sessionId: 'chat-failure',
}
const failure = queueCodexPermissionUpdate(failingScope, async () => {
  throw new Error('permission denied')
})
let failureObserved = false
try {
  await failure
} catch (error) {
  failureObserved = error instanceof Error && error.message === 'permission denied'
}
assert(failureObserved, 'permission update failures must reach the initiating UI')

let recovered = false
await queueCodexPermissionUpdate(failingScope, async () => { recovered = true })
assert(recovered, 'a failed update must not poison later changes for that scope')
await awaitAllCodexPermissionUpdates()

console.log('codex permission update tests passed')
