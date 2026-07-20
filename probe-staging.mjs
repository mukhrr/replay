import { chromium } from 'playwright';
const URL = 'https://staging.new.expensify.com/';
const email = `mukhrr+repro${Date.now().toString().slice(-7)}@gmail.com`;
const shot = (p,n) => p.screenshot({ path: `/tmp/exp-probe/${n}.png` }).catch(()=>{});

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport:{width:1440,height:900} })).newPage();
const api = [];
p.on('response', r => { if (r.url().includes('/api')) api.push(`${r.status()} ${r.url().split('?')[0].slice(-40)}`); });

try {
  await p.goto(URL, { waitUntil:'domcontentloaded', timeout:45000 });
  await p.waitForTimeout(5000);
  console.log('title:', await p.title());
  await shot(p,'1-loaded');

  const input = p.locator('input[type="email"], input[inputmode="email"], input[name="username"]').first();
  await input.waitFor({ state:'visible', timeout:30000 });
  await input.fill(email);
  console.log('email:', email);

  await p.getByRole('button',{name:/continue/i}).first().click();
  await p.waitForTimeout(8000);
  await shot(p,'2-after-continue');

  const body = (await p.evaluate(()=>document.body.innerText||'')).replace(/\s+/g,' ').slice(0,280);
  console.log('state:', body);
  console.log('api calls:', api.slice(0,6));
} catch(e) {
  console.log('FAILED:', String(e).split('\n')[0].slice(0,160));
  await shot(p,'fail');
  console.log('api calls:', api.slice(0,6));
} finally { await b.close(); }
