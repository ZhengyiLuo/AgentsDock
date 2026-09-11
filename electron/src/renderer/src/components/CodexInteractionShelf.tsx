// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  FilePenLine,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  TerminalSquare,
  X
} from 'lucide-react'
import type { JsonValue, ProviderPendingInteraction } from '@shared/types'
import {
  codexBridge,
  useCodexRuntime
} from './CodexRuntimeContext'
import './CodexControls.css'

export function CodexInteractionShelf() {
  useLocale()
  const { supported, loading, mutating, error, runtime, session, run } = useCodexRuntime()
  const [collapsed, setCollapsed] = useState(false)
  const interactions = runtime?.pending_interactions ?? []
  const interactionIdentity = interactions.map(interaction => interaction.id).join('\u0000')
  const shelfLabel = providerInteractionShelfLabel('Codex', interactions)

  useEffect(() => {
    if (interactions.length) setCollapsed(false)
  }, [interactionIdentity, interactions.length, session?.id])

  if (!supported || loading || !session || interactions.length === 0) return null

  return (
    <section className="codex-interaction-shelf" aria-label={shelfLabel}>
      <header>
        <div>
          <span className="codex-attention-dot" aria-hidden="true" />
          <strong>{shelfLabel}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("ui.CodexInteractionShelf.CodexInteractionShelf.show_requests_238b52a") : t("ui.CodexInteractionShelf.CodexInteractionShelf.hide_requests_87789d0")}
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </header>
      {!collapsed && <div className="codex-interaction-list">
        {error && <div className="codex-interaction-error" role="alert">{error}</div>}
        {interactions.map(interaction => <CodexInteractionCard
          key={interaction.id}
          interaction={interaction}
          busy={mutating}
          onRespond={response => run(async () => {
            const bridge = codexBridge()
            if (!bridge) throw new Error('This AgentsDock build does not expose Codex controls.')
            await bridge.resolveInteraction(session.id, interaction.id, response)
          })}
        />)}
      </div>}
    </section>
  )
}

export function providerInteractionShelfLabel(providerName: string, interactions: ProviderPendingInteraction[]): string {
  const approvalsOnly = interactions.length > 0 && interactions.every(interaction => (
    interaction.method.includes('requestApproval')
    || interaction.method === 'applyPatchApproval'
    || interaction.method === 'execCommandApproval'
  ))
  if (approvalsOnly) {
    return interactions.length === 1
      ? t("ui.CodexInteractionShelf.providerInteractionShelfLabel.is_waiting_for_approval_7a1fe66", { "provider": String(providerName) })
      : t("ui.CodexInteractionShelf.providerInteractionShelfLabel.is_waiting_for_approvals_251e576", { "provider": String(providerName), "count": String(interactions.length) })
  }
  return interactions.length === 1
    ? t("ui.CodexInteractionShelf.providerInteractionShelfLabel.needs_your_input_8f6162b", { "provider": String(providerName) })
    : t("ui.CodexInteractionShelf.providerInteractionShelfLabel.needs_responses_edf83ba", { "provider": String(providerName), "count": String(interactions.length) })
}

interface InteractionCardProps {
  interaction: ProviderPendingInteraction
  busy: boolean
  providerName?: string
  onRespond(response: Record<string, JsonValue>): Promise<unknown>
}

export function CodexInteractionCard(props: Omit<InteractionCardProps, 'providerName'>) {
  useLocale()
  return <ProviderInteractionCard {...props} providerName="Codex" />
}

export function ProviderInteractionCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const method = interaction.method
  const params = interaction.params ?? {}

  if (method === 'item/tool/requestUserInput') {
    return <AskUserCard interaction={interaction} busy={busy} providerName={providerName} onRespond={onRespond} />
  }
  if (method === 'item/permissions/requestApproval') {
    return <PermissionCard interaction={interaction} busy={busy} providerName={providerName} onRespond={onRespond} />
  }
  if (method === 'mcpServer/elicitation/request') {
    return <McpElicitationCard interaction={interaction} busy={busy} providerName={providerName} onRespond={onRespond} />
  }
  return <ApprovalCard interaction={interaction} busy={busy} providerName={providerName} onRespond={onRespond} />
}

function ApprovalCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const params = interaction.params
  const headingId = useId()
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const responseInFlight = useRef(false)
  useEffect(() => {
    responseInFlight.current = false
    setPendingAction(null)
  }, [interaction.id])
  const command = approvalCommand(params)
  const reason = stringValue(params.reason) || stringValue(params.message)
  const toolName = stringValue(params.toolName) || stringValue(params.name)
  const fileApproval = interaction.method.includes('fileChange')
    || interaction.method === 'applyPatchApproval'
    || ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)
  const legacy = interaction.method === 'applyPatchApproval' || interaction.method === 'execCommandApproval'
  const availableDecisions = arrayValue(params.availableDecisions)
  const decisionsSpecified = Array.isArray(params.availableDecisions)
  const allowed = (decision: string) => (
    !decisionsSpecified || availableDecisions.some(value => value === decision)
  )
  const availableExecAmendment = availableDecisions.find(value => (
    hasRecordKey(value, 'acceptWithExecpolicyAmendment')
  ))
  const execAmendmentDecision = availableExecAmendment ?? null
  const availableNetworkAmendments = availableDecisions.filter(value => (
    hasRecordKey(value, 'applyNetworkPolicyAmendment')
  ))
  const networkAmendmentDecisions = availableNetworkAmendments
  const networkContext = recordValue(params.networkApprovalContext)
  const networkHost = stringValue(networkContext.host)
  const networkProtocol = stringValue(networkContext.protocol)
  const networkPort = numberOrStringValue(networkContext.port)
  const networkApproval = Object.keys(networkContext).length > 0
  const additionalPermissions = recordValue(params.additionalPermissions)
  const permissionSuggestions = arrayValue(params.permissionSuggestions)
  const approvalItem = recordValue(params.approvalItem)
  const proposedChanges = params.changes ?? params.fileChanges ?? approvalItem.changes
  const hasProposedChanges = Array.isArray(proposedChanges)
    ? proposedChanges.length > 0
    : Object.keys(recordValue(proposedChanges)).length > 0
  const cwd = stringValue(params.cwd)
  const grantRoot = stringValue(params.grantRoot)
  const toolInput = recordValue(params.toolInput)
  const displayName = stringValue(params.displayName) || stringValue(params.title) || toolName
  const description = stringValue(params.description)
  const toolApproval = interaction.method === 'item/tool/requestApproval' && Boolean(toolName || displayName)
  const responding = busy || pendingAction !== null
  const respond = (response: Record<string, JsonValue>, action = 'respond') => {
    if (busy || responseInFlight.current) return
    responseInFlight.current = true
    setPendingAction(action)
    void Promise.resolve()
      .then(() => onRespond(response))
      .catch(() => {
        responseInFlight.current = false
        setPendingAction(current => current === action ? null : current)
      })
  }
  const decide = (decision: string) => respond({ decision }, decision)
  const title = fileApproval
    ? 'Apply these file changes?'
    : networkApproval
      ? 'Allow this network access?'
      : toolApproval
        ? `Allow ${toolName || displayName}?`
        : command
          ? 'Run this command?'
          : displayName
            ? `Allow ${displayName}?`
            : 'Allow this action?'
  const subtitle = fileApproval
    ? `Review the proposed changes. ${providerName} stays paused until you choose.`
    : networkApproval
      ? `Review access to ${networkTargetLabel(networkHost, networkProtocol, networkPort)}. ${providerName} stays paused until you choose.`
      : toolApproval
        ? `${providerName} wants to use ${toolName || displayName}. It stays paused until you choose.`
        : command
          ? `Review the command below. ${providerName} stays paused until you choose.`
          : `${providerName} wants to use ${displayName || 'this tool'}. It stays paused until you choose.`
  const approveLabel = fileApproval
    ? 'Approve changes'
    : networkApproval
      ? 'Approve access'
      : toolApproval
        ? `Allow ${toolName || displayName} once`
        : command
          ? 'Approve & run'
          : 'Approve once'
  const declineLabel = fileApproval
    ? 'Reject changes'
    : networkApproval
      ? 'Deny access'
      : command && !toolApproval
        ? 'Deny command'
        : 'Deny action'
  const canDecline = legacy || allowed('decline')
  const canCancel = !legacy && allowed('cancel')
  const sessionApprovalLabel = permissionSuggestions.length > 0
    ? 'Apply shown permissions this session'
    : 'Allow for this session'
  const footerGuidance = canDecline && canCancel
    ? `Deny skips this action and lets ${providerName} continue. Stop turn ends the current turn.`
    : canDecline
      ? `Deny skips this action and lets ${providerName} continue.`
      : canCancel
        ? 'Stop turn ends the current turn.'
        : `Choose an available action to let ${providerName} continue.`

  return <article
    className="codex-interaction-card approval"
    data-method={interaction.method}
    aria-labelledby={headingId}
    aria-busy={responding}
  >
    <CardHeading
      icon={fileApproval ? <FilePenLine size={17} /> : <TerminalSquare size={17} />}
      title={title}
      titleId={headingId}
      subtitle={subtitle}
      interaction={interaction}
      providerName={providerName}
    />
    <div className="codex-approval-body">
      {networkApproval && <div className="codex-request-scope" aria-label={t("ui.CodexInteractionShelf.ApprovalCard.requested_network_access_69911cb")}>
        <strong>{networkHost || t("ui.CodexInteractionShelf.ApprovalCard.unknown_host_a619fe4")}</strong>
        <span>{[networkProtocol, networkPort ? t("ui.CodexInteractionShelf.ApprovalCard.port_36b1e9c", { "port": String(networkPort) }) : ''].filter(Boolean).join(' · ') || t("ui.CodexInteractionShelf.ApprovalCard.managed_network_access_28b56e4")}</span>
      </div>}
      {description && description !== reason && <section className="codex-approval-explanation">
        <strong>What {providerName}{" "}{t("ui.CodexInteractionShelf.ApprovalCard.is_doing_e3673d0")}</strong>
        <p>{description}</p>
      </section>}
      {reason && <section className="codex-approval-explanation">
        <strong>{t("ui.CodexInteractionShelf.ApprovalCard.why_approval_is_required_299d0c9")}</strong>
        <p>{reason}</p>
      </section>}
      {command && <section className="codex-approval-detail">
        <strong>{toolApproval ? t("ui.CodexInteractionShelf.ApprovalCard.command_used_by_d7b5840", { "tool": String(toolName || displayName) }) : t("ui.CodexInteractionShelf.ApprovalCard.command_to_run_3d73027")}</strong>
        <pre className="codex-request-command">{command}</pre>
      </section>}
      {fileApproval && hasProposedChanges && <JsonDetails
        value={proposedChanges as JsonValue}
        label={t("ui.CodexInteractionShelf.ApprovalCard.proposed_file_changes_30f1dc5")}
        open
      />}
      {fileApproval && !hasProposedChanges && Object.keys(toolInput).length > 0 && <JsonDetails
        value={toolInput}
        label={t("ui.CodexInteractionShelf.ApprovalCard.requested_file_operation_9f538fa")}
        open
      />}
      {fileApproval && !hasProposedChanges && Object.keys(toolInput).length === 0 && <p className="codex-request-warning" role="alert">
        {providerName}{" "}{t("ui.CodexInteractionShelf.ApprovalCard.did_not_provide_a_patch_preview_review_the_501ec73")}</p>}
      {(cwd || grantRoot) && <dl className="codex-request-paths">
        {cwd && <><dt>{t("ui.CodexInteractionShelf.ApprovalCard.working_directory_865e85c")}</dt><dd>{cwd}</dd></>}
        {grantRoot && <><dt>{t("ui.CodexInteractionShelf.ApprovalCard.requested_write_root_85dbbf5")}</dt><dd>{grantRoot}</dd></>}
      </dl>}
      {Object.keys(additionalPermissions).length > 0 && <JsonDetails
        value={additionalPermissions}
        label={t("ui.CodexInteractionShelf.ApprovalCard.additional_sandbox_permissions_835992c")}
        open
      />}
      {permissionSuggestions.length > 0 && <JsonDetails
        value={permissionSuggestions}
        label={t("ui.CodexInteractionShelf.ApprovalCard.session_permission_scope_2613505", { "provider": String(providerName) })}
        open
      />}
      {!command && !networkApproval && !fileApproval && <JsonDetails
        value={Object.keys(toolInput).length > 0 ? toolInput : params}
        label={toolName ? t("ui.CodexInteractionShelf.ApprovalCard.input_f395b71", { "tokens": String(toolName) }) : t("ui.CodexInteractionShelf.ApprovalCard.request_details_b6e3369")}
      />}
      {(execAmendmentDecision || networkAmendmentDecisions.length > 0) && <div className="codex-policy-amendments">
        <strong>{t("ui.CodexInteractionShelf.ApprovalCard.optional_policy_changes_61f52a8")}</strong>
        {execAmendmentDecision && <button
          type="button"
          className="quiet-button"
          disabled={responding}
          onClick={() => respond({ decision: execAmendmentDecision }, 'exec-policy')}
        >{pendingAction === 'exec-policy' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} {pendingAction === 'exec-policy' ? t("ui.CodexInteractionShelf.ApprovalCard.applying_3329a9b") : t("ui.CodexInteractionShelf.ApprovalCard.allow_and_remember_command_rule_a8d4373")}</button>}
        {networkAmendmentDecisions.map((decision, index) => {
          const body = recordValue(recordValue(decision).applyNetworkPolicyAmendment)
          const amendment = recordValue(body.network_policy_amendment)
          const host = stringValue(amendment.host) || networkHost || 'host'
          const action = stringValue(amendment.action)
          return <button
            key={`${index}:${JSON.stringify(decision)}`}
            type="button"
            className={`quiet-button${action === 'deny' ? ' codex-decline' : ''}`}
            disabled={responding}
            onClick={() => respond({ decision }, `network-policy-${index}`)}
          >{pendingAction === `network-policy-${index}` ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} {pendingAction === `network-policy-${index}` ? t("ui.CodexInteractionShelf.applying_3329a9b") : action === 'deny' ? t("ui.CodexInteractionShelf.deny_and_remember_9ed3f6f", { "host": String(host) }) : t("ui.CodexInteractionShelf.allow_and_remember_b5043fb", { "host": String(host) })}</button>
        })}
      </div>}
    </div>
    <footer className="codex-approval-footer">
      <p className="codex-approval-status">
        <strong>{providerName} is paused</strong>
        <span>{footerGuidance}</span>
      </p>
      <div className="codex-card-actions" role="group" aria-label={t("ui.CodexInteractionShelf.ApprovalCard.approval_actions_ee07e88")}>
        {canDecline && <button
          type="button"
          className="quiet-button codex-decline"
          disabled={responding}
          onClick={() => decide(legacy ? 'denied' : 'decline')}
        >{pendingAction === (legacy ? 'denied' : 'decline') ? <LoaderCircle className="spin" size={14} /> : <X size={14} />} {pendingAction === (legacy ? 'denied' : 'decline') ? t("ui.CodexInteractionShelf.ApprovalCard.denying_a3830dd") : declineLabel}</button>}
        {canCancel && <button
          type="button"
          className="quiet-button"
          disabled={responding}
          onClick={() => decide('cancel')}
        >{pendingAction === 'cancel' && <LoaderCircle className="spin" size={14} />} {pendingAction === 'cancel' ? t("ui.CodexInteractionShelf.ApprovalCard.stopping_bbe8574") : t("ui.CodexInteractionShelf.ApprovalCard.stop_turn_5763890")}</button>}
        {allowed('acceptForSession') && !legacy && <button
          type="button"
          className="quiet-button"
          disabled={responding}
          title={permissionSuggestions.length > 0
            ? t("ui.CodexInteractionShelf.ApprovalCard.apply_the_displayed_provider_permission_ch_3daf88c")
            : t("ui.CodexInteractionShelf.ApprovalCard.allow_this_request_scope_until_the_session_6257b5d", { "provider": String(providerName) })}
          onClick={() => decide('acceptForSession')}
        >{pendingAction === 'acceptForSession' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} {pendingAction === 'acceptForSession' ? t("ui.CodexInteractionShelf.ApprovalCard.applying_3329a9b") : sessionApprovalLabel}</button>}
        {(legacy || allowed('accept')) && <button
          type="button"
          className="primary-button"
          disabled={responding}
          onClick={() => decide(legacy ? 'approved' : 'accept')}
        >{pendingAction === (legacy ? 'approved' : 'accept') ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {pendingAction === (legacy ? 'approved' : 'accept') ? t("ui.CodexInteractionShelf.ApprovalCard.approving_e99dcb0") : approveLabel}</button>}
      </div>
    </footer>
  </article>
}

