// Shared HTTP documents and CDP actions: no engine-specific workload fast paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const fixtures = {
  navigation: '<!doctype html><title>Navigation fixture</title><main>' + Array.from({length:500}, (_,i)=>`<p data-row="${i}">Row ${i}</p>`).join('') + '</main>',
  interaction: '<!doctype html><title>Interaction fixture</title><input id="name"><button id="save">Save</button><p id="result">Waiting</p><script>document.getElementById("save").onclick=()=>{document.getElementById("result").textContent="Saved: "+document.getElementById("name").value}</script>',
  javascript: '<!doctype html><title>JavaScript fixture</title><output id="sum">Waiting</output>',
};
export const fixtureHash = createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
export async function operation(page, base, workload) {
  await page.goto(`${base}/${workload}`, {waitUntil:'load', timeout:15000});
  // Every operation navigates to a fresh document. This assertion gates isolation.
  assert.equal(await page.evaluate('typeof globalThis.__evalMarker'), 'undefined');
  await page.evaluate('globalThis.__evalMarker = true');
  if (workload === 'navigation') {
    assert.deepEqual(await page.evaluate('({count:document.querySelectorAll("[data-row]").length,last:document.querySelector("[data-row=\\"499\\"]").textContent})'), {count:500,last:'Row 499'});
  } else if (workload === 'interaction') {
    await page.type('#name','benchmark');
    await page.click('#save');
    assert.equal(await page.$eval('#result', el=>el.textContent), 'Saved: benchmark');
  } else if (workload === 'javascript') {
    assert.deepEqual(await page.evaluate(`(() => { const data=Array.from({length:10000},(_,i)=>({id:i,value:i%97})); const total=JSON.parse(JSON.stringify(data)).filter(x=>x.id%2===0).reduce((n,x)=>n+x.value,0); document.getElementById('sum').textContent=String(total); return {total,text:document.getElementById('sum').textContent,length:data.length}; })()`), {total:239824,text:'239824',length:10000});
  } else throw Error('Unknown workload');
}
