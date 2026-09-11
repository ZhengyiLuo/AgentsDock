import type { Job } from '../types'
import { defaultScheduleWallTime, describeJobSchedule, effectiveScheduleKind, formatScheduleWallTime, JOB_INTERVAL_PRESETS_SECONDS, jobLoopsForever, jobNextRunUpdatePatch, jobScheduleFields, jobScheduleUpdatePatch, mergeScheduleWallTimePickerValue, parseScheduleWallTime, scheduleWallTimeAndroidDatePickerDate, validateJobNextRun, validateJobSchedule } from './job-schedule'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const base: Job = {
  id: 'job-1', session_id: 'chat-1', title: 'Status', prompt: 'Check status', interval_seconds: 3600,
}

assert(effectiveScheduleKind(base) === 'interval', 'legacy jobs should remain interval schedules')
assert(describeJobSchedule(base) === 'Every 1h', 'interval jobs should keep their compact description')
assert(validateJobSchedule('interval', { intervalSeconds: 9, cronExpression: '', rrule: '', timezone: '' }) != null, 'short intervals should be rejected')
assert(JOB_INTERVAL_PRESETS_SECONDS.includes(600), 'mobile presets should include 10 minutes')
assert(JOB_INTERVAL_PRESETS_SECONDS.includes(1800), 'mobile presets should include 30 minutes')
assert(jobScheduleFields('interval', {
  intervalSeconds: 600, cronExpression: '', rrule: '', timezone: '',
}).interval_seconds === 600, '10-minute presets should submit exactly 600 seconds')
assert(jobScheduleUpdatePatch(base, jobScheduleFields('interval', {
  intervalSeconds: 1800, cronExpression: '', rrule: '', timezone: '',
})).interval_seconds === 1800, '30-minute edits should patch exactly 1800 seconds')
assert(Object.keys(jobScheduleUpdatePatch({ ...base, timezone: 'UTC' }, jobScheduleFields('interval', {
  intervalSeconds: 3600, cronExpression: '', rrule: '', timezone: '',
}))).length === 0, 'server-normalized UTC must not make an unchanged interval schedule look edited')

const cron: Job = {
  ...base,
  interval_seconds: null,
  schedule_kind: 'cron',
  cron_expression: '0 9 * * 1-5',
  timezone: 'America/Los_Angeles',
}
assert(describeJobSchedule(cron) === 'Weekdays at 9:00 AM · America/Los_Angeles', 'cron jobs should render their rule and timezone')
assert(validateJobSchedule('cron', { intervalSeconds: 0, cronExpression: '@hourly', rrule: '', timezone: 'UTC' }) == null, 'cron aliases should pass client validation')
assert(!jobLoopsForever({ ...cron, loop: true, max_runs: 3 }), 'finite cron jobs should derive their mode from max_runs')
assert(formatScheduleWallTime('2026-07-21T16:00:00Z', 'cron', 'America/Los_Angeles') === '2026-07-21 09:00', 'recurrence edit values should use the selected timezone')
assert(parseScheduleWallTime('2026-07-21 09:00', 'cron') === '2026-07-21T09:00', 'recurrence inputs should remain naive wall times for the server timezone')
assert(defaultScheduleWallTime(new Date(2026, 7, 25, 10, 2, 30)) === '2026-08-25 10:05', 'the picker should start at the next five-minute boundary')
assert(defaultScheduleWallTime(new Date('2026-08-25T17:02:30.000Z'), 'cron', 'America/Los_Angeles') === '2026-08-25 10:05', 'cron defaults must use the selected schedule timezone instead of the device timezone')
assert(defaultScheduleWallTime(new Date('2026-08-25T17:02:30.000Z'), 'rrule', 'UTC') === '2026-08-25 17:05', 'RRULE defaults must preserve the same instant in their selected timezone')
const androidCalendarValue = scheduleWallTimeAndroidDatePickerDate('2026-08-25 23:55')
assert(androidCalendarValue.toISOString() === '2026-08-25T00:00:00.000Z', 'Android calendar values should use the intended UTC day in every device timezone')
const selectedAndroidDay = new Date('2026-08-26T00:00:00.000Z')
const dateMerged = mergeScheduleWallTimePickerValue('2026-08-25 23:55', selectedAndroidDay, 'date', true)
assert(dateMerged === '2026-08-26 23:55', 'Android date selection should not shift west of UTC or overwrite the selected time')
const timeMerged = mergeScheduleWallTimePickerValue(dateMerged, new Date(2026, 0, 1, 9, 45), 'time')
assert(timeMerged === '2026-08-26 09:45', 'time selection should preserve the already selected calendar day')
assert(parseScheduleWallTime(timeMerged, 'cron') === '2026-08-26T09:45', 'cron picker values should remain naive wall times for the selected timezone')
assert(parseScheduleWallTime(timeMerged, 'rrule') === '2026-08-26T09:45', 'RRULE picker values should remain naive wall times for the selected timezone')
assert(parseScheduleWallTime(timeMerged, 'interval')?.endsWith('Z') === true, 'interval picker values should become absolute UTC instants')
assert(validateJobNextRun(true, 'time', '', 'interval', true) === 'Choose a valid date and time.', 'blank exact times must block an edit')
assert(validateJobNextRun(true, 'time', 'not-a-date', 'cron', true) === 'Choose a valid date and time.', 'invalid exact times must block an edit')
assert(validateJobNextRun(true, 'time', '2026-02-30 09:00', 'cron', true) === 'Choose a valid date and time.', 'impossible calendar dates must block an edit instead of normalizing silently')
assert(validateJobNextRun(true, 'interval', '', 'cron', false) === 'Enable the job to change its next run.', 'a paused job must not silently discard Next match')
assert(validateJobNextRun(false, 'interval', '', 'cron', false) == null, 'a newly created paused recurrence may keep its canonical first match')

