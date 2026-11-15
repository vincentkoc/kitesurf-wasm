import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launch} from '../scripts/browser-eval/containment.mjs';
import {captureNative,nativeIdentity,gdbArguments,nativeCommand} from '../scripts/browser-eval/native.mjs';

const binary=await fs.realpath(process.execPath);
const expected={binary,sha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex')};
async function fixture(fn){
  const dir=await fs.mkdtemp(join(os.tmpdir(),'eval-native-test-'));
  const owner=launch(binary,['-e','setInterval(()=>{},1000)'],process.env,{captureControl:true});
  const pid=await owner.ready;
  try{await fn({dir,owner,pid});}
  finally{
    assert.deepEqual(await owner.stop(),{status:'empty',verification:'subreaper waitpid ECHILD'});
    await assert.rejects(fs.access('/proc/'+pid),{code:'ENOENT'});
    await fs.rm(dir,{recursive:true,force:true});
  }
}
async function debuggerFile(dir,body){
  const file=join(dir,'fake-gdb');
  await fs.writeFile(file,'#!'+process.execPath+'\n'+body,{mode:0o755});
  return file;
}
const marker="const marker=process.argv.find(x=>x.startsWith('echo NATIVE_DETACHED_')).slice(5).replace(/\\\\n$/,'\\n');";

test('native GDB command only observes, disables auto-loading, and uses independent watchdog',()=>{
  const args=gdbArguments(123,'a'.repeat(32));
  const commands=args.flatMap((v,i)=>v==='-ex'||v==='-iex'?[args[i+1]]:[]);
  assert(commands.includes('set auto-load no'));
  assert(commands.includes('set debuginfod enabled off'));
  assert(commands.includes('thread apply all -c bt -no-filters 32'));
  assert(commands.includes('detach'));
  assert(!commands.some(x=>/^(run|continue|call|break|set var)\b/.test(x)));
  const command=nativeCommand(123,'a'.repeat(32),4000);
  assert.equal(command.file,'/usr/bin/timeout');
  assert.deepEqual(command.args.slice(0,3),['--foreground','--signal=TERM','--kill-after=0.25s']);
  assert.throws(()=>nativeCommand(123,'a'.repeat(32),4000,{privileged:true}),/not supported/);
});

test('supervisor hold ACK pins an exited direct child until release; cancellation overrides hold',
  {skip:process.platform!=='linux',timeout:10000},async()=>{
    const owner=launch(binary,['-e','setInterval(()=>{},1000)'],process.env,{captureControl:true});
    const pid=await owner.ready;
    try{
      const hold=await owner.holdCapture();
      assert.equal(hold.capture,'held');assert.equal(hold.target.pid,pid);
      process.kill(pid,'SIGKILL');
      await delay(80);
      assert.equal((await fs.readFile('/proc/'+pid+'/stat','utf8')).split(') ').at(-1).split(' ')[0],'Z');
      assert.equal(owner.child.exitCode,null,'held zombie must not be reaped');
      await owner.releaseCapture(hold.id);
      await owner.exited;
      await assert.rejects(owner.stop(),/Supervisor\/engine failed/);
      assert(owner.messages.some(x=>x.cleanup==='empty'));
    }finally{if(owner.child.exitCode===null)await owner.stop();}
    await assert.rejects(fs.access('/proc/'+pid),{code:'ENOENT'});
    await fixture(async({owner,pid})=>{
      const hold=await owner.holdCapture();
      const stopping=owner.stop();
      await delay(100);
      assert.equal((await fs.readFile('/proc/'+pid+'/stat','utf8')).split(') ').at(-1).split(' ')[0],'Z',
        'cancellation kills immediately, but must not recycle an in-flight attach PID');
      assert.equal(owner.child.exitCode,null);
      await owner.releaseCapture(hold.id);
      await stopping;
    });
});

test('capture validates pinned identity and rejects target exit before any debugger spawn',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,pid})=>{
    const identity=await nativeIdentity(pid);
    for(const replacement of [{...identity,start:'wrong'},{...identity,tracerPid:999},{...identity,state:'Z'}]){
      const result=await captureNative(owner,expected,{readIdentity:async()=>replacement});
      assert.equal(result.status,'unavailable');assert.equal(result.helperPid,undefined);
      assert(result.errors.length);
    }
    const result=await captureNative(owner,{...expected,sha256:'bad'});
    assert.equal(result.status,'unavailable');assert.match(result.errors.join(' '),/hash differs/);
}));

