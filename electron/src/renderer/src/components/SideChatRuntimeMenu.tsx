import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown } from 'lucide-react'
import { t } from '@shared/i18n'
import { runtimeBackendCatalogFor, runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeEffortOptions } from '@shared/runtime-catalog'
import type { Session } from '@shared/types'
import { runtimeLabel } from '../lib/format'
import { useAppStore } from '../store/app-store'

/** The ordinary Codex model/effort choices, scoped to the side conversation. */
export function SideChatRuntimeMenu({ session, model, effort, onChange }: {
  session: Session; model?: string; effort?: string
  onChange: (settings: { model?: string; effort: string }) => void
}) {
  const catalog = useAppStore(state => state.runtimeCatalog)
  const backend = runtimeBackendCatalogFor(catalog, session.backend, session.codex_provider, session.codex_provider_catalog)
  const models = runtimeCatalogOptions(catalog, session.backend, 'models', model, session.codex_provider, session.codex_provider_catalog)
    .filter(option => option.value || backend?.default_model)
  const efforts = runtimeEffortOptions(catalog, session.backend, model, effort, session.codex_provider, session.codex_provider_catalog)
  const label = runtimeLabel({ ...session, model, effort }, catalog)
  const selectModel = (value: string) => {
    const selected = value || backend?.default_model || undefined
    onChange({ model: selected, effort: runtimeEffortAfterModelChange(catalog, session.backend, selected ?? null,
      effort, session.codex_provider, session.codex_provider_catalog) ?? '' })
  }
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button type="button" className="runtime-chip side-chat-runtime-chip"
      aria-label={t('sideChat.runtimeSettings')} title={label}><span>{label}</span><ChevronDown size={13} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu-content runtime-menu side-chat-runtime-menu" side="top" align="start">
      <DropdownMenu.Label className="menu-label">{t('ui.Composer.RuntimeMenu.model_5e2c614')}</DropdownMenu.Label>
      {models.map(option => <DropdownMenu.CheckboxItem key={option.value || 'default'} className="menu-item"
        disabled={option.locked} title={option.locked ? option.locked_reason ?? undefined : undefined}
        checked={(model ?? '') === option.value} onCheckedChange={() => selectModel(option.value)}>{option.label}</DropdownMenu.CheckboxItem>)}
      {efforts.some(option => Boolean(option.value)) && <>
        <DropdownMenu.Separator className="menu-separator" />
        <DropdownMenu.Label className="menu-label">{t('sideChat.reasoning')}</DropdownMenu.Label>
        {efforts.map(option => <DropdownMenu.CheckboxItem key={option.value || 'default'} className="menu-item"
          checked={(effort ?? '') === option.value} onCheckedChange={() => onChange({ model: model || undefined, effort: option.value })}>{option.label}</DropdownMenu.CheckboxItem>)}
      </>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
