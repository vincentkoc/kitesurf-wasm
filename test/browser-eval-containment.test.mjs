import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {launch} from '../scripts/browser-eval/containment.mjs';

test('cleanup reaps setsid/double-fork descendants before the next trial', {skip:process.platform!=='linux',timeout:15000}, async()=>{
  const dir=await fs.mkdtemp(join(os.tmpdir(),'eval-containment-test-'));
  const pidFile=join(dir,'escaped-pid');
  // Root -> detached intermediate -> detached long-lived grandchild.
  const grandchild=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
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
