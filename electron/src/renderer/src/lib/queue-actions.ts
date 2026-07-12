import type { QueuedTurn } from '@shared/types'

export type SteerFirstQueuedResult = {
  steered: boolean
  turns: QueuedTurn[]
}

export async function steerQueuedTurn(sessionId: string, queuedId: string): Promise<QueuedTurn[]> {
  try {
    await window.agentsDock.queue.runNow(sessionId, queuedId)
  } catch (error) {
    const turns = await window.agentsDock.queue.list(sessionId).catch(() => { throw error })
    if (turns.some(turn => turn.queued_id === queuedId)) throw error
    return turns
  }
  return window.agentsDock.queue.list(sessionId)
}

export async function steerFirstQueuedTurn(sessionId: string): Promise<SteerFirstQueuedResult> {
  const turns = await window.agentsDock.queue.list(sessionId)
  const first = turns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => (a.turn.position ?? Number.MAX_SAFE_INTEGER) - (b.turn.position ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)[0]?.turn

  if (!first) return { steered: false, turns }
  return { steered: true, turns: await steerQueuedTurn(sessionId, first.queued_id) }
}
