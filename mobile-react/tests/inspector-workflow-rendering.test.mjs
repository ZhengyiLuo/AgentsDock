import assert from 'node:assert/strict'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { create } from 'zustand'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT=true
globalThis.requestAnimationFrame??=callback=>setTimeout(callback,0)
const store=create(()=>({}))
const fixture={store,client:{isValidated:true,validationRevision:1},reads:[],writes:[],stops:[],runs:[],alerts:[]}
globalThis.__inspectorWorkflow=fixture
const icons=['Archive','ArrowUp','Bot','Check','ChevronDown','ChevronRight','Copy','FileText','Folder','FolderOpen','GitFork','Pause','Pencil','Pin','Play','Plus','RefreshCw','Search','Square','SquareTerminal','Trash2','X']
const mocks={
  'react-native':`import {createElement} from 'react'; export const View='View',Text='Text',TextInput='TextInput',ScrollView='ScrollView',ActivityIndicator='ActivityIndicator',KeyboardAvoidingView='KeyboardAvoidingView';export const Pressable=props=>createElement('Pressable',props,typeof props.children==='function'?props.children({pressed:false}):props.children);export const Modal=({visible=true,...props})=>visible?createElement('Modal',props):null;export const StyleSheet={create:x=>x,hairlineWidth:1,absoluteFill:{}};export const Platform={OS:'ios'};export const AccessibilityInfo={announceForAccessibility(){}};export const Alert={alert:(...args)=>globalThis.__inspectorWorkflow.alerts.push(args)};export const useColorScheme=()=> 'dark';`,
  'react-native-safe-area-context':`export const SafeAreaView='SafeAreaView';`,
  'lucide-react-native':icons.map(name=>`export const ${name}='${name}';`).join(''),
  'expo-clipboard':`export async function setStringAsync(){}`,
  '../store/useAppStore':`export const useAppStore=globalThis.__inspectorWorkflow.store;export const client=globalThis.__inspectorWorkflow.client;`,
  '../lib/app-keyboard':`export async function dismissAppKeyboard(){}`,
  './AppText':`export const Text='Text',TextInput='TextInput';`,
  './MediaGrid':`export const MediaGrid=()=>null;`,
  './file-viewer/FileViewerContext':`export const useFileViewer=()=>({openArtifacts(){}});`,
  './ui':`import {createElement} from 'react';export const SectionHeader=({title,trailing})=>createElement('View',null,createElement('Text',null,title),trailing);export const IconButton=({icon:Icon,label,testID,onPress,disabled})=>createElement('Pressable',{testID,accessibilityRole:'button',accessibilityLabel:label,onPress,disabled,style:{minHeight:44,minWidth:44}},createElement(Icon));export const SheetCloseButton=props=>createElement(IconButton,{...props,icon:'X'});`,
}
const outfile=path.resolve('build/tmp',`inspector-workflow-${process.pid}.mjs`)
await mkdir(path.dirname(outfile),{recursive:true})
await build({stdin:{contents:`export {Inspector} from './src/components/Inspector';export {WorkingDirectoryPicker} from './src/components/WorkingDirectoryPicker';export {ImportChatDialog} from './src/components/ImportChatDialog';`,resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'silent',plugins:[{name:'workflow-native-hosts',setup(context){context.onResolve({filter:/.*/},args=>args.path==='react'?{path:args.path,external:true}:mocks[args.path]?{path:args.path,namespace:'workflow-mock'}:undefined);context.onLoad({filter:/.*/,namespace:'workflow-mock'},args=>({contents:mocks[args.path],loader:'js'}))}}]})
after(async()=>{await unlink(outfile);delete globalThis.__inspectorWorkflow})
const {Inspector,WorkingDirectoryPicker,ImportChatDialog}=await import(pathToFileURL(outfile).href)
const byID=(tree,id)=>tree.root.findAll(node=>typeof node.type==='string'&&node.props.testID===id)
const text=tree=>tree.root.findAllByType('Text').map(node=>node.children.filter(value=>typeof value==='string').join('')).join('\n')
const click=(tree,id)=>act(async()=>byID(tree,id)[0].props.onPress())
const labeled=(tree,label)=>tree.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel===label)
const style=value=>Object.assign({},...[value].flat(Infinity).filter(Boolean))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const settle=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,150)))
const event=(seq,patch={})=>({id:`e${seq}`,seq,session_id:'chat',ts:'2026-09-14T10:00:00Z',type:'job_started',job_id:'job',run_id:'run',...patch})
const listing=(input,patch={})=>({input,resolved_path:input||'/srv',base_path:'/srv',exists:true,suggestions:[],truncated:false,...patch})
const health=()=>({ok:true,server_identity:'server',server_instance_id:'instance',default_cwd:'/srv',capabilities:{working_directory_completion:{available:true},scheduled_jobs:{available:true}}})
function reset(patch={}){
  fixture.reads=[];fixture.writes=[];fixture.stops=[];fixture.runs=[];fixture.alerts=[];fixture.client.isValidated=true;fixture.client.validationRevision=1
  fixture.client.completeWorkingDirectory=async input=>{fixture.reads.push(input);return listing(input,{suggestions:input==='/srv'?[{name:'Project',path:'/srv/project'}]:[]})}
  store.setState({activeProfileId:'profile',profileGeneration:1,selectedSessionId:'chat',connected:true,connecting:false,switchingProfileId:null,workspaceAdopting:false,health:health(),sessions:[{id:'chat',title:'Chat',folder:'General',cwd:'/srv',backend:'codex'}],snapshots:{chat:{events:[],files:[],queuedTurns:[]}},activeSessionIds:new Set(),stoppingSessionIds:new Set(),sendingSessionIds:new Set(),pendingQueuedRunIds:new Set(),pendingJobRunIds:new Set(),turnAdmissionTokens:{},filePaging:{},runtime:null,pins:[],jobs:[{id:'job',session_id:'chat',title:'Daily check',backend:'codex',context_mode:'continuation',enabled:true,prompt:'Check',interval_seconds:60}],refreshJobs:async()=>{},refreshFiles:async()=>{},updateSession:async(...args)=>{fixture.writes.push(args);return true},runJob:async(...args)=>{fixture.runs.push(args);return{ok:true}},stopTurn:async(...args)=>{fixture.stops.push(args)},updateJob:async(...args)=>{fixture.writes.push(args);return true},deleteJob:async(...args)=>fixture.writes.push(args),...patch},true)
}
async function render(component=Inspector,patch={}){let tree;const props=component===Inspector?{sessionId:'chat',onDigest(){},onJob(){},onTerminal(){},onProcesses(){},onTmux(){},...patch}:{visible:true,sessionId:'chat',initialPath:'/srv',onChoose:async path=>{fixture.writes.push(path);return true},onClose(){fixture.closed=true},...patch};await act(async()=>{tree=TestRenderer.create(React.createElement(component,props))});return{tree,props}}
const unmount=tree=>act(async()=>tree.unmount())