test('real target exit between identity checks cannot redirect debugger attachment',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,pid})=>{
    let checks=0;
    const result=await captureNative(owner,expected,{readIdentity:async target=>{
      const identity=await nativeIdentity(target);
      if(++checks===2){
        process.kill(pid,'SIGKILL');
        owner.child.kill('SIGTERM');
        return {...identity,state:'Z'};
      }
      return identity;
    }});
    assert.equal(checks,2);
    assert.equal(result.status,'unavailable');assert.equal(result.helperPid,undefined);
    assert.match(result.errors.join(' '),/exited before attach/);
  }));

test('late hold ACK after budget expiry releases ownership without late attach',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner})=>{
    const held=await owner.holdCapture();
    let acknowledge,notifyReleased;
    const ack=new Promise(resolve=>{acknowledge=resolve;});
    const released=new Promise(resolve=>{notifyReleased=resolve;});
    const delayed={...owner,holdCapture:()=>ack,releaseCapture:async id=>{
      const reply=await owner.releaseCapture(id);
      notifyReleased(reply);
      return reply;
    }};
    const result=await captureNative(delayed,expected,{timeoutMs:100});
    assert.equal(result.timedOut,true);assert.equal(result.helperPid,undefined);
    const before=JSON.stringify(result);
    acknowledge(held);
    let timer;
    try{
      const reply=await Promise.race([released,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Late hold was not released')),1500);
      })]);
      assert.equal(reply.capture,'released');
    }finally{clearTimeout(timer);}
    assert.equal(JSON.stringify(result),before);
  }));

test('real stopped supervisor releases a late grant after its hold caller timed out',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner})=>{
    let resumed=false,result;
    const until=async predicate=>{
      const end=performance.now()+2000;
      while(!predicate()&&performance.now()<end)await delay(10);
      assert(predicate(),'Expected control-channel state did not arrive');
    };
    try{
      owner.child.kill('SIGSTOP');
      for(let i=0;i<200;i++){
        const stat=await fs.readFile('/proc/'+owner.child.pid+'/stat','utf8');
        if(stat.split(') ').at(-1).startsWith('T '))break;
        await delay(10);
      }
      assert((await fs.readFile('/proc/'+owner.child.pid+'/stat','utf8')).split(') ').at(-1).startsWith('T '));
      result=await captureNative(owner,expected);
      assert.equal(result.status,'unavailable');
      assert.match(result.errors.join(' '),/Capture control timed out/);
      assert.equal(result.helperPid,undefined);
      assert(!owner.messages.some(x=>x.capture==='held'));
      owner.child.kill('SIGCONT');resumed=true;
      await until(()=>owner.messages.some(x=>x.capture==='held'));
      const grant=owner.messages.find(x=>x.capture==='held');
      await until(()=>owner.messages.some(x=>x.capture==='released'&&x.id===grant.id));
    }finally{
      if(!resumed)owner.child.kill('SIGCONT');
      // A broken regression must not strand its synthetic child. This is safe
      // only because the rejected caller was verified not to start a debugger.
      if(result&&result.helperPid===undefined){
        for(const grant of owner.messages.filter(x=>x.capture==='held')){
          if(!owner.messages.some(x=>x.capture==='released'&&x.id===grant.id))
            await owner.releaseCapture(grant.id).catch(()=>{});
        }
      }
    }
  }));

test('abandoned competing hold cannot release an already delivered active hold',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,pid})=>{
    const active=await owner.holdCapture();
    let resumed=false;
    try{
      owner.child.kill('SIGSTOP');
      for(let i=0;i<200;i++){
        if((await fs.readFile('/proc/'+owner.child.pid+'/stat','utf8')).split(') ').at(-1).startsWith('T '))break;
        await delay(10);
      }
      assert((await fs.readFile('/proc/'+owner.child.pid+'/stat','utf8')).split(') ').at(-1).startsWith('T '));
      await assert.rejects(owner.holdCapture(),/Capture control timed out/);
      owner.child.kill('SIGCONT');resumed=true;
      const end=performance.now()+2000;
      while(!owner.messages.some(x=>x.capture==='denied'&&x.id!==active.id)&&performance.now()<end)await delay(10);
      assert(owner.messages.some(x=>x.capture==='denied'&&x.id!==active.id));
      assert(!owner.messages.some(x=>x.capture==='released'),'abandoned request must not release an active caller token');
      process.kill(pid,'SIGKILL');
      await delay(100);
      assert.equal((await fs.readFile('/proc/'+pid+'/stat','utf8')).split(') ').at(-1).split(' ')[0],'Z');
      assert.equal(owner.child.exitCode,null,'active hold must continue to pin target identity');
      const stopping=owner.stop();
      await owner.releaseCapture(active.id);
      await stopping;
    }finally{
      if(!resumed)owner.child.kill('SIGCONT');
      if(!owner.messages.some(x=>x.capture==='released'&&x.id===active.id))
        await owner.releaseCapture(active.id).catch(()=>{});
    }
  }));

