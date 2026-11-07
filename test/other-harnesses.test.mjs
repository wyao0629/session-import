import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { zstdCompressSync } from 'node:zlib';
import { fixture, put, jsonl, database, conversation, instant, ms } from './fixtures/other/helpers.mjs';
const require = createRequire(import.meta.url);
const h = name => require(`../lib/harnesses/${name}`);
const { normalize } = require('../lib/harnesses/_shared/other');
const { project } = require('../lib/import/project');
const { renderMessages } = require('../lib/hub/render');
async function check(name, root) {
  const adapter = h(name);
  const found = await adapter.discover({ home: root, env: {}, extraRoots: [root] });
  assert.ok(found.some(f => f.root === root));
  const entries = await adapter.scan(root, { maxSessions: 30 });
  for (const e of entries) {
    assert.equal(e.key, `${adapter.id}:${e.sessionId}`);
    assert.equal(typeof e.visible, 'boolean');
    assert.ok(Object.hasOwn(e, 'hiddenReason'));
    assert.ok(Object.hasOwn(e, 'parentSessionId'));
    const messages = await adapter.messages(e);
    assert.equal(e.messageCount, messages.filter(m => !['injected','noise'].includes(m.kind)).length);
    assert.ok(messages.every(m => ['user','assistant','system'].includes(m.role) && typeof m.text === 'string'));
  }
  return entries;
}
test('shared parser preserves block ordering, pairs duplicate DSH events and renders tools/thinking', () => {
  const messages = normalize([...conversation, {type:'function_call',callId:'call-1',name:'Read',arguments:'{"path":"fixture.txt"}'}, {role:'toolResult',toolCallId:'call-1',content:'fixture output'}]);
  assert.equal(messages[0].text, 'fixture question');
  assert.equal(messages[1].text, 'before tool');
  assert.equal(messages[2].tools[0].id, 'call-1');
  assert.equal(messages[3].text, 'after tool');
  assert.equal(messages.flatMap(m => m.tools ?? []).length, 1);
  const entry = {harness:'fixture',sessionId:'id',createdAt:instant};
  for (const text of [project(entry,messages).messages.map(m=>m.text).join('\n'), renderMessages(entry,messages,'full')]) {
    assert.match(text,/reasoning retained/); assert.match(text,/fixture output/); assert.match(text,/Read/);
  }
});
test('Claude custom title, independent subagents and embedded sidechains share parser and cache', async () => {
  const root = await fixture('claude');
  await put(root,'projects/ws/parent.jsonl',jsonl([...conversation,{type:'summary',summary:'summary'},{type:'ai-title',aiTitle:'AI title'},{type:'custom-title',customTitle:'GUI title'}, {...conversation[0],isSidechain:true,agentId:'embedded'}]));
  await put(root,'projects/ws/parent/subagents/agent-child.jsonl',jsonl(conversation));
  await put(root,'projects/ws/parent/subagents/agent-child.meta.json',{description:'Child task'});
  const entries = await check('claude',root), parent = entries.find(e=>e.sessionId==='parent');
  assert.equal(parent.name,'GUI title'); assert.equal(parent.childCount,2);
  assert.equal(entries.filter(e=>e.hiddenReason==='subagent').length,2);
  assert.ok((await h('claude').messages(entries.find(e=>e.sidechain))).some(m=>m.text==='fixture question'));
  const cached=await h('claude').scan(root,{previous:new Map(entries.map(e=>[e.key,e]))});
  assert.deepEqual(cached,entries);
});
test('WorkBuddy SQLite rename overrides transcript and deleted sessions remain hidden',async()=>{
  const root=await fixture('wb');
  await put(root,'projects/ws/s.jsonl',jsonl([{type:'ai-title',aiTitle:'generated'},...conversation,{type:'function_call',callId:'wb-call',name:'Shell',arguments:'{}'},{type:'function_call_result',callId:'wb-call',output:'done',status:'success'}]));
  await database(root,'workbuddy.db','CREATE TABLE sessions(id TEXT, custom_title TEXT,title TEXT,deleted_at INTEGER,cwd TEXT,created_at INTEGER,updated_at INTEGER)',db=>db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('s','GUI rename','old',ms,root,ms,ms));
  const [e]=await check('workbuddy',root); assert.equal(e.name,'GUI rename');assert.equal(e.hiddenReason,'deleted');
  assert.equal((await h('workbuddy').messages(e)).flatMap(m=>m.tools??[]).find(t=>t.id==='wb-call').result,'done');
});
test('DSH multi-frame zstd title and parent with paired tool event duplication',async()=>{
  const root=await fixture('dsh');
  const events=[{type:'session',id:'child',cwd:root,parentSession:'parent',delegationDepth:1,createdAt:ms},{type:'user/message',time:ms,data:{content:'question'}},{type:'assistant/message',time:ms,data:{message:{role:'assistant',content:[{type:'thinking',text:'thought'},{type:'toolCall',id:'c',name:'Read',arguments:'{}'}]}}},{type:'tool/call',time:ms,data:{callId:'c',name:'Read',arguments:'{}'}},{type:'tool/result',time:ms,data:{message:{role:'toolResult',toolCallId:'c',content:[{type:'text',text:'result'}]}}},{type:'session/title',time:ms,data:{title:'DSH GUI'}}];
  await put(root,'sessions/ws/child/session.v4.jsonl.zstd',Buffer.concat([zstdCompressSync(Buffer.from(jsonl(events.slice(0,3)))),zstdCompressSync(Buffer.from(jsonl(events.slice(3))))]));
  const [e]=await check('dsh',root);assert.equal(e.name,'DSH GUI');assert.equal(e.parentSessionId,'parent');assert.equal(e.hiddenReason,'subagent');
  const messages=await h('dsh').messages(e);assert.equal(messages.flatMap(m=>m.tools??[]).length,1);assert.equal(messages.flatMap(m=>m.tools??[])[0].status,'success');
  assert.ok((await h('dsh').messages(e,{withThinking:false})).every(m=>!m.thinking));
});
test('Gemini JSON and JSONL $set replacement retain thoughts and toolCalls',async()=>{
  const root=await fixture('gemini');const data={sessionId:'g',title:'Gemini GUI',cwd:root,startTime:instant,lastUpdated:instant};
  const messages=[{id:'u',type:'user',content:'question'},{id:'a',type:'gemini',content:'answer',thoughts:[{description:'think'}],toolCalls:[{id:'c',name:'read_file',args:{path:'a'},result:'done'}]}];
  await put(root,'tmp/ws/chats/session-g.jsonl',jsonl([data,{$set:{messages}}]));
  await put(root,'tmp/ws/chats/session-j.json',{...data,sessionId:'j',messages});
  const entries=await check('gemini',root);assert.equal(entries.length,2);
  for(const e of entries){const m=await h('gemini').messages(e);assert.ok(m.some(m=>m.thinking?.includes('think')));assert.equal(m.flatMap(m=>m.tools??[])[0].result,'done');}
});
test('Grok summaries, retained empty rows and indexed child metadata',async()=>{
  const root=await fixture('grok');
  await put(root,'sessions/ws/parent/chat_history.jsonl',jsonl([{type:'user',content:'question'},{type:'assistant',content:'answer',tool_calls:[{id:'c',name:'Read',arguments:'{}'}]},{type:'tool_result',tool_call_id:'c',content:'result'}]));
  await put(root,'sessions/ws/parent/summary.json',{generated_title:'Grok GUI',info:{cwd:root},created_at:instant,updated_at:instant});
  await put(root,'sessions/ws/child/chat_history.jsonl',jsonl([{type:'user',content:'child'}]));
  await put(root,'sessions/ws/parent/subagents/child/meta.json',{parent_session_id:'parent',child_session_id:'child'});
  await put(root,'sessions/ws/empty/chat_history.jsonl',jsonl([{type:'system',content:'injected'},{type:'user',content:null,synthetic_reason:'setup'}]));
  const entries=await check('grok',root);assert.equal(entries.length,3);assert.equal(entries.find(e=>e.sessionId==='parent').name,'Grok GUI');assert.equal(entries.find(e=>e.sessionId==='child').parentSessionId,'parent');assert.equal(entries.find(e=>e.sessionId==='empty').hiddenReason,'empty');
});
test('Reasonix meta title and recovery/subagent parent relationships',async()=>{
  const root=await fixture('reasonix');
  for(const id of ['base','base-recovery-1','subagents/sa_1'])await put(root,`projects/ws/sessions/${id}.jsonl`,jsonl([{role:'user',content:'question',createdAt:instant},{role:'assistant',content:'answer',reasoning_content:'thought',tool_calls:[{id:'c',name:'Read',arguments:'{}'}]},{role:'tool',tool_call_id:'c',name:'Read',content:'result'}]));
  await put(root,'projects/ws/sessions/base.jsonl.meta',{topic_title:'Reasonix GUI',workspace_root:root});
  await put(root,'projects/ws/sessions/subagents/sa_1.jsonl.meta',{parent_session_id:'base',topic_title:'child'});
  const entries=await check('reasonix',root);assert.equal(entries.find(e=>e.sessionId==='base').name,'Reasonix GUI');assert.equal(entries.find(e=>e.branchKind==='recovery').parentSessionId,'base');assert.equal(entries.filter(e=>e.hiddenReason==='subagent').length,1);
});
test('Qoder CLI, IDE, Quest sidecar, App and Work databases are readable',async()=>{
  const root=await fixture('qoder');
  await put(root,'projects/ws/cli.jsonl',jsonl(conversation));
  await put(root,'projects/ws/transcript/ide.jsonl',jsonl(conversation));
  await put(root,'projects/ws/cli/subagents/agent-a.jsonl',jsonl(conversation));
  await put(root,'projects/ws/task-q.session.execution.jsonl',jsonl([{role:'user',parts:[{type:'text',text:'quest question'}]},{role:'assistant',parts:[{type:'tool',tool:{id:'cq',name:'Read',args:{},result:'quest result'}}]}]));
  await put(root,'projects/ws/task-q.session.execution-session.json',{id:'quest',title:'Quest GUI',working_dir:root});
  await database(root,'main.sqlite','CREATE TABLE chat_sessions(session_id TEXT,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,deleted_at INTEGER,owner_session_id TEXT,origin_session_id TEXT,model TEXT); CREATE TABLE chat_session_messages(session_id TEXT,message_id TEXT,sequence INTEGER,payload_json TEXT,role TEXT,created_at INTEGER)',db=>{
    db.prepare('INSERT INTO chat_sessions VALUES(?,?,?,?,?,?,?,?,?,?)').run('app','App GUI',root,ms,ms,1,null,null,null,'model');
    db.prepare('INSERT INTO chat_session_messages VALUES(?,?,?,?,?,?)').run('app','m',1,JSON.stringify({parts:[{type:'text',text:'app question'}]}),'user',ms);
  });
  await database(root,'data/agents.db','CREATE TABLE projects(id TEXT,path TEXT); CREATE TABLE chats(id TEXT,name TEXT,project_id TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,deleted_at INTEGER); CREATE TABLE sub_chats(id TEXT,chat_id TEXT,session_id TEXT,name TEXT,created_at INTEGER,updated_at INTEGER,messages TEXT); CREATE TABLE messages(id TEXT,sub_chat_id TEXT,role TEXT,parts TEXT,created_at INTEGER,sequence INTEGER)',db=>{
    db.prepare('INSERT INTO projects VALUES(?,?)').run('p',root);db.prepare('INSERT INTO chats VALUES(?,?,?,?,?,?,?)').run('chat','Work GUI','p',ms,ms,null,null);db.prepare('INSERT INTO sub_chats VALUES(?,?,?,?,?,?,?)').run('tab','chat','work','Tab',ms,ms,'[]');db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('m','tab','user',JSON.stringify([{type:'text',text:'work question'}]),ms,1);
  });
  const entries=await check('qoder',root);assert.equal(entries.length,6);assert.equal(entries.find(e=>e.sessionId==='quest').name,'Quest GUI');assert.equal(entries.find(e=>e.sessionId==='app').hiddenReason,'archived');assert.equal(entries.find(e=>e.sessionId==='work').name,'Work GUI');
});
for(const name of ['opencode','zcode'])test(`${name} SQLite session/message/part and child visibility`,async()=>{
  const root=await fixture(name),file=name==='zcode'?'cli/db/db.sqlite':'opencode.db';
  await database(root,file,'CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,task_type TEXT,time_archived INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,sequence INTEGER,data TEXT)',db=>{
    for(const id of ['parent','child']){db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?,?,?)').run(id,`${name} GUI`,root,ms,ms,id==='child'?'parent':null,id==='child'?'subagent_child':'interactive',null);db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(id+'m',id,ms,JSON.stringify({role:'assistant'}));for(const [i,p]of [{type:'text',text:'answer'},{type:'reasoning',text:'think'},{type:'tool',callID:'c',tool:'Read',state:{input:{},output:'result',status:'completed'}}].entries())db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id+i,id+'m',id,ms,i,JSON.stringify(p));}
  });
  const before=await fs.readFile(path.join(root,file));const entries=await check(name,root);assert.equal(entries.length,2);assert.equal(entries.find(e=>e.sessionId==='child').hiddenReason,'subagent');assert.deepEqual(await fs.readFile(path.join(root,file)),before);
});
for(const name of ['openclaw','autoclaw'])test(`${name} file and zstd SQLite events with node parent keys`,async()=>{
  const root=await fixture(name);
  await put(root,'agents/a/sessions/file.jsonl',jsonl([{type:'session',cwd:root},{type:'message',message:{role:'user',content:'file question'}},{type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'c',name:'Read',arguments:{}},{type:'thinking',thinking:'claw thought'}]}},{type:'message',message:{role:'toolResult',toolCallId:'c',content:'claw result'}}]));
  await put(root,'agents/a/sessions/sessions.json',{'agent:a:main':{sessionId:'parent'},'agent:a:subagent:child':{sessionId:'file',label:'Claw GUI',spawnedBy:'agent:a:main'}});
  await database(root,'agents/b/agent/openclaw-agent.sqlite','CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at INTEGER,updated_at INTEGER,transcript_updated_at INTEGER,display_name TEXT,parent_session_key TEXT,spawned_by TEXT);CREATE TABLE session_nodes(session_key TEXT,display_name TEXT,label TEXT,entry_json TEXT,archived_at INTEGER,parent_session_key TEXT,spawned_by TEXT,fork_source_session_id TEXT);CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB)',db=>{
    for(const id of ['parent','child']){db.prepare('INSERT INTO session_windows VALUES(?,?,?,?,?,?,?,?)').run(id,id,ms,ms,ms,'window title',id==='child'?'parent':null,null);db.prepare('INSERT INTO session_nodes VALUES(?,?,?,?,?,?,?,?)').run(id,`${id} GUI`,'label','{}',null,null,null,null);db.prepare('INSERT INTO transcript_events VALUES(?,?,?,?)').run(id,1,null,zstdCompressSync(Buffer.from(JSON.stringify({type:'message',message:{role:'user',content:'sqlite question'}}))));}
  });
  const entries=await check(name,root);assert.equal(entries.length,3);assert.equal(entries.find(e=>e.sessionId==='file').name,'Claw GUI');assert.equal(entries.find(e=>e.sessionId==='child').parentSessionId,'parent');
});
test('generic handles JSONL, glob exclusion and non-empty default parsing',async()=>{
  const root=await fixture('generic');await put(root,'session.jsonl',jsonl(conversation));await put(root,'exclude/events.jsonl',jsonl(conversation));
  const adapter=require('../lib/harnesses/generic').createGenericHarness({id:'example',label:'Example',roots:[root],glob:'**/*.jsonl',exclude:'exclude/**',title:()=> 'GUI'});
  const entries=await adapter.scan(root);assert.equal(entries.length,1);assert.equal(entries[0].key,'example:session');assert.equal(entries[0].name,'GUI');assert.ok((await adapter.messages(entries[0])).some(m=>m.tools?.length));
});
test('Reasonix tool-result child links collapse recovery copies and reject ambiguous parents',async()=>{
  const root=await fixture('reasonix-links');
  for(const id of ['base','base-recovery-1','other','subagents/sa_unique','subagents/sa_ambiguous','subagents/sa_foreign']){
    const records=[{role:'user',content:'question'}];
    if(id==='base'||id==='base-recovery-1')records.push({role:'tool',name:'explore',content:'Completed sa_unique and sa_ambiguous'});
    if(id==='other')records.push({role:'tool',name:'explore',content:'Completed sa_ambiguous'});
    await put(root,`projects/ws/sessions/${id}.jsonl`,jsonl(records));
  }
  await put(root,'projects/elsewhere/sessions/foreign.jsonl',jsonl([{role:'tool',name:'explore',content:'Completed sa_foreign'}]));
  const entries=await check('reasonix',root);
  assert.equal(entries.find(e=>e.sessionId==='sa_unique').parentSessionId,'base');
  assert.equal(entries.find(e=>e.sessionId==='sa_ambiguous').parentSessionId,null);
  assert.equal(entries.find(e=>e.sessionId==='sa_foreign').parentSessionId,null);
  assert.equal(entries.find(e=>e.sessionId==='base-recovery-1').parentSessionId,'base');
});
test('generic metadata callbacks preserve fields and refresh without transcript changes',async()=>{
  const root=await fixture('generic-meta');await put(root,'session.json',{messages:[{role:'user',content:'question'}]});
  let name='GUI title';
  const adapter=require('../lib/harnesses/generic').createGenericHarness({id:'meta',roots:[root],metadata:async()=>({sessionId:'mapped',name,parentSessionId:'parent',subagent:true,workspacePath:root,createdAt:instant})});
  const [entry]=await adapter.scan(root);
  assert.equal(entry.key,'meta:mapped');assert.equal(entry.name,name);assert.equal(entry.parentSessionId,'parent');assert.equal(entry.hiddenReason,'subagent');assert.equal(entry.workspacePath,root);assert.equal(entry.createdAt,instant);
  name='GUI renamed';const [updated]=await adapter.scan(root,{previous:new Map([[entry.key,entry]])});
  assert.equal(updated.name,name);
});
