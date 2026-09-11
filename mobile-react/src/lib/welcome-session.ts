import type { ChatReference, Event, Session, Snapshot } from '../types'

/** Local-only chat shown before any real AgentsServer is configured. */
export const WELCOME_SESSION_ID = '__agentsdock_welcome__'

const WELCOME_INTRO_TEXT = "**Welcome to AgentsDock!**\n\nAgentsDock connects to an AgentsServer that you control; this welcome chat never sends anything over the network.\n\nVisit **[agentsdock.net](https://agentsdock.net)** for setup instructions, then add your server address and access token to start chatting with Codex or Claude.\n\nSay hi, or ask how to get set up."

export interface WelcomeWorkspaceState<HistoryWindow extends { sessionId: string } = { sessionId: string }> {
  sessions: Session[]
  snapshots: Record<string, Snapshot>
  drafts: Record<string, string>
  chatReferencesBySession: Record<string, ChatReference[]>
  selectedSessionId: string | null
  historyWindow?: HistoryWindow | null
}

export function isWelcomeSession(sessionId: string | null | undefined): boolean {
  return sessionId === WELCOME_SESSION_ID
}

export function buildWelcomeSession(unread = true): Session {
  return {
    id: WELCOME_SESSION_ID,
    title: 'Welcome to AgentsDock',
    backend: 'claude',
    manual_unread: unread,
  }
}

export function buildWelcomeSnapshot(timestamp = new Date().toISOString()): Snapshot {
  const intro: Event = {
    seq: 1,
    id: 'welcome-intro',
    session_id: WELCOME_SESSION_ID,
    type: 'turn_finished',
    ts: timestamp,
    run_id: 'welcome-intro-turn',
    result_text: WELCOME_INTRO_TEXT,
  }
  return {
    session: buildWelcomeSession(),
    events: [intro],
    queuedTurns: [],
    files: [],
    filesTotal: 0,
    hasMore: false,
    latestSeq: 1,
    cachedAt: Date.parse(timestamp) || 0,
  }
}

/**
 * Reconciles the ephemeral welcome chat without letting it survive a real
 * server configuration. Returning null preserves store identity when no work
 * is required.
 */
export function welcomeWorkspacePatch<HistoryWindow extends { sessionId: string }>(
  state: WelcomeWorkspaceState<HistoryWindow>,
  required: boolean,
): Partial<WelcomeWorkspaceState<HistoryWindow>> | null {
  const present = state.sessions.some(session => isWelcomeSession(session.id))
  if (required) {
    if (present && state.snapshots[WELCOME_SESSION_ID]) return null
    return {
      sessions: present ? state.sessions : [...state.sessions, buildWelcomeSession()],
      snapshots: state.snapshots[WELCOME_SESSION_ID]
        ? state.snapshots
        : { ...state.snapshots, [WELCOME_SESSION_ID]: buildWelcomeSnapshot() },
    }
  }

  const hasEphemeralState = present
    || Boolean(state.snapshots[WELCOME_SESSION_ID])
    || Object.hasOwn(state.drafts, WELCOME_SESSION_ID)
    || Object.hasOwn(state.chatReferencesBySession, WELCOME_SESSION_ID)
    || isWelcomeSession(state.selectedSessionId)
    || isWelcomeSession(state.historyWindow?.sessionId)
  if (!hasEphemeralState) return null

  const snapshots = { ...state.snapshots }
  delete snapshots[WELCOME_SESSION_ID]
  const drafts = { ...state.drafts }
  delete drafts[WELCOME_SESSION_ID]
  const chatReferencesBySession = { ...state.chatReferencesBySession }
  delete chatReferencesBySession[WELCOME_SESSION_ID]
  return {
    sessions: state.sessions.filter(session => !isWelcomeSession(session.id)),
    snapshots,
    drafts,
    chatReferencesBySession,
    selectedSessionId: isWelcomeSession(state.selectedSessionId) ? null : state.selectedSessionId,
    historyWindow: isWelcomeSession(state.historyWindow?.sessionId) ? null : state.historyWindow,
  }
}

export function welcomeReplyText(userText: string): string {
  const text = userText.trim().toLocaleLowerCase()
  if (/^(hi|hello|hey|yo|hola|嗨|哈喽|你好)(?:\s|[!,.?，。！？]|$)/u.test(text)) {
    return "Hi! I'm the local welcome guide. Connect your own AgentsServer, then this app can start real Codex or Claude turns."
  }
  if (/help|setup|set up|guide|start|connect|server|agentsdock/u.test(text)) {
    return 'Install AgentsServer on a Mac or Linux host, then add its address and access token in connection settings. Full guide: [agentsdock.net](https://agentsdock.net)'
  }
  return "This local welcome chat can't run an agent turn. Set up your AgentsServer to continue: [agentsdock.net](https://agentsdock.net)"
}

export function appendWelcomeExchange(
  snapshot: Snapshot,
  userText: string,
  timestamp = new Date().toISOString(),
): Snapshot {
  const afterSeq = snapshot.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0)
  const userSeq = afterSeq + 1
  const replySeq = afterSeq + 2
  const runId = `welcome-turn-${userSeq}`
  const userEvent: Event = {
    seq: userSeq,
    id: `welcome-user-${userSeq}`,
    session_id: WELCOME_SESSION_ID,
    type: 'turn_started',
    ts: timestamp,
    run_id: runId,
    text: userText,
    prompt: userText,
  }
  const replyEvent: Event = {
    seq: replySeq,
    id: `welcome-reply-${replySeq}`,
    session_id: WELCOME_SESSION_ID,
    type: 'turn_finished',
    ts: timestamp,
    run_id: runId,
    result_text: welcomeReplyText(userText),
  }
  const session = { ...snapshot.session, manual_unread: false, latest_event_seq: replySeq, latest_agent_event_seq: replySeq }
  return {
    ...snapshot,
    session,
    events: [...snapshot.events, userEvent, replyEvent],
    latestSeq: replySeq,
    cachedAt: Date.parse(timestamp) || snapshot.cachedAt,
  }
}

/** Synthetic UI state must never become a durable server-workspace choice. */
export function withoutWelcomeRecord<T>(record: Record<string, T>): Record<string, T> {
  if (!Object.hasOwn(record, WELCOME_SESSION_ID)) return record
  const next = { ...record }
  delete next[WELCOME_SESSION_ID]
  return next
}