interface AskQuestion {
  id: string
  header?: string
  question: string
  isOther?: boolean
  isSecret?: boolean
  multiSelect?: boolean
  options: Array<{ label: string; description?: string }>
}

function AskUserCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const questions = useMemo(() => parseQuestions(interaction.params.questions), [interaction.params.questions])
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({})
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({})
  useEffect(() => {
    setAnswers({})
    setOtherSelected({})
    setTextAnswers({})
  }, [interaction.id])
  const answerValues = (question: AskQuestion): string[] => {
    if (question.options.length === 0) {
      const answer = textAnswers[question.id]?.trim()
      return answer ? [answer] : []
    }
    const selected = (answers[question.id] ?? []).map(answer => answer.trim()).filter(Boolean)
    const other = otherSelected[question.id] ? textAnswers[question.id]?.trim() : ''
    return other ? [...selected, other] : selected
  }
  const hasAnswer = (question: AskQuestion) => answerValues(question).length > 0
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (questions.some(question => !hasAnswer(question))) return
    const responseAnswers: Record<string, JsonValue> = {}
    for (const question of questions) {
      const values = answerValues(question)
      if (values.length) responseAnswers[question.id] = { answers: values }
    }
    void onRespond({ answers: responseAnswers }).catch(() => undefined)
  }

  return <article className="codex-interaction-card question" data-method={interaction.method}>
    <CardHeading
      icon={<MessageSquareText size={17} />}
      title={t("ui.CodexInteractionShelf.AskUserCard.has_a_question_cff2d22", { "provider": String(providerName) })}
      subtitle="Your answer is sent directly to the active turn."
      interaction={interaction}
      providerName={providerName}
    />
    <form className="codex-question-form" onSubmit={submit}>
      {questions.map(question => <fieldset key={question.id}>
        <legend>{question.question}</legend>
        {question.header && <span className="codex-question-header">{question.header}</span>}
        {question.options.length > 0
          ? <div className="codex-answer-options">
            {question.options.map(option => <label key={option.label}>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`codex-question-${interaction.id}-${question.id}`}
                value={option.label}
                checked={(answers[question.id] ?? []).includes(option.label)}
                onChange={event => {
                  if (!question.multiSelect) {
                    setOtherSelected(current => ({ ...current, [question.id]: false }))
                    setAnswers(current => ({ ...current, [question.id]: [option.label] }))
                    return
                  }
                  setAnswers(current => {
                    const selected = current[question.id] ?? []
                    return {
                      ...current,
                      [question.id]: event.target.checked
                        ? [...selected, option.label]
                        : selected.filter(value => value !== option.label)
                    }
                  })
                }}
              />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>)}
            {question.isOther && <label>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`codex-question-${interaction.id}-${question.id}`}
                checked={otherSelected[question.id] === true}
                onChange={event => {
                  const selected = question.multiSelect ? event.target.checked : true
                  setOtherSelected(current => ({ ...current, [question.id]: selected }))
                  if (!question.multiSelect) setAnswers(current => ({ ...current, [question.id]: [] }))
                }}
              />
              <span className="codex-other-answer">
                <strong>{t("ui.CodexInteractionShelf.other_f97e9da")}</strong>
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  aria-label={t("ui.CodexInteractionShelf.other_answer_for_659dc6e", { "question": String(question.question) })}
                  autoComplete="off"
                  value={otherSelected[question.id] ? textAnswers[question.id] ?? '' : ''}
                  onFocus={() => {
                    if (!question.multiSelect) setAnswers(current => ({ ...current, [question.id]: [] }))
                    setOtherSelected(current => ({ ...current, [question.id]: true }))
                  }}
                  onChange={event => {
                    setOtherSelected(current => ({ ...current, [question.id]: true }))
                    setTextAnswers(current => ({ ...current, [question.id]: event.target.value }))
                  }}
                />
              </span>
            </label>}
          </div>
          : <input
            className="codex-free-answer"
            type={question.isSecret ? 'password' : 'text'}
            aria-label={t("ui.CodexInteractionShelf.answer_for_d4c1fb4", { "question": String(question.question) })}
            autoComplete="off"
            value={textAnswers[question.id] ?? ''}
            onChange={event => setTextAnswers(current => ({ ...current, [question.id]: event.target.value }))}
          />}
      </fieldset>)}
      {questions.length === 0 && <JsonDetails value={interaction.params} label={t("ui.CodexInteractionShelf.AskUserCard.question_details_86d7826")} />}
      <div className="codex-card-actions">
        <AutoResolveNotice interaction={interaction} providerName={providerName} />
        <button
          type="button"
          className="quiet-button"
          disabled={busy}
          onClick={() => void onRespond({ answers: {} }).catch(() => undefined)}
        >{t("ui.CodexInteractionShelf.AskUserCard.skip_28d0359")}</button>
        <button type="submit" className="primary-button" disabled={busy || questions.some(question => !hasAnswer(question))}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{" "}{t("ui.CodexInteractionShelf.AskUserCard.send_answer_1873707")}</button>
      </div>
    </form>
  </article>
}

function PermissionCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const requested = recordValue(interaction.params.permissions)
  const cwd = stringValue(interaction.params.cwd)
  const environmentId = stringValue(interaction.params.environmentId)
  const reason = stringValue(interaction.params.reason)
  const [scope, setScope] = useState<'turn' | 'session'>('turn')
  const respond = (accepted: boolean) => void onRespond({
    permissions: accepted ? requested : {},
    scope,
    strictAutoReview: false
  }).catch(() => undefined)
  return <article className="codex-interaction-card permission" data-method={interaction.method}>
    <CardHeading
      icon={<KeyRound size={17} />}
      title={t("ui.CodexInteractionShelf.PermissionCard.grant_additional_permissions_0b25288")}
      subtitle={`${providerName} requested access beyond the current permission profile.`}
      interaction={interaction}
      providerName={providerName}
    />
    {reason && <p className="codex-request-reason">{reason}</p>}
    {(cwd || environmentId) && <dl className="codex-request-paths">
      {cwd && <><dt>{t("ui.CodexInteractionShelf.PermissionCard.working_directory_865e85c")}</dt><dd>{cwd}</dd></>}
      {environmentId && <><dt>{t("ui.CodexInteractionShelf.PermissionCard.environment_9e47195")}</dt><dd>{environmentId}</dd></>}
    </dl>}
    <JsonDetails value={requested} label={t("ui.CodexInteractionShelf.PermissionCard.requested_permissions_416379f")} open />
    <label className="codex-inline-field">
      <span>{t("ui.CodexInteractionShelf.PermissionCard.grant_duration_43deb75")}</span>
      <select value={scope} onChange={event => setScope(event.target.value as 'turn' | 'session')}>
        <option value="turn">{t("ui.CodexInteractionShelf.PermissionCard.this_turn_only_97ef5f9")}</option>
        <option value="session">This {providerName} session</option>
      </select>
    </label>
    <div className="codex-card-actions">
      <button type="button" className="quiet-button codex-decline" disabled={busy} onClick={() => respond(false)}><X size={14} />{" "}{t("ui.CodexInteractionShelf.PermissionCard.deny_05a2d73")}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => respond(true)}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}{" "}{t("ui.CodexInteractionShelf.PermissionCard.grant_requested_subset_6185a87")}</button>
    </div>
  </article>
}

