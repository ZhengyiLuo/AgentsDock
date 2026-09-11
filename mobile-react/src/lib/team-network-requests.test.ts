import assert from 'node:assert/strict'
import test from 'node:test'
import { TeamNetworkRequests } from './team-network-requests'

test('mailbox requests cannot strand an independent message load', () => {
  const requests = new TeamNetworkRequests()
  const detail = requests.begin('detail')
  const mail = requests.begin('mail')
  assert.equal(requests.isCurrent(detail), true, 'A mailbox read must not prevent the detail request from releasing its busy state')
  assert.equal(requests.isCurrent(mail), true)
})

test('leaving a message cancels its response while the mailbox can still finish', () => {
  const requests = new TeamNetworkRequests()
  const detail = requests.begin('detail')
  requests.cancel('detail')
  const mail = requests.begin('mail')
  const reopenedDetail = requests.begin('detail')
  assert.equal(requests.isCurrent(detail), false)
  assert.equal(requests.isCurrent(mail), true)
  assert.equal(requests.isCurrent(reopenedDetail), true)
})

test('changing teams rejects every old-team read and mutation even when new counters match', () => {
  const requests = new TeamNetworkRequests()
  const operations = ['workspace', 'mail', 'detail', 'post', 'agent'] as const
  const previousTeam = operations.map(operation => requests.begin(operation))
  requests.reset()
  const selectedTeam = operations.map(operation => requests.begin(operation))
  assert.deepEqual(previousTeam.map(request => requests.isCurrent(request)), operations.map(() => false))
  assert.deepEqual(selectedTeam.map(request => requests.isCurrent(request)), operations.map(() => true))
})

test('a superseded mailbox result cannot overwrite the latest box', () => {
  const requests = new TeamNetworkRequests()
  const inbox = requests.begin('mail')
  const sent = requests.begin('mail')
  assert.equal(requests.isCurrent(inbox), false)
  assert.equal(requests.isCurrent(sent), true)
})

test('late completion after closing cannot clear a new message load', async () => {
  const requests = new TeamNetworkRequests()
  let releaseOld!: () => void
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve })
  const oldDetail = requests.begin('detail')
  let detailLoading = true
  const oldCompletion = oldResponse.finally(() => {
    if (requests.isCurrent(oldDetail)) detailLoading = false
  })
  requests.reset()
  const newDetail = requests.begin('detail')
  releaseOld()
  await oldCompletion
  assert.equal(detailLoading, true)
  assert.equal(requests.isCurrent(newDetail), true)
})
