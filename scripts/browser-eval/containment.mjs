import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

export function launch(binary,args,env=process.env) {
  const child=spawn('python3',[fileURLToPath(new URL('./supervise.py',import.meta.url)),binary,...args],{
    stdio:['ignore','pipe','pipe'],detached:true,env,
  });
  const messages=[];
  let resolveReady,rejectReady,spawnError;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    try {const message=JSON.parse(line);messages.push(message);if(message.rootPid)resolveReady(message.rootPid);}
    catch(e){rejectReady(e);}
  });
  const exited=new Promise(resolve=>{
    child.once('error',error=>{spawnError=error;rejectReady(error);resolve({error});});
    child.once('close',(code,signal)=>{rejectReady(Error('Supervisor exited before readiness'));resolve({code,signal});});
  });
  // A launch failure can precede awaiting readiness, but is still reported there.
  ready.catch(()=>{});
  return {child,ready,exited,messages,
    async stop() {
      if(child.exitCode===null&&!child.signalCode&&!spawnError)child.kill('SIGTERM');
      let timer;
      try {
        const result=await Promise.race([exited,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('Containment cleanup timed out; campaign must abort')),7000);
        })]);
        assert.equal(result.code,0,'Supervisor/engine failed or cleanup was incomplete');
        assert(messages.some(m=>m.cleanup==='empty'&&m.verification==='waitpid ECHILD'),'Missing empty-containment verification');
        return {status:'empty',verification:'subreaper waitpid ECHILD'};
      } finally {clearTimeout(timer);}
    },
  };
}
