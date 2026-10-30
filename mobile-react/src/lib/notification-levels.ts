import type { Event, Session } from '../types'
import { sessionNeedsProviderInteraction } from './claude-controls'
import { isUnread } from './format'

export type NotificationLevel = 'normal' | 'important' | 'emergency'

export interface AgentNotification {
  level: NotificationLevel
  title: string
  body: string
  key: string
}

function hasUnreadCompletedGoal(session: Session): boolean {
  if (goalStatus(session) !== 'complete') return false
  const readAt = Date.parse(session.last_read_agent_event_at ?? '')
  const updatedAt = goalUpdatedAt(session)
  return !Number.isFinite(readAt) || updatedAt === null || updatedAt * 1000 > readAt
}

function goalStatus(session: Session): Session['codex_goal_status'] {
  return session.codex_goal_status !== undefined ? session.codex_goal_status : session.codex_goal?.status
}

function goalUpdatedAt(session: Session): number | null {
  return session.codex_goal_updated_at !== undefined ? session.codex_goal_updated_at : session.codex_goal?.updatedAt ?? null
}

export function sessionAttentionLevel(session: Session): NotificationLevel | null {
  if (!isUnread(session)) return null
  if (session.emergency_alert?.status === 'active') return 'emergency'
  return session.unread_notification_level || 'normal'
}

export function notificationForEvent(event: Event, session: Session, translate: (text: string) => string = text => text): AgentNotification | null {
  const title = session.title
  const runKey = event.run_id || `event:${event.seq}`
  if (event.type === 'agent_notification' && event.notification_level) return {
    level: event.notification_level,
    title: `${translate(event.notification_level === 'emergency' ? 'Emergency' : event.notification_level === 'important' ? 'Important' : 'Notification')} · ${title}`,
    body: event.message || translate('You got a new message.'),
    key: `agent-notification:${event.seq}`,
  }
  if (event.type === 'emergency_alert_raised') return {
    level: 'emergency', title: `${translate('Emergency')} · ${title}`,
    body: event.message || event.emergency_alert?.message || translate('The agent raised an emergency alert.'),
    key: `emergency:${event.emergency_alert_id || event.emergency_alert?.id || event.id}`,
  }
  if (session.unread_notification_level && event.seq > (session.unread_notification_seq ?? 0)) return null
  if (event.type === 'codex_interaction_requested' || event.type === 'claude_interaction_requested' || event.type === 'gemini_interaction_requested') return {
    level: 'normal', title: `${translate('Action needed')} · ${title}`, body: translate('The agent needs your input.'),
    key: `interaction:${event.interaction_id || event.interaction?.id || event.id}`,
  }
  if (event.type === 'job_error') return {
    level: 'normal', title: `${translate('Task needs attention')} · ${title}`, body: translate('A scheduled task failed.'),
    key: `job-error:${event.job_occurrence_id || event.id}`,
  }
  if (event.type === 'job_finished') return {
    level: 'normal', title: `${translate('Task complete')} · ${title}`, body: translate('A scheduled task finished.'),
    key: `job-finished:${event.job_occurrence_id || event.id}`,
  }
  if (event.type === 'codex_goal_updated' && event.goal?.status === 'complete') return {
    level: 'normal', title: `${translate('Goal complete')} · ${title}`, body: translate('The agent completed its goal.'),
    key: `goal-complete:${event.seq}`,
  }
  if (['assistant_text', 'artifact_created'].includes(event.type)) return {
    level: 'normal', title, body: translate('You got a new message.'), key: `run:${runKey}`,
  }
  return null
}

export function notificationForSessionUpdate(
  previous: Session | undefined,
  session: Session,
  translate: (text: string) => string = text => text,
): AgentNotification | null {
  if (!previous) return null
  const emergency = session.emergency_alert?.status === 'active' ? session.emergency_alert : null
  if (emergency && emergency.id !== previous.emergency_alert?.id) return {
    level: 'emergency', title: `${translate('Emergency')} · ${session.title}`,
    body: emergency.message, key: `emergency:${emergency.id}`,
  }
  const latestSeq = session.latest_agent_event_seq ?? 0
  const previousSeq = previous.latest_agent_event_seq ?? 0
  const newAgentEvent = latestSeq > previousSeq
  const needsInput = sessionNeedsProviderInteraction(session)
  if (session.unread_notification_level && session.unread_notification_seq
    && session.unread_notification_seq !== previous.unread_notification_seq && isUnread(session)) return {
    level: session.unread_notification_level,
    title: `${translate(session.unread_notification_level === 'emergency' ? 'Emergency' : session.unread_notification_level === 'important' ? 'Important' : 'Notification')} · ${session.title}`,
    body: session.latest_notification_level === session.unread_notification_level
      ? session.latest_notification_message || translate('You got a new message.')
      : translate('You got a new message.'),
    key: `agent-notification:${session.unread_notification_seq}`,
  }
  if (session.unread_notification_level || emergency) return null
  if (needsInput && (!sessionNeedsProviderInteraction(previous) || newAgentEvent)) return {
    level: 'normal', title: `${translate('Action needed')} · ${session.title}`,
    body: translate('The agent needs your input.'), key: `interaction-summary:${latestSeq}`,
  }
  if (!newAgentEvent) return null
  if (session.latest_agent_event_type === 'job_error') return {
    level: 'normal', title: `${translate('Task needs attention')} · ${session.title}`,
    body: translate('A scheduled task failed.'), key: `job-error-summary:${latestSeq}`,
  }
  if (session.latest_agent_event_type === 'job_finished') return {
    level: 'normal', title: `${translate('Task complete')} · ${session.title}`,
    body: translate('A scheduled task finished.'), key: `job-finished-summary:${latestSeq}`,
  }
  if (hasUnreadCompletedGoal(session) && (
    goalStatus(previous) !== 'complete'
    || goalUpdatedAt(previous) !== goalUpdatedAt(session)
  )) return {
    level: 'normal', title: `${translate('Goal complete')} · ${session.title}`,
    body: translate('The agent completed its goal.'), key: `goal-complete-summary:${latestSeq}`,
  }
  return { level: 'normal', title: session.title, body: translate('You got a new message.'), key: `summary:${latestSeq}` }
}

export function notificationLevelRank(level: NotificationLevel): number {
  return level === 'emergency' ? 3 : level === 'important' ? 2 : 1
}