test('fake debugger output is retained, control stays separate, and exit/detach are required',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,dir})=>{
    const debuggerPath=await debuggerFile(dir,marker+"process.stdout.write('#0 synthetic_frame\\n'+marker);process.stderr.write('diagnostic stderr');");
    const result=await captureNative(owner,expected,{debuggerPath});
    assert.equal(result.status,'captured');assert.equal(result.debuggerExited,true);assert.equal(result.detached,true);
    assert.match(result.stdout,/#0 synthetic_frame/);assert.equal(result.stderr,'diagnostic stderr');
    assert.equal(result.target.pid,await owner.ready);
    assert(!owner.messages.some(x=>x.capture==='NATIVE_DETACHED'));
    assert(Object.isFrozen(result));assert(Object.isFrozen(result.errors));
    await assert.rejects(fs.access('/proc/'+result.helperPid),{code:'ENOENT'});
  }));

test('debugger success without detach proof and command failure are unavailable',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,dir})=>{
    for(const body of ["process.stdout.write('#0 no_detach\\n');",marker+"process.stdout.write(marker);process.exitCode=1;"]){
      const debuggerPath=await debuggerFile(dir,body);
      const result=await captureNative(owner,expected,{debuggerPath});
      assert.equal(result.status,'unavailable');
      assert.equal(result.debuggerExited,true);
    }
  }));

test('output cap continues draining and does not hide successful debugger exit',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,dir})=>{
    const debuggerPath=await debuggerFile(dir,marker+"process.stdout.write('x'.repeat(2*1024*1024));process.stdout.write(marker);");
    const result=await captureNative(owner,expected,{debuggerPath,maxOutputBytes:4096});
    assert.equal(result.status,'incomplete');assert.equal(result.outputTruncated,true);
    assert.equal(result.retainedBytes,4096);assert(result.outputBytes>2*1024*1024);
    assert.equal(result.debuggerExited,true);assert.equal(result.detached,true);
    assert(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=4096);
  }));

test('hung fake debugger is killed by independent watchdog before cleanup',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,dir})=>{
    const debuggerPath=await debuggerFile(dir,"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const result=await captureNative(owner,expected,{debuggerPath,timeoutMs:1800});
    assert.equal(result.status,'incomplete');assert.equal(result.timedOut,true);
    assert.equal(result.debuggerExited,true);assert.equal(result.detached,false);
    assert(result.elapsedMs<=2000);
    await assert.rejects(fs.access('/proc/'+result.helperPid),{code:'ENOENT'});
  }));

test('cancelled capture cannot keep supervisor hold or promote late completion',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,dir})=>{
    const ready=join(dir,'debugger-ready');
    const debuggerPath=await debuggerFile(dir,"require('node:fs').writeFileSync("+JSON.stringify(ready)+",String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const abort=new AbortController();
    const pending=captureNative(owner,expected,{debuggerPath,timeoutMs:1800,signal:abort.signal});
    for(let i=0;i<100;i++){
      if(await fs.access(ready).then(()=>true,()=>false))break;
      await delay(10);
    }
    const debuggerPid=Number(await fs.readFile(ready,'utf8'));
    abort.abort();
    await owner.stop();
    const result=await pending;
    assert.equal(result.status,'incomplete');assert.equal(result.cancelled,true);
    assert.equal(result.debuggerExited,true);
    await assert.rejects(fs.access('/proc/'+debuggerPid),{code:'ENOENT'});
    const original=JSON.stringify(result);await delay(100);assert.equal(JSON.stringify(result),original);
  }));

test('stalled native identity inspection is bounded and cannot spawn after timeout',
  {skip:process.platform!=='linux',timeout:10000},async()=>fixture(async({owner,pid})=>{
    const identity=await nativeIdentity(pid);
    let release;
    const blocked=new Promise(resolve=>{release=resolve;});
    const result=await captureNative(owner,expected,{timeoutMs:150,readIdentity:()=>blocked});
    assert.equal(result.status,'incomplete');assert.equal(result.timedOut,true);
    assert.equal(result.helperPid,undefined);
    const before=JSON.stringify(result);release(identity);await delay(100);
    assert.equal(JSON.stringify(result),before);
  }));

