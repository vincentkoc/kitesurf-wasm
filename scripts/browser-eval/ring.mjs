// Failure-only diagnostics: retain raw CDP strings; never parse or write in the logger.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {readFailureSnapshot} from './trace.mjs';

const errorText=error=>String(error?.stack||error);
export function createCdpRing({
  maxEntries=2048,maxPayloadBytes=4*1024*1024,now=()=>performance.now(),
  io=fs,readSnapshot=readFailureSnapshot,dumpTimeoutMs=5000,
}={}) {
  assert(Number.isSafeInteger(maxEntries)&&maxEntries>0&&maxEntries<=65536,'Invalid ring entry limit');
  assert(Number.isSafeInteger(maxPayloadBytes)&&maxPayloadBytes>0&&maxPayloadBytes<=64*1024*1024,'Invalid ring payload limit');
  assert(Number.isSafeInteger(dumpTimeoutMs)&&dumpTimeoutMs>0&&dumpTimeoutMs<=30000,'Invalid ring dump timeout');
  const slots=new Array(maxEntries);
  let first=0,count=0,bytes=0,received=0,dropped=0,oversized=0,captureErrors=0;
  let stopped=false,result,dumping;
  const stats=status=>({
    mode:'cdp-ring',status,completeHistory:false,
    coverage:'Puppeteer connection only; bounded recent history, not engine startup or full stdout/stderr',
    limits:{maxEntries,maxPayloadBytes,payloadAccounting:'UTF-16 string bytes; object overhead separately bounded by maxEntries'},
    received,retained:count,retainedPayloadBytes:bytes,dropped,oversized,captureErrors,
    historyTruncated:dropped>0||captureErrors>0,
  });
  const evict=()=>{
    const entry=slots[first];bytes-=entry.raw.length*2;slots[first]=undefined;
    first=(first+1)%maxEntries;count--;dropped++;
  };
  const retain=direction=>raw=>{
    if(stopped)return;
    received++;
    // No JSON parsing, UTF-8 encoding, promises, callbacks into the page, or I/O.
    if(typeof raw!=='string'){captureErrors++;dropped++;return;}
    const size=raw.length*2;
    if(size>maxPayloadBytes){oversized++;dropped++;return;} // Never cut a protocol message.
    while(count===maxEntries||bytes+size>maxPayloadBytes)evict();
    try {
      slots[(first+count)%maxEntries]={sequence:received,monotonicMs:now(),direction,raw};
      count++;bytes+=size;
    } catch {captureErrors++;dropped++;}
  };
  const send=retain('send'),receive=retain('receive');
  const clear=()=>{slots.fill(undefined);first=0;count=0;bytes=0;};
  return {
    logger(prefix) {
      if(prefix==='puppeteer:protocol:SEND ►')return send;
      if(prefix==='puppeteer:protocol:RECV ◀')return receive;
    },
    status:()=>result??stats('buffering'),
    discard() {
      if(result)return result;
      assert(!dumping,'Ring dump in progress');
      stopped=true;result=stats(captureErrors?'incomplete':'discarded');clear();return result;
    },
    dumpFailure(directory,context,supervisorPid) {
      if(dumping)return dumping;
      assert(!stopped,'Ring already discarded');
      stopped=true;
      // Freeze before any asynchronous post-failure work; later logger calls are ignored.
      const entries=Array.from({length:count},(_,i)=>slots[(first+i)%maxEntries]);
      const frozen=stats('written');
      clear();
      dumping=new Promise(resolve=>{
        const errors=[];
        const controller=new AbortController();
        let settled=false,timer;
        const finish=timedOut=>{
          if(settled)return;
          settled=true;clearTimeout(timer);
          // Only this fence publishes state. Late I/O cannot replace or mutate it.
          result=Object.freeze({...frozen,directory,dumpTimeoutMs,timedOut,
            status:timedOut||errors.length||captureErrors?'incomplete':'written',
            errors:Object.freeze([...errors])});
          resolve(result);
        };
        timer=setTimeout(()=>{
          errors.push('Diagnostic ring dump timed out; cleanup must proceed');
          finish(true);controller.abort();
        },dumpTimeoutMs);
        const stage=async operation=>{
          controller.signal.throwIfAborted();
          const value=await operation();
          controller.signal.throwIfAborted();
          return value;
        };
        const write=(name,contents)=>stage(()=>io.writeFile(join(directory,name),contents,{flag:'wx',signal:controller.signal}));
        // Observe late rejections even when an injected/native operation ignores abort.
        void (async()=>{
          let snapshot;
          try{snapshot=await stage(()=>readSnapshot(supervisorPid,{signal:controller.signal}));}
          catch(error){if(settled)return;errors.push(errorText(error));snapshot={error:errorText(error)};}
          const records=entries.map(({raw,...entry})=>{
            try{return {...entry,message:JSON.parse(raw)};}
            catch(error){errors.push(errorText(error));return {...entry,raw,parseError:errorText(error)};}
          });
          await stage(()=>io.mkdir(dirname(directory),{recursive:true}));
          await stage(()=>io.mkdir(directory)); // Exclusive row directory.
          await write('cdp.jsonl',records.map(x=>JSON.stringify(x)+'\n').join(''));
          await write('failure.json',JSON.stringify({capturedAt:new Date().toISOString(),context,snapshot},null,2)+'\n');
          // A final write can itself stall. Never write a terminal success claim
          // that might land after timeout: the owning raw row certifies completion.
          await write('manifest.json',JSON.stringify({...frozen,directory,dumpTimeoutMs,
            status:'pending',completionAuthority:'raw report row.ring',errors:[...errors]},null,2)+'\n');
          finish(false);
        })().catch(error=>{if(!settled){errors.push(errorText(error));finish(false);}});
      });
      return dumping;
    },
  };
}
