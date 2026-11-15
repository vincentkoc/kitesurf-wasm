import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';

export function launch(binary,args,env=process.env,{captureStdout=false,captureControl=false}={}) {
  const child=spawn('python3',[fileURLToPath(new URL('./supervise.py',import.meta.url)),...(captureControl?['--capture-control']:[]),...(captureStdout?['--stdout-fd','3']:[]),binary,...args],{
    stdio:[captureControl?'pipe':'ignore','pipe','pipe',...(captureStdout?['pipe']:[])],detached:true,env,
  });
  const messages=[],pending=new Map(),abandonedHolds=new Map();
  const alive=()=>child.exitCode===null&&!child.signalCode;
  const forgetAbandoned=id=>{
    const hold=abandonedHolds.get(id);
    if(hold)clearTimeout(hold.retry);
    abandonedHolds.delete(id);
  };
  const request=(capture,id=randomBytes(16).toString('hex'),timeoutMs=500)=>new Promise((resolve,reject)=>{
    if(!captureControl||!alive())return reject(Error('Capture control unavailable'));
    if(pending.has(id))return reject(Error('Capture control request already pending'));
    let timer;
    const entry={capture,
      resolve:message=>{clearTimeout(timer);resolve(message);},
      reject:error=>{clearTimeout(timer);reject(error);},
    };
    const abandon=error=>{
      if(pending.get(id)!==entry)return;
      pending.delete(id);
      // The caller has rejected without ever receiving this token. A later
      // grant can therefore be released safely; no debugger could use it.
      if(capture==='hold')abandonedHolds.set(id,{granted:false,releasing:false});
      entry.reject(error);
    };
    timer=setTimeout(()=>abandon(Error('Capture control timed out')),timeoutMs);
    pending.set(id,entry);
    child.stdin.write(JSON.stringify({capture,id})+'\n',error=>{if(error)abandon(error);});
  });
  const releaseAbandoned=id=>{
    const hold=abandonedHolds.get(id);
    if(!hold?.granted||hold.releasing||!alive())return;
    hold.releasing=true;
    void request('release',id).then(()=>forgetAbandoned(id)).catch(()=>{
      if(abandonedHolds.get(id)!==hold)return;
      hold.releasing=false;
      if(alive())hold.retry=setTimeout(()=>releaseAbandoned(id),250);
    });
  };
  child.stdin?.on('error',()=>{});
  const rejectPending=()=>{
    for(const p of pending.values())p.reject(Error('Capture supervisor exited'));
    pending.clear();
    for(const id of abandonedHolds.keys())forgetAbandoned(id);
  };
  let resolveReady,rejectReady,spawnError;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    try {
      const message=JSON.parse(line);messages.push(message);
      if(message.rootPid)resolveReady(message.rootPid);
      const abandoned=abandonedHolds.get(message.id);
      if(abandoned&&message.capture==='held'){
        abandoned.granted=true;
        releaseAbandoned(message.id);
        return; // Never deliver an abandoned grant to the rejected caller.
      }
      if(abandoned&&['released','denied'].includes(message.capture))forgetAbandoned(message.id);
      const entry=pending.get(message.id);
      if(entry&&(message.capture==='denied'||message.capture===(entry.capture==='hold'?'held':'released'))){
        pending.delete(message.id);
        if(message.capture==='denied')entry.reject(Error(message.error));else entry.resolve(message);
      }
    }catch(e){rejectReady(e);}
  });
  const exited=new Promise(resolve=>{
    child.once('error',error=>{spawnError=error;rejectReady(error);rejectPending();resolve({error});});
    child.once('close',(code,signal)=>{rejectReady(Error('Supervisor exited before readiness'));rejectPending();resolve({code,signal});});
  });
  // A launch failure can precede awaiting readiness, but is still reported there.
  ready.catch(()=>{});
  return {child,ready,exited,messages,
    holdCapture:()=>request('hold'),
    releaseCapture:id=>request('release',id),
    stdout:captureStdout?child.stdio[3]:null,
    async stop() {
      if(child.exitCode===null&&!child.signalCode&&!spawnError)child.kill('SIGTERM');
      let timer;
      try {
        const result=await Promise.race([exited,new Promise((_,reject)=>{
          timer=setTimeout(()=>{
            const held=messages.findLast(m=>m.cleanup==='incomplete'&&m.captureId);
            reject(Error(held?'Containment cleanup incomplete: native debugger exit unconfirmed; target PID '+held.rootPid+' retained (capture '+held.captureId+')':'Containment cleanup timed out; campaign must abort'));
          },7000);
        })]);
        assert.equal(result.code,0,'Supervisor/engine failed or cleanup was incomplete');
        assert(messages.some(m=>m.cleanup==='empty'&&m.verification==='waitpid ECHILD'),'Missing empty-containment verification');
        return {status:'empty',verification:'subreaper waitpid ECHILD'};
      } finally {clearTimeout(timer);}
    },
  };
}