function McpElicitationCard(props: InteractionCardProps) {
  useLocale()
  const { interaction } = props
  if (stringValue(interaction.params.mode) === 'url') {
    return <McpUrlElicitationCard {...props} />
  }
  return <McpFormElicitationCard {...props} />
}

function McpFormElicitationCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const params = interaction.params
  const snapshot = useMemo(() => mcpFormSnapshot(interaction), [interaction.id])
  const { properties, required, initialContent, rawFallback } = snapshot
  const [content, setContent] = useState<Record<string, JsonValue>>(initialContent)
  const [rawContent, setRawContent] = useState(() => JSON.stringify(initialContent, null, 2))
  const [rawError, setRawError] = useState<string | null>(null)
  useEffect(() => {
    setContent(initialContent)
    setRawContent(JSON.stringify(initialContent, null, 2))
    setRawError(null)
  }, [initialContent, interaction.id])
  const valid = rawFallback
    ? rawError === null && openAiRawContentIsValid(snapshot.schema, content)
    : mcpContentIsValid(properties, required, content)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    void onRespond({ action: 'accept', content }).catch(() => undefined)
  }
  return <article className="codex-interaction-card elicitation" data-method={interaction.method}>
    <CardHeading
      icon={<MessageSquareText size={17} />}
      title={stringValue(params.title) || t("ui.CodexInteractionShelf.McpFormElicitationCard.connected_tool_needs_input_03eb311")}
      subtitle={stringValue(params.message) || 'Review the request before sharing this information.'}
      interaction={interaction}
      providerName={providerName}
    />
    <form className="codex-elicitation-form" onSubmit={submit}>
      {rawFallback
        ? <>
          <p className="codex-request-warning" role="status">{t("ui.CodexInteractionShelf.McpFormElicitationCard.this_openai_form_contains_a_field_type_thi_b962606")}</p>
          <label>
            <span>{t("ui.CodexInteractionShelf.McpFormElicitationCard.openai_form_response_json_60cca89")}</span>
            <textarea
              aria-label={t("ui.CodexInteractionShelf.McpFormElicitationCard.openai_form_response_json_60cca89")}
              rows={7}
              spellCheck={false}
              value={rawContent}
              onChange={event => {
                const nextRaw = event.target.value
                setRawContent(nextRaw)
                try {
                  const parsed = JSON.parse(nextRaw) as JsonValue
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setRawError('The response must be a JSON object.')
                    return
                  }
                  setContent(parsed)
                  setRawError(null)
                } catch {
                  setRawError('Enter valid JSON.')
                }
              }}
            />
            {rawError && <small className="codex-field-error" role="alert">{rawError}</small>}
          </label>
          <JsonDetails value={snapshot.schema} label={t("ui.CodexInteractionShelf.McpFormElicitationCard.openai_form_schema_8fb76b8")} />
        </>
        : Object.entries(properties).map(([name, rawDefinition]) => {
          const definition = recordValue(rawDefinition)
          return <McpFormField
            key={name}
            fieldGroupId={`${interaction.id}-${name}`}
            name={name}
            definition={definition}
            required={required.has(name)}
            value={content[name]}
            onChange={value => setContent(current => (
              value === undefined
                ? omitRecordKey(current, name)
                : { ...current, [name]: value }
            ))}
          />
        })}
      {!rawFallback && Object.keys(properties).length === 0 && <JsonDetails value={params} label={t("ui.CodexInteractionShelf.McpFormElicitationCard.tool_request_e20f875")} open />}
      <div className="codex-card-actions">
        <button type="button" className="quiet-button codex-decline" disabled={busy} onClick={() => void onRespond({ action: 'decline' }).catch(() => undefined)}><X size={14} />{" "}{t("ui.CodexInteractionShelf.McpFormElicitationCard.decline_a2d285b")}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void onRespond({ action: 'cancel' }).catch(() => undefined)}>{t("ui.CodexInteractionShelf.McpFormElicitationCard.cancel_turn_a0bf577")}</button>
        <button type="submit" className="primary-button" disabled={busy || !valid}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{" "}{t("ui.CodexInteractionShelf.McpFormElicitationCard.share_with_tool_655d6ec")}</button>
      </div>
    </form>
  </article>
}

interface McpFormFieldProps {
  fieldGroupId: string
  name: string
  definition: Record<string, JsonValue>
  required: boolean
  value: JsonValue | undefined
  onChange(value: JsonValue | undefined): void
}

interface McpSelectOption {
  value: JsonValue
  label: string
}

interface OpenAiImagePickerItem {
  id: string
  title: string
  image: string
}

interface McpFormSnapshot {
  schema: Record<string, JsonValue>
  properties: Record<string, JsonValue>
  required: Set<string>
  initialContent: Record<string, JsonValue>
  rawFallback: boolean
}

