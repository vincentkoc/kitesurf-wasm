import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, binary: { type: 'string' }, output: { type: 'string' },
  iterations: { type: 'string', default: '10' },
  mode: { type: 'string', default: 'latency' },
  config: { type: 'string' },
} });
assert(['chromium', 'lightpanda', 'kitesurf'].includes(values.engine), '--engine chromium|lightpanda|kitesurf');
assert(['latency', 'lifecycle'].includes(values.mode), '--mode latency|lifecycle');
assert(values.binary && values.output, '--binary and --output required');
assert(!values.config || values.engine === 'kitesurf', '--config is for uncompiled workerd only');
const iterations = Number(values.iterations);
assert(Number.isInteger(iterations) && iterations >= 3 && iterations <= 100, '--iterations 3..100');
const binary = resolve(values.binary);
const output = resolve(values.output);
await fs.access(binary);
try { await fs.access(output); throw Error('Output already exists: ' + output); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const html = '<!doctype html><html><head><title>Eval fixture</title></head><body><h1>Eval fixture</h1><input id="name"><button id="save">Save</button><p id="result">Waiting</p><script>document.getElementById("save").onclick=()=>{document.getElementById("result").textContent="Saved: "+document.getElementById("name").value}</script></body></html>';
const fixture = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(r => server.close(r));
  return port;
}
async function resources(rootPid) {
  if (process.platform !== 'linux') return null;
  const names = (await fs.readdir('/proc')).filter(n => /^\d+$/.test(n));
  const all = (await Promise.all(names.map(async pid => {
    try {
      const text = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
      const p = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(p[1]), start: p[19], userTicks: Number(p[11]), systemTicks: Number(p[12]) };
    } catch { return null; }
  }))).filter(Boolean);
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all) if (owned.has(p.ppid) && !owned.has(p.pid)) { owned.add(p.pid); changed = true; }
  }
  const members = await Promise.all(all.filter(p => owned.has(p.pid)).map(async p => {
    try {
      const text = await fs.readFile('/proc/' + p.pid + '/smaps_rollup', 'utf8');
      return { ...p, rssKiB: Number(/^Rss:\s+(\d+)/m.exec(text)[1]), pssKiB: Number(/^Pss:\s+(\d+)/m.exec(text)[1]) };
    } catch { return { ...p, rssKiB: null, pssKiB: null }; }
  }));
  const complete = members.length > 0 && members.every(p => p.rssKiB !== null);
  return { members, complete, rssMiB: complete ? members.reduce((n, p) => n + p.rssKiB, 0) / 1024 : null,
    pssMiB: complete ? members.reduce((n, p) => n + p.pssKiB, 0) / 1024 : null };
}
function cpuDifference(before, after) {
  if (!before || !after) return null;
  const previous = new Map(before.members.map(p => [p.pid + ':' + p.start, p]));
  let ticks = 0;
  for (const p of after.members) {
    const old = previous.get(p.pid + ':' + p.start);
    ticks += p.userTicks + p.systemTicks - (old ? old.userTicks + old.systemTicks : 0);
  }
  return { observedMilliseconds: ticks * 1000 / hz,
    method: 'Process self CPU ticks at batch boundaries. Exited descendants and their final increments can be missed; lower bound, not per-task median.' };
}
function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return { n: sorted.length, medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samplesMs: samples };
}
const profile = await fs.mkdtemp(os.tmpdir() + '/kitesurf-eval-');
let child;
let browser;
let childExit;
let stderr = '';
let interrupted = false;
const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const report = {
  schema: 1, engine: values.engine, mode: values.mode, utc: new Date().toISOString(),
  binary, binarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'),
  config: values.config ? resolve(values.config) : null,
  fixtureSha256: createHash('sha256').update(html).digest('hex'),
  configSha256: values.config ? createHash('sha256').update(await fs.readFile(resolve(values.config))).digest('hex') : null,
  node: process.version, platform: process.platform, arch: process.arch,
  hostLoad: os.loadavg(), iterations, memoryCurve: [],
  notes: [
    'Latency and lifecycle runs are separate. No memory traversal, proxy, OpenClaw routes, tracing or forced GC inside latency batches.',
    'Repeated navigation creates a fresh document; same-document JS measures a different workload and is reported separately.',
    'Memory is current whole-process-tree RSS/PSS at named boundaries, not per-page cost or true peak.',
    'No automatic process restarts during a run. A failed assertion invalidates the run.',
    'Forced GC is deliberately absent: normal runtime behavior is the subject of this test.',
  ],
};
async function checkpoint(stage) { report.memoryCurve.push({ stage, ...await resources(child.pid) }); }
try {
  const fixturePort = await listen(fixture);
  const url = 'http://127.0.0.1:' + fixturePort + '/';
  const port = await freePort();
  const args = values.engine === 'kitesurf'
    ? [...(values.config ? ['serve', resolve(values.config)] : []), '--experimental', '--socket-addr=http=127.0.0.1:' + port]
    : values.engine === 'lightpanda' ? ['serve', '--host', '127.0.0.1', '--port', String(port)]
    : ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
      '--disable-component-update', '--no-proxy-server', '--user-data-dir=' + profile, '--remote-debugging-port=' + port];
  report.args = args;
  const start = performance.now();
  child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stderr.on('data', data => { stderr += data; });
  childExit = new Promise(r => { child.once('exit', r); child.once('error', r); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (interrupted) throw Error('Evaluation interrupted');
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw Error('Engine exited before readiness: ' + stderr);
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(500) });
      if (response.ok) { report.version = await response.json(); ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert(ready, 'Engine did not become ready');
  report.startupReadyMs = performance.now() - start;
  await checkpoint('ready-before-connect');
  browser = await puppeteer.connect(values.engine === 'chromium'
    ? { browserURL: 'http://127.0.0.1:' + port, protocolTimeout: 15000 }
    : { browserWSEndpoint: 'ws://127.0.0.1:' + port + (values.engine === 'kitesurf' ? '/devtools/browser' : ''), protocolTimeout: 15000 });
  const page = await browser.newPage();
  const first = performance.now();
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  assert.equal(await page.evaluate('document.querySelector("h1").textContent'), 'Eval fixture');
  report.firstNavigationAndAssertionMs = performance.now() - first;
  await checkpoint('first-document');

  if (values.mode === 'latency') {
    const before = await resources(child.pid);
    const navigations = [];
    for (let i = 0; i < iterations; i++) {
      const begin = performance.now();
      await page.goto(url + '?iteration=' + i, { waitUntil: 'load', timeout: 15000 });
      navigations.push(performance.now() - begin);
      assert.equal(await page.evaluate('document.querySelector("h1").textContent'), 'Eval fixture');
    }
    const after = await resources(child.pid);
    report.navigation = summary(navigations);
    report.navigation.batchCpu = cpuDifference(before, after);
    const actions = [];
    for (let i = 0; i < iterations; i++) {
      const begin = performance.now();
      const result = await page.evaluate('document.getElementById("name").value="case"; document.getElementById("save").click(); document.getElementById("result").textContent');
      actions.push(performance.now() - begin);
      assert.equal(result, 'Saved: case');
    }
    report.sameDocumentJs = summary(actions);
    await checkpoint('after-latency-batches');
  } else {
    for (let i = 0; i < iterations; i++) {
      await page.goto(url + '?iteration=' + i, { waitUntil: 'load', timeout: 15000 });
      assert.equal(await page.evaluate('document.querySelector("h1").textContent'), 'Eval fixture');
      await checkpoint('navigation-' + (i + 1));
    }
    await delay(2000);
    await checkpoint('idle-2s');
  }
  await page.evaluate('globalThis.__evalSentinel=123');
  await page.goto(url + '?isolation-check', { waitUntil: 'load', timeout: 15000 });
  assert.equal(await page.evaluate('typeof globalThis.__evalSentinel'), 'undefined');
  report.navigationIsolationPassed = true;
  await checkpoint('after-isolation-check-navigation');
  await page.close();
  await delay(2000);
  await checkpoint('page-closed-2s');
  await browser.disconnect();
  browser = null;
  await delay(2000);
  await checkpoint('disconnected-2s');
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (browser) await browser.disconnect().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await childExit;
    clearTimeout(timer);
  }
  fixture.closeAllConnections();
  if (fixture.listening) await new Promise(r => fixture.close(r));
  try {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    report.cleanupError = error.message;
    report.success = false;
    process.exitCode = 1;
  }
  await fs.mkdir(resolve(output, '..'), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(output + '.stderr', stderr, { flag: 'wx' });
  console.log(JSON.stringify({ output, success: report.success, navigation: report.navigation,
    sameDocumentJs: report.sameDocumentJs, memory: report.memoryCurve.map(({stage,rssMiB,pssMiB})=>({stage,rssMiB,pssMiB})) }));
}
