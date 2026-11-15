import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import {join} from 'node:path';
import {Writable,Readable} from 'node:stream';
import {once} from 'node:events';
import {launch} from '../scripts/browser-eval/containment.mjs';
import {createWriteStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Connection} from 'puppeteer-core/lib/puppeteer/cdp/Connection.js';
import {createRowTrace} from '../scripts/browser-eval/trace.mjs';

async function fixture(fn) {
  const root=await fs.mkdtemp(join(os.tmpdir(),'eval-trace-test-'));
  try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
async function row(root,name='row',options) {
  const directory=join(root,name);
  const trace=await createRowTrace(directory,{row:name,engine:'fake'},options);
  const source=Readable.from(['synthetic stdout\n']);
  trace.captureStdout(source);
  await once(source,'end');
  return trace;
}
async function records(trace) {
  return (await fs.readFile(join(trace.directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
}

test('trace preserves method this/arguments/promise/value/error and restores descriptors',async()=>fixture(async root=>{
  const trace=await row(root);
  const expectedPromise=Promise.resolve({value:1}),failure=new Error('original failure');
  const options={waitUntil:'load',timeout:15000};let receiver,received;
  const prototype={goto(...args){receiver=this;received=args;return expectedPromise;}};
  const page=Object.create(prototype);
  page.evaluate=()=>{throw failure};
  page.type=()=>Promise.reject(failure);
  page.click=()=>42;
  page.$eval=()=>expectedPromise;
  const before=Object.getOwnPropertyDescriptor(page,'evaluate'),restore=trace.install(page);
  await trace.runOperation('warmup',0,async()=>{
    assert.equal(page.goto('/same',options),expectedPromise);
    assert.equal(receiver,page);assert.equal(received[1],options);
    assert.equal(options.timeout,15000);assert.equal(page.click(),42);
    assert.throws(()=>page.evaluate(),e=>e===failure);
    await assert.rejects(page.type(),e=>e===failure);
    assert.equal(await page.$eval(),await expectedPromise);
  });
  restore();assert(!Object.hasOwn(page,'goto'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(page,'evaluate'),before);
  assert.equal((await trace.close()).status,'complete');
  const events=await records(trace);
  assert(events.some(e=>e.event==='call-start'&&e.method==='goto'&&e.args[1].timeout===15000));
  assert.equal(events.filter(e=>e.event==='call-error').length,2);
  assert(events.filter(e=>e.event.startsWith('call-')).every(e=>e.operation.kind==='warmup'));
}));

test('failed operation is retained, flushed and separated from the next row',async()=>fixture(async root=>{
  const first=await row(root,'first'),second=await row(root,'second'),failure=new Error('goto timed out');
  const page={goto:()=>Promise.reject(failure)},restore=first.install(page);
  await assert.rejects(first.runOperation('measured',0,()=>page.goto()),e=>e===failure);
  first.stderr(Buffer.from('full stderr\n'));restore();
  assert.equal((await first.close()).status,'complete');
  assert.equal(await fs.readFile(join(first.directory,'stderr.log'),'utf8'),'full stderr\n');
  await second.runOperation('warmup',1,async()=>{});
  await second.close();
  const a=await records(first),b=await records(second);
  assert(a.some(e=>e.event==='operation-error'&&e.error.includes('goto timed out')));
  assert(a.every(e=>e.row==='first'));assert(b.every(e=>e.row==='second'));
  assert(!b.some(e=>e.event==='operation-error'));
  await assert.rejects(createRowTrace(first.directory,{}),{code:'EEXIST'});
}));

test('installed Puppeteer Connection logger retains raw request/reply/event IDs',async()=>fixture(async root=>{
  const trace=await row(root);
  const transport={
    send(message){
      const sent=JSON.parse(message);
      queueMicrotask(()=>{
        this.onmessage(JSON.stringify({id:sent.id,result:{frameId:'frame',loaderId:'loader'}}));
        this.onmessage(JSON.stringify({method:'Page.lifecycleEvent',sessionId:'session',
          params:{frameId:'frame',loaderId:'loader',name:'load'}}));
      });
    },
    close(){this.onclose?.();},
  };
  const connection=new Connection('ws://synthetic',transport,0,15000,false,undefined,trace.logger);
  const response=await connection.send('Page.navigate',{url:'http://fixture/interaction'});
  assert.equal(response.loaderId,'loader');connection.dispose();
  await trace.close();
  const wire=(await records(trace)).filter(e=>e.event==='cdp');
  assert(wire.some(e=>e.direction==='send'&&e.message.method==='Page.navigate'));
  assert(wire.some(e=>e.direction==='receive'&&e.message.id&&e.message.result.loaderId==='loader'));
  assert(wire.some(e=>e.message.sessionId==='session'&&e.message.params.frameId==='frame'));
}));

test('trace serialization failure does not replace operation result and marks incomplete',async()=>fixture(async root=>{
  const trace=await row(root),arg={};arg.cycle=arg;
  const page={goto:value=>value},restore=trace.install(page);
  assert.equal(page.goto(arg),arg);restore();
  assert.throws(()=>trace.assertHealthy(),/Incomplete diagnostic trace/);
  await assert.rejects(trace.close(),/Incomplete diagnostic trace/);
  const manifest=JSON.parse(await fs.readFile(join(trace.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.status,'incomplete');
}));

test('asynchronous sink errors are failures, not silent trace loss',async()=>fixture(async root=>{
  const trace=await row(root,'broken',{streamFactory:(path,options)=>{
    if(!path.endsWith('events.jsonl'))return createWriteStream(path,options);
    return new Writable({write(_chunk,_encoding,done){done(new Error('synthetic disk full'));}});
  }});
  await assert.rejects(trace.close(),/synthetic disk full/);
  assert.equal(trace.status().status,'incomplete');
}));


test('trace-enabled harness retains failed-launch evidence without executing a workload',
  {skip:process.platform!=='linux',timeout:15000},async()=>fixture(async root=>{
    const binary=join(root,'fake-engine');
    await fs.writeFile(binary,"#!/bin/sh\nprintf 'fake engine stdout\\n'\nprintf 'fake engine failure\\n' >&2\nexit 1\n",{mode:0o755});
    const config=join(root,'config.json'),output=join(root,'raw.json'),traceRoot=join(root,'trace');
    await fs.writeFile(config,JSON.stringify({trials:3,warmups:2,repetitions:2,
      engines:['kitesurf','chromium','lightpanda'].map(id=>({id,binary,runtimeIdentity:'TEST ONLY'}))}));
    const harness=fileURLToPath(new URL('../scripts/browser-eval/run.mjs',import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath,[harness,'--config',config,'--output',output,'--measurement-window-reserved'],
      {env:{...process.env,BROWSER_EVAL_TRACE_DIR:traceRoot},timeout:12000}),error=>error.code===1);
    const report=JSON.parse(await fs.readFile(output,'utf8'));
    assert.equal(report.diagnosticOnly,true);assert.equal(report.status,'failed');
    assert.equal(report.runs.length,1);const row=report.runs[0];
    assert.equal(row.status,'failed');assert.equal(row.wallMs.length,0);
    assert.equal(row.trace.status,'complete');
    assert.match(await fs.readFile(join(row.trace.directory,'stdout.log'),'utf8'),/fake engine stdout/);
    assert.match(await fs.readFile(join(row.trace.directory,'stderr.log'),'utf8'),/fake engine failure/);
    const events=(await fs.readFile(join(row.trace.directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert(events.some(event=>event.event==='failure-snapshot'&&event.host['/proc/meminfo']));
    assert.equal(events.at(-1).event,'row-trace-close');
    assert(!events.some(event=>event.event==='operation-start'));
  }));


for(const code of ['ENOSPC','EIO'])test('stdout '+code+' fails trace and drains the engine pipe for cleanup',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async root=>{
    const trace=await createRowTrace(join(root,'row'),{row:1},{streamFactory:(path,options)=>{
      if(!path.endsWith('stdout.log'))return createWriteStream(path,options);
      return new Writable({highWaterMark:1,write(_chunk,_encoding,done){done(Object.assign(new Error('stdout '+code),{code}));}});
    }});
    // More than a pipe buffer: an error handler that leaves the source paused
    // would prevent this producer from reaching its stderr readiness marker.
    const source="const chunk=Buffer.alloc(65536);let n=0;function pump(){while(n<32){n++;if(!process.stdout.write(chunk)){process.stdout.once('drain',pump);return;}}process.stderr.write('fully drained');setInterval(()=>{},1000);}pump();";
    const owner=launch(process.execPath,['-e',source],process.env,{captureStdout:true});
    trace.captureStdout(owner.stdout);
    const marker=once(owner.child.stderr,'data');
    let rootPid;
    try {
      rootPid=await owner.ready;
      assert.equal(String((await marker)[0]),'fully drained');
      assert.throws(()=>trace.assertHealthy(),new RegExp(code));
    } finally {
      trace.drainStdout();
      assert.deepEqual(await owner.stop(),{status:'empty',verification:'subreaper waitpid ECHILD'});
      await assert.rejects(trace.close(),new RegExp(code));
    }
    const manifest=JSON.parse(await fs.readFile(join(trace.directory,'manifest.json'),'utf8'));
    assert.equal(manifest.status,'incomplete');
    await assert.rejects(fs.access('/proc/'+rootPid),{code:'ENOENT'});
  }));

test('stdout errors at final flush are incomplete even after successful writes',async()=>fixture(async root=>{
  const trace=await row(root,'final-error',{streamFactory:(path,options)=>{
    if(!path.endsWith('stdout.log'))return createWriteStream(path,options);
    return new Writable({write(_chunk,_encoding,done){done();},final(done){done(new Error('late stdout EIO'));}});
  }});
  await assert.rejects(trace.close(),/late stdout EIO/);
  assert.equal(trace.status().status,'incomplete');
}));

test('stalled stdout flush is bounded and cannot hang trace closure',async()=>fixture(async root=>{
  const trace=await row(root,'stalled',{flushTimeoutMs:25,streamFactory:(path,options)=>{
    if(!path.endsWith('stdout.log'))return createWriteStream(path,options);
    return new Writable({write(_chunk,_encoding,done){done();},final(){}});
  }});
  await assert.rejects(trace.close(),/flush timed out/);
  assert.equal(trace.status().status,'incomplete');
}));
