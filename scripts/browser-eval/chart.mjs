import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fmt=x=>x>=100?x.toFixed(0):x.toFixed(1);
export function render(summary,workload,phase){
  assert.equal(summary.status,'passed');assert.match(summary.sourceSha256,/^[a-f0-9]{64}$/,'Summary must refer to measured raw input');
  assert(['navigation','interaction','javascript'].includes(workload));assert(['cold','warm'].includes(phase));
  const rows=summary.cells.filter(r=>r.workload===workload&&r.phase===phase);
  assert.deepEqual(rows.map(r=>r.engine).sort(),['chromium','kitesurf','lightpanda']);
  const names={kitesurf:'Kitesurf WASM',chromium:'Chrome / Chromium',lightpanda:'Lightpanda'};
  const colors={kitesurf:'#ffffff',chromium:'url(#baseline-hatch)',lightpanda:'#96999e'};
  const parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1230" viewBox="0 0 1440 1230">','<rect width="1440" height="1230" fill="#090a0b"/>','<defs><pattern id="baseline-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 2L2 -2M0 8L8 0M6 10L10 6" stroke="#c4c8cc" stroke-width="2"/></pattern></defs>','<g font-family="DejaVu Sans, sans-serif" fill="#f3f4f5">'];
  const text=(x,y,s,size=20,fill='#f3f4f5')=>parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${escape(s)}</text>`);
  text(66,62,'BROWSER WORKLOADS / LOCAL CONTROLLED EVAL',16,'#9ca3aa');
  text(66,119,`${workload[0].toUpperCase()+workload.slice(1)} / ${phase} process`,42);
  text(66,157,`${summary.trials} independent trials / median of per-trial values / lower is better`,20,'#b0b6bd');
  const metrics=[['wallMs','Wall clock','ms / operation'],['sampledPeakRssMiB','Process-tree sampled peak RSS','MiB'],['observedCpuMsPerOp','Observed CPU (quantized, incomplete)','ms / operation']];
  for(let m=0;m<metrics.length;m++){
    const [key,title,unit]=metrics[m],top=215+m*230;
    const max=Math.max(...rows.map(r=>r[key].max));
    assert(Number.isFinite(max)&&max>=0);const scale=max||1;
    text(66,top,title,25);text(1100,top,unit,18,'#aeb4bb');
    parts.push(`<path d="M66 ${top+16}H1374" stroke="#30343a"/>`);
    rows.forEach((row,i)=>{
      const v=row[key],y=top+53+i*48;assert(v.n===summary.trials&&v.min<=v.median&&v.median<=v.max);
      text(66,y+7,names[row.engine],20);
      parts.push(`<rect x="350" y="${y-15}" width="${(v.median/scale*850).toFixed(3)}" height="25" stroke="#777d85" fill="${colors[row.engine]}"/>`);
      // Range whisker is the trial min-max, not a confidence interval.
      const lo=350+v.min/scale*850,hi=350+v.max/scale*850;
      parts.push(`<path d="M${lo.toFixed(3)} ${y-3}H${hi.toFixed(3)} M${lo.toFixed(3)} ${y-9}V${y+3} M${hi.toFixed(3)} ${y-9}V${y+3}" stroke="#fff" opacity=".75"/>`);
      text(1230,y+7,fmt(v.median),30);
    });
    text(350,top+204,'0',14,'#8e969f');text(1110,top+204,fmt(scale),14,'#8e969f');
  }
  text(66,942,phase==='cold'?'Cold = fresh process/profile; first operation. Startup excluded; filesystem cache not flushed.':`Warm = ${summary.warmups} untimed warmups; ${summary.repetitions} fresh-document operations per trial.`,17,'#b0b6bd');
  text(66,970,'Same local HTTP + CDP actions/assertions. No pooling, screenshots, tracing or forced GC.',17,'#b0b6bd');
  text(66,998,'Latency and resource passes separate. RSS shares double-counted; sample interval 50ms + boundaries.',17,'#b0b6bd');
  text(66,1026,'CPU quantization can overcount; missed exits can undercount. Whiskers = trial min-max.',17,'#b0b6bd');
  for(let i=0;i<summary.engineIdentity.length;i++){
    const e=summary.engineIdentity[i];text(66,1069+i*27,`${names[e.id]}: ${e.runtimeIdentity} / binary ${e.binarySha256.slice(0,12)}`,16,'#9ca3aa');
  }
  text(66,1170,`Raw ${summary.sourceSha256.slice(0,16)} / fixture ${summary.fixtureHash.slice(0,12)} / ${summary.host.arch} / ${summary.host.kernel}`,15,'#8e969f');
  text(66,1198,`Run ${summary.started} / ${summary.host.cpu}`,15,'#8e969f');
  parts.push('</g></svg>');return parts.join('\n')+'\n';
}
export function renderPoster(summary,workload,phase){
  // Reuse the detailed chart's validation; the poster is the same data, not a new result.
  render(summary,workload,phase);
  const rows=summary.cells.filter(r=>r.workload===workload&&r.phase===phase);
  const names={kitesurf:'Kitesurf WASM',chromium:'Chrome / Chromium',lightpanda:'Lightpanda'};
  const fills={kitesurf:'#fff',chromium:'url(#baseline-hatch)',lightpanda:'#92969c'};
  const parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">',
    '<rect width="1920" height="1080" fill="#090a0b"/>',
    '<defs><pattern id="baseline-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 2L2 -2M0 8L8 0M6 10L10 6" stroke="#bfc4ca" stroke-width="2"/></pattern></defs>',
    '<g font-family="DejaVu Sans, sans-serif" fill="#f4f4f4">'];
  const text=(x,y,value,size=22,fill='#f4f4f4')=>parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${escape(value)}</text>`);
  text(70,74,'BROWSER ENGINES / MEASURED, NOT MARKETED',21,'#a8adb4');
  text(70,157,`${workload[0].toUpperCase()+workload.slice(1)} / ${phase} process`,64);
  text(70,210,`${summary.trials} trials · median of per-trial values · lower is better`,26,'#a8adb4');
  const metrics=[['wallMs','Wall clock','ms / operation'],['sampledPeakRssMiB','Sampled peak RSS','MiB / process tree'],['observedCpuMsPerOp','Observed CPU','ms / operation · incomplete']];
  metrics.forEach(([key,title,unit],m)=>{
    const x=70+m*610,scale=Math.max(...rows.map(row=>row[key].max))||1;
    text(x,302,title,34);text(x,342,unit,21,'#a8adb4');
    parts.push(`<path d="M${x} 369H${x+550}" stroke="#43474c"/>`);
    rows.forEach((row,i)=>{
      const y=423+i*115,v=row[key];
      text(x,y,names[row.engine],24);
      parts.push(`<text x="${x+550}" y="${y}" text-anchor="end" font-size="34">${escape(fmt(v.median))}</text>`);
      parts.push(`<rect x="${x}" y="${y+20}" width="${(v.median/scale*550).toFixed(3)}" height="28" fill="${fills[row.engine]}" stroke="#777d85"/>`);
      const lo=x+v.min/scale*550,hi=x+v.max/scale*550;
      parts.push(`<path d="M${lo.toFixed(3)} ${y+34}H${hi.toFixed(3)} M${lo.toFixed(3)} ${y+26}V${y+42} M${hi.toFixed(3)} ${y+26}V${y+42}" stroke="#fff"/>`);
    });
  });
  text(70,798,phase==='cold'?'Fresh process/profile; first operation. Process startup excluded. Filesystem cache not flushed.':`${summary.warmups} untimed warmups; ${summary.repetitions} fresh-document operations per trial. No page pooling.`,22,'#b6bbc2');
  text(70,837,'Same HTTP fixture + CDP assertions. Separate latency/resource passes. Whiskers: trial min–max.',22,'#b6bbc2');
  text(70,876,'RSS double-counts shared pages. CPU is quantized/incomplete. Shared runner; not exclusive-host qualification.',22,'#b6bbc2');
  text(70,923,summary.engineIdentity.map(e=>`${names[e.id]}: ${e.binarySha256.slice(0,12)}`).join(' · '),20,'#8f969f');
  text(70,958,`Raw ${summary.sourceSha256.slice(0,16)} · fixture ${summary.fixtureHash.slice(0,12)} · ${summary.host.arch} · ${summary.host.kernel}`,19,'#8f969f');
  text(70,993,`Measured ${summary.started} · ${summary.host.cpu}`,19,'#8f969f');
  parts.push('</g></svg>');return parts.join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,workload,phase,prefix,mode]=process.argv.slice(2);assert(prefix,'node chart.mjs SUMMARY.json WORKLOAD cold|warm OUTPUT_PREFIX [--poster]');
  assert(mode===undefined||mode==='--poster','Unknown chart mode');
  const svg=(mode==='--poster'?renderPoster:render)(JSON.parse(await fs.readFile(input,'utf8')),workload,phase);
  await fs.writeFile(prefix+'.svg',svg,{flag:'wx'});
  // Python/cairo is an explicit optional conversion dependency, never another browser run.
  try{await fs.access(prefix+'.png');throw Error('PNG output exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const result=spawnSync(process.env.EVAL_PYTHON||'python3',['-c','import cairosvg,sys; cairosvg.svg2png(url=sys.argv[1],write_to=sys.argv[2])',prefix+'.svg',prefix+'.png'],{encoding:'utf8'});
  assert.equal(result.status,0,'SVG retained; PNG needs pip install -r scripts/browser-eval/requirements-render.txt\n'+result.stderr);
}
