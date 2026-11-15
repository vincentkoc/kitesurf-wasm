import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const median = xs => {const x=[...xs].sort((a,b)=>a-b),m=Math.floor(x.length/2);assert(x.length,'Empty samples');return x.length%2?x[m]:(x[m-1]+x[m])/2;};
export function summarize(report) {
  assert.equal(report.schema,1);assert.equal(report.status,'passed','Cannot chart a failed/incomplete experiment');
  const {trials,repetitions}= {trials:5,repetitions:10,...report.config};
  assert(trials>=3);assert.equal(report.runs.length,trials*3*3*2*2,'Missing or extra trial rows');
  assert.deepEqual(report.engineIdentity.map(x=>x.id).sort(),['chromium','kitesurf','lightpanda']);
  assert.match(report.fixtureHash,/^[a-f0-9]{64}$/);
  for(const e of report.engineIdentity){assert.match(e.binarySha256,/^[a-f0-9]{64}$/);assert(e.runtimeIdentity);}
  const cells=[];
  for(const workload of ['navigation','interaction','javascript'])for(const phase of ['cold','warm'])for(const engine of ['kitesurf','chromium','lightpanda']){
    const passes={};
    for(const pass of ['latency','resources']){
      const rows=report.runs.filter(r=>r.workload===workload&&r.phase===phase&&r.engine===engine&&r.pass===pass);
      assert.equal(rows.length,trials,'Unbalanced comparison');
      assert.deepEqual(rows.map(r=>r.trial).sort((a,b)=>a-b),Array.from({length:trials},(_,i)=>i),'Duplicate/missing trial');
      for(const r of rows){assert.equal(r.status,'passed');assert.equal(r.wallMs.length,phase==='cold'?1:repetitions);assert(r.wallMs.every(v=>Number.isFinite(v)&&v>=0));if(pass==='resources')assert.equal(r.resources.complete,true);}
      passes[pass]=rows;
    }
    const stats=values=>{assert(values.every(v=>Number.isFinite(v)&&v>=0));return {median:median(values),min:Math.min(...values),max:Math.max(...values),n:values.length};};
    cells.push({engine,workload,phase,
      wallMs:stats(passes.latency.map(r=>median(r.wallMs))),
      sampledPeakRssMiB:stats(passes.resources.map(r=>r.resources.sampledPeakRssMiB)),
      sampledPeakPssMiB:stats(passes.resources.map(r=>r.resources.sampledPeakPssMiB)),
      cpuLowerBoundMsPerOp:stats(passes.resources.map(r=>r.resources.cpuLowerBoundMsPerOp)),
      startupReadyMs:stats(passes.latency.map(r=>r.startupReadyMs)),
    });
  }
  return {schema:1,status:'passed',started:report.started,finished:report.finished,fixtureHash:report.fixtureHash,engineIdentity:report.engineIdentity,host:report.host,trials,repetitions,warmups:report.config.warmups??2,notes:report.notes,cells};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert(process.argv[2]&&process.argv[3],'node summary.mjs RAW.json SUMMARY.json');
  const bytes=await fs.readFile(process.argv[2]);const out=summarize(JSON.parse(bytes));out.sourceSha256=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(process.argv[3],JSON.stringify(out,null,2)+'\n',{flag:'wx'});
}
