import type { Event } from '@shared/types'

/** Presentation only: retain native output verbatim for details, copying and history. */
export function claudeCompactOutput(event: Event, input?: Event): { text: string; collapsed: boolean } | null {
  if (event.type !== 'assistant_text' || event.backend !== 'claude'
    || !input || input.type !== 'turn_started' || input.backend !== 'claude'
    || !input.run_id || input.run_id !== event.run_id || input.session_id !== event.session_id
    || input.seq >= event.seq || !/^\/compact(?:\s|$)/u.test(input.prompt ?? '')
    || !(event.provider_message_id?.trim()
      || (event.provider_origin?.provider === 'claude' && event.provider_origin.event_id))) return null

  const text = event.text ?? ''
  // Do not classify ordinary prose, quoted markup or arbitrary assistant text as a command.
  if (!/^Compacted\s+PostCompact \[/u.test(text)) return null
  const diagnostics = text.replace(/^Compacted\s+/u, '')
  // Collapse only the known single successful, empty-output hook envelope.
  // Non-empty stdout, multiple hooks, warnings and failures stay expanded.
  const collapsed = !event.is_error && !event.error
    && /^PostCompact \[[\s\S]+\] completed successfully: \{\}$/u.test(diagnostics)
    && diagnostics.split('PostCompact [').length === 2
    && !/\b(?:error|failed|failure|warning|stderr|timed? out|exit (?:code )?[1-9])\b/iu.test(diagnostics)
  return { text, collapsed }
}
