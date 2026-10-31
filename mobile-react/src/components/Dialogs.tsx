import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { DateTimePicker } from '@expo/ui/community/datetime-picker'
import * as Clipboard from 'expo-clipboard'
import { ArrowLeft, Calendar, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, KeyRound, Languages, MessageSquare, Minus, Monitor, Moon, Network, Plus, Search, Server, ShieldCheck, SquareTerminal, Sun, SunMoon, type LucideIcon } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { defaultScheduleWallTime, effectiveScheduleKind, formatScheduleWallTime, JOB_INTERVAL_PRESETS_SECONDS, jobLoopsForever, jobNextRunUpdatePatch, jobScheduleFields, jobScheduleUpdatePatch, mergeScheduleWallTimePickerValue, parseScheduleWallTime, scheduleWallTimeAndroidDatePickerDate, scheduleWallTimePickerDate, type JobStartMode, validateJobNextRun, validateJobSchedule } from '../lib/job-schedule'
import { AGENTS_SERVER_REPOSITORY_URL } from '../lib/server-setup'
import { trackEvent } from '../lib/analytics'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { backendLabel } from '../lib/format'
import { serverSearchQuery } from '../lib/server-search'
import { APP_FONT_SCALE_MAX, APP_FONT_SCALE_MIN, APP_FONT_SCALE_STEP } from '../lib/typography'
import { tailscaleServerHost } from '../lib/settings-agents'
import { orderedSessionSections } from '../lib/session-order'
import { runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeSelectionError, selectableChatBackends } from '../lib/runtime-catalog'
import { chatBackendChoice, chatBackendLabel, chatBackendSelection, isCustomProvider, providerRuntimeCatalog, selectableChatBackendChoices } from '../lib/provider-selection'
import { chatMentionTrigger, insertChatReference, parseStoredChatReferences, reconcileChatReferences, supportedCrossChatTargetBackends, type ChatMentionTrigger } from '../lib/chat-references'
import { MAX_SCHEDULED_CHAT_REFERENCES, normalizeScheduledJobChatReferences, scheduledJobChatReferencesForWrite, scheduledJobRouteHintsAvailable } from '../lib/scheduled-job-chat-references'
import { client, useAppStore } from '../store/useAppStore'
import { useAppearanceStore, type ThemePreference } from '../store/useAppearanceStore'
import { useLanguageStore } from '../store/useLanguageStore'
import { t } from '../i18n'
import type { LanguagePreference } from '../i18n/locale'
import { radius, spacing, typography, usePalette } from '../theme'
import type { Backend, ChatReference, CreateJobInput, JobContextMode, JobScheduleKind, RuntimeOption, Session, TimelineSearchResult, UpdateJobInput } from '../types'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { AgentPicker } from './AgentPicker'
import { IconButton, SheetCloseButton } from './ui'
import { MyAgentsSettings } from './MyAgentsSettings'
import appConfig from '../../app.json'
import { AndroidUpdateSettings } from './AndroidUpdater'
import { AppleUpdateSettings } from './AppleUpdateSettings'
import { AnalyticsSettings } from './AnalyticsSettings'

const PRIVACY_POLICY_URL = 'https://agentsdock.net/privacy.html'

