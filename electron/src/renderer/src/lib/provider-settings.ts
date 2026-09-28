import type { Backend } from '@shared/types'
import { useAppStore } from '../store/app-store'

/** One settings route for onboarding and recovery; never switches servers. */
export function openAIProviderSettings(backend?: Backend) {
  window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', {
    detail: { section: 'providers', backend },
  }))
  useAppStore.getState().setModal('appSettings', true)
}
