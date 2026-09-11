import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')

function count(source, pattern) {
  return [...source.matchAll(pattern)].length
}

function sourceBetween(startToken, endToken, from = 0) {
  const start = dialogs.indexOf(startToken, from)
  assert.notEqual(start, -1, `missing scheduler source token: ${startToken}`)
  const end = dialogs.indexOf(endToken, start + startToken.length)
  assert.notEqual(end, -1, `missing scheduler source token: ${endToken}`)
  return dialogs.slice(start, end)
}

const picker = sourceBetween('testID="job-start-picker"', 'testID="job-start-value"')

test('iPhone exact-time controls stack full-width native pickers below separate labels', () => {
  assert.match(dialogs, /const \{ width \} = useWindowDimensions\(\)/)
  assert.match(dialogs, /const compactIOSPicker = Platform\.OS === 'ios' && width < 600/)
  assert.match(picker, /Platform\.OS === 'ios' \? compactIOSPicker \? <>/)
  assert.equal(count(picker, /styles\.jobStartPickerControlPhone/g), 2)
  assert.equal(count(picker, /styles\.jobStartPickerHeading/g), 2)
  assert.equal(count(picker, /style=\{styles\.jobStartPickerNativePhone\}/g), 2)
  assert.match(
    dialogs,
    /jobStartPickerControlPhone: \{[^}]*width: '100%'[^}]*flexDirection: 'column'[^}]*alignItems: 'stretch'/,
  )
  assert.match(
    dialogs,
    /jobStartPickerNativePhone: \{[^}]*width: '100%'[^}]*minHeight: 44[^}]*alignSelf: 'stretch'/,
  )
  assert.match(
    picker,
    /jobStartPickerHeading[^]*?>Date<\/Text><\/View>\s*<DateTimePicker style=\{styles\.jobStartPickerNativePhone\}/,
    'the Date label must close before the full-width native control begins',
  )
  assert.match(
    picker,
    /jobStartPickerHeading[^]*?>Time<\/Text><\/View>\s*<DateTimePicker style=\{styles\.jobStartPickerNativePhone\}/,
    'the Time label must close before the full-width native control begins',
  )
})

test('iPad retains the two compact same-line picker controls', () => {
  assert.match(
    picker,
    /<View style=\{styles\.jobStartPickerControl\}><Calendar[^]*?>Date<\/Text><DateTimePicker testID="job-start-date-picker"[^]*?display="compact"/,
  )
  assert.match(
    picker,
    /<View style=\{styles\.jobStartPickerControl\}><Clock[^]*?>Time<\/Text><DateTimePicker testID="job-start-time-picker"[^]*?display="compact"/,
  )
  assert.equal(count(picker, /testID="job-start-date-picker"/g), 2, 'phone and tablet must each own one Date picker')
  assert.equal(count(picker, /testID="job-start-time-picker"/g), 2, 'phone and tablet must each own one Time picker')
})

test('Android keeps explicit date/time buttons and dialog picker behavior', () => {
  assert.match(picker, /testID="job-start-date-button"[^]*?setAndroidStartPicker\('date'\)/)
  assert.match(picker, /testID="job-start-time-button"[^]*?setAndroidStartPicker\('time'\)/)
  assert.match(dialogs, /Platform\.OS === 'android' && androidStartPicker \? <DateTimePicker/)
  assert.match(dialogs, /mode=\{androidStartPicker\}[^]*?presentation="dialog"[^]*?display="default"/)
  assert.match(dialogs, /applyPickerValue\(part, value, part === 'date'\)[^]*?setAndroidStartPicker\(null\)/)
  assert.match(dialogs, /onDismiss=\{\(\) => setAndroidStartPicker\(null\)\}/)
})

test('all scheduled-job modes, picker updates, and save remain wired', () => {
  for (const mode of ['keep', 'immediate', 'interval', 'time']) {
    assert.match(
      dialogs,
      new RegExp(`testID="job-start-mode-${mode}"[^>]*onPress=\\{\\(\\) => selectStartMode\\('${mode}'\\)\\}`),
      `${mode} start mode must retain its activation handler`,
    )
  }
  assert.match(dialogs, /\(\['interval', 'cron', 'rrule'\] as JobScheduleKind\[\]\)\.map/)
  assert.match(dialogs, /testID=\{`job-schedule-kind-\$\{value\}`\}[^>]*onPress=\{\(\) => setScheduleKind\(value\)\}/)
  assert.match(dialogs, /selected=\{!loop\} onPress=\{\(\) => setLoop\(false\)\}/)
  assert.match(dialogs, /selected=\{loop\} onPress=\{\(\) => setLoop\(true\)\}/)
  assert.match(dialogs, /<Switch accessibilityLabel="Job enabled" value=\{enabled\} onValueChange=\{setEnabled\}/)
  assert.match(dialogs, /if \(value !== 'keep'\) setEnabled\(true\)/)
  assert.match(dialogs, /updateStart\(defaultScheduleWallTime\(new Date\(\), scheduleKind, timezone\)\)/)
  assert.match(dialogs, /const startError = validateJobNextRun\(Boolean\(job\), startMode, start, scheduleKind, enabled\)/)
  assert.match(dialogs, /if \(startError\) \{ setStatus\(startError\); return \}/)
  assert.match(dialogs, /Object\.assign\(patch, jobNextRunUpdatePatch\(\{/)
  assert.equal(count(picker, /onValueChange=\{\(_event, value\) => applyPickerValue\('date', value\)\}/g), 2)
  assert.equal(count(picker, /onValueChange=\{\(_event, value\) => applyPickerValue\('time', value\)\}/g), 2)
  assert.match(dialogs, /testID="job-save"[^>]*disabled=\{saving \|\| !title\.trim\(\) \|\| !prompt\.trim\(\) \|\| Boolean\(scheduleError\) \|\| Boolean\(startError\)\}[^>]*onPress=\{\(\) => void submit\(\)\}/)
})