const importHealth=()=>({...health(),api_contract_version:15,capabilities:{...health().capabilities,local_session_import_v1:{available:true,required:false,message:'',action:null,version:1,max_batch_items:25,max_list_items:12}}})
const candidate=(patch={})=>({backend:'codex',provider_session_id:'provider',label:'Provider chat',cwd:'/srv/project',updated_at:'2026-09-14T10:00:00Z',...patch})
const importedSession=(patch={})=>({id:'imported',backend:'codex',title:'Imported',session_id:'provider',cwd:'/srv/project',...patch})
function resetImport(patch={}){
  reset({health:importHealth(),...patch});fixture.imports=[];fixture.selected=[];fixture.opened=0;fixture.closed=0;fixture.listLimits=[];fixture.remoteSessions=[...store.getState().sessions]
  fixture.client.listLocalSessions=async limit=>{fixture.listLimits.push(limit);return[candidate(),candidate({backend:'claude',provider_session_id:'claude-provider',label:'Other history'})]}
  fixture.client.sessions=async()=>fixture.remoteSessions
  fixture.client.bulkImportSessions=async items=>{fixture.imports.push(items);fixture.remoteSessions.push(importedSession());return[{...items[0],ok:true,session_id:'imported',imported:9}]}
  store.setState({refreshSessions:async()=>store.setState({sessions:fixture.remoteSessions}),selectSession:async(id,generation)=>{fixture.selected.push([id,generation]);store.setState({selectedSessionId:id})}})
}
async function renderImport(props={}){return render(ImportChatDialog,{visible:true,onOpened(){fixture.opened++},onClose(){fixture.closed++},...props})}
const chooseImport=tree=>click(tree,'import-chat-candidate-codex-provider')

