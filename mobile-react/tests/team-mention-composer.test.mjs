import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
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
const fixture = { store, alerts: [], reads: [], sends: [], routeReads: [], revokes: [], skips: [], width: 390, scheme: 'dark', client: { isValidated: true, validationRevision: 1 } }
globalThis.__teamComposerFixture = fixture
const mocks = {
  'react-native': `import { createElement } from 'react'; const fixture=globalThis.__teamComposerFixture;
    export const View='View', Text='Text', ScrollView='ScrollView', ActivityIndicator='ActivityIndicator';
    export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({pressed:false}) : props.children);
    export const Modal = ({visible=true,...props}) => visible ? createElement('Modal',props) : null;
    export const FlatList = ({data=[],renderItem,ListEmptyComponent,ListFooterComponent,...props}) => createElement('FlatList',props,data.length ? data.map((item,index) => createElement('ListItem',{key:item.id||index},renderItem({item,index}))) : typeof ListEmptyComponent === 'function' ? createElement(ListEmptyComponent) : ListEmptyComponent, ListFooterComponent);
    export const StyleSheet={create:value=>value,hairlineWidth:0.5,absoluteFill:{},flatten:value=>Object.assign({},...[value].flat(Infinity).filter(Boolean))};
    export const Platform={OS:'ios',select:choices=>choices.ios??choices.default};
    export const useColorScheme=()=>fixture.scheme; export const useWindowDimensions=()=>({width:fixture.width,height:844,scale:3,fontScale:1});
    export const Alert={alert:(...args)=>fixture.alerts.push(args)}; export const ActionSheetIOS={showActionSheetWithOptions:(options,callback)=>fixture.actionSheet={options,callback}};`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeAreaView'; export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  'expo-image': `export const Image='Image';`,
  'expo-document-picker': `export async function getDocumentAsync(){return {canceled:true}}`,
  'expo-image-picker': `export async function launchImageLibraryAsync(){return {canceled:true}}`,
  '@expo/ui/community/menu': `export const MenuView='MenuView';`,
  'lucide-react-native': `export const AlertCircle='AlertCircle', ArrowDown='ArrowDown', ArrowUp='ArrowUp', Check='Check', ChevronDown='ChevronDown', ChevronRight='ChevronRight', CornerDownRight='CornerDownRight', File='File', Mail='Mail', MessageCircleMore='MessageCircleMore', MessageSquareShare='MessageSquareShare', Paperclip='Paperclip', Search='Search', Send='Send', Square='Square', Trash2='Trash2', X='X', Server='Server', RefreshCw='RefreshCw';`,
  '../store/useAppStore': `export const useAppStore=globalThis.__teamComposerFixture.store; export const client=globalThis.__teamComposerFixture.client;`,
  '../lib/analytics': `export function trackEvent(){}`,
  '../lib/app-keyboard': `export async function dismissAppKeyboard(){}`,
  './AppText': `import {forwardRef,createElement} from 'react'; export const Text='Text'; export const TextInput=forwardRef((props,ref)=>createElement('TextInput',{...props,ref}));`,
  './BackendMark': `export const BackendMark='BackendMark';`,
  './CodexPermissionMenu': `export const CodexPermissionMenu=()=>null;`,
  './ClaudePermissionMenu': `export const ClaudePermissionMenu=()=>null;`,
  './CursorPermissionMenu': `export const CursorPermissionMenu=()=>null;`,
  './CodexGoalBar': `export const CodexGoalBar=()=>null;`,
  './CodexRuntimeContext': `export const useCodexRuntime=()=>({refresh:async()=>{}});`,
  './ClaudeRuntimeContext': `export const useClaudeRuntime=()=>({refresh:async()=>{}});`,
  './FullscreenImageViewer': `export const FullscreenViewerCloseButton='FullscreenViewerCloseButton', SwipeDismissImage='SwipeDismissImage';`,
}
const outfile = path.resolve('build/tmp', `team-composer-tests-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export { Composer, ChatTargetPicker, QueueShelf } from './src/components/Composer'; export { TeamTargetPicker } from './src/components/TeamTargetPicker'; export { updateQueuedTurns } from './src/lib/queue'; export { projectTimeline } from './src/lib/timeline';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'team-composer-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true }
      : mocks[args.path] ? { path: args.path, namespace: 'team-composer-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'team-composer-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__teamComposerFixture })
const { Composer, ChatTargetPicker, QueueShelf, TeamTargetPicker, updateQueuedTurns, projectTimeline } = await import(pathToFileURL(outfile).href)

function health() { return { ok: true, server_identity: 'local-server', server_instance_id: 'instance', capabilities: {
  agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
  team_hub_v1: { available: true, version: 1, server_session_base_path: '/api/team-hub-server', hub_id: 'hub' },
} } }
function reset(patch = {}) {
  fixture.alerts.length=0; fixture.reads.length=0; fixture.sends.length=0; fixture.client.isValidated=true; fixture.client.validationRevision=1
  fixture.routeReads.length=0;fixture.revokes.length=0;fixture.skips.length=0;fixture.width=390;fixture.scheme='dark'
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
async function render() {
  let renderer
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Composer,{sessionId:'chat',keyboardVisible:true,onSent(){},onOpenMcp(){}}),{createNodeMock:()=>({focus(){},clear(){},setNativeProps(){}})})})
  return renderer
}
const byID=(renderer,id)=>renderer.root.findAll(node=>typeof node.type==='string'&&node.props.testID===id)
const texts=renderer=>renderer.root.findAllByType('Text').map(node=>node.children.filter(child=>typeof child==='string').join('')).join('\n')
const type=async(renderer,value)=>act(async()=>byID(renderer,'chat-composer-input')[0].props.onChangeText(value))

test('composer native-host harness keeps ordinary draft typing local without team discovery',async()=>{
  reset()
  const renderer=await render()
  try{
    await type(renderer,'Ordinary message.')
    assert.equal(store.getState().drafts.chat,'Ordinary message.')
    assert.deepEqual(fixture.reads,[])
    assert.equal(renderer.root.findAllByType('Modal').length,0)
  }finally{await act(async()=>renderer.unmount())}
})

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const click=async(renderer,id)=>act(async()=>byID(renderer,id)[0].props.onPress())
const recipient=renderer=>renderer.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Reference Mac Studio in My team')
async function renderPicker(overrides={}){
  let renderer
  const props={visible:true,width:390,query:'',sourceSessionId:'chat',referenceLimitReached:false,onQueryChange(){},onSelect(value){fixture.selected=value;return true},onClose(){},onDidDismiss(){},...overrides}
  await act(async()=>{renderer=TestRenderer.create(React.createElement(TeamTargetPicker,props))})
  return {renderer,props}
}

test('recipient picker uses approved proxy, displays destination and search, and accepts only one repeated tap',async()=>{
  reset();let selections=0
  const {renderer,props}=await renderPicker({onSelect(value){fixture.selected=value;selections++;return true}})
  try{
    assert.equal(fixture.reads.length,3)
    assert.ok(fixture.reads.every(([base])=>base==='/api/team-hub-server'))
    assert.match(texts(renderer),/Mac Studio/)
    assert.match(texts(renderer),/Server inbox/)
    assert.ok(recipient(renderer))
    await act(async()=>renderer.update(React.createElement(TeamTargetPicker,{...props,query:'not a server'})))
    assert.equal(recipient(renderer),undefined)
    assert.match(texts(renderer),/No matching/)
    assert.equal(fixture.reads.length,3,'Search is local, not a network request per keystroke')
    await act(async()=>renderer.update(React.createElement(TeamTargetPicker,props)))
    await act(async()=>{const select=recipient(renderer).props.onPress;select();select()})
    assert.equal(selections,1)
    assert.deepEqual(fixture.selected.target,{kind:'recipient',recipient_kind:'server',team_id:'team',target_id:'remote-node',display_name_snapshot:'Mac Studio'})
  }finally{await act(async()=>renderer.unmount())}
})

test('slow recipient discovery is visible and failed discovery has a working Retry',async()=>{
  reset()
  const initial=fixture.client.teamNetworkGet, pending=deferred()
  fixture.client.teamNetworkGet=(base,endpoint)=>endpoint==='/v1/health'?pending.promise:initial(base,endpoint)
  const {renderer}=await renderPicker()
  try{
    assert.equal(byID(renderer,'team-target-loading').length,1)
    assert.equal(recipient(renderer),undefined)
    await act(async()=>pending.reject(new Error('Network unavailable')))
    assert.equal(byID(renderer,'team-target-loading').length,0)
    assert.match(texts(renderer),/Network unavailable/)
    fixture.client.teamNetworkGet=initial
    await click(renderer,'team-target-retry')
    assert.equal(byID(renderer,'team-target-error').length,0)
    assert.ok(recipient(renderer))
  }finally{await act(async()=>renderer.unmount())}
})

test('offline and unsupported servers show an explanation without any target request',async()=>{
  for(const patch of [{connected:false},{health:{ok:true}}]){
    reset(patch)
    const {renderer}=await renderPicker()
    try{
      assert.deepEqual(fixture.reads,[])
      assert.equal(byID(renderer,'team-target-error').length,1)
      assert.equal(recipient(renderer),undefined)
      assert.ok(byID(renderer,'team-target-picker-close').length)
    }finally{await act(async()=>renderer.unmount())}
  }
})

test('switching connection ignores stale recipient results without clearing the new loading state',async()=>{
  reset()
  const initial=fixture.client.teamNetworkGet, old=deferred(), fresh=deferred()
  let reads=0
  fixture.client.teamNetworkGet=(base,endpoint)=>endpoint==='/v1/health'?(++reads===1?old.promise:fresh.promise):initial(base,endpoint)
  const {renderer}=await renderPicker()
  try{
    await act(async()=>store.setState({profileGeneration:2}))
    assert.equal(reads,2)
    await act(async()=>old.reject(new Error('Old connection failed')))
    assert.equal(byID(renderer,'team-target-loading').length,1)
    assert.equal(byID(renderer,'team-target-error').length,0)
    await act(async()=>fresh.resolve({hub_id:'hub',capabilities:{team_messages_v1:{available:true,version:1}}}))
    assert.ok(recipient(renderer))
  }finally{await act(async()=>renderer.unmount())}
})

test('changed Hub identity cannot populate a recipient picker',async()=>{
  reset()
  const initial=fixture.client.teamNetworkGet
  fixture.client.teamNetworkGet=(base,endpoint)=>endpoint==='/v1/health'?Promise.resolve({hub_id:'other-hub',capabilities:{team_messages_v1:{available:true,version:1}}}):initial(base,endpoint)
  const {renderer}=await renderPicker()
  try{
    assert.match(texts(renderer),/different Hub identity/)
    assert.equal(recipient(renderer),undefined)
  }finally{await act(async()=>renderer.unmount())}
})

test('same-profile validation refresh reloads recipients and keeps late old results fenced',async()=>{
  reset()
  const initial=fixture.client.teamNetworkGet, old=deferred(), fresh=deferred()
  let reads=0
  fixture.client.teamNetworkGet=(base,endpoint)=>endpoint==='/v1/health'?(++reads===1?old.promise:fresh.promise):initial(base,endpoint)
  const {renderer}=await renderPicker()
  try{
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:health()})})
    assert.equal(reads,2)
    await act(async()=>old.reject(new Error('Old validation expired')))
    assert.equal(byID(renderer,'team-target-loading').length,1)
    await act(async()=>fresh.resolve({hub_id:'hub',capabilities:{team_messages_v1:{available:true,version:1}}}))
    assert.ok(recipient(renderer))
  }finally{await act(async()=>renderer.unmount())}
})

test('typing @@ opens the server picker, selection creates exact draft spans, and Send receives structured recipient',async()=>{
  reset()
  const renderer=await render()
  try{
    await type(renderer,'@')
    await type(renderer,'@@')
    assert.match(texts(renderer),/Team Network recipient/)
    assert.equal(renderer.root.findAllByType('Modal').length,1)
    assert.ok(recipient(renderer))
    await act(async()=>{const select=recipient(renderer).props.onPress;select();select()})
    assert.equal(store.getState().drafts.chat,'@@Mac Studio ')
    const references=store.getState().teamReferencesBySession.chat
    assert.deepEqual(references,[{kind:'recipient',recipient_kind:'server',team_id:'team',target_id:'remote-node',display_name_snapshot:'Mac Studio',source_text_start:0,source_text_end:12,grant_intent:true}])
    assert.deepEqual(store.getState().chatReferencesBySession.chat,[])
    assert.equal(byID(renderer,'composer-team-references').length,1)
    assert.equal(renderer.root.findAllByType('Modal').length,0)
    await type(renderer,'@@Mac Studio Please check the renderer.')
    await click(renderer,'chat-send')
    assert.equal(fixture.sends.length,1)
    assert.deepEqual(fixture.sends[0][3].teamReferences,references)
    assert.equal(fixture.sends[0][3].admittedDraft,'@@Mac Studio Please check the renderer.')
    assert.deepEqual(fixture.sends[0][3].chatReferences,[])
  }finally{await act(async()=>renderer.unmount())}
})

test('removing a server recipient revokes its structured grant but leaves the literal draft intact',async()=>{
  reset()
  const renderer=await render()
  try{
    await type(renderer,'@@')
    await act(async()=>recipient(renderer).props.onPress())
    const remove=renderer.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Remove reference to Mac Studio')
    assert.ok(remove)
    await act(async()=>remove.props.onPress())
    assert.deepEqual(store.getState().teamReferencesBySession.chat,[])
    assert.equal(store.getState().drafts.chat,'@@Mac Studio ')
    assert.equal(byID(renderer,'composer-team-references').length,0)
    await click(renderer,'chat-send')
    assert.deepEqual(fixture.sends[0][3].teamReferences,[])
  }finally{await act(async()=>renderer.unmount())}
})

test('editing inside a selected @@ name revokes it instead of silently routing changed text',async()=>{
  reset()
  const renderer=await render()
  try{
    await type(renderer,'@@')
    await act(async()=>recipient(renderer).props.onPress())
    await type(renderer,'@@Mac Studio altered ')
    assert.equal(store.getState().teamReferencesBySession.chat.length,1,'Text after the selected token keeps its exact target')
    await type(renderer,'@@Mac StXdio altered ')
    assert.deepEqual(store.getState().teamReferencesBySession.chat,[])
  }finally{await act(async()=>renderer.unmount())}
})

test('unsupported @@ explains capability requirements without disguising the token as local @Chat',async()=>{
  reset({health:{ok:true}})
  const renderer=await render()
  try{
    await type(renderer,'@@')
    assert.equal(byID(renderer,'team-target-error').length,1)
    assert.deepEqual(fixture.reads,[])
    assert.deepEqual(store.getState().chatReferencesBySession.chat,[])
    await click(renderer,'team-target-picker-close')
    assert.equal(renderer.root.findAllByType('Modal').length,0)
    assert.equal(store.getState().drafts.chat,'@@')
  }finally{await act(async()=>renderer.unmount())}
})

function withLocalChats(){
  const value=health()
  value.capabilities.cross_chat_handoffs_v1={available:true,version:7,actions:['route','instruction','request_reply','final_result'],supported_target_backends:['codex','claude'],features:{durable_route_grants:true,agent_cross_chat_routes:true,agent_ambient_local_handoffs:false,route_hint_mentions:true},agent_routes:{client_capability:'agent_cross_chat_routes_v2',policy:'default_deny',actions:['instruction','request_reply']}}
  return value
}

test('fast @@ wins over the single-@ picker even when local chat routing is enabled',async()=>{
  reset({health:withLocalChats()})
  const renderer=await render()
  try{
    await type(renderer,'@')
    assert.equal(renderer.root.findAllByType('Modal').length,0)
    await type(renderer,'@@')
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)))
    assert.equal(byID(renderer,'team-target-search').length,1)
    assert.equal(byID(renderer,'chat-target-search').length,0)
    assert.equal(renderer.root.findAllByType('Modal').length,1)
  }finally{await act(async()=>renderer.unmount())}
})

for(const entry of ['button','second @'])test(`local chat picker switches to servers via ${entry} only after its iOS sheet dismisses`,async()=>{
  reset({health:withLocalChats()})
  const renderer=await render()
  try{
    await type(renderer,'@')
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)))
    assert.equal(byID(renderer,'chat-target-search').length,1)
    const dismiss=renderer.root.findByType('Modal').props.onDismiss
    if(entry==='button')await click(renderer,'chat-target-team-network')
    else await act(async()=>byID(renderer,'chat-target-search')[0].props.onChangeText('@Mac'))
    assert.equal(renderer.root.findAllByType('Modal').length,0,'Two native sheets must not compete')
    await act(async()=>dismiss())
    assert.equal(byID(renderer,'team-target-search').length,1)
    assert.ok(recipient(renderer))
    await act(async()=>recipient(renderer).props.onPress())
    assert.equal(store.getState().drafts.chat,'@@Mac Studio ')
    assert.equal(store.getState().teamReferencesBySession.chat.length,1)
  }finally{await act(async()=>renderer.unmount())}
})

test('Add menu exposes a direct server recipient picker without requiring typed sigils',async()=>{
  reset()
  const renderer=await render()
  try{
    await click(renderer,'chat-attach')
    const index=fixture.actionSheet.options.options.indexOf('Reference a server (@@)')
    assert.ok(index>=0)
    await act(async()=>fixture.actionSheet.callback(index))
    assert.ok(recipient(renderer))
    await act(async()=>recipient(renderer).props.onPress())
    assert.equal(store.getState().drafts.chat,'@@Mac Studio ')
    assert.equal(store.getState().teamReferencesBySession.chat.length,1)
  }finally{await act(async()=>renderer.unmount())}
})

const targetSession=(id='target')=>({id,title:`Chat ${id}`,backend:'codex',folder:'Work',status:'idle'})
const route=(id='route',target='target')=>({route_id:id,revision:`opaque-${id}-revision`,alias:`Chat ${target}`,target_session_id:target,actions:['instruction','request_reply'],created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',target:{title:`Chat ${target}`,folder:'Work',backend:'codex',available:true,unavailable_reason:null}})
function resetRoutes(patch={}){reset({health:withLocalChats(),sessions:[{id:'chat',title:'Mobile',backend:'codex'},targetSession(),targetSession('new')],agentRoutesBySession:{chat:{routes:[route()],max_routes:2}},...patch})}
async function renderChatPicker(overrides={}){
  let renderer
  const props={visible:true,width:fixture.width,query:'',sourceSessionId:'chat',supportedTargetBackends:['codex','claude'],references:[],requestReplySupported:true,referenceLimitReached:false,onQueryChange(){},onTeamNetwork(){},onSelect(value){fixture.selected=value;return true},onClose(){},onDidDismiss(){},...overrides}
  await act(async()=>{renderer=TestRenderer.create(React.createElement(ChatTargetPicker,props))})
  return {renderer,props}
}

for(const [width,scheme] of [[320,'dark'],[834,'light']])test(`chat access picker renders granted/pending permissions and usable controls at ${width} ${scheme}`,async()=>{
  resetRoutes();fixture.width=width;fixture.scheme=scheme
  const {renderer}=await renderChatPicker()
  try{
    assert.match(texts(renderer),/Granted · Send \+ Ask/)
    assert.match(texts(renderer),/Will grant when sent · Send \+ Ask/)
    assert.doesNotMatch(texts(renderer),/opaque-route-revision/)
    assert.deepEqual(fixture.routeReads,[['chat',1]])
    const revoke=byID(renderer,'chat-route-revoke-route')[0]
    assert.equal(revoke.props.disabled,false)
    assert.ok(revoke.props.style({pressed:false}).flat().some(value=>value?.minHeight>=44))
    await act(async()=>{const choose=byID(renderer,'chat-target-new')[0].props.onPress;choose();choose()})
    assert.equal(fixture.selected.id,'new')
  }finally{await act(async()=>renderer.unmount())}
})

test('route capacity blocks only new grants; existing and already-pending targets remain available',async()=>{
  resetRoutes({agentRoutesBySession:{chat:{routes:[route()],max_routes:1}}})
  const {renderer,props}=await renderChatPicker()
  try{
    assert.equal(byID(renderer,'chat-target-new')[0].props.disabled,true)
    assert.equal(byID(renderer,'chat-target-target')[0].props.disabled,false)
    assert.equal(byID(renderer,'chat-route-capacity').length,1)
    await act(async()=>renderer.update(React.createElement(ChatTargetPicker,{...props,references:[{session_id:'new',action:'route',grant_intent:true}]})))
    assert.equal(byID(renderer,'chat-target-new')[0].props.disabled,false)
    await act(async()=>renderer.update(React.createElement(ChatTargetPicker,{...props,referenceLimitReached:true})))
    assert.equal(byID(renderer,'chat-target-target')[0].props.disabled,true)
    assert.equal(byID(renderer,'chat-route-revoke-route')[0].props.disabled,false,'Access may still be revoked when the draft reference limit is full')
  }finally{await act(async()=>renderer.unmount())}
})

test('detached unavailable grants can be revoked with exact opaque revision and no duplicate taps',async()=>{
  const detached=route('detached','archived');detached.target.available=false
  resetRoutes({agentRoutesBySession:{chat:{routes:[detached],max_routes:4}}})
  const pending=deferred();store.setState({revokeAgentRoute:async(...args)=>{fixture.revokes.push(args);return pending.promise}})
  const {renderer}=await renderChatPicker()
  try{
    assert.equal(byID(renderer,'chat-detached-route-detached').length,1)
    assert.match(texts(renderer),/Target unavailable/)
    await act(async()=>{const revoke=byID(renderer,'chat-route-revoke-detached')[0].props.onPress;revoke();revoke()})
    assert.deepEqual(fixture.revokes,[['chat','detached','opaque-detached-revision',1]])
    await act(async()=>pending.resolve(true))
  }finally{await act(async()=>renderer.unmount())}
})

test('permission loading/errors are visible and Retry, close, and server switch all work',async()=>{
  resetRoutes({agentRouteLoadingSessionIds:new Set(['chat'])})
  let closes=0,switches=0
  const {renderer}=await renderChatPicker({onClose(){closes++},onTeamNetwork(){switches++}})
  try{
    assert.equal(byID(renderer,'chat-routes-loading').length,1)
    await act(async()=>store.setState({agentRouteLoadingSessionIds:new Set(),agentRouteErrorsBySession:{chat:'Access changed; retry.'}}))
    assert.match(texts(renderer),/Access changed; retry/)
    await click(renderer,'chat-routes-retry');assert.equal(fixture.routeReads.length,2)
    await click(renderer,'chat-target-team-network');assert.equal(switches,1)
    await click(renderer,'chat-target-picker-close');assert.equal(closes,1)
    await act(async()=>store.setState({connected:false}))
    assert.equal(byID(renderer,'chat-target-target')[0].props.disabled,true)
    assert.equal(byID(renderer,'chat-route-revoke-route')[0].props.disabled,true)
  }finally{await act(async()=>renderer.unmount())}
})

test('revalidation releases hung revoke without allowing stale callbacks or old completion to unlock the fresh request',async()=>{
  resetRoutes();const old=deferred(),fresh=deferred()
  store.setState({revokeAgentRoute:async(...args)=>{fixture.revokes.push(args);return fixture.revokes.length===1?old.promise:fresh.promise}})
  const {renderer}=await renderChatPicker()
  try{
    const stale=byID(renderer,'chat-route-revoke-route')[0].props.onPress
    await act(async()=>stale())
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:withLocalChats()})})
    await act(async()=>stale());assert.equal(fixture.revokes.length,1)
    await click(renderer,'chat-route-revoke-route');assert.equal(fixture.revokes.length,2)
    await act(async()=>old.resolve(true))
    await click(renderer,'chat-route-revoke-route');assert.equal(fixture.revokes.length,2)
    await act(async()=>fresh.resolve(true))
  }finally{await act(async()=>renderer.unmount())}
})

test('rejected target selections do not lock the picker, and captured handlers cannot act after scope change',async()=>{
  resetRoutes();let selections=0
  const {renderer}=await renderChatPicker({onSelect(){selections++;return false}})
  try{
    const select=byID(renderer,'chat-target-new')[0].props.onPress
    await act(async()=>{select();select()});assert.equal(selections,2)
    await act(async()=>store.setState({profileGeneration:2}))
    await act(async()=>select());assert.equal(selections,2)
    await click(renderer,'chat-target-new');assert.equal(selections,3)
  }finally{await act(async()=>renderer.unmount())}
})

test('composer disables Send while granted access is being revoked',async()=>{
  resetRoutes({drafts:{chat:'Hello'},revokingAgentRouteIds:new Set(['chat:route'])})
  const renderer=await render()
  try{
    assert.equal(byID(renderer,'chat-send')[0].props.disabled,true)
    await act(async()=>store.setState({revokingAgentRouteIds:new Set()}))
    assert.equal(byID(renderer,'chat-send')[0].props.disabled,false)
    await click(renderer,'chat-send');assert.equal(fixture.sends.length,1)
  }finally{await act(async()=>renderer.unmount())}
})

function asyncTurn(){return {queued_id:'incoming',session_id:'chat',purpose:'cross_chat_handoff_delivery',conversation_mode:'async_route_v1',source_session_id:'target',source_title:'Mac agent',target_session_id:'chat',cross_chat_envelope_id:'envelope',prompt:'Please review the patch.',display_prompt:'Please review the patch.',file_ids:[],position:0}}
function queueHealth(){const value=withLocalChats();value.capabilities.cross_chat_handoffs_v1.version=9;value.capabilities.cross_chat_handoffs_v1.features.exact_queued_delivery_skip=true;return value}
async function renderQueue(overrides={}){
  let renderer
  const props={sessionId:'chat',profileId:'profile',profileGeneration:1,networkDisabled:false,onSent(){},...overrides}
  await act(async()=>{renderer=TestRenderer.create(React.createElement(QueueShelf,props))})
  return {renderer,props}
}
for(const [scheme,background,border] of [['dark','#312d36','#9d7ac9'],['light','#f4effb','#8566bd']])test(`incoming async queue uses Mac ${scheme} purple and only exact removal, never Edit or Run now`,async()=>{
  resetRoutes({health:queueHealth(),snapshots:{chat:{queuedTurns:[asyncTurn()]}}});fixture.scheme=scheme
  const {renderer}=await renderQueue()
  try{
    assert.match(texts(renderer),/Mac agent/)
    assert.match(texts(renderer),/Please review the patch/)
    assert.doesNotMatch(texts(renderer),/starts automatically|Run now/)
    const row=byID(renderer,'queued-row-incoming')[0]
    assert.ok(row.props.style.flat().some(value=>value?.backgroundColor===background&&value?.borderColor===border))
    assert.equal(byID(renderer,'queued-send-now-incoming').length,0)
    assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,false)
    await act(async()=>{const skip=byID(renderer,'queued-skip-incoming')[0].props.onPress;skip();skip()})
    assert.deepEqual(fixture.skips,[['chat','incoming',1]])
  }finally{await act(async()=>renderer.unmount())}
})

test('incoming-only queue is visible in Composer, but unsupported exact skip stays disabled',async()=>{
  resetRoutes({snapshots:{chat:{queuedTurns:[asyncTurn()]}}})
  const renderer=await render()
  try{
    assert.equal(byID(renderer,'queued-row-incoming').length,1)
    assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,true)
    assert.match(byID(renderer,'queued-skip-incoming')[0].props.accessibilityHint,/Update AgentsServer/)
  }finally{await act(async()=>renderer.unmount())}
})

const queueEvent=(patch={})=>({id:'queue-event',session_id:'chat',seq:1,ts:'2026-09-11T10:00:00Z',type:'turn_started',...patch})
async function applyQueueEvent(event){
  await act(async()=>store.setState(state=>({snapshots:{...state.snapshots,chat:{...state.snapshots.chat,queuedTurns:updateQueuedTurns(state.snapshots.chat.queuedTurns,event)}}})))
}
const userQueueTurn=(queued_id,position=0)=>({queued_id,session_id:'chat',prompt:'Identical message text',file_ids:[],position,created_at:'2020-01-01T00:00:00Z'})

test('native-goal steering removes only the exact accepted queued row from the rendered Composer',async()=>{
  resetRoutes({snapshots:{chat:{queuedTurns:[userQueueTurn('steered'),userQueueTurn('same-text',1)]}}})
  const renderer=await render()
  const accepted=queueEvent({type:'turn_steered',queued_id:'steered',run_id:'goal-run',native_goal_steer:true,native_steer:true,backend:'codex',purpose:'codex_goal_resume',provider_user_authored:true})
  try{
    assert.equal(byID(renderer,'queued-row-steered').length,1)
    assert.equal(byID(renderer,'queued-row-same-text').length,1,'old timestamps alone never hide pending messages')
    for(const patch of [{queued_id:undefined},{queued_id:'unknown'},{native_goal_steer:undefined},{provider_user_authored:false}]){
      await applyQueueEvent({...accepted,...patch})
      assert.equal(byID(renderer,'queued-row-steered').length,1,'inexact acknowledgements cannot clear a queued row')
    }
    await applyQueueEvent(accepted)
    assert.equal(byID(renderer,'queued-row-steered').length,0)
    assert.equal(byID(renderer,'queued-row-same-text').length,1,'prompt equality is not an acknowledgement for a different queue ID')
    await applyQueueEvent(queueEvent({queued_id:'same-text',run_id:'next-run'}))
    assert.equal(renderer.root.findAllByType(QueueShelf).length,0,'clearing the last queue row unmounts the shelf without a local stale copy')
  }finally{await act(async()=>renderer.unmount())}
})

test('Run now removes selected and explicitly superseded rows, preserving same-text unsuperseded rows',async()=>{
  resetRoutes({snapshots:{chat:{queuedTurns:[userQueueTurn('older'),userQueueTurn('selected',1),userQueueTurn('keep',2)]}}})
  const renderer=await render()
  try{
    await applyQueueEvent(queueEvent({type:'turn_queue_run_now',queued_id:'selected',superseded_queued_ids:['older']}))
    assert.equal(byID(renderer,'queued-row-selected').length,0)
    assert.equal(byID(renderer,'queued-row-older').length,0)
    assert.equal(byID(renderer,'queued-row-keep').length,1)
    await applyQueueEvent(queueEvent({queued_id:'keep',run_id:'next-run'}))
    assert.equal(renderer.root.findAllByType(QueueShelf).length,0)
  }finally{await act(async()=>renderer.unmount())}
})

test('incoming async message leaves the rendered queue on admission and mixed history has one nonqueued timeline card',async()=>{
  resetRoutes({health:queueHealth(),snapshots:{chat:{queuedTurns:[asyncTurn()]}}})
  const lifecycle=status=>queueEvent({id:`async-${status}`,seq:{received:1,queued:2,started:4,delivered:5}[status],type:`chat_conversation_message_${status}`,conversation_mode:'async_route_v1',conversation_id:'pair',message_id:'envelope',handoff_id:'envelope',cross_chat_envelope_id:'envelope',source_session_id:'target',target_session_id:'chat',queued_id:'incoming',handoff_status:status,handoff_preview:asyncTurn().prompt})
  const lateLegacy=queueEvent({id:'legacy-queued',seq:3,type:'cross_chat_handoff_queued',handoff_id:'envelope',handoff_status:'queued',source_session_id:'target',target_session_id:'chat'})
  const events=[lifecycle('received'),lifecycle('queued'),lateLegacy]
  const renderer=await render()
  try{
    assert.equal(byID(renderer,'queued-row-incoming').length,1)
    assert.deepEqual(projectTimeline(events,[]),[],'pending incoming content belongs exclusively to the queue even with a compatibility receipt')
    await applyQueueEvent(queueEvent({queued_id:'incoming',run_id:'delivery-run',purpose:'cross_chat_handoff_delivery'}))
    events.push(lifecycle('started'))
    assert.equal(byID(renderer,'queued-row-incoming').length,0)
    let projected=projectTimeline(events,[])
    assert.equal(projected.length,1)
    assert.equal(projected[0].crossChatMessage,true)
    assert.equal(projected[0].event.type,'chat_conversation_message_started')
    events.push(lifecycle('delivered'),{...lateLegacy,id:'later-legacy-queued',seq:6})
    projected=projectTimeline(events,[])
    assert.equal(projected.length,1)
    assert.equal(projected[0].event.handoff_status,'delivered')
    assert.equal(byID(renderer,'queued-row-incoming').length,0)
    assert.equal(renderer.root.findAllByType(QueueShelf).length,0)
  }finally{await act(async()=>renderer.unmount())}
})

test('a positions-only queue snapshot cannot hide a queued message before authoritative membership arrives',async()=>{
  resetRoutes({snapshots:{chat:{queuedTurns:[userQueueTurn('unconfirmed')]}}})
  const renderer=await render()
  try{
    await applyQueueEvent(queueEvent({type:'queue_snapshot',positions:[]}))
    assert.equal(byID(renderer,'queued-row-unconfirmed').length,1,'omission is not an exact delivery acknowledgement')
    await act(async()=>store.setState({snapshots:{chat:{queuedTurns:[]}}}))
    assert.equal(byID(renderer,'queued-row-unconfirmed').length,0,'an authoritative empty queue does remove the row immediately')
  }finally{await act(async()=>renderer.unmount())}
})

test('queue revalidation clears hung action and rejects old closure/completion without unlocking a new skip',async()=>{
  resetRoutes({health:queueHealth(),snapshots:{chat:{queuedTurns:[asyncTurn()]}}})
  const old=deferred(),fresh=deferred()
  store.setState({skipQueuedDelivery:async(...args)=>{fixture.skips.push(args);return fixture.skips.length===1?old.promise:fresh.promise}})
  const {renderer}=await renderQueue()
  try{
    const stale=byID(renderer,'queued-skip-incoming')[0].props.onPress
    await act(async()=>stale());assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,true)
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:queueHealth()})})
    assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,false)
    await act(async()=>stale());assert.equal(fixture.skips.length,1)
    await click(renderer,'queued-skip-incoming');assert.equal(fixture.skips.length,2)
    await act(async()=>old.resolve(true));assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,true)
    await act(async()=>fresh.resolve(true));assert.equal(byID(renderer,'queued-skip-incoming')[0].props.disabled,false)
  }finally{await act(async()=>renderer.unmount())}
})

test('same-tick queued Save submits once and reconnect preserves unsaved editor text',async()=>{
  const turn={queued_id:'user',session_id:'chat',prompt:'Old text',file_ids:[]}
  resetRoutes({snapshots:{chat:{queuedTurns:[turn]}}})
  const pending=deferred(),updates=[]
  store.setState({updateQueued:async(...args)=>{updates.push(args);return pending.promise}})
  const {renderer}=await renderQueue()
  try{
    const edit=renderer.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Edit queued message')
    await act(async()=>edit.props.onPress())
    await act(async()=>renderer.root.findByType('TextInput').props.onChangeText('Keep this unsaved text'))
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:queueHealth()})})
    assert.equal(renderer.root.findByType('TextInput').props.value,'Keep this unsaved text')
    await act(async()=>{const save=byID(renderer,'queued-save-user')[0].props.onPress;save();save()})
    assert.equal(updates.length,1)
    await act(async()=>pending.resolve(true))
  }finally{await act(async()=>renderer.unmount())}
})

test('offline remote server inbox remains selectable and its offline state is explained',async()=>{
  reset();const original=fixture.client.teamNetworkGet
  fixture.client.teamNetworkGet=async(...args)=>{const value=await original(...args);if(value.servers)value.servers[0].status='offline';return value}
  const {renderer}=await renderPicker()
  try{assert.match(texts(renderer),/Offline · inbox available/);assert.ok(recipient(renderer));await act(async()=>recipient(renderer).props.onPress());assert.equal(fixture.selected.target.recipient_kind,'server')}
  finally{await act(async()=>renderer.unmount())}
})

function aliasesHealth(){const value=health();value.capabilities.team_bulletin_alias_v1={available:true,version:1,mention:'@@bulletin',legacy_mention:'@@all'};value.capabilities.team_all_servers_alias_v1={available:true,version:1,mention:'@@all',recipient_kind:'all_servers',max_recipients_per_message:64};return value}
test('Team aliases stay distinct, searchable by exact sigil, and stale rows cannot select after capability loss',async()=>{
  reset({health:aliasesHealth()});const original=fixture.client.teamNetworkGet
  fixture.client.teamNetworkGet=async(...args)=>{const value=await original(...args);if(args[1]==='/v1/health')value.capabilities.team_all_servers_alias_v1=aliasesHealth().capabilities.team_all_servers_alias_v1;return value}
  let selections=0
  const {renderer,props}=await renderPicker({onSelect(value){fixture.selected=value;selections++;return true}})
  try{
    assert.match(texts(renderer),/All server inboxes/);assert.match(texts(renderer),/@@bulletin/)
    const old=renderer.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Reference All servers in My team').props.onPress
    await act(async()=>renderer.update(React.createElement(TeamTargetPicker,{...props,query:'@@bulletin'})))
    assert.equal(renderer.root.findAllByType('Pressable').filter(node=>node.props.accessibilityLabel==='Reference All servers in My team').length,0)
    await act(async()=>renderer.update(React.createElement(TeamTargetPicker,props)))
    await act(async()=>store.setState({health:health()}))
    await act(async()=>old());assert.equal(selections,0)
    await act(async()=>recipient(renderer).props.onPress());assert.equal(selections,1)
  }finally{await act(async()=>renderer.unmount())}
})

test('captured server row cannot select after same-profile recipient reload and empty discovery has working Refresh',async()=>{
  reset();let selections=0
  const {renderer}=await renderPicker({onSelect(){selections++;return true}})
  try{
    const old=recipient(renderer).props.onPress
    await act(async()=>{fixture.client.validationRevision++;store.setState({health:health()})})
    await act(async()=>old());assert.equal(selections,0)
    await act(async()=>recipient(renderer).props.onPress());assert.equal(selections,1)
  }finally{await act(async()=>renderer.unmount())}
  reset();const original=fixture.client.teamNetworkGet;let empty=true
  fixture.client.teamNetworkGet=async(...args)=>{const value=await original(...args);if(empty&&value.servers)value.servers=[];return value}
  const second=await renderPicker()
  try{assert.equal(byID(second.renderer,'team-target-refresh').length,1);empty=false;await click(second.renderer,'team-target-refresh');assert.ok(recipient(second.renderer))}
  finally{await act(async()=>second.renderer.unmount())}
})
