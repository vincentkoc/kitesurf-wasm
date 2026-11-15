// Failure-only native observation. No target execution commands or hot-path hooks.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';

const errorText=e=>String(e?.message||e).slice(0,2000);
const frozen=value=>Object.freeze({...value,errors:Object.freeze([...value.errors])});
async function digest(path,signal){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);
  return hash.digest('hex');
}
export async function nativeIdentity(pid,{signal}={}){
  assert(Number.isSafeInteger(pid)&&pid>1,'Invalid native target PID');
  const root='/proc/'+pid;
  const text=await fs.readFile(root+'/stat',{encoding:'utf8',signal});
  const fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  const status=await fs.readFile(root+'/status',{encoding:'utf8',signal});
  const stat=await fs.stat(root+'/exe');
  return {pid,ppid:Number(fields[1]),start:fields[19],state:fields[0],
    uid:Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
    tracerPid:Number(/^TracerPid:\s+(\d+)/m.exec(status)?.[1]),
    exe:await fs.readlink(root+'/exe'),dev:stat.dev,ino:stat.ino};
}
// A timeout exit alone is not proof that its GDB child exited. Check the
// dedicated process group, including reparented members, before certifying it.
async function debuggerGroup(pgid,signal){
  const names=await fs.readdir('/proc');
  const members=[];
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    signal.throwIfAborted();
    try{
      const text=await fs.readFile('/proc/'+name+'/stat',{encoding:'utf8',signal});
      const fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
      if(Number(fields[2])===pgid)members.push({pid:Number(name),state:fields[0],start:fields[19]});
    }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
  }
  return members;
}
export function gdbArguments(pid,marker){
  assert(Number.isSafeInteger(pid)&&pid>1&&/^[a-f0-9]{32}$/.test(marker));
  return ['-nx','-q','-batch',
    '-iex','set auto-load no','-iex','set debuginfod enabled off',
    '-iex','set auto-solib-add off',
    '-ex','set pagination off','-ex','set confirm off',
    '-ex','set print frame-arguments none','-ex','set print entry-values no',
    '--se=/proc/'+pid+'/exe','-p',String(pid),
    '-ex','info threads','-ex','thread apply all -c bt -no-filters 32',
    '-ex','thread apply all -c info registers rip rsp rbp',
    '-ex','info proc mappings','-ex','detach',
    '-ex','echo NATIVE_DETACHED_'+marker+'\\n'];
}
// GDB and its independent timeout are unprivileged children in a dedicated
// process group. The target's task-local PR_SET_PTRACER permits this controller's
// descendants only. No sudo proxy can hide GDB in another privileged group.
// --foreground makes timeout kill/reap GDB, not itself; GDB is not permitted
// to spawn commands (no auto-load, shell, inferior calls or debuginfod).
export function nativeCommand(pid,marker,remainingMs,{privileged=false,debuggerPath='/usr/bin/gdb'}={}){
  assert(!privileged,'Privileged native debugging is not supported');
  const seconds=Math.max(0.05,(remainingMs-500)/1000).toFixed(3)+'s';
  const args=['--foreground','--signal=TERM','--kill-after=0.25s',seconds,debuggerPath,...gdbArguments(pid,marker)];
  return {file:'/usr/bin/timeout',args};
}
export function captureNative(owner,expected,{
  signal,timeoutMs=5000,maxOutputBytes=1024*1024,privileged=false,
  debuggerPath='/usr/bin/gdb',readIdentity=nativeIdentity,readDebuggerGroup=debuggerGroup,
}={}){
  assert(!privileged&&process.getuid()!==0&&process.geteuid()!==0,'Native debugging requires an unprivileged caller');
  assert(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=5000);
  assert(Number.isInteger(maxOutputBytes)&&maxOutputBytes>0&&maxOutputBytes<=1024*1024);
  const started=performance.now(),marker=randomBytes(16).toString('hex');
  const controller=new AbortController();
  const output={stdout:[],stderr:[]};
  const state={mode:'native-stack',status:'unavailable',timeoutMs,maxOutputBytes,
    errors:[],debuggerExited:false,detached:false,outputBytes:0,retainedBytes:0,
    outputTruncated:false,privileged,timedOut:false,cancelled:false};
  let settled=false,held,helper,timer,tail='';
  let releaseStarted=false,attachmentMayRun=false,exitVerified=false;
  const release=()=>{
    if(!held||releaseStarted||(attachmentMayRun&&!exitVerified))return;
    releaseStarted=true;
    // A diagnostic deadline is not a custody deadline. Release only before any
    // debugger could start, or after independent exit verification, even late.
    void owner.releaseCapture(held.id).catch(()=>{
      releaseStarted=false;
      if(owner.messages.some(x=>x.capture==='released'&&x.id===held.id))return;
      if(owner.child.exitCode===null&&!owner.child.signalCode)setTimeout(release,250);
    });
  };
  return new Promise(resolveResult=>{
    const finish=()=>{
      if(settled)return;
      settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      controller.abort();
      state.debuggerExited=exitVerified;
      state.custody=held?(attachmentMayRun&&!exitVerified?'retained-debugger-exit-unconfirmed':'release-requested'):'no-hold';
      if(state.custody==='retained-debugger-exit-unconfirmed')state.errors.push('Target PID remains pinned until debugger exit is verified; timeout does not release custody');
      release();
      state.elapsedMs=performance.now()-started;
      state.stdout=Buffer.concat(output.stdout).toString('utf8');
      state.stderr=Buffer.concat(output.stderr).toString('utf8');
      resolveResult(frozen(state));
    };
    const signalHelper=()=>{
      if(helper&&!exitVerified&&helper.exitCode===null&&!helper.signalCode){
        try{process.kill(-helper.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')state.errors.push('Local helper signal: '+errorText(e));}
        // The independent unprivileged timeout remains the hard kill owner.
      }
    };
    const cancel=()=>{state.cancelled=true;state.status='incomplete';signalHelper();};
    if(signal?.aborted){cancel();finish();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{
      state.timedOut=true;state.status='incomplete';
      state.errors.push('Native capture budget exhausted');
      signalHelper();finish();
    },timeoutMs);
    const check=()=>{
      controller.signal.throwIfAborted();
      if(state.cancelled)throw Error('Native capture cancelled');
      if(settled)throw Error('Native capture already closed');
    };
    const stage=async fn=>{check();const value=await fn();check();return value;};
    void(async()=>{
      held=await owner.holdCapture();
      check();
      state.hold={id:held.id,target:held.target};
      const target=await stage(()=>readIdentity(held.target.pid,{signal:controller.signal}));
      for(const key of ['pid','ppid','start','uid','exe','dev','ino'])
        assert.equal(target[key],held.target[key],'Native target changed: '+key);
      assert.equal(target.ppid,owner.child.pid,'Target is not the held direct child');
      assert.equal(target.uid,process.getuid(),'Target UID differs');
      assert.equal(target.tracerPid,0,'Target already traced');
      assert(!['Z','X'].includes(target.state),'Target exited before capture');
      const binary=await stage(()=>fs.realpath(expected.binary));
      const stat=await stage(()=>fs.stat(binary));
      assert.equal(target.exe,binary,'Native executable path differs');
      assert.equal(target.dev,stat.dev,'Native executable device differs');
      assert.equal(target.ino,stat.ino,'Native executable inode differs');
      const binarySha256=await stage(()=>digest('/proc/'+target.pid+'/exe',controller.signal));
      assert.equal(binarySha256,expected.sha256,'Native executable hash differs');
      state.target={...target,binarySha256};
      const current=await stage(()=>readIdentity(target.pid,{signal:controller.signal}));
      for(const key of ['pid','ppid','start','uid','exe','dev','ino'])
        assert.equal(current[key],target[key],'Native target changed before attach: '+key);
      assert.equal(current.tracerPid,0,'Target became traced');
      assert(!['Z','X'].includes(current.state),'Target exited before attach');
      const remaining=timeoutMs-(performance.now()-started);
      assert(remaining>750,'Insufficient native capture budget');
      const command=nativeCommand(target.pid,marker,remaining,{privileged,debuggerPath});
      check();
      helper=spawn(command.file,command.args,{detached:true,stdio:['ignore','pipe','pipe'],
        env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:'/nonexistent',DEBUGINFOD_URLS:''}});
      state.helperPid=helper.pid;
      attachmentMayRun=Number.isSafeInteger(helper.pid);
      const consume=(name,chunk)=>{
        if(settled)return; // pipes remain drained; terminal report cannot change
        state.outputBytes+=chunk.length;
        if(name==='stdout'){
          tail=(tail+chunk.toString('utf8')).slice(-256);
          if(tail.includes('NATIVE_DETACHED_'+marker))state.detached=true;
        }
        const length=Math.min(chunk.length,maxOutputBytes-state.retainedBytes);
        if(length>0){output[name].push(Buffer.from(chunk.subarray(0,length)));state.retainedBytes+=length;}
        if(length<chunk.length)state.outputTruncated=true;
      };
      helper.stdout.on('data',x=>consume('stdout',x));helper.stderr.on('data',x=>consume('stderr',x));
      helper.once('error',error=>{if(!settled){state.errors.push(errorText(error));finish();}});
      helper.once('close',(code,exitSignal)=>{
        if(!settled){
          state.watchdogExited=true;state.exitCode=code;state.exitSignal=exitSignal;
          if(code===124||code===137||exitSignal==='SIGKILL'){state.timedOut=true;state.errors.push('Debugger watchdog expired');}
          if(code!==0)state.errors.push('Debugger exited unsuccessfully');
        }
        if(!attachmentMayRun){exitVerified=true;release();if(!settled)finish();return;}
        // This observer is independent of the bounded diagnostic result. It is
        // intentionally kept alive after timeout: an unconfirmed numeric-PID
        // attach must never outlive the unreaped target's numeric PID custody.
        void(async()=>{
          while(!exitVerified){
            let probeTimer;
            try{
              const members=await Promise.race([
                readDebuggerGroup(helper.pid,AbortSignal.timeout(1000)),
                new Promise((_,reject)=>{probeTimer=setTimeout(()=>reject(Error('Debugger exit observation timed out')),1000);}),
              ]);
              if(members.length===0){
                exitVerified=true;
                if(!settled){
                  state.remainingDebuggerGroup=[];
                  state.status=code===0&&state.detached&&!state.outputTruncated&&!state.cancelled&&!state.errors.length?'captured':
                    (state.timedOut||state.cancelled||state.outputTruncated||(code===0&&state.errors.length)?'incomplete':'unavailable');
                  finish();
                }else{
                  // Append evidence, never promote or mutate the frozen row.
                  release();
                  process.stderr.write(JSON.stringify({nativeCustody:'debugger-exit-verified',targetPid:held.target.pid,helperPid:helper.pid,late:true})+'\n');
                }
                return;
              }
              if(!settled){state.remainingDebuggerGroup=members;state.errors.push('Debugger process group remains after watchdog exit');state.status='incomplete';finish();}
            }catch(error){if(!settled){state.errors.push(errorText(error));state.status='incomplete';}}
            finally{clearTimeout(probeTimer);}
            await new Promise(resolve=>setTimeout(resolve,250));
          }
        })();
      });
    })().catch(error=>{
      if(!settled){state.errors.push(errorText(error));state.status=state.cancelled?'incomplete':'unavailable';finish();}
      else release(); // late hold ACK must not retain the child
    });
  });
}
