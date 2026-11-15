// Explicit manual-diagnostic qualification only; never executes the browser.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {launch} from './containment.mjs';
import {captureNative} from './native.mjs';

const {values}=parseArgs({options:{output:{type:'string'}}});
assert(values.output,'--output required');
assert(process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.BROWSER_EVAL_NATIVE==='1','Manual native diagnostic only');
const report={diagnosticOnly:true,status:'unavailable',errors:[]};
let owner;
try{
  report.ptraceScope=(await fs.readFile('/proc/sys/kernel/yama/ptrace_scope','utf8')).trim();
  assert(['0','1'].includes(report.ptraceScope),'Unprivileged ptrace is unavailable; no policy changes are allowed');
  report.uid=process.getuid();
  assert.notEqual(report.uid,0,'Native debugger must run unprivileged');
  report.capEff=/^CapEff:\s+(\w+)/m.exec(await fs.readFile('/proc/self/status','utf8'))?.[1];
  assert(report.capEff&&(BigInt('0x'+report.capEff)&(1n<<19n))===0n,'Native debugger must not have CAP_SYS_PTRACE');
  for(const path of ['/usr/bin/gdb','/usr/bin/timeout'])await fs.access(path);
  const exec=promisify(execFile);
  report.gdb=(await exec('/usr/bin/gdb',['-nx','--version'],{timeout:3000,maxBuffer:65536})).stdout.split('\n')[0];
  const binary=await fs.realpath('/usr/bin/sleep');
  const sha256=createHash('sha256').update(await fs.readFile(binary)).digest('hex');
  owner=launch(binary,['30'],process.env,{captureControl:true});
  await owner.ready;
  report.capture=await captureNative(owner,{binary,sha256});
  assert.equal(report.capture.status,'captured','Real-GDB synthetic qualification failed');
  assert(report.capture.debuggerExited&&report.capture.detached,'Debugger exit/detach not verified');
  assert(/#0\s/.test(report.capture.stdout),'No native frame captured');
  report.status='qualified';
}catch(error){report.errors.push(String(error.stack||error));process.exitCode=1;}
finally{
  if(owner){
    try{report.cleanup=await owner.stop();}
    catch(error){report.status='unavailable';report.errors.push(String(error));process.exitCode=1;}
  }
  await fs.writeFile(values.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