export function ServerSetupDialog({
  visible,
  onConfigure,
  onClose,
  onDidDismiss,
}: {
  visible: boolean
  onConfigure: () => void
  onClose: () => void
  onDidDismiss?: () => void
}) {
  const colors = usePalette()
  return <Sheet visible={visible} title="Connect AgentsDock" onClose={onClose} onDidDismiss={onDidDismiss} form>
    <View style={styles.setupIntro}>
      <View style={[styles.setupIcon, { backgroundColor: colors.raised }]}><Server size={24} color={colors.blue} /></View>
      <View style={styles.setupCopy}>
        <Text style={[styles.setupTitle, { color: colors.text }]} localize>Set up your agent server</Text>
        <Text style={[styles.setupBody, { color: colors.muted }]} localize>AgentsDock needs a running AgentsServer before it can load chats and launch agents.</Text>
      </View>
    </View>
    <View style={styles.setupSteps}>
      <SetupStep icon={SquareTerminal} text="Install AgentsServer on a Mac or Linux host with the Codex or Claude Code CLI." />
      <SetupStep icon={Network} text="Make your server reachable over the same Wi-Fi or private Tailscale network." />
      <SetupStep icon={KeyRound} text="Enter the server address and access token in connection settings." />
    </View>
    <Pressable
      testID="server-setup-guide"
      accessibilityRole="link"
      onPress={() => void Linking.openURL(AGENTS_SERVER_REPOSITORY_URL)}
      style={({ pressed }) => [styles.setupGuide, { backgroundColor: colors.raised, borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}
    >
      <ExternalLink size={16} color={colors.blue} />
      <Text style={[styles.setupGuideText, { color: colors.text }]} localize>Open AgentsServer setup guide</Text>
    </Pressable>
    <PrimaryButton testID="server-setup-configure" label="Configure connection" onPress={onConfigure} />
    <Text style={[styles.help, { color: colors.muted, textAlign: 'center' }]} localize>You can reopen connection settings from the sidebar at any time.</Text>
  </Sheet>
}

function SetupStep({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  const colors = usePalette()
  return <View style={styles.setupStep}><Icon size={17} color={colors.muted} /><Text style={[styles.setupStepText, { color: colors.text }]}>{text}</Text></View>
}

function openPrivacyPolicy(): void {
  void Linking.openURL(PRIVACY_POLICY_URL).catch(() => undefined)
}

export function SettingsDialog({ visible, onClose, onOpenServers, onDidDismiss }: { visible: boolean; onClose: () => void; onOpenServers: () => void; onDidDismiss?: () => void }) {
  const colors = usePalette()
  const fontScale = useAppStore(state => state.fontScale)
  const setFontScale = useAppStore(state => state.setFontScale)
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const serverName = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.name)
  const serverURL = useAppStore(state => state.serverURL)
  const connected = useAppStore(state => state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting)
  const chatDefaults = useAppStore(state => state.chatDefaults)
  const setChatDefaults = useAppStore(state => state.setChatDefaults)
  const themePreference = useAppearanceStore(state => state.preference)
  const setThemePreference = useAppearanceStore(state => state.setPreference)
  const themeError = useAppearanceStore(state => state.error)
  const languagePreference = useLanguageStore(state => state.preference)
  const languageError = useLanguageStore(state => state.error)
  const setLanguagePreference = useLanguageStore(state => state.setPreference)
  const [page, setPage] = useState<SettingsPage>('home')
  const [defaultFolder, setDefaultFolder] = useState(chatDefaults.folder)
  const [defaultCwd, setDefaultCwd] = useState(chatDefaults.cwd)
  useEffect(() => { if (!visible) setPage('home') }, [visible])
  useEffect(() => {
    if (!visible) return
    setDefaultFolder(chatDefaults.folder)
    setDefaultCwd(chatDefaults.cwd)
  }, [chatDefaults.cwd, chatDefaults.folder, visible])
  const leavePage = () => {
    if (page === 'chats') setChatDefaults({ folder: defaultFolder.trim() || 'General', cwd: defaultCwd.trim() })
    dismissAppKeyboard()
  }
  const back = () => { leavePage(); setPage('home') }
  const close = () => { leavePage(); onClose() }
  const defaultServerCwd = health?.default_cwd?.trim() ?? ''
  const chatDefaultBackendOptions = selectableChatBackendChoices(health, runtime)
  const defaultChoice = chatBackendChoice(chatDefaults)
  const defaultCatalog = providerRuntimeCatalog(runtime, chatDefaults)
  const chatDefaultModelOptions = runtimeCatalogOptions(defaultCatalog, chatDefaults.backend, 'models', chatDefaults.model)
  const tailscaleHost = connected ? tailscaleServerHost(serverURL) : null
  return <Sheet visible={visible} title={settingsTitles[page]} onClose={close} onDidDismiss={onDidDismiss} onBack={page === 'home' ? undefined : back}>
    {page === 'home' ? <View testID="settings-categories" style={styles.settingsCategories}>
      <View>
        <SettingsHeading title="App" />
        <SettingsRow testID="settings-open-appearance" icon={SunMoon} title="Appearance" value={t(themeLabels[themePreference])} onPress={() => setPage('appearance')} />
        <SettingsRow testID="settings-open-language" icon={Languages} title="Language" value={languagePreference === 'system' ? t('System') : languagePreference === 'en' ? 'English' : '简体中文'} onPress={() => setPage('language')} />
        <SettingsRow testID="settings-open-updates" icon={Download} title="App updates" onPress={() => setPage('updates')} />
        <SettingsRow testID="settings-open-chats" icon={MessageSquare} title="New chat defaults" onPress={() => setPage('chats')} />
      </View>
      <View>
        <SettingsHeading title="Server" />
        <SettingsRow testID="settings-open-servers" icon={Server} title="Server" value={serverName} onPress={onOpenServers} />
        <SettingsRow testID="settings-open-agents" icon={SquareTerminal} title="My agents" onPress={() => setPage('agents')} />
        {tailscaleHost ? <View testID="settings-tailscale-server" style={[styles.settingsRow, { borderColor: colors.border }]}>
          <Network size={20} color={colors.muted} />
          <View style={styles.settingsNetworkCopy}>
            <Text style={[typography.body, { color: colors.text }]} localize>Tailscale server</Text>
            <Text selectable style={[typography.caption, { color: colors.muted }]}>{tailscaleHost}</Text>
          </View>
        </View> : null}
      </View>
      <View>
        <SettingsHeading title="About" />
        <SettingsRow testID="settings-open-privacy" icon={ShieldCheck} title="Privacy" external onPress={openPrivacyPolicy} />
        {Platform.OS === 'android' ? <SettingsRow testID="settings-open-analytics" icon={ShieldCheck} title="Usage analytics" onPress={() => setPage('analytics')} /> : null}
      </View>
      <Text testID="settings-build" style={[styles.build, { color: colors.muted }]} localize>AgentsDock {appConfig.expo.version} · build {Platform.OS === 'android' ? appConfig.expo.android.versionCode : appConfig.expo.ios.buildNumber}</Text>
    </View> : null}
    {page === 'appearance' ? <>
    <Label text="Theme" />
    <View accessibilityRole="tablist" style={[styles.themeOptions, { backgroundColor: colors.raised }]}>
      {themeOptions.map(({ value, icon: Icon }) => <Pressable key={value} testID={`settings-theme-${value}`} accessibilityRole="tab" accessibilityLabel={t(themeLabels[value])} accessibilityState={{ selected: themePreference === value }} onPress={() => void setThemePreference(value)} style={({ pressed }) => [styles.themeOption, { backgroundColor: themePreference === value ? colors.surface : 'transparent', opacity: pressed ? 0.65 : 1 }]}>
        <Icon size={20} color={themePreference === value ? colors.blue : colors.muted} />
        <Text style={[typography.label, styles.themeOptionText, { color: themePreference === value ? colors.text : colors.muted }]}>{t(themeLabels[value])}</Text>
      </Pressable>)}
    </View>
    {themeError ? <Text accessibilityRole="alert" style={[styles.help, { color: colors.red }]}>{themeError}</Text> : null}
    <Label text="App text size" />
    <View style={[styles.fontScale, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <IconButton icon={Minus} disabled={fontScale <= APP_FONT_SCALE_MIN} label="Decrease app text size" onPress={() => setFontScale(fontScale - APP_FONT_SCALE_STEP)} />
      <View style={styles.fontScalePreview}>
        <Text style={[styles.fontScaleValue, { color: colors.muted }]} localize>{Math.round(fontScale * 100)}%</Text>
        <Text style={[typography.body, { color: colors.text }]} localize>Navigation and chats resize immediately.</Text>
      </View>
      <IconButton icon={Plus} disabled={fontScale >= APP_FONT_SCALE_MAX} label="Increase app text size" onPress={() => setFontScale(fontScale + APP_FONT_SCALE_STEP)} />
    </View>
    <Text style={[styles.help, { color: colors.muted }]} localize>Applies to chats, navigation, settings, server management, and terminal text.</Text>
    </> : null}
    {page === 'language' ? <View accessibilityRole="radiogroup" style={styles.settingsCategories}>
      {languageOptions.map(({ value, label }) => <Pressable key={value} testID={`settings-language-${value}`} accessibilityRole="radio" accessibilityLabel={t(label)} accessibilityState={{ checked: languagePreference === value }} onPress={() => void setLanguagePreference(value)} style={({ pressed }) => [styles.settingsRow, { borderColor: colors.border, backgroundColor: pressed ? colors.raised : 'transparent' }]}>
        <Text style={[styles.settingsRowTitle, { color: colors.text }]}>{t(label)}</Text>
        {languagePreference === value ? <Check size={18} color={colors.green} /> : null}
      </Pressable>)}
      {languageError ? <Text accessibilityRole="alert" style={[styles.help, { color: colors.red }]}>{t(languageError)}</Text> : null}
    </View> : null}
    {page === 'chats' ? <>
    <Label text="New chat defaults" />
    <AgentPicker testID="settings-default-agent" label={chatBackendLabel(defaultChoice)} value={defaultChoice} choices={chatDefaultBackendOptions} onChange={value => { if (chatDefaultBackendOptions.includes(value)) setChatDefaults({ ...chatBackendSelection(value), model: '', effort: '' }) }} style={[styles.select, { gap: spacing.sm, backgroundColor: colors.raised, borderColor: colors.border }]}>
      <BackendMark backend={chatDefaults.backend} size={22} />
      <Text style={[typography.body, { color: colors.text, flex: 1 }]} numberOfLines={1}>{chatBackendLabel(defaultChoice)}</Text>
      <ChevronDown size={15} color={colors.muted} />
    </AgentPicker>
    {!chatDefaultBackendOptions.includes(defaultChoice) ? <Text style={[styles.help, { color: colors.muted }]} localize>This agent is unavailable. Check My agents.</Text> : null}
    <Label text="Model" /><Select testID="settings-default-model" title="Choose model" value={chatDefaults.model} options={chatDefaultModelOptions} onChange={next => setChatDefaults({ model: next, effort: runtimeEffortAfterModelChange(defaultCatalog, chatDefaults.backend, next, chatDefaults.effort) ?? '' })} />
    {isCustomProvider(chatDefaults) ? <><Label text="Model ID (optional)" /><TextInput testID="settings-default-api-model" value={chatDefaults.model} onChangeText={model => setChatDefaults({ model, effort: '' })} autoCapitalize="none" autoCorrect={false} placeholder="default" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} /></> : null}
    <Label text="Folder" /><TextInput testID="settings-default-folder" accessibilityLabel="Default folder" value={defaultFolder} onChangeText={setDefaultFolder} onBlur={() => setChatDefaults({ folder: defaultFolder.trim() || 'General' })} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Working directory" /><TextInput
      testID="settings-default-cwd"
      accessibilityLabel="Default working directory"
      value={defaultCwd}
      onChangeText={setDefaultCwd}
      onBlur={() => setChatDefaults({ cwd: defaultCwd.trim() })}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={defaultServerCwd || 'Server default'}
      placeholderTextColor={colors.muted}
      style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]}
    />
    </> : null}
    {page === 'agents' ? <MyAgentsSettings /> : null}
    {page === 'updates' && Platform.OS === 'android' ? <AndroidUpdateSettings /> : null}
    {page === 'updates' && Platform.OS === 'ios' ? <AppleUpdateSettings /> : null}
    {page === 'analytics' && Platform.OS === 'android' ? <AnalyticsSettings visible={visible} /> : null}
  </Sheet>
}

type SettingsPage = 'home' | 'appearance' | 'language' | 'chats' | 'agents' | 'analytics' | 'updates'
const settingsTitles: Record<SettingsPage, string> = { home: 'Settings', appearance: 'Appearance', language: 'Language', chats: 'New chat defaults', agents: 'My agents', analytics: 'Usage analytics', updates: 'App updates' }
const themeLabels: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const themeOptions: { value: ThemePreference; icon: LucideIcon }[] = [{ value: 'system', icon: Monitor }, { value: 'light', icon: Sun }, { value: 'dark', icon: Moon }]
const languageOptions: { value: LanguagePreference; label: string }[] = [{ value: 'system', label: 'System' }, { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]

function SettingsHeading({ title }: { title: string }) {
  const colors = usePalette()
  return <Text accessibilityRole="header" style={[styles.settingsHeading, { color: colors.muted }]}>{t(title)}</Text>
}

function SettingsRow({ icon: Icon, title, value, onPress, testID, external = false }: { icon: LucideIcon; title: string; value?: string; onPress: () => void; testID: string; external?: boolean }) {
  const colors = usePalette()
  const TrailingIcon = external ? ExternalLink : ChevronRight
  return <Pressable testID={testID} accessibilityRole={external ? 'link' : 'button'} accessibilityLabel={t(title)} accessibilityValue={value ? { text: value } : undefined} onPress={onPress} style={({ pressed }) => [styles.settingsRow, { borderColor: colors.border, backgroundColor: pressed ? colors.raised : 'transparent' }]}>
    <Icon size={20} color={colors.text} />
    <Text style={[styles.settingsRowTitle, { color: colors.text }]}>{t(title)}</Text>
    {value ? <Text numberOfLines={1} style={[styles.settingsRowValue, { color: colors.muted }]}>{value}</Text> : null}
    <TrailingIcon size={16} color={colors.muted} />
  </Pressable>
}

interface ConnectionBinding {
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  connectionReady: boolean
}

interface SearchDialogProps {
  visible: boolean
  sessionId?: string
  onClose: () => void
}

export function SearchDialog(props: SearchDialogProps) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  return <ScopedSearchDialog
    key={`${connectionKey}:${props.sessionId ?? 'global'}`}
    {...props}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedSearchDialog({ visible, sessionId, onClose, connection, connectionKey, activeProfileId, profileGeneration, connectionReady }: SearchDialogProps & ConnectionBinding) {
  const colors = usePalette()
  const searchInput = useRef<TextInput>(null)
  const sessions = useAppStore(state => state.sessions)
  const select = useAppStore(state => state.selectSession)
  const seekTimelineResult = useAppStore(state => state.seekTimelineResult)
  const cancelTimelineSeek = useAppStore(state => state.cancelTimelineSeek)
  const openingResult = useRef(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Awaited<ReturnType<typeof client.searchTimeline>>>([])
  const [busy, setBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const [openingResultId, setOpeningResultId] = useState<string | null>(null)
  useEffect(() => {
    if (openingResult.current) cancelTimelineSeek()
    setQuery('')
    setResults([])
    setBusy(false)
    setSearchError(null)
    setOpeningResultId(null)
    openingResult.current = false
  }, [activeProfileId, cancelTimelineSeek, profileGeneration])
  useEffect(() => {
    if (!visible || !connectionReady) {
      if (openingResult.current) cancelTimelineSeek()
      setQuery('')
      setResults([])
      setBusy(false)
      setSearchError(null)
      setOpeningResultId(null)
      openingResult.current = false
      return
    }
    const clean = serverSearchQuery(query)
    if (!clean) { setResults([]); setBusy(false); setSearchError(null); return }
    let cancelled = false
    setResults([])
    setSearchError(null)
    const timer = setTimeout(() => {
      if (!connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
      setBusy(true)
      const request = sessionId ? connection.searchTimeline(sessionId, clean) : connection.searchSessions(clean)
      void request
        .then(value => { if (!cancelled && connectionIsCurrent(connection, activeProfileId, profileGeneration)) { setResults(value); setSearchError(null) } })
        .catch(error => { if (!cancelled && connectionIsCurrent(connection, activeProfileId, profileGeneration)) { setResults([]); setSearchError(dialogError(error)) } })
        .finally(() => { if (!cancelled && connectionIsCurrent(connection, activeProfileId, profileGeneration)) setBusy(false) })
    }, 230)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activeProfileId, cancelTimelineSeek, connection, connectionReady, profileGeneration, query, searchRevision, sessionId, visible])
  const nameMatches = useMemo(() => sessionId ? [] : sessions.filter(value => value.title.toLowerCase().includes(query.trim().toLowerCase())), [query, sessionId, sessions])
  const resultRows = results.filter(result => !nameMatches.some(session => session.id === result.session_id))
  const cancelOpeningResult = () => {
    if (!openingResult.current) return
    openingResult.current = false
    cancelTimelineSeek()
    setOpeningResultId(null)
  }
  const closeSearch = () => {
    cancelOpeningResult()
    onClose()
  }
  const openSession = (id: string) => {
    if (!connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
    dismissAppKeyboard()
    void select(id)
    onClose()
  }
  const openTimelineResult = async (result: TimelineSearchResult) => {
    if (openingResult.current || !connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
    openingResult.current = true
    dismissAppKeyboard()
    setOpeningResultId(result.event_id)
    try {
      const opened = await seekTimelineResult(result, profileGeneration)
      if (opened && connectionIsCurrent(connection, activeProfileId, profileGeneration)) {
        openingResult.current = false
        setOpeningResultId(null)
        onClose()
        return
      }
    } catch {
      // The store normally reports failures in the global error slot. Keep the
      // sheet usable if an unexpected storage or selection failure escapes.
    }
    if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) {
      openingResult.current = false
      setOpeningResultId(null)
    }
  }
  return <Sheet key={connectionKey} visible={visible} title={sessionId ? 'Find in chat' : 'Search'} onClose={closeSearch} onShow={() => searchInput.current?.focus()} wide>
    {connectionReady ? <>
      <View style={[styles.searchBox, { backgroundColor: colors.raised, borderColor: colors.border }]}><Search size={16} color={colors.muted} /><TextInput ref={searchInput} value={query} onChangeText={value => { setResults([]); setBusy(false); setSearchError(null); setQuery(value) }} accessibilityLabel="Search names and complete chat history" placeholder="Search names and complete chat history" placeholderTextColor={colors.muted} returnKeyType="search" submitBehavior="blurAndSubmit" onSubmitEditing={dismissAppKeyboard} clearButtonMode={Platform.OS === 'ios' ? 'while-editing' : 'never'} style={{ flex: 1, color: colors.text, fontSize: 14 }} />{busy || openingResultId ? <ActivityIndicator size="small" color={colors.blue} /> : null}</View>
      {searchError ? <View accessibilityRole="alert" style={styles.searchFailure}>
        <Text style={[styles.searchFailureText, { color: colors.red }]} numberOfLines={2} localize>History search failed. {searchError}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry history search"
          testID="search-dialog-retry"
          onPress={() => setSearchRevision(value => value + 1)}
          style={({ pressed }) => [styles.searchFailureRetry, { borderColor: colors.red, opacity: pressed ? 0.6 : 1 }]}
        ><Text style={{ color: colors.red, fontSize: 12, fontWeight: '800' }} localize>Retry</Text></Pressable>
      </View> : null}
      <ScrollView style={{ maxHeight: 500 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" alwaysBounceVertical={Platform.OS === 'ios'} onScrollBeginDrag={dismissAppKeyboard}>
        {nameMatches.map(session => <SearchResult key={`${connectionKey}:name:${session.id}`} title={session.title} subtitle="Chat name" disabled={Boolean(openingResultId)} onPress={() => openSession(session.id)} />)}
        {resultRows.map(result => <SearchResult key={`${connectionKey}:${result.session_id}:${result.event_id}`} title={sessions.find(value => value.id === result.session_id)?.title ?? 'Chat'} subtitle={result.snippet} disabled={Boolean(openingResultId)} onPress={() => void openTimelineResult(result)} />)}
        {query.trim() && !busy && !searchError && !nameMatches.length && !resultRows.length ? <Text style={[styles.empty, { color: colors.muted }]} localize>No matches</Text> : null}
      </ScrollView>
    </> : <ConnectionUnavailable />}
  </Sheet>
}

interface DigestDialogProps {
  visible: boolean
  source: Session | null
  onClose: () => void
}

export function DigestDialog(props: DigestDialogProps) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  return <ScopedDigestDialog
    key={`${connectionKey}:${props.source?.id ?? 'none'}`}
    {...props}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedDigestDialog({ visible, source, onClose, connection, connectionKey, activeProfileId, profileGeneration, connectionReady }: DigestDialogProps & ConnectionBinding) {
  const colors = usePalette()
  const operationRef = useRef(0)
  const allSessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const sections = useMemo(
    () => orderedSessionSections(allSessions.filter(value => value.id !== source?.id), folderOrder, false),
    [allSessions, folderOrder, source?.id],
  )
  const sessions = useMemo(() => sections.flatMap(section => section.sessions), [sections])
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('normal')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [phase, setPhase] = useState<'idle' | 'preview' | 'send'>('idle')
  const [status, setStatus] = useState('')
  useEffect(() => {
    operationRef.current += 1
    setTarget('')
    setDetail('normal')
    setPrompt('')
    setPreview('')
    setStatus('')
    setPhase('idle')
  }, [activeProfileId, profileGeneration, source?.id, visible])
  useEffect(() => {
    if (visible && !sessions.some(value => value.id === target)) setTarget(sessions[0]?.id ?? '')
  }, [sessions, target, visible])
  if (!source) return null
  const busy = phase !== 'idle'
  const generate = async () => {
    if (!connectionReady || !target) return
    const operation = ++operationRef.current
    const isCurrent = () => operationRef.current === operation
      && visible
      && connectionIsCurrent(connection, activeProfileId, profileGeneration)
    setPhase('preview'); setStatus('Summarizing the source chat with its agent…')
    try {
      const value = await connection.previewDigest(source.id, target, detail, prompt)
      if (isCurrent()) {
        setPreview(value)
        setStatus(`${value.length.toLocaleString()} character preview`)
      }
    } catch (error) {
      if (isCurrent()) setStatus(dialogError(error))
    } finally {
      if (isCurrent()) setPhase('idle')
    }
  }
  const send = async () => {
    if (!connectionReady || !target) return
    const operation = ++operationRef.current
    const isCurrent = () => operationRef.current === operation
      && visible
      && connectionIsCurrent(connection, activeProfileId, profileGeneration)
    setPhase('send'); setStatus('Starting the digest turn in the source chat…')
    try {
      await connection.sendDigest(source.id, target, detail, prompt)
      if (isCurrent()) {
        onClose()
        requestAnimationFrame(dismissAppKeyboard)
      }
    } catch (error) {
      if (isCurrent()) setStatus(dialogError(error))
    } finally {
      if (isCurrent()) setPhase('idle')
    }
  }
  return <Sheet key={connectionKey} visible={visible} title="Create digest" onClose={onClose} wide>
    {connectionReady ? <>
      <View style={[styles.digestSource, { backgroundColor: colors.raised, borderColor: colors.border }]}><BackendMark backend={source.backend} size={20} /><View style={{ flex: 1 }}><Text style={{ color: colors.muted, fontSize: 10, fontWeight: '800' }} localize>SOURCE CHAT</Text><Text style={{ color: colors.text, fontSize: 13, fontWeight: '800' }} numberOfLines={1}>{source.title}</Text></View></View>
      <Label text="Target chat" /><Select title="Choose target chat" testID="digest-target" value={target} options={sections.flatMap(section => section.sessions.map(value => ({ value: value.id, label: `${section.title} · ${value.title}` })))} onChange={setTarget} />
      <Label text="Detail" /><Select title="Choose digest detail" testID="digest-detail" value={detail} options={[{ value: 'short', label: 'Short' }, { value: 'normal', label: 'Normal' }, { value: 'deep', label: 'Deep' }]} onChange={value => { setDetail(value); setPreview(''); setStatus('') }} />
      <Label text="Prompt for target agent" /><TextInput testID="digest-prompt" accessibilityLabel="Prompt for target agent" value={prompt} onChangeText={value => { setPrompt(value); if (preview) setStatus('Prompt changed · refresh the preview before sending') }} multiline placeholder="What should the target agent focus on?" placeholderTextColor={colors.muted} style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
      {preview ? <ScrollView style={[styles.preview, { backgroundColor: colors.raised }]}><Text selectable style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{preview}</Text></ScrollView> : null}
      <View style={styles.statusRow}>{busy ? <ActivityIndicator size="small" color={colors.blue} /> : null}<Text style={{ flex: 1, color: status && !busy && !preview ? colors.red : colors.muted, fontSize: 11 }}>{status || 'The source chat agent creates one focused handoff turn.'}</Text></View>
      <View style={styles.buttonRow}><SecondaryButton testID="digest-preview" label={phase === 'preview' ? 'Working…' : 'Preview'} disabled={busy || !target} onPress={() => void generate()} /><PrimaryButton testID="digest-send" label={phase === 'send' ? 'Sending…' : 'Send to chat'} disabled={busy || !target} onPress={() => void send()} /></View>
    </> : <ConnectionUnavailable />}
  </Sheet>
}

export function JobDialog({ visible, session, jobId, onClose }: { visible: boolean; session: Session | null; jobId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const { width } = useWindowDimensions()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const jobs = useAppStore(state => state.jobs)
  const create = useAppStore(state => state.createJob)
  const update = useAppStore(state => state.updateJob)
  const clearError = useAppStore(state => state.clearError)
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const sessions = useAppStore(state => state.sessions)
  const job = jobs.find(value => value.id === jobId) ?? null
  const [title, setTitle] = useState('Status check')
  const [prompt, setPrompt] = useState('Check the current status and report meaningful changes.')
  const [interval, setIntervalValue] = useState('3600')
  const [scheduleKind, setScheduleKind] = useState<JobScheduleKind>('interval')
  const [cronExpression, setCronExpression] = useState('0 * * * *')
  const [rrule, setRRule] = useState('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [startMode, setStartMode] = useState<JobStartMode>('interval')
  const [loop, setLoop] = useState(true)
  const [maxRuns, setMaxRuns] = useState('1')
  const [start, setStart] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [backend, setBackend] = useState<Backend>('codex')
  const [contextMode, setContextMode] = useState<JobContextMode>('chat')
  const [chatReferences, setChatReferences] = useState<ChatReference[]>([])
  const [jobMention, setJobMention] = useState<ChatMentionTrigger | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [androidStartPicker, setAndroidStartPicker] = useState<'date' | 'time' | null>(null)
  const savingRef = useRef(false)
  const saveEpoch = useRef(0)
  const startRef = useRef('')
  const startModeRef = useRef<JobStartMode>('interval')
  useEffect(() => {
    saveEpoch.current += 1
    savingRef.current = false
    setAndroidStartPicker(null)
    if (!visible) return
    setTitle(job?.title ?? 'Status check')
    setPrompt(job?.prompt ?? 'Check the current status and report meaningful changes.')
    setIntervalValue(String(job?.interval_seconds ?? 3600))
    setScheduleKind(job ? effectiveScheduleKind(job) : 'interval')
    setCronExpression(job?.cron_expression ?? '0 * * * *')
    setRRule(job?.rrule ?? 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
    setTimezone(job?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
    const nextStartMode = job ? 'keep' : 'interval'
    startModeRef.current = nextStartMode
    setStartMode(nextStartMode)
    setLoop(job ? jobLoopsForever(job) : true)
    setMaxRuns(String(job?.max_runs ?? 1))
    const kind = job ? effectiveScheduleKind(job) : 'interval'
    const nextStart = formatScheduleWallTime(job?.next_run_at_iso ?? job?.first_run_at ?? job?.next_run_at, kind, job?.timezone)
    startRef.current = nextStart
    setStart(nextStart)
    setEnabled(job?.enabled ?? true)
    setBackend(job?.backend ?? session?.backend ?? 'codex')
    setContextMode(job?.context_mode ?? 'chat')
    setChatReferences(job ? parseStoredChatReferences(job.chat_references, job.prompt, job.session_id) : [])
    setJobMention(null)
    setSaving(false)
    setStatus('')
  }, [job?.id, session?.backend, session?.id, visible])
  if (!session) return null
  const scopeIsCurrent = () => {
    const state = useAppStore.getState()
    return state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && state.selectedSessionId === session.id
  }
  const intervalSeconds = Math.max(10, Number(interval) || 3600)
  const supportsIndependentRuns = health?.capabilities?.scheduled_jobs?.context_modes?.includes('standalone') === true || job?.context_mode === 'standalone'
  const supportedBackends = selectableChatBackends(health)
  const selectedBackend = contextMode === 'chat' ? session.backend : backend
  const backendOptions = contextMode === 'chat'
    ? [session.backend]
    : supportedBackends.includes(backend) ? supportedBackends : [...supportedBackends, backend]
  const runtimeError = runtimeSelectionError(health, runtime, selectedBackend, selectedBackend === session.backend ? session.model : null)
  const scheduledRouteHintsSupported = scheduledJobRouteHintsAvailable(health)
  const targetBackends = supportedCrossChatTargetBackends(health)
  const targetQuery = jobMention?.query.trim().toLocaleLowerCase() ?? ''
  const targetCandidates = jobMention && scheduledRouteHintsSupported
    ? sessions.filter(candidate => (
      candidate.id !== session.id
      && !candidate.archived
      && targetBackends.includes(candidate.backend)
      && (!targetQuery || `${candidate.title} ${candidate.folder ?? ''} ${candidate.id}`.toLocaleLowerCase().includes(targetQuery))
    )).slice(0, 8)
    : []
  const scheduleError = validateJobSchedule(scheduleKind, { intervalSeconds: Number(interval), cronExpression, rrule, timezone })
  const selectIntervalPreset = (value: number) => {
    setIntervalValue(String(value))
    dismissAppKeyboard()
  }
  const updateStart = (value: string) => {
    startRef.current = value
    setStart(value)
    setStatus('')
  }
  const selectStartMode = (value: JobStartMode) => {
    startModeRef.current = value
    setStartMode(value)
    setAndroidStartPicker(null)
    setStatus('')
    if (value === 'time' && !parseScheduleWallTime(startRef.current, scheduleKind)) {
      updateStart(defaultScheduleWallTime(new Date(), scheduleKind, timezone))
    }
    if (value !== 'keep') setEnabled(true)
    dismissAppKeyboard()
  }
  const pickerDate = scheduleWallTimePickerDate(start)
  const androidPickerDate = androidStartPicker === 'date' ? scheduleWallTimeAndroidDatePickerDate(start, pickerDate) : pickerDate
  const compactIOSPicker = Platform.OS === 'ios' && width < 600
  const applyPickerValue = (part: 'date' | 'time', value: Date, androidUtcDate = false) => {
    updateStart(mergeScheduleWallTimePickerValue(startRef.current, value, part, androidUtcDate))
  }
  const startError = validateJobNextRun(Boolean(job), startMode, start, scheduleKind, enabled)
  const updateJobPrompt = (value: string) => {
    const nextReferences = reconcileChatReferences(prompt, value, chatReferences)
    setPrompt(value)
    setChatReferences(nextReferences)
    setJobMention(scheduledRouteHintsSupported ? chatMentionTrigger(value, value.length, nextReferences) : null)
  }
  const chooseJobTarget = (target: Session) => {
    if (!jobMention || !scheduledRouteHintsSupported) return
    if (chatReferences.length >= MAX_SCHEDULED_CHAT_REFERENCES) {
      setStatus(`A scheduled job can route to at most ${MAX_SCHEDULED_CHAT_REFERENCES} chats.`)
      return
    }
    if (chatReferences.some(reference => reference.session_id === target.id && reference.action === 'route')) {
      setStatus(`${target.title} is already selected for this job.`)
      setJobMention(null)
      return
    }
    try {
      const inserted = insertChatReference(prompt, jobMention, target, 'route')
      const shifted = reconcileChatReferences(prompt, inserted.text, chatReferences)
      setPrompt(inserted.text)
      setChatReferences([...shifted, inserted.reference].sort((left, right) => left.source_text_start - right.source_text_start))
      setJobMention(null)
      setStatus('')
    } catch (error) {
      setStatus(dialogError(error))
    }
  }
  const revokeJobTarget = (reference: ChatReference) => {
    setChatReferences(current => current.filter(candidate => candidate !== reference))
    setJobMention(null)
  }
  const submit = async () => {
    if (savingRef.current || !scopeIsCurrent() || scheduleError) return
    if (startError) { setStatus(startError); return }
    if (enabled && runtimeError) { setStatus(runtimeError); return }
    let scheduledTime: string | null = null
    const submittedStartMode = startModeRef.current
    if (submittedStartMode === 'immediate') scheduledTime = new Date().toISOString()
    else if (submittedStartMode === 'time') {
      scheduledTime = parseScheduleWallTime(startRef.current, scheduleKind)
      if (!scheduledTime) { setStatus('Choose a valid date and time.'); return }
    }
    const cleanPrompt = prompt.trim()
    const leadingWhitespace = prompt.length - prompt.trimStart().length
    const storedReferences = job ? parseStoredChatReferences(job.chat_references, job.prompt, job.session_id) : []
    if (job?.chat_references?.length && storedReferences.length !== job.chat_references.length) {
      setStatus('This job contains a stored chat route that mobile cannot validate. Update it from the Mac app or remove the route there before editing on mobile.')
      return
    }
    if (chatReferences.length > MAX_SCHEDULED_CHAT_REFERENCES) {
      setStatus(`A scheduled job can route to at most ${MAX_SCHEDULED_CHAT_REFERENCES} chats.`)
      return
    }
    const normalizedReferences = normalizeScheduledJobChatReferences(
      cleanPrompt,
      chatReferences.map(reference => ({
        ...reference,
        source_text_start: reference.source_text_start - leadingWhitespace,
        source_text_end: reference.source_text_end - leadingWhitespace,
      })),
      session.id,
    )
    const writableReferences = scheduledJobChatReferencesForWrite(health, normalizedReferences)
    if (scheduledRouteHintsSupported && normalizedReferences.length !== chatReferences.length) {
      setStatus('A scheduled @Chat route was edited or is no longer valid. Remove it and select the chat again.')
      return
    }
    if (!scheduledRouteHintsSupported && storedReferences.length > 0 && (
      cleanPrompt !== job?.prompt
      || JSON.stringify(chatReferences) !== JSON.stringify(storedReferences)
    )) {
      setStatus('This server does not advertise scheduled @Chat routes. Existing routes are preserved, but their prompt or targets cannot be edited on mobile until AgentsServer is updated.')
      return
    }
    const scheduleFields = jobScheduleFields(scheduleKind, { intervalSeconds, cronExpression, rrule, timezone })
    const body: CreateJobInput = {
      session_id: session.id,
      title: title.trim(),
      prompt: cleanPrompt,
      ...(writableReferences ? { chat_references: writableReferences } : {}),
      ...scheduleFields,
      first_run_at: scheduledTime,
      loop,
      max_runs: loop ? null : Math.min(999, Math.max(1, Number(maxRuns) || 1)),
      enabled,
      context_mode: supportsIndependentRuns ? contextMode : undefined,
      backend: selectedBackend,
      model: selectedBackend === session.backend ? session.model : null,
      effort: selectedBackend === session.backend ? session.effort : null,
    }
    const operationEpoch = ++saveEpoch.current
    clearError()
    savingRef.current = true
    setSaving(true); setStatus(job ? 'Saving scheduled job…' : 'Creating scheduled job…')
    let saved = false
    try {
      if (job) {
        const scheduleKindChanged = scheduleKind !== effectiveScheduleKind(job)
        const patch: UpdateJobInput = jobScheduleUpdatePatch(job, scheduleFields)
        if (body.title !== job.title) patch.title = body.title
        if (body.prompt !== job.prompt) patch.prompt = body.prompt
        if (writableReferences && JSON.stringify(writableReferences) !== JSON.stringify(storedReferences)) patch.chat_references = writableReferences
        if (scheduleKind === 'interval' && (scheduleKindChanged || loop !== Boolean(job.loop))) patch.loop = loop
        if (body.max_runs !== (job.max_runs ?? null)) patch.max_runs = body.max_runs
        if (enabled !== (job.enabled ?? true)) patch.enabled = enabled
        if (supportsIndependentRuns && contextMode !== (job.context_mode ?? 'chat')) patch.context_mode = contextMode
        if (selectedBackend !== (job.backend ?? session.backend)) patch.backend = selectedBackend
        Object.assign(patch, jobNextRunUpdatePatch({
          mode: submittedStartMode,
          scheduleKind,
          intervalSeconds,
          scheduledTime,
        }))
        saved = await update(job.id, patch, profileGeneration)
      } else {
        saved = await create(body, profileGeneration)
      }
    } catch {
      saved = false
    }
    if (saveEpoch.current !== operationEpoch || !scopeIsCurrent()) return
    savingRef.current = false
    setSaving(false)
    if (saved) {
      onClose()
      requestAnimationFrame(dismissAppKeyboard)
    } else {
      const serverError = useAppStore.getState().error
      setStatus(serverError || 'The server did not save this scheduled job. Check the connection and try again.')
    }
  }
  return <Sheet visible={visible} title={job ? 'Edit job' : 'Schedule job'} onClose={onClose} dismissable={!saving} keyboardShouldPersistTaps="always" wide>
    <Label text="Title" /><TextInput testID="job-title" accessibilityLabel="Job title" value={title} onChangeText={setTitle} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text="Backend" /><View style={styles.segment}>{backendOptions.map(value => { const unavailable = value === 'cursor' && Boolean(runtimeSelectionError(health, runtime, value, value === session.backend ? session.model : null)); return <Pressable key={value} accessibilityRole="button" accessibilityLabel={`${backendLabel(value)}${unavailable ? ', unavailable' : ''}`} accessibilityState={{ selected: selectedBackend === value, disabled: unavailable }} disabled={unavailable} onPress={() => setBackend(value)} style={[styles.segmentButton, { backgroundColor: selectedBackend === value ? colors.blue : colors.raised, opacity: unavailable ? 0.4 : 1 }]}><BackendMark backend={value} size={20} /><Text style={{ color: selectedBackend === value ? 'white' : colors.text, fontWeight: '700' }}>{backendLabel(value)}</Text></Pressable> })}</View>
    <Label text="Run context" /><View style={styles.modeRow}><ModeButton label="This chat" selected={contextMode === 'chat'} onPress={() => { setContextMode('chat'); setBackend(session.backend) }} />{supportsIndependentRuns ? <ModeButton label="Independent" selected={contextMode === 'standalone'} onPress={() => setContextMode('standalone')} /> : null}</View>
    {runtimeError ? <Text accessibilityRole="alert" style={[styles.help, { color: colors.orange }]} localize>{runtimeError}{enabled ? ' Pause this job or choose an available runtime before saving.' : ''}</Text> : null}
    <Label text="Schedule" /><View style={styles.modeRow}>{(['interval', 'cron', 'rrule'] as JobScheduleKind[]).map(value => <ModeButton key={value} testID={`job-schedule-kind-${value}`} label={value === 'rrule' ? 'RRULE' : value[0].toUpperCase() + value.slice(1)} selected={scheduleKind === value} onPress={() => setScheduleKind(value)} />)}</View>
    {scheduleKind === 'interval' ? <>
      <Label text="Interval" />
      <View testID="job-interval-presets" style={styles.presetRow}>{JOB_INTERVAL_PRESETS_SECONDS.map(value => {
        const selected = interval === String(value)
        return <Pressable
          key={value}
          testID={`job-interval-preset-${value}`}
          accessibilityRole="button"
          accessibilityLabel={`${intervalLabel(value)} interval`}
          accessibilityState={{ selected }}
          onPress={() => selectIntervalPreset(value)}
          style={({ pressed }) => [styles.preset, { backgroundColor: selected ? colors.blue : colors.raised, opacity: pressed ? 0.68 : 1 }]}
        ><Text style={{ color: selected ? 'white' : colors.text, fontSize: 11 }}>{intervalLabel(value)}</Text></Pressable>
      })}</View>
      <Label text="Custom seconds" /><TextInput testID="job-interval" accessibilityLabel="Job interval seconds" value={interval} onChangeText={setIntervalValue} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    </> : scheduleKind === 'cron' ? <>
      <Label text="Cron expression" /><TextInput testID="job-cron-expression" accessibilityLabel="Cron expression" value={cronExpression} onChangeText={setCronExpression} autoCapitalize="none" autoCorrect={false} placeholder="0 9 * * 1-5" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
      <Text style={[styles.help, { color: colors.muted }]} localize>Unix cron: 5 fields; 6–7 fields add seconds first and optional year last. @hourly and @daily aliases work.</Text>
    </> : <>
      <Label text="RRULE" /><TextInput testID="job-rrule" accessibilityLabel="RRULE" value={rrule} onChangeText={setRRule} multiline autoCapitalize="characters" autoCorrect={false} placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0" placeholderTextColor={colors.muted} style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
      <Text style={[styles.help, { color: colors.muted }]} localize>RFC 5545 recurrence rule. The RRULE: prefix is optional.</Text>
    </>}
    {scheduleKind !== 'interval' ? <><Label text="Timezone" /><TextInput testID="job-timezone" accessibilityLabel="Schedule timezone" value={timezone} onChangeText={setTimezone} autoCapitalize="none" autoCorrect={false} placeholder="America/Los_Angeles" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /></> : null}
    <Text style={[styles.help, { color: scheduleError ? colors.red : colors.muted }]}>{scheduleError ?? (scheduleKind === 'interval' ? 'Runs relative to the previous scheduled time.' : 'The server validates the full expression when you save.')}</Text>
    <Label text={job ? 'Next run' : 'First run'} />
    <View style={styles.modeRow}>{job ? <ModeButton testID="job-start-mode-keep" label="Keep" selected={startMode === 'keep'} onPress={() => selectStartMode('keep')} /> : null}<ModeButton testID="job-start-mode-immediate" label="Now" selected={startMode === 'immediate'} onPress={() => selectStartMode('immediate')} /><ModeButton testID="job-start-mode-interval" label={scheduleKind === 'interval' ? 'After interval' : 'Next match'} selected={startMode === 'interval'} onPress={() => selectStartMode('interval')} /><ModeButton testID="job-start-mode-time" label={scheduleKind === 'interval' ? 'At a time' : 'At a time, then schedule'} selected={startMode === 'time'} onPress={() => selectStartMode('time')} /></View>
    {startMode === 'time' ? <>
      <View testID="job-start-picker" onTouchStart={dismissAppKeyboard} style={[styles.jobStartPicker, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        {Platform.OS === 'ios' ? compactIOSPicker ? <>
          <View style={[styles.jobStartPickerControl, styles.jobStartPickerControlPhone]}>
            <View style={styles.jobStartPickerHeading}><Calendar size={16} color={colors.muted} /><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Date</Text></View>
            <DateTimePicker style={styles.jobStartPickerNativePhone} testID="job-start-date-picker" value={pickerDate} mode="date" display="compact" accentColor={colors.blue} onValueChange={(_event, value) => applyPickerValue('date', value)} />
          </View>
          <View style={[styles.jobStartPickerControl, styles.jobStartPickerControlPhone]}>
            <View style={styles.jobStartPickerHeading}><Clock size={16} color={colors.muted} /><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Time</Text></View>
            <DateTimePicker style={styles.jobStartPickerNativePhone} testID="job-start-time-picker" value={pickerDate} mode="time" display="compact" accentColor={colors.blue} onValueChange={(_event, value) => applyPickerValue('time', value)} />
          </View>
        </> : <>
          <View style={styles.jobStartPickerControl}><Calendar size={16} color={colors.muted} /><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Date</Text><DateTimePicker testID="job-start-date-picker" value={pickerDate} mode="date" display="compact" accentColor={colors.blue} onValueChange={(_event, value) => applyPickerValue('date', value)} /></View>
          <View style={styles.jobStartPickerControl}><Clock size={16} color={colors.muted} /><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Time</Text><DateTimePicker testID="job-start-time-picker" value={pickerDate} mode="time" display="compact" accentColor={colors.blue} onValueChange={(_event, value) => applyPickerValue('time', value)} /></View>
        </> : <>
          <Pressable testID="job-start-date-button" accessibilityRole="button" accessibilityLabel="Choose job start date" onPress={() => { dismissAppKeyboard(); setAndroidStartPicker('date') }} style={({ pressed }) => [styles.jobStartPickerButton, { opacity: pressed ? 0.65 : 1 }]}><Calendar size={17} color={colors.blue} /><View style={{ flex: 1 }}><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Date</Text><Text style={[styles.jobStartPickerValue, { color: colors.text }]}>{pickerDate.toLocaleDateString([], { dateStyle: 'medium' })}</Text></View></Pressable>
          <Pressable testID="job-start-time-button" accessibilityRole="button" accessibilityLabel="Choose job start time" onPress={() => { dismissAppKeyboard(); setAndroidStartPicker('time') }} style={({ pressed }) => [styles.jobStartPickerButton, { opacity: pressed ? 0.65 : 1 }]}><Clock size={17} color={colors.blue} /><View style={{ flex: 1 }}><Text style={[styles.jobStartPickerLabel, { color: colors.muted }]} localize>Time</Text><Text style={[styles.jobStartPickerValue, { color: colors.text }]}>{pickerDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text></View></Pressable>
        </>}
      </View>
      <Text testID="job-start-value" style={[styles.help, { color: startError ? colors.red : colors.muted }]}>{startError ?? `${start}${scheduleKind === 'interval' ? '' : ` · ${timezone.trim() || 'selected timezone'}`}`}</Text>
      {Platform.OS === 'android' && androidStartPicker ? <DateTimePicker
        key={`job-start-${androidStartPicker}`}
        testID={`job-start-${androidStartPicker}-picker`}
        value={androidPickerDate}
        mode={androidStartPicker}
        presentation="dialog"
        display="default"
        is24Hour={false}
        accentColor={colors.blue}
        positiveButton={{ label: 'Set' }}
        negativeButton={{ label: 'Cancel' }}
        onValueChange={(_event, value) => {
          const part = androidStartPicker
          applyPickerValue(part, value, part === 'date')
          setAndroidStartPicker(null)
        }}
        onDismiss={() => setAndroidStartPicker(null)}
      /> : null}
    </> : <Text style={[styles.help, { color: colors.muted }]}>{startMode === 'keep' ? `Keeps ${job?.next_run_at_iso ? new Date(job.next_run_at_iso).toLocaleString() : 'the current schedule'}.` : startMode === 'immediate' ? 'Runs once as soon as the scheduler can launch it, then follows the schedule.' : scheduleKind === 'interval' ? `${job ? 'Resets the next run and cadence anchor to' : 'First run is'} one interval from now.` : job ? 'Discards any one-time override and uses the next matching recurrence.' : 'The first run uses the next matching recurrence.'}</Text>}
    <Label text="Mode" /><View style={styles.modeRow}><ModeButton label={scheduleKind === 'interval' ? 'Run fixed times' : 'Limit total runs'} selected={!loop} onPress={() => setLoop(false)} /><ModeButton label={scheduleKind === 'interval' ? 'Loop forever' : 'No extra run limit'} selected={loop} onPress={() => setLoop(true)} /></View>
    {!loop ? <><Label text="Number of runs" /><TextInput testID="job-run-count" accessibilityLabel="Number of job runs" value={maxRuns} onChangeText={setMaxRuns} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /></> : null}
    <View style={styles.toggle}><Text style={{ color: colors.text, flex: 1 }} localize>Enabled</Text><Switch accessibilityLabel="Job enabled" value={enabled} onValueChange={setEnabled} /></View>
    <Label text="Prompt" /><TextInput
      testID="job-prompt"
      accessibilityLabel="Job prompt"
      value={prompt}
      onChangeText={updateJobPrompt}
      onFocus={() => setJobMention(scheduledRouteHintsSupported ? chatMentionTrigger(prompt, prompt.length, chatReferences) : null)}
      onSelectionChange={event => {
        const selection = event.nativeEvent.selection
        if (selection.start === selection.end) setJobMention(scheduledRouteHintsSupported ? chatMentionTrigger(prompt, selection.start, chatReferences) : null)
      }}
      multiline
      style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}
    />
    {chatReferences.length ? <View style={styles.jobReferenceChips}>{chatReferences.map(reference => <Pressable
      key={`${reference.session_id}:${reference.source_text_start}`}
      accessibilityRole="button"
      accessibilityLabel={`Remove scheduled route to ${reference.display_title_snapshot}`}
      disabled={!scheduledRouteHintsSupported}
      onPress={() => revokeJobTarget(reference)}
      style={[styles.jobReferenceChip, { backgroundColor: colors.raised, borderColor: colors.border, opacity: scheduledRouteHintsSupported ? 1 : 0.65 }]}
    ><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }} localize>@{reference.display_title_snapshot}</Text><Minus size={12} color={colors.muted} /></Pressable>)}</View> : null}
    {jobMention ? <View style={[styles.jobMentionPicker, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      {targetCandidates.length ? targetCandidates.map(candidate => <Pressable
        key={candidate.id}
        accessibilityRole="button"
        accessibilityLabel={`Route scheduled job to ${candidate.title}`}
        onPress={() => chooseJobTarget(candidate)}
        style={({ pressed }) => [styles.jobMentionOption, { opacity: pressed ? 0.6 : 1 }]}
      ><BackendMark backend={candidate.backend} size={16} /><View style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>{candidate.title}</Text><Text numberOfLines={1} style={{ color: colors.muted, fontSize: 10 }}>{candidate.folder || 'General'}</Text></View></Pressable>) : <Text style={[styles.help, { color: colors.muted }]} localize>No matching active chats.</Text>}
    </View> : null}
    <Text style={[styles.help, { color: scheduledRouteHintsSupported || !chatReferences.length ? colors.muted : colors.orange }]} localize>{scheduledRouteHintsSupported
      ? 'Type @Chat to give each scheduled occurrence an exact route to another active chat.'
      : chatReferences.length
        ? 'Stored @Chat routes are view-only and preserved. Update AgentsServer before changing this prompt or its routes on mobile.'
        : 'Update AgentsServer to add scheduled @Chat route hints.'}</Text>
    {status ? <Text accessibilityRole={saving ? undefined : 'alert'} style={{ color: saving ? colors.muted : colors.red, fontSize: 11 }}>{status}</Text> : null}
    <PrimaryButton testID="job-save" label={saving ? 'Saving…' : job ? 'Save job' : 'Schedule job'} disabled={saving || !title.trim() || !prompt.trim() || Boolean(scheduleError) || Boolean(startError)} onPress={() => void submit()} />
  </Sheet>
}

export function ProcessDialog({ visible, sessionId, onClose }: { visible: boolean; sessionId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const inspect = useAppStore(state => state.inspectProcesses)
  const snapshot = useAppStore(state => sessionId ? state.processes[sessionId] : undefined)
  useEffect(() => { if (visible && sessionId) void inspect(sessionId) }, [inspect, sessionId, visible])
  return <Sheet visible={visible} title="Live processes" onClose={onClose} wide>
    <ScrollView style={{ maxHeight: 560 }} keyboardShouldPersistTaps="always">{snapshot?.processes.length ? snapshot.processes.map(process => <View key={process.pid} style={[styles.process, { backgroundColor: colors.raised }]}><View style={[styles.processDot, { backgroundColor: colors.green }]} /><View style={{ flex: 1 }}><Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'Menlo' }}>{process.command || process.args}</Text><Text style={{ color: colors.muted, fontSize: 10 }} localize>{process.cwd} · pid {process.pid} · CPU {process.cpu_percent ?? 0}% · {Math.round((process.rss_kb ?? 0) / 1024)} MB</Text></View><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync([process.command || process.args, process.cwd].filter(Boolean).join('\n'))} label="Copy process" /></View>) : <Text style={[styles.empty, { color: colors.muted }]} localize>No live processes for this chat.</Text>}{snapshot?.stdout_tail?.text ? <View><View style={styles.outputHeader}><Text style={[styles.outputTitle, { color: colors.muted }]} localize>Live stdout</Text><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync(snapshot.stdout_tail?.text ?? '')} label="Copy stdout" /></View><Text selectable style={[styles.log, { color: colors.text, backgroundColor: '#090b0e' }]}>{snapshot.stdout_tail.text}</Text></View> : null}</ScrollView>
    <View style={styles.buttonRow}><SecondaryButton label="Refresh" onPress={() => sessionId && void inspect(sessionId)} /></View>
  </Sheet>
}

interface TmuxDialogProps {
  visible: boolean
  sessionId: string | null
  onClose: () => void
}

export function TmuxDialog(props: TmuxDialogProps) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  return <ScopedTmuxDialog
    key={`${connectionKey}:${props.sessionId ?? 'none'}`}
    {...props}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedTmuxDialog({ visible, sessionId, onClose, connection, connectionKey, activeProfileId, profileGeneration, connectionReady }: TmuxDialogProps & ConnectionBinding) {
  const colors = usePalette()
  const captureRef = useRef(0)
  const inspect = useAppStore(state => state.inspectTmux)
  const panes = useAppStore(state => sessionId ? state.tmuxPanes[sessionId] : undefined) ?? []
  const [includeAll, setIncludeAll] = useState(false)
  const [selectedPane, setSelectedPane] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    captureRef.current += 1
    setSelectedPane(null)
    setOutput('')
    setBusy(false)
    if (visible && connectionReady && sessionId) void inspect(sessionId, includeAll)
  }, [activeProfileId, connectionReady, includeAll, inspect, profileGeneration, sessionId, visible])
  const capture = async (paneId: string) => {
    if (!connectionReady || !sessionId) return
    const operation = ++captureRef.current
    const isCurrent = () => captureRef.current === operation
      && visible
      && connectionIsCurrent(connection, activeProfileId, profileGeneration)
    setSelectedPane(paneId); setBusy(true)
    try {
      const next = await connection.captureTmux(sessionId, paneId, 500)
      if (isCurrent()) setOutput(next)
    } catch (error) {
      if (isCurrent()) setOutput(dialogError(error))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  return <Sheet key={connectionKey} visible={visible} title="Tmux submitters" onClose={onClose} wide>
    {connectionReady ? <>
      <View style={styles.toggle}><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontWeight: '700' }} localize>Machine-wide panes</Text><Text style={{ color: colors.muted, fontSize: 10 }} localize>Off shows panes linked to this chat.</Text></View><Switch value={includeAll} onValueChange={setIncludeAll} /></View>
      <ScrollView style={{ maxHeight: selectedPane ? 280 : 520 }} keyboardShouldPersistTaps="always">
        {panes.length ? panes.map(pane => <Pressable key={`${connectionKey}:${pane.pane_id}`} accessibilityRole="button" accessibilityLabel={`Capture ${pane.session_name ?? 'tmux'} ${pane.window_name ?? pane.pane_index ?? pane.pane_id}`} accessibilityState={{ selected: selectedPane === pane.pane_id }} onPress={() => void capture(pane.pane_id)} style={[styles.process, { backgroundColor: selectedPane === pane.pane_id ? colors.raised : colors.surface, borderColor: colors.border }]}><View style={[styles.processDot, { backgroundColor: pane.dead ? colors.muted : colors.green }]} /><SquareTerminal size={15} color={colors.muted} /><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} localize>{pane.session_name ?? 'tmux'}:{pane.window_name ?? pane.pane_index ?? pane.pane_id}</Text><Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 3 }} numberOfLines={2} localize>{pane.command || 'shell'} · {pane.current_path || pane.cwd || 'unknown directory'}</Text>{pane.tags?.length ? <Text style={{ color: colors.blue, fontSize: 10, marginTop: 3 }}>{pane.tags.join(' · ')}</Text> : null}</View></Pressable>) : <Text style={[styles.empty, { color: colors.muted }]} localize>No tmux panes linked to this chat.</Text>}
      </ScrollView>
      {selectedPane ? <View><View style={styles.outputHeader}><Text style={[styles.outputTitle, { color: colors.muted }]}>{busy ? 'Capturing output…' : `Output · ${selectedPane}`}</Text><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync(output)} label="Copy tmux output" /></View><ScrollView style={{ maxHeight: 250 }}><Text selectable style={[styles.log, { color: colors.text, backgroundColor: '#090b0e' }]}>{output || (busy ? 'Loading…' : 'No output.')}</Text></ScrollView></View> : null}
      <View style={styles.buttonRow}><SecondaryButton label="Refresh" onPress={() => sessionId && void inspect(sessionId, includeAll)} /></View>
    </> : <ConnectionUnavailable />}
  </Sheet>
}

function Sheet({ visible, title, onClose, onBack, onShow, onDidDismiss, children, wide, form, dismissable = true, keyboardShouldPersistTaps = 'handled' }: { visible: boolean; title: string; onClose: () => void; onBack?: () => void; onShow?: () => void; onDidDismiss?: () => void; children: React.ReactNode; wide?: boolean; form?: boolean; dismissable?: boolean; keyboardShouldPersistTaps?: 'always' | 'handled' | 'never' }) {
  const colors = usePalette()
  const titleKey = title.toLowerCase().replaceAll(' ', '-')
  const closing = useRef(false)
  useEffect(() => {
    if (visible) closing.current = false
  }, [visible])
  const close = () => {
    if (!dismissable || closing.current) return
    closing.current = true
    onClose()
    requestAnimationFrame(dismissAppKeyboard)
  }
  const didDismiss = () => {
    closing.current = false
    dismissAppKeyboard()
    onDidDismiss?.()
  }
  const panel = <View
    testID={`sheet-${titleKey}`}
    style={[styles.sheetPage, Platform.OS !== 'ios' && styles.sheet, wide && Platform.OS !== 'ios' && styles.sheetWide, { backgroundColor: colors.surface, borderColor: colors.border }]}
  >
    <SafeAreaView style={styles.sheetSafeArea} edges={['bottom']}>
      <View style={styles.sheetGrabber} />
      <View style={styles.sheetHeader}>{onBack ? <IconButton icon={ArrowLeft} label="Back to Settings" testID="settings-back" onPress={onBack} /> : null}<Text style={[styles.sheetTitle, { color: colors.text }]}>{t(title)}</Text>{dismissable ? <SheetCloseButton onPress={close} label={t('Close {title}', { title: t(title) })} testID={`sheet-close-${titleKey}`} /> : null}</View>
      <ScrollView
        key={titleKey}
        contentContainerStyle={styles.sheetBody}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      >{children}</ScrollView>
    </SafeAreaView>
  </View>
  if (Platform.OS === 'ios') {
    return <Modal visible={visible} animationType="slide" presentationStyle={form ? 'formSheet' : 'pageSheet'} allowSwipeDismissal={dismissable} onShow={onShow} onRequestClose={close} onDismiss={didDismiss}>{panel}</Modal>
  }
  return <Modal visible={visible} transparent animationType="fade" onShow={onShow} onRequestClose={onBack ?? close} onDismiss={didDismiss}><View style={styles.backdrop}>{dismissable ? <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" style={StyleSheet.absoluteFill} onPress={close} /> : <View style={StyleSheet.absoluteFill} />}{panel}</View></Modal>
}
function Label({ text, children }: { text: string; children?: React.ReactNode }) { const colors = usePalette(); return <View style={styles.labelRow}><Text style={[styles.label, { color: colors.muted }]}>{t(text)}</Text>{children}</View> }
function PrimaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t(label)} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primary, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={styles.primaryText}>{t(label)}</Text></Pressable> }
function SecondaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t(label)} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondary, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={{ color: colors.text, fontWeight: '700' }}>{t(label)}</Text></Pressable> }
function ModeButton({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t(label)} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.modeButton, { backgroundColor: selected ? colors.blue : colors.raised, opacity: pressed ? 0.65 : 1 }]}><Text style={{ color: selected ? 'white' : colors.text, fontSize: 12, fontWeight: '700', textAlign: 'center' }}>{t(label)}</Text></Pressable> }
function SearchResult({ title, subtitle, disabled = false, onPress }: { title: string; subtitle: string; disabled?: boolean; onPress: () => void }) { const colors = usePalette(); return <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${subtitle}`} disabled={disabled} onPress={onPress} style={[styles.result, { borderColor: colors.border, opacity: disabled ? 0.55 : 1 }]}><Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>{title}</Text><Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }} numberOfLines={3}>{subtitle}</Text></Pressable> }
function ConnectionUnavailable() { const colors = usePalette(); return <View style={styles.connectionUnavailable}><Text style={[styles.connectionUnavailableText, { color: colors.muted }]} localize>This server must finish connecting and verifying its identity first.</Text></View> }

function Select({ title = 'Choose option', value, valueLabel, options, onChange, testID }: { title?: string; value: string; valueLabel?: string; options: RuntimeOption[]; onChange: (value: string) => void; testID?: string }) {
  const colors = usePalette()
  const { width, height } = useWindowDimensions()
  const [open, setOpen] = useState(false)
  const deduped = options.filter((option, index) => options.findIndex(value => value.value === option.value) === index)
  const selected = deduped.find(option => option.value === value) ?? (valueLabel ? { label: valueLabel } : deduped[0])
  const compact = width < 600
  const close = () => setOpen(false)
  return <>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={selected?.label ?? 'Choose'} accessibilityState={{ expanded: open }} onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }} style={[styles.select, { backgroundColor: colors.raised, borderColor: colors.border }]}><Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>{selected?.label ?? 'Choose'}</Text><ChevronDown size={15} color={colors.muted} /></Pressable>
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent={Platform.OS === 'android'} onRequestClose={close}>
      <SafeAreaView style={styles.selectSafeArea} edges={['top', 'bottom']}>
        <View style={[styles.backdrop, styles.selectBackdrop, compact && styles.selectBackdropCompact]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss choices" style={StyleSheet.absoluteFill} onPress={close} />
          <View accessibilityViewIsModal style={[styles.menu, compact && styles.menuCompact, { maxHeight: Math.min(440, height * 0.62), backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.menuHeader, { borderColor: colors.border }]}><Text style={[styles.menuTitle, { color: colors.text }]}>{title}</Text><SheetCloseButton onPress={close} label={`Close ${title.toLocaleLowerCase()}`} /></View>
            <ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={styles.menuOptions}>{deduped.map(option => <Pressable key={option.value || '__default'} accessibilityRole="button" accessibilityLabel={option.locked ? `${option.label}, upgrade required` : option.label} accessibilityHint={option.locked ? option.locked_reason ?? undefined : undefined} accessibilityState={{ disabled: option.locked, selected: value === option.value }} disabled={option.locked} onPress={() => { onChange(option.value); close() }} style={[styles.option, { backgroundColor: value === option.value ? colors.raised : 'transparent', opacity: option.locked ? 0.45 : 1 }]}>{value === option.value ? <Check size={15} color={colors.blue} /> : <View style={{ width: 15 }} />}<Text style={{ color: colors.text, flex: 1 }} localize>{option.label}{option.locked ? ' (upgrade required)' : ''}</Text></Pressable>)}</ScrollView>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  </>
}

function dialogError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function connectionIsCurrent(connection: AgentServerClient, profileId: string | null, generation: number): boolean {
  const state = useAppStore.getState()
  return !connection.isDisposed
    && connection.isValidated
    && client === connection
    && state.activeProfileId === profileId
    && state.profileGeneration === generation
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}
function intervalLabel(seconds: number): string { if (seconds % 604800 === 0) return `${seconds / 604800}w`; if (seconds % 86400 === 0) return `${seconds / 86400}d`; if (seconds % 3600 === 0) return `${seconds / 3600}h`; return `${seconds / 60}m` }
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 18 }, sheetPage: { flex: 1 }, sheetSafeArea: { flex: 1 }, sheet: { width: '100%', maxWidth: 520, maxHeight: '88%', borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }, sheetWide: { maxWidth: 760 }, sheetGrabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, marginBottom: 1, borderRadius: radius.round, backgroundColor: '#8a8a8a88' },
  sheetHeader: { minHeight: 64, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs, flexDirection: 'row', alignItems: 'center' }, sheetTitle: { ...typography.title, flex: 1, fontWeight: '600' }, sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm },
  labelRow: { minHeight: 24, marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, label: { ...typography.label, fontWeight: '600' }, help: { ...typography.caption }, build: { ...typography.caption, paddingTop: spacing.xs, textAlign: 'center' },
  input: { ...typography.body, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, textarea: { ...typography.body, minHeight: 110, maxHeight: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: spacing.md, textAlignVertical: 'top' },
  segment: { flexDirection: 'row', gap: spacing.sm }, segmentButton: { flex: 1, minHeight: 44, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  primary: { minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg }, primaryText: { ...typography.body, color: 'white', fontWeight: '600' }, secondary: { minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg }, buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm }, statusRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  select: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' }, selectSafeArea: { flex: 1 }, selectBackdrop: { padding: 18 }, selectBackdropCompact: { justifyContent: 'flex-end', paddingHorizontal: 10, paddingBottom: 8 }, menu: { width: '100%', maxWidth: 440, borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }, menuCompact: { maxWidth: 560, borderRadius: radius.sheet }, menuHeader: { minHeight: 52, paddingLeft: 14, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 }, menuTitle: { flex: 1, fontSize: 15, fontWeight: '800' }, menuOptions: { padding: 6 }, option: { minHeight: 44, borderRadius: radius.md, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchBox: { minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }, searchFailure: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }, searchFailureText: { flex: 1, fontSize: 11.5, lineHeight: 15 }, searchFailureRetry: { minWidth: 64, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }, result: { minHeight: 58, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth }, empty: { padding: 24, textAlign: 'center' },
  connectionUnavailable: { minHeight: 180, alignItems: 'center', justifyContent: 'center', padding: 24 }, connectionUnavailableText: { maxWidth: 320, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  digestSource: { minHeight: 56, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 }, preview: { maxHeight: 280, borderRadius: radius.md, padding: 10 }, presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, preset: { minWidth: 52, minHeight: 44, flexBasis: '22%', flexGrow: 1, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 }, modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, modeButton: { minHeight: 44, minWidth: 88, flexGrow: 1, borderRadius: radius.md, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' }, toggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center' },
  jobStartPicker: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 5, gap: 2 }, jobStartPickerControl: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 8 }, jobStartPickerControlPhone: { minHeight: 74, width: '100%', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 3, paddingVertical: 5 }, jobStartPickerHeading: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 8 }, jobStartPickerNativePhone: { width: '100%', minHeight: 44, alignSelf: 'stretch' }, jobStartPickerLabel: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }, jobStartPickerValue: { marginTop: 2, fontSize: 13, fontWeight: '700' }, jobStartPickerButton: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10 },
  jobReferenceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, jobReferenceChip: { minHeight: 34, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6 }, jobMentionPicker: { maxHeight: 260, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 6, gap: 2 }, jobMentionOption: { minHeight: 46, borderRadius: radius.md, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  process: { minHeight: 58, borderRadius: radius.md, padding: 9, marginBottom: 6, flexDirection: 'row', gap: 8 }, processDot: { width: 7, height: 7, borderRadius: radius.round, marginTop: 5 }, log: { padding: 10, borderRadius: radius.md, fontFamily: 'Menlo', fontSize: 11, lineHeight: 16 },
  outputHeader: { minHeight: 34, flexDirection: 'row', alignItems: 'center' }, outputTitle: { flex: 1, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  fontScale: { minHeight: 74, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, fontScalePreview: { flex: 1, gap: spacing.xs }, fontScaleValue: { ...typography.caption, fontWeight: '600' },
  settingsCategories: { gap: spacing.xl, paddingTop: spacing.sm }, settingsHeading: { ...typography.label, fontWeight: '600', paddingBottom: spacing.sm },
  settingsRow: { minHeight: 56, paddingVertical: spacing.md, gap: spacing.md, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth }, settingsRowTitle: { ...typography.body, flex: 1 }, settingsRowValue: { ...typography.label, maxWidth: '35%' },
  themeOptions: { flexDirection: 'row', gap: spacing.xs, padding: spacing.xs, borderRadius: radius.md, marginBottom: spacing.lg }, themeOption: { flex: 1, minHeight: 76, paddingVertical: spacing.md, paddingHorizontal: spacing.xs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }, themeOptionText: { fontWeight: '600', textAlign: 'center' },
  settingsNetworkCopy: { flex: 1, gap: spacing.xs },
  setupIntro: { paddingTop: 4, flexDirection: 'row', alignItems: 'center', gap: 12 }, setupIcon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, setupCopy: { flex: 1, gap: 4 }, setupTitle: { fontSize: 18, fontWeight: '800' }, setupBody: { fontSize: 13, lineHeight: 18 },
  setupSteps: { paddingVertical: 8, gap: 4 }, setupStep: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 5 }, setupStepText: { flex: 1, fontSize: 13, lineHeight: 18 }, setupGuide: { minHeight: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, setupGuideText: { fontSize: 13, fontWeight: '700' },
})