function McpFormField({ fieldGroupId, name, definition, required, value, onChange }: McpFormFieldProps) {
  useLocale()
  const type = stringValue(definition.type)
  const format = stringValue(definition.format)
  const label = stringValue(definition.title) || sentenceCase(name)
  const description = stringValue(definition.description)
  const singleOptions = mcpSingleSelectOptions(definition)
  const multiOptions = mcpMultiSelectOptions(definition)
  const minItems = nonNegativeInteger(definition.minItems)
  const maxItems = nonNegativeInteger(definition.maxItems)
  const minLength = nonNegativeInteger(definition.minLength)
  const maxLength = nonNegativeInteger(definition.maxLength)
  const minimum = finiteNumber(definition.minimum)
  const maximum = finiteNumber(definition.maximum)
  const invalid = !mcpFieldValueIsValid(definition, value, required)
  const imagePickerItems = openAiImagePickerItems(definition)

  if (type === 'openai/imagePicker' && imagePickerItems.length > 0) {
    return <fieldset className="codex-image-picker" aria-invalid={invalid}>
      <legend>{label}{required && <b aria-label="required">*</b>}</legend>
      {description && <small>{description}</small>}
      <div role="radiogroup" aria-label={label} aria-required={required}>
        {imagePickerItems.map(item => <label key={item.id}>
          <input
            type="radio"
            name={`codex-openai-image-picker-${fieldGroupId}`}
            value={item.id}
            checked={value === item.id}
            onChange={() => onChange(item.id)}
          />
          {item.image && safeInlineImageUrl(item.image)
            ? <img src={item.image} alt="" />
            : <span className="codex-image-picker-placeholder" aria-hidden="true" />}
          <span><strong>{item.title}</strong><small>{item.id}</small></span>
        </label>)}
      </div>
    </fieldset>
  }

  return <label>
    <span>{label}{required && <b aria-label="required">*</b>}</span>
    {description && <small>{description}</small>}
    {type === 'array' && multiOptions.length > 0
      ? <select
        aria-label={label}
        aria-invalid={invalid}
        aria-required={required}
        multiple
        size={Math.min(8, Math.max(3, multiOptions.length))}
        value={multiSelectionIndices(multiOptions, value)}
        onChange={event => {
          const selected = Array.from(event.currentTarget.selectedOptions).flatMap(option => {
            const index = Number.parseInt(option.value, 10)
            return Number.isInteger(index) && index >= 0 && index < multiOptions.length
              ? [multiOptions[index].value]
              : []
          })
          onChange(selected)
        }}
      >{multiOptions.map((option, index) => <option key={`${index}:${JSON.stringify(option.value)}`} value={String(index)}>{option.label}</option>)}</select>
      : singleOptions.length > 0
        ? <select
          aria-label={label}
          aria-invalid={invalid}
          aria-required={required}
          required={required}
          value={enumSelectionIndex(singleOptions.map(option => option.value), value)}
          onChange={event => {
            const index = Number.parseInt(event.target.value, 10)
            onChange(
              Number.isInteger(index) && index >= 0 && index < singleOptions.length
                ? singleOptions[index].value
                : undefined
            )
          }}
        ><option value="">{t("ui.CodexInteractionShelf.McpFormField.select_731fe04")}</option>{singleOptions.map((option, index) => <option key={`${index}:${JSON.stringify(option.value)}`} value={String(index)}>{option.label}</option>)}</select>
        : type === 'boolean'
          ? <span className="codex-boolean-field">
            <input
              aria-label={label}
              aria-invalid={invalid}
              aria-required={required}
              type="checkbox"
              checked={value === true}
              onChange={event => onChange(event.target.checked)}
            />
            <small>{value === true ? t("ui.CodexInteractionShelf.McpFormField.enabled_92c1cdf") : 'Disabled'}</small>
          </span>
          : <input
            aria-label={label}
            aria-invalid={invalid}
            aria-required={required}
            type={mcpInputType(definition)}
            autoComplete="off"
            min={minimum}
            max={maximum}
            minLength={minLength}
            maxLength={maxLength}
            step={type === 'integer' ? 1 : type === 'number' ? 'any' : undefined}
            pattern={format === 'date-time' ? DATE_TIME_PATTERN : undefined}
            placeholder={format === 'date-time' ? '2026-07-28T12:00:00Z' : undefined}
            value={String(value ?? '')}
            onChange={event => {
              if ((type === 'number' || type === 'integer') && event.target.value === '') {
                onChange(undefined)
                return
              }
              onChange(type === 'number' || type === 'integer'
                ? Number(event.target.value)
                : event.target.value)
            }}
          />}
    <McpConstraintHint
      definition={definition}
      minItems={minItems}
      maxItems={maxItems}
      minLength={minLength}
      maxLength={maxLength}
      minimum={minimum}
      maximum={maximum}
    />
  </label>
}

function McpConstraintHint({
  definition,
  minItems,
  maxItems,
  minLength,
  maxLength,
  minimum,
  maximum
}: {
  definition: Record<string, JsonValue>
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}) {
  useLocale()
  const hints = [
    minItems !== undefined ? `Choose at least ${minItems}` : '',
    maxItems !== undefined ? `Choose at most ${maxItems}` : '',
    minLength !== undefined ? `Minimum ${minLength} characters` : '',
    maxLength !== undefined ? `Maximum ${maxLength} characters` : '',
    minimum !== undefined ? `Minimum ${minimum}` : '',
    maximum !== undefined ? `Maximum ${maximum}` : '',
    stringValue(definition.format) ? `Format: ${stringValue(definition.format)}` : ''
  ].filter(Boolean)
  return hints.length > 0 ? <small className="codex-constraint-hint">{hints.join(' · ')}</small> : null
}

function McpUrlElicitationCard({ interaction, busy, providerName = 'Codex', onRespond }: InteractionCardProps) {
  useLocale()
  const params = interaction.params
  const url = stringValue(params.url)
  const safeUrl = isSafeExternalUrl(url)
  const [opened, setOpened] = useState(false)
  const open = async () => {
    if (!safeUrl) return
    await window.agentsDock.native.openExternal(url)
    setOpened(true)
  }
  return <article className="codex-interaction-card elicitation" data-method={interaction.method}>
    <CardHeading
      icon={<KeyRound size={17} />}
      title={stringValue(params.title) || t("ui.CodexInteractionShelf.McpUrlElicitationCard.connected_tool_needs_authorization_ba55610")}
      subtitle={stringValue(params.message) || 'Open the authorization page, then continue this turn.'}
      interaction={interaction}
      providerName={providerName}
    />
    <div className="codex-request-scope" aria-label={t("ui.CodexInteractionShelf.McpUrlElicitationCard.authorization_url_c70b5f2")}>
      <strong>{safeUrl ? url : t("ui.CodexInteractionShelf.McpUrlElicitationCard.invalid_authorization_url_565d4ea")}</strong>
    </div>
    {!safeUrl && <p className="codex-request-warning" role="alert">{t("ui.CodexInteractionShelf.McpUrlElicitationCard.only_https_or_http_authorization_links_can_5c5daa9")}</p>}
    <div className="codex-card-actions">
      <button type="button" className="quiet-button codex-decline" disabled={busy} onClick={() => void onRespond({ action: 'decline', content: null }).catch(() => undefined)}><X size={14} />{" "}{t("ui.CodexInteractionShelf.McpUrlElicitationCard.decline_a2d285b")}</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={() => void onRespond({ action: 'cancel', content: null }).catch(() => undefined)}>{t("ui.CodexInteractionShelf.McpUrlElicitationCard.cancel_turn_a0bf577")}</button>
      <button type="button" className="quiet-button" disabled={busy || !safeUrl} onClick={() => void open().catch(() => undefined)}>{t("ui.CodexInteractionShelf.McpUrlElicitationCard.open_authorization_page_a99dd51")}</button>
      <button
        type="button"
        className="primary-button"
        disabled={busy || !opened}
        onClick={() => void onRespond({ action: 'accept', content: {} }).catch(() => undefined)}
      ><Check size={14} />{" "}{t("ui.CodexInteractionShelf.McpUrlElicitationCard.continue_31fbef1")}</button>
    </div>
  </article>
}

