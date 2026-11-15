import * as fs from 'node:fs/promises';
// /proc scans are confined to resource runs, not latency samples.
export function parseStat(pid, text) {
  const p = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return {pid:Number(pid), ppid:Number(p[1]), start:p[19], ticks:Number(p[11])+Number(p[12])};
}
export async function snapshot(root) {
  const names=(await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x));
  const all=(await Promise.all(names.map(async pid=>{try{return parseStat(pid, await fs.readFile(`/proc/${pid}/stat`,'utf8'));}catch{return null;}}))).filter(Boolean);
  const owned=new Set([root]);
  for(let changed=true;changed;) { changed=false; for(const p of all) if(owned.has(p.ppid)&&!owned.has(p.pid)){owned.add(p.pid);changed=true;} }
  const members=await Promise.all(all.filter(p=>owned.has(p.pid)).map(async p=>{
    try{const t=await fs.readFile(`/proc/${p.pid}/smaps_rollup`,'utf8'); return {...p,rssKiB:Number(/^Rss:\s+(\d+)/m.exec(t)[1]),pssKiB:Number(/^Pss:\s+(\d+)/m.exec(t)[1])};}
    catch{return {...p,rssKiB:null,pssKiB:null};}
  }));
  return {members,complete:members.some(p=>p.pid===root)&&members.every(p=>p.rssKiB!==null)};
}
export function accumulator(before, hz) {
  const initial=new Map(before.members.map(p=>[`${p.pid}:${p.start}`,p.ticks]));
  const last=new Map(initial); let rss=0,pss=0,complete=before.complete,count=0;
  return {
    add(sample) {
      count++; complete&&=sample.complete;
      if(sample.complete){rss=Math.max(rss,sample.members.reduce((n,p)=>n+p.rssKiB,0)/1024);pss=Math.max(pss,sample.members.reduce((n,p)=>n+p.pssKiB,0)/1024);}
      for(const p of sample.members){const key=`${p.pid}:${p.start}`;last.set(key,Math.max(last.get(key)||0,p.ticks));}
    },
    result(operations) {return {complete,sampleCount:count,sampledPeakRssMiB:complete?rss:null,sampledPeakPssMiB:complete?pss:null,cpuLowerBoundMsPerOp:[...last].reduce((n,[k,v])=>n+Math.max(0,v-(initial.get(k)||0)),0)*1000/hz/operations};}
  };
}