const preservedNextRun = jobNextRunUpdatePatch({
  mode: 'keep', scheduleKind: 'cron', intervalSeconds: 3600, scheduledTime: null,
})
assert(!Object.prototype.hasOwnProperty.call(preservedNextRun, 'next_run_at'), 'Keep must omit next_run_at so the current occurrence survives')
const resetNextRun = jobNextRunUpdatePatch({
  mode: 'interval', scheduleKind: 'cron', intervalSeconds: 3600, scheduledTime: null,
})
assert(Object.prototype.hasOwnProperty.call(resetNextRun, 'next_run_at') && resetNextRun.next_run_at === null, 'Next match must send an explicit null reset')
assert(resetNextRun.enabled === true, 'Next match must enable a paused job so the server can recompute it')
const rruleReset = jobNextRunUpdatePatch({
  mode: 'interval', scheduleKind: 'rrule', intervalSeconds: 3600, scheduledTime: null,
})
assert(rruleReset.next_run_at === null && rruleReset.enabled === true, 'RRULE Next match must use the same explicit reset contract')
const exactCronRun = jobNextRunUpdatePatch({
  mode: 'time', scheduleKind: 'cron', intervalSeconds: 3600, scheduledTime: '2026-08-26T09:45',
})
assert(exactCronRun.next_run_at === '2026-08-26T09:45' && exactCronRun.enabled === true, 'an exact recurrence override must send its concrete wall time and enable the job')
const exactIntervalRun = jobNextRunUpdatePatch({
  mode: 'time', scheduleKind: 'interval', intervalSeconds: 3600, scheduledTime: '2026-08-26T16:45:00.000Z',
})
assert(exactIntervalRun.next_run_at === '2026-08-26T16:45:00.000Z' && exactIntervalRun.enabled === true, 'an exact interval anchor must be sent unchanged and enable the job')
const delayedIntervalRun = jobNextRunUpdatePatch({
  mode: 'interval', scheduleKind: 'interval', intervalSeconds: 600, scheduledTime: null, now: new Date('2026-08-26T16:00:00.000Z'),
})
assert(delayedIntervalRun.next_run_at === '2026-08-26T16:10:00.000Z' && delayedIntervalRun.enabled === true, 'After interval must send the new cadence anchor and enable the job')
const unchangedCronPatch = jobScheduleUpdatePatch(cron, jobScheduleFields('cron', {
  intervalSeconds: 3600,
  cronExpression: '0 9 * * 1-5',
  rrule: 'FREQ=DAILY',
  timezone: 'America/Los_Angeles',
}))
assert(Object.keys(unchangedCronPatch).length === 0, 'saving an unchanged cron job must not rewrite it as an interval')

const recurrence: Job = {
  ...base,
  interval_seconds: null,
  schedule_kind: 'rrule',
  rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=14;BYMINUTE=30',
  timezone: 'UTC',
}
assert(describeJobSchedule(recurrence) === 'Every week on Monday, Wednesday at 2:30 PM · UTC', 'RRULE jobs should render their recurrence and timezone')
assert(describeJobSchedule({ ...recurrence, rrule: 'FREQ=MONTHLY;COUNT=3;BYDAY=1MO;BYSETPOS=1' }) === 'RRULE FREQ=MONTHLY;COUNT=3;BYDAY=1MO;BYSETPOS=1 · UTC', 'complex RRULE constraints must remain visible')
assert(validateJobSchedule('rrule', { intervalSeconds: 0, cronExpression: '', rrule: 'BYDAY=MO', timezone: 'UTC' }) != null, 'RRULE must include a frequency')
assert(validateJobSchedule('rrule', { intervalSeconds: 0, cronExpression: '', rrule: 'FREQ=DAILY', timezone: 'Not/A_Zone' }) != null, 'recurrence timezone must be valid')
const changedRulePatch = jobScheduleUpdatePatch(recurrence, jobScheduleFields('rrule', {
  intervalSeconds: 3600,
  cronExpression: '',
  rrule: 'FREQ=DAILY',
  timezone: 'UTC',
}))
assert(Object.keys(changedRulePatch).join(',') === 'rrule' && changedRulePatch.rrule === 'FREQ=DAILY', 'editing an RRULE should patch only the changed recurrence field')

console.log('job schedule regressions passed')
