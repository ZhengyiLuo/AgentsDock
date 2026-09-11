import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import { timelineCount, timelineEventLabel, timelineStatusLabel } from './timeline-labels'

afterEach(() => setLocale('en'))

describe('timeline semantic labels', () => {
  it('keeps English plurals and translates Chinese count templates', () => {
    expect(timelineCount('tools', 1)).toBe('1 tool')
    expect(timelineCount('tools', 2)).toBe('2 tools')
    setLocale('zh-CN')
    expect(timelineCount('tools', 2)).toBe('2 个工具')
    expect(timelineCount('editedFiles', 3)).toBe('已编辑 3 个文件')
    expect(timelineCount('earlierMessages', 1)).toBe('显示 1 条更早的消息')
  })

  it('translates known statuses and event semantics without interpreting unknown content as translation keys', () => {
    setLocale('zh-CN')
    expect(timelineStatusLabel('completed')).toBe('已完成')
    expect(timelineEventLabel('session_created')).toBe('会话已创建')
    expect(timelineEventLabel('reasoning_summary')).toBe('Reasoning 摘要')
    expect(timelineEventLabel('new_provider_event')).toBe('New Provider Event')
  })
})