function CardHeading({ icon, title, titleId, subtitle, interaction, providerName = 'Codex' }: {
  icon: ReactNode
  title: string
  titleId?: string
  subtitle: string
  interaction: ProviderPendingInteraction
  providerName?: string
}) {
  useLocale()
  return <header className="codex-card-heading">
    <span className="codex-card-icon" aria-hidden="true">{icon}</span>
    <div><strong id={titleId}>{title}</strong><small>{subtitle}</small></div>
    <AutoResolveNotice interaction={interaction} providerName={providerName} compact />
  </header>
}

function AutoResolveNotice({ interaction, providerName = 'Codex', compact = false }: {
  interaction: ProviderPendingInteraction
  providerName?: string
  compact?: boolean
}) {
  useLocale()
  const duration = interaction.auto_resolution_ms
  const [remaining, setRemaining] = useState(() => remainingAutoResolveSeconds(interaction))
  useEffect(() => {
    if (!duration) return
    const update = () => setRemaining(remainingAutoResolveSeconds(interaction))
    const timer = window.setInterval(update, 1_000)
    update()
    return () => window.clearInterval(timer)
  }, [duration, interaction])
  if (!duration || remaining === null) return null
  return <small className={`codex-auto-resolve${compact ? ' compact' : ''}`} title={t("ui.CodexInteractionShelf.AutoResolveNotice.will_continue_with_an_empty_response_if_ti_485d78c", { "provider": String(providerName) })}>
    {compact ? t("ui.CodexInteractionShelf.AutoResolveNotice.s_5307d20", { "seconds": String(remaining) }) : t("ui.CodexInteractionShelf.AutoResolveNotice.auto_continues_in_s_f8e34b5", { "seconds": String(remaining) })}
  </small>
}

function JsonDetails({ value, label, open = false }: { value: JsonValue; label: string; open?: boolean }) {
  useLocale()
  return <details className="codex-json-details" open={open}>
    <summary>{label}</summary>
    <pre>{JSON.stringify(value, null, 2)}</pre>
  </details>
}

function parseQuestions(raw: JsonValue | undefined): AskQuestion[] {
  return arrayValue(raw).flatMap(value => {
    const question = recordValue(value)
    const id = stringValue(question.id)
    const text = stringValue(question.question)
    if (!id || !text) return []
    return [{
      id,
      header: stringValue(question.header),
      question: text,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      multiSelect: question.multiSelect === true || question.multi_select === true,
      options: arrayValue(question.options).flatMap(optionValue => {
        const option = recordValue(optionValue)
        const label = stringValue(option.label)
        return label ? [{ label, description: stringValue(option.description) }] : []
      })
    }]
  })
}

function approvalCommand(params: Record<string, JsonValue>): string {
  const direct = stringValue(params.command)
  if (direct) return direct
  const toolCommand = stringValue(recordValue(params.toolInput).command)
  if (toolCommand) return toolCommand
  const actions = arrayValue(params.commandActions)
  if (actions.length) {
    return actions.map(action => {
      if (typeof action === 'string') return action
      const record = recordValue(action)
      return stringValue(record.command) || stringValue(record.text) || JSON.stringify(record)
    }).filter(Boolean).join('\n')
  }
  return ''
}

function hasRecordKey(value: JsonValue | undefined, key: string): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
}

function networkTargetLabel(host: string, protocol: string, port: string): string {
  const destination = [host || 'an external host', port ? `port ${port}` : ''].filter(Boolean).join(':')
  return protocol ? `${destination} over ${protocol}` : destination
}

function remainingAutoResolveSeconds(interaction: ProviderPendingInteraction): number | null {
  if (!interaction.auto_resolution_ms) return null
  const created = Date.parse(interaction.created_at ?? '')
  if (!Number.isFinite(created)) return Math.ceil(interaction.auto_resolution_ms / 1_000)
  return Math.max(0, Math.ceil((created + interaction.auto_resolution_ms - Date.now()) / 1_000))
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberOrStringValue(value: JsonValue | undefined): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
}

function enumSelectionIndex(options: JsonValue[], selected: JsonValue | undefined): string {
  if (selected === undefined) return ''
  const selectedJson = JSON.stringify(selected)
  const index = options.findIndex(option => JSON.stringify(option) === selectedJson)
  return index >= 0 ? String(index) : ''
}

function initialMcpContent(
  properties: Record<string, JsonValue>,
  required: Set<string>
): Record<string, JsonValue> {
  const content: Record<string, JsonValue> = {}
  for (const [name, rawDefinition] of Object.entries(properties)) {
    const definition = recordValue(rawDefinition)
    if (
      Object.prototype.hasOwnProperty.call(definition, 'default')
      && definition.default !== null
      && definition.default !== undefined
    ) {
      content[name] = Array.isArray(definition.default)
        ? [...definition.default]
        : definition.default
      continue
    }
    if (required.has(name) && stringValue(definition.type) === 'boolean') {
      content[name] = false
    } else if (required.has(name) && stringValue(definition.type) === 'array') {
      content[name] = []
    }
  }
  return content
}