test('Import browse/filter is read-only, capability-limited, keyboard-safe and bounded with separate 44pt actions',async()=>{
  resetImport();const {tree}=await renderImport()
  try{
    assert.deepEqual(fixture.listLimits,[12]);assert.deepEqual(fixture.imports,[])
    assert.equal(byID(tree,'import-chat-keyboard-safe')[0].props.behavior,'padding')
    assert.equal(style(byID(tree,'import-chat-list')[0].props.style).maxHeight,440)
    assert.equal(style(byID(tree,'import-chat-actions')[0].props.style).maxHeight,200)
    await chooseImport(tree);assert.deepEqual(fixture.imports,[]);assert.ok(style(byID(tree,'import-chat-import')[0].props.style).minHeight>=44)
    await act(async()=>byID(tree,'import-chat-filter')[0].props.onChangeText('claude'))
    assert.equal(byID(tree,'import-chat-candidate-codex-provider').length,0);assert.equal(byID(tree,'import-chat-candidate-claude-claude-provider').length,1)
    assert.match(text(tree),/codex: Provider chat/)
    let parent=byID(tree,'import-chat-import')[0].parent
    while(parent){assert.equal(typeof parent.type==='string'&&parent.type==='Pressable',false);parent=parent.parent}
  }finally{await unmount(tree)}
})
test('single import uses exact selected identity and durable busy gate; receipt requires explicit Open and never sends',async()=>{
  resetImport();const held=deferred();fixture.client.bulkImportSessions=async items=>{fixture.imports.push(items);return held.promise};const {tree}=await renderImport()
  try{
    await chooseImport(tree);const submit=byID(tree,'import-chat-import')[0].props.onPress
    await act(async()=>{submit();submit()});assert.deepEqual(fixture.imports,[[{provider_session_id:'provider',backend:'codex',cwd:'/srv/project'}]])
    fixture.remoteSessions.push(importedSession());await act(async()=>held.resolve([{provider_session_id:'provider',backend:'codex',ok:true,session_id:'imported',imported:9}]))
    assert.match(text(tree),/Imported 9 history items\. No message sent/);assert.deepEqual(fixture.selected,[]);assert.equal(byID(tree,'import-chat-import').length,0)
    await act(async()=>submit());assert.equal(fixture.imports.length,1)
    await click(tree,'import-chat-candidate-claude-claude-provider');await chooseImport(tree);assert.equal(byID(tree,'import-chat-import').length,0);assert.equal(byID(tree,'import-chat-receipt').length,1)
    await click(tree,'import-chat-open-imported');assert.deepEqual(fixture.selected,[['imported',1]]);assert.equal(fixture.opened,1);assert.deepEqual(fixture.runs,[])
  }finally{await unmount(tree)}
})
test('matching provider IDs reuse exact backend chats and ambiguity requires an explicit chat selection',async()=>{
  for(const ambiguous of [false,true]){
    const a=importedSession({id:'existing-a',title:'First'}),b=importedSession({id:'existing-b',title:'Second'})
    resetImport({sessions:[a,...ambiguous?[b]:[],importedSession({id:'wrong-backend',backend:'claude'})]});const {tree}=await renderImport()
    try{await chooseImport(tree);assert.equal(byID(tree,'import-chat-import').length,0);assert.equal(byID(tree,'import-chat-open-wrong-backend').length,0);assert.deepEqual(fixture.selected,[])
      if(ambiguous)assert.match(text(tree),/Several chats use this provider ID/)
      const target=ambiguous?'existing-b':'existing-a';await click(tree,`import-chat-open-${target}`);assert.deepEqual(fixture.selected,[[target,1]]);assert.deepEqual(fixture.imports,[])
    }finally{await unmount(tree)}
  }
})
test('fresh preflight discovers newly linked provider chats and never imports from stale cached absence',async()=>{
  resetImport();fixture.remoteSessions.push(importedSession({id:'concurrent'}));const {tree}=await renderImport()
  try{await chooseImport(tree);await click(tree,'import-chat-import');assert.deepEqual(fixture.imports,[]);assert.match(text(tree),/already linked/);assert.equal(byID(tree,'import-chat-open-concurrent').length,1);await click(tree,'import-chat-open-concurrent');assert.deepEqual(fixture.selected,[['concurrent',1]])}finally{await unmount(tree)}
})
test('list/preflight failures expose retry without POST; exact failed item receipts remain readable',async()=>{
  resetImport();let fail=true;fixture.client.listLocalSessions=async()=>{if(fail)throw Error('Listing unavailable');return[candidate()]};const {tree}=await renderImport()
  try{
    assert.match(text(tree),/Listing unavailable/);fail=false;await click(tree,'import-chat-reload');await chooseImport(tree)
    fixture.client.sessions=async()=>{throw Error('Cannot verify existing chats')};await click(tree,'import-chat-import');assert.match(text(tree),/Cannot verify existing chats/);assert.deepEqual(fixture.imports,[])
    fixture.client.sessions=async()=>fixture.remoteSessions;fixture.client.bulkImportSessions=async items=>{fixture.imports.push(items);return[{...items[0],ok:false,imported:0,session_id:null,code:'history_missing',error:'Provider history no longer exists'}]}
    await click(tree,'import-chat-import');assert.match(text(tree),/Provider history no longer exists/);assert.equal(byID(tree,'import-chat-open-imported').length,0);assert.deepEqual(fixture.selected,[])
  }finally{await unmount(tree)}
})
test('accepted import survives failed refresh; retry Open never repeats import',async()=>{
  resetImport();store.setState({refreshSessions:async()=>{throw Error('Refresh offline')}});const {tree}=await renderImport()
  try{await chooseImport(tree);await click(tree,'import-chat-import');await click(tree,'import-chat-open-imported');assert.match(text(tree),/Refresh offline/);assert.equal(byID(tree,'import-chat-receipt').length,1);assert.deepEqual(fixture.selected,[]);store.setState({refreshSessions:async()=>store.setState({sessions:fixture.remoteSessions})});await click(tree,'import-chat-open-imported');assert.equal(fixture.imports.length,1);assert.deepEqual(fixture.selected,[['imported',1]])}finally{await unmount(tree)}
})
test('malformed or mismatched import receipts never become successful Open targets',async()=>{
  for(const patch of [{provider_session_id:'forged'},{backend:'claude'},{session_id:null},{imported:0}]){
    resetImport();fixture.client.bulkImportSessions=async()=>[{provider_session_id:'provider',backend:'codex',ok:true,session_id:'wrong',imported:1,...patch}];const {tree}=await renderImport()
    try{await chooseImport(tree);await click(tree,'import-chat-import');assert.equal(byID(tree,'import-chat-receipt').length,0);assert.equal(byID(tree,'import-chat-open-imported').length,0);assert.ok(byID(tree,'import-chat-error').length);assert.deepEqual(fixture.selected,[])}finally{await unmount(tree)}
  }
})
test('profile, chat, validation, instance, adoption and capability changes retire pending preflight and captured import actions',async()=>{
  const changes=[()=>store.setState({profileGeneration:2}),()=>store.setState({selectedSessionId:'other'}),()=>{fixture.client.validationRevision++;store.setState({health:importHealth()})},()=>store.setState({health:{...importHealth(),server_instance_id:'new'}}),()=>store.setState({workspaceAdopting:true}),()=>store.setState({health:health()})]
  for(const change of changes){resetImport();const held=deferred();fixture.client.sessions=async()=>held.promise;const {tree}=await renderImport()
    try{await chooseImport(tree);const stale=byID(tree,'import-chat-import')[0].props.onPress;await act(async()=>stale());await act(async()=>change());await act(async()=>{held.resolve([]);stale()});assert.deepEqual(fixture.imports,[]);assert.deepEqual(fixture.selected,[])}finally{await unmount(tree)}
  }
})
test('changing selected candidate rejects captured Import and removed candidates cannot be imported',async()=>{
  resetImport();const {tree}=await renderImport()
  try{await chooseImport(tree);const stale=byID(tree,'import-chat-import')[0].props.onPress;await click(tree,'import-chat-candidate-claude-claude-provider');await act(async()=>stale());assert.deepEqual(fixture.imports,[]);fixture.client.listLocalSessions=async()=>[];await click(tree,'import-chat-reload');assert.equal(byID(tree,'import-chat-import').length,0);await act(async()=>stale());assert.deepEqual(fixture.imports,[])}finally{await unmount(tree)}
})
test('late accepted import cannot open another selected chat or overwrite a newly mounted operation spinner',async()=>{
  resetImport();const first=deferred(),second=deferred();fixture.client.bulkImportSessions=async items=>{fixture.imports.push(items);return fixture.imports.length===1?first.promise:second.promise};const {tree}=await renderImport()
  try{await chooseImport(tree);await click(tree,'import-chat-import');await act(async()=>{fixture.client.validationRevision++;store.setState({health:importHealth()})});await chooseImport(tree);await click(tree,'import-chat-import');await act(async()=>first.resolve([{provider_session_id:'provider',backend:'codex',ok:true,session_id:'old',imported:4}]));assert.equal(byID(tree,'import-chat-receipt').length,0);assert.equal(byID(tree,'import-chat-import')[0].props.disabled,true);assert.deepEqual(fixture.selected,[]);await act(async()=>second.resolve([{provider_session_id:'provider',backend:'codex',ok:true,session_id:'new',imported:3}]));assert.match(text(tree),/Imported 3 history items/)}finally{await unmount(tree)}
})
test('closed import callbacks stay retired after reopening; unsupported capability performs no discovery',async()=>{
  resetImport();const {tree,props}=await renderImport()
  try{await chooseImport(tree);const stale=byID(tree,'import-chat-import')[0].props.onPress;await act(async()=>labeled(tree,'Close import chat').props.onPress());await act(async()=>tree.update(React.createElement(ImportChatDialog,{...props,visible:false})));await act(async()=>tree.update(React.createElement(ImportChatDialog,props)));await chooseImport(tree);await act(async()=>stale());assert.deepEqual(fixture.imports,[]);await act(async()=>store.setState({health:health()}));assert.equal(byID(tree,'import-chat-unavailable').length,1);assert.equal(fixture.listLimits.length,2)}finally{await unmount(tree)}
})
test('Browse retires same-tick cwd blur writes; folder choose remains inside a keyboard-safe sheet',async()=>{
  reset();const {tree}=await render()
  try{const blur=tree.root.findAllByType('TextInput').find(node=>node.props.value==='/srv').props.onBlur;await act(async()=>{byID(tree,'inspector-browse-directory')[0].props.onPress();blur()});assert.deepEqual(fixture.writes,[]);assert.equal(byID(tree,'working-directory-keyboard-safe')[0].props.behavior,'padding');await settle();assert.equal(byID(tree,'working-directory-choose')[0].props.disabled,false)}finally{await unmount(tree)}
})
test('an exact active job stays stoppable while its next manual run waits on the server',async()=>{
  reset({health:{...health(),active_runs:[{session_id:'chat',run_id:'run'}]},activeSessionIds:new Set(['chat']),snapshots:{chat:{events:[event(1)],files:[],queuedTurns:[]}},jobs:[{id:'job',session_id:'chat',title:'Daily check',backend:'codex',enabled:true,manual_run_pending:true}]});const {tree}=await render()
  try{assert.equal(byID(tree,'stop-scheduled-job-job')[0].props.disabled,false);assert.equal(byID(tree,'run-scheduled-job-job')[0].props.disabled,true);await click(tree,'stop-scheduled-job-job');assert.deepEqual(fixture.stops,[[1,'chat']])}finally{await unmount(tree)}
})
test('sidebar import entry is explicit, touch-safe and capability-scoped while quick create stays intact',async()=>{
  const sidebar=await readFile('src/components/Sidebar.tsx','utf8'),shell=await readFile('src/components/AppShell.tsx','utf8')
  assert.match(sidebar,/onImportChat && importAvailable/);assert.match(sidebar,/testID="sidebar-import-chat"/);assert.match(sidebar,/sidebarImportAvailable\(useAppStore\.getState\(\)\)/);assert.match(sidebar,/importButton: \{ minHeight: 44, minWidth: 44/);assert.match(sidebar,/actions: \{[^\n]*flexWrap: 'wrap'/);assert.match(sidebar,/onPress=\{onNewChat\} label="New chat"/)
  assert.match(shell,/<ImportChatDialog[^\n]*visible=\{modalScopeCurrent && importChat\}/);assert.match(shell,/setImportChat\(false\)/)
})

test('folder navigation is read-only; exact Choose is single-flight and has touch-safe bounded controls',async()=>{
  reset();const save=deferred();const {tree}=await render(WorkingDirectoryPicker,{onChoose:async value=>{fixture.writes.push(value);return save.promise}})
  try{
    await settle();assert.deepEqual(fixture.reads,['/srv']);assert.deepEqual(fixture.writes,[])
    assert.ok(style(byID(tree,'working-directory-list')[0].props.style).maxHeight<=440)
    assert.ok(style(byID(tree,'working-directory-choose')[0].props.style).minHeight>=44)
    await click(tree,'working-directory-open-/srv/project');await settle()
    assert.deepEqual(fixture.reads,['/srv','/srv/project']);assert.deepEqual(fixture.writes,[])
    const choose=byID(tree,'working-directory-choose')[0].props.onPress
    await act(async()=>{choose();choose()});assert.deepEqual(fixture.writes,['/srv/project'])
    await act(async()=>save.resolve(true))
  }finally{await unmount(tree)}
})
test('typed nonexistent paths cannot save and a stale listing cannot select its previous directory',async()=>{
  reset();const old=deferred();fixture.client.completeWorkingDirectory=async value=>value==='/srv'?old.promise:listing(value,{exists:false,resolved_path:'',suggestions:[]})
  const {tree}=await render(WorkingDirectoryPicker)
  try{
    await settle();await act(async()=>byID(tree,'working-directory-path')[0].props.onChangeText('/missing'));await settle()
    await act(async()=>old.resolve(listing('/srv',{suggestions:[{name:'Wrong',path:'/wrong'}]})))
    assert.equal(byID(tree,'working-directory-open-/wrong').length,0)
    assert.equal(byID(tree,'working-directory-choose')[0].props.disabled,true)
    await click(tree,'working-directory-choose');assert.deepEqual(fixture.writes,[])
  }finally{await unmount(tree)}
})
test('folder errors expose Retry and preserve typed paths without speculative saves',async()=>{
  reset();let fail=true;fixture.client.completeWorkingDirectory=async value=>{if(fail)throw Error('Permission denied');return listing(value)}
  const {tree}=await render(WorkingDirectoryPicker)
  try{await settle();assert.match(text(tree),/Permission denied/);fail=false;await click(tree,'working-directory-retry');await settle();assert.equal(byID(tree,'working-directory-path')[0].props.value,'/srv');assert.equal(byID(tree,'working-directory-choose')[0].props.disabled,false);assert.deepEqual(fixture.writes,[])}finally{await unmount(tree)}
})
test('folder capability loss, chat switch and revalidation reject captured Choose and late reads',async()=>{
  for(const change of [()=>store.setState({health:{...health(),capabilities:{}}}),()=>store.setState({selectedSessionId:'other'}),()=>{fixture.client.validationRevision++;store.setState({health:health()})}]){
    reset();const {tree}=await render(WorkingDirectoryPicker)
    try{await settle();const choose=byID(tree,'working-directory-choose')[0].props.onPress;await act(async()=>change());await act(async()=>choose());assert.deepEqual(fixture.writes,[])}finally{await unmount(tree)}
  }
})
test('folder picker cancels closed requests and reopening does not retain hung busy state',async()=>{
  reset();const old=deferred();fixture.client.completeWorkingDirectory=async()=>old.promise
  const {tree,props}=await render(WorkingDirectoryPicker)
  try{await settle();await act(async()=>tree.update(React.createElement(WorkingDirectoryPicker,{...props,visible:false})));fixture.client.completeWorkingDirectory=async value=>listing(value);await act(async()=>tree.update(React.createElement(WorkingDirectoryPicker,props)));await settle();await act(async()=>old.resolve(listing('/srv',{suggestions:[{name:'Stale',path:'/stale'}]})));assert.equal(byID(tree,'working-directory-open-/stale').length,0);assert.equal(byID(tree,'working-directory-choose')[0].props.disabled,false)}finally{await unmount(tree)}
})
test('Inspector opens folder browser and commits exactly the current chat cwd',async()=>{
  reset();const {tree}=await render()
  try{await click(tree,'inspector-browse-directory');await settle();await click(tree,'working-directory-open-/srv/project');await settle();await click(tree,'working-directory-choose');assert.deepEqual(fixture.writes,[['chat',{cwd:'/srv/project'},1]]);assert.equal(byID(tree,'working-directory-picker').length,0)}finally{await unmount(tree)}
})
test('exact running job renders Stop, blocks duplicate Run, and rejects stale ownership',async()=>{
  reset({health:{...health(),active_runs:[{session_id:'chat',run_id:'run'}]},activeSessionIds:new Set(['chat']),snapshots:{chat:{events:[event(1)],files:[],queuedTurns:[]}}})
  const held=deferred();store.setState({stopTurn:async(...args)=>{fixture.stops.push(args);return held.promise}})
  const {tree}=await render()
  try{
    assert.match(text(tree),/Running/);assert.equal(byID(tree,'run-scheduled-job-job')[0].props.disabled,true)
    await click(tree,'run-scheduled-job-job');assert.deepEqual(fixture.runs,[])
    const stop=byID(tree,'stop-scheduled-job-job')[0].props.onPress
    await act(async()=>{stop();stop()});assert.deepEqual(fixture.stops,[[1,'chat']]);await act(async()=>held.resolve())
    await act(async()=>store.setState({health:{...health(),active_runs:[{session_id:'chat',run_id:'human-run'}]}}))
    await act(async()=>stop());assert.equal(fixture.stops.length,1);assert.equal(byID(tree,'stop-scheduled-job-job').length,0)
  }finally{await unmount(tree)}
})
test('running fallback without exact health ownership never offers Stop',async()=>{
  reset({activeSessionIds:new Set(['chat']),snapshots:{chat:{events:[event(1)],files:[],queuedTurns:[]}}});const {tree}=await render()
  try{assert.match(text(tree),/Running/);assert.equal(byID(tree,'stop-scheduled-job-job').length,0)}finally{await unmount(tree)}
})
test('runtime failures block Run and enabling, but still permit pausing an enabled job',async()=>{
  reset({jobs:[{id:'job',session_id:'chat',title:'Cursor job',context_mode:'standalone',backend:'cursor',enabled:false}]});const {tree}=await render()
  try{assert.equal(byID(tree,'run-scheduled-job-job')[0].props.disabled,true);assert.equal(labeled(tree,'Enable job').props.disabled,true);await click(tree,'run-scheduled-job-job');await act(async()=>labeled(tree,'Enable job').props.onPress());assert.deepEqual(fixture.runs,[]);assert.deepEqual(fixture.writes,[]);await act(async()=>store.setState({jobs:[{...store.getState().jobs[0],enabled:true}]}));await act(async()=>labeled(tree,'Pause job').props.onPress());assert.deepEqual(fixture.writes,[['job',{enabled:false},1]])}finally{await unmount(tree)}
})
test('Run refresh and old finally cannot unlock a newer run after revalidation',async()=>{
  reset();const first=deferred(),second=deferred();let count=0;store.setState({runJob:async()=>++count===1?first.promise:second.promise});const {tree}=await render()
  try{const stale=byID(tree,'run-scheduled-job-job')[0].props.onPress;await act(async()=>{stale();stale()});assert.equal(count,1);await act(async()=>{fixture.client.validationRevision++;store.setState({health:health()})});await act(async()=>stale());assert.equal(count,1);await click(tree,'run-scheduled-job-job');assert.equal(count,2);await act(async()=>first.resolve({ok:true}));assert.equal(byID(tree,'run-scheduled-job-job')[0].props.disabled,true);await act(async()=>second.resolve({ok:true}));assert.equal(byID(tree,'run-scheduled-job-job')[0].props.disabled,false)}finally{await unmount(tree)}
})
test('subagents fold active/history, use native task headings, and keep selected identity across title updates',async()=>{
  const child=(seq,patch={})=>event(seq,{type:'subagent_state',job_id:undefined,backend:'codex',subagent_id:'child',subagent_status:'running',subagent_task:'check_layout',subagent_nickname:'Ada',subagent_log:[{ts:'2026-09-14T10:00:00Z',text:'Exact activity'}],...patch})
  reset({snapshots:{chat:{events:[child(1),child(2,{subagent_id:'past',subagent_status:'completed',subagent_task:'old_work'})],files:[],queuedTurns:[]}}});const {tree}=await render()
  try{
    assert.equal(byID(tree,'subagents-body').length,0);await click(tree,'subagents-toggle');assert.match(text(tree),/Check layout/);assert.doesNotMatch(text(tree),/Old work/)
    assert.equal(style(byID(tree,'subagents-body')[0].props.style).maxHeight,240)
    await click(tree,'subagents-history-toggle');assert.match(text(tree),/Old work/)
    await click(tree,'subagent-codex:subagent:child');assert.match(text(tree),/Exact activity/);assert.equal(style(byID(tree,'subagent-output')[0].props.style).maxHeight,420)
    await act(async()=>store.setState({snapshots:{chat:{...store.getState().snapshots.chat,events:[child(3,{subagent_title:'Precise title'})]}}}))
    assert.match(text(tree),/Precise title/);assert.equal(byID(tree,'subagent-output').length,1)
    await act(async()=>store.setState({profileGeneration:2}));assert.equal(byID(tree,'subagent-output').length,0);assert.equal(byID(tree,'subagents-body').length,0)
  }finally{await unmount(tree)}
})
