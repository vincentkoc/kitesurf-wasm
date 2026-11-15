import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {launch} from '../scripts/browser-eval/containment.mjs';
import {snapshot,accumulator,parseStat} from '../scripts/browser-eval/resources.mjs';

test('resources include live adopted setsid/double-fork descendants, then cleanup reaps them', {skip:process.platform!=='linux',timeout:15000}, async()=>{
  const dir=await fs.mkdtemp(join(os.tmpdir(),'eval-containment-test-'));
  const pidFile=join(dir,'escaped-pid');
  // Root -> detached intermediate -> detached long-lived grandchild.
  // /proc self ticks are quantized: startup may consume less than one tick.
  // Complete known CPU work before announcing readiness, rather than assuming
  // that process startup or a wall-clock sleep makes CPU accounting nonzero.
  const grandchild=`const start=process.cpuUsage();for(;;){const used=process.cpuUsage(start);if(used.user+used.system>=50000)break;}require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const intermediate=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}).unref()`;
  const root=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
  const owner=launch(process.execPath,['-e',root]);
  let rootPid,escapedPid;
  try {
    rootPid=await owner.ready;
    for(let i=0;i<200;i++) {
      try {escapedPid=Number(await fs.readFile(pidFile,'utf8'));break;} catch(e) {if(e.code!=='ENOENT')throw e;}
      await delay(20);
    }
    assert(escapedPid>0,'escaped descendant started');
    process.kill(escapedPid,0);
    // Wait for the intermediate to exit: this must measure an adopted sibling of
    // the engine root, not merely a grandchild still reachable from that root.
    let adopted;
    for(let i=0;i<200;i++) {
      adopted=parseStat(escapedPid,await fs.readFile(`/proc/${escapedPid}/stat`,'utf8'));
      if(adopted.ppid===owner.child.pid)break;
      await delay(20);
    }
    assert.equal(adopted.ppid,owner.child.pid,'live grandchild adopted by subreaper');
    const sample=await snapshot(owner.child.pid);
    assert.equal(sample.complete,true);
    assert(sample.members.some(p=>p.pid===rootPid),'engine root included');
    assert(!sample.members.some(p=>p.pid===owner.child.pid),'supervisor excluded');
    const escaped=sample.members.find(p=>p.pid===escapedPid);
    assert(escaped,'adopted descendant included in resource sample');
    assert(escaped.rssKiB>0,'adopted descendant RSS measured');
    assert(escaped.pssKiB>0,'adopted descendant PSS measured');
    assert(escaped.ticks>0,'adopted descendant self ticks measured');
    const stats=accumulator({complete:true,members:[]},100);
    stats.add(sample);
    const result=stats.result(1);
    assert.equal(result.sampledPeakRssMiB,sample.members.reduce((n,p)=>n+p.rssKiB,0)/1024);
    assert.equal(result.sampledPeakPssMiB,sample.members.reduce((n,p)=>n+p.pssKiB,0)/1024);
    assert.equal(result.observedCpuMsPerOp,sample.members.reduce((n,p)=>n+p.ticks,0)*10);
    const withoutAdopted=sample.members.filter(p=>p.pid!==escapedPid);
    assert(result.sampledPeakRssMiB>withoutAdopted.reduce((n,p)=>n+p.rssKiB,0)/1024);
    assert(result.sampledPeakPssMiB>withoutAdopted.reduce((n,p)=>n+p.pssKiB,0)/1024);
    assert(result.observedCpuMsPerOp>withoutAdopted.reduce((n,p)=>n+p.ticks,0)*10);
  } finally {
    assert.deepEqual(await owner.stop(),{status:'empty',verification:'subreaper waitpid ECHILD'});
    await fs.rm(dir,{recursive:true,force:true});
  }
  for(const pid of [rootPid,escapedPid])await assert.rejects(fs.access(`/proc/${pid}`),{code:'ENOENT'});
  // A subsequent launcher is admitted only after the first containment is empty.
  const next=launch(process.execPath,['-e','setInterval(()=>{},1000)']);
  await next.ready;await next.stop();
});

test('early launcher exit is failed evidence even if containment is empty', {skip:process.platform!=='linux',timeout:10000}, async()=>{
  const owner=launch(process.execPath,['-e','process.exit(1)']);
  await owner.ready;await owner.exited;
  await assert.rejects(owner.stop(),/Supervisor\/engine failed/);
  assert(owner.messages.some(m=>m.cleanup==='empty'));
});
