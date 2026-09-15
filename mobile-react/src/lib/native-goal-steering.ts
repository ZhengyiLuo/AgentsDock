import type { Event } from '../types'

/** A server-confirmed user message delivered within the current native goal run. */
export function isNativeGoalSteerEvent(event: Event): boolean {
  return event.type === 'turn_steered'
    && event.native_goal_steer === true
    && event.native_steer === true
    && event.backend === 'codex'
    && event.purpose === 'codex_goal_resume'
    && event.provider_user_authored === true
    && Boolean(event.run_id?.trim())
}
