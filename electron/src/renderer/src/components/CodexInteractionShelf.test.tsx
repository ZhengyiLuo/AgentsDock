import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { CodexInteractionCard, ProviderInteractionCard, providerInteractionShelfLabel } from './CodexInteractionShelf'
import type { CodexInteraction } from './CodexRuntimeContext'

afterEach(() => {
  cleanup()
  setLocale('en')
  vi.restoreAllMocks()
})

describe('CodexInteractionCard', () => {
  it('uses approval language only when every pending interaction is an approval', () => {
    expect(providerInteractionShelfLabel('Codex', [
      interaction('item/commandExecution/requestApproval', {}),
      interaction('item/fileChange/requestApproval', {})
    ])).toBe('Codex is waiting for 2 approvals')
    expect(providerInteractionShelfLabel('Codex', [
      interaction('item/tool/requestUserInput', {})
    ])).toBe('Codex needs your input')
  })

  it('renders a command approval and sends the selected decision', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'git status',
        reason: 'Inspect the working tree'
      })}
      busy={false}
      onRespond={respond}
    />)

    expect(screen.getByRole('article', { name: 'Run this command?' })).toBeInTheDocument()
    expect(screen.getByText('git status')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve & run' }))
    expect(respond).toHaveBeenCalledWith({ decision: 'accept' })
  })

  it('shows network and sandbox scope and only offers available decisions', () => {
    render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'curl https://example.com',
        cwd: '/work/project',
        networkApprovalContext: { host: 'example.com', protocol: 'https', port: 443 },
        additionalPermissions: { filesystem: { read: ['/work/shared'] } },
        availableDecisions: ['accept']
      })}
      busy={false}
      onRespond={vi.fn().mockResolvedValue(undefined)}
    />)

    expect(screen.getByText('Allow this network access?')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('/work/project')).toBeInTheDocument()
    expect(screen.getByText('/work/shared', { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny access' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop turn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow for this session' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve access' })).toBeInTheDocument()
    expect(screen.getByText('Choose an available action to let Codex continue.')).toBeInTheDocument()
    expect(screen.queryByText(/Deny skips this action/)).not.toBeInTheDocument()
  })

  it('returns exact structured policy-amendment decisions advertised by app-server', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    const execDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['prefix_rule(pattern=["git", "status"], decision="allow")']
      }
    }
    const networkDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'api.example.com', action: 'allow' }
      }
    }
    const view = render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'curl https://api.example.com',
        networkApprovalContext: { host: 'api.example.com', protocol: 'https' },
        availableDecisions: ['decline', execDecision, networkDecision]
      })}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow and remember command rule' }))
    expect(respond).toHaveBeenLastCalledWith({ decision: execDecision })
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()

    view.unmount()
    render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'curl https://api.example.com',
        networkApprovalContext: { host: 'api.example.com', protocol: 'https' },
        availableDecisions: ['decline', networkDecision]
      })}
      busy={false}
      onRespond={respond}
    />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow and remember api.example.com' }))
    expect(respond).toHaveBeenLastCalledWith({ decision: networkDecision })
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Approve access' })).not.toBeInTheDocument()
  })

  it('does not invent policy-amendment decisions that app-server did not advertise', () => {
    render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'curl https://api.example.com',
        proposedExecpolicyAmendment: ['git', 'status'],
        proposedNetworkPolicyAmendments: [{ host: 'api.example.com', action: 'allow' }]
      })}
      busy={false}
      onRespond={vi.fn().mockResolvedValue(undefined)}
    />)

    expect(screen.queryByRole('button', { name: 'Allow and remember command rule' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow and remember api.example.com' })).not.toBeInTheDocument()
  })

  it('shows the proposed file changes before approval', () => {
    render(<CodexInteractionCard
      interaction={interaction('item/fileChange/requestApproval', {
        itemId: 'change-1',
        grantRoot: '/work/project',
        changes: [{ path: '/work/project/app.ts', kind: 'update', diff: '+safe change' }]
      })}
      busy={false}
      onRespond={vi.fn().mockResolvedValue(undefined)}
    />)

    expect(screen.getByText('Proposed file changes')).toBeInTheDocument()
    expect(screen.getByText('/work/project/app.ts', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('/work/project')).toBeInTheDocument()
  })

  it('shows legacy apply-patch fileChanges before approval', () => {
    render(<CodexInteractionCard
      interaction={interaction('applyPatchApproval', {
        conversationId: 'thread-1',
        callId: 'call-1',
        fileChanges: {
          '/work/project/app.ts': {
            type: 'update',
            unified_diff: '@@ -1 +1 @@\n-old\n+new'
          }
        }
      })}
      busy={false}
      onRespond={vi.fn().mockResolvedValue(undefined)}
    />)

    expect(screen.getByText('Proposed file changes')).toBeInTheDocument()
    expect(screen.getByText('/work/project/app.ts', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(/did not provide a patch preview/)).not.toBeInTheDocument()
  })

  it('collects structured answers without flattening question identifiers', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('item/tool/requestUserInput', {
        questions: [{
          id: 'deployment',
          header: 'Target',
          question: 'Where should this ship?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Beta', description: 'Publish to beta only.' },
            { label: 'Stable', description: 'Publish to everyone.' }
          ]
        }]
      })}
      busy={false}
      onRespond={respond}
    />)

    const question = screen.getByText('Where should this ship?')
    expect(question.closest('fieldset')?.firstElementChild?.tagName).toBe('LEGEND')
    await userEvent.setup().click(screen.getByRole('radio', { name: /Beta/ }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send answer' }))
    expect(respond).toHaveBeenCalledWith({
      answers: { deployment: { answers: ['Beta'] } }
    })
  })

  it('can skip an ask-user card with an empty answer map', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('item/tool/requestUserInput', {
        questions: [{ id: 'choice', question: 'Pick one', options: [{ label: 'A' }] }]
      })}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }))
    expect(respond).toHaveBeenCalledWith({ answers: {} })
  })

  it('does not submit an empty Other answer and sends custom text without a prefix', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('item/tool/requestUserInput', {
        questions: [{
          id: 'target',
          question: 'Where should this ship?',
          isOther: true,
          options: [{ label: 'Beta' }]
        }]
      })}
      busy={false}
      onRespond={respond}
    />)

    const send = screen.getByRole('button', { name: 'Send answer' })
    await userEvent.setup().click(screen.getByRole('radio', { name: /Other/ }))
    expect(send).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText('Other answer for Where should this ship?'), 'Internal ring')
    expect(send).toBeEnabled()
    await userEvent.setup().click(send)
    expect(respond).toHaveBeenCalledWith({
      answers: { target: { answers: ['Internal ring'] } }
    })
  })

  it('collects every selected option for a multi-select question', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<ProviderInteractionCard
      interaction={interaction('item/tool/requestUserInput', {
        questions: [{
          id: 'checks',
          question: 'Which checks should run?',
          multiSelect: true,
          options: [{ label: 'Tests' }, { label: 'Lint' }, { label: 'Build' }]
        }]
      })}
      providerName="Claude"
      busy={false}
      onRespond={respond}
    />)

    expect(screen.getByText('Claude has a question')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Tests' }))
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Build' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send answer' }))

    expect(respond).toHaveBeenCalledWith({
      answers: { checks: { answers: ['Tests', 'Build'] } }
    })
  })

  it('renders Claude tool metadata without calling every request a command', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<ProviderInteractionCard
      interaction={interaction('item/tool/requestApproval', {
        toolName: 'WebFetch',
        displayName: 'Fetch documentation',
        description: 'Read the official API reference.',
        toolInput: { url: 'https://docs.example.test' },
        availableDecisions: ['accept', 'decline']
      })}
      providerName="Claude"
      busy={false}
      onRespond={respond}
    />)

    expect(screen.getByText('Allow WebFetch?')).toBeInTheDocument()
    expect(screen.getByText('Claude wants to use WebFetch. It stays paused until you choose.')).toBeInTheDocument()
    expect(screen.getByText('What Claude is doing')).toBeInTheDocument()
    expect(screen.getByText('WebFetch input')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow WebFetch once' }))
    expect(respond).toHaveBeenCalledWith({ decision: 'accept' })
  })

  it('shows the exact Claude session permission scope before allowing it', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<ProviderInteractionCard
      interaction={interaction('item/fileChange/requestApproval', {
        toolName: 'Write',
        toolInput: { file_path: '/work/project/app.ts', content: 'safe' },
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
        permissionSuggestions: [{
          type: 'addDirectories',
          directories: ['/work/project'],
          destination: 'session'
        }]
      })}
      providerName="Claude"
      busy={false}
      onRespond={respond}
    />)

    const scope = screen.getByText('Claude session permission scope').closest('details')
    expect(scope).toHaveAttribute('open')
    expect(scope).toHaveTextContent('/work/project')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply shown permissions this session' }))
    expect(respond).toHaveBeenCalledWith({ decision: 'acceptForSession' })
  })

  it('locks a submitted decision until the interaction disappears and unlocks only on rejection', async () => {
    let resolveResponse!: () => void
    const pending = new Promise<void>(resolve => { resolveResponse = resolve })
    const respond = vi.fn().mockReturnValue(pending)
    const view = render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'git status',
        availableDecisions: ['accept', 'decline', 'cancel']
      })}
      busy={false}
      onRespond={respond}
    />)

    const approve = screen.getByRole('button', { name: 'Approve & run' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny command' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeDisabled()

    resolveResponse()
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()

    view.unmount()
    render(<CodexInteractionCard
      interaction={interaction('item/commandExecution/requestApproval', {
        command: 'git diff',
        availableDecisions: ['accept']
      })}
      busy={false}
      onRespond={vi.fn().mockRejectedValue(new Error('Approval failed'))}
    />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve & run' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve & run' })).toBeEnabled())
  })

  it('leads with the tool identity when a tool approval contains a nested command', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    const view = render(<ProviderInteractionCard
      interaction={interaction('item/tool/requestApproval', {
        toolName: 'Monitor',
        displayName: 'Monitor',
        description: 'Watch the 64-task fleet for failures and completion.',
        reason: 'A policy hook required confirmation.',
        toolInput: { command: 'monitor-fleet --tasks 64' },
        availableDecisions: ['accept', 'decline', 'cancel']
      })}
      providerName="Claude"
      busy={false}
      onRespond={respond}
    />)

    expect(screen.getByRole('article', { name: 'Allow Monitor?' })).toBeInTheDocument()
    expect(screen.queryByText('Run this command?')).not.toBeInTheDocument()
    expect(screen.getByText('What Claude is doing')).toBeInTheDocument()
    expect(screen.getByText('Why approval is required')).toBeInTheDocument()
    expect(screen.getByText('Command used by Monitor')).toBeInTheDocument()
    const actions = screen.getByRole('group', { name: 'Approval actions' })
    expect(actions).toBeInTheDocument()
    expect(screen.getByText('Claude is paused')).toBeInTheDocument()
    expect(screen.getByText(/Deny skips this action and lets Claude continue/)).toBeInTheDocument()
    const body = view.container.querySelector('.codex-approval-body')
    expect(body).toBeInTheDocument()
    expect(body).toContainElement(screen.getByText('monitor-fleet --tasks 64'))
    expect(body).not.toContainElement(actions)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop turn' }))
    expect(respond).toHaveBeenCalledWith({ decision: 'cancel' })
  })

  it('grants only the displayed permission subset and selected scope', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('item/permissions/requestApproval', {
        permissions: { filesystem: { read: ['/work/project'] } }
      })}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Grant duration' }), 'session')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Grant requested subset' }))
    expect(respond).toHaveBeenCalledWith({
      permissions: { filesystem: { read: ['/work/project'] } },
      scope: 'session',
      strictAutoReview: false
    })
  })

  it('renders an MCP schema as a form and submits typed content', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        title: 'Deployment details',
        message: 'The deployment tool needs a target.',
        requestedSchema: {
          type: 'object',
          required: ['environment'],
          properties: {
            environment: {
              type: 'string',
              title: 'Environment',
              enum: ['beta', 'stable']
            }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /Environment/ }), 'beta')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Share with tool' }))
    expect(respond).toHaveBeenCalledWith({ action: 'accept', content: { environment: 'beta' } })
  })

  it('preserves non-string MCP enum values', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: {
            attempts: { type: 'integer', title: 'Attempts', enum: [1, 2, 3] }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().selectOptions(
      screen.getByRole('combobox', { name: /Attempts/ }),
      screen.getByRole('option', { name: '2' })
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Share with tool' }))
    expect(respond).toHaveBeenCalledWith({ action: 'accept', content: { attempts: 2 } })
  })

  it('uses MCP defaults, required false booleans, and titled single-select values', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          required: ['enabled', 'target'],
          properties: {
            enabled: { type: 'boolean', title: 'Enabled' },
            target: {
              type: 'string',
              title: 'Target',
              default: 'beta',
              oneOf: [
                { const: 'beta', title: 'Beta ring' },
                { const: 'stable', title: 'Stable ring' }
              ]
            },
            attempts: { type: 'integer', title: 'Attempts', default: 2 }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()
    expect(screen.getByRole('option', { name: 'Beta ring' })).toHaveProperty('selected', true)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Share with tool' }))
    expect(respond).toHaveBeenCalledWith({
      action: 'accept',
      content: { enabled: false, target: 'beta', attempts: 2 }
    })
  })

  it('supports titled MCP multi-select fields and enforces item-count constraints', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        requestedSchema: {
          type: 'object',
          required: ['channels'],
          properties: {
            channels: {
              type: 'array',
              title: 'Channels',
              minItems: 2,
              maxItems: 2,
              items: {
                anyOf: [
                  { const: 'email', title: 'Email' },
                  { const: 'chat', title: 'Chat' }
                ]
              }
            }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    const submit = screen.getByRole('button', { name: 'Share with tool' })
    expect(submit).toBeDisabled()
    await userEvent.setup().selectOptions(screen.getByRole('listbox', { name: 'Channels' }), ['0', '1'])
    expect(submit).toBeEnabled()
    await userEvent.setup().click(submit)
    expect(respond).toHaveBeenCalledWith({
      action: 'accept',
      content: { channels: ['email', 'chat'] }
    })
  })

  it('enforces MCP numeric, length, and email constraints before sharing', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        requestedSchema: {
          type: 'object',
          required: ['count', 'contact'],
          properties: {
            count: { type: 'integer', title: 'Count', minimum: 2, maximum: 4 },
            contact: { type: 'string', title: 'Contact', format: 'email', minLength: 6, maxLength: 40 }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    const count = screen.getByRole('spinbutton', { name: 'Count' })
    const contact = screen.getByRole('textbox', { name: 'Contact' })
    const submit = screen.getByRole('button', { name: 'Share with tool' })
    expect(count).toHaveAttribute('min', '2')
    expect(count).toHaveAttribute('max', '4')
    await userEvent.setup().type(count, '1')
    await userEvent.setup().type(contact, 'invalid')
    expect(submit).toBeDisabled()
    await userEvent.setup().clear(count)
    await userEvent.setup().type(count, '3')
    await userEvent.setup().clear(contact)
    await userEvent.setup().type(contact, 'dev@example.com')
    expect(submit).toBeEnabled()
    await userEvent.setup().click(submit)
    expect(respond).toHaveBeenCalledWith({
      action: 'accept',
      content: { count: 3, contact: 'dev@example.com' }
    })
  })

  it('opens an MCP URL before enabling continuation', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    const openExternal = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { native: { openExternal } }
    })
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        mode: 'url',
        message: 'Sign in to Example',
        url: 'https://example.com/oauth'
      })}
      busy={false}
      onRespond={respond}
    />)

    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open authorization page' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/oauth')
    expect(continueButton).toBeEnabled()
    await userEvent.setup().click(continueButton)
    expect(respond).toHaveBeenCalledWith({ action: 'accept', content: {} })
  })

  it('preserves MCP form drafts across language changes and fresh runtime snapshots and resets for a new interaction', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    const params = {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', title: 'Name' }
        }
      }
    }
    const view = render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', params)}
      busy={false}
      onRespond={respond}
    />)

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Name' }), 'Draft value')
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft value')
    expect(respond).not.toHaveBeenCalled()
    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft value')
    view.rerender(<CodexInteractionCard
      interaction={{ ...interaction('mcpServer/elicitation/request', structuredClone(params)), created_at: new Date().toISOString() }}
      busy={false}
      onRespond={respond}
    />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft value')

    view.rerender(<CodexInteractionCard
      interaction={{
        ...interaction('mcpServer/elicitation/request', params),
        id: 'codexreq_2_test'
      }}
      busy={false}
      onRespond={respond}
    />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(''))
  })

  it('renders the native OpenAI image picker and returns the selected item id', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        mode: 'openai/form',
        message: 'Choose a template',
        requestedSchema: {
          type: 'object',
          required: ['template'],
          properties: {
            template: {
              type: 'openai/imagePicker',
              title: 'Template',
              items: [{
                id: 'monthly-review',
                title: 'Monthly review',
                image
              }]
            }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    const submit = screen.getByRole('button', { name: 'Share with tool' })
    expect(submit).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('radio', { name: /Monthly review/ }))
    expect(submit).toBeEnabled()
    await userEvent.setup().click(submit)
    expect(respond).toHaveBeenCalledWith({
      action: 'accept',
      content: { template: 'monthly-review' }
    })
  })

  it('provides a validated raw-JSON fallback for unknown OpenAI form fields', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<CodexInteractionCard
      interaction={interaction('mcpServer/elicitation/request', {
        mode: 'openai/form',
        message: 'Provide a future field',
        requestedSchema: {
          type: 'object',
          required: ['payload'],
          properties: {
            payload: { type: 'openai/futureField', title: 'Payload' }
          }
        }
      })}
      busy={false}
      onRespond={respond}
    />)

    const editor = screen.getByRole('textbox', { name: 'OpenAI form response JSON' })
    const submit = screen.getByRole('button', { name: 'Share with tool' })
    expect(submit).toBeDisabled()
    fireEvent.change(editor, { target: { value: '{"payload":{"x":1}}' } })
    expect(submit).toBeEnabled()
    await userEvent.setup().click(submit)
    expect(respond).toHaveBeenCalledWith({
      action: 'accept',
      content: { payload: { x: 1 } }
    })
  })
})

function interaction(method: string, params: Record<string, JsonValue>): CodexInteraction {
  return {
    id: 'codexreq_1_test',
    session_id: 'chat-1',
    thread_id: 'thread-1',
    method,
    params,
    created_at: new Date().toISOString()
  }
}
