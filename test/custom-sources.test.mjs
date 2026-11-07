import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { zstdCompressSync } from 'node:zlib';
import { fixture, put, jsonl, database, conversation, instant, ms } from './fixtures/other/helpers.mjs';
const require=createRequire(import.meta.url);
const {validateSpec,loadCustomSources}=require('../lib/custom-sources');
const {makeDeclarativeSource}=require('../lib/sources/declarative');
const {matchesGlob}=require('../lib/drivers/fsutil');
const {buildCorpus}=require('../lib/forge');
const {project}=require('../lib/import/project');
const baseSpec=(root,extra={})=>({id:'fixture-source',label:'Fixture',driver:'jsonl-transcript',root,...extra});
test('legacy documented JSONL config, tool blocks, firstUser and Forge compatibility',async()=>{
  const root=await fixture('legacy');
  const text=await fs.readFile(new URL('../docs/CUSTOM-SOURCES.md',import.meta.url),'utf8');
  const documented=[...text.matchAll(/```json\s*([\s\S]*?)```/g)].map(m=>{try{return JSON.parse(m[1]);}catch{return null;}}).find(s=>s?.driver==='jsonl-transcript');
  documented.root=root;
  await put(root,'old.jsonl',jsonl([{role:'human',message:{content:[{type:'text',text:'old question'}]},timestamp:instant},{type:'tool_use',name:'Read',input:{path:'x'},output:'legacy output',status:'completed'}]));
  assert.equal(validateSpec(documented,0).ok,true);
  const source=makeDeclarativeSource(documented),[entry]=await source.scan();
  assert.equal(entry.title,'old question');
  const messages=await source.messages(entry), converted=await source.convert(entry);
  assert.deepEqual(messages,converted.messages);assert.equal(entry.messageCount,messages.length);
  assert.match(buildCorpus([{...converted.session,messages:converted.messages}]),/legacy output/);
  assert.match(project(entry,messages).messages.map(m=>m.text).join('\n'),/Read/);
});
test('fileName/include/exclude select before maxFiles; sidecar title and tool arrays are retained',async()=>{
  const root=await fixture('sidecar');
  for(const name of ['events.jsonl','updates.jsonl','chat_history.jsonl'])await put(root,'s/'+name,jsonl([{role:'user',content:'question'},{role:'assistant',content:'answer',reasoning_content:'thought',tool_calls:[{id:'c',name:'Read',arguments:'{"path":"f"}'}]},{role:'tool',tool_call_id:'c',content:'tool result'}]));
  await put(root,'s/summary.json',{title:'GUI rename',parent:'p',cwd:root,created:instant,deleted:false,archived:false});
  await put(root,'excluded/chat_history.jsonl',jsonl([{role:'user',content:'excluded'}]));
  const spec=baseSpec(root,{maxFiles:1,fileName:'chat_history.jsonl',include:'**/chat_history.jsonl',exclude:'excluded/**',session:{idFrom:'parentDir'},sidecar:{path:'{dir}/summary.json',titlePath:'title',parentPath:'parent',cwdPath:'cwd',createdPath:'created',deletedPath:'deleted',archivedPath:'archived'},entry:{rolePath:'role',content:'content',thinkingPath:'reasoning_content',toolCall:{callArray:{path:'tool_calls',idPath:'id',namePath:'name',argsPath:'arguments',argsJson:true},result:{match:{path:'role',in:['tool']},idPath:'tool_call_id',resultPath:'content'}}}});
  const source=makeDeclarativeSource(spec);const [e]=await source.scan();assert.equal(e.sessionId,'s');assert.equal(e.title,'GUI rename');assert.equal(e.parentSessionId,'p');assert.equal(e.hiddenReason,'subagent');
  const messages=await source.messages(e);const tool=messages.flatMap(m=>m.tools??[])[0];assert.deepEqual(tool.args,{path:'f'});assert.equal(tool.result,'tool result');assert.ok(messages.some(m=>m.thinking?.includes('thought')));
  assert.ok((await source.messages(e,{withThinking:false})).every(m=>!m.thinking&&!m.content.includes('thought')));
});
test('lastEntry title priorities, late session id, parent flags and incomplete call id',async()=>{
  const root=await fixture('markers');
  await put(root,'marker.jsonl',jsonl([{type:'meta',id:'real',parent:'p',subagent:false},{type:'user',content:'question'},{type:'summary',title:'summary'},{type:'custom-title',title:'GUI'},{type:'function_call',id:'c',name:'Read',arguments:'{}'}]));
  const spec=baseSpec(root,{session:{idFrom:'id',idFromEntry:{path:'type',in:['meta']},titleFrom:{first:[{lastEntry:{match:{path:'type',in:['custom-title']},path:'title'}},{lastEntry:{match:{path:'type',in:['summary']},path:'title'}}]},parentFrom:'parent',subagentFrom:'subagent',branchFrom:{literal:'fork'}},entry:{rolePath:'type',content:'content',toolCall:{call:{types:['function_call'],idPath:'id',namePath:'name',argsPath:'arguments',argsJson:true}}}});
  const source=makeDeclarativeSource(spec),[e]=await source.scan();assert.equal(e.sessionId,'real');assert.equal(e.title,'GUI');assert.equal(e.visible,true);
  const tool=(await source.messages(e)).flatMap(m=>m.tools??[])[0];assert.equal(tool.id,'c');assert.equal(tool.status,'pending');
});
test('json-tree documented paths preserve metadata, thinking and count',async()=>{
  const root=await fixture('tree');await put(root,'tree.json',{id:'tree',title:'Tree GUI',directory:root,createdAt:instant,messages:[{role:'user',content:'tree question',createdAt:instant},{role:'assistant',content:'tree answer',thinking:'tree thought'}]});
  const spec=baseSpec(root,{driver:'json-tree',session:{idPath:'id',titlePath:'title',tsPath:'createdAt',pathPath:'directory',messagesPath:'messages'},message:{rolePath:'role',content:{path:'content'},thinking:'thinking',tsPath:'createdAt'}});
  const source=makeDeclarativeSource(spec),[e]=await source.scan();assert.equal(e.title,'Tree GUI');assert.equal(e.messageCount,2);assert.equal((await source.messages(e))[1].thinking[0],'tree thought');
});
test('declarative multi-frame zstd shares normalized parsing',async()=>{
  const root=await fixture('zstd');await put(root,'s.jsonl.zstd',Buffer.concat([zstdCompressSync(Buffer.from(jsonl(conversation.slice(0,1)))),zstdCompressSync(Buffer.from(jsonl(conversation.slice(1))))]));
  const source=makeDeclarativeSource(baseSpec(root,{extension:'.jsonl.zstd'})),[e]=await source.scan();assert.equal(e.sessionId,'s');assert.ok((await source.messages(e)).some(m=>m.tools?.[0]?.result==='fixture output'));
});
test('SQLite direct role columns pair calls across rows and stay read-only',async()=>{
  const root=await fixture('sqlite-direct');
  const db=await database(root,'direct.db','CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,role TEXT,content TEXT,time_created INTEGER,sequence INTEGER,data TEXT)',db=>{
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run('s','SQLite GUI',root,ms,ms,'parent');
    for(const [i,m]of [{role:'user',content:'question'},{role:'assistant',content:'answer',tool_calls:[{id:'c',name:'Read',arguments:'{}'}]},{role:'tool',tool_call_id:'c',content:'db result'}].entries())db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?,?)').run(String(i),'s',m.role,m.content,ms,i,JSON.stringify(m));
  });
  const before=await fs.readFile(db),spec=baseSpec(root,{driver:'sqlite-session',db,session:{parentCol:'parent_id'},message:{roleCol:'role',contentCol:'content'}});
  const source=makeDeclarativeSource(spec),[e]=await source.scan();const messages=await source.messages(e);assert.equal(e.parentSessionId,'parent');assert.equal(messages.flatMap(m=>m.tools??[]).length,1);assert.equal(messages.flatMap(m=>m.tools??[])[0].result,'db result');assert.equal(e.messageCount,messages.length);assert.deepEqual(await fs.readFile(db),before);
});
test('SQLite original part spec keeps sequence, tool status, thinking and exclusion as hidden',async()=>{
  const root=await fixture('sqlite-parts');const db=await database(root,'parts.db','CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,task_type TEXT,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,sequence INTEGER,data TEXT)',db=>{
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?,?)').run('s','Part GUI',root,ms,ms,'subagent_child','p');db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m','s',ms,JSON.stringify({role:'assistant'}));
    for(const [i,p]of [{type:'reasoning',text:'db thought'},{type:'tool',callID:'c',tool:'Read',state:{status:'completed',input:{},output:'parts result'}},{type:'text',text:'answer'}].entries())db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(String(3-i),'m','s',ms,i,JSON.stringify(p));
  });
  const spec=baseSpec(root,{driver:'sqlite-session',db,session:{exclude:[{col:'task_type',equals:'subagent_child'}]},message:{table:'message'},part:{table:'part',textTypes:['text'],toolType:'tool',toolNamePath:'tool',argsPath:'state.input',resultPath:'state.output',statusPath:'state.status'}});
  const source=makeDeclarativeSource(spec),[e]=await source.scan();const messages=await source.messages(e);assert.equal(e.hiddenReason,'subagent');assert.equal(messages[0].thinking[0],'db thought');assert.equal(messages[1].tools[0].result,'parts result');assert.equal(messages[2].text,'answer');
});
test('validation preserves old guards, expands home and relative paths, rejects duplicate ids',async()=>{
  const root=await fixture('validation');const valid=baseSpec('sessions');
  assert.equal(validateSpec(valid,0,{workspaceRoot:root}).spec.root,path.join(root,'sessions'));
  assert.equal(validateSpec(baseSpec('~\\.example'),0).spec.root,path.join(os.homedir(),'.example'));
  for(const raw of [baseSpec(os.homedir()),baseSpec(path.parse(root).root),baseSpec(root,{driver:'bad'}),baseSpec(root,{id:'grok'}),baseSpec(root,{entry:{script:'bad'}}),baseSpec(root,{include:1})])assert.equal(validateSpec(raw,0).ok,false);
  const loaded=await loadCustomSources({workspaceRoot:root,readText:async()=>JSON.stringify({sources:[valid,valid]})});assert.equal(loaded.specs.length,1);assert.match(loaded.errors[0],/duplicate/);
  assert.ok(matchesGlob('s/chat_history.jsonl','**/chat_history.jsonl'));assert.ok(matchesGlob('chat_history.jsonl','**/chat_history.jsonl'));assert.equal(matchesGlob('s/events.jsonl','**/chat_history.jsonl'),false);
});
test('sidecars cannot traverse outside a declared source',async()=>{
  const root=await fixture('sidecar-guard');await put(root,'s.jsonl',jsonl([{role:'user',content:'question'}]));
  const source=makeDeclarativeSource(baseSpec(root,{sidecar:{path:'../outside.json',titlePath:'title'}}));
  await assert.rejects(()=>source.scan(),/outside/);
});
test('dynamic registry uses unified declarative messages for tools and import',async()=>{
  const root=await fixture('registry');await put(root,'s.jsonl',jsonl(conversation));
  const {refreshDynamicSources,registry}=require('../lib/registry');
  await refreshDynamicSources({readText:async()=>JSON.stringify([baseSpec(root)])});
  const adapter=registry.get('fixture-source');assert.ok(adapter);const [e]=await adapter.scan();assert.equal(e.key,'fixture-source:s');
  const messages=await adapter.messages(e);assert.ok(messages.some(m=>m.thinking?.length));assert.match(project(e,messages).messages.map(m=>m.text).join('\n'),/fixture output/);
});
