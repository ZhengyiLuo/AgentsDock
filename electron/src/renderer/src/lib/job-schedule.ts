import type { Job, JobScheduleKind } from '@shared/types'
import { getLocale, t } from '@shared/i18n'

const DAY_KEYS: Record<string, string> = { MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday', SU: 'sunday' }

export interface JobScheduleDraft {
  intervalSeconds: number
  cronExpression: string
  rrule: string
  timezone: string
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
  separator = 'T',
): string {
  if (value == null || value === '') return ''
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return ''
  if (kind === 'interval') {
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${separator}${pad(date.getHours())}:${pad(date.getMinutes())}`
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

export function parseScheduleWallTime(value: string, kind: JobScheduleKind): string | null {
  const clean = value.trim()
  if (!clean) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(clean) ? clean.replace(' ', 'T') : clean
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return null
  if (kind !== 'interval' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    return normalized
  }
  return parsed.toISOString()
}

export function validateJobSchedule(kind: JobScheduleKind, draft: JobScheduleDraft): string | null {
  if (kind === 'interval') {
    return Number.isFinite(draft.intervalSeconds) && draft.intervalSeconds >= 10
      ? null
      : t('schedule.intervalMinimum')
  }
  if (!draft.timezone.trim()) return t('schedule.chooseTimezone')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone.trim() }).format()
  } catch {
    return t('schedule.invalidTimezone')
  }
  if (kind === 'cron') {
    return draft.cronExpression.trim() ? null : t('schedule.enterCron')
  }
  const normalized = draft.rrule.trim().replace(/^RRULE:/i, '')
  return /(?:^|;)FREQ=[A-Z]+(?:;|$)/i.test(normalized)
    ? null
    : t('schedule.invalidRrule')
}

export function describeJobSchedule(job: Pick<Job, 'schedule_kind' | 'interval_seconds' | 'cron_expression' | 'rrule' | 'timezone'>): string {
  const kind = effectiveScheduleKind(job)
  if (kind === 'interval') return t('schedule.everyInterval', { interval: formatInterval(job.interval_seconds || 0) })
  const timezone = job.timezone?.trim() || 'UTC'
  const schedule = kind === 'cron'
    ? describeCron(job.cron_expression || '')
    : describeRRule(job.rrule || '')
  return `${schedule} · ${timezone}`
}

export function supportedTimezones(): string[] {
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  let zones: string[] = []
  try { zones = Intl.supportedValuesOf('timeZone') } catch { /* Older runtimes still accept free-form IANA names. */ }
  return [...new Set(['UTC', current, ...zones])]
}

/**
 * Describe a cron expression the way AgentsServer parses it (croniter with
 * `second_at_beginning`): five fields are minute-first, six fields put seconds
 * first, and seven fields add a trailing year. Anything the summary cannot
 * express falls back to the raw expression prefixed with "Cron".
 */
export function describeCron(expression: string): string {
  const value = expression.trim().replace(/\s+/g, ' ')
  const alias: Record<string, string> = {
    '@yearly': 'yearly', '@annually': 'yearly', '@monthly': 'monthly', '@weekly': 'weekly',
    '@daily': 'daily', '@midnight': 'midnight', '@hourly': 'hourly'
  }
  if (alias[value.toLowerCase()]) return t(`schedule.${alias[value.toLowerCase()]}`)
  const raw = value ? value.split(' ') : []
  if (raw.length < 5 || raw.length > 7) return value ? `Cron ${value}` : t('schedule.cron')
  const second = raw.length >= 6 ? raw[0] : '0'
  const year = raw.length === 7 ? raw[6] : '*'
  const [minute, hour, dayOfMonth, month, dayOfWeek] = raw.length >= 6 ? raw.slice(1, 6) : raw
  const fallback = `Cron ${value}`
  const yearSuffix = year === '*' ? '' : /^\d{4}$/.test(year) ? t('schedule.inYear', { year }) : null
  if (yearSuffix === null) return fallback

  const isNumber = (field: string) => /^\d+$/.test(field)
  const stepOf = (field: string): number | null => {
    const match = /^\*\/(\d+)$/.exec(field)
    return match ? Number(match[1]) : null
  }
  const plural = everyUnit
  const restIsWild = dayOfMonth === '*' && month === '*' && dayOfWeek === '*'

  // Sub-minute schedules (six/seven-field form).
  if (second !== '0') {
    if (second === '*' && minute === '*' && hour === '*' && restIsWild) return `${everyUnit(1, 'second')}${yearSuffix}`
    const secondStep = stepOf(second)
    if (secondStep && minute === '*' && hour === '*' && restIsWild) return `${plural(secondStep, 'second')}${yearSuffix}`
    if (!isNumber(second)) return fallback
  }
  const secondSuffix = isNumber(second) && Number(second) !== 0 ? t('schedule.secondsSuffix', { seconds: Number(second) }) : ''

  if (minute === '*' && hour === '*' && restIsWild) return `${everyUnit(1, 'minute')}${secondSuffix}${yearSuffix}`
  const minuteStep = stepOf(minute)
  if (minuteStep && hour === '*' && restIsWild) return `${plural(minuteStep, 'minute')}${secondSuffix}${yearSuffix}`
  const hourStep = stepOf(hour)
  if (isNumber(minute) && hourStep && restIsWild) {
    return `${t('schedule.hourStepAt', { interval: plural(hourStep, 'hour'), minute: minute.padStart(2, '0') })}${secondSuffix}${yearSuffix}`
  }
  if (isNumber(minute) && hour === '*' && restIsWild) {
    return `${t('schedule.hourlyAt', { minute: minute.padStart(2, '0') })}${secondSuffix}${yearSuffix}`
  }
  if (isNumber(minute) && isNumber(hour)) {
    const time = `${formatClock(Number(hour), Number(minute))}${secondSuffix}`
    if (dayOfMonth === '*' && month === '*') {
      if (dayOfWeek === '*') return `${t('schedule.dailyAt', { time })}${yearSuffix}`
      if (/^(1-5|MON-FRI)$/i.test(dayOfWeek)) return `${t('schedule.weekdaysAt', { time })}${yearSuffix}`
      if (/^(0,6|6,0|SAT,SUN|SUN,SAT)$/i.test(dayOfWeek)) return `${t('schedule.weekendsAt', { time })}${yearSuffix}`
      const days = cronDays(dayOfWeek)
      if (days) return `${t('schedule.daysAt', { days, time })}${yearSuffix}`
    }
    if (isNumber(dayOfMonth) && month === '*' && dayOfWeek === '*') {
      return `${t('schedule.monthlyAt', { day: Number(dayOfMonth), time })}${yearSuffix}`
    }
    if (isNumber(dayOfMonth) && isNumber(month) && dayOfWeek === '*') {
      return `${t('schedule.yearlyAt', { month: Number(month), day: Number(dayOfMonth), time })}${yearSuffix}`
    }
  }
  return fallback
}

function describeRRule(value: string): string {
  const normalized = value.trim().replace(/^RRULE:/i, '')
  const parts = Object.fromEntries(normalized.split(';').map(part => part.split('=', 2)).filter(part => part.length === 2).map(([key, item]) => [key.toUpperCase(), item]))
  const frequency = parts.FREQ?.toUpperCase()
  if (!frequency) return normalized ? `RRULE ${normalized}` : t('schedule.rrule')
  const simpleKeys = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'])
  const complex = Object.keys(parts).some(key => !simpleKeys.has(key))
    || (Boolean(parts.BYDAY) && (frequency !== 'WEEKLY' || parts.BYDAY.split(',').some(day => /^[-+]?\d/.test(day))))
    || (Boolean(parts.BYHOUR) && !/^\d+$/.test(parts.BYHOUR))
    || (Boolean(parts.BYMINUTE) && !/^\d+$/.test(parts.BYMINUTE))
    || (Boolean(parts.BYSECOND) && parts.BYSECOND !== '0')
  if (complex) return `RRULE ${normalized}`
  const interval = Math.max(1, Number(parts.INTERVAL) || 1)
  const units: Record<string, string> = {
    MINUTELY: 'minute', HOURLY: 'hour', DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year'
  }
  const unit = units[frequency]
  let text = unit ? everyUnit(interval, unit) : `RRULE ${normalized}`
  const days = parts.BYDAY?.split(',').map(day => {
    const key = DAY_KEYS[day.replace(/^[-+]?\d+/, '').toUpperCase()]
    return key ? t(`schedule.${key}`) : day
  }).join(t('schedule.daySeparator'))
  if (days) text = t('schedule.recurrenceDays', { recurrence: text, days })
  if (parts.BYHOUR && /^\d+$/.test(parts.BYHOUR)) text = t('schedule.recurrenceTime', { recurrence: text, time: formatClock(Number(parts.BYHOUR), Number(parts.BYMINUTE) || 0) })
  return text
}

function cronDays(value: string): string | null {
  const cronDayNames: Record<string, string> = {
    '0': 'sunday', '1': 'monday', '2': 'tuesday', '3': 'wednesday', '4': 'thursday', '5': 'friday', '6': 'saturday', '7': 'sunday',
    SUN: 'sunday', MON: 'monday', TUE: 'tuesday', WED: 'wednesday', THU: 'thursday', FRI: 'friday', SAT: 'saturday'
  }
  const days = value.split(',').map(day => cronDayNames[day.toUpperCase()])
  return days.every(Boolean) ? days.map(day => t(`schedule.${day}`)).join(t('schedule.daySeparator')) : null
}

function formatClock(hour: number, minute: number): string {
  const hour12 = hour % 12 || 12
  return t('schedule.clock', {
    period: t(hour >= 12 ? 'schedule.pm' : 'schedule.am'),
    hour: hour12,
    minute: String(minute).padStart(2, '0')
  })
}

function formatInterval(seconds: number): string {
  if (seconds <= 0) return t('schedule.configuredInterval')
  for (const [size, unit] of [[604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']] as const) {
    if (seconds % size === 0) return t(`schedule.interval.${unit}`, { count: seconds / size })
  }
  return t('schedule.interval.second', { count: seconds })
}

function everyUnit(count: number, unit: string): string {
  return t(`schedule.every.${unit}.${count === 1 ? 'one' : 'many'}`, { count })
}
