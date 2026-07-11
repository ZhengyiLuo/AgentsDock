import type { QueuedTurn } from '@shared/types'

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
