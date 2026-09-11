import type { Job, JobScheduleKind, UpdateJobInput } from '../types'

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
}

export const JOB_INTERVAL_PRESETS_SECONDS = [
  60,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  14400,
  28800,
  43200,
  86400,
  604800,
] as const

export interface JobScheduleDraft {
  intervalSeconds: number
  cronExpression: string
  rrule: string
  timezone: string
}

export interface JobScheduleFields {
  schedule_kind: JobScheduleKind
  interval_seconds: number | null
  cron_expression: string | null
  rrule: string | null
  timezone: string | null
}

export type JobStartMode = 'keep' | 'immediate' | 'interval' | 'time'

export interface JobNextRunUpdateDraft {
  mode: JobStartMode
  scheduleKind: JobScheduleKind
  intervalSeconds: number
  /** Parsed absolute or recurrence-local timestamp for immediate/time modes. */
  scheduledTime: string | null
  now?: Date
}

type ScheduleWallTimePart = 'date' | 'time'

interface ScheduleWallTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export function effectiveScheduleKind(job: Pick<Job, 'schedule_kind'>): JobScheduleKind {
  return job.schedule_kind || 'interval'
}

export function jobLoopsForever(job: Pick<Job, 'schedule_kind' | 'loop' | 'max_runs'>): boolean {
  return effectiveScheduleKind(job) === 'interval'
    ? Boolean(job.loop)
    : job.max_runs == null
}

