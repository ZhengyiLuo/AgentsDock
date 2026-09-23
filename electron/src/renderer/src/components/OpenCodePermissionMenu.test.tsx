import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, Session } from '@shared/types'
import { OpenCodePermissionMenu } from './OpenCodePermissionMenu'
import { useAppStore, interactiveClientCapabilities } from '../store/app-store'
import { backendLabel, runtimeLabel } from '../lib/format'
import { setLocale } from '@shared/i18n'

const session: Session = { id: 'open-chat', title: 'OpenCode chat', backend: 'opencode', opencode_permission_mode: 'default' }
const health: Health = { ok: true, capabilities: {
  opencode_backend: { available: true, required: false, action: null, version: 1, message: 'Supported' },
  local_provider_commands_v1: { available: true, required: false, action: null, version: 1, message: 'Skills', supported_backends: ['opencode'] }
} }

describe('OpenCode native permission and feature controls', () => {
  beforeEach(() => {
    setLocale('en')
    useAppStore.setState({ activeProfileId: 'profile', profileGeneration: 1, switchingProfileId: null,
      sessions: [session], health, activeSessionIds: new Set(), turnAdmissionTokens: {}, error: null,
      runtimeCatalog: { backends: { opencode: { available: true, models: [], efforts: [], permission_modes: ['default', 'full_access', 'plan'] } } } })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocale('en') })

  it('describes native settings truthfully and persists the requested mode through the store', async () => {
    const update = vi.fn(async (_id: string, patch: Partial<Session>) => ({ ...session, ...patch }))
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sessions: { update } } })
    function ConnectedMenu() {
      const current = useAppStore(state => state.sessions[0])
      return <OpenCodePermissionMenu session={current} running={false} open onOpenChange={vi.fn()} />
    }
    render(<ConnectedMenu />)
    expect(screen.getByRole('button', { name: 'OpenCode permissions: OpenCode settings' })).toBeEnabled()
    expect(screen.getByText(/may allow shell commands/)).toBeVisible()
    expect(screen.getByText('Changing permissions starts a fresh native OpenCode context. Visible chat history is kept.')).toBeVisible()
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(expect.stringContaining('Visible chat history is kept.'))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['OpenCode settings', 'Full access', 'Plan only'])
    await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'plan')
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { opencode_permission_mode: 'plan' }))
    expect(screen.getByText(/not an operating-system sandbox/)).toBeVisible()
    expect(screen.getByText(/fresh native OpenCode context/)).toBeVisible()
  })

  it('keeps existing OpenCode chats visibly unavailable on old servers', () => {
    useAppStore.setState({ health: { ok: true } })
    render(<OpenCodePermissionMenu session={session} running={false} />)
    const button = screen.getByRole('button', { name: 'OpenCode permissions: OpenCode settings' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('Update the server'))
  })

  it('localizes native permission policy', () => {
    setLocale('zh-CN')
    render(<OpenCodePermissionMenu session={session} running={false} open onOpenChange={vi.fn()} />)
    expect(screen.getByText(/可能允许运行 Shell 命令/)).toBeVisible()
    expect(screen.getByText('更改权限会重置 OpenCode 原生上下文，界面中的会话记录会保留。')).toBeVisible()
  })

  it('keeps policy viewable but forbids permission edits while a turn runs', () => {
    render(<OpenCodePermissionMenu session={session} running open onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'OpenCode permissions: OpenCode settings' })).toBeEnabled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByText('Stop or wait for this turn to finish before changing OpenCode permissions.')).toBeVisible()
  })

  it('advertises skills only for selected skill turns and never Codex or cross-chat capabilities', () => {
    expect(interactiveClientCapabilities(session, health)).toEqual([])
    expect(interactiveClientCapabilities(session, health, true)).toEqual(['opencode_provider_commands_v1'])
    expect(interactiveClientCapabilities(session, { ok: true }, true)).toEqual([])
    expect(backendLabel('opencode')).toBe('OpenCode')
    expect(runtimeLabel(session)).toBe('OpenCode default')
    expect(runtimeLabel({ ...session, effort: 'high' })).not.toContain('high')
  })

  it('rejects nonnative fork and external history import before IPC', async () => {
    const fork = vi.fn(), importHistory = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sessions: { fork, importHistory } } })
    await useAppStore.getState().forkSession(session.id)
    expect(fork).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/Native OpenCode session forking/)
    await useAppStore.getState().importHistory(session.id)
    expect(importHistory).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/history import is not supported/)
  })
})
