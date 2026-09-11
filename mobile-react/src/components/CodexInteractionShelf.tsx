import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  Check,
  ChevronRight,
  FilePenLine,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  TerminalSquare,
  X,
} from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { advertisedStructuredDecisions } from '../lib/codex-controls'
import {
  enumSelectionIndex,
  initialMcpContent,
  jsonIdentity,
  mcpConstraintHints,
  mcpContentIsValid,
  mcpFieldValueIsValid,
  mcpMultiSelectOptions,
  mcpSingleSelectOptions,
  multiSelectionIndices,
  nonNegativeInteger,
  parseMcpNumericDraft,
  toggleMultiSelectValue,
} from '../lib/codex-mcp-form'
import { client } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { JsonValue, ProviderPendingInteraction } from '../types'
import { Text, TextInput } from './AppText'
import { useCodexRuntime } from './CodexRuntimeContext'
import { SheetCloseButton } from './ui'

export interface ProviderInteractionCardProps {
  interaction: ProviderPendingInteraction
  busy: boolean
  providerName: string
  onRespond(response: Record<string, JsonValue>): Promise<unknown>
}

export function CodexInteractionShelf() {
  const { supported, mutating, error, runtime, session, refresh, run } = useCodexRuntime()
  const respond = (interactionId: string, response: Record<string, JsonValue>) => {
    if (!supported || !session) return Promise.resolve(null)
    return run(async () => {
      await client.resolveCodexInteraction(session.id, interactionId, response)
    })
  }
  return <ProviderInteractionShelf
    providerName="Codex"
    supported={supported}
    // A background runtime refresh is not a mutation. Keep approval and input
    // actions live while fresh status is being fetched, matching the desktop
    // interaction shelf and preventing a control-event refresh from swallowing
    // the user's tap.
    busy={mutating}
    error={error}
    sessionId={session?.id ?? null}
    interactions={runtime?.pending_interactions ?? []}
    pendingInteractionCount={Math.max(
      session?.codex_pending_interaction_count ?? 0,
      session?.codex_needs_user_action ? 1 : 0,
      session?.latest_event_type === 'codex_interaction_requested' ? 1 : 0,
    )}
    closeTestID="codex-requests-close"
    onRetry={refresh}
    onRespond={respond}
  />
}

export interface ProviderInteractionShelfProps {
  providerName: string
  supported: boolean
  busy: boolean
  error: string | null
  sessionId: string | null
  interactions: readonly ProviderPendingInteraction[]
  pendingInteractionCount?: number
  closeTestID?: string
  onRetry?(): Promise<unknown>
  onRespond(interactionId: string, response: Record<string, JsonValue>): Promise<unknown>
}

