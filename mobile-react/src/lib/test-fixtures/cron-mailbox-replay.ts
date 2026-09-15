import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event } from '../../types'

/** Synthetic contract fixture, not a provider parser or a transcript sanitizer. */
export function cronMailboxReplayFixture() {
  const sessionId = 'qa-codex-replay'
  const hash = (text: string) => bytesToHex(sha256(utf8ToBytes(text)))
  const wakeText = ('Synthetic mailbox wake: read the pending peer message and report the outcome. '
    + 'This sentence is test data and is also quoted verbatim by a genuine human. ').repeat(4).slice(0, 551)
  const scheduledInput = 'Synthetic scheduled monitor input.'
  const scheduledReport = 'SCHEDULED RESULT: the synthetic monitor completed once.'
  const wakeProgress = 'MAILBOX PROGRESS: checking the synthetic peer request.'
  const wakeAnswer = 'MAILBOX ANSWER: the synthetic peer request has been handled.'
  const humanAnswer = 'HUMAN ANSWER: your identical quotation is retained as a real user message.'
  const event = (seq: number, type: string, extra: Partial<Event>): Event => ({
    id: `mixed-${seq}`, seq, type, session_id: sessionId, backend: 'codex',
    ts: new Date(Date.parse('2026-09-13T12:00:00Z') + seq * 1000).toISOString(), ...extra
  })
  const job = { run_id: 'native-job', job_id: 'synthetic-monitor', purpose: 'scheduled_job',
    job_title: 'Synthetic scheduled monitor', job_timeline_group_id: 'job:synthetic-monitor',
    job_occurrence_id: 'synthetic-occurrence' }
  const mailbox: Partial<Event> = {
    message_id: 'synthetic-peer-message', cross_chat_envelope_id: 'synthetic-peer-message',
    conversation_id: 'synthetic-pair', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox',
    source_session_id: 'qa-codex-replay-away', source_title: 'Synthetic Peer', target_session_id: sessionId,
    handoff_preview: 'PEER MESSAGE: please check the synthetic monitor result.',
    received_at: '2026-09-13T12:00:04Z', message_revision: 0
  }
  const nativeEvents = [
    event(1, 'turn_started', { ...job, prompt: scheduledInput }),
    event(2, 'assistant_text', { ...job, text: scheduledReport }),
    event(3, 'turn_finished', { ...job, result_text: scheduledReport }),
    event(4, 'chat_conversation_message_received', { ...mailbox, inbox_state: 'unread' }),
    event(5, 'turn_started', { run_id: 'native-wake', purpose: 'chat_mailbox_wake', prompt: '',
      provider_generated: true, mailbox_wake_id: `mailwake_${'a'.repeat(32)}`,
      mailbox_wake_through_seq: 4, provider_input_sha256: hash(wakeText) }),
    event(6, 'reasoning_summary', { run_id: 'native-wake', phase: 'commentary', text: wakeProgress }),
    event(7, 'chat_conversation_message_read', { ...mailbox, inbox_state: 'read', read_at: '2026-09-13T12:00:07Z' }),
    event(8, 'assistant_text', { run_id: 'native-wake', phase: 'final_answer', text: wakeAnswer }),
    event(9, 'turn_finished', { run_id: 'native-wake', result_text: wakeAnswer })
  ]
  const sources = [nativeEvents[0], nativeEvents[1], nativeEvents[4], nativeEvents[5], nativeEvents[7]]
  const staleEvents = sources.map((source, index) => event(100 + index, source.type, {
    run_id: 'import_mixed_history', imported: true, ts: source.ts,
    ...(source.type === 'turn_started'
      ? { provider_user_authored: true, prompt: source.seq === 5 ? wakeText : source.prompt }
      : { text: source.text })
  }))
  // Server proof is explicit. Same words, timestamps or authorship alone never hide a row.
  const corrected = staleEvents.map((source, index): Event => ({
    ...source, ...(source.type === 'turn_started' ? { prompt: '' } : { text: '' }),
    metadata_only: true, provider_history_repair: 'source_proven_native_replay',
    provider_origin: { provider: 'codex', kind: source.type === 'turn_started' ? 'user' : 'assistant',
      event_id: `provider-${source.id}`, session_id: 'synthetic-provider-thread',
      turn_id: `provider-${sources[index].run_id}`, native_event_id: sources[index].id,
      timestamp: source.ts, source_text_sha256: hash(source.prompt ?? source.text ?? '') }
  }))
  const genuine = [
    event(106, 'turn_started', { run_id: 'import_mixed_history', imported: true,
      provider_user_authored: true, prompt: wakeText }),
    event(107, 'turn_finished', { run_id: 'import_mixed_history', imported: true, result_text: humanAnswer })
  ]
  return { title: 'Cron + Mailbox Replay QA', sessionId, wakeText, scheduledInput, scheduledReport,
    wakeProgress, wakeAnswer, humanAnswer, nativeEvents, staleEvents, corrected, genuine,
    beforeEvents: [...nativeEvents, ...staleEvents, ...genuine],
    afterEvents: [...nativeEvents, ...corrected, ...genuine],
    jobHistory: [{ jobId: job.job_id, timelineGroupId: job.job_timeline_group_id, runs: [nativeEvents[2]] }] }
}
