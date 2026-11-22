import puppeteer from 'puppeteer-core';
import fs from 'fs';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.goto('http://localhost:5190/', { waitUntil: 'networkidle0' });
const xml = fs.readFileSync('/Users/emi2mac/Documents/Emi Music Note/memory-from-cats-andrew-lloyd-webber/memory-from-cats-andrew-lloyd-webber.musicxml', 'utf8');
console.log(await p.evaluate(async (xml) => {
  const { XmlModel } = await import('/js/scoremodel.js');
  const m = new XmlModel(xml);
  const out = [];
  const bar = () => m.toString().match(/<measure[^>]*number="3"[^>]*>[\s\S]*?<\/measure>/)[0].replace(/\s+/g, ' ').slice(0, 160);
  out.push('div ' + m.div + ' meter ' + m.meter + ' beats(2) ' + m.beats(2) + ' count ' + m.count(2) + ' get ' + JSON.stringify(m.get(2, 0)));
  m.setPitch(2, 0, 'C6'); out.push('after pitch beats ' + m.beats(2) + ' | ' + bar());
  const snap = m.snapshot();
  m.add(2, 0); out.push('after add beats ' + m.beats(2) + ' | ' + bar());
  m.restore(snap); out.push('after restore beats ' + m.beats(2) + ' | ' + bar());
  return out.join('\n');
}, xml));
await b.close();