test('deadline closes the result but pins identity beyond five seconds until exit is verified',
  {skip:process.platform!=='linux',timeout:20000},async()=>fixture(async({owner,pid,dir})=>{
    const debuggerPath=await debuggerFile(dir,marker+"process.stdout.write(marker);");
    let confirmExit;
    const proof=new Promise(resolve=>{confirmExit=resolve;});
    const pending=captureNative(owner,expected,{
      debuggerPath,timeoutMs:1600,readDebuggerGroup:()=>proof,
    });
    let result;
    try{
      result=await pending;
      assert.equal(result.status,'incomplete');assert.equal(result.timedOut,true);
      assert.equal(result.debuggerExited,false);
      assert.equal(result.custody,'retained-debugger-exit-unconfirmed');
      const frozen=JSON.stringify(result);
      await assert.rejects(owner.stop(),/cleanup incomplete.*exit unconfirmed.*retained/);
      assert.equal((await fs.readFile('/proc/'+pid+'/stat','utf8')).split(') ').at(-1).split(' ')[0],'Z');
      assert.equal(owner.child.exitCode,null);
      assert(!owner.messages.some(x=>x.cleanup==='empty'),'must not claim ECHILD while PID is pinned');
      assert(!owner.messages.some(x=>x.capture==='released'),'deadline must never release a possible attach target');
      confirmExit([]);
      await owner.exited;
      assert(owner.messages.some(x=>x.capture==='released'));
      assert(owner.messages.some(x=>x.cleanup==='empty'));
      assert.equal(JSON.stringify(result),frozen,'late cleanup must not promote frozen result');
    }finally{confirmExit([]);}
  }));

test('task-local ptracer permits an unprivileged controller child after target exec',
  {skip:process.platform!=='linux',timeout:10000},async t=>{
    const scope=(await fs.readFile('/proc/sys/kernel/yama/ptrace_scope','utf8')).trim();
    if(scope!=='1'||process.getuid()===0){t.skip('Requires non-root Yama relational mode');return;}
    await fixture(async({owner,pid,dir})=>{
      const debuggerPath=join(dir,'ptrace-probe');
      await fs.writeFile(debuggerPath,`#!/usr/bin/python3
import ctypes, os, sys
libc=ctypes.CDLL(None,use_errno=True)
pid=int(sys.argv[sys.argv.index('-p')+1])
if libc.ptrace(16,pid,0,0)!=0:
    raise OSError(ctypes.get_errno(),'PTRACE_ATTACH failed')
got,status=os.waitpid(pid,0)
assert got==pid and os.WIFSTOPPED(status)
if libc.ptrace(17,pid,0,0)!=0:
    raise OSError(ctypes.get_errno(),'PTRACE_DETACH failed')
marker=next(x for x in sys.argv if x.startswith('echo NATIVE_DETACHED_'))[5:].replace('\\\\n','\\n')
print('#0 synthetic ptrace only, not a GDB backtrace')
print(marker)
`,{mode:0o755});
      const result=await captureNative(owner,expected,{debuggerPath});
      assert.equal(result.status,'captured',result.stderr);
      assert.equal(result.privileged,false);assert.equal(result.debuggerExited,true);
      assert.equal((await nativeIdentity(pid)).tracerPid,0);
    });
  });

test('native harness flag rejects non-manual, non-ring and streaming modes before output',
  {skip:process.platform!=='linux',timeout:10000},async()=>{
    const dir=await fs.mkdtemp(join(os.tmpdir(),'eval-native-gate-'));
    try{
      for(const env of [
        {GITHUB_EVENT_NAME:'push',BROWSER_EVAL_RING_DIR:dir},
        {GITHUB_EVENT_NAME:'workflow_dispatch',BROWSER_EVAL_RING_DIR:''},
        {GITHUB_EVENT_NAME:'workflow_dispatch',BROWSER_EVAL_RING_DIR:dir,BROWSER_EVAL_TRACE_DIR:dir},
      ]){
        await assert.rejects(promisify(execFile)(binary,['scripts/browser-eval/run.mjs'],{
          env:{...process.env,BROWSER_EVAL_TRACE_DIR:'',BROWSER_EVAL_NATIVE:'1',...env},
        }),error=>error.code===1&&error.stderr.includes('manual ring diagnostic'));
      }
      assert.deepEqual(await fs.readdir(dir),[]);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