export function formatScheduleWallTime(
  value: string | number | null | undefined,
  kind: JobScheduleKind,
  timezone?: string | null,
  separator = ' ',
): string {
  if (value == null || value === '') return ''
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return ''
  if (kind === 'interval') {
    return formatLocalScheduleWallTime(date, separator)
  }
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone?.trim() || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}${separator}${parts.hour}:${parts.minute}`
  } catch {
    return ''
  }
}

/**
 * Returns a useful initial value when a user switches a job to “At a time”.
 * The value is deliberately a wall time: recurrence schedules are interpreted
 * by the server in their selected timezone, while interval schedules are
 * converted to an absolute instant by parseScheduleWallTime.
 */
export function defaultScheduleWallTime(
  now = new Date(),
  kind: JobScheduleKind = 'interval',
  timezone?: string | null,
): string {
  const value = new Date(now)
  value.setSeconds(0, 0)
  const remainder = value.getMinutes() % 5
  value.setMinutes(value.getMinutes() + (remainder === 0 ? 5 : 5 - remainder))
  return kind === 'interval'
    ? formatLocalScheduleWallTime(value)
    : formatScheduleWallTime(value.toISOString(), kind, timezone)
}

/** Builds a picker Date whose local components exactly match a stored wall time. */
export function scheduleWallTimePickerDate(value: string, fallback = new Date()): Date {
  const parts = scheduleWallTimeParts(value)
  if (!parts) return new Date(fallback)
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0)
}

/** Android Material's calendar dialog consumes the selected day in UTC. */
export function scheduleWallTimeAndroidDatePickerDate(value: string, fallback = new Date()): Date {
  const local = scheduleWallTimePickerDate(value, fallback)
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

/**
 * Merges one native picker result into a wall-time string without allowing the
 * date picker to silently overwrite the time (or vice versa). Android's
 * Material date dialog reports the chosen calendar day as UTC midnight, so its
 * date components must be read in UTC.
 */
export function mergeScheduleWallTimePickerValue(
  currentValue: string,
  selected: Date,
  part: ScheduleWallTimePart,
  androidUtcDate = false,
): string {
  const base = scheduleWallTimePickerDate(currentValue, selected)
  if (part === 'date') {
    const year = androidUtcDate ? selected.getUTCFullYear() : selected.getFullYear()
    const month = androidUtcDate ? selected.getUTCMonth() : selected.getMonth()
    const day = androidUtcDate ? selected.getUTCDate() : selected.getDate()
    base.setFullYear(year, month, day)
  } else {
    base.setHours(selected.getHours(), selected.getMinutes(), 0, 0)
  }
  return formatLocalScheduleWallTime(base)
}

export function parseScheduleWallTime(value: string, kind: JobScheduleKind): string | null {
  const clean = value.trim()
  if (!clean) return null
  const isBareWallTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(clean)
  if (isBareWallTime && !scheduleWallTimeParts(clean)) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(clean) ? clean.replace(' ', 'T') : clean
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return null
  if (kind !== 'interval' && isBareWallTime) {
    return normalized
  }
  return parsed.toISOString()
}

/**
 * Validate the relationship between an explicit next-run choice and Enabled.
 * Editing any occurrence of a paused job is contradictory: the server clears
 * next-run timestamps while disabled, so require the user to enable it first.
 */
export function validateJobNextRun(
  editing: boolean,
  mode: JobStartMode,
  value: string,
  kind: JobScheduleKind,
  enabled: boolean,
): string | null {
  if (mode === 'time' && !parseScheduleWallTime(value, kind)) {
    return 'Choose a valid date and time.'
  }
  if (editing && mode !== 'keep' && !enabled) {
    return 'Enable the job to change its next run.'
  }
  if (!editing && (mode === 'time' || mode === 'immediate') && !enabled) {
    return 'Enable the job to use an exact first run time.'
  }
  return null
}

/**
 * Build the server's tri-state next-run patch:
 * - omitted preserves the current occurrence;
 * - null discards an override and recomputes a cron/RRULE match;
 * - a timestamp selects an occurrence. For intervals, the server also adopts
 *   that timestamp as the recurring cadence anchor.
 */
export function jobNextRunUpdatePatch(draft: JobNextRunUpdateDraft): UpdateJobInput {
  if (draft.mode === 'keep') return {}
  if (draft.mode === 'immediate' || draft.mode === 'time') {
    if (!draft.scheduledTime) throw new Error('A concrete next-run time is required.')
    return { next_run_at: draft.scheduledTime, enabled: true }
  }
  if (draft.scheduleKind !== 'interval') {
    return { next_run_at: null, enabled: true }
  }
  const delaySeconds = Math.max(10, Number.isFinite(draft.intervalSeconds) ? draft.intervalSeconds : 3600)
  const now = draft.now ? new Date(draft.now) : new Date()
  return {
    next_run_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    enabled: true,
  }
}

function formatLocalScheduleWallTime(date: Date, separator = ' '): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${separator}${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function scheduleWallTimeParts(value: string): ScheduleWallTimeParts | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const calendarDay = new Date(Date.UTC(year, month - 1, day))
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return null
  return { year, month, day, hour, minute }
}

export function validateJobSchedule(kind: JobScheduleKind, draft: JobScheduleDraft): string | null {
  if (kind === 'interval') {
    return Number.isFinite(draft.intervalSeconds) && draft.intervalSeconds >= 10
      ? null
      : 'Interval must be at least 10 seconds.'
  }
  if (!draft.timezone.trim()) return 'Enter an IANA timezone.'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone.trim() }).format()
  } catch {
    return 'Timezone must be a valid IANA name, such as America/Los_Angeles.'
  }
  if (kind === 'cron') return draft.cronExpression.trim() ? null : 'Enter a cron expression.'
  const normalized = draft.rrule.trim().replace(/^RRULE:/i, '')
  return /(?:^|;)FREQ=[A-Z]+(?:;|$)/i.test(normalized)
    ? null
    : 'RRULE must include FREQ=, such as FREQ=WEEKLY;BYDAY=MO,WE.'
}

export function jobScheduleFields(kind: JobScheduleKind, draft: JobScheduleDraft): JobScheduleFields {
  return {
    schedule_kind: kind,
    interval_seconds: kind === 'interval' ? Math.max(10, Number.isFinite(draft.intervalSeconds) ? draft.intervalSeconds : 3600) : null,
    cron_expression: kind === 'cron' ? draft.cronExpression.trim() : null,
    rrule: kind === 'rrule' ? draft.rrule.trim() : null,
    timezone: kind === 'interval' ? null : draft.timezone.trim(),
  }
}

export function jobScheduleUpdatePatch(
  job: Pick<Job, 'schedule_kind' | 'interval_seconds' | 'cron_expression' | 'rrule' | 'timezone'>,
  fields: JobScheduleFields,
): UpdateJobInput {
  const patch: UpdateJobInput = {}
  if (fields.schedule_kind !== effectiveScheduleKind(job)) patch.schedule_kind = fields.schedule_kind
  if (fields.interval_seconds !== job.interval_seconds) patch.interval_seconds = fields.interval_seconds
  if (fields.cron_expression !== (job.cron_expression ?? null)) patch.cron_expression = fields.cron_expression
  if (fields.rrule !== (job.rrule ?? null)) patch.rrule = fields.rrule
  const currentTimezone = effectiveScheduleKind(job) === 'interval' ? null : (job.timezone ?? null)
  if (fields.timezone !== currentTimezone) patch.timezone = fields.timezone
  return patch
}

export function describeJobSchedule(job: Pick<Job, 'schedule_kind' | 'interval_seconds' | 'cron_expression' | 'rrule' | 'timezone'>): string {
  const kind = effectiveScheduleKind(job)
  if (kind === 'interval') return `Every ${formatInterval(job.interval_seconds || 0)}`
  const timezone = job.timezone?.trim() || 'UTC'
  const schedule = kind === 'cron' ? describeCron(job.cron_expression || '') : describeRRule(job.rrule || '')
  return `${schedule} · ${timezone}`
}

function describeCron(expression: string): string {
  const value = expression.trim()
  const alias: Record<string, string> = {
    '@yearly': 'Yearly', '@annually': 'Yearly', '@monthly': 'Monthly', '@weekly': 'Weekly',
    '@daily': 'Daily', '@midnight': 'Daily at midnight', '@hourly': 'Hourly',
  }
  if (alias[value.toLowerCase()]) return alias[value.toLowerCase()]
  const fields = value.split(/\s+/)
  if (fields.length !== 5) return value ? `Cron ${value}` : 'Cron schedule'
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (fields.every(field => field === '*')) return 'Every minute'
  if (/^\d+$/.test(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Hourly at :${minute.padStart(2, '0')}`
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*') {
    const time = formatClock(Number(hour), Number(minute))
    if (dayOfWeek === '*') return `Daily at ${time}`
    if (/^(1-5|MON-FRI)$/i.test(dayOfWeek)) return `Weekdays at ${time}`
    const days = cronDays(dayOfWeek)
    if (days) return `${days} at ${time}`
  }
  return `Cron ${value}`
}

