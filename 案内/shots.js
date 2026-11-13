// 業務委託向けの案内用キャプチャ：テスト画面（ダミーデータ）を業務委託ディレクターの見え方にして撮る
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'img'); fs.mkdirSync(OUT, { recursive: true });
const PORT = 9333, URL0 = 'http://localhost:5178/dev-test/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.argv[2] ? process.argv[2].split(',') : null;
const SHOTS = [
  { id: '01_summary', dash: 'media', view: 'summary' },
  { id: '02_monthly', dash: 'media', view: 'monthly' },
  { id: '03_sim', dash: 'media', view: 'sim', wait: 6000 },
  { id: '04_simcmp', dash: 'media', view: 'simcmp', wait: 6000 },
  { id: '05_progress', dash: 'articles', view: 'am-progress' },
  { id: '06_amonthly', dash: 'articles', view: 'am-monthly' },
  { id: '07_status', dash: 'articles', view: 'am-status' },
  { id: '08_press', dash: 'articles', view: 'am-press' },
  { id: '09_kw', dash: 'articles', view: 'kw' },
  { id: '10_reward', dash: 'rewards', view: 'rw-me' },
  { id: '11_goal', dash: 'goals', view: 'wk-month' },
  { id: '12_goalart', dash: 'goals', view: 'wk-articles' },
  { id: '13_goalmetric', dash: 'goals', view: 'wk-metrics' }
];
(async () => {
  const prof = path.join(__dirname, 'prof');
  const ch = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let tgt; for (let i = 0; i < 40 && !tgt; i++) { await sleep(300); try { tgt = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + URL0, { method: 'PUT' })).json(); } catch (e) { /* 待つ */ } }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const wait = {}; ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && wait[j.id]) { wait[j.id](j); delete wait[j.id]; } };
  const send = (method, params) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + expr + '})()', awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.error('JS:', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result && r.result.result.value; };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.enable'); await send('Runtime.enable');
  if (!only || only.includes('00_login')) { await send('Page.navigate', { url: 'http://localhost:5178/public/login.html' }); await sleep(3000); const sh = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, '00_login.png'), Buffer.from(sh.result.data, 'base64')); console.log('00_login'); }
  await send('Page.navigate', { url: URL0 }); await sleep(5000);
  /* 業務委託ディレクターの見え方。UI確認の帯・管理者向けの帯は消す */
  console.log(await ev(`const s=document.getElementById('ui-preview-select'); s.value='out_director'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,3000));
    const st=document.createElement('style'); st.textContent='#preview-banner,.ai-warn,#task-banner,.task-banner{display:none!important}'; document.head.appendChild(st); return 'preview '+document.getElementById('dash-select').value;`));
  for (const s of SHOTS) {
    if (only && !only.includes(s.id)) continue;
    const info = await ev(`[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&x.innerText.trim()==='閉じる').forEach(x=>x.click()); await new Promise(r=>setTimeout(r,300)); /* 前の撮影で開いた画面を閉じる */ const d=document.getElementById('dash-select'); if(d.value!=='${s.dash}'){d.value='${s.dash}'; d.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,2000));}
      const b=document.querySelector('[data-view="${s.view}"]'); if(!b) return 'NO VIEW'; b.click(); await new Promise(r=>setTimeout(r,${s.wait || 3500}));
      document.querySelectorAll('div,section').forEach(e=>{ if(/^要対応/.test((e.innerText||'').trim()) && e.offsetHeight<120) e.style.display='none'; });
      ${s.view === 'am-monthly' ? "for(let i=0;i<8&&!document.querySelector('#content table');i++){ const pb=[...document.querySelectorAll('#content button')].find(x=>/前の月/.test(x.innerText)); if(!pb) break; pb.click(); await new Promise(r=>setTimeout(r,1500)); }" : ''}
      /* 案内に要らないもの：左上の UI確認、右上の「管理者」、ダミーの人名 */
      const sel=document.getElementById('ui-preview-select'); if(sel){ let p=sel; while(p.parentElement && p.parentElement.getBoundingClientRect().height < 160) p=p.parentElement; p.style.display='none'; }
      const walk=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while((n=walk.nextNode())){ const t=n.nodeValue; if(t.trim()==='管理者' && n.parentElement.closest('header,.topbar,#user-box,.user')) n.nodeValue='業務委託 太郎'; else if(t.trim()==='管理者') n.nodeValue=t.replace('管理者','業務委託 太郎'); if(t.trim()==='管') n.nodeValue='業'; if(/守屋|井川|菅原/.test(t)) n.nodeValue=t.replace(/守屋/g,'業務委託 太郎').replace(/井川|菅原/g,'山田'); }
      window.scrollTo(0,0); const c=document.getElementById('content'); return (c.querySelector('.err')?'ERR ':'')+document.getElementById('page-title').innerText+' '+c.innerText.length;`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, s.id + '.png'), Buffer.from(shot.result.data, 'base64'));
    console.log(s.id, info);
  }
  ws.close(); ch.kill();
})().catch(e => { console.error(e); process.exit(1); });
