import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
const port = Number(process.env.KITESURF_PORT ?? 18977);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid KITESURF_PORT');
// Fail if occupied before launch; never connect to an unrelated service.
try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); throw new Error('Smoke test port occupied'); }
catch (error) { if (error.message === 'Smoke test port occupied') throw error; }
const binary = resolve(process.env.KITESURF_BINARY ?? 'packages/browser/bin/kitesurf');
const child = spawn(binary, ['--experimental', `--socket-addr=http=127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
child.stderr.on('data', chunk => { log += chunk; });
let failure;
child.on('error', error => { failure = error; });
const exit = once(child, 'exit');
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Browser exited early: ${log}`);
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await setTimeout(100);
  }
  if (!ready) throw new Error('Browser startup timed out');
  browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/devtools/browser`, protocolTimeout: 30_000 });
  const page = await browser.newPage();
  const goto = html => page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'load', timeout: 30_000 });
  await goto('<title>Local Kitesurf</title><input id="name"><button onclick="document.querySelector(\'#result\').textContent=\'hello \'+document.querySelector(\'#name\').value">Submit</button><p id="result"></p>');
  await page.type('#name', 'world');
  await page.click('button');
  assert.equal(await page.$eval('#result', el => el.textContent), 'hello world');
  const png = await page.screenshot();
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  await page.evaluate('globalThis.secret = 123');
  await goto('<h1>New document</h1>');
  assert.equal(await page.evaluate('typeof secret'), 'undefined');
  const page2 = await browser.newPage();
  await page2.goto('data:text/html,<h1>Second tab</h1>');
  await page2.close();
  assert.equal(await page.$eval('h1', el => el.textContent), 'New document');
  await page.close();
  console.log(JSON.stringify({ passed: true, checks: ['CDP', 'input', 'click', 'Boa', 'PNG', 'navigation isolation', 'tab lifecycle'] }));
} finally {
  if (browser) await browser.disconnect();
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exit;
  clearTimeout(timer);
  if (log) console.error(log);
}
