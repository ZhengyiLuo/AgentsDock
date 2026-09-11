import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import { describeCron, describeJobSchedule, effectiveScheduleKind, formatScheduleWallTime, jobLoopsForever, parseScheduleWallTime, validateJobSchedule } from './job-schedule'

describe('job schedules', () => {
  afterEach(() => setLocale('en'))

  it('localizes calendar summaries and validation without translating syntax, timezone IDs or wall-time values', () => {
    setLocale('zh-CN')
    expect(describeJobSchedule({ interval_seconds: 3600 })).toBe('每 1 小时')
    expect(describeCron('@hourly')).toBe('每小时')
    expect(describeCron('0 15 9 * * 1-5')).toBe('工作日 上午 9:15')
    expect(describeCron('0 0 9 * * 1-5 2027')).toBe('工作日 上午 9:00（2027 年）')
    expect(describeCron('0 0 9 25 12 *')).toBe('每年 12 月 25 日 上午 9:00')
    expect(describeCron('*/30 * * * * *')).toBe('每 30 秒')
    expect(describeJobSchedule({ schedule_kind: 'rrule', interval_seconds: null, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=14;BYMINUTE=30', timezone: 'Europe/London' }))
      .toBe('每周（周一、周三），下午 2:30 · Europe/London')
    expect(describeCron('0 9-17/2 * * 1-5')).toBe('Cron 0 9-17/2 * * 1-5')
    expect(validateJobSchedule('interval', { intervalSeconds: 9, cronExpression: '', rrule: '', timezone: '' })).toBe('间隔必须至少为 10 秒。')
    expect(validateJobSchedule('rrule', { intervalSeconds: 60, cronExpression: '', rrule: '', timezone: 'UTC' })).toContain('FREQ=WEEKLY;BYDAY=MO,WE')
    expect(formatScheduleWallTime('2026-07-21T16:00:00Z', 'cron', 'America/Los_Angeles')).toBe('2026-07-21T09:00')
    expect(parseScheduleWallTime('2026-07-21T09:00', 'cron')).toBe('2026-07-21T09:00')
  })
  it('keeps legacy jobs on the interval schedule', () => {
    expect(effectiveScheduleKind({})).toBe('interval')
    expect(describeJobSchedule({ interval_seconds: 3600 })).toBe('Every 1h')
  })

  it('describes common cron schedules with their timezone', () => {
    expect(describeJobSchedule({
      schedule_kind: 'cron', interval_seconds: null, cron_expression: '0 9 * * 1-5', timezone: 'America/Los_Angeles'
    })).toBe('Weekdays at 9:00 AM · America/Los_Angeles')
    expect(describeJobSchedule({
      schedule_kind: 'cron', interval_seconds: null, cron_expression: '@hourly', timezone: 'UTC'
    })).toBe('Hourly · UTC')
  })

  it('describes the server\'s six- and seven-field cron forms (seconds first, year last)', () => {
    // AgentsServer validates with croniter(second_at_beginning=True), so a
    // six-field expression carries seconds in the first position. These used
    // to fall through to the raw "Cron ..." text in the Jobs panel.
    expect(describeCron('0 */5 * * * *')).toBe('Every 5 minutes')
    expect(describeCron('0 0 */2 * * *')).toBe('Every 2 hours at :00')
    expect(describeCron('*/30 * * * * *')).toBe('Every 30 seconds')
    expect(describeCron('* * * * * *')).toBe('Every second')
    expect(describeCron('0 15 9 * * 1-5')).toBe('Weekdays at 9:15 AM')
    expect(describeCron('30 0 12 * * *')).toBe('Daily at 12:00 PM and 30s')
    expect(describeCron('0 0 9 1 * *')).toBe('Monthly on day 1 at 9:00 AM')
    expect(describeCron('0 0 9 25 12 *')).toBe('Yearly on 12/25 at 9:00 AM')
    expect(describeCron('0 0 9 * * 1-5 2027')).toBe('Weekdays at 9:00 AM in 2027')
    expect(describeCron('0 0 10 * * 0,6')).toBe('Weekends at 10:00 AM')
  })

  it('describes step schedules in the classic five-field form', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours at :00')
    expect(describeCron('* * * * *')).toBe('Every minute')
    expect(describeCron('5 * * * *')).toBe('Hourly at :05')
  })

  it('falls back to the raw expression only when the summary cannot express it', () => {
    expect(describeCron('0 9-17/2 * * 1-5')).toBe('Cron 0 9-17/2 * * 1-5')
    expect(describeCron('H 9 * * *')).toBe('Cron H 9 * * *')
    expect(describeCron('0 0 9 * * 1-5 20xx')).toBe('Cron 0 0 9 * * 1-5 20xx')
    expect(describeCron('')).toBe('Cron schedule')
    expect(describeCron('1 2 3')).toBe('Cron 1 2 3')
  })

  it('describes RRULE frequency, days, time, and timezone', () => {
    expect(describeJobSchedule({
      schedule_kind: 'rrule', interval_seconds: null,
      rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=14;BYMINUTE=30', timezone: 'Europe/London'
    })).toBe('Every week on Monday, Wednesday at 2:30 PM · Europe/London')
  })

  it('shows full syntax when an RRULE has constraints the summary cannot express', () => {
    expect(describeJobSchedule({
      schedule_kind: 'rrule', interval_seconds: null,
      rrule: 'FREQ=MONTHLY;COUNT=3;BYDAY=1MO;BYSETPOS=1', timezone: 'UTC'
    })).toBe('RRULE FREQ=MONTHLY;COUNT=3;BYDAY=1MO;BYSETPOS=1 · UTC')
  })

  it('uses max_runs to identify finite calendar recurrences', () => {
    expect(jobLoopsForever({ schedule_kind: 'cron', loop: true, max_runs: 3 })).toBe(false)
    expect(jobLoopsForever({ schedule_kind: 'rrule', loop: true, max_runs: null })).toBe(true)
    expect(jobLoopsForever({ schedule_kind: 'interval', loop: false, max_runs: 3 })).toBe(false)
  })

  it('keeps recurrence wall times in the selected timezone', () => {
    expect(formatScheduleWallTime('2026-07-21T16:00:00Z', 'cron', 'America/Los_Angeles')).toBe('2026-07-21T09:00')
    expect(parseScheduleWallTime('2026-07-21T09:00', 'cron')).toBe('2026-07-21T09:00')
    expect(parseScheduleWallTime('2026-07-21T09:00', 'interval')).toMatch(/Z$/)
  })

  it('validates only the client-side invariants and leaves full parsing to the server', () => {
    expect(validateJobSchedule('interval', { intervalSeconds: 9, cronExpression: '', rrule: '', timezone: '' })).toMatch(/10 seconds/)
    expect(validateJobSchedule('cron', { intervalSeconds: 60, cronExpression: '@daily', rrule: '', timezone: 'UTC' })).toBeNull()
    expect(validateJobSchedule('cron', { intervalSeconds: 60, cronExpression: '', rrule: '', timezone: 'UTC' })).toMatch(/cron expression/)
    expect(validateJobSchedule('rrule', { intervalSeconds: 60, cronExpression: '', rrule: 'BYDAY=MO', timezone: 'UTC' })).toMatch(/FREQ=/)
    expect(validateJobSchedule('rrule', { intervalSeconds: 60, cronExpression: '', rrule: 'RRULE:FREQ=DAILY', timezone: 'Not/AZone' })).toMatch(/valid IANA/)
  })
})
