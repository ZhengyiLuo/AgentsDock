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
    loading,
    runtime,
    session,
    refreshing,
    contextUsageError,
    runtimeError,
    refresh,
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
  const title = percent == null
    ? t('claudeContext.pending')
    : t('ui.ClaudeContextIndicator.ClaudeContextIndicator.context_used_5d5dd91', { percent: formattedPercent })
  const tooltip = percent == null ? detail : `${title} · ${detail}`
  const supportsOnDemandRefresh = runtime?.features?.context_usage_refresh === true
  const runtimeStatus = runtime?.status?.type
  const canSampleNow = supportsOnDemandRefresh && runtimeStatus === 'idle'
  // A failed runtime read can always be retried observationally. Never send
  // the SDK sampling command alongside an active provider turn.
  const canRefresh = !loading && !refreshing && (Boolean(runtimeError) || !supportsOnDemandRefresh || canSampleNow)
  const error = contextUsageError ?? runtimeError
  const refreshStatus = loading || refreshing
    ? t('claudeContext.refreshing')
    : runtimeError
      ? t('claudeContext.retry')
      : canSampleNow
        ? t('claudeContext.refreshNow')
        : supportsOnDemandRefresh && runtimeStatus === 'active'
          ? t('claudeContext.afterCurrentReply')
          : supportsOnDemandRefresh
            ? t('claudeContext.afterNextReply')
            : t('claudeContext.afterEachReply')
  return <Tooltip.Provider delayDuration={100}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={`codex-context-indicator${percent == null ? ' unknown' : ''}${loading || refreshing ? ' refreshing' : ''}`}
          aria-label={t("ui.ClaudeContextIndicator.ClaudeContextIndicator.refresh_claude_context_usage_ff7e7c5")}
          aria-describedby={meterId}
          aria-busy={loading || refreshing}
          aria-disabled={!canRefresh}
          onClick={() => {
            if (canRefresh) void (runtimeError ? refresh() : refreshContextUsage())
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
          <strong>{title}</strong>
          <span>{detail}</span>
          {error && <small className="error">{t('claudeContext.refreshFailed', { error })}</small>}
          <small>{refreshStatus}</small>
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
