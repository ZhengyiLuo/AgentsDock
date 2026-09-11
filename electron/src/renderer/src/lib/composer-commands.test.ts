import { describe, expect, it } from 'vitest'
import {
  composerCommandTrigger,
  filterComposerCommands,
  groupComposerCommandsByCategory,
  matchComposerCommands,
  type ComposerCommandCategory,
  type ComposerCommandMetadata
} from './composer-commands'

interface TestCommand extends ComposerCommandMetadata {
  provider: 'all' | 'codex' | 'claude'
}

const commands: readonly TestCommand[] = [
  { id: 'chat', label: 'Chat', description: 'Choose another chat', keywords: ['handoff', 'cross-chat'], provider: 'all' },
  { id: 'goal', label: 'Goal', description: 'Set a persistent goal', keywords: ['objective'], provider: 'codex' },
  { id: 'model', label: 'Model', description: 'Choose a model', keywords: ['runtime'], provider: 'all' },
  { id: 'plan', label: 'Plan mode', description: 'Use Claude plan mode', keywords: ['permission mode'], provider: 'claude' },
  { id: 'reasoning', label: 'Reasoning', description: 'Choose reasoning effort', keywords: ['effort'], provider: 'all' },
  { id: 'status', label: 'Status', description: 'Show chat status', keywords: ['context usage'], provider: 'all' }
]

describe('composer slash commands', () => {
  it('finds a command only as the first non-whitespace token at the textarea caret', () => {
    expect(composerCommandTrigger('/', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(composerCommandTrigger('  /Mo', 5)).toEqual({ start: 2, end: 5, query: 'Mo' })
    expect(composerCommandTrigger('\n\t/reasoning', 12)).toEqual({ start: 2, end: 12, query: 'reasoning' })
    expect(composerCommandTrigger('/plugin:review_code.v2', 22)).toEqual({
      start: 0,
      end: 22,
      query: 'plugin:review_code.v2'
    })

    expect(composerCommandTrigger('Ask /model', 10)).toBeNull()
    expect(composerCommandTrigger('https://example.com', 19)).toBeNull()
    expect(composerCommandTrigger('/model now', 10)).toBeNull()
    expect(composerCommandTrigger('/model', 3)).toBeNull()
  })

  it('keeps /chat in command discovery until an argument delegates to the handoff parser', () => {
    expect(matchComposerCommands('/ch', 3, commands)?.commands.map(command => command.id)).toEqual(['chat'])
    expect(matchComposerCommands('/chat', 5, commands)).toMatchObject({
      trigger: { start: 0, end: 5, query: 'chat' },
      commands: [{ id: 'chat' }]
    })

    expect(composerCommandTrigger('/chat ', 6)).toBeNull()
    expect(matchComposerCommands('/chat Training', 14, commands)).toBeNull()
    expect(matchComposerCommands('/chat/sess_123', 14, commands)).toBeNull()
  })

  it('does not open a command match for ordinary absolute paths or prose slashes', () => {
    expect(matchComposerCommands('/Users/dev/project', 18, commands)).toBeNull()
    expect(matchComposerCommands('/Volumes', 8, commands)).toBeNull()
    expect(matchComposerCommands('/tmp', 4, commands)).toBeNull()
    expect(matchComposerCommands('Compare A/B', 11, commands)).toBeNull()
  })

  it('matches IDs, labels, and keywords without changing declaration order', () => {
    expect(filterComposerCommands(commands, '').map(command => command.id)).toEqual([
      'chat', 'goal', 'model', 'plan', 'reasoning', 'status'
    ])
    expect(filterComposerCommands(commands, 'rea').map(command => command.id)).toEqual(['reasoning'])
    expect(filterComposerCommands(commands, 'eff').map(command => command.id)).toEqual(['reasoning'])
    expect(filterComposerCommands(commands, 'objective').map(command => command.id)).toEqual(['goal'])
    expect(filterComposerCommands(commands, 'cross').map(command => command.id)).toEqual(['chat'])
    expect(filterComposerCommands(commands, 'plan-mode').map(command => command.id)).toEqual(['plan'])
    expect(filterComposerCommands(commands, 'planmode').map(command => command.id)).toEqual(['plan'])
    expect(filterComposerCommands(commands, 'does-not-exist')).toEqual([])
    expect(filterComposerCommands(commands, 'model with args')).toEqual([])
  })

  it('applies a caller-owned availability filter without weakening matching', () => {
    const codex = (command: TestCommand) => command.provider !== 'claude'
    const claude = (command: TestCommand) => command.provider !== 'codex'

    expect(filterComposerCommands(commands, '', codex).map(command => command.id)).toEqual([
      'chat', 'goal', 'model', 'reasoning', 'status'
    ])
    expect(filterComposerCommands(commands, '', claude).map(command => command.id)).toEqual([
      'chat', 'model', 'plan', 'reasoning', 'status'
    ])
    expect(matchComposerCommands('/go', 3, commands, claude)).toBeNull()
    expect(matchComposerCommands('/pl', 3, commands, claude)?.commands.map(command => command.id)).toEqual(['plan'])
  })
})

describe('groupComposerCommandsByCategory', () => {
  interface CategorizedCommand extends ComposerCommandMetadata {
    category?: string
  }

  const categories: readonly ComposerCommandCategory[] = [
    { id: 'agentsdock', heading: 'AgentsDock' },
    { id: 'skills', heading: 'Skills' }
  ]

  const categorized: readonly CategorizedCommand[] = [
    { id: 'model', label: 'Model', description: 'Choose a model', category: 'agentsdock' },
    { id: 'status', label: 'Status', description: 'Show chat status', category: 'agentsdock' },
    { id: 'import', label: 'Import Chat', description: 'Bring in local history', category: 'agentsdock' },
    { id: 'provider-0', label: 'Review code', description: 'Local provider skill', category: 'skills' }
  ]

  it('groups by category in declared order and preserves each command\'s flat index', () => {
    const groups = groupComposerCommandsByCategory(categorized, categories)
    expect(groups.map(group => group.id)).toEqual(['agentsdock', 'skills'])
    expect(groups[0].items.map(item => [item.command.id, item.index])).toEqual([
      ['model', 0],
      ['status', 1],
      ['import', 2]
    ])
    expect(groups[1].items.map(item => [item.command.id, item.index])).toEqual([
      ['provider-0', 3]
    ])
  })

  it('shows section headings only when more than one category is present', () => {
    const groups = groupComposerCommandsByCategory(categorized, categories)
    expect(groups.every(group => group.showHeading)).toBe(true)

    const onlyAgentsdock = categorized.filter(command => command.category === 'agentsdock')
    const singleGroup = groupComposerCommandsByCategory(onlyAgentsdock, categories)
    expect(singleGroup).toHaveLength(1)
    expect(singleGroup[0].showHeading).toBe(false)
  })

  it('falls back to the default category when a command has none, and to the raw id for an unknown category', () => {
    const uncategorized: readonly CategorizedCommand[] = [
      { id: 'legacy', label: 'Legacy', description: 'No category set' },
      { id: 'experimental', label: 'Experimental', description: 'Unknown category', category: 'labs' }
    ]
    const groups = groupComposerCommandsByCategory(uncategorized, categories)
    expect(groups.map(group => ({ id: group.id, heading: group.heading }))).toEqual([
      { id: 'agentsdock', heading: 'AgentsDock' },
      { id: 'labs', heading: 'labs' }
    ])
  })
})
