import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {fixtures,operation,fixtureHash} from '../scripts/browser-eval/fixtures.mjs';
import {parseStat,accumulator} from '../scripts/browser-eval/resources.mjs';
import {median,summarize} from '../scripts/browser-eval/summary.mjs';
import {render} from '../scripts/browser-eval/chart.mjs';
// Synthetic reducer fixtures are test-only, never benchmark evidence or exported claims.
function synthetic(){
  const report={schema:1,status:'passed',fixtureHash,config:{trials:3,repetitions:2},host:{arch:'test',kernel:'test',cpu:'synthetic'},started:'test-only',engineIdentity:['kitesurf','chromium','lightpanda'].map(id=>({id,runtimeIdentity:'TEST ONLY',binarySha256:'a'.repeat(64)})),runs:[]};
  for(let trial=0;trial<3;trial++)for(const engine of ['kitesurf','chromium','lightpanda'])for(const workload of Object.keys(fixtures))for(const phase of ['cold','warm'])for(const pass of ['latency','resources'])report.runs.push({trial,engine,workload,phase,pass,status:'passed',cleanup:{status:'empty',verification:'subreaper waitpid ECHILD'},wallMs:phase==='cold'?[10+trial]:[10+trial,20+trial],startupReadyMs:5,resources:{complete:true,sampledPeakRssMiB:10+trial,sampledPeakPssMiB:8+trial,observedCpuMsPerOp:trial}});
  return report;
}
test('summary is balanced, median of trial medians, deterministic',()=>{
  assert.equal(median([1,2,20,30]),11);const s=summarize(synthetic());assert.equal(s.cells.length,18);assert.equal(s.cells.find(x=>x.phase==='warm').wallMs.median,16);
  s.sourceSha256='b'.repeat(64);assert.equal(render(s,'interaction','warm'),render(s,'interaction','warm'));assert.match(render(s,'interaction','warm'),/Observed CPU \(quantized, incomplete\)/);
});
test('failed, missing, duplicate and invalid rows never become wins',()=>{
  let r=synthetic();r.status='failed';assert.throws(()=>summarize(r));
  r=synthetic();r.diagnosticOnly=true;assert.throws(()=>summarize(r),/Diagnostic.*timings/);
  r=synthetic();r.runs.pop();assert.throws(()=>summarize(r));
  r=synthetic();r.runs[0].status='failed';assert.throws(()=>summarize(r));
  r=synthetic();r.runs[0].wallMs=[NaN];assert.throws(()=>summarize(r));
  r=synthetic();r.runs.find(x=>x.pass==='resources').resources.complete=false;assert.throws(()=>summarize(r));
  r=synthetic();delete r.runs[0].cleanup;assert.throws(()=>summarize(r));
  const s=summarize(synthetic());assert.throws(()=>render(s,'interaction','warm'));
});
test('Observed CPU preserves observed departed processes and PID reuse',()=>{
  const a=accumulator({complete:true,members:[{pid:1,start:'1',ticks:100}]},100);
  a.add({complete:true,members:[{pid:1,start:'1',ticks:110,rssKiB:1024,pssKiB:512},{pid:2,start:'2',ticks:10,rssKiB:1024,pssKiB:512}]});
  a.add({complete:true,members:[{pid:1,start:'1',ticks:120,rssKiB:1024,pssKiB:512},{pid:2,start:'3',ticks:5,rssKiB:1024,pssKiB:512}]});
  assert.equal(a.result(1).observedCpuMsPerOp,350);assert.equal(a.result(1).sampledPeakRssMiB,2);
});
test('stat parser tolerates spaces and parentheses in process name',()=>{
  const fields=Array(50).fill('0');fields[0]='S';fields[1]='4';fields[11]='10';fields[12]='2';fields[19]='900';
  assert.deepEqual(parseStat('5',`5 (foo ) bar) ${fields.join(' ')}`),{pid:5,ppid:4,start:'900',ticks:12});
});
test('JS workload oracle executes and rejects a bad engine result',async()=>{
  const output={textContent:''};let context=vm.createContext({document:{getElementById:()=>output}});
  const page={goto:async()=>{context=vm.createContext({document:{getElementById:()=>output}});},evaluate:async code=>{const value=vm.runInContext(code,context);return value===undefined?undefined:JSON.parse(JSON.stringify(value));}};
  await operation(page,'http://fixture','javascript');assert.equal(output.textContent,'239824');
  page.evaluate=async()=> 'incorrect';await assert.rejects(()=>operation(page,'http://fixture','javascript'));
});
