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
const fixture = { store, alerts: [], reads: [], sends: [], client: { isValidated: true, validationRevision: 1 } }
globalThis.__teamComposerFixture = fixture
const mocks = {
  'react-native': `import { createElement } from 'react'; const fixture=globalThis.__teamComposerFixture;
    export const View='View', Text='Text', ScrollView='ScrollView', ActivityIndicator='ActivityIndicator';
    export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({pressed:false}) : props.children);
    export const Modal = ({visible=true,...props}) => visible ? createElement('Modal',props) : null;
    export const FlatList = ({data=[],renderItem,ListEmptyComponent,...props}) => createElement('FlatList',props,data.length ? data.map((item,index) => createElement('ListItem',{key:item.id||index},renderItem({item,index}))) : typeof ListEmptyComponent === 'function' ? createElement(ListEmptyComponent) : ListEmptyComponent);
    export const StyleSheet={create:value=>value,hairlineWidth:0.5,absoluteFill:{},flatten:value=>Object.assign({},...[value].flat(Infinity).filter(Boolean))};
    export const Platform={OS:'ios',select:choices=>choices.ios??choices.default};
    export const useColorScheme=()=>'dark'; export const useWindowDimensions=()=>({width:390,height:844,scale:3,fontScale:1});
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
  stdin: { contents: `export { Composer } from './src/components/Composer'; export { TeamTargetPicker } from './src/components/TeamTargetPicker';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'team-composer-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true }
      : mocks[args.path] ? { path: args.path, namespace: 'team-composer-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'team-composer-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__teamComposerFixture })
const { Composer, TeamTargetPicker } = await import(pathToFileURL(outfile).href)

function health() { return { ok: true, server_identity: 'local-server', server_instance_id: 'instance', capabilities: {
  agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
  team_hub_v1: { available: true, version: 1, server_session_base_path: '/api/team-hub-server', hub_id: 'hub' },
} } }
function reset(patch = {}) {
  fixture.alerts.length=0; fixture.reads.length=0; fixture.sends.length=0; fixture.client.isValidated=true; fixture.client.validationRevision=1
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
