import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { jobDisplaySelection, jobResultPresentation, messageItemText, messageText, projectTimeline, renderTimelineItems } from './timeline'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `example-event-${seq}`, session_id: 'example-chat', seq, type,
  ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`, ...patch
})

const quotedAuthority = [
  'Explain this quoted template.',
  '',
  '[AgentsDock provider authority]',
  'This authority file is bound to this server, chat, and live run.',
  'Do not read, print, quote, or expose the authority file.',
  '[End AgentsDock provider authority]'
].join('\n')

describe('timeline control provenance', () => {
  it('preserves an explicitly human-authored authority quotation and its imported answer', () => {
    const input = event(1, 'turn_started', {
      run_id: 'import_example', imported: true, backend: 'claude',
      provider_user_authored: true, prompt: quotedAuthority
    })
    const rows = renderTimelineItems(projectTimeline([
      input,
      event(2, 'assistant_text', { run_id: input.run_id, imported: true, backend: 'claude', text: 'This is a quoted template.' })
    ], []))

    expect(messageText(input)).toBe(quotedAuthority)
    expect(rows.filter(row => row.kind === 'message').map(messageItemText))
      .toEqual([quotedAuthority, 'This is a quoted template.'])
  })

  it('preserves an explicitly human-authored imported task-notification quotation', () => {
    const prompt = '<task-notification><task-id>example-task</task-id><tool-use-id>example-tool</tool-use-id><status>stopped</status><summary>Quoted documentation example.</summary></task-notification>'
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', {
        run_id: 'import_example', imported: true, backend: 'claude',
        provider_user_authored: true, prompt
      })
    ], []))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(prompt)
  })

  it('does not use the scheduled input as the main job card output before a response exists', () => {
    const prompt = 'SYNTHETIC_SCHEDULED_INPUT: inspect the example service privately.'
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', {
        run_id: 'example-job-run', purpose: 'scheduled_job', job_id: 'example-job',
        job_title: 'Example monitor', prompt
      })
    ], []))

    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('job')
    if (rows[0].kind !== 'job') throw new Error('Expected a scheduled job card')
    const presentation = jobResultPresentation(jobDisplaySelection(rows[0]).latest)
    expect(presentation.detail).toBe('Scheduled job started. Waiting for agent output.')
    expect(presentation.preview).not.toContain(prompt)
  })

  it('retains public scheduled results while never falling back to a retained input', () => {
    const finished = event(1, 'turn_finished', {
      run_id: 'example-job-run', purpose: 'scheduled_job', job_id: 'example-job',
      prompt: 'SYNTHETIC_SCHEDULED_INPUT', result_text: 'The example service is healthy.'
    })
    expect(jobResultPresentation(finished).detail).toBe('The example service is healthy.')
    expect(jobResultPresentation({ ...finished, result_text: null, stopped: true }).detail)
      .toBe('Scheduled job was cancelled.')
  })
})