function mcpFormSnapshot(interaction: ProviderPendingInteraction): McpFormSnapshot {
  const schemaValue = interaction.params.requestedSchema ?? interaction.params.schema
  const schema = recordValue(schemaValue)
  const properties = recordValue(schema.properties)
  const required = new Set(
    arrayValue(schema.required).filter((value): value is string => typeof value === 'string')
  )
  const openAiForm = stringValue(interaction.params.mode) === 'openai/form'
  const rawFallback = openAiForm && (
    stringValue(schema.type) !== 'object'
    || !isRecord(schema.properties)
    || Object.values(properties).some(value => !mcpFieldCanRender(recordValue(value)))
  )
  return {
    schema,
    properties,
    required,
    initialContent: initialMcpContent(properties, required),
    rawFallback
  }
}

function mcpFieldCanRender(definition: Record<string, JsonValue>): boolean {
  if (mcpSingleSelectOptions(definition).length > 0) return true
  const type = stringValue(definition.type)
  if (type === 'openai/imagePicker') return openAiImagePickerItems(definition).length > 0
  if (type === 'array') return mcpMultiSelectOptions(definition).length > 0
  return type === 'boolean' || type === 'string' || type === 'number' || type === 'integer'
}

function openAiRawContentIsValid(
  schema: Record<string, JsonValue>,
  content: Record<string, JsonValue>
): boolean {
  const required = arrayValue(schema.required).filter((value): value is string => typeof value === 'string')
  return required.every(name => Object.prototype.hasOwnProperty.call(content, name))
}

function mcpContentIsValid(
  properties: Record<string, JsonValue>,
  required: Set<string>,
  content: Record<string, JsonValue>
): boolean {
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(content, name)) return false
  }
  return Object.entries(content).every(([name, value]) => {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) return false
    return mcpFieldValueIsValid(recordValue(properties[name]), value, required.has(name))
  })
}

function mcpFieldValueIsValid(
  definition: Record<string, JsonValue>,
  value: JsonValue | undefined,
  required: boolean
): boolean {
  if (value === undefined) return !required
  const type = stringValue(definition.type)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'openai/imagePicker') {
    return typeof value === 'string'
      && openAiImagePickerItems(definition).some(item => item.id === value)
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (type === 'integer' && !Number.isInteger(value)) return false
    const minimum = finiteNumber(definition.minimum)
    const maximum = finiteNumber(definition.maximum)
    return (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum)
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false
    const options = mcpMultiSelectOptions(definition)
    if (options.length > 0 && value.some(item => !options.some(option => jsonValuesEqual(option.value, item)))) {
      return false
    }
    const minItems = nonNegativeInteger(definition.minItems)
    const maxItems = nonNegativeInteger(definition.maxItems)
    return (minItems === undefined || value.length >= minItems)
      && (maxItems === undefined || value.length <= maxItems)
  }
  if (typeof value !== 'string') return false
  const options = mcpSingleSelectOptions(definition)
  if (options.length > 0 && !options.some(option => jsonValuesEqual(option.value, value))) return false
  const minLength = nonNegativeInteger(definition.minLength)
  const maxLength = nonNegativeInteger(definition.maxLength)
  if (minLength !== undefined && value.length < minLength) return false
  if (maxLength !== undefined && value.length > maxLength) return false
  return mcpStringMatchesFormat(value, stringValue(definition.format))
}

function mcpSingleSelectOptions(definition: Record<string, JsonValue>): McpSelectOption[] {
  const titled = arrayValue(definition.oneOf).flatMap(rawOption => {
    const option = recordValue(rawOption)
    if (!Object.prototype.hasOwnProperty.call(option, 'const')) return []
    return [{ value: option.const, label: stringValue(option.title) || String(option.const) }]
  })
  if (titled.length > 0) return titled
  const values = arrayValue(definition.enum)
  const names = arrayValue(definition.enumNames)
  return values.map((value, index) => ({
    value,
    label: typeof names[index] === 'string' ? names[index] : String(value)
  }))
}

function mcpMultiSelectOptions(definition: Record<string, JsonValue>): McpSelectOption[] {
  if (stringValue(definition.type) !== 'array') return []
  const items = recordValue(definition.items)
  const titled = arrayValue(items.anyOf).flatMap(rawOption => {
    const option = recordValue(rawOption)
    if (!Object.prototype.hasOwnProperty.call(option, 'const')) return []
    return [{ value: option.const, label: stringValue(option.title) || String(option.const) }]
  })
  if (titled.length > 0) return titled
  return arrayValue(items.enum).map(value => ({ value, label: String(value) }))
}

function openAiImagePickerItems(definition: Record<string, JsonValue>): OpenAiImagePickerItem[] {
  return arrayValue(definition.items).flatMap(rawItem => {
    const item = recordValue(rawItem)
    const id = stringValue(item.id)
    if (!id) return []
    return [{
      id,
      title: stringValue(item.title) || id,
      image: stringValue(item.image)
    }]
  })
}

function multiSelectionIndices(options: McpSelectOption[], selected: JsonValue | undefined): string[] {
  if (!Array.isArray(selected)) return []
  return options.flatMap((option, index) => (
    selected.some(value => jsonValuesEqual(value, option.value)) ? [String(index)] : []
  ))
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mcpInputType(definition: Record<string, JsonValue>): string {
  if (definition.secret === true) return 'password'
  const type = stringValue(definition.type)
  if (type === 'number' || type === 'integer') return 'number'
  const format = stringValue(definition.format)
  if (format === 'email') return 'email'
  if (format === 'uri') return 'url'
  if (format === 'date') return 'date'
  return 'text'
}

function mcpStringMatchesFormat(value: string, format: string): boolean {
  if (!format || !value) return true
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'uri') {
    try {
      return Boolean(new URL(value).protocol)
    } catch {
      return false
    }
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }
  if (format === 'date-time') return new RegExp(`^(?:${DATE_TIME_PATTERN})$`).test(value)
  return true
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function safeInlineImageUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(value)
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sentenceCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, match => match.toUpperCase())
}

const DATE_TIME_PATTERN = String.raw`\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`
