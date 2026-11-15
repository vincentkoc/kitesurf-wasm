import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Connection} from 'puppeteer-core/lib/puppeteer/cdp/Connection.js';
import {createCdpRing} from '../scripts/browser-eval/ring.mjs';
import {launch} from '../scripts/browser-eval/containment.mjs';
import {summarize} from '../scripts/browser-eval/summary.mjs';

const SEND='puppeteer:protocol:SEND ►',RECV='puppeteer:protocol:RECV ◀';
async function fixture(fn){
  const root=await fs.mkdtemp(join(os.tmpdir(),'eval-ring-test-'));
  try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
const records=async dir=>(await fs.readFile(join(dir,'cdp.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

test('ring bounds entry count and payload; overflow is explicit, messages never sliced',async()=>fixture(async root=>{
  const ring=createCdpRing({maxEntries:3,maxPayloadBytes:60,readSnapshot:async()=>({test:true})});
  const send=ring.logger(SEND);
  for(let i=1;i<=5;i++)send(JSON.stringify({id:i}));
  assert.equal(ring.status().retained,3);
  assert.equal(ring.status().dropped,2);
  send('x'.repeat(31)); // Larger than the entire UTF-16 payload allowance.
  assert.equal(ring.status().oversized,1);
  assert.equal(ring.status().dropped,3);
  assert(ring.status().retainedPayloadBytes<=60);
  const dir=join(root,'failed'),result=await ring.dumpFailure(dir,{error:'timeout'},123);
  assert.equal(result.status,'written');
  assert.equal(result.historyTruncated,true);
  assert.equal(result.completeHistory,false);
  assert.deepEqual((await records(dir)).map(x=>x.message.id),[3,4,5]);
  assert.equal(result.received,6);
  assert.throws(()=>createCdpRing({maxEntries:0}),/entry limit/);
  assert.throws(()=>createCdpRing({maxPayloadBytes:Infinity}),/payload limit/);
}));

test('payload limit also evicts before entry capacity and preserves sequence',async()=>fixture(async root=>{
  const ring=createCdpRing({maxEntries:100,maxPayloadBytes:32,readSnapshot:async()=>({})});
  for(let id=1;id<=5;id++)ring.logger(RECV)(JSON.stringify({id}));
  assert.equal(ring.status().retained,2);
  const dir=join(root,'bytes');await ring.dumpFailure(dir,{},null);
  assert.deepEqual((await records(dir)).map(x=>x.sequence),[4,5]);
}));

test('hot logger performs no I/O, parsing or snapshot; success discards and remains diagnostic',()=>{
  let ioCalls=0,snapshotCalls=0;
  const io=new Proxy({}, {get(){ioCalls++;throw Error('unexpected hot-path I/O');}});
  const ring=createCdpRing({maxEntries:4,maxPayloadBytes:100,io,readSnapshot:()=>{snapshotCalls++;throw Error('unexpected snapshot');}});
  assert.equal(ring.logger('unrelated channel'),undefined);
  const log=ring.logger(RECV);
  for(let i=0;i<10000;i++)log('not JSON');
  assert.equal(ioCalls,0);assert.equal(snapshotCalls,0);
  assert.equal(ring.status().retained,4);
  const result=ring.discard();
  assert.equal(result.status,'discarded');
  assert.equal(result.historyTruncated,true);
  assert.equal(result.completeHistory,false);
  log('late');
  assert.deepEqual(ring.status(),result);
  assert.equal(ioCalls,0);
  assert.throws(()=>summarize({schema:1,diagnosticOnly:true,status:'passed'}),/Diagnostic.*timings/);
});

test('failed dump freezes raw request/reply and loader/session IDs; no page wrappers or extra commands',async()=>fixture(async root=>{
  const ring=createCdpRing({readSnapshot:async pid=>({pid,testOnly:true})});
  const sent=[];
  const transport={
    send(raw){
      sent.push(JSON.parse(raw));
      queueMicrotask(()=>{
        this.onmessage(JSON.stringify({id:sent.at(-1).id,result:{frameId:'frame',loaderId:'loader'}}));
        this.onmessage(JSON.stringify({method:'Page.lifecycleEvent',sessionId:'session',
          params:{frameId:'frame',loaderId:'loader',name:'load'}}));
      });
    },
    close(){this.onclose?.();},
  };
  const connection=new Connection('ws://synthetic',transport,0,15000,false,undefined,ring.logger);
  const answer=await connection.send('Page.navigate',{url:'http://fixture/interaction'});
  assert.deepEqual(answer,{frameId:'frame',loaderId:'loader'});
  assert.equal(sent.length,1);assert.equal(sent[0].method,'Page.navigate');
  assert.equal(ring.install,undefined);
  const dir=join(root,'timeout'),promise=ring.dumpFailure(dir,{error:'original timeout',completedMeasuredOperations:0},321);
  ring.logger(SEND)('{"id":999}');
  const result=await promise;assert.equal(result.status,'written');
  assert.equal(await ring.dumpFailure(dir,{},0),result);connection.dispose();
  const saved=await records(dir);
  assert.equal(saved.length,3);
  assert(saved.some(x=>x.message.id===sent[0].id&&x.message.result?.loaderId==='loader'));
  assert(saved.some(x=>x.message.sessionId==='session'&&x.message.params?.frameId==='frame'));
  const failure=JSON.parse(await fs.readFile(join(dir,'failure.json'),'utf8'));
  assert.equal(failure.context.error,'original timeout');assert.equal(failure.snapshot.pid,321);
  assert.equal(result.historyTruncated,false);assert.equal(result.completeHistory,false);
}));

test('invalid capture and dump failures are explicitly incomplete',async()=>fixture(async root=>{
  const ring=createCdpRing({readSnapshot:async()=>{throw Error('snapshot unavailable');}});
  ring.logger(RECV)(42);ring.logger(RECV)('broken JSON');
  assert.equal(ring.status().captureErrors,1);
  const result=await ring.dumpFailure(join(root,'invalid'),{error:'navigation timeout'});
  assert.equal(result.status,'incomplete');assert(result.errors.some(x=>x.includes('snapshot unavailable')));
  const broken=createCdpRing({readSnapshot:async()=>({}),io:{mkdir:async()=>{throw Error('disk full');},writeFile:async()=>{throw Error('disk full');}}});
  assert.equal((await broken.dumpFailure(join(root,'disk'),{})).status,'incomplete');
  const invalid=createCdpRing();invalid.logger(RECV)(null);
  assert.equal(invalid.discard().status,'incomplete');
}));

for(const blocked of ['snapshot','write'])test('stalled ring '+blocked+' times out, then containment reaches ECHILD',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async root=>{
    const owner=launch(process.execPath,['-e','setInterval(()=>{},1000)']);
    const pid=await owner.ready;
    let signal,release;
    const stuck=new Promise(resolve=>{release=resolve;});
    let writes=0;
    const ring=createCdpRing({dumpTimeoutMs:25,
      readSnapshot:async(_pid,options)=>{signal=options.signal;return blocked==='snapshot'?stuck:{};},
      io:{mkdir:async()=>{},writeFile:async()=>{writes++;return stuck;}},
    });
    ring.logger(SEND)('{"id":1,"method":"Page.navigate"}');
    const started=performance.now();let result;
    try{
      result=await ring.dumpFailure(join(root,'failed'),{error:'original timeout'},owner.child.pid);
      assert.equal(result.status,'incomplete');assert.equal(result.timedOut,true);
      assert.match(result.errors.join('\n'),/dump timed out/);
      assert(performance.now()-started<1500,'dump must not hold cleanup indefinitely');
    }finally{assert.deepEqual(await owner.stop(),{status:'empty',verification:'subreaper waitpid ECHILD'});}
    assert.equal(signal.aborted,true);
    await assert.rejects(fs.access('/proc/'+pid),{code:'ENOENT'});
    const saved=JSON.stringify({ring:result}),before=writes;
    release({late:true});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(writes,before,'no next I/O stage may start after timeout');
    assert.equal(ring.status(),result);assert.equal(JSON.stringify({ring:result}),saved);
    assert(Object.isFrozen(result));assert(Object.isFrozen(result.errors));
  }));

test('late final manifest completion is provisional and cannot promote timed-out state',async()=>fixture(async root=>{
  let release,manifest,signal;
  const writes=[];
  const stuck=new Promise(resolve=>{release=resolve;});
  const ring=createCdpRing({dumpTimeoutMs:25,readSnapshot:async()=>({}),io:{
    mkdir:async()=>{},writeFile:async(path,contents,options)=>{
      writes.push(path);signal=options.signal;
      if(path.endsWith('manifest.json')){manifest=JSON.parse(contents);await stuck;}
    },
  }});
  const result=await ring.dumpFailure(join(root,'final-write'),{error:'original failure'},1);
  assert.equal(result.status,'incomplete');assert.equal(result.timedOut,true);
  assert.equal(manifest.status,'pending');assert.equal(manifest.completionAuthority,'raw report row.ring');
  assert.equal(signal.aborted,true);
  const saved=JSON.stringify(result);release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ring.status(),result);assert.equal(JSON.stringify(result),saved);assert.equal(writes.length,3);
}));

test('harness mode selection: normal stays untraced; ring captures failed launch only',
  {skip:process.platform!=='linux',timeout:20000},async()=>fixture(async root=>{
    const binary=join(root,'fake-engine');
    await fs.writeFile(binary,"#!/bin/sh\nprintf 'synthetic launch failure\\n' >&2\nexit 1\n",{mode:0o755});
    const config=join(root,'config.json');
    await fs.writeFile(config,JSON.stringify({trials:3,warmups:2,repetitions:2,
      engines:['kitesurf','chromium','lightpanda'].map(id=>({id,binary,runtimeIdentity:'TEST ONLY'}))}));
    const harness=fileURLToPath(new URL('../scripts/browser-eval/run.mjs',import.meta.url));
    for(const mode of ['normal','ring']){
      const output=join(root,mode+'.json'),ringRoot=join(root,mode+'-ring');
      const env={...process.env,BROWSER_EVAL_TRACE_DIR:'',BROWSER_EVAL_RING_DIR:mode==='ring'?ringRoot:''};
      await assert.rejects(promisify(execFile)(process.execPath,[harness,'--config',config,'--output',output,'--measurement-window-reserved'],{env,timeout:12000}),e=>e.code===1);
      const report=JSON.parse(await fs.readFile(output,'utf8')),row=report.runs[0];
      assert.equal(report.diagnosticOnly,mode==='ring');assert.equal(row.status,'failed');
      assert.equal(row.wallMs.length,0);assert.equal(row.trace,undefined);
      if(mode==='ring'){
        assert.equal(report.diagnosticMode,'failure-ring');assert.equal(row.ring.status,'written');
        const failure=JSON.parse(await fs.readFile(join(row.ring.directory,'failure.json'),'utf8'));
        assert(failure.snapshot.host['/proc/meminfo']);
        assert.match(failure.context.stderrTail,/synthetic launch failure/);
        assert.deepEqual(await records(row.ring.directory),[]);
      }else{
        assert.equal(row.ring,undefined);await assert.rejects(fs.access(ringRoot),{code:'ENOENT'});
      }
    }
    const conflict=join(root,'conflict.json'),both=join(root,'both');
    await assert.rejects(promisify(execFile)(process.execPath,[harness,'--config',config,'--output',conflict,'--measurement-window-reserved'],
      {env:{...process.env,BROWSER_EVAL_TRACE_DIR:both,BROWSER_EVAL_RING_DIR:both},timeout:5000}),e=>e.code===1&&e.stderr.includes('mutually exclusive'));
    await assert.rejects(fs.access(both),{code:'ENOENT'});await assert.rejects(fs.access(conflict),{code:'ENOENT'});
  }));
