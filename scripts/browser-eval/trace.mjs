// Opt-in diagnostic observation. Never change fixture calls or await writes in an operation.
import {createWriteStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import {join} from 'node:path';
import {snapshot} from './resources.mjs';

const methods=['goto','evaluate','type','click','$eval'];
const errorText=error=>{try{return String(error?.stack||error);}catch{return 'Unprintable diagnostic error';}};
export async function readFailureSnapshot(supervisorPid,{signal}={}) {
  const check=()=>signal?.throwIfAborted();
  const read=async path=>{check();try{return await fs.readFile(path,{encoding:'utf8',signal});}catch(error){check();return {error:errorText(error)};}};
  const host=Object.fromEntries(await Promise.all(
    ['/proc/meminfo','/proc/loadavg','/proc/pressure/cpu','/proc/pressure/memory','/proc/pressure/io']
      .map(async path=>[path,await read(path)])));
  check();
  let processes;
  try{processes=supervisorPid?await snapshot(supervisorPid):{error:'Supervisor not started'};}
  catch(error){processes={error:errorText(error)};}
  check();
  const states=processes.members?await Promise.all(processes.members.map(async member=>({
    pid:member.pid,start:member.start,status:await read('/proc/'+member.pid+'/status'),
    wchan:await read('/proc/'+member.pid+'/wchan'),
  }))):[];
  return {host,processes,states};
}
export async function createRowTrace(directory, metadata, {streamFactory=createWriteStream,flushTimeoutMs=5000}={}) {
  // Exclusive row directories prevent a second run from overwriting evidence.
  await fs.mkdir(directory);
  const errors=[], streams=[];
  let closed=false, closing, operation=null, callSequence=0;
  let stdoutSource=null, stdoutEnded=false, stdoutFailed=false, cleanupDraining=false;
  const pending=new Map();
  const noteError=error=>errors.push(errorText(error));
  const open=name=>{
    const stream=streamFactory(join(directory,name),{flags:'wx'});
    stream.on('error',noteError);
    streams.push(stream);
    return stream;
  };
  const events=open('events.jsonl'), stderr=open('stderr.log'), stdout=open('stdout.log');
  stdout.on('error',()=>{stdoutFailed=true;stdoutSource?.resume();});
  // Install rejection handlers now, including for streams that fail before close().
  const completions=streams.map(stream=>finished(stream).then(()=>null,error=>error));
  const record=data=>{
    if(closed)return;
    try {
      events.write(JSON.stringify({time:new Date().toISOString(),monotonicMs:performance.now(),
        ...metadata,operation,stage:[...pending.values()].at(-1)??null,...data},
        (_key,value)=>typeof value==='function'?String(value):value)+'\n');
    } catch(error) {noteError(error);}
  };
  const status=()=>({status:errors.length?'incomplete':closed?'complete':'running',
    directory,errors:[...errors]});
  record({event:'row-start'});
  return {
    directory,
    captureStdout(source) {
      if(stdoutSource||!source){noteError(new Error('Missing or duplicate stdout capture pipe'));return;}
      stdoutSource=source;
      source.on('error',error=>{noteError(error);source.resume();});
      source.once('end',()=>{stdoutEnded=true;});
      source.on('data',chunk=>{
        // After a sink error, continue draining/discarding so the engine cannot
        // deadlock on a full pipe. The row is already incomplete, never a pass.
        if(stdoutFailed)return;
        try {
          if(!stdout.write(chunk)&&!cleanupDraining){source.pause();stdout.once('drain',()=>source.resume());}
        } catch(error) {noteError(error);stdoutFailed=true;source.resume();}
      });
    },
    drainStdout() {
      // Cleanup kills the producer immediately afterwards. Drain its bounded
      // remaining pipe bytes even if file backpressure would otherwise pause it.
      cleanupDraining=true;stdoutSource?.resume();
    },
    status,
    record,
    assertHealthy() {if(errors.length)throw new Error('Incomplete diagnostic trace: '+errors.join('; '));},
    stderr(chunk) {try{stderr.write(chunk);}catch(error){noteError(error);}},
    // Puppeteer 25.16.0 invokes these two built-in logger channels with raw CDP JSON.
    logger(prefix) {
      const direction=prefix==='puppeteer:protocol:SEND ►'?'send':
        prefix==='puppeteer:protocol:RECV ◀'?'receive':null;
      if(!direction)return undefined;
      return message=>{
        try{record({event:'cdp',direction,message:JSON.parse(message)});}
        catch(error){noteError(error);}
      };
    },
    install(page) {
      const descriptors=new Map();
      for(const method of methods) {
        const original=page[method];
        if(typeof original!=='function')continue;
        descriptors.set(method,Object.getOwnPropertyDescriptor(page,method));
        page[method]=function(...args) {
          const callId=++callSequence,start=performance.now();
          pending.set(callId,method);
          // Arguments are observed separately; serialization cannot change the call.
          record({event:'call-start',method,callId,
            args});
          const end=(event,error)=>{
            record({event,method,callId,durationMs:performance.now()-start,
              ...(error===undefined?{}:{error:errorText(error)})});
            pending.delete(callId);
          };
          let result;
          try{result=Reflect.apply(original,this,args);}
          catch(error){end('call-error',error);throw error;}
          if(result instanceof Promise) {
            // Side-effect-only handlers preserve the original promise and rejection object.
            result.then(()=>end('call-end'),error=>end('call-error',error));
          } else end('call-end');
          return result;
        };
      }
      return ()=>{
        for(const [method,descriptor] of descriptors) {
          if(descriptor)Object.defineProperty(page,method,descriptor);
          else delete page[method];
        }
      };
    },
    async runOperation(kind,index,fn) {
      operation={kind,index};
      record({event:'operation-start'});
      try{const result=await fn();record({event:'operation-end'});return result;}
      catch(error){record({event:'operation-error',error:errorText(error)});throw error;}
      finally{operation=null;}
    },
    async captureFailure(supervisorPid) {
      // One failure-only observation; no /proc scans are added to latency operations.
      record({event:'failure-snapshot',...await readFailureSnapshot(supervisorPid)});
    },
    close() {
      if(closing)return closing;
      closing=(async()=>{
        record({event:'row-trace-close'});
        closed=true;
        for(const stream of streams)if(!stream.destroyed)stream.end();
        let timer;
        try {
          await Promise.race([Promise.all(completions),new Promise(resolve=>{
            timer=setTimeout(()=>{
              const error=new Error('Diagnostic stream flush timed out');
              noteError(error);
              for(const stream of streams)if(!stream.destroyed)stream.destroy(error);
              resolve();
            },flushTimeoutMs);
          })]);
        } finally {clearTimeout(timer);}
        if(!stdoutEnded)noteError(new Error('Stdout capture did not reach EOF before close'));
        const result=status();
        try{await fs.writeFile(join(directory,'manifest.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
        catch(error){noteError(error);}
        if(errors.length)throw new Error('Incomplete diagnostic trace: '+errors.join('; '));
        return result;
      })();
      return closing;
    },
  };
}