export function ProviderInteractionShelf({
  providerName,
  supported,
  busy,
  error,
  sessionId,
  interactions,
  pendingInteractionCount = 0,
  closeTestID,
  onRetry,
  onRespond,
}: ProviderInteractionShelfProps) {
  const colors = usePalette()
  const [open, setOpen] = useState(false)
  const seenRequests = useRef('')
  const visibleCount = Math.max(interactions.length, pendingInteractionCount)
  const requestKey = `${providerName}:${sessionId ?? ''}:${visibleCount}:${interactions.map(interaction => interaction.id).join(':')}`
  const available = supported && Boolean(sessionId) && visibleCount > 0
  const close = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])

  useEffect(() => {
    if (!available || seenRequests.current === requestKey) return
    seenRequests.current = requestKey
    setOpen(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [available, requestKey])
  useEffect(() => {
    if (available || !open) return
    close()
  }, [available, close, open])

  if (!available && !open) return null
  const slug = providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const resolvedCloseTestID = closeTestID ?? `${slug}-requests-close`
  return (
    <>
      {available ? <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${providerName} needs ${visibleCount === 1 ? 'your input' : `${visibleCount} responses`}`}
        onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }}
        style={({ pressed }) => [
          styles.shelf,
          { backgroundColor: `${colors.orange}1f`, borderColor: colors.orange, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View style={[styles.attentionDot, { backgroundColor: colors.orange }]} />
        <Text style={[styles.shelfTitle, { color: colors.text }]} numberOfLines={1}>
          {visibleCount === 1 ? `${providerName} needs your input` : `${providerName} needs ${visibleCount} responses`}
        </Text>
        {busy ? <ActivityIndicator size="small" color={colors.orange} /> : <ChevronRight size={17} color={colors.orange} />}
      </Pressable> : null}
      {open ? <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
        <SafeAreaView style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
          <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>{providerName} needs your input</Text>
              <Text style={[styles.sheetSubtitle, { color: colors.muted }]}>
                Review each request before the active turn continues.
              </Text>
            </View>
            <SheetCloseButton label={`Close ${providerName} requests`} testID={resolvedCloseTestID} onPress={close} />
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.interactionList}
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="always"
          >
            {available && error ? (
              <View style={[styles.error, { backgroundColor: `${colors.red}18`, borderColor: colors.red }]}>
                <Text selectable style={{ color: colors.red, fontSize: 12, lineHeight: 17 }}>{error}</Text>
                {onRetry ? <View style={styles.actions}>
                  <Action label="Retry loading request" primary disabled={busy} onPress={() => { void onRetry().catch(() => undefined) }} />
                </View> : null}
              </View>
            ) : null}
            {available && !error && interactions.length === 0 ? (
              <View style={[styles.loadingRequest, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <ActivityIndicator size="small" color={colors.orange} />
                <Text style={{ color: colors.muted, fontSize: 12 }}>Loading the pending {providerName} request…</Text>
              </View>
            ) : null}
            {available ? interactions.map(interaction => (
              <ProviderInteractionCard
                key={interaction.id}
                interaction={interaction}
                providerName={providerName}
                busy={busy}
                onRespond={response => onRespond(interaction.id, response)}
              />
            )) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal> : null}
    </>
  )
}

export function CodexInteractionCard(props: Omit<ProviderInteractionCardProps, 'providerName'>) {
  return <ProviderInteractionCard {...props} providerName="Codex" />
}

export function ProviderInteractionCard(props: ProviderInteractionCardProps) {
  const method = props.interaction.method
  if (method === 'item/tool/requestUserInput') return <QuestionCard {...props} />
  if (method === 'item/permissions/requestApproval') return <PermissionCard {...props} />
  if (method === 'mcpServer/elicitation/request') {
    return stringValue(props.interaction.params.mode) === 'url'
      ? <McpUrlElicitationCard {...props} />
      : <McpElicitationCard {...props} />
  }
  return <ApprovalCard {...props} />
}

function ApprovalCard({ interaction, busy, providerName, onRespond }: ProviderInteractionCardProps) {
  const colors = usePalette()
  const params = interaction.params
  const command = approvalCommand(params)
  const reason = stringValue(params.reason) || stringValue(params.message)
  const toolName = stringValue(params.toolName) || stringValue(params.name)
  const displayName = stringValue(params.displayName) || stringValue(params.title) || toolName
  const description = stringValue(params.description)
  const fileApproval = interaction.method.includes('fileChange')
    || interaction.method === 'applyPatchApproval'
    || ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'].includes(toolName)
  const legacy = interaction.method === 'applyPatchApproval' || interaction.method === 'execCommandApproval'
  const availableDecisions = arrayValue(params.availableDecisions)
  const decisionsSpecified = Array.isArray(params.availableDecisions)
  const allowed = (decision: string) => (
    !decisionsSpecified || availableDecisions.some(value => value === decision)
  )
  const execAmendmentDecision = advertisedStructuredDecisions(
    params.availableDecisions,
    'acceptWithExecpolicyAmendment',
  )[0] ?? null
  const networkAmendmentDecisions = advertisedStructuredDecisions(
    params.availableDecisions,
    'applyNetworkPolicyAmendment',
  )
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
  const respond = (response: Record<string, JsonValue>) => {
    void onRespond(response).catch(() => undefined)
  }
  const denyDecision = legacy
    ? 'denied'
    : allowed('decline') ? 'decline' : null
  const cancelDecision = !legacy && allowed('cancel')
  const onceDecision = legacy
    ? 'approved'
    : allowed('accept') ? 'accept' : null
  const sessionDecision = !legacy && allowed('acceptForSession') ? 'acceptForSession' : null
  const title = fileApproval
    ? 'Approve file changes?'
    : networkApproval
      ? 'Approve network access?'
      : command
        ? 'Approve command?'
        : displayName
          ? `Approve ${displayName}?`
          : 'Approve tool use?'
  const subtitle = fileApproval
    ? `${providerName} is waiting before changing files.`
    : networkApproval
      ? `${providerName} is waiting to access ${networkTargetLabel(networkHost, networkProtocol, networkPort)}.`
      : command
        ? `${providerName} is waiting before running this command.`
        : `${providerName} is waiting before using ${displayName || 'this tool'}.`
  return (
    <Card
      icon={fileApproval ? FilePenLine : TerminalSquare}
      title={title}
      subtitle={subtitle}
      interaction={interaction}
    >
      {networkApproval ? (
        <View style={[styles.requestScope, { backgroundColor: colors.background }]}>
          <Text selectable style={{ color: colors.text, fontSize: 12, fontWeight: '900' }}>{networkHost || 'Unknown host'}</Text>
          <Text selectable style={{ color: colors.muted, fontSize: 10.5 }}>
            {[networkProtocol, networkPort ? `port ${networkPort}` : ''].filter(Boolean).join(' · ') || 'Managed network access'}
          </Text>
        </View>
      ) : null}
      {command ? <Text selectable style={[styles.command, { color: colors.text, backgroundColor: colors.background }]}>{command}</Text> : null}
      {fileApproval && hasProposedChanges ? (
        <View style={{ gap: 5 }}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>Proposed file changes</Text>
          <JsonBlock value={proposedChanges as JsonValue} />
        </View>
      ) : null}
      {fileApproval && !hasProposedChanges && Object.keys(toolInput).length ? (
        <View style={{ gap: 5 }}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>Requested file operation</Text>
          <JsonBlock value={toolInput} />
        </View>
      ) : null}
      {fileApproval && !hasProposedChanges && !Object.keys(toolInput).length ? (
        <View style={[styles.warning, { backgroundColor: `${colors.orange}18`, borderColor: colors.orange }]}>
          <Text style={{ color: colors.orange, fontSize: 11.5, lineHeight: 16 }}>
            {providerName} did not provide a patch preview. Review the requested path scope before allowing this change.
          </Text>
        </View>
      ) : null}
      {reason ? <Text selectable style={[styles.reason, { color: colors.muted }]}>{reason}</Text> : null}
      {description && description !== reason ? <Text selectable style={[styles.reason, { color: colors.muted }]}>{description}</Text> : null}
      {cwd || grantRoot ? (
        <View style={[styles.requestPaths, { backgroundColor: colors.background }]}>
          {cwd ? <LabeledValue label="Working directory" value={cwd} /> : null}
          {grantRoot ? <LabeledValue label="Requested write root" value={grantRoot} /> : null}
        </View>
      ) : null}
      {Object.keys(additionalPermissions).length ? (
        <View style={{ gap: 5 }}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>Additional sandbox permissions</Text>
          <JsonBlock value={additionalPermissions} />
        </View>
      ) : null}
      {permissionSuggestions.length ? (
        <View style={{ gap: 5 }}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>{providerName} session permission scope</Text>
          <JsonBlock value={permissionSuggestions} />
        </View>
      ) : null}
      {!command && !networkApproval && !fileApproval ? (
        <View style={{ gap: 5 }}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>{toolName ? `${toolName} input` : 'Request details'}</Text>
          <JsonBlock value={Object.keys(toolInput).length ? toolInput : params} />
        </View>
      ) : null}
      {execAmendmentDecision || networkAmendmentDecisions.length ? (
        <View style={[styles.policyBox, { borderColor: colors.orange }]}>
          <Text style={{ color: colors.text, fontSize: 11.5, fontWeight: '800' }}>Optional policy changes</Text>
          <View style={styles.actions}>
            {execAmendmentDecision ? (
              <Action
                label="Allow and remember command rule"
                disabled={busy}
                onPress={() => respond({ decision: execAmendmentDecision })}
              />
            ) : null}
            {networkAmendmentDecisions.map((decision, index) => {
              const body = recordValue(decision.applyNetworkPolicyAmendment)
              const amendment = recordValue(body.network_policy_amendment)
              const host = stringValue(amendment.host) || networkHost || 'host'
              const action = stringValue(amendment.action)
              return (
                <Action
                  key={`${index}:${jsonIdentity(decision)}`}
                  label={action === 'deny' ? `Deny and remember ${host}` : `Allow and remember ${host}`}
                  tone={action === 'deny' ? 'danger' : undefined}
                  disabled={busy}
                  onPress={() => respond({ decision })}
                />
              )
            })}
          </View>
        </View>
      ) : null}
      <View style={styles.actions}>
        {denyDecision ? <Action label="Deny" tone="danger" disabled={busy} onPress={() => respond({ decision: denyDecision })} /> : null}
        {cancelDecision ? <Action label="Cancel turn" disabled={busy} onPress={() => respond({ decision: 'cancel' })} /> : null}
        {sessionDecision ? <Action label="Allow for session" disabled={busy} onPress={() => respond({ decision: sessionDecision })} /> : null}
        {onceDecision ? <Action label="Allow once" primary disabled={busy} onPress={() => respond({ decision: onceDecision })} /> : null}
      </View>
      {!denyDecision && !cancelDecision && !sessionDecision && !onceDecision && !execAmendmentDecision && !networkAmendmentDecisions.length ? (
        <Text style={{ color: colors.red, fontSize: 12 }}>This request has no compatible decision exposed by the server.</Text>
      ) : null}
    </Card>
  )
}

interface AskQuestion {
  id: string
  header?: string
  question: string
  isOther: boolean
  isSecret: boolean
  multiSelect: boolean
  options: Array<{ label: string; description?: string }>
}

function QuestionCard({ interaction, busy, providerName, onRespond }: ProviderInteractionCardProps) {
  const colors = usePalette()
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
    if (!question.options.length) {
      const answer = textAnswers[question.id]?.trim()
      return answer ? [answer] : []
    }
    const selected = (answers[question.id] ?? []).map(answer => answer.trim()).filter(Boolean)
    const other = otherSelected[question.id] ? textAnswers[question.id]?.trim() : ''
    return other ? [...selected, other] : selected
  }
  const complete = questions.length > 0 && questions.every(question => answerValues(question).length > 0)
  const submit = () => {
    const responseAnswers: Record<string, JsonValue> = {}
    for (const question of questions) {
      const values = answerValues(question)
      if (values.length) responseAnswers[question.id] = { answers: values }
    }
    void onRespond({ answers: responseAnswers }).catch(() => undefined)
  }
  return (
    <Card
      icon={MessageSquareText}
      title={`${providerName} has a question`}
      subtitle="Your answer goes directly to the active turn."
      interaction={interaction}
    >
      {questions.map(question => (
        <View key={question.id} style={styles.question}>
          {question.header ? <Text style={[styles.eyebrow, { color: colors.orange }]}>{question.header}</Text> : null}
          <Text style={[styles.questionText, { color: colors.text }]}>{question.question}</Text>
          {question.options.map(option => {
            const selected = (answers[question.id] ?? []).includes(option.label)
            return (
              <Pressable
                key={option.label}
                accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
                accessibilityState={question.multiSelect ? { checked: selected } : { selected }}
                onPress={() => {
                  if (!question.multiSelect) {
                    setOtherSelected(current => ({ ...current, [question.id]: false }))
                    setAnswers(current => ({ ...current, [question.id]: [option.label] }))
                    return
                  }
                  setAnswers(current => {
                    const selectedAnswers = current[question.id] ?? []
                    return {
                      ...current,
                      [question.id]: selected
                        ? selectedAnswers.filter(value => value !== option.label)
                        : [...selectedAnswers, option.label],
                    }
                  })
                }}
                style={[styles.option, { borderColor: selected ? colors.blue : colors.border, backgroundColor: selected ? `${colors.blue}18` : colors.background }]}
              >
                <View style={[styles.radio, question.multiSelect && styles.checkbox, { borderColor: selected ? colors.blue : colors.muted }]}>
                  {selected ? question.multiSelect
                    ? <Check size={12} color={colors.blue} />
                    : <View style={[styles.radioDot, { backgroundColor: colors.blue }]} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{option.label}</Text>
                  {option.description ? <Text style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{option.description}</Text> : null}
                </View>
              </Pressable>
            )
          })}
          {question.options.length > 0 && question.isOther ? (
            <View
              style={[
                styles.option,
                styles.otherOption,
                {
                  borderColor: otherSelected[question.id] ? colors.blue : colors.border,
                  backgroundColor: otherSelected[question.id] ? `${colors.blue}18` : colors.background,
                },
              ]}
            >
              <Pressable
                accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={question.multiSelect
                  ? { checked: otherSelected[question.id] === true }
                  : { selected: otherSelected[question.id] === true }}
                onPress={() => {
                  setOtherSelected(current => ({
                    ...current,
                    [question.id]: question.multiSelect ? current[question.id] !== true : true,
                  }))
                  if (!question.multiSelect) setAnswers(current => ({ ...current, [question.id]: [] }))
                }}
                style={styles.otherOptionHeader}
              >
                <View style={[styles.radio, question.multiSelect && styles.checkbox, { borderColor: otherSelected[question.id] ? colors.blue : colors.muted }]}>
                  {otherSelected[question.id] ? question.multiSelect
                    ? <Check size={12} color={colors.blue} />
                    : <View style={[styles.radioDot, { backgroundColor: colors.blue }]} /> : null}
                </View>
                <Text style={{ color: colors.text, fontWeight: '700' }}>Other</Text>
              </Pressable>
              <TextInput
                accessibilityLabel={`Other answer: ${question.question}`}
                value={otherSelected[question.id] ? textAnswers[question.id] ?? '' : ''}
                onFocus={() => {
                  if (!question.multiSelect) setAnswers(current => ({ ...current, [question.id]: [] }))
                  setOtherSelected(current => ({ ...current, [question.id]: true }))
                }}
                onChangeText={value => {
                  setOtherSelected(current => ({ ...current, [question.id]: true }))
                  setTextAnswers(current => ({ ...current, [question.id]: value }))
                }}
                secureTextEntry={question.isSecret}
                autoCapitalize="sentences"
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                placeholder="Type another answer"
                placeholderTextColor={colors.muted}
              />
            </View>
          ) : !question.options.length ? (
            <TextInput
              accessibilityLabel={`Answer: ${question.question}`}
              value={textAnswers[question.id] ?? ''}
              onChangeText={value => setTextAnswers(current => ({ ...current, [question.id]: value }))}
              secureTextEntry={question.isSecret}
              autoCapitalize="sentences"
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              placeholder="Type your answer"
              placeholderTextColor={colors.muted}
            />
          ) : null}
        </View>
      ))}
      {!questions.length ? <JsonBlock value={interaction.params} /> : null}
      <View style={styles.actions}>
        <Action label="Skip" disabled={busy} onPress={() => { void onRespond({ answers: {} }).catch(() => undefined) }} />
        <Action label="Send answer" primary disabled={busy || !complete} onPress={submit} />
      </View>
    </Card>
  )
}

function PermissionCard({ interaction, busy, providerName, onRespond }: ProviderInteractionCardProps) {
  const colors = usePalette()
  const requested = recordValue(interaction.params.permissions)
  const cwd = stringValue(interaction.params.cwd)
  const environmentId = stringValue(interaction.params.environmentId)
  const reason = stringValue(interaction.params.reason)
  const [scope, setScope] = useState<'turn' | 'session'>('turn')
  const respond = (accepted: boolean) => {
    void onRespond({
      permissions: accepted ? requested : {},
      scope,
      strictAutoReview: false,
    }).catch(() => undefined)
  }
  return (
    <Card
      icon={KeyRound}
      title="Grant additional permissions?"
      subtitle={`${providerName} requested access beyond this chat’s profile.`}
      interaction={interaction}
    >
      {reason ? <Text selectable style={[styles.reason, { color: colors.muted }]}>{reason}</Text> : null}
      {cwd || environmentId ? (
        <View style={[styles.requestPaths, { backgroundColor: colors.background }]}>
          {cwd ? <LabeledValue label="Working directory" value={cwd} /> : null}
          {environmentId ? <LabeledValue label="Environment" value={environmentId} /> : null}
        </View>
      ) : null}
      <JsonBlock value={requested} />
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>Grant duration</Text>
      <View style={styles.segment}>
        {(['turn', 'session'] as const).map(value => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={value === 'turn' ? 'Grant for this turn' : 'Grant for this session'}
            accessibilityState={{ selected: scope === value }}
            onPress={() => setScope(value)}
            style={[styles.segmentOption, { backgroundColor: scope === value ? colors.blue : colors.background, borderColor: colors.border }]}
          >
            <Text style={{ color: scope === value ? 'white' : colors.text, fontWeight: '700' }}>
              {value === 'turn' ? 'This turn' : 'This session'}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.actions}>
        <Action label="Deny" tone="danger" disabled={busy} onPress={() => respond(false)} />
        <Action label="Grant requested subset" primary disabled={busy} onPress={() => respond(true)} />
      </View>
    </Card>
  )
}

function McpElicitationCard({ interaction, busy, providerName, onRespond }: ProviderInteractionCardProps) {
  const params = interaction.params
  const schemaValue = params.requestedSchema ?? params.schema
  const schema = useMemo(() => recordValue(schemaValue), [schemaValue])
  const properties = useMemo(() => recordValue(schema.properties), [schema.properties])
  const required = useMemo(
    () => new Set(arrayValue(schema.required).filter((value): value is string => typeof value === 'string')),
    [schema.required],
  )
  const initializationKey = `${interaction.id}:${jsonIdentity(schema)}`
  const initializedKey = useRef(initializationKey)
  const [content, setContent] = useState<Record<string, JsonValue>>(
    () => initialMcpContent(properties, required),
  )
  useEffect(() => {
    if (initializedKey.current === initializationKey) return
    initializedKey.current = initializationKey
    setContent(initialMcpContent(properties, required))
  }, [initializationKey, properties, required])
  const valid = mcpContentIsValid(properties, required, content)
  const update = (name: string, value: JsonValue | undefined) => setContent(current => {
    const next = { ...current }
    if (value === undefined) delete next[name]
    else next[name] = value
    return next
  })
  return (
    <Card
      icon={MessageSquareText}
      title={stringValue(params.title) || 'Connected tool needs input'}
      subtitle={stringValue(params.message) || `Review what ${providerName} will share with the connected tool.`}
      interaction={interaction}
    >
      {Object.entries(properties).map(([name, rawDefinition]) => {
        const definition = recordValue(rawDefinition)
        return (
          <McpFormField
            key={`${initializationKey}:${name}`}
            name={name}
            definition={definition}
            required={required.has(name)}
            value={content[name]}
            onChange={value => update(name, value)}
          />
        )
      })}
      {!Object.keys(properties).length ? <JsonBlock value={params} /> : null}
      <View style={styles.actions}>
        <Action label="Decline" tone="danger" disabled={busy} onPress={() => { void onRespond({ action: 'decline' }).catch(() => undefined) }} />
        <Action label="Cancel turn" disabled={busy} onPress={() => { void onRespond({ action: 'cancel' }).catch(() => undefined) }} />
        <Action label="Share with tool" primary disabled={busy || !valid} onPress={() => { void onRespond({ action: 'accept', content }).catch(() => undefined) }} />
      </View>
    </Card>
  )
}

function McpFormField({ name, definition, required, value, onChange }: {
  name: string
  definition: Record<string, JsonValue>
  required: boolean
  value: JsonValue | undefined
  onChange(value: JsonValue | undefined): void
}) {
  const colors = usePalette()
  const type = stringValue(definition.type)
  const numericType = type === 'number' || type === 'integer' ? type : null
  const format = stringValue(definition.format)
  const label = stringValue(definition.title) || sentenceCase(name)
  const description = stringValue(definition.description)
  const singleOptions = mcpSingleSelectOptions(definition)
  const multiOptions = mcpMultiSelectOptions(definition)
  const selectedSingleIndex = enumSelectionIndex(singleOptions.map(option => option.value), value)
  const selectedMultiIndices = new Set(multiSelectionIndices(multiOptions, value))
  const selectedMultiCount = Array.isArray(value) ? value.length : 0
  const maxItems = nonNegativeInteger(definition.maxItems)
  const maxLength = nonNegativeInteger(definition.maxLength)
  const invalid = !mcpFieldValueIsValid(definition, value, required)
  const hints = mcpConstraintHints(definition)
  const inputBorderColor = invalid ? colors.red : colors.border
  const numericFocused = useRef(false)
  const [numericDraft, setNumericDraft] = useState(
    () => numericType && typeof value === 'number' ? String(value) : '',
  )
  useEffect(() => {
    if (!numericType || numericFocused.current) return
    setNumericDraft(typeof value === 'number' ? String(value) : '')
  }, [numericType, value])

  return (
    <View style={styles.formField}>
      <Text style={[styles.fieldLabel, { color: colors.text }]}>{label}{required ? ' *' : ''}</Text>
      {description ? <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16 }}>{description}</Text> : null}
      {type === 'array' && multiOptions.length > 0 ? (
        <View style={styles.choiceWrap} accessibilityRole="list">
          {multiOptions.map((option, index) => {
            const selected = selectedMultiIndices.has(index)
            const atMaximum = !selected && maxItems !== undefined && selectedMultiCount >= maxItems
            return (
              <Pressable
                key={`${name}:${index}:${jsonIdentity(option.value)}`}
                accessibilityRole="checkbox"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: selected, disabled: atMaximum }}
                disabled={atMaximum}
                onPress={() => onChange(toggleMultiSelectValue(value, option.value))}
                style={[
                  styles.choiceChip,
                  {
                    borderColor: selected ? colors.blue : invalid ? colors.red : colors.border,
                    backgroundColor: selected ? `${colors.blue}18` : colors.background,
                    opacity: atMaximum ? 0.4 : 1,
                  },
                ]}
              >
                <Text style={{ color: colors.text, fontSize: 12 }}>{option.label}</Text>
              </Pressable>
            )
          })}
        </View>
      ) : singleOptions.length > 0 ? (
        <View style={styles.choiceWrap} accessibilityRole="radiogroup">
          {singleOptions.map((option, index) => {
            const selected = selectedSingleIndex === index
            return (
              <Pressable
                key={`${name}:${index}:${jsonIdentity(option.value)}`}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected }}
                onPress={() => onChange(selected && !required ? undefined : option.value)}
                style={[
                  styles.choiceChip,
                  {
                    borderColor: selected ? colors.blue : invalid ? colors.red : colors.border,
                    backgroundColor: selected ? `${colors.blue}18` : colors.background,
                  },
                ]}
              >
                <Text style={{ color: colors.text, fontSize: 12 }}>{option.label}</Text>
              </Pressable>
            )
          })}
        </View>
      ) : type === 'boolean' ? (
        <View style={styles.switchRow}>
          <Text style={{ color: value === true ? colors.text : colors.muted, fontSize: 11 }}>
            {value === true ? 'Enabled' : 'Disabled'}
          </Text>
          <Switch
            accessibilityLabel={label}
            value={value === true}
            onValueChange={onChange}
          />
        </View>
      ) : (
        <TextInput
          accessibilityLabel={label}
          value={numericType ? numericDraft : value == null ? '' : String(value)}
          onFocus={() => {
            if (numericType) numericFocused.current = true
          }}
          onBlur={() => {
            if (!numericType) return
            numericFocused.current = false
            const parsed = parseMcpNumericDraft(numericDraft, numericType)
            if (parsed === undefined) {
              setNumericDraft('')
              onChange(undefined)
            } else {
              setNumericDraft(String(parsed))
              onChange(parsed)
            }
          }}
          onChangeText={nextValue => {
            if (numericType) {
              setNumericDraft(nextValue)
              onChange(parseMcpNumericDraft(nextValue, numericType))
              return
            }
            if (!nextValue) {
              onChange(undefined)
              return
            }
            onChange(nextValue)
          }}
          secureTextEntry={definition.secret === true}
          keyboardType={mcpKeyboardType(type, format)}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={maxLength}
          placeholder={mcpPlaceholder(format)}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.text, borderColor: inputBorderColor, backgroundColor: colors.background }]}
        />
      )}
      {hints.length ? (
        <Text style={{ color: invalid ? colors.red : colors.muted, fontSize: 10.5, lineHeight: 15 }}>
          {hints.join(' · ')}
        </Text>
      ) : invalid ? (
        <Text style={{ color: colors.red, fontSize: 10.5 }}>Enter a valid value.</Text>
      ) : null}
    </View>
  )
}

function McpUrlElicitationCard({ interaction, busy, providerName, onRespond }: ProviderInteractionCardProps) {
  const colors = usePalette()
  const params = interaction.params
  const url = stringValue(params.url)
  const safeUrl = isSafeExternalUrl(url)
  const [opened, setOpened] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const open = async () => {
    if (!safeUrl) return
    setOpenError(null)
    try {
      await Linking.openURL(url)
      setOpened(true)
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <Card
      icon={KeyRound}
      title={stringValue(params.title) || 'Connected tool needs authorization'}
      subtitle={stringValue(params.message) || `Open the authorization page, then continue this ${providerName} turn.`}
      interaction={interaction}
    >
      <View style={[styles.requestScope, { backgroundColor: colors.background }]}>
        <Text selectable style={{ color: safeUrl ? colors.text : colors.red, fontSize: 11.5, fontWeight: '800' }}>
          {safeUrl ? url : 'Invalid authorization URL'}
        </Text>
      </View>
      {!safeUrl ? (
        <View style={[styles.warning, { backgroundColor: `${colors.red}18`, borderColor: colors.red }]}>
          <Text style={{ color: colors.red, fontSize: 11.5 }}>Only HTTPS or HTTP authorization links can be opened.</Text>
        </View>
      ) : null}
      {openError ? (
        <View style={[styles.warning, { backgroundColor: `${colors.red}18`, borderColor: colors.red }]}>
          <Text selectable style={{ color: colors.red, fontSize: 11.5 }}>{openError}</Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <Action label="Decline" tone="danger" disabled={busy} onPress={() => { void onRespond({ action: 'decline', content: null }).catch(() => undefined) }} />
        <Action label="Cancel turn" disabled={busy} onPress={() => { void onRespond({ action: 'cancel', content: null }).catch(() => undefined) }} />
        <Action label="Open authorization page" disabled={busy || !safeUrl} onPress={() => { void open() }} />
        <Action label="Continue" primary disabled={busy || !opened} onPress={() => { void onRespond({ action: 'accept', content: {} }).catch(() => undefined) }} />
      </View>
    </Card>
  )
}

function Card({ icon: Icon, title, subtitle, interaction, children }: {
  icon: typeof Check
  title: string
  subtitle: string
  interaction: ProviderPendingInteraction
  children: React.ReactNode
}) {
  const colors = usePalette()
  const remaining = useInteractionCountdown(interaction)
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.cardIcon, { backgroundColor: colors.raised }]}><Icon size={18} color={colors.orange} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.cardSubtitle, { color: colors.muted }]}>{subtitle}</Text>
        </View>
        {remaining != null ? <Text style={[styles.countdown, { color: colors.orange }]}>{remaining}s</Text> : null}
      </View>
      {children}
    </View>
  )
}

function Action({ label, onPress, disabled, primary, tone }: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
  tone?: 'danger'
}) {
  const colors = usePalette()
  const backgroundColor = primary ? colors.blue : colors.raised
  const color = primary ? 'white' : tone === 'danger' ? colors.red : colors.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { backgroundColor, opacity: disabled ? 0.4 : pressed ? 0.68 : 1 }]}
    >
      {primary ? <ShieldCheck size={15} color={color} /> : tone === 'danger' ? <X size={15} color={color} /> : <Check size={15} color={color} />}
      <Text style={{ color, fontSize: 12, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  )
}

function JsonBlock({ value }: { value: JsonValue }) {
  const colors = usePalette()
  return <Text selectable style={[styles.json, { color: colors.text, backgroundColor: colors.background }]}>{JSON.stringify(value, null, 2)}</Text>
}

function LabeledValue({ label, value }: { label: string; value: string }) {
  const colors = usePalette()
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: colors.muted, fontSize: 9.5, fontWeight: '800' }}>{label}</Text>
      <Text selectable style={{ color: colors.text, fontSize: 11.5 }}>{value}</Text>
    </View>
  )
}

function useInteractionCountdown(interaction: ProviderPendingInteraction): number | null {
  const [remaining, setRemaining] = useState(() => providerRemainingAutoResolveSeconds(interaction))
  useEffect(() => {
    if (!interaction.auto_resolution_ms) {
      setRemaining(null)
      return
    }
    const update = () => setRemaining(providerRemainingAutoResolveSeconds(interaction))
    update()
    const timer = setInterval(update, 1_000)
    return () => clearInterval(timer)
  }, [interaction])
  return remaining
}

function parseQuestions(raw: JsonValue | undefined): AskQuestion[] {
  return arrayValue(raw).flatMap(value => {
    const question = recordValue(value)
    const id = stringValue(question.id)
    const text = stringValue(question.question)
    if (!id || !text) return []
    return [{
      id,
      header: stringValue(question.header) || undefined,
      question: text,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      multiSelect: question.multiSelect === true || question.multi_select === true,
      options: arrayValue(question.options).flatMap(optionValue => {
        const option = recordValue(optionValue)
        const label = stringValue(option.label)
        return label ? [{ label, description: stringValue(option.description) || undefined }] : []
      }),
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

function providerRemainingAutoResolveSeconds(
  interaction: ProviderPendingInteraction,
  now = Date.now(),
): number | null {
  if (!interaction.auto_resolution_ms) return null
  const createdAt = Date.parse(interaction.created_at)
  if (!Number.isFinite(createdAt)) return Math.ceil(interaction.auto_resolution_ms / 1_000)
  return Math.max(0, Math.ceil((createdAt + interaction.auto_resolution_ms - now) / 1_000))
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberOrStringValue(value: JsonValue | undefined): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
}

function networkTargetLabel(host: string, protocol: string, port: string): string {
  const destination = [host || 'an external host', port ? `port ${port}` : ''].filter(Boolean).join(':')
  return protocol ? `${destination} over ${protocol}` : destination
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function mcpKeyboardType(type: string, format: string): 'numbers-and-punctuation' | 'email-address' | 'url' | 'default' {
  if (type === 'number' || type === 'integer') return 'numbers-and-punctuation'
  if (format === 'email') return 'email-address'
  if (format === 'uri') return 'url'
  return 'default'
}

function mcpPlaceholder(format: string): string | undefined {
  if (format === 'date') return 'YYYY-MM-DD'
  if (format === 'date-time') return '2026-07-28T12:00:00Z'
  return undefined
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function sentenceCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, match => match.toUpperCase())
}

const styles = StyleSheet.create({
  shelf: {
    minHeight: 48,
    marginHorizontal: 10,
    marginBottom: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  attentionDot: { width: 9, height: 9, borderRadius: 5 },
  shelfTitle: { flex: 1, fontSize: 12.5, fontWeight: '800' },
  sheet: { flex: 1 },
  sheetHeader: { minHeight: 68, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { fontSize: 18, fontWeight: '900' },
  sheetSubtitle: { fontSize: 11, marginTop: 3 },
  interactionList: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 12, paddingBottom: 40, gap: 10 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 13, gap: 12 },
  error: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10 },
  loadingRequest: { minHeight: 72, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: { width: 38, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '900' },
  cardSubtitle: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  countdown: { fontSize: 12, fontWeight: '900' },
  command: { borderRadius: 7, padding: 11, fontFamily: 'Menlo', fontSize: 11.5, lineHeight: 17 },
  reason: { fontSize: 12, lineHeight: 17 },
  requestScope: { borderRadius: 7, padding: 10, gap: 3 },
  requestPaths: { borderRadius: 7, padding: 10, gap: 8 },
  policyBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 9, gap: 8 },
  warning: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 9 },
  json: { borderRadius: 7, padding: 10, fontFamily: 'Menlo', fontSize: 10.5, lineHeight: 15 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 7 },
  action: { minHeight: 44, borderRadius: 7, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  question: { gap: 7 },
  eyebrow: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  questionText: { fontSize: 13.5, lineHeight: 19, fontWeight: '800' },
  option: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 9 },
  otherOption: { flexDirection: 'column', alignItems: 'stretch', gap: 5 },
  otherOptionHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9 },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkbox: { borderRadius: 4 },
  radioDot: { width: 9, height: 9, borderRadius: 5 },
  input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13 },
  formField: { gap: 5 },
  fieldLabel: { fontSize: 11, fontWeight: '800' },
  segment: { flexDirection: 'row', gap: 7 },
  segmentOption: { minHeight: 44, flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  switchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choiceChip: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, justifyContent: 'center' },
})
