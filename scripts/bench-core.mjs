import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCore, compileCore } from '../packages/core/index.mjs';
const samples = [];
await compileCore();
for (let pair = 0; pair < 8; pair++) {
  for (const mode of pair % 2 ? ['cached', 'compile-each'] : ['compile-each', 'cached']) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const module = mode === 'cached' ? await compileCore() : await WebAssembly.compile(await readFile(new URL('../packages/core/vendor/kitesurf_core_bg.wasm', import.meta.url)));
    const core = await createCore({ module });
    try {
      if (await core.evaluate('6*7') !== '42') throw new Error('Invalid evaluation');
      if ((await core.scan('<title>bench</title>')).title !== 'bench') throw new Error('Invalid scan');
    } finally { await core.close(); }
    const elapsed = process.cpuUsage(cpu);
    samples.push({ pair, mode, wallMs: performance.now() - start, cpuMs: (elapsed.user + elapsed.system) / 1000, rssBytes: process.memoryUsage().rss });
  }
}
const median = a => [...a].sort((x,y)=>x-y)[Math.floor(a.length / 2)];
console.log(JSON.stringify({ scope: 'Node component creation+evaluate+scan+terminate; not CDP browser speed', samples, summary: ['compile-each','cached'].map(mode => ({ mode, medianWallMs: median(samples.filter(s=>s.mode===mode).map(s=>s.wallMs)), medianCpuMs: median(samples.filter(s=>s.mode===mode).map(s=>s.cpuMs)) })), processPeakRssKiB: process.resourceUsage().maxRSS }, null, 2));
