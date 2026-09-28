import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { ConfirmDeleteDialog } from './Dialogs'

const originalDelete = useAppStore.getState().deleteSession
afterEach(() => { cleanup(); setLocale('en'); useAppStore.setState({ deleteSession: originalDelete }) })

it.each([
  { locale: 'en' as const, title: 'Delete from AgentsDock?', button: 'Delete from AgentsDock', cancel: 'Cancel',
    description: '“Example” will be deleted from AgentsDock. Its history in the original agent will be kept.' },
  { locale: 'zh-CN' as const, title: '从 AgentsDock 删除？', button: '从 AgentsDock 删除', cancel: '取消',
    description: '“Example”将从 AgentsDock 删除，原始 Agent 中的会话历史会保留。' }
])('states the deletion scope and retained native history in $locale', async ({ locale, title, button, cancel, description }) => {
  setLocale(locale)
  const remove = vi.fn().mockResolvedValue(true)
  useAppStore.setState({ deleteSession: remove })
  render(<ConfirmDeleteDialog />)
  const open = () => act(() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-delete', {
    detail: { id: 'copy-test', title: 'Example', backend: 'codex' }
  })))
  open()
  expect(screen.getByRole('dialog', { name: title })).toHaveAccessibleDescription(description)
  fireEvent.click(screen.getByRole('button', { name: cancel }))
  expect(remove).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  open()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: button })))
  expect(remove).toHaveBeenCalledExactlyOnceWith('copy-test')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
