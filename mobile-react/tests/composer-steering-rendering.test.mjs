import assert from 'node:assert/strict'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { create } from 'zustand'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame ??= callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame ??= clearTimeout
const store = create(() => ({}))
const fixture = { store, alerts: [], reads: [], sends: [], routeReads: [], revokes: [], skips: [], width: 390, height: 844, scheme: 'dark', client: { isValidated: true, validationRevision: 1 } }
globalThis.__steeringComposerFixture = fixture
const mocks = {
  'react-native': `import { createElement } from 'react'; const fixture=globalThis.__steeringComposerFixture;
    export const View='View', Text='Text', ScrollView='ScrollView', ActivityIndicator='ActivityIndicator', KeyboardAvoidingView='KeyboardAvoidingView';
    export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({pressed:false}) : props.children);
    export const Modal = ({visible=true,...props}) => visible ? createElement('Modal',props) : null;
    export const FlatList = ({data=[],renderItem,ListEmptyComponent,ListFooterComponent,...props}) => createElement('FlatList',props,data.length ? data.map((item,index) => createElement('ListItem',{key:item.id||index},renderItem({item,index}))) : typeof ListEmptyComponent === 'function' ? createElement(ListEmptyComponent) : ListEmptyComponent, ListFooterComponent);
    export const StyleSheet={create:value=>value,hairlineWidth:0.5,absoluteFill:{},flatten:value=>Object.assign({},...[value].flat(Infinity).filter(Boolean))};
    export const Platform={OS:'ios',select:choices=>choices.ios??choices.default};
    export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};
    export const BackHandler={addEventListener:()=>({remove(){}})};
    export const useColorScheme=()=>fixture.scheme; export const useWindowDimensions=()=>({width:fixture.width,height:fixture.height,scale:3,fontScale:1.6});
    export const Alert={alert:(...args)=>fixture.alerts.push(args)}; export const ActionSheetIOS={showActionSheetWithOptions:(options,callback)=>fixture.actionSheet={options,callback}};`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeAreaView'; export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  'react-native-keyboard-controller': `export const KeyboardAvoidingView='KeyboardSafeView';`,
  'expo-image': `export const Image='Image';`,
  'expo-clipboard': `export async function setStringAsync(value){const f=globalThis.__steeringComposerFixture;if(f.clipboardFailure)throw new Error('Clipboard unavailable');f.copied=value}`,
  'expo-document-picker': `export async function getDocumentAsync(){return {canceled:true}}`,
  'expo-image-picker': `export async function launchImageLibraryAsync(){return {canceled:true}}`,
  '@expo/ui/community/menu': `export const MenuView='MenuView';`,
  'lucide-react-native': `export const AlertCircle='AlertCircle', ArrowDown='ArrowDown', ArrowUp='ArrowUp', Check='Check', ChevronDown='ChevronDown', ChevronRight='ChevronRight', CornerDownRight='CornerDownRight', File='File', Goal='Goal', Pause='Pause', Pencil='Pencil', Play='Play', Mail='Mail', MessageCircleMore='MessageCircleMore', MessageSquareShare='MessageSquareShare', Paperclip='Paperclip', Search='Search', Send='Send', Square='Square', Trash2='Trash2', X='X', Server='Server', RefreshCw='RefreshCw';`,
  '../store/useAppStore': `export const useAppStore=globalThis.__steeringComposerFixture.store; export const client=globalThis.__steeringComposerFixture.client;`,
  '../lib/analytics': `export function trackEvent(){}`,
  '../lib/app-keyboard': `export async function dismissAppKeyboard(){globalThis.__steeringComposerFixture.dismissals++}`,
  './AppText': `import {forwardRef,createElement} from 'react'; export const Text='Text'; export const TextInput=forwardRef((props,ref)=>createElement('TextInput',{...props,ref}));`,
  './BackendMark': `export const BackendMark='BackendMark';`,
  './CodexPermissionMenu': `export const CodexPermissionMenu=()=>null;`,
  './ClaudePermissionMenu': `export const ClaudePermissionMenu=()=>null;`,
  './CursorPermissionMenu': `export const CursorPermissionMenu=()=>null;`,
  './CodexRuntimeContext': `export const useCodexRuntime=()=>globalThis.__steeringComposerFixture.codexRuntime;`,
  './ClaudeRuntimeContext': `export const useClaudeRuntime=()=>({refresh:async()=>{}});`,
  './FullscreenImageViewer': `export const FullscreenViewerCloseButton='FullscreenViewerCloseButton', SwipeDismissImage='SwipeDismissImage';`,
}
const outfile = path.resolve('build/tmp', `steering-composer-tests-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export { Composer, ChatTargetPicker, QueueShelf } from './src/components/Composer'; export { TeamTargetPicker } from './src/components/TeamTargetPicker'; export { updateQueuedTurns } from './src/lib/queue'; export { projectTimeline } from './src/lib/timeline';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'steering-composer-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true }
      : mocks[args.path] ? { path: args.path, namespace: 'team-composer-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'team-composer-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__steeringComposerFixture })
const { Composer, ChatTargetPicker, QueueShelf, TeamTargetPicker, updateQueuedTurns, projectTimeline } = await import(pathToFileURL(outfile).href)

function health() { return { ok: true, server_identity: 'local-server', server_instance_id: 'instance', capabilities: {
  agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
  team_hub_v1: { available: true, version: 1, server_session_base_path: '/api/team-hub-server', hub_id: 'hub' },
} } }
function reset(patch = {}) {
  fixture.alerts.length=0; fixture.reads.length=0; fixture.sends.length=0; fixture.client.isValidated=true; fixture.client.validationRevision=1
  fixture.routeReads.length=0;fixture.revokes.length=0;fixture.skips.length=0;fixture.width=390;fixture.height=844;fixture.scheme='dark'
  fixture.codexRuntime={supported:false,goalsSupported:false,goalsEnabled:false,runtime:null,session:null,mutating:false,error:null,scopeKey:'profile:1:chat',refresh:async()=>null,updateGoal:async()=>null,clearGoal:async()=>null}
  fixture.focusedInput=null;fixture.blurredInputs=[];fixture.dismissals=0
  fixture.client.crossChatHandoff=async()=>{throw new Error('Unexpected message body read')}
  fixture.client.teamNetworkGet = async (base, endpoint) => {
    fixture.reads.push([base,endpoint])
    if (endpoint === '/v1/health') return {hub_id:'hub',capabilities:{team_messages_v1:{available:true,version:1}}}
    if (endpoint === '/v1/server-session') return {principal:{id:'local-node',kind:'node'},teams:[{id:'team',display_name:'My team',status:'active'}]}
    if (endpoint.startsWith('/v1/teams/team/network')) return {network:{id:'team',hub_id:'hub'},servers:[{id:'remote-node',server_identity:'remote-server',display_name:'Mac Studio',recipient_display_name:'Mac Studio',owned_by_caller:false,status:'active'}],has_more:false}
    throw new Error(`Unexpected team endpoint: ${endpoint}`)
  }
  store.setState({
    activeProfileId:'profile',profileGeneration:1,selectedSessionId:'chat',connected:true,connecting:false,switchingProfileId:null,workspaceAdopting:false,
    health:health(),sessions:[{id:'chat',title:'Mobile',backend:'codex'}],snapshots:{},runtime:null,profiles:[],
    drafts:{chat:''},uploads:{},uploadPending:{},uploadFailed:{},queuedRunStatus:{},chatReferencesBySession:{},teamReferencesBySession:{},
    activeSessionIds:new Set(),sendingSessionIds:new Set(),stoppingSessionIds:new Set(),turnAdmissionTokens:{},
    agentRoutesBySession:{},agentRouteErrorsBySession:{},agentRouteLoadingSessionIds:new Set(),revokingAgentRouteIds:new Set(),skippingQueuedDeliveryIds:new Set(),pendingQueuedRunIds:new Set(),
    refreshAgentRoutes:async(...args)=>{fixture.routeReads.push(args);return store.getState().agentRoutesBySession[args[0]]??null},
    revokeAgentRoute:async(...args)=>{fixture.revokes.push(args);return true},
    skipQueuedDelivery:async(...args)=>{fixture.skips.push(args);return true},
    setSessionDraft:(id,text)=>store.setState(state=>({drafts:{...state.drafts,[id]:text}})),
    setChatReferencesForSession:(id,references)=>store.setState(state=>({chatReferencesBySession:{...state.chatReferencesBySession,[id]:references}})),
    setTeamReferencesForSession:(id,references)=>store.setState(state=>({teamReferencesBySession:{...state.teamReferencesBySession,[id]:references}})),
    beginTurnAdmission:id=>{if(store.getState().turnAdmissionTokens[id])return null;store.setState(state=>({turnAdmissionTokens:{...state.turnAdmissionTokens,[id]:'admitted'}}));return 'admitted'},
    endTurnAdmission:id=>store.setState(state=>({turnAdmissionTokens:{...state.turnAdmissionTokens,[id]:undefined}})),
    sendPrompt:async(...args)=>{fixture.sends.push(args);return true},
    ...patch,
  },true)
}
async function render({expandQueue=true,...overrides}={}) {
  let renderer
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Composer,{sessionId:'chat',keyboardVisible:true,onSent(){},onOpenMcp(){},...overrides}),{createNodeMock:element=>({focus(){fixture.focusedInput=element.props.testID},isFocused(){return fixture.focusedInput===element.props.testID},blur(){fixture.blurredInputs.push(element.props.testID);fixture.focusedInput=null},clear(){},setNativeProps(){}})})})
  if(expandQueue && byID(renderer,'queued-section-toggle').length)await click(renderer,'queued-section-toggle')
  return renderer
}
const byID=(renderer,id)=>renderer.root.findAll(node=>typeof node.type==='string'&&node.props.testID===id)
const texts=renderer=>renderer.root.findAllByType('Text').map(node=>node.children.filter(child=>typeof child==='string').join('')).join('\n')
const type=async(renderer,value)=>act(async()=>byID(renderer,'chat-composer-input')[0].props.onChangeText(value))


const click=async(renderer,id)=>act(async()=>byID(renderer,id)[0].props.onPress())
const styleOf=value=>Object.assign({},...[typeof value==='function'?value({pressed:false}):value].flat(Infinity).filter(Boolean))
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}}
const turn=(patch={})=>({queued_id:'existing',session_id:'chat',prompt:'Keep the current work and steer carefully.',file_ids:[],...patch})
const failure='Could not run this queued message now. It is still queued. '+ 'Complete actionable server error. '.repeat(50)
function queued(patch={}) {
  fixture.clipboardFailure=false;fixture.copied=null
  reset({activeSessionIds:new Set(['chat']),snapshots:{chat:{queuedTurns:[turn()]}},
    queuedRunStatus:{chat:{queued_id:'existing',tone:'error',message:failure,goal_steer_rejected:true}},...patch})
}
function goalRuntime() {
  return {...fixture.codexRuntime,supported:true,goalsSupported:true,goalsEnabled:true,session:store.getState().sessions[0],
    runtime:{available:true,goal:{threadId:'thread',objective:'Long goal objective '.repeat(200),status:'active',tokensUsed:12,timeUsedSeconds:20,createdAt:1,updatedAt:2},status:{type:'idle'},goals_enabled:true}}
}
function stop(renderer){return act(async()=>renderer.unmount())}

test('active primary controls stay labeled and distinct when a consumed draft leaves the composer empty',async()=>{
  queued()
  const renderer=await render({expandQueue:false})
  try {
    for(const [id,label] of [['chat-stop','Stop'],['chat-send-now','Steer'],['chat-send','Queue']]) {
      const button=byID(renderer,id)[0]
      assert.ok(button.findAllByType('Text').some(node=>node.children.includes(label)))
      assert.ok(styleOf(button.props.style).minHeight>=44)
      assert.ok(styleOf(button.props.style).minWidth>=44)
    }
    assert.equal(byID(renderer,'chat-send-now')[0].props.disabled,false)
    assert.equal(byID(renderer,'chat-send-now')[0].props.accessibilityLabel,'Review queued messages to steer')
    await click(renderer,'chat-send-now')
    assert.equal(byID(renderer,'queued-review-sheet').length,1)
    assert.deepEqual(fixture.sends,[])
    await click(renderer,'queued-review-close')
    assert.equal(byID(renderer,'chat-send')[0].props.disabled,true)
    assert.equal(byID(renderer,'queued-review-open').length,1)
    await type(renderer,'Explicit draft')
    await click(renderer,'chat-send')
    await click(renderer,'chat-send-now')
    assert.deepEqual(fixture.sends.map(args=>args[0]),[false,true])
    assert.equal(byID(renderer,'chat-hide-keyboard').length,1)
  } finally {await stop(renderer)}
})

for(const width of [320,393,600]) test(`long active drafts preserve the pinned labeled row at ${width}pt`,async()=>{
  queued();fixture.width=width
  const renderer=await render({expandQueue:false})
  try {
    await type(renderer,'Long draft\n'.repeat(300))
    await act(async()=>byID(renderer,'chat-composer-input')[0].props.onContentSizeChange({nativeEvent:{contentSize:{height:9000}}}))
    const input=byID(renderer,'chat-composer-input')[0]
    assert.equal(styleOf(input.props.style).height,78)
    assert.equal(input.props.scrollEnabled,true)
    let cardNode=input.parent
    while(cardNode && styleOf(cardNode.props.style).maxHeight!==278) cardNode=cardNode.parent
    const card=styleOf(cardNode.props.style)
    const actions=styleOf(byID(renderer,'chat-primary-actions')[0].props.style)
    assert.ok(styleOf(input.props.style).height+44+actions.minHeight+2<=card.maxHeight)
    assert.equal(actions.flexShrink,0)
    assert.equal(byID(renderer,'queued-section-toggle')[0].props.accessibilityState.expanded,false)
  } finally {await stop(renderer)}
})

test('real folded goal padding, borders, margin and queue header all fit the portrait keyboard budget',async()=>{
  queued();fixture.codexRuntime=goalRuntime()
  const renderer=await render({expandQueue:false})
  try {
    const goal=styleOf(byID(renderer,'codex-goal-bar')[0].props.style)
    const header=styleOf(byID(renderer,'codex-goal-details')[0].props.style)
    const queue=styleOf(byID(renderer,'queued-section-toggle')[0].props.style)
    const rail=byID(renderer,'composer-auxiliary-scroll')[0]
    const required=header.minHeight+2*goal.paddingVertical+2*goal.borderWidth+goal.marginBottom+styleOf(rail.props.contentContainerStyle).gap+queue.minHeight
    assert.ok(required>104,'the previous nominal two-header estimate misses actual goal chrome')
    assert.ok(styleOf(rail.props.style).maxHeight>=required)
    assert.equal(rail.props.keyboardShouldPersistTaps,'always')
    assert.equal(byID(renderer,'codex-goal-details')[0].props.accessibilityState.expanded,false)
  } finally {await stop(renderer)}
})

test('landscape review remains outside the hidden rail and its editor remains usable above the keyboard',async()=>{
  queued();fixture.width=844;fixture.height=390
  const renderer=await render({expandQueue:false})
  try {
    const rail=byID(renderer,'composer-auxiliary-scroll')[0]
    assert.equal(styleOf(rail.props.style).maxHeight,0)
    const review=byID(renderer,'chat-review-queue')[0]
    assert.equal(rail.findAll(node=>node===review).length,0)
    assert.ok(styleOf(review.props.style).minHeight>=44)
    await click(renderer,'chat-review-queue')
    assert.equal(byID(renderer,'queued-review-sheet').length,1)
    assert.equal(renderer.root.findAllByType('KeyboardAvoidingView')[0].props.behavior,'padding')
    assert.equal(styleOf(byID(renderer,'queued-section-body')[0].props.style).flex,1)
    await click(renderer,'queued-recovery-edit')
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.editable,true)
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('Landscape edit retained'))
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.value,'Landscape edit retained')
    await click(renderer,'queued-review-close')
    await click(renderer,'chat-review-queue')
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.value,'Landscape edit retained')
  } finally {await stop(renderer)}
})

test('Review shows the complete error and explicit same-item Edit Save Steer without sending a replacement',async()=>{
  queued();const operations=[]
  store.setState({
    updateQueued:async(...args)=>{operations.push(['save',...args]);store.setState({queuedRunStatus:{}});return true},
    runQueuedNow:async(...args)=>{operations.push(['steer',...args]);return true},
  })
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open')
    assert.equal(byID(renderer,'queued-run-error-full')[0].children.join(''),failure)
    assert.equal(byID(renderer,'queued-run-error-full')[0].props.numberOfLines,undefined)
    assert.equal(byID(renderer,'queued-run-error-full')[0].props.selectable,true)
    assert.equal(styleOf(byID(renderer,'queued-run-error-scroll')[0].props.style).maxHeight,144)
    assert.deepEqual(operations,[])
    await click(renderer,'queued-recovery-edit')
    assert.equal(byID(renderer,'queued-save-existing')[0].props.disabled,false,'unchanged text can be explicitly saved')
    await click(renderer,'queued-save-existing')
    assert.deepEqual(operations,[['save','chat','existing',turn().prompt,[],1,[]]])
    assert.match(texts(renderer),/Steer/)
    assert.equal(byID(renderer,'queued-run-error-full').length,0)
    await click(renderer,'queued-send-now-existing')
    assert.deepEqual(operations.at(-1),['steer','chat','existing',1])
    assert.deepEqual(fixture.sends,[])
    assert.deepEqual(fixture.reads,[])
  } finally {await stop(renderer)}
})

test('attachment-only recovery saves the original ID with an unchanged empty body and keeps the files',async()=>{
  const item=turn({prompt:'',file_ids:['file-already-uploaded']})
  queued({snapshots:{chat:{queuedTurns:[item]}}});const updates=[]
  store.setState({updateQueued:async(...args)=>{updates.push(args);return true}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open')
    assert.match(texts(renderer),/1 attached file · kept with this queued message/)
    await click(renderer,'queued-recovery-edit')
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.value,'')
    assert.equal(byID(renderer,'queued-save-existing')[0].props.disabled,false)
    await click(renderer,'queued-save-existing')
    assert.deepEqual(updates,[['chat','existing','',[],1,[]]])
    assert.deepEqual(store.getState().snapshots.chat.queuedTurns[0].file_ids,['file-already-uploaded'])
    assert.deepEqual(fixture.sends,[])
  } finally {await stop(renderer)}
})

test('clearing a nonempty message cannot disguise a destructive empty-body edit as attachment recovery',async()=>{
  queued({snapshots:{chat:{queuedTurns:[turn({file_ids:['file']})]}}});const updates=[]
  store.setState({updateQueued:async(...args)=>{updates.push(args);return true}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText(''))
    assert.equal(byID(renderer,'queued-save-existing')[0].props.disabled,true)
    await click(renderer,'queued-save-existing')
    assert.deepEqual(updates,[])
  } finally {await stop(renderer)}
})

test('Save and Steer each reject same-tick duplicate taps without auto-running after Save',async()=>{
  queued();const saves=[],runs=[],save=deferred(),run=deferred()
  store.setState({updateQueued:async(...args)=>{saves.push(args);return save.promise},runQueuedNow:async(...args)=>{runs.push(args);return run.promise}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>{const press=byID(renderer,'queued-save-existing')[0].props.onPress;press();press()})
    assert.equal(saves.length,1);assert.equal(runs.length,0)
    await act(async()=>save.resolve(true))
    await act(async()=>{const press=byID(renderer,'queued-send-now-existing')[0].props.onPress;press();press()})
    assert.equal(runs.length,1)
    await act(async()=>run.resolve(true))
  } finally {await stop(renderer)}
})

for(const change of ['profile','validation','boot','selection']) test(`retained modal Save cannot mutate after same-tick ${change} replacement`,async()=>{
  queued();const updates=[];store.setState({updateQueued:async(...args)=>{updates.push(args);return true}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    const save=byID(renderer,'queued-save-existing')[0].props.onPress
    await act(async()=>{
      if(change==='profile')store.setState({activeProfileId:'other'})
      if(change==='validation'){fixture.client.validationRevision++;store.setState({health:health()})}
      if(change==='boot')store.setState({health:{...health(),server_instance_id:'next-boot'}})
      if(change==='selection')store.setState({selectedSessionId:'other'})
      save()
    })
    assert.deepEqual(updates,[])
  } finally {await stop(renderer)}
})

for(const patch of [{prompt:'Changed elsewhere'},{file_ids:['new-file']},{chat_references:[{session_id:'new-reference'}]}]) test(`changed queued content preserves the unsaved draft instead of overwriting ${JSON.stringify(patch)}`,async()=>{
  queued();const updates=[];store.setState({updateQueued:async(...args)=>{updates.push(args);return true}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('My unsaved draft'))
    await act(async()=>store.setState({snapshots:{chat:{queuedTurns:[turn(patch)]}}}))
    await click(renderer,'queued-save-existing')
    assert.deepEqual(updates,[])
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.value,'My unsaved draft')
    assert.match(texts(renderer),/Queued message changed.*unsaved draft is preserved/)
  } finally {await stop(renderer)}
})

test('failed explicit Save keeps the edit and full failure visible for another explicit attempt',async()=>{
  queued();store.setState({error:'Save refused. Keep this draft.',updateQueued:async()=>false})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('Keep this edited text'))
    await click(renderer,'queued-save-existing')
    assert.equal(byID(renderer,'queued-editor-existing')[0].props.value,'Keep this edited text')
    assert.match(texts(renderer),/Save refused. Keep this draft./)
    assert.equal(byID(renderer,'queued-run-error-full')[0].children.join(''),failure)
  } finally {await stop(renderer)}
})

test('offline Review is local, keeps folds chosen, and does not expose a spurious goal upgrade action',async()=>{
  queued({connected:false,queuedRunStatus:{chat:{queued_id:'existing',tone:'error',message:'Delivery remains unconfirmed.'}}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open')
    assert.equal(byID(renderer,'queued-recovery-edit').length,0)
    assert.equal(byID(renderer,'queued-send-now-existing')[0].props.disabled,true)
    await click(renderer,'queued-message-view-existing')
    assert.equal(byID(renderer,'queued-message-body-existing').length,1)
    await click(renderer,'queued-review-close')
    assert.equal(byID(renderer,'queued-section-toggle')[0].props.accessibilityState.expanded,false)
    assert.deepEqual(fixture.sends,[]);assert.deepEqual(fixture.reads,[])
  } finally {await stop(renderer)}
})

test('constrained landscape includes real header, card borders, shell padding and one action row in the keyboard budget',async()=>{
  queued();fixture.width=812;fixture.height=375
  const renderer=await render({expandQueue:false})
  try {
    const headerSource=await readFile('src/components/ChatHeader.tsx','utf8')
    const headerHeight=Number(headerSource.match(/root: \{ minHeight: (\d+)/)[1])
    const input=styleOf(byID(renderer,'chat-composer-input')[0].props.style)
    const actions=styleOf(byID(renderer,'chat-primary-actions')[0].props.style)
    const shell=styleOf(byID(renderer,'chat-composer')[0].props.style)
    assert.equal(input.height,44)
    assert.equal(actions.minHeight,44)
    assert.equal(shell.paddingVertical,0)
    assert.equal(shell.gap,0)
    assert.equal(byID(renderer,'chat-attach').length,0,'secondary tools return after keyboard dismissal')
    assert.ok(headerHeight+input.height+actions.minHeight+2+2*shell.paddingVertical<=375-216)
    for(const id of ['chat-stop','chat-send-now','chat-send','chat-review-queue','chat-hide-keyboard'])assert.equal(byID(renderer,id).length,1)
    for(const id of ['chat-stop','chat-send-now','chat-send']) {
      const label=byID(renderer,id)[0].findAllByType('Text')[0]
      assert.equal(label.props.numberOfLines,1)
      assert.equal(label.props.maxFontSizeMultiplier,1.3)
    }
  } finally {await stop(renderer)}
})

test('iPhone SE portrait keeps both folded panels and all primary touch targets within the real keyboard budget',async()=>{
  queued();fixture.width=375;fixture.height=667;fixture.codexRuntime=goalRuntime()
  const renderer=await render({expandQueue:false})
  try {
    await type(renderer,'Long short-screen draft\n'.repeat(100))
    await act(async()=>byID(renderer,'chat-composer-input')[0].props.onContentSizeChange({nativeEvent:{contentSize:{height:9000}}}))
    const headerSource=await readFile('src/components/ChatHeader.tsx','utf8')
    const headerHeight=Number(headerSource.match(/root: \{ minHeight: (\d+)/)[1])
    const available=667-291-20-headerHeight
    const input=styleOf(byID(renderer,'chat-composer-input')[0].props.style)
    const actions=styleOf(byID(renderer,'chat-primary-actions')[0].props.style)
    const shell=styleOf(byID(renderer,'chat-composer')[0].props.style)
    const rail=byID(renderer,'composer-auxiliary-scroll')[0]
    assert.equal(available,288)
    assert.equal(input.height,78)
    assert.equal(actions.minHeight,44)
    assert.equal(shell.paddingVertical,0)
    assert.equal(styleOf(rail.props.style).maxHeight,116)
    assert.equal(rail.props.accessibilityElementsHidden,false)
    assert.equal(rail.props.pointerEvents,'auto')
    assert.ok(input.height+actions.minHeight+2+2*shell.paddingVertical+shell.gap+styleOf(rail.props.style).maxHeight<=available)
    assert.equal(byID(renderer,'chat-attach').length,0)
    for(const id of ['codex-goal-details','queued-section-toggle','chat-stop','chat-send-now','chat-send','chat-review-queue','chat-hide-keyboard']) {
      const target=byID(renderer,id)[0]
      assert.ok(target,id)
      const style=styleOf(target.props.style)
      assert.ok((style.height??style.minHeight)>=44,id)
      assert.notEqual(target.props.disabled,true,id)
    }
    await click(renderer,'chat-review-queue')
    assert.equal(byID(renderer,'queued-review-sheet').length,1)
    assert.deepEqual(fixture.sends,[])
    assert.equal(store.getState().drafts.chat,'Long short-screen draft\n'.repeat(100))
    await click(renderer,'queued-review-close')
    await act(async()=>renderer.update(React.createElement(Composer,{sessionId:'chat',keyboardVisible:false,onSent(){},onOpenMcp(){}})))
    assert.equal(byID(renderer,'chat-attach').length,1,'keyboard dismissal restores secondary tools')
  } finally {await stop(renderer)}
})

test('measured large-text action height reduces draft growth rather than clipping controls inside the card',async()=>{
  queued()
  const renderer=await render({expandQueue:false,keyboardVisible:false})
  try {
    await type(renderer,'Long draft\n'.repeat(100))
    await act(async()=>byID(renderer,'chat-composer-input')[0].props.onContentSizeChange({nativeEvent:{contentSize:{height:9000}}}))
    await act(async()=>byID(renderer,'chat-primary-actions')[0].props.onLayout({nativeEvent:{layout:{height:120}}}))
    assert.ok(styleOf(byID(renderer,'chat-composer-input')[0].props.style).height+120+48+2<=278)
    assert.equal(byID(renderer,'chat-send-now')[0].findAllByType('Text')[0].props.maxFontSizeMultiplier,undefined,'normal portrait controls retain accessibility scaling')
  } finally {await stop(renderer)}
})

test('Steer is disabled only when neither a draft nor existing queued work is available',async()=>{
  reset({activeSessionIds:new Set(['chat'])})
  const renderer=await render({expandQueue:false})
  try {
    assert.equal(byID(renderer,'chat-send-now')[0].props.disabled,true)
    assert.equal(byID(renderer,'chat-send-now')[0].props.accessibilityLabel,'Steer current turn')
    await click(renderer,'chat-send-now')
    assert.deepEqual(fixture.sends,[])
  } finally {await stop(renderer)}
})

test('a consumed final queued item keeps its unsaved draft mounted until confirmed discard',async()=>{
  queued()
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('Recover this unsaved edit'))
    await act(async()=>store.setState({snapshots:{chat:{queuedTurns:[]}},queuedRunStatus:{}}))
    assert.equal(byID(renderer,'queued-recovered-draft')[0].children.join(''),'Recover this unsaved edit')
    await click(renderer,'queued-recovered-copy')
    assert.equal(fixture.copied,'Recover this unsaved edit')
    assert.match(texts(renderer),/Draft copied/)
    await click(renderer,'queued-review-close');await click(renderer,'chat-send-now')
    assert.equal(byID(renderer,'queued-recovered-draft').length,1)
    await click(renderer,'queued-recovered-discard')
    assert.equal(byID(renderer,'queued-recovered-draft').length,1,'opening the confirmation never discards')
    const confirm=fixture.alerts.at(-1)[2].find(button=>button.style==='destructive')
    await act(async()=>confirm.onPress())
    assert.equal(byID(renderer,'queued-recovered-draft').length,0)
    assert.deepEqual(fixture.sends,[])
  } finally {await stop(renderer)}
})

test('orphaned edit unlocks other queued Run now actions and copy failures leave a selectable fallback',async()=>{
  queued();const calls=[];store.setState({runQueuedNow:async(...args)=>{calls.push(args);return true}})
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('Still recoverable'))
    await act(async()=>store.setState({snapshots:{chat:{queuedTurns:[turn({queued_id:'other'})]}},queuedRunStatus:{}}))
    assert.equal(byID(renderer,'queued-send-now-other')[0].props.disabled,false)
    await click(renderer,'queued-send-now-other')
    assert.deepEqual(calls,[['chat','other',1]])
    fixture.clipboardFailure=true
    await click(renderer,'queued-recovered-copy')
    assert.match(texts(renderer),/Copy failed. Select the text above/)
    assert.equal(byID(renderer,'queued-recovered-draft')[0].props.selectable,true)
    assert.equal(byID(renderer,'queued-recovered-draft')[0].children.join(''),'Still recoverable')
  } finally {await stop(renderer)}
})

test('a retained discard confirmation cannot clear recovery after same-profile server replacement',async()=>{
  queued()
  const renderer=await render({expandQueue:false})
  try {
    await click(renderer,'queued-review-open');await click(renderer,'queued-recovery-edit')
    await act(async()=>byID(renderer,'queued-editor-existing')[0].props.onChangeText('Keep after reconnect'))
    await act(async()=>store.setState({snapshots:{chat:{queuedTurns:[]}},queuedRunStatus:{}}))
    await click(renderer,'queued-recovered-discard')
    const confirm=fixture.alerts.at(-1)[2].find(button=>button.style==='destructive')
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:health()});confirm.onPress()})
    assert.equal(byID(renderer,'queued-recovered-draft')[0].children.join(''),'Keep after reconnect')
  } finally {await stop(renderer)}
})
