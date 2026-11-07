import type { CreateSessionInput, Health, RuntimeCatalog } from '../types'
import { chatBackendChoice, chatBackendSelection, selectableChatBackendChoices, type ChatBackendChoice } from './provider-selection'

export function chooseNewChatBackend(choices: readonly ChatBackendChoice[], preferred?: ChatBackendChoice,
  random: () => number = Math.random): ChatBackendChoice | undefined {
  if (preferred && choices.includes(preferred)) return preferred
  return choices.length ? choices[Math.floor(random() * choices.length)] : undefined
}

/** Retry only known pre-creation validation failures, never ambiguous writes. */
export function newChatRecoveryInput(input: CreateSessionInput, health: Health | null, runtime: RuntimeCatalog | null,
  status: number, message: string, attempted: readonly ChatBackendChoice[] = []): CreateSessionInput | null {
  const cwd = health?.default_cwd?.trim() || ''
  const invalidWorkspace = status === 400 && input.backend === 'gemini'
    && message === 'Gemini requires an existing workspace directory.'
  const missingApi = status === 409 && ['Connect this custom API in My Agents before creating a chat.', 'Connect a custom API first.'].includes(message)
  if (!invalidWorkspace && !missingApi) return null
  const excluded = new Set([...attempted, chatBackendChoice(input)])
  const choice = chooseNewChatBackend(selectableChatBackendChoices(health, runtime).filter(choice => !excluded.has(choice)))
  if (!choice) return null
  return { title: input.title, folder: input.folder, cwd, ...chatBackendSelection(choice), model: '', effort: '' }
}
