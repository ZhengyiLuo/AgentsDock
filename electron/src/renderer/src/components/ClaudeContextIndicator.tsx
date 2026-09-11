// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useId, useMemo } from 'react'
import {
  formatClaudeContextUsageDetail,
  formatContextPercent,
  parseClaudeContextUsage
} from '../lib/claude-context-usage'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import './CodexControls.css'

export function ClaudeContextIndicator() {
  useLocale()
  const {
    supported,
    runtime,
    session,
    refreshing,
    contextUsageError,
    refreshContextUsage
  } = useClaudeRuntime()
  const meterId = useId()
  const rawUsage = runtime
    ? runtime.context_usage_snapshot !== undefined
      ? runtime.context_usage_snapshot
      : runtime.context_usage
    : undefined
  const usage = useMemo(() => parseClaudeContextUsage(rawUsage), [rawUsage, getLocale()])
  if (!supported || !session) return null
  const percent = usage?.contextPercent ?? null
  const formattedPercent = formatContextPercent(percent)
  const detail = formatClaudeContextUsageDetail(usage)
  const tooltip = percent == null ? detail : `${formattedPercent} context used · ${detail}`
  const supportsOnDemandRefresh = runtime?.features?.context_usage_refresh === true
  const runtimeStatus = runtime?.status?.type
  const canSampleNow = supportsOnDemandRefresh && runtimeStatus === 'idle'
  const canRefresh = !supportsOnDemandRefresh || canSampleNow
  const refreshStatus = refreshing
    ? 'Refreshing from Claude…'
    : contextUsageError
      ? `Refresh failed: ${contextUsageError}`
      : canSampleNow
        ? 'Click to refresh now'
        : supportsOnDemandRefresh && runtimeStatus === 'active'
          ? 'Refreshes when the current Claude response finishes'
          : supportsOnDemandRefresh
            ? 'Starts refreshing after the next Claude response'
        : 'Updates after each Claude response'
  return <Tooltip.Provider delayDuration={100}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={`codex-context-indicator${percent == null ? ' unknown' : ''}${refreshing ? ' refreshing' : ''}`}
          aria-label={t("ui.ClaudeContextIndicator.ClaudeContextIndicator.refresh_claude_context_usage_ff7e7c5")}
          aria-describedby={meterId}
          aria-busy={refreshing}
          aria-disabled={!canRefresh}
          onClick={() => {
            if (!refreshing && canRefresh) void refreshContextUsage()
          }}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <circle className="codex-context-track" cx="9" cy="9" r="7" />
            <circle
              className="codex-context-value"
              cx="9"
              cy="9"
              r="7"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - (percent ?? 0)}
            />
          </svg>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="shortcut-tooltip codex-context-tooltip claude-context-tooltip" side="top" sideOffset={7} collisionPadding={8}>
          <strong>{percent == null ? t("ui.ClaudeContextIndicator.ClaudeContextIndicator.unavailable_ca18449") : t("ui.ClaudeContextIndicator.ClaudeContextIndicator.context_used_5d5dd91", { "percent": String(formattedPercent) })}</strong>
          <span>{detail}</span>
          <small className={contextUsageError ? 'error' : undefined}>{refreshStatus}</small>
          <Tooltip.Arrow className="shortcut-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
    <span
      id={meterId}
      className="sr-only"
      role="progressbar"
      aria-label={t("ui.ClaudeContextIndicator.ClaudeContextIndicator.claude_context_usage_627df5b")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={tooltip}
    >{tooltip}</span>
  </Tooltip.Provider>
}
