// Run only in an explicitly reserved measurement window. No concurrent engines.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import os from 'node:os';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import {fixtures,fixtureHash,operation} from './fixtures.mjs';
import {snapshot,accumulator} from './resources.mjs';
import {launch} from './containment.mjs';
import {createRowTrace} from './trace.mjs';
const traceRoot=process.env.BROWSER_EVAL_TRACE_DIR?resolve(process.env.BROWSER_EVAL_TRACE_DIR):null;
if(traceRoot)await fs.mkdir(traceRoot,{recursive:true});

const {values} = parseArgs({options:{config:{type:'string'},output:{type:'string'},'measurement-window-reserved':{type:'boolean',default:false}}});
assert(values.config&&values.output,'--config and --output required');
assert(values['measurement-window-reserved'],'Reserve an idle host and pass --measurement-window-reserved');
assert.equal(process.platform,'linux','Resource measurements require Linux /proc');
const config=JSON.parse(await fs.readFile(values.config,'utf8'));
const trials=config.trials??5, repetitions=config.repetitions??10, warmups=config.warmups??2;
for(const [n,v] of Object.entries({trials,repetitions,warmups})) assert(Number.isInteger(v)&&v>=(n==='trials'?3:1)&&v<=100,`Invalid ${n}`);
assert.deepEqual(config.engines.map(e=>e.id).sort(),['chromium','kitesurf','lightpanda']);
for(const engine of config.engines){
  assert(engine.binary&&engine.runtimeIdentity,'Each engine requires binary and actual runtimeIdentity (not compatibility UA)');
  assert(engine.args===undefined,'Custom engine arguments are not allowed; launch parity is fixed');
  engine.binary=resolve(engine.binary); await fs.access(engine.binary);
}
const output=resolve(values.output);
// exclusive creation retains a failed/incomplete run, never overwrites prior evidence.
const handle=await fs.open(output,'wx');
const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
const hash=async path=>createHash('sha256').update(await fs.readFile(path)).digest('hex');
const report={schema:1,diagnosticOnly:!!traceRoot,status:'running',started:new Date().toISOString(),fixtureHash,config,
  host:{platform:process.platform,arch:process.arch,node:process.version,kernel:os.release(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,load:os.loadavg(),totalMemory:os.totalmem()},
  engineIdentity:[],runs:[],notes:[
    'Cold means a fresh process/profile and its first workload, not cold filesystem cache. Startup readiness is separate.',
    'Warm means the same process after warmups, but a fresh document on every operation; no page/isolate pooling.',
    'Each workload and measurement pass has a separate engine process; trials rotate engine order. No parallel execution.',
    'Latency excludes process-tree scans. Resource pass is separately instrumented at 50ms plus operation boundaries.',
    'RSS/PSS and CPU sample all supervisor descendants, including adopted orphans, but exclude the supervisor itself. RSS double-counts shared pages; sampled peak is not true peak.',
    'CPU is observed quantized process self ticks, not total CPU or a bound. Quantization can overcount; missed exits/final increments can undercount.',
    'Workload wall clock includes CDP navigation, actions and assertions. No rendering, real websites or network-speed claim.',
    'Any correctness, resource completeness, launch or cleanup failure invalidates the comparison; failures are retained, never wins.'
  ]};
if(traceRoot)report.notes.unshift('DIAGNOSTIC ONLY: trace observation changes overhead; timings are not performance-qualified and cannot be charted.');
// FileHandle.writeFile uses its current offset: write by explicit position instead.
const save=async()=>{const text=JSON.stringify(report,null,2)+'\n';await handle.truncate(0);await handle.write(text,0,'utf8');await handle.sync();};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function freePort(){const s=http.createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p;}
const server=http.createServer((req,res)=>{const name=req.url.slice(1);if(!Object.hasOwn(fixtures,name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(fixtures[name]);});
report.supervisorVersion=execFileSync('python3',['--version'],{encoding:'utf8'}).trim();
report.resourceEnvironment={LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH??null,TMPDIR:'/tmp',TMP:'/tmp',TEMP:'/tmp'};
let active,interrupted=false;
const terminate=child=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');};
const interrupt=()=>{interrupted=true;if(active)terminate(active);};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
async function run(engine,workload,phase,pass,trial,base){
  assert(!interrupted,'Evaluation interrupted');
  const row={engine:engine.id,workload,phase,pass,trial,status:'running',wallMs:[],started:new Date().toISOString(),loadBefore:os.loadavg()}; report.runs.push(row); await save();
  const profile=await fs.mkdtemp('/tmp/browser-eval-');
  let child,browser,containment,rootPid,supervisorPid,polling=false,poller,trace,restoreTrace,page;
  const observedOperation=(kind,index)=>trace?trace.runOperation(kind,index,()=>operation(page,base,workload)):operation(page,base,workload);
  try{
    if(traceRoot){
      const directory=resolve(traceRoot,String(report.runs.length).padStart(4,'0')+'-'+engine.id+'-'+workload+'-'+phase+'-'+pass+'-'+trial);
      row.trace={status:'running',directory};
      trace=await createRowTrace(directory,{row:report.runs.length,engine:engine.id,workload,phase,pass,trial});
    }
    const port=await freePort();
    const args=engine.id==='kitesurf'?['--experimental',`--socket-addr=http=127.0.0.1:${port}`]:engine.id==='lightpanda'?['serve','--host','127.0.0.1','--port',String(port)]:['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--disable-component-update','--no-proxy-server',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`];
    row.args=args;
    const start=performance.now(); let spawnError,stderr='';
    containment=launch(engine.binary,args,{...process.env,TMPDIR:'/tmp',TMP:'/tmp',TEMP:'/tmp'},{captureStdout:!!trace});
    child=active=containment.child;
    if(trace)trace.captureStdout(containment.stdout);
    child.on('error',e=>spawnError=e);child.stderr.on('data',x=>{stderr=(stderr+x).slice(-8000);row.stderr=stderr;trace?.stderr(x);});
    rootPid=await containment.ready;row.rootPid=rootPid;
    supervisorPid=child.pid;row.supervisorPid=supervisorPid;
    let ready=false;
    for(let i=0;i<150;i++){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||child.signalCode)throw Error('Engine exited: '+stderr);
      try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){row.compatibilityLabels=await r.json();ready=true;break;}}catch{}
      await delay(100);
    }
    assert(ready,'Readiness timed out');row.startupReadyMs=performance.now()-start;
    const connectOptions=engine.id==='chromium'?{browserURL:`http://127.0.0.1:${port}`,protocolTimeout:15000}:{browserWSEndpoint:`ws://127.0.0.1:${port}${engine.id==='kitesurf'?'/devtools/browser':''}`,protocolTimeout:15000};
    if(trace)connectOptions.logger=trace.logger;
    browser=await puppeteer.connect(connectOptions);
    page=await browser.newPage();
    if(trace)restoreTrace=trace.install(page);
    if(phase==='warm')for(let i=0;i<warmups;i++){await observedOperation('warmup',i);trace?.assertHealthy();}
    const n=phase==='cold'?1:repetitions;
    let stats;
    if(pass==='resources'){
      const first=await snapshot(supervisorPid); stats=accumulator(first,hz);stats.add(first);polling=true;
      poller=(async()=>{while(polling){await delay(50);if(polling)stats.add(await snapshot(supervisorPid));}})();
    }
    for(let i=0;i<n;i++){
      const t=performance.now();await observedOperation('measured',i);row.wallMs.push(performance.now()-t);trace?.assertHealthy();
      if(stats)stats.add(await snapshot(supervisorPid));
    }
    polling=false;if(poller)await poller;
    if(stats){row.resources=stats.result(n);assert(row.resources.complete,'Incomplete process-tree sample');}
    row.status='passed';
  }catch(e){row.status='failed';row.error=String(e.stack||e);if(trace)await trace.captureFailure(supervisorPid);throw e;}
  finally{
    polling=false;if(poller)await poller.catch(()=>{});
    try{if(browser)await browser.disconnect();}finally{
      try {
        trace?.drainStdout();
        if(containment){try{row.cleanup=await containment.stop();}catch(e){row.status='failed';row.cleanup={status:'failed',error:String(e)};throw e;}}
      } finally {
        active=null;restoreTrace?.();
        try{
          if(trace){try{row.trace=await trace.close();}catch(error){row.status='failed';row.trace=trace.status();throw error;}}
          else if(row.trace){row.trace.status='incomplete';row.trace.errors=[row.error??'Trace setup failed'];}
        }finally{await fs.rm(profile,{recursive:true,force:true});row.loadAfter=os.loadavg();await save();}
      }
    }
  }
}
try{
  for(const engine of config.engines){const digest=await hash(engine.binary);if(engine.expectedSha256)assert.equal(digest,engine.expectedSha256,'Binary digest mismatch');report.engineIdentity.push({id:engine.id,runtimeIdentity:engine.runtimeIdentity,binarySha256:digest});}
  report.harnessHashes={};for(const file of ['run.mjs','fixtures.mjs','resources.mjs','summary.mjs','chart.mjs','containment.mjs','supervise.py','trace.mjs'])report.harnessHashes[file]=await hash(new URL(file,import.meta.url));
  const port=await listen(server),base=`http://127.0.0.1:${port}`;
  for(let trial=0;trial<trials;trial++) for(const workload of Object.keys(fixtures)) for(const phase of ['cold','warm']) for(const pass of ['latency','resources']){
    const offset=trial%3;
    for(let j=0;j<3;j++)await run(config.engines[(j+offset)%3],workload,phase,pass,trial,base);
  }
  report.status='passed';
}catch(e){report.status='failed';report.error=String(e.stack||e);process.exitCode=1;}
finally{report.finished=new Date().toISOString();await save();await handle.close();server.close();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