function describeRRule(value: string): string {
  const normalized = value.trim().replace(/^RRULE:/i, '')
  const parts = Object.fromEntries(normalized.split(';').map(part => part.split('=', 2)).filter(part => part.length === 2).map(([key, item]) => [key.toUpperCase(), item]))
  const frequency = parts.FREQ?.toUpperCase()
  if (!frequency) return normalized ? `RRULE ${normalized}` : 'RRULE schedule'
  const simpleKeys = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'])
  const complex = Object.keys(parts).some(key => !simpleKeys.has(key))
    || (Boolean(parts.BYDAY) && (frequency !== 'WEEKLY' || parts.BYDAY.split(',').some(day => /^[-+]?\d/.test(day))))
    || (Boolean(parts.BYHOUR) && !/^\d+$/.test(parts.BYHOUR))
    || (Boolean(parts.BYMINUTE) && !/^\d+$/.test(parts.BYMINUTE))
    || (Boolean(parts.BYSECOND) && parts.BYSECOND !== '0')
  if (complex) return `RRULE ${normalized}`
  const interval = Math.max(1, Number(parts.INTERVAL) || 1)
  const units: Record<string, [string, string]> = {
    MINUTELY: ['minute', 'minutes'], HOURLY: ['hour', 'hours'], DAILY: ['day', 'days'],
    WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'],
  }
  const unit = units[frequency]
  let text = unit ? (interval === 1 ? `Every ${unit[0]}` : `Every ${interval} ${unit[1]}`) : `RRULE ${normalized}`
  const days = parts.BYDAY?.split(',').map(day => DAY_NAMES[day.replace(/^[-+]?\d+/, '').toUpperCase()] || day).join(', ')
  if (days) text += ` on ${days}`
  if (parts.BYHOUR && /^\d+$/.test(parts.BYHOUR)) text += ` at ${formatClock(Number(parts.BYHOUR), Number(parts.BYMINUTE) || 0)}`
  return text
}

function cronDays(value: string): string | null {
  const names: Record<string, string> = {
    '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday',
    SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday',
  }
  const days = value.split(',').map(day => names[day.toUpperCase()])
  return days.every(Boolean) ? days.join(', ') : null
}

function formatClock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM'
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`
}

function formatInterval(seconds: number): string {
  if (seconds <= 0) return 'configured interval'
  if (seconds % 604800 === 0) return `${seconds / 604800}w`
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}
