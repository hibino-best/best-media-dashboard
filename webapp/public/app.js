/* BESTメディア 数値ダッシュボード — 画面 */
(() => {
'use strict';

// ================= 共通 =================
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('ja-JP');
// リンク先は http(s) だけ（javascript: などは無効にする）
const escUrl = u => /^https?:\/\//i.test(String(u || '').trim()) ? esc(String(u).trim()) : '#';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const seriesColor = i => css('--s' + ((i % 10) + 1));
const ALL = '__all__';

let fbAuth = null, me = null;
async function api(path, view) {
  const tok = await fbAuth.currentUser.getIdToken();
  const headers = { Authorization: 'Bearer ' + tok };
  if (view) headers['X-View'] = encodeURIComponent(view);
  if (PREVIEW_UID) headers['X-Preview-UID'] = PREVIEW_UID;   // UI確認（人ごと）
  if (expFull()) headers['X-Exp'] = '1';   /* 支出情報（BEST社員）：契約・請求を全員分読む（2026-11-05） */
  const res = await fetch('/api' + path, { headers });
  if (res.headers && res.headers.get && res.headers.get('X-AI-Warn')) showAiWarn();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || ('通信エラー（' + res.status + '）')), { status: res.status });
  return body;
}
async function apiSend(method, path, data) {
  if (me && me._preview) throw new Error('UI確認中は保存できません（画面の確認だけです）');
  const tok = await fbAuth.currentUser.getIdToken();
  const res = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('通信エラー（' + res.status + '）'));
  return body;
}

/** AI や自動操作による取得の可能性を本人に知らせる（承認したアカウントには出ない） */
function showAiWarn() {
  if (document.getElementById('ai-warn')) return;
  if (typeof me !== 'undefined' && me && me.perms && me.perms.media === 'admin') return;   /* 管理者には出さない（2026-10-30 ユーザー指定） */
  document.body.insertAdjacentHTML('afterbegin', '<div id="ai-warn" class="ai-warn" role="alert"><b>AI や自動操作による情報の取得の可能性を検知しました。</b>管理者に通知しています。このダッシュボードの情報を AI で読み取れるのは、管理者が承認したアカウントだけです。<button type="button" class="linkbtn" onclick="this.parentNode.remove()">閉じる</button></div>');
}
/** 画面が自動操作されている印があれば知らせる（navigator.webdriver・ヘッドレスのブラウザなど） */
async function checkAutomation() {
  const ua = navigator.userAgent || '', marks = [navigator.webdriver ? 'webdriver' : '', /HeadlessChrome|Puppeteer|Playwright|Selenium|PhantomJS/i.test(ua) ? 'headless' : '', window.callPhantom || window._phantom ? 'phantom' : '', document.documentElement.getAttribute('webdriver') ? 'webdriver-attr' : ''].filter(Boolean);
  if (!marks.length) return;
  try { const r = await apiSend('POST', '/ai-signal', { path: location.pathname, detail: marks.join(',') }); if (r.warn) showAiWarn(); } catch (e) { /* 何もしない */ }
}

// ================= 日付 =================
const pad = n => String(n).padStart(2, '0');
const todayJst = () => { const d = new Date(Date.now() + 9 * 3600000); return d.toISOString().slice(0, 10); };
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const mLabel = ym => ym.replace('-', '/');
const mShort = ym => ym.slice(2).replace('-', '/');
const dLabel = d => d.slice(5).replace('-', '/');
const YESTERDAY = addDays(todayJst(), -1);
const CUR_MONTH = todayJst().slice(0, 7);
const LAST_FULL = shiftMonth(CUR_MONTH, -1);

// ================= データ =================
let META = null, MONTHLY = null, MONTHS = [];
const DAILY_CACHE = new Map(), REGION_CACHE = new Map();

const ent = id => ((META && META.media) || []).find(m => m.id === id) || dirEnt(id);   /* 読み込みの途中（META がまだ）に切り替えても止まらないように（2026-11-05） */
/** 制作状況でディレクトリを選んだときの「メディア|ディレクトリ」（META にないディレクトリ）（2026-10-28 ユーザー指定） */
function dirEnt(id) { const i = String(id || '').indexOf('|'); if (i < 0) return null; const media = id.slice(0, i), sub = id.slice(i + 1); return (ARTICLE_SUBS[media] || []).includes(sub) ? { id, media, sub, name: sub, dirSub: true } : null; }
const topIds = () => META.media.filter(m => !m.block).map(m => m.id);
function mediaName(id) {
  if (id === ALL) return 'メディア累計';
  const m = ent(id); if (!m) return id;
  if (m.dirSub) { const p = META.media.find(x => x.media === m.media && !x.block); return (p ? p.name : m.media) + '／' + m.sub; }
  if (m.block) { const p = META.media.find(x => x.media === m.media && !x.block); return (p ? p.name : m.media) + '／' + m.name; }
  return m.name;
}

const RAW_KEYS = ['pv', 'sessions', 'users', 'active', 'newUsers', 'engSec', 'keyEvents', 'imp', 'clicks', 'posW', 'postsTotal', 'posts', 'rewrites', 'lite', 'tweak', 'wpPosts', 'wpRewrites', 'kCalls', 'visits', 'contracts', 'revPartner', 'revAffiliate', 'cost'];
function sumRaw(list) {
  const t = { ch: {} }; let hasSc = false, hasGa = false;
  list.forEach(r => {
    if (!r) return;
    if (r.pv != null) hasGa = true;
    if (r.imp != null) hasSc = true;
    RAW_KEYS.forEach(k => { if (r[k] != null) t[k] = (t[k] || 0) + Number(r[k]); });
    if (r.costs) { t.costs = t.costs || {}; Object.entries(r.costs).forEach(([c, v]) => { t.costs[c] = (t.costs[c] || 0) + Number(v); }); }
    Object.entries(r.ch || {}).forEach(([c, v]) => { const x = t.ch[c] = t.ch[c] || { pv: 0, sessions: 0 }; x.pv += v.pv; x.sessions += v.sessions; });
  });
  t.hasGa = hasGa; t.hasSc = hasSc;
  return t;
}
function derive(r, approxUsers) {
  const g = r.hasGa, s = r.hasSc;
  return {
    pv: g ? r.pv || 0 : null, sessions: g ? r.sessions || 0 : null, users: g ? r.users || 0 : null, active: g ? r.active || 0 : null, newUsers: g ? r.newUsers || 0 : null,
    eng: g && r.sessions ? Math.floor(r.engSec / r.sessions) : null,
    cv: g ? r.keyEvents || 0 : null, cvr: g && r.sessions ? (r.keyEvents || 0) / r.sessions : null,
    vpa: g && r.active ? r.pv / r.active : null,
    imp: s ? r.imp || 0 : null, clicks: s ? r.clicks || 0 : null, ctr: s && r.imp ? r.clicks / r.imp : null, pos: s && r.imp ? r.posW / r.imp : null,
    ...sheetDerive(r),
    ch: r.ch, costs: r.costs || null, approxUsers: !!approxUsers,
  };
}
/** シート由来（月次のみ）の値：収益合計＝加盟店＋アフィリエイト、収支＝収益合計−支出 */
function sheetDerive(r) {
  const n = k => r[k] != null ? r[k] : null;
  const hasRev = r.revPartner != null || r.revAffiliate != null;
  const revenue = hasRev ? (r.revPartner || 0) + (r.revAffiliate || 0) : null;
  return { postsTotal: n('postsTotal'), posts: n('posts'), rewrites: n('rewrites'), lite: n('lite'), tweak: n('tweak'), wpPosts: n('wpPosts'), wpRewrites: n('wpRewrites'), kCalls: n('kCalls'), visits: n('visits'), contracts: n('contracts'),
    revPartner: n('revPartner'), revAffiliate: n('revAffiliate'), revenue, cost: n('cost'),
    profit: hasRev || r.cost != null ? (revenue || 0) - (r.cost || 0) : null,
    unitCost: unitCostOf(r) };
}
/** 1記事あたりの単価＝支出合計÷（新規＋リライト＋簡易リライト）（2026-11-05 ユーザー指定）。記事が0本なら出さない */
function unitCostOf(r) { const n = (Number(r.posts) || 0) + (Number(r.rewrites) || 0) + (Number(r.lite) || 0); return r.cost != null && n > 0 ? r.cost / n : null; }
/** 1記事あたりの単価を出してよい月：翌月5日（前月分の請求・コンテンツ管理表の更新が終わる日）をすぎた月だけ */
const UNIT_COST_FROM = '2025-03';   /* 進行管理に記事の記録がそろったのは2025年3月から（それより前は月0〜3本しか記録がなく、2024/11は ¥1,748,522 のような値になる）（2026-11-05） */
const unitCostReady = ym => ym >= UNIT_COST_FROM && todayJst() >= shiftMonth(ym, 1) + '-05';
function monthVal(id, ym) {
  const ids = id === ALL ? topIds() : [id];
  const o = derive(sumRaw(ids.map(x => (MONTHLY[x] || {})[ym])));
  if (!unitCostReady(ym)) o.unitCost = null;   /* 今月は月の途中で、支出は月の分・記事は途中までなので単価が大きく出る。前月もシート（進行管理など）の更新が終わる翌月5日までは出さない（2026-11-05 ユーザー指摘：異常値が出る） */
  return o;
}
async function loadDaily(from, to) {
  const key = from + '|' + to;
  if (!DAILY_CACHE.has(key)) DAILY_CACHE.set(key, api('/daily?from=' + from + '&to=' + to));
  return DAILY_CACHE.get(key);
}
function dayList(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
function rangeVal(daily, id, from, to) {
  const ids = id === ALL ? topIds() : [id];
  const rows = []; ids.forEach(x => dayList(from, to).forEach(d => rows.push((daily[x] || {})[d])));
  const o = derive(sumRaw(rows), true);
  if (from < UNIT_COST_FROM + '-01') o.unitCost = null;   /* 進行管理の記録がそろう前の日を含む期間は単価を出さない（2026-11-05） */
  return o;
}
function daySeries(daily, id, k, from, to) {
  const ids = id === ALL ? topIds() : [id];
  if (k === 'unitCost') {   /* 1記事あたりの単価は、記事を公開した日にしか出ず線が途切れて跳ねるので、期間の1日目からの累計（累計の支出÷累計の記事数）で描く（2026-11-05 ユーザー指摘：日次・前月比・期間比較があやしい） */
    let cost = 0, n = 0;
    return dayList(from, to).map(d => { if (d > YESTERDAY || d < UNIT_COST_FROM + '-01') return null; const o = derive(sumRaw(ids.map(x => (daily[x] || {})[d]))); cost += Number(o.cost) || 0; n += (Number(o.posts) || 0) + (Number(o.rewrites) || 0) + (Number(o.lite) || 0); return n > 0 && cost > 0 ? cost / n : null; });
  }
  return dayList(from, to).map(d => derive(sumRaw(ids.map(x => (daily[x] || {})[d])))[k]);
}
const ucDayNote = k => k === 'unitCost' ? ' <small>（その期間の1日目からの累計：累計の支出÷累計の記事数）</small>' : '';

// ================= 指標 =================
const noMoney = () => !!me && me.roleEff === 'resta';   // REsta社員は収益と支出を見られない（2026-10-30 ユーザー指定）
const MONEY_KEYS = ['revenue', 'cost', 'profit', 'unitCost'];
let MONEY_ORIG = null;
/** 指標・主要指標・KPI・出典の一覧から収益と支出を外す（REsta社員のとき）。元に戻すときは元の一覧から作り直す */
function applyMoneyFilter() {
  const lists = [[METRICS, x => MONEY_KEYS.includes(x.k)], [KPI_KEYS, k => MONEY_KEYS.includes(k)], [MAIN_KEYS, k => MONEY_KEYS.includes(k)], [ALL_SRC, k => k === '支出'], [AREA_METRICS, a => MONEY_KEYS.includes(a[0])]];
  if (!MONEY_ORIG) MONEY_ORIG = lists.map(([a]) => a.slice());
  lists.forEach(([a, bad], i) => { a.length = 0; MONEY_ORIG[i].filter(x => !(noMoney() && bad(x))).forEach(x => a.push(x)); });
}
const METRICS = [
  { k: 'pv', l: 'PV', src: 'GA4' },
  { k: 'sessions', l: 'セッション', src: 'GA4' },
  { k: 'users', l: 'ユーザー', src: 'GA4', note: '総ユーザー数' },
  { k: 'active', l: 'アクティブユーザー', src: 'GA4' },
  { k: 'newUsers', l: '新規ユーザー', src: 'GA4' },
  { k: 'vpa', l: 'アクティブユーザーあたりのビュー', src: 'GA4', fmt: 'dec2' },
  { k: 'eng', l: '平均エンゲージメント時間', src: 'GA4', unit: '秒' },
  { k: 'cv', l: 'CV（キーイベント）', src: 'GA4' },
  { k: 'cvr', l: 'CV率', src: 'GA4', fmt: 'pct' },
  { k: 'imp', l: '表示回数', src: 'SC' },
  { k: 'clicks', l: 'クリック数', src: 'SC' },
  { k: 'ctr', l: '平均CTR', src: 'SC', fmt: 'pct' },
  { k: 'pos', l: '平均掲載順位', src: 'SC', fmt: 'dec1', lowerBetter: true },
  // ここから下：WordPress・kintone（SEO回線）・ASP・支出。日次・期間比較では支出とアフィリエイトは月の金額を日割り（monthly: 月次のみの指標）
  { k: 'postsTotal', l: '公開記事数（累計）', src: 'WordPress', monthly: true },
  { k: 'posts', l: '新規公開記事数', src: '進行管理', note: '進行管理の制作判断「新規」でアップロード日が入った記事' },
  { k: 'rewrites', l: 'リライト記事数', src: '進行管理', note: '進行管理の制作判断「リライト」' },
  { k: 'lite', l: '簡易リライト記事数', src: '進行管理', note: '進行管理の制作判断「簡易リライト」' },
  { k: 'tweak', l: '微調整', src: 'WordPress', note: 'WordPressで更新された記事 −（リライト＋簡易リライト）' },
  { k: 'kCalls', l: 'コール数', src: 'kintone' },
  { k: 'visits', l: '訪問確定数', src: 'kintone' },
  { k: 'contracts', l: '成約数', src: 'kintone' },
  { k: 'revenue', l: '収益合計(税抜き)', src: 'kintone', srcs: ['kintone', 'ASP'], fmt: 'yen' },
  { k: 'cost', l: '支出合計(税抜き)', src: '支出', fmt: 'yen', lowerBetter: true },
  { k: 'profit', l: '収支合計(税抜き)', note: '収益合計−支出合計', src: '集計', fmt: 'yen' },
  { k: 'unitCost', l: '1記事あたりの単価(税抜き)', note: '支出合計÷（新規＋リライト＋簡易リライト）。シートの更新が終わる翌月5日から出します（それまでは —）。進行管理の記録がそろった2025年3月から', src: '集計', fmt: 'yen', lowerBetter: true },   /* 2026-11-05 ユーザー指定 */
];
const M = Object.fromEntries(METRICS.map(x => [x.k, x]));
const KPI_KEYS = ['pv', 'sessions', 'users', 'vpa', 'cv', 'cvr', 'imp', 'clicks', 'pos', 'postsTotal', 'posts', 'rewrites', 'lite', 'tweak', 'kCalls', 'contracts', 'revenue', 'cost', 'profit', 'unitCost'];
const MAIN_KEYS = ['pv', 'cv', 'cvr', 'clicks', 'pos', 'kCalls', 'contracts', 'revenue', 'cost', 'profit', 'unitCost'];   // 前年比・前月比の主要指標

function fmt(k, v) {
  if (v == null || Number.isNaN(v)) return '—';
  const f = M[k] && M[k].fmt;
  if (f === 'pct') return (v * 100).toFixed(2) + '%';
  if (f === 'dec1') return v.toFixed(1);
  if (f === 'dec2') return v.toFixed(2);
  if (f === 'yen') return (v < 0 ? '−' : '') + '¥' + nf.format(Math.abs(Math.round(v)));
  return nf.format(Math.round(v));
}
// 増減率は「前の値の絶対値」で割る。収支のようにマイナスになる値でも、プラスに近づいたら＋（良くなった）になる（2026-10-14 ユーザー指定）
const rate = (a, b) => (a == null || b == null || !b) ? null : (a - b) / Math.abs(b);
// 比較は「前年比 151.5%」の形（今の値÷比べる値×100）で出す（2026-10-26 ユーザー指定）。100%より上が増加。
// マイナスになる値（収支）は上の rate を使い 100%＋増減率 にするので、プラスに近づけば100%より上になる
const ratioTxt = r => (100 + r * 100).toFixed(1) + '%';
function chipCls(k, r) { const better = M[k] && M[k].lowerBetter ? r < 0 : r > 0; return Math.abs(r) < 0.005 ? 'flat' : better ? 'up' : 'down'; }
function chip(k, cur, prev, label) {
  const r = rate(cur, prev), l = /比$/.test(label) ? label : label + '比';
  if (r === null) return `<span class="chip flat"><span class="k">${l}</span>—</span>`;
  return `<span class="chip ${chipCls(k, r)}"><span class="k">${l}</span>${ratioTxt(r)}</span>`;
}
function rateCell(k, cur, prev) {
  const r = rate(cur, prev);
  if (r === null) return '<td class="num">—</td>';
  return `<td class="num"><span class="chip ${chipCls(k, r)}">${ratioTxt(r)}</span></td>`;
}
function spark(vals) {
  const v = vals.map(x => x == null ? 0 : x);
  if (v.length < 2) return '';
  const w = 160, h = 30, mx = Math.max(...v), mn = Math.min(...v), sp = mx - mn || 1;
  const pts = v.map((x, i) => [i / (v.length - 1) * w, h - 3 - (x - mn) / sp * (h - 6)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L${w} ${h} L0 ${h} Z" fill="var(--card-soft, var(--accent-soft))" stroke="none"/><path d="${d}" fill="none" stroke="var(--card-ink, var(--accent))" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="var(--card-ink, var(--accent))"/></svg>`;
}


// ================= 取得元ラベル =================
const ALL_SRC = ['GA4', 'SC', 'WordPress', 'kintone', '支出'];
const srcOf = k => M[k].srcs || [M[k].src];
const srcBadges = list => [...new Set(list)].map(x => `<span class="sb" data-src="${x}">${x}</span>`).join('');
/** パネル見出し：左にタイトル、右に取得元ラベル（とボタン類） */
const H = (title, sources, extra = '') => `<div class="panel-head"><h2>${title}</h2><div class="srcs">${extra}${srcBadges(sources)}</div></div>`;
/** 機能改善依頼のボタン（BEST正社員・業務委託ディレクターだけ。2026-10-29 ユーザー指定） */
const FB_ROLES = ['employee', 'out_director', 'exec', 'out_ad', 'out_aw'];   /* BEST役員・業務委託アシスタントディレクター・アシスタント兼ライターも（2026-11-06 ユーザー指定） */
const canFeedback = () => !!me && hasCap('feedback_send', () => FB_ROLES.includes(me.roleEff));   /* 権限管理の feedback_send */
/* 画面ごとに1つ、本文のいちばん上（右寄せ）に出す（2026-10-29 ユーザー指定） */
const fbBar = () => canFeedback() ? '<div class="fb-bar"><button type="button" class="fb-btn" data-fb title="この画面について、機能の改善を依頼する">機能改善依頼</button></div>' : '';

// ================= グラフ =================
let charts = [];
function clearCharts() { charts.forEach(c => c.destroy()); charts = []; }
// グラフにカーソルを合わせたときの数字：金額（収益・支出・収支・売上）は小数点なしの円にする（2026-10-26 ユーザー指定）
if (window.Chart) Chart.defaults.plugins.tooltip.callbacks.label = ctx => {
  const p = ctx.parsed || {}, v = ctx.chart.options.indexAxis === 'y' ? p.x : p.y, l = ctx.dataset.label || '';
  const yt = ((ctx.chart.options.scales || {}).y || {}).ticks || {};
  const money = typeof v === 'number' && (/収益|支出|収支|売上|金額|円|¥/.test(l) || !!(yt.callback && yt.callback.money));
  return (l ? l + ': ' : '') + (money ? (v < 0 ? '−' : '') + '¥' + nf.format(Math.round(Math.abs(v))) : ctx.formattedValue);
};
function baseOpts(extra = {}) {
  const fg = css('--muted'), grid = css('--grid');
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: fg, boxWidth: 10, boxHeight: 10, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: fg, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { color: grid } },
      y: { ticks: { color: fg, font: { size: 11 } }, grid: { color: grid }, beginAtZero: true },
    },
  }, extra);
}
/* マイナスがあるグラフは、¥0（0）の位置に基準の線を太く入れる（2026-11-09 ユーザー指定：シミュレーションの推移の想定収支） */
function zeroLine(cfg) {
  const sc = cfg && cfg.options && cfg.options.scales; if (!sc) return;
  Object.keys(sc).filter(k => k[0] === 'y').forEach(k => { const y = sc[k], g = y.grid = y.grid || {}; if (g.display === false || typeof g.color === 'function') return;
    const base = g.color || css('--grid'), on = c => !!c.tick && c.tick.value === 0 && c.scale.min < 0;
    g.color = c => on(c) ? css('--fg') : base; g.lineWidth = c => on(c) ? 2 : 1; });
}
function chart(id, cfg) { const el = $(id); if (!el || !window.Chart) return; const old = Chart.getChart(el); if (old) old.destroy(); zeroLine(cfg); charts.push(new Chart(el, cfg)); }   /* 同じグラフ枠にもう描いてあれば消してから描く（すばやく切り替えたときの「Canvas is already in use」。2026-11-06 巡回で見つかった） */
const yTicks = k => ({ color: css('--muted'), callback: v => M[k] && M[k].fmt === 'pct' ? (v * 100).toFixed(1) + '%' : nf.format(v) });
const yenTick = Object.assign(v => '¥' + nf.format(Math.round(v)), { money: true });   // 金額の軸（ツールチップも円で出す目印）
const yAxis = k => ({ ticks: M[k] && M[k].fmt === 'yen' ? { color: css('--muted'), callback: yenTick } : yTicks(k), grid: { color: css('--grid') }, reverse: k === 'pos', beginAtZero: k !== 'pos' });   /* 上下を逆にするのは掲載順位だけ（支出・1記事あたりの単価は小さいほうがよいが、金額なので0からふつうの向き。2026-11-05 ユーザー指摘：グラフがおかしい） */
const stackScales = () => ({ x: { stacked: true, ticks: { color: css('--muted'), font: { size: 11 } }, grid: { display: false } }, y: { stacked: true, ticks: { color: css('--muted') }, grid: { color: css('--grid') } } });

// ================= 状態 =================
const state = { dash: 'media', view: 'summary', media: ALL, mode: 'single', metric: 'pv', areaMetric: 'sessions',
  ymMonth: LAST_FULL, dailyFrom: addDays(YESTERDAY, -29), dailyTo: YESTERDAY,
  aFrom: LAST_FULL + '-01', aTo: monthEnd(LAST_FULL), bFrom: shiftMonth(LAST_FULL, -1) + '-01', bTo: monthEnd(shiftMonth(LAST_FULL, -1)) };
try { Object.assign(state, JSON.parse(localStorage.getItem('bm-ui') || '{}')); } catch (e) { /* 保存なしで表示 */ }
const save = () => { try { localStorage.setItem('bm-ui', JSON.stringify({ dash: state.dash, view: state.view === 'outline' ? 'am-progress' : state.view,media: state.media, mode: state.mode, metric: state.metric, artMedia: state.artMedia })); } catch (e) { /* 保存できなくても続ける */ } };
const isAdmin = () => me && me.perms && me.perms.media === 'admin';
let REAL_ME = null, ROLE_DEF = null;   // ログインしている本人（UI確認中も変わらない）と、権限管理の設定
const realAdmin = () => !!REAL_ME && REAL_ME.perms && REAL_ME.perms.media === 'admin';
const ROLE_LABELS = { admin: '管理者', exec: 'BEST役員', employee: 'BEST正社員', contract: 'BEST契約社員', parttime: 'BESTアルバイト', out_director: '業務委託ディレクター', out_ad: '業務委託アシスタントディレクター', out_aw: '業務委託アシスタント兼ライター', out_writer: '業務委託ライター', supervisor: '監修者', free_writer: '契約外ライター', finance: 'BEST経理部', resta: 'REsta社員' };
const roleLabel = r => ROLE_LABELS[r] || r || '—';
/** 役割の操作権限から、画面で使う権限を作る（サーバーと同じ考え方） */
function permsOfRole(role, caps) {
  const has = k => role === 'admin' || caps.includes(k);
  return { media: role === 'admin' ? 'admin' : has('media_view') ? 'viewer' : 'none',
    articles: role === 'admin' ? 'admin' : has('articles_settings') ? 'admin' : has('articles_edit') || caps.includes('articles_own') ? 'editor' : has('articles_view') ? 'viewer' : 'none',
    revenue: role === 'admin' ? 'admin' : has('revenue_view') ? 'viewer' : 'none', rewards: has('rewards_view') ? 'viewer' : 'none', bulk: has('articles_bulk'), own: role !== 'admin' && caps.includes('articles_own'),
    adminMenus: ['admin_users', 'admin_roles', 'admin_logs', 'admin_media', 'admin_contracts', 'admin_expenses', 'admin_staff', 'admin_targets', 'admin_api', 'admin_jobs', 'admin_system'].filter(has) };
}
/** 権限管理の項目を持っているか（2026-11-06：あとから足した機能も権限管理で切り替え）。役割がない人（これまでの個別の権限）は fb（足す前の判定） */
const hasCap = (k, fb) => isAdmin() || (!!me && Array.isArray(me.caps) ? me.caps.includes(k) : !!(fb && fb()));
const hasAnyPerm = u => !!u && !!u.perms && ['media', 'articles', 'revenue', 'rewards'].some(k => u.perms[k] && u.perms[k] !== 'none');
/** その人が使えるダッシュボード */
const allowedDashes = () => ['media', 'articles', 'rewards', 'expenses', 'revenue', 'goals', 'ai'].filter(d => d === 'ai' ? hasCap('ai_tools', () => false) && me.perms.media !== 'none' && !noMoney() : d === 'expenses' ? hasCap('expenses_view', () => ['exec', 'employee'].includes(me.roleEff)) : d === 'goals' ? !!MY_STAFF && hasCap('goals_view', () => !noMoney() && me.roleEff !== 'finance') : d === 'media' ? me.perms.media !== 'none' : d === 'articles' ? (me.perms.articles || 'viewer') !== 'none' : d === 'rewards' ? (isAdmin() || me.perms.rewards === 'viewer' || isOutUser()) : (isAdmin() || (me.perms.revenue && me.perms.revenue !== 'none')));   /* REsta社員・BEST経理部は目標・工数を出さない（2026-10-30 ユーザー指定） */
// 管理メニューの画面 → 必要な権限
const ADMIN_VIEW_CAP = { users: 'admin_users', roles: 'admin_roles', logs: 'admin_logs', media: 'admin_media', contracts: 'admin_contracts', subs: 'admin_expenses', expenses: 'admin_expenses', staff: 'admin_staff', resta: 'admin_staff', unitassign: 'admin_staff', aiaccess: 'admin_api', people: 'admin_staff', targets: 'admin_targets', api: 'admin_api', jobs: 'admin_jobs' };
const canAdminView = id => id === 'system' ? hasCap('admin_system', () => !(me && me.roleEff === 'finance')) : id === 'expenses' && me && ['exec', 'employee'].includes(me.roleEff) ? true : isAdmin() ||   /* システム構造はBEST経理部には出さない（2026-10-30 ユーザー指定） */
   (!!me && !!me.perms && (me.perms.adminMenus || []).includes(ADMIN_VIEW_CAP[id]));
const canBulk = () => isAdmin() || !!(me && me.perms && me.perms.bulk);
/** UI確認：役割を選ぶとその役割の画面、人を選ぶとその人の画面で表示する（保存はできない。人ごとは 2026-10-28 ユーザー指定） */
let PREVIEW_UID = null, PREVIEW_USERS = [];
async function setPreview(val) {
  const uid = val && val.startsWith('u:') ? val.slice(2) : '', role = uid ? '' : val;
  const wasPerson = !!PREVIEW_UID;
  PREVIEW_UID = null;
  if (!val) me = REAL_ME;
  else if (role) {
    if (!ROLE_DEF) ROLE_DEF = await api('/admin/roles');
    const caps = ROLE_DEF.matrix[role] || [];
    me = Object.assign({}, REAL_ME, { perms: permsOfRole(role, caps), roleEff: role, caps, _preview: role });
  } else {
    PREVIEW_UID = uid;
    try { me = Object.assign(await api('/me'), { _preview: val }); } catch (e) { PREVIEW_UID = null; me = REAL_ME; $('ui-preview-select').value = ''; alert(e.message); }
  }
  applyMoneyFilter();
  // 人ごとの確認の出入りでは、読み込んだデータ（見られるメディア・記事・社員の情報）を読み直す
  if (wasPerson || PREVIEW_UID) {
    ARTICLES = null; ITEMS = null; CONTRACTS = null; SEO = null; PERSON_NAMES = null; STAFF_NAMES = null;
    SIM_ACH = null; SIM_STAFF = null; SIM_REFRATES = null; SIM_BASE = null; SIM_PRED = null;   /* 達成済み・人件費の合計・前提（見られるメディア）は人によって違う。UI確認のあとに管理者の画面でメディアが1つしか出なくなっていた（2026-11-06） */
    try {
      const [meta, monthly, st] = await Promise.all([api('/meta'), me.perms.media !== 'none' ? api('/monthly') : Promise.resolve({}), api('/staff/me').catch(() => ({}))]);
      META = meta; MONTHLY = monthly; MY_STAFF = st.staff || null;
      const ms = new Set(); Object.values(MONTHLY).forEach(o => Object.keys(o).forEach(m => ms.add(m))); MONTHS = [...ms].sort();
      renderMediaSelect();
    } catch (e) { /* 表示できる範囲で続ける */ }
  }
  const ok = allowedDashes();
  if (!ok.includes(state.dash)) state.dash = ok[0] || 'articles';
  state.view = dashViews()[0] ? dashViews()[0].id : state.view;
  const b = $('preview-banner');
  b.hidden = !val;
  if (val) {
    b.innerHTML = '<b>UI確認中：' + esc(PREVIEW_UID ? me.name + ' さん（' + roleLabel(me.roleEff || me.role) + '）' : roleLabel(role)) + '</b> の画面です。保存などの操作はできません。' + (!PREVIEW_UID && me.perms.own ? '（実際は自分が担当の記事だけが表示されます）' : '') + ' <button class="btn sm" type="button" id="preview-end">確認を終わる</button>';
    $('preview-end').onclick = () => { $('ui-preview-select').value = ''; setPreview(''); };
  }
  render();
}

const ICO = {
  'ex-list': 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', 'ex-staff': 'M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0', 'ex-site': 'M3 5h18v12H3zM8 21h8M12 17v4', 'ex-outsource': 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', 'ex-press': 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5', 'ex-tool': 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z', 'ex-ai': 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  summary: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z', monthly: 'M4 20V10M10 20V4M16 20v-8M22 20H2', daily: 'M3 17l5-6 4 3 5-7 4 4M3 21h18',
  sim: 'M3 20h18M5 16l4-5 4 3 6-8M17 6h2v2', 'ai-sim': 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z', simcmp: 'M4 20V10M10 20V4M16 20v-8M22 20H2M3 6l4-2',
  yoy: 'M4 12h16M4 6h10M4 18h7M18 4l3 3-3 3', mom: 'M5 12h14M12 5l7 7-7 7', range: 'M3 5h8v14H3zM13 5h8v14h-8z',
  area: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  articles: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5', artlist: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', 'am-list': 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', 'am-monthly': 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M8 13h3M8 16h6', 'am-press': 'M4 5h16v14H4zM8 9h8M8 13h5', 'am-concept': 'M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3zM9.5 20h5', 'am-progress': 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 'am-settings': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z', 'am-status': 'M4 20V10M10 20V4M16 20v-8M22 20H2', contracts: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h4M15 16l1.5 1.5L19 15', 'rw-active': 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', 'rv-monthly': 'M4 20V10M10 20V4M16 20v-8M22 20H2', 'rv-daily': 'M3 17l5-6 4 3 5-7 4 4M3 21h18', 'rv-yoy': 'M4 12h16M4 6h10M4 18h7M18 4l3 3-3 3', 'rv-range': 'M3 5h8v14H3zM13 5h8v14h-8z', 'rv-kintone': 'M4 4h16v16H4zM4 10h16M10 10v10', 'rv-area': 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'rv-moshimo': 'M4 17l5-5 4 4 7-8M15 8h5v5', kw: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5', plan: 'M4 4h16v16H4zM8 15l3-3 2 2 4-5',
  users: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c1-4 4-6 8-6s7 2 8 6', subs: 'M4 7h16v12H4zM8 3v4M16 3v4M4 11h16', logs: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  media: 'M4 6h16M4 12h16M4 18h10M18 16v6M15 19h6', targets: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', api: 'M9 7L4 12l5 5M15 7l5 5-5 5', jobs: 'M12 6v6l4 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
};
const VIEWS = [
  { id: 'summary', l: 'サマリ' }, { id: 'monthly', l: '月次' }, { id: 'daily', l: '日次' }, { id: 'yoy', l: '前年比' }, { id: 'mom', l: '前月比' },
  { id: 'range', l: '期間比較' }, { id: 'area', l: 'エリア' }, { id: 'sim', l: 'シミュレーション', tag: 'AI' }, { id: 'simcmp', l: 'シミュレーション比較' },   /* プランニング比はシミュレーション比較に入れ替え（2026-11-05 ユーザー指定） */   /* 2026-11-05 ユーザー指定 */   // 記事進捗・記事一覧・KW追従はコンテンツ作成へ（2026-10-27 ユーザー指定）
];
const ALL_ADMIN_IDS = ['tasks', 'staff', 'resta', 'unitassign', 'aiaccess'];   // REsta社員管理（2026-10-30 ユーザー指定）   // タスク通知（2026-10-29 ユーザー指定）   // 全体管理（BEST MEDIA とくらしのレスキューの両方に関わる）
const ADMIN_VIEWS = [{ id: 'users', l: 'ユーザー管理' }, { id: 'roles', l: '権限管理' }, { id: 'media', l: 'メディア管理' }, { id: 'contracts', l: '契約管理' }, { id: 'subs', l: '支出管理' }, { id: 'tasks', l: 'タスク通知' }, { id: 'staff', l: 'BEST社員管理' }, { id: 'resta', l: 'REsta社員管理' }, { id: 'unitassign', l: 'メディア担当管理' }, { id: 'aiaccess', l: 'AIからのアクセス' }, { id: 'people', l: '担当者の紐づけ' }, { id: 'targets', l: '記事目標設定' }, { id: 'api', l: 'API・連携設定' }, { id: 'system', l: 'システム構造' }, { id: 'jobs', l: '収集ジョブ' }, { id: 'logs', l: 'アクセスログ' }];
ICO.resta = ICO.staff;
ICO.tasks = 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0';   // ベル（タスク通知）
ICO.aiaccess = 'M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6zM9 12l2 2 4-4';   // 盾（AIからのアクセス）
ICO.system = 'M4 4h6v6H4zM14 4h6v6h-6zM9 14h6v6H9zM7 10v2h10v-2M12 12v2';
ICO.expenses = 'M3 6h18v12H3zM3 10h18M7 15h3';
ICO.staff = 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c.7-3 3-5 6-5s5.3 2 6 5M17 11a2.5 2.5 0 1 0 0-5M21 19c-.4-2-1.7-3.4-3.5-4';
ICO.roles = 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6zM9 12l2 2 4-4';
const ARTICLE_VIEWS = [{ id: 'am-status', l: '制作状況' }, { id: 'am-progress', l: 'コンテンツ進行管理' }, { id: 'am-press', l: 'プレスリリース進行管理' }, { id: 'am-monthly', l: '月次進行管理' }, { id: 'am-concept', l: 'コンセプト' }, { id: 'kw', l: 'KW追従' }, { id: 'am-settings', l: 'カテゴリ・タグ・ブロック' }];   // 制作状況＝記事進捗＋制作状況＋記事一覧（2026-10-27 ユーザー指定）
const CONTENT_NUM_VIEWS = ['articles', 'artlist', 'kw', 'am-status'];   // メディア数値から移した画面（右上のメディアは state.media を使う）
/** 支出管理（ダッシュボード）：支出一覧は管理者・BEST役員・BEST社員、ほかは管理者だけ（2026-11-02 ユーザー指定） */
const EXPENSE_VIEWS = [{ id: 'ex-list', l: '支出一覧' }, { id: 'ex-staff', l: 'BEST人件費' }, { id: 'ex-site', l: 'サイト制作・修正費' }, { id: 'ex-outsource', l: '業務委託費' }, { id: 'ex-press', l: 'プレスリリース費' }, { id: 'ex-tool', l: 'ツール利用費' }];   /* AI利用費はツール利用費にまとめた（2026-11-02 ユーザー指定） */
const isBestStaffMe = () => isAdmin() || (!!me && ['exec', 'employee', 'contract', 'parttime'].includes(me.roleEff));
const EXP_STAFF_TABS = ['site', 'outsource', 'press', 'tool'];   /* BEST社員にも表示・入力（2026-11-05 ユーザー指定） */
const expStaffMe = () => hasCap('expenses_view', isBestStaffMe);   /* 支出情報の権限（権限管理の expenses_view） */
const expFull = () => typeof state !== 'undefined' && state.dash === 'expenses' && !isAdmin() && expStaffMe();
const expenseViews = () => EXPENSE_VIEWS.filter(v => v.id === 'ex-list' || isAdmin() || (expStaffMe() && EXP_STAFF_TABS.includes(v.id.slice(3))));
const REWARD_VIEWS = [{ id: 'rw-active', l: '報酬管理一覧' }, { id: 'rw-mine', l: '担当者一覧' }, { id: 'rw-preview', l: '操作画面確認' }, { id: 'rw-me', l: '報酬' }, { id: 'rw-batch', l: '請求の取りまとめ' }, { id: 'rw-finance', l: '経理部確認' }, { id: 'rw-check', l: '報酬額の確認' }];   // 請求の取りまとめ（管理者）・経理部確認（経理部と管理者）（2026-10-29 ユーザー指定）   // 業務委託は「報酬」だけ、BEST社員は契約者一覧・操作画面確認（2026-10-28 ユーザー指定）
const OUT_ROLES = ['out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'];
const isOutUser = () => !!me && OUT_ROLES.includes(me.roleEff);
const rewardViews = () => REWARD_VIEWS.filter(v => me && me.roleEff === 'finance' ? v.id === 'rw-finance' : isOutUser() ? v.id === 'rw-me' : v.id === 'rw-preview' || v.id === (isAdmin() ? 'rw-active' : 'rw-mine') || (isAdmin() && ['rw-batch', 'rw-finance', 'rw-check'].includes(v.id)));
/** 管理者でない BEST社員が見られる業務委託：自分が請求担当の人だけ */
const billRole = c => !MY_STAFF || MY_STAFF.contractor ? '' : c.billingStaffId === MY_STAFF.id ? 'メイン' : c.billingSubStaffId === MY_STAFF.id ? 'サブ' : '';   // 自分が請求担当のメインかサブか
const myBilling = c => isAdmin() || !!billRole(c);
const REVENUE_VIEWS = [{ id: 'rv-monthly', l: '月次' }, { id: 'rv-range', l: '期間比較' }, { id: 'rv-kintone', l: 'kintone' }, { id: 'rv-moshimo', l: 'もしもアフィリエイト' }];   // 月次・期間比較＝kintone＋アフィリエイトの合計、kintone の中で月次〜エリアを切り替え（2026-10-14 ユーザー指定）
const icon = id => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICO[id] || ICO.summary}"/></svg>`;

const canEditArticles = () => !!me && me.status === 'active' && (me.perms.media === 'admin' || ['admin', 'editor'].includes(me.perms.articles));
const MEDIA_DASHES = ['articles', 'rewards', 'revenue'];   // 右上でメディアを選ぶダッシュボード
const ADMIN_MEDIA_VIEWS = ['contracts', 'expenses', 'staff'];   // 管理メニューで右上のメディア（メディア累計あり）を使う画面（2026-10-14 ユーザー指定）
const adminMedia = () => state.adminMedia || ALL;
const dashViews = () => state.dash === 'ai' ? AI_VIEWS.filter(v => v.id !== 'ai-errcheck' || hasCap('ai_errcheck', () => false)) : state.dash === 'expenses' ? expenseViews() : state.dash === 'goals' ? WORK_VIEWS : state.dash === 'rewards' ? rewardViews() : state.dash === 'revenue' ? REVENUE_VIEWS : state.dash === 'articles' ? ARTICLE_VIEWS.filter(v => isWriterOnly() ? v.id === 'am-monthly' : (v.id !== 'am-progress' || canEditArticles()) && (v.id !== 'am-press' || canSeePress()) && (v.id !== 'am-monthly' || canEditArticles()) && (v.id !== 'am-settings' || isAdminArticles()) && (v.id !== 'am-concept' || canConcept())) : VIEWS.filter(v => !['sim', 'simcmp'].includes(v.id) || hasCap('sim_view', () => !noMoney()));   /* REsta社員はシミュレーションの予測を見る権限がないので、タブを出さない（2026-11-06 ユーザー指定：見る権限がないタブは非表示） */
const ADMIN_GROUPS = { users: ['users', 'roles'], media: ['media', 'targets', 'people'] };
const groupOf = id => Object.keys(ADMIN_GROUPS).find(g => ADMIN_GROUPS[g].includes(id));
/** まとめた管理メニューの中のタブ（見られるものだけ） */
function adminTabsHtml(id) {
  const g = groupOf(id); if (!g) return '';
  const ok = ADMIN_GROUPS[g].filter(canAdminView); if (ok.length < 2) return '';
  return '<div class="seg admin-tabs" role="tablist">' + ok.map(v => '<button type="button" data-admintab="' + v + '" aria-pressed="' + (v === id) + '">' + esc(ADMIN_VIEWS.find(x => x.id === v).l) + '</button>').join('') + '</div>';
}
function renderNav() {
  const item = v => `<li><button type="button" data-view="${v.id}" ${state.view === v.id ? 'aria-current="page"' : ''}>${icon(v.id)}<span>${v.l}</span>${v.tag ? `<span class="tag">${v.tag}</span>` : ''}</button></li>`;
  $('nav-analysis').innerHTML = dashViews().map(item).join('');
  // 管理は「BEST MEDIA管理」と「全体管理」（くらしのレスキューにも関わるもの）に分ける（2026-10-27 ユーザー指定）
  // まとめたメニューは親だけ出す（押すと見られる最初のタブ）
  const navOf = v => { const g = ADMIN_GROUPS[v.id]; if (!g) return groupOf(v.id) ? null : canAdminView(v.id) ? v : null; const ok = g.filter(canAdminView); return ok.length ? { id: ok[0], l: v.l, grp: v.id } : null; };
  const gItem = v => `<li><button type="button" data-view="${v.id}" ${(v.grp ? groupOf(state.view) === v.grp : state.view === v.id) ? 'aria-current="page"' : ''}>${icon(v.grp || v.id)}<span>${v.l}</span></button></li>`;
  const bm = ADMIN_VIEWS.filter(v => !ALL_ADMIN_IDS.includes(v.id)).map(navOf).filter(Boolean), al = ADMIN_VIEWS.filter(v => ALL_ADMIN_IDS.includes(v.id) && canAdminView(v.id));
  $('nav-admin').innerHTML = bm.map(gItem).join(''); $('nav-admin-wrap').hidden = !bm.length;
  $('nav-admin-all').innerHTML = al.map(item).join(''); $('nav-admin-all-wrap').hidden = !al.length;
  // 未対応の請求：報酬管理（ダッシュボードの選択）と担当者一覧・契約者一覧に赤い件数（2026-10-29 ユーザー指定）
  { const n = INV_PENDING.length, o = [...$('dash-select').options].find(x => x.value === 'rewards'); if (o) o.textContent = '報酬管理' + (n ? '（要対応 ' + n + '）' : '');
    ['rw-mine', 'rw-active'].forEach(id => { const b = document.querySelector('#nav-analysis [data-view="' + id + '"]'); if (b && n) { b.classList.add('nav-alert'); b.insertAdjacentHTML('beforeend', '<span class="nav-badge">' + n + '</span>'); } }); }
  const tb = document.querySelector('#nav-admin-all [data-view="tasks"]'); if (tb) { tb.classList.toggle('nav-alert', TASK_COUNT > 0); if (TASK_COUNT > 0) tb.insertAdjacentHTML('beforeend', '<span class="nav-badge">' + TASK_COUNT + '</span>'); }
  const okDash = allowedDashes();
  [...$('dash-select').options].forEach(o => { o.hidden = !okDash.includes(o.value); });
  if (state.dash === 'contracts' || !okDash.includes(state.dash)) state.dash = okDash[0] || 'articles';
  $('ui-preview').hidden = !realAdmin();
  $('dash-select').value = state.dash;
}
function renderMediaSelect() {
  const sel = $('media-select');
  let h = `<option value="${ALL}">メディア累計（${topIds().length}メディア）</option>`;
  META.media.forEach(m => { h += `<option value="${esc(m.id)}">${m.block ? (m.group ? '　└ ' : '　　・') + esc(m.name) : esc(m.name)}</option>`; });
  sel.innerHTML = h;
  if (state.media !== ALL && !ent(state.media)) state.media = ALL;
  sel.value = state.media;
}

// ================= 共通パーツ =================
function metricSelect(keys, dailyOnly) {
  const list = (keys ? METRICS.filter(x => keys.includes(x.k)) : METRICS).filter(x => !(dailyOnly && x.monthly));
  if (!list.find(x => x.k === state.metric)) state.metric = list[0].k;
  return `<label class="field">指標<select id="metric-sel">${list.map(x => `<option value="${x.k}" ${x.k === state.metric ? 'selected' : ''}>${x.l}（${srcOf(x.k).join('・')}）</option>`).join('')}</select></label>`;
}
function bindMetric() { const el = $('metric-sel'); if (el) el.onchange = () => { state.metric = el.value; render(); }; }
function monthPicker(minIndex = 0) {
  const opts = MONTHS.slice(minIndex).filter(m => m <= LAST_FULL).reverse();
  if (!opts.includes(state.ymMonth)) state.ymMonth = opts[0];
  return `<label class="field">対象月<select id="ym-sel">${opts.map(mm => `<option value="${mm}" ${mm === state.ymMonth ? 'selected' : ''}>${mLabel(mm)}</option>`).join('')}</select></label>`;
}
function bindMonthPicker() { const el = $('ym-sel'); if (el) el.onchange = () => { state.ymMonth = el.value; render(); }; }
const last13 = () => MONTHS.filter(m => m <= LAST_FULL).slice(-13);
const pendingNote = '<span class="pill off">データなし</span>';
const scNote = id => id !== ALL && ent(id) && ent(id).block ? '<p class="note">ディレクトリのSearch Consoleは、ページURLにディレクトリのパスを含むページの値です。</p>' : '';

// ================= サマリ =================
// 構成：期間別の進捗（今月・BEST半期・年間累計、前期比・昨対比）→ 当月の進捗値 → 前月の確定値 → 過去12か月の推移
// 「その他」は表示しない。代わりに「BEST人件費」「ツール利用」（今は空）（2026-10-14 ユーザー指定）
const COST_LABELS = { cost_staff: 'BEST人件費', cost_tool: 'ツール利用費', cost_site: 'サイト制作・修正', cost_article: '業務委託費', cost_press: 'プレスリリース費', cost_ai: 'ツール利用費' };   /* AI費はツール利用費にまとめる（2026-11-13 ユーザー指定） */   // 区分の名前（2026-10-29 ユーザー指定。業務委託費＝コンテンツ制作。キーは以前のまま）   // AI活用費（2026-10-29 ユーザー指定）
// サマリでは、ディレクション費も業務委託費に含める。プレスリリース費は別の区分（2026-10-29 ユーザー指定）
const COST_GROUP = { cost_direction: 'cost_article' };
const mNum = ym => Number(ym.slice(5)) + '月';

/** 期間の値：まるごとの月は月次の値、最後の月が途中（endDay 日まで）なら日次の値を足す。今月は月次の値がそのまま昨日までの値 */
async function spanVal(id, startYm, endYm, endDay) {
  if (endYm < startYm) return derive(sumRaw([]));
  const ids = id === ALL ? topIds() : [id], months = monthsFrom(startYm, endYm);
  const partial = endDay != null && endYm !== CUR_MONTH;
  const raws = [];
  ids.forEach(x => (partial ? months.slice(0, -1) : months).forEach(m => raws.push((MONTHLY[x] || {})[m])));
  if (partial && endDay > 0) {
    const to = endYm + '-' + String(Math.min(endDay, daysIn(endYm))).padStart(2, '0');
    const daily = await loadDaily(endYm + '-01', to);
    ids.forEach(x => dayList(endYm + '-01', to).forEach(d => raws.push((daily[x] || {})[d])));
  }
  return derive(sumRaw(raws), true);
}
/** 複数の月をまとめた値 */
function periodVal(id, months) {
  const ids = id === ALL ? topIds() : [id], raws = [];
  ids.forEach(x => months.forEach(m => raws.push((MONTHLY[x] || {})[m])));
  return derive(sumRaw(raws));
}
/** 収益（加盟店・アフィリエイト）と支出（項目別）、収支。la/lp/ly は列の見出し */
function moneyTable(a, p, y, la, lp, ly, rp, ry) {
  const costOf = (t, k) => { if (!t.costs) return null; let v = null; Object.entries(t.costs).forEach(([c, x]) => { if ((COST_GROUP[c] || c) === k && x != null) v = (v || 0) + x; }); return v; };
  const line = (label, k, get, cls) => { const c = get(a), pv = get(p), yv = get(y);
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + label + '</td><td class="num">' + fmt(k, c) + '</td><td class="num' + (k === 'profit' && lp === '想定' ? ' ' + pmCls(pv) : '') + '">' + fmt(k, pv) + '</td>' + rateCell(k, c, pv) + '<td class="num">' + fmt(k, yv) + '</td>' + rateCell(k, c, yv) + '</tr>'; };
  const costKeys = Object.keys(COST_LABELS).concat([...new Set([a, p, y].flatMap(t => Object.keys(t.costs || {})).map(k => COST_GROUP[k] || k))].filter(k => !COST_LABELS[k]));
  return '<div class="table-wrap"><table><thead><tr><th>項目</th><th class="num">' + la + '</th><th class="num">' + lp + '</th><th class="num">' + (rp || '前月比') + '</th><th class="num">' + ly + '</th><th class="num">' + (ry || '前年比') + '</th></tr></thead><tbody>'
    + '<tr class="calc"><td colspan="6"><b>収益(税抜き)</b></td></tr>'
    + line('　加盟店 <span class="note">kintone・SEO回線</span>', 'revenue', t => t.revPartner) + line('　アフィリエイト <span class="note">ASP</span>', 'revenue', t => t.revAffiliate)
    + line('<b>収益合計(税抜き)</b>', 'revenue', t => t.revenue, 'total')
    + '<tr class="calc"><td colspan="6"><b>支出(税抜き)</b></td></tr>'
    + costKeys.map(k => line('　' + esc(COST_LABELS[k] || k), 'cost', t => costOf(t, k))).join('')
    + line('<b>支出合計(税抜き)</b>', 'cost', t => t.cost, 'total')
    + line('<b>収支合計(税抜き)</b>', 'profit', t => t.profit, 'total')
    + line('1記事あたりの単価 <span class="note">支出合計÷（新規＋リライト＋簡易リライト）</span>', 'unitCost', t => t.unitCost)   /* 2026-11-05 ユーザー指定 */
    + '</tbody></table></div>';
}
/** KPIカード（chips は比較の2つ、series は小さなグラフ） */
function kpiCards(a, p, y, lp, ly, series) {
  return KPI_KEYS.filter(k => !(noMoney() && MONEY_KEYS.includes(k))).map(k => '<div class="kpi" data-src="' + M[k].src + '"><div class="lbl"><span title="' + M[k].l + '">' + M[k].l + '</span><span class="srcs">' + srcBadges(srcOf(k)) + '</span></div>'
    + '<div class="val">' + fmt(k, a[k]) + (M[k].unit && a[k] != null ? '<small>' + M[k].unit + '</small>' : '') + '</div>'
    + '<div class="chips">' + (a[k] == null ? pendingNote : chip(k, a[k], p[k], lp) + chip(k, a[k], y[k], ly)) + '</div>' + (a[k] == null ? '' : spark(series(k))) + '</div>').join('');
}
/** 記事進捗（ある月の実績／目標） */
function monthArticleBlock(id, ym) {
  return ART_TYPES.map(([k, l]) => { const a = actualOf(id, ym, k), t = targetOf(id, ym, k), r = t ? (a || 0) / t : null;
    return '<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px"><div class="row" style="justify-content:space-between"><span>' + l + '</span><span class="num">' + (a ?? '—') + (t ? ' / ' + t + '本（' + Math.round(r * 100) + '%）' : '本<span class="note">（目標未設定）</span>') + '</span></div>'
      + (t ? '<div class="progress"><span class="' + (r >= 1 ? 'over' : 'under') + '" style="width:' + Math.min(r, 1) * 100 + '%"></span></div>' : '') + '</div>'; }).join('')
    + '<p class="note" style="margin:8px 0 0">' + mLabel(ym) + 'の公開（新規）・更新（リライト）の本数。緑は目標達成、黄は未達。</p>';
}

function viewSummary() {
  const id = state.media, cur = LAST_FULL, prev = shiftMonth(cur, -1), ly = shiftMonth(cur, -12);
  if (state.mode === 'compare') return summaryCompare(cur, prev, ly);
  const D = dayDone(), now = CUR_MONTH, curEnd = D ? now : LAST_FULL;
  const h = halfOf(now), fy = fyOf(now), fm = fyMonths(fy), fmUntil = m => fm.filter(x => x <= m);
  const yd = YESTERDAY.slice(5).replace('-', '/');
  const L12 = monthsFrom(shiftMonth(cur, -11), cur), L12now = monthsFrom(shiftMonth(now, -11), now);   // 過去12か月（確定分）／今月までの12か月
  const html = '<section class="panel" id="sum-periods">' + H('期間別の進捗 <small>' + esc(mediaName(id)) + '</small>', noMoney() ? ['GA4', 'SC', 'WordPress', 'kintone'] : ['GA4', 'SC', 'WordPress', 'kintone', 'ASP', '支出']) + '<p class="loading">読み込み中…</p></section>' + scNote(id)
    // 当月の進捗値
    + '<h3 class="am-h sum-h">' + mNum(now) + 'の進捗値 <span class="note">' + mLabel(now) + '・1日〜' + yd + '（昨日まで）・前月同期／前年同期と比較</span></h3>'
    + '<section class="kpis wide" id="sum-now"><p class="loading">読み込み中…</p></section>'
    + '<section class="grid2"><div class="panel" id="sum-now-art">' + H('記事進捗 <small>' + mLabel(now) + '・' + yd + 'まで</small>', ['WordPress'], '<button class="linkbtn" type="button" data-goto="articles">記事進捗を開く →</button>') + '<p class="loading">読み込み中…</p></div>'
    + (noMoney() ? '' : '<div class="panel" id="sum-now-money">' + H('収益と支出の内訳 <small>' + mLabel(now) + '・' + yd + 'まで</small>', ['kintone', 'ASP', '支出']) + '<p class="loading">読み込み中…</p></div>') + '</section>'
    // 前月の確定値
    + '<h3 class="am-h sum-h">' + mNum(cur) + 'の確定値 <span class="note">' + mLabel(cur) + '・前月／前年と比較・カードの小さなグラフは過去12か月（' + mLabel(L12[0]) + '〜' + mLabel(cur) + '）の推移</span></h3>'
    + '<section class="kpis wide">' + kpiCards(monthVal(id, cur), monthVal(id, prev), monthVal(id, ly), '前月', '前年', k => L12.map(m => monthVal(id, m)[k])) + '</section>'
    + '<section class="grid2"><div class="panel" id="sum-last-art">' + H('記事進捗 <small>' + mLabel(cur) + '</small>', ['WordPress']) + '<p class="loading">読み込み中…</p></div>'
    + (noMoney() ? '' : '<div class="panel">' + H('収益と支出の内訳 <small>' + mLabel(cur) + '（確定値）</small>', ['kintone', 'ASP', '支出']) + moneyTable(monthVal(id, cur), monthVal(id, prev), monthVal(id, ly), mLabel(cur), mLabel(prev), mLabel(ly)) + '</div>') + '</section>'
    // 年間推移
    + '<h3 class="am-h sum-h">過去12か月の推移 <span class="note">' + mLabel(L12[0]) + '〜' + mLabel(cur) + '（確定した月）</span></h3>'
    + '<section class="grid2"><div class="panel">' + H('PV・セッション <small>過去12か月・月別</small>', ['GA4']) + '<div class="chart-box"><canvas id="c-trend"></canvas></div></div>'
    + '<div class="panel">' + H('流入チャネル <small>過去12か月の累計・PV</small>', ['GA4']) + '<div class="chart-box"><canvas id="c-ch"></canvas></div></div></section>'
    + '<section class="grid2 even"><div class="panel">' + H('CV（キーイベント）とCV率 <small>過去12か月・月別</small>', ['GA4']) + '<div class="chart-box sm"><canvas id="c-cv"></canvas></div></div>'
    + '<div class="panel">' + H('エリア別セッション <small>過去12か月の累計・上位8都道府県</small>', ['GA4'], '<button class="linkbtn" type="button" data-goto="area">エリアを開く →</button>') + '<div class="chart-box sm"><canvas id="c-area"></canvas></div></div></section>'
    + '<section class="grid2 even"><div class="panel">' + H('記事進捗 <small>過去12か月・合計（新規＋リライト＋簡易リライト）の月別と累計</small>', ['WordPress'], '<button class="linkbtn" type="button" data-goto="articles">記事進捗を開く →</button>') + '<div class="chart-box sm"><canvas id="c-fyart"></canvas></div><div id="sum-fy-art"></div></div>'
    + '<div class="panel">' + H('順位分布の推移 <small>KW追従・月末時点のKW数（スマホ）</small>', ['Ahrefs'], '<button class="linkbtn" type="button" data-goto="kw">KW追従を開く →</button>') + '<div class="chart-box sm" id="sum-rank-box"><canvas id="c-sumrank"></canvas></div></div></section>'
    + (noMoney() ? '' : '<section class="panel">' + H('収益・支出・収支 <small>過去12か月・月別・税抜き</small>', ['kintone', 'ASP', '支出']) + '<div class="chart-box sm"><canvas id="c-money"></canvas></div></section>');
  return { html, view: 'サマリ（' + mediaName(id) + '）', after: async () => {
    bindGoto();
    const rows = L12.map(m => monthVal(id, m)), labels = L12.map(m => mShort(m));
    chart('c-trend', { type: 'line', data: { labels, datasets: [
      { label: 'PV', data: rows.map(r => r.pv), borderColor: seriesColor(0), backgroundColor: seriesColor(0) + '22', fill: true, tension: .3, pointRadius: 2 },
      { label: 'セッション', data: rows.map(r => r.sessions), borderColor: seriesColor(2), tension: .3, pointRadius: 2 },
    ] }, options: baseOpts() });
    const fyTot = periodVal(id, L12), ch = Object.entries(fyTot.ch || {}).sort((x, y2) => y2[1].pv - x[1].pv);
    chart('c-ch', { type: 'doughnut', data: { labels: ch.map(c => c[0]), datasets: [{ data: ch.map(c => c[1].pv), backgroundColor: ch.map((c, i) => seriesColor(i)), borderColor: css('--surface'), borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), boxWidth: 10, font: { size: 11 } } } } } });
    chart('c-cv', { type: 'bar', data: { labels, datasets: [
      { label: 'CV', data: rows.map(r => r.cv), backgroundColor: seriesColor(0), yAxisID: 'y', borderRadius: 3 },
      { label: 'CV率（%）', data: rows.map(r => r.cvr == null ? null : +(r.cvr * 100).toFixed(2)), type: 'line', borderColor: seriesColor(1), backgroundColor: seriesColor(1), yAxisID: 'y1', pointRadius: 2 },
    ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { display: false } }, y: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y1: { position: 'right', ticks: { color: css('--muted'), callback: v => v + '%' }, grid: { display: false } } } }) });
    chart('c-money', { type: 'bar', data: { labels, datasets: [
      { label: '収益合計(税抜き)', data: rows.map(r => r.revenue), backgroundColor: MONEY_BLUE, stack: 'rev', borderRadius: 2 },
      { label: '支出合計(税抜き)', data: rows.map(r => r.cost), backgroundColor: MONEY_RED, stack: 'cost', borderRadius: 2 },
      { label: '収支合計(税抜き)', data: rows.map(r => r.profit), type: 'line', borderColor: css('--fg'), backgroundColor: css('--fg'), pointRadius: 2, tension: .25 },
    ] }, options: baseOpts({ scales: { x: { stacked: true, ticks: { color: css('--muted') }, grid: { display: false } }, y: { stacked: true, ticks: { color: css('--muted'), callback: v => '¥' + nf.format(v) }, grid: { color: css('--grid') } } } }) });
    // 順位分布の推移（KW追従・スマホ）
    (async () => {
      const e = id === ALL ? null : ent(id), box = $('sum-rank-box');
      if (!box) return;
      let d; try { d = await api('/kw-rank?media=' + encodeURIComponent(e ? e.media : '__all__')); /* メディア累計は全メディアの合計 */ } catch (err) { box.innerHTML = '<p class="empty">表示できませんでした</p>'; return; }
      const rs = d.rows.filter(r => r.device === 'mobile' && (!e || !e.block || String(r.tags || '').split('、').includes(e.block)));
      const ms = [...new Set(rs.map(r => r.ym))].sort().slice(-12);
      if (!ms.length) { box.innerHTML = '<p class="empty">' + (d.connected ? '順位はまだ取得していません（毎月2日に取得）' : 'Ahrefsと未連携です') + '</p>'; return; }
      chart('c-sumrank', { type: 'bar', data: { labels: ms.map(mShort), datasets: RANK_BANDS.map(([l, fn, color]) => ({ label: l, backgroundColor: color(), stack: 'a', data: ms.map(m => rs.filter(r => r.ym === m && fn(r.position == null ? null : Number(r.position))).length) })) }, options: baseOpts({ scales: stackScales() }) });
    })();
    // 当月・前期・昨対（途中の月は日次の値で同じ日数どうしを比べる）
    const sh = (ym, n) => shiftMonth(ym, n), dEnd = D || null;
    const ph = halfOf(sh(h.start, -6));   // BEST半期の前期（ひとつ前の半期・6か月まるごと）（2026-11-06 ユーザー指定）
    const [nowC, nowP, nowY, hC, hP, hY, fC, fY, pC, pP, pY] = await Promise.all([
      spanVal(id, now, now, null), spanVal(id, sh(now, -1), sh(now, -1), D), spanVal(id, sh(now, -12), sh(now, -12), D),
      spanVal(id, h.start, curEnd, null), spanVal(id, sh(h.start, -6), sh(curEnd, -6), dEnd), spanVal(id, sh(h.start, -12), sh(curEnd, -12), dEnd),
      spanVal(id, fm[0], curEnd, null), spanVal(id, sh(fm[0], -12), sh(curEnd, -12), dEnd),
      spanVal(id, ph.start, ph.end, null), spanVal(id, sh(ph.start, -6), sh(ph.end, -6), null), spanVal(id, sh(ph.start, -12), sh(ph.end, -12), null),
    ]);
    $('sum-now').innerHTML = kpiCards(nowC, nowP, nowY, '前月同期', '前年同期', k => L12now.map(m => monthVal(id, m)[k]));
    if ($('sum-now-money')) $('sum-now-money').innerHTML = H('収益と支出の内訳 <small>' + mLabel(now) + '・' + yd + 'まで</small>', ['kintone', 'ASP', '支出'])
      + moneyTable(nowC, nowP, nowY, mLabel(now) + '<br><span class="note">〜' + yd + '</span>', mLabel(sh(now, -1)) + '<br><span class="note">同日まで</span>', mLabel(sh(now, -12)) + '<br><span class="note">同日まで</span>', '前月同期比', '前年同期比')
      + '<p class="note">支出・アフィリエイトは、スプレッドシートに入力された月の金額を日割りしています（今月分は入力後に反映）。</p>';
    // 期間別の進捗
    const P = [
      { label: '今月', sub: mLabel(now) + '・1日〜' + yd, c: nowC, p: nowP, y: nowY, pl: '前月同期比', months: [now] },
      { label: 'BEST半期（今期）', sub: h.label + '（' + h.range + '）の' + yd + 'まで', c: hC, p: hP, y: hY, pl: '前半期比', months: monthsFrom(h.start, curEnd) },
      { label: 'BEST半期（前期）', sub: ph.label + '（' + ph.range + '）・確定', c: pC, p: pP, y: pY, pl: '前半期比', months: monthsFrom(ph.start, ph.end) },
      { label: '年間累計', sub: fy + '年度（' + mLabel(fm[0]) + '〜）の' + yd + 'まで', c: fC, p: null, y: fY, pl: '', months: monthsFrom(fm[0], curEnd) },
    ];
    await loadArticles().catch(() => {});
    const ROWS = [['pv', 'PV'], ['cv', 'CV（キーイベント）'], ['cvr', 'CV率'], ['clicks', 'クリック数'], ['posts', '新規公開記事数', 'new'], ['rewrites', 'リライト記事数', 'rewrite'], ['lite', '簡易リライト記事数'], ['tweak', '微調整'], ['kCalls', 'コール数'], ['contracts', '成約数'], ['revenue', '収益合計(税抜き)'], ['cost', '支出合計(税抜き)'], ['profit', '収支合計(税抜き)'], ['unitCost', '1記事あたりの単価(税抜き)']].filter(r => !(noMoney() && MONEY_KEYS.includes(r[0])));   /* REsta社員は収益と支出なし */
    const cell = (x, k, art) => { const st = art ? periodStat(id, x.months, art) : null;
      return '<td class="c-num"><div class="pv-box"><div class="pv-val">' + fmt(k, x.c[k]) + (st && st.tgt ? '<span class="note"> / 目標 ' + st.tgt + '</span>' : '') + '</div><div class="chips">' + (x.p ? chip(k, x.c[k], x.p[k], x.pl.replace('比', '')) : '') + chip(k, x.c[k], x.y[k], '昨対') + '</div></div></td>'; };
    $('sum-periods').innerHTML = H('期間別の進捗 <small>' + esc(mediaName(id)) + '・昨日（' + YESTERDAY.replace(/-/g, '/') + '）分までの最新の値</small>', noMoney() ? ['GA4', 'SC', 'WordPress', 'kintone'] : ['GA4', 'SC', 'WordPress', 'kintone', 'ASP', '支出'])
      + /* 表は枠の幅いっぱい、期間の列は同じ幅。値と比較は決まった幅のまとまり（.pv-box）にして列の中央に置き、見出しも同じ幅で右をそろえる（2026-11-06 ユーザー指定：左右のバランス） */
      '<div class="table-wrap"><table class="am-table period-table"><colgroup><col style="width:240px">' + P.map(() => '<col>').join('') + '</colgroup><thead><tr><th class="c-txt">指標</th>' + P.map(x => '<th class="c-num"><div class="pv-box"><b>' + x.label + '</b><br><span class="note">' + esc(x.sub) + '</span></div></th>').join('') + '</tr></thead><tbody>'
      + ROWS.map(([k, l, art]) => '<tr><td class="c-txt">' + l + ' <span class="note">' + srcOf(k).join('・') + '</span></td>' + P.map(x => cell(x, k, art)).join('') + '</tr>').join('')
      + '</tbody></table></div><p class="note">比較は同じ日数どうし：今月は前月・前年同月の1日〜' + yd.slice(3) + '日、BEST半期（今期）は前の半期（前半期）と前年の同じ半期の同じ時点まで、BEST半期（前期）は6か月まるごとを、その前の半期・前年の同じ半期と比較、年間累計は前年度の同じ時点まで（年間は前期＝前年度のため昨対のみ）。支出・アフィリエイトは月の金額の日割りです。</p>';
    // 記事進捗：当月・前月・年間
    $('sum-now-art').innerHTML = H('記事進捗 <small>' + mLabel(now) + '・' + yd + 'まで</small>', ['WordPress'], '<button class="linkbtn" type="button" data-goto="articles">記事進捗を開く →</button>') + articleBlock(id);
    $('sum-last-art').innerHTML = H('記事進捗 <small>' + mLabel(cur) + '</small>', ['WordPress']) + monthArticleBlock(id, cur);
    let ca = 0, ct = 0;
    const act = L12.map(m => actualOf(id, m, 'total')), cumA = act.map(v => (ca += v || 0)), cumT = L12.map(m => { ct += targetOf(id, m, 'total') || 0; return ct || null; });
    chart('c-fyart', { type: 'bar', data: { labels, datasets: [
      { label: '実績（月）', data: act, backgroundColor: css('--wp-soft'), borderRadius: 2 },
      { label: '累計実績', data: cumA, type: 'line', borderColor: css('--wp-ink'), backgroundColor: css('--wp-ink'), pointRadius: 2, tension: .2 },
      { label: '累計目標', data: cumT, type: 'line', borderColor: css('--muted'), borderDash: [5, 4], pointRadius: 0, tension: .2 },
    ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { display: false } }, y: { ticks: { color: css('--muted'), precision: 0 }, grid: { color: css('--grid') }, beginAtZero: true } } }) });
    const l12st = periodStat(id, L12, 'total');
    $('sum-fy-art').innerHTML = '<p class="note">過去12か月の実績 <b class="num">' + (l12st.act ?? '—') + '</b> ／ 目標 <b class="num">' + (l12st.tgt ?? '—') + '</b>（' + pct(l12st.act, l12st.tgt) + '）</p>';
    bindGoto();
    const regions = await loadRegions(L12[0] + '-01', monthEnd(cur));
    const top = regionRows(regions, id).sort((x, y2) => y2.sessions - x.sessions).slice(0, 8);
    chart('c-area', { type: 'bar', data: { labels: top.map(x => x.pref), datasets: [{ label: 'セッション', data: top.map(x => x.sessions), backgroundColor: seriesColor(0), borderRadius: 3 }] },
      options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y: { ticks: { color: css('--muted'), font: { size: 11 } }, grid: { display: false } } } }) });
  } };
}
function bindGoto() { document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { state.view = b.dataset.goto; if (CONTENT_NUM_VIEWS.includes(state.view)) { state.dash = 'articles'; if (state.media !== ALL && ent(state.media)) state.artMedia = ent(state.media).media; } render(); }); }   // 記事進捗などはコンテンツ作成へ
function summaryCompare(cur, prev, ly) {
  const ids = topIds();
  const rows = ids.map(id => ({ id, a: monthVal(id, cur), p: monthVal(id, prev), y: monthVal(id, ly) }));
  const tot = { a: monthVal(ALL, cur), p: monthVal(ALL, prev), y: monthVal(ALL, ly) };
  const maxPv = Math.max(1, ...rows.map(r => r.a.pv || 0));
  const cells = t => `<td class="num">${fmt('vpa', t.a.vpa)}</td><td class="num">${fmt('cv', t.a.cv)}</td><td class="num">${fmt('cvr', t.a.cvr)}</td><td class="num">${fmt('clicks', t.a.clicks)}</td><td class="num">${fmt('pos', t.a.pos)}</td>`;
  const body = rows.map((r, i) => `<tr data-row="${i}" style="cursor:pointer"><td>${esc(mediaName(r.id))}</td><td class="num"><span class="bar" style="width:${Math.round((r.a.pv || 0) / maxPv * 60)}px"></span>${fmt('pv', r.a.pv)}</td>${rateCell('pv', r.a.pv, r.p.pv)}${rateCell('pv', r.a.pv, r.y.pv)}${cells(r)}</tr>`).join('');
  return { html: `<p class="note">全メディアの${mLabel(cur)}の数値です。行をクリックするとそのメディアのサマリへ移動します。</p>
    <section class="grid2">
      <div class="panel">${H(`メディア別 PV <small>${mLabel(cur)}と前年同月</small>`, ['GA4'])}<div class="chart-box tall"><canvas id="c-cmp"></canvas></div></div>
      <div class="panel">${H('PV構成比', ['GA4'])}<div class="chart-box tall"><canvas id="c-share"></canvas></div></div>
    </section>
    <section class="panel">${H(`各メディア比較 <small>${mLabel(cur)}</small>`, ['GA4', 'SC'])}
      <div class="table-wrap"><table><thead><tr><th>メディア</th><th class="num">PV</th><th class="num">前月比</th><th class="num">前年比</th><th class="num">ビュー/人</th><th class="num">CV</th><th class="num">CV率</th><th class="num">クリック</th><th class="num">掲載順位</th></tr></thead>
      <tbody>${body}<tr class="total"><td>メディア累計</td><td class="num">${fmt('pv', tot.a.pv)}</td>${rateCell('pv', tot.a.pv, tot.p.pv)}${rateCell('pv', tot.a.pv, tot.y.pv)}${cells(tot)}</tr></tbody></table></div></section>`,
    view: 'サマリ（各メディア比較）',
    after: () => {
      const sorted = [...rows].sort((x, y2) => (y2.a.pv || 0) - (x.a.pv || 0));
      chart('c-cmp', { type: 'bar', data: { labels: sorted.map(r => mediaName(r.id)), datasets: [
        { label: mLabel(cur), data: sorted.map(r => r.a.pv), backgroundColor: seriesColor(0) },
        { label: mLabel(ly) + '（前年）', data: sorted.map(r => r.y.pv), backgroundColor: css('--line') },
      ] }, options: baseOpts({ indexAxis: 'y', scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y: { ticks: { color: css('--muted'), font: { size: 11 } }, grid: { display: false } } } }) });
      chart('c-share', { type: 'doughnut', data: { labels: rows.map(r => mediaName(r.id)), datasets: [{ data: rows.map(r => r.a.pv || 0), backgroundColor: rows.map((r, i) => seriesColor(i)), borderColor: css('--surface'), borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), boxWidth: 10, font: { size: 10.5 } } } } } });
      document.querySelectorAll('tr[data-row]').forEach(tr => tr.onclick = () => { state.media = rows[Number(tr.dataset.row)].id; state.mode = 'single'; render(); });
    } };
}

// ================= 月次 =================
function viewMonthly() {
  const months = last13().concat(MONTHS.includes(CUR_MONTH) ? [CUR_MONTH] : []), k = state.metric;
  const lab = mm => mShort(mm) + (mm === CUR_MONTH ? '（途中）' : '');
  if (state.mode === 'compare') {
    const ids = topIds();
    const body = ids.map(id => `<tr><td>${esc(mediaName(id))}</td>${months.map(mm => `<td class="num">${fmt(k, monthVal(id, mm)[k])}</td>`).join('')}</tr>`).join('');
    return { html: `<div class="row">${metricSelect()}</div>
      <section class="panel">${H(`${M[k].l}の月次推移 <small>メディア別</small>`, srcOf(k))}<div class="chart-box tall"><canvas id="c-m"></canvas></div></section>
      <section class="panel">${H('メディア別 月次表', srcOf(k))}<div class="table-wrap"><table><thead><tr><th>メディア</th>${months.map(mm => `<th class="num">${lab(mm)}</th>`).join('')}</tr></thead><tbody>${body}
      <tr class="total"><td>メディア累計</td>${months.map(mm => `<td class="num">${fmt(k, monthVal(ALL, mm)[k])}</td>`).join('')}</tr></tbody></table></div></section>`,
      view: '月次（各メディア比較・' + M[k].l + '）',
      after: () => { bindMetric(); chart('c-m', { type: 'line', data: { labels: months.map(mShort), datasets: ids.map((id, i) => ({ label: mediaName(id), data: months.map(mm => monthVal(id, mm)[k]), borderColor: seriesColor(i), backgroundColor: seriesColor(i), tension: .25, pointRadius: 1.5 })) }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y: yAxis(k) } }) }); } };
  }
  const rows = months.map(mm => ({ mm, t: monthVal(state.media, mm) }));
  return { html: `<div class="row">${metricSelect()}<span class="note">月の数値は毎日更新。前月分は毎月5日まで取り直して確定します。</span></div>${scNote(state.media)}
    <section class="panel">${H(`${M[k].l}の月次推移 <small>${esc(mediaName(state.media))}</small>`, srcOf(k))}<div class="chart-box"><canvas id="c-m"></canvas></div></section>
    <section class="panel">${H(`月次一覧 <small>${esc(mediaName(state.media))}</small>`, ALL_SRC)}<div class="table-wrap"><table><thead><tr><th>指標</th>${rows.map(r => `<th class="num">${lab(r.mm)}</th>`).join('')}</tr></thead>
    <tbody>${METRICS.map(x => `<tr><td>${x.l} <span class="note">${srcOf(x.k).join('・')}</span></td>${rows.map(r => `<td class="num">${fmt(x.k, r.t[x.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`,
    view: '月次（' + mediaName(state.media) + '）',
    after: () => { bindMetric(); chart('c-m', { type: 'bar', data: { labels: rows.map(r => mShort(r.mm)), datasets: [{ label: M[k].l, data: rows.map(r => r.t[k]), backgroundColor: rows.map(r => r.mm === LAST_FULL ? seriesColor(0) : seriesColor(0) + '88'), borderRadius: 4 }] }, options: baseOpts({ plugins: { legend: { display: false } }, scales: { x: { ticks: { color: css('--muted') }, grid: { display: false } }, y: yAxis(k) } }) }); } };
}

// ================= 日次 =================
function viewDaily() {
  const k = state.metric, from = state.dailyFrom, to = state.dailyTo > YESTERDAY ? YESTERDAY : state.dailyTo;
  const controls = `<div class="row">${metricSelect(null, true)}<label class="field">期間<input type="date" id="d-from" value="${from}" max="${YESTERDAY}"></label><label class="field">〜<input type="date" id="d-to" value="${to}" max="${YESTERDAY}"></label>
    <div class="seg" role="group" aria-label="期間プリセット"><button type="button" data-preset="7">7日</button><button type="button" data-preset="30">30日</button><button type="button" data-preset="90">90日</button><button type="button" data-preset="365">1年</button></div>
    <span class="note">昨日（${YESTERDAY.replace(/-/g, '/')}）分まで反映</span></div>`;
  const bind = () => {
    bindMetric();
    $('d-from').onchange = ev => { state.dailyFrom = ev.target.value; render(); };
    $('d-to').onchange = ev => { state.dailyTo = ev.target.value; render(); };
    document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { state.dailyTo = YESTERDAY; state.dailyFrom = addDays(YESTERDAY, -(Number(b.dataset.preset) - 1)); render(); });
  };
  const labels = dayList(from, to).map(dLabel);
  if (state.mode === 'compare') {
    const ids = topIds();
    return { html: controls + `<section class="panel">${H(`${M[k].l}の日次推移 <small>メディア別</small>${ucDayNote(k)}`, srcOf(k))}<div class="chart-box tall"><canvas id="c-d"></canvas></div></section><section class="panel" id="d-table"><p class="loading">読み込み中…</p></section>`,
      view: '日次（各メディア比較）',
      after: async () => {
        bind();
        const daily = await loadDaily(from, to);
        chart('c-d', { type: 'line', data: { labels, datasets: ids.map((id, i) => ({ label: mediaName(id), data: daySeries(daily, id, k, from, to), borderColor: seriesColor(i), backgroundColor: seriesColor(i), tension: .2, pointRadius: 0, borderWidth: 1.5 })) }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 10 }, grid: { color: css('--grid') } }, y: yAxis(k) } }) });
        const n = dayList(from, to).length;
        $('d-table').innerHTML = `${H(`期間合計 <small>${from} 〜 ${to}（${n}日）</small>`, ALL_SRC.concat('ASP'))}<div class="table-wrap"><table><thead><tr><th>メディア</th><th class="num">PV</th><th class="num">1日平均PV</th><th class="num">セッション</th><th class="num">CV</th><th class="num">CV率</th><th class="num">クリック</th><th class="num">新規公開</th><th class="num">コール数</th><th class="num">成約数</th>${noMoney() ? '' : '<th class="num">収益合計(税抜き)</th><th class="num">支出合計(税抜き)</th>'}</tr></thead><tbody>
          ${ids.map(id => { const t = rangeVal(daily, id, from, to); return `<tr><td>${esc(mediaName(id))}</td><td class="num">${fmt('pv', t.pv)}</td><td class="num">${fmt('pv', t.pv == null ? null : t.pv / n)}</td><td class="num">${fmt('sessions', t.sessions)}</td><td class="num">${fmt('cv', t.cv)}</td><td class="num">${fmt('cvr', t.cvr)}</td><td class="num">${fmt('clicks', t.clicks)}</td><td class="num">${fmt('posts', t.posts)}</td><td class="num">${fmt('kCalls', t.kCalls)}</td><td class="num">${fmt('contracts', t.contracts)}</td>${noMoney() ? '' : `<td class="num">${fmt('revenue', t.revenue)}</td><td class="num">${fmt('cost', t.cost)}</td>`}</tr>`; }).join('')}</tbody></table></div>`;
      } };
  }
  return { html: controls + scNote(state.media) + `<section class="panel">${H(`${M[k].l}の日次推移 <small>${esc(mediaName(state.media))}</small>${ucDayNote(k)}`, srcOf(k))}<div class="chart-box"><canvas id="c-d"></canvas></div></section><section class="panel" id="d-table"><p class="loading">読み込み中…</p></section>`,
    view: '日次（' + mediaName(state.media) + '）',
    after: async () => {
      bind();
      const daily = await loadDaily(from, to);
      chart('c-d', { type: 'line', data: { labels, datasets: [{ label: M[k].l, data: daySeries(daily, state.media, k, from, to), borderColor: seriesColor(0), backgroundColor: seriesColor(0) + '22', fill: true, tension: .2, pointRadius: 0, borderWidth: 1.8 }] }, options: baseOpts({ plugins: { legend: { display: false } }, scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 12 }, grid: { color: css('--grid') } }, y: yAxis(k) } }) });
      const ids = state.media === ALL ? topIds() : [state.media];
      const rows = dayList(from, to).reverse().slice(0, 62).map(d => ({ d, t: derive(sumRaw(ids.map(x => (daily[x] || {})[d]))) }));
      $('d-table').innerHTML = `${H('日次一覧 <small>新しい順・最大62日</small>', ALL_SRC.concat('ASP'))}<div class="table-wrap"><table><thead><tr><th>日付</th><th class="num">PV</th><th class="num">セッション</th><th class="num">ユーザー</th><th class="num">CV</th><th class="num">CV率</th><th class="num">表示回数</th><th class="num">クリック</th><th class="num">掲載順位</th><th class="num">新規公開</th><th class="num">リライト</th><th class="num">簡易リライト</th><th class="num">微調整</th><th class="num">コール数</th><th class="num">訪問確定</th><th class="num">成約数</th>${noMoney() ? '' : '<th class="num">収益合計(税抜き)</th><th class="num">支出合計(税抜き)<span class="note">（日割り）</span></th><th class="num">収支合計(税抜き)</th><th class="num">1記事あたりの単価</th>'}</tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r.d.replace(/-/g, '/')}（${'日月火水木金土'[new Date(r.d + 'T00:00:00Z').getUTCDay()]}）</td><td class="num">${fmt('pv', r.t.pv)}</td><td class="num">${fmt('sessions', r.t.sessions)}</td><td class="num">${fmt('users', r.t.users)}</td><td class="num">${fmt('cv', r.t.cv)}</td><td class="num">${fmt('cvr', r.t.cvr)}</td><td class="num">${fmt('imp', r.t.imp)}</td><td class="num">${fmt('clicks', r.t.clicks)}</td><td class="num">${fmt('pos', r.t.pos)}</td><td class="num">${fmt('posts', r.t.posts)}</td><td class="num">${fmt('rewrites', r.t.rewrites)}</td><td class="num">${fmt('lite', r.t.lite)}</td><td class="num">${fmt('tweak', r.t.tweak)}</td><td class="num">${fmt('kCalls', r.t.kCalls)}</td><td class="num">${fmt('visits', r.t.visits)}</td><td class="num">${fmt('contracts', r.t.contracts)}</td>${noMoney() ? '' : `<td class="num">${fmt('revenue', r.t.revenue)}</td><td class="num">${fmt('cost', r.t.cost)}</td><td class="num">${fmt('profit', r.t.profit)}</td><td class="num">${fmt('unitCost', r.t.unitCost)}</td>`}</tr>`).join('')}</tbody></table></div><p class="note">コール数・訪問確定・成約数・収益（加盟店）はkintoneのSEO回線、新規公開・リライト・簡易リライトは進行管理（アップロード日）、微調整はWordPressで更新された記事からリライト・簡易リライトを引いた数、支出・アフィリエイトは月の金額の日割りです。</p>`;
    } };
}

// ================= 前年比・前月比・期間比較 =================
/** 比率の見出し：前年同月→前年比、前月→前月比、それ以外→期間比 */
const ratioHead = baseLabel => /前年/.test(baseLabel) ? '前年比' : /前月/.test(baseLabel) ? '前月比' : '期間比';
function compareTable(curT, baseT, curLabel, baseLabel, note) {
  return `<div class="table-wrap"><table><thead><tr><th>指標</th><th class="num">${curLabel}</th><th class="num">${baseLabel}</th><th class="num">増減</th><th class="num">${ratioHead(baseLabel)}</th></tr></thead><tbody>
    ${METRICS.filter(x => !(note && x.monthly)).map(x => { const c = curT[x.k], b = baseT[x.k], d = c == null || b == null ? null : c - b;
      return `<tr><td>${x.l}${note && ['users', 'active', 'newUsers', 'vpa'].includes(x.k) ? ' <span class="note">※</span>' : ''} <span class="note">${srcOf(x.k).join('・')}</span></td><td class="num">${fmt(x.k, c)}</td><td class="num">${fmt(x.k, b)}</td><td class="num">${d == null ? '—' : (d >= 0 ? '+' : '−') + fmt(x.k, Math.abs(d))}</td>${rateCell(x.k, c, b)}</tr>`; }).join('')}
  </tbody></table></div>${note ? '<p class="note">※ ユーザー数は日別の値の合計です。期間をまたいで同じ人が来た場合は重複して数えるため、実際より多めになります。支出・アフィリエイトは月の金額を日割りしています。公開記事数（累計）は月次のみです。</p>' : ''}`;
}
function compareMediaTable(k, getCur, getBase, curLabel, baseLabel) {
  const rows = topIds().map(id => ({ id, c: getCur(id)[k], b: getBase(id)[k] }));
  const tc = getCur(ALL)[k], tb = getBase(ALL)[k];
  return { rows, html: `<div class="table-wrap"><table><thead><tr><th>メディア</th><th class="num">${curLabel}</th><th class="num">${baseLabel}</th><th class="num">${ratioHead(baseLabel)}</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(mediaName(r.id))}</td><td class="num">${fmt(k, r.c)}</td><td class="num">${fmt(k, r.b)}</td>${rateCell(k, r.c, r.b)}</tr>`).join('')}
    <tr class="total"><td>メディア累計</td><td class="num">${fmt(k, tc)}</td><td class="num">${fmt(k, tb)}</td>${rateCell(k, tc, tb)}</tr></tbody></table></div>` };
}
function rateBarChart(id, k, rows) {
  const vals = rows.map(r => r.b ? +(100 + (r.c - r.b) / Math.abs(r.b) * 100).toFixed(1) : 0);   /* 比率（%）。マイナスの値でも、プラスに近づいたら100%より上 */
  const good = css('--good'), bad = css('--bad');
  chart(id, { type: 'bar', data: { labels: rows.map(r => mediaName(r.id)), datasets: [{ label: '比率（%）', data: vals, backgroundColor: vals.map(v => (M[k].lowerBetter ? v < 100 : v >= 100) ? good : bad), borderRadius: 3 }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: css('--muted'), callback: v => v + '%' }, grid: { color: css('--grid') } }, y: { ticks: { color: css('--muted'), font: { size: 11 } }, grid: { display: false } } } }) });
}
function viewPeriodCompare(kind) {
  const minIdx = kind === 'yoy' ? 12 : 1;
  const picker = monthPicker(minIdx);
  const cur = state.ymMonth, base = kind === 'yoy' ? shiftMonth(cur, -12) : shiftMonth(cur, -1);
  const curL = mLabel(cur), baseL = mLabel(base) + (kind === 'yoy' ? '（前年同月）' : '（前月）'), k = state.metric, name = kind === 'yoy' ? '前年比' : '前月比';
  if (state.mode === 'compare') {
    const t = compareMediaTable(k, id => monthVal(id, cur), id => monthVal(id, base), curL, baseL);
    return { html: `<div class="row">${picker}${metricSelect()}</div>
      <section class="grid2"><div class="panel">${H(`${M[k].l}の${name} <small>メディア別</small>`, srcOf(k))}<div class="chart-box tall"><canvas id="c-r"></canvas></div></div>
      <div class="panel">${H(`メディア別 ${M[k].l}`, srcOf(k))}${t.html}</div></section>`,
      view: name + '（各メディア比較）', after: () => { bindMonthPicker(); bindMetric(); rateBarChart('c-r', k, t.rows); } };
  }
  const a = monthVal(state.media, cur), b = monthVal(state.media, base);
  const head = `<div class="row">${picker}${metricSelect()}</div>${scNote(state.media)}
    <section class="grid2"><div class="panel"><div class="panel-head"><h2 id="r-title"></h2><div class="srcs"><span class="srcs">${srcBadges(srcOf(k))}</span></div></div><div class="chart-box"><canvas id="c-r"></canvas></div></div>
    <div class="panel">${H(`主要指標 <small>${curL} と ${baseL}</small>`, ['GA4', 'SC', 'kintone'])}
      <div class="kpis" style="grid-template-columns: repeat(2, minmax(0,1fr)); margin-top: 8px;">${MAIN_KEYS.map(x => `<div class="kpi" data-src="${M[x].src}"><div class="lbl"><span title="${M[x].l}">${M[x].l}</span><span class="srcs">${srcBadges(srcOf(x))}</span></div><div class="val">${fmt(x, a[x])}</div><div class="chips">${a[x] == null ? pendingNote : chip(x, a[x], b[x], kind === 'yoy' ? '前年' : '前月')}</div></div>`).join('')}</div></div></section>
    <section class="panel">${H('全指標の比較', ALL_SRC)}${compareTable(a, b, curL, baseL)}</section>`;
  if (kind === 'yoy') {
    const thisY = MONTHS.filter(m => m <= cur).slice(-12);
    return { html: head, view: name + '（' + mediaName(state.media) + '）', after: () => {
      bindMonthPicker(); bindMetric();
      $('r-title').innerHTML = `${M[k].l}：直近12か月と前年の重ね合わせ <small>${esc(mediaName(state.media))}</small>`;
      chart('c-r', { type: 'line', data: { labels: thisY.map(mm => Number(mm.slice(5)) + '月'), datasets: [
        { label: '直近12か月', data: thisY.map(mm => monthVal(state.media, mm)[k]), borderColor: seriesColor(0), backgroundColor: seriesColor(0) + '22', fill: true, tension: .3, pointRadius: 2 },
        { label: 'その前年', data: thisY.map(mm => monthVal(state.media, shiftMonth(mm, -12))[k]), borderColor: css('--muted'), borderDash: [5, 4], tension: .3, pointRadius: 0 },
      ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y: yAxis(k) } }) });
    } };
  }
  return { html: head, view: name + '（' + mediaName(state.media) + '）', after: async () => {
    bindMonthPicker(); bindMetric();
    $('r-title').innerHTML = `${M[k].l}：日別の重ね合わせ <small>${curL} と ${mLabel(base)}</small>${ucDayNote(k)}`;
    const daily = await loadDaily(base + '-01', monthEnd(cur) > YESTERDAY ? YESTERDAY : monthEnd(cur));
    const c1 = daySeries(daily, state.media, k, cur + '-01', monthEnd(cur)), c0 = daySeries(daily, state.media, k, base + '-01', monthEnd(base));
    const len = Math.max(c1.length, c0.length);
    chart('c-r', { type: 'line', data: { labels: Array.from({ length: len }, (_, i) => (i + 1) + '日'), datasets: [
      { label: curL, data: c1, borderColor: seriesColor(0), tension: .25, pointRadius: 0, borderWidth: 1.8 },
      { label: mLabel(base), data: c0, borderColor: css('--muted'), borderDash: [5, 4], tension: .25, pointRadius: 0 },
    ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 10 }, grid: { color: css('--grid') } }, y: yAxis(k) } }) });
  } };
}
function viewRange() {
  const k = state.metric, fix = d => d > YESTERDAY ? YESTERDAY : d;
  const aF = state.aFrom, aT = fix(state.aTo), bF = state.bFrom, bT = fix(state.bTo);
  const dIn = (id, v) => `<input type="date" id="${id}" value="${v}" max="${YESTERDAY}">`;
  const controls = `<div class="panel"><div class="row"><span class="field"><b style="color: var(--fg)">期間A</b>${dIn('ra-from', aF)}〜${dIn('ra-to', aT)}</span>
    <span class="field"><b style="color: var(--fg)">期間B</b>${dIn('rb-from', bF)}〜${dIn('rb-to', bT)}</span>${metricSelect(null, true)}</div>
    <p class="note" style="margin: 8px 0 0;">日数が違う期間でも比較できます（期間A ${dayList(aF, aT).length}日／期間B ${dayList(bF, bT).length}日、各400日まで）。</p></div>`;
  const bind = () => { bindMetric(); [['ra-from', 'aFrom'], ['ra-to', 'aTo'], ['rb-from', 'bFrom'], ['rb-to', 'bTo']].forEach(([id, key]) => { $(id).onchange = ev => { state[key] = ev.target.value; render(); }; }); };
  const load = () => Promise.all([loadDaily(aF, aT), loadDaily(bF, bT)]);
  if (state.mode === 'compare') {
    return { html: controls + `<section class="grid2"><div class="panel">${H(`${M[k].l}の期間比 <small>A ÷ B・メディア別</small>`, srcOf(k))}<div class="chart-box tall"><canvas id="c-r"></canvas></div></div><div class="panel" id="r-table"><p class="loading">読み込み中…</p></div></section>`,
      view: '期間比較（各メディア比較）', after: async () => {
        bind();
        const [da, db] = await load();
        const t = compareMediaTable(k, id => rangeVal(da, id, aF, aT), id => rangeVal(db, id, bF, bT), '期間A', '期間B');
        $('r-table').innerHTML = H(`メディア別 ${M[k].l}`, srcOf(k)) + t.html;
        rateBarChart('c-r', k, t.rows);
      } };
  }
  return { html: controls + scNote(state.media) + `<section class="panel">${H(`${M[k].l}：経過日数で重ね合わせ <small>${esc(mediaName(state.media))}</small>${ucDayNote(k)}`, srcOf(k))}<div class="chart-box"><canvas id="c-r"></canvas></div></section><section class="panel" id="r-table"><p class="loading">読み込み中…</p></section>`,
    view: '期間比較（' + mediaName(state.media) + '）', after: async () => {
      bind();
      const [da, db] = await load();
      const s1 = daySeries(da, state.media, k, aF, aT), s0 = daySeries(db, state.media, k, bF, bT), len = Math.max(s1.length, s0.length);
      chart('c-r', { type: 'line', data: { labels: Array.from({ length: len }, (_, i) => (i + 1) + '日目'), datasets: [
        { label: `期間A（${dLabel(aF)}〜${dLabel(aT)}）`, data: s1, borderColor: seriesColor(0), tension: .25, pointRadius: 0, borderWidth: 1.8 },
        { label: `期間B（${dLabel(bF)}〜${dLabel(bT)}）`, data: s0, borderColor: seriesColor(1), borderDash: [5, 4], tension: .25, pointRadius: 0 },
      ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 10 }, grid: { color: css('--grid') } }, y: yAxis(k) } }) });
      $('r-table').innerHTML = H('全指標の比較', ALL_SRC) + compareTable(rangeVal(da, state.media, aF, aT), rangeVal(db, state.media, bF, bT), '期間A', '期間B', true);
    } };
}

// ================= エリア =================
const PREFS = [
  ['北海道', 'Hokkaido', 12, 0], ['青森', 'Aomori', 11, 2], ['秋田', 'Akita', 10, 3], ['岩手', 'Iwate', 11, 3], ['石川', 'Ishikawa', 7, 4], ['富山', 'Toyama', 8, 4], ['新潟', 'Niigata', 9, 4], ['山形', 'Yamagata', 10, 4], ['宮城', 'Miyagi', 11, 4],
  ['島根', 'Shimane', 3, 5], ['鳥取', 'Tottori', 4, 5], ['兵庫', 'Hyogo', 5, 5], ['京都', 'Kyoto', 6, 5], ['福井', 'Fukui', 7, 5], ['長野', 'Nagano', 8, 5], ['群馬', 'Gunma', 9, 5], ['栃木', 'Tochigi', 10, 5], ['福島', 'Fukushima', 11, 5],
  ['山口', 'Yamaguchi', 2, 6], ['広島', 'Hiroshima', 3, 6], ['岡山', 'Okayama', 4, 6], ['大阪', 'Osaka', 5, 6], ['滋賀', 'Shiga', 6, 6], ['岐阜', 'Gifu', 7, 6], ['山梨', 'Yamanashi', 8, 6], ['埼玉', 'Saitama', 9, 6], ['茨城', 'Ibaraki', 10, 6],
  ['福岡', 'Fukuoka', 1, 7], ['愛媛', 'Ehime', 3, 7], ['香川', 'Kagawa', 4, 7], ['和歌山', 'Wakayama', 5, 7], ['奈良', 'Nara', 6, 7], ['愛知', 'Aichi', 7, 7], ['静岡', 'Shizuoka', 8, 7], ['東京', 'Tokyo', 9, 7], ['千葉', 'Chiba', 10, 7],
  ['長崎', 'Nagasaki', 0, 8], ['佐賀', 'Saga', 1, 8], ['大分', 'Oita', 2, 8], ['高知', 'Kochi', 3, 8], ['徳島', 'Tokushima', 4, 8], ['三重', 'Mie', 6, 8], ['神奈川', 'Kanagawa', 9, 8],
  ['熊本', 'Kumamoto', 1, 9], ['宮崎', 'Miyazaki', 2, 9], ['鹿児島', 'Kagoshima', 1, 10], ['沖縄', 'Okinawa', 0, 11],
];
const normRegion = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ Prefecture$/i, '').trim().toLowerCase();
const EN2PREF = Object.fromEntries(PREFS.map(p => [p[1].toLowerCase(), p]));
async function loadRegions(from, to) {
  const key = from + '|' + to;
  if (!REGION_CACHE.has(key)) REGION_CACHE.set(key, api('/regions?from=' + from + '&to=' + to));
  return REGION_CACHE.get(key);
}
const prefShort = p => p === '北海道' ? '北海道' : String(p || '').replace(/[都府県]$/, '');
function regionRows(regions, id, kin) {
  const ids = id === ALL ? topIds() : [id];
  const z = () => ({ sessions: 0, pv: 0, cv: 0, kCalls: 0, contracts: 0, revenue: 0 });
  const acc = Object.fromEntries(PREFS.map(p => [p[0], Object.assign({ pref: p[0], col: p[2], row: p[3] }, z())]));
  const other = Object.assign({ pref: '海外・不明' }, z());
  ids.forEach(x => Object.entries(regions[x] || {}).forEach(([name, v]) => {
    const p = EN2PREF[normRegion(name)], t = p ? acc[p[0]] : other;
    t.sessions += v.sessions; t.pv += v.pv; t.cv += v.keyEvents;
  }));
  if (kin) ids.forEach(x => Object.entries(kin[x] || {}).forEach(([p, v]) => { const t = acc[prefShort(p)] || other; t.kCalls += v.kCalls || 0; t.contracts += v.contracts || 0; t.revenue += v.revPartner || 0; }));
  const rows = Object.values(acc), total = rows.reduce((a, x) => a + x.sessions, 0) + other.sessions;
  rows.forEach(x => { x.cvr = x.sessions ? x.cv / x.sessions : 0; x.share = total ? x.sessions / total : 0; });
  rows.other = other; rows.total = total;
  return rows;
}
async function loadKinArea(from, to) {
  const key = 'k|' + from + '|' + to;
  if (!REGION_CACHE.has(key)) REGION_CACHE.set(key, api('/kintone-area?from=' + from + '&to=' + to).catch(() => ({})));
  return REGION_CACHE.get(key);
}
const AREA_METRICS = [['sessions', 'セッション', 'GA4'], ['pv', 'PV', 'GA4'], ['cv', 'CV', 'GA4'], ['cvr', 'CV率', 'GA4'], ['kCalls', 'コール数', 'kintone'], ['contracts', '成約数', 'kintone'], ['revenue', '収益（加盟店）', 'kintone']];
const areaSrc = k => (AREA_METRICS.find(a => a[0] === k) || [])[2] || 'GA4';
const areaVal = (k, v) => v == null ? '—' : k === 'revenue' ? '¥' + nf.format(Math.floor(v)) : nf.format(v);
const areaFmt = (k, v) => k === 'cvr' ? (v * 100).toFixed(2) + '%' : k === 'revenue' ? '¥' + nf.format(Math.floor(v)) : nf.format(v);
function tileMap(rows, k) {
  const mx = Math.max(...rows.map(x => x[k])) || 1;
  return '<div class="tilemap" role="img" aria-label="都道府県別の値">' + rows.map(x => { const p = Math.round(Math.sqrt(Math.max(x[k], 0) / mx) * 100);
    return '<div class="tile ' + (p > 55 ? 'hot' : '') + '" style="grid-column:' + (x.col + 1) + '; grid-row:' + (x.row + 1) + '; background: color-mix(in srgb, var(--accent) ' + p + '%, var(--surface-2));" title="' + x.pref + '：' + areaFmt(k, x[k]) + '">' + x.pref.slice(0, 2) + '</div>'; }).join('') + '</div><div class="scale" style="margin-top:8px">少<i></i>多</div>';
}
function viewArea() {
  const picker = monthPicker(), mm = state.ymMonth;
  if (!AREA_METRICS.find(a => a[0] === state.areaMetric)) state.areaMetric = 'sessions';
  const k = state.areaMetric, lab = (AREA_METRICS.find(a => a[0] === k) || [])[1];
  const sel = '<label class="field">指標<select id="area-metric">' + AREA_METRICS.map(a => '<option value="' + a[0] + '"' + (a[0] === k ? ' selected' : '') + '>' + a[1] + '（' + a[2] + '）</option>').join('') + '</select></label>';
  const controls = '<div class="row">' + picker + sel + '<span class="note">セッション〜CV率はGA4の「地域」、コール数・成約数・収益はkintoneのSEO回線の案件の都道府県から集計</span></div>';
  const bind = () => { bindMonthPicker(); $('area-metric').onchange = ev => { state.areaMetric = ev.target.value; render(); }; };
  const load = (m) => Promise.all([loadRegions(m + '-01', monthEnd(m)), loadKinArea(m + '-01', monthEnd(m))]);
  if (state.mode === 'compare') {
    return { html: controls + '<section class="panel" id="a-body"><p class="loading">読み込み中…</p></section>', view: 'エリア（各メディア比較）', after: async () => {
      bind();
      const [regions, kin] = await load(mm);
      const shareK = k === 'cvr' ? 'sessions' : k;
      const all = regionRows(regions, ALL, kin), top = [...all].sort((a, b) => b[shareK] - a[shareK]).slice(0, 10);
      $('a-body').innerHTML = H('メディア別 エリア構成 <small>' + mLabel(mm) + '・全体の上位10都道府県の' + (k === 'cvr' ? 'セッション' : lab) + '構成比</small>', [areaSrc(shareK)]) + '<div class="table-wrap"><table><thead><tr><th>メディア</th>' + top.map(x => '<th class="num">' + x.pref + '</th>').join('') + '</tr></thead><tbody>'
        + topIds().map(id => { const rows = regionRows(regions, id, kin), by = Object.fromEntries(rows.map(x => [x.pref, x])), tot = rows.reduce((a, x) => a + x[shareK], 0) + rows.other[shareK];
          return '<tr><td>' + esc(mediaName(id)) + '</td>' + top.map(x => { const v = tot ? by[x.pref][shareK] / tot : 0, p = Math.round(Math.min(v / 0.2, 1) * 70); return '<td class="num" style="background: color-mix(in srgb, var(--accent) ' + p + '%, transparent)">' + (v * 100).toFixed(1) + '%</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    } };
  }
  return { html: controls + '<section class="grid2 even"><div class="panel" id="a-map"><p class="loading">読み込み中…</p></div><div class="panel" id="a-rank"></div></section>', view: 'エリア（' + mediaName(state.media) + '）', after: async () => {
    bind();
    const prev = shiftMonth(mm, -1);
    const [[regions, kin], [pr, pk]] = await Promise.all([load(mm), load(prev)]);
    const rows = regionRows(regions, state.media, kin), prevBy = Object.fromEntries(regionRows(pr, state.media, pk).map(x => [x.pref, x]));
    $('a-map').innerHTML = H(lab + 'の都道府県マップ <small>' + esc(mediaName(state.media)) + '・' + mLabel(mm) + '</small>', [areaSrc(k)]) + tileMap(rows, k)
      + '<p class="note">海外・不明：' + (areaSrc(k) === 'kintone' ? lab + ' ' + areaFmt(k, rows.other[k]) : 'セッション ' + nf.format(rows.other.sessions)) + '</p>';
    const rank = [...rows].sort((a, b) => b[k] - a[k] || b.sessions - a.sessions).slice(0, 15);
    $('a-rank').innerHTML = H('上位15都道府県 <small>' + lab + 'の多い順・' + mLabel(mm) + '</small>', ['GA4', 'kintone']) + '<div class="table-wrap"><table><thead><tr><th>都道府県</th><th class="num">セッション</th><th class="num">構成比</th><th class="num">PV</th><th class="num">CV</th><th class="num">CV率</th><th class="num">コール数</th><th class="num">成約数</th>' + (noMoney() ? '' : '<th class="num">収益（加盟店）</th>') + '<th class="num">' + lab + ' 前月比</th></tr></thead><tbody>'
      + rank.map(x => '<tr><td>' + x.pref + '</td><td class="num">' + nf.format(x.sessions) + '</td><td class="num">' + (x.share * 100).toFixed(1) + '%</td><td class="num">' + nf.format(x.pv) + '</td><td class="num">' + x.cv + '</td><td class="num">' + (x.cvr * 100).toFixed(2) + '%</td><td class="num">' + areaVal('kCalls', x.kCalls) + '</td><td class="num">' + areaVal('contracts', x.contracts) + '</td>' + (noMoney() ? '' : '<td class="num">' + areaVal('revenue', x.revenue) + '</td>') + rateCell(k, x[k], prevBy[x.pref][k]) + '</tr>').join('') + '</tbody></table></div>';
  } };
}

// ================= 準備中の画面 =================
const placeholder = (title, lines) => ({ html: `<section class="panel placeholder"><h2 style="justify-content:center">${title}</h2>${lines.map(l => `<p class="note">${l}</p>`).join('')}</section>`, after: () => {} });
// ---- 記事進捗（WordPress。未連携のメディアはスプレッドシートの値） ----
let ARTICLES = null, TARGETS = {};
async function loadArticles() {
  if (!ARTICLES) {
    const [a, t] = await Promise.all([api('/articles'), api('/targets?from=2024-05&to=' + shiftMonth(CUR_MONTH, 24))]);
    ARTICLES = a; TARGETS = t;
  }
  return ARTICLES;
}
const siteOf = id => id;   // ディレクトリはディレクトリの実績（スプレッドシートの値）を使う
// ---- 目標の対象（ディレクトリがあるメディアはディレクトリごとに設定） ----
// ディレクトリごとに目標を立てるメディア（2026-10-14 ユーザー指定）。メディアの行はディレクトリの合計
const TARGET_DIR_MEDIA = ['害獣お助け', '水まわりお助け', '屋根外壁お助け'];
const TARGET_DIR_SKIP = ['過去制作', 'BEST365移管'];   // 目標を立てないディレクトリ
const targetDirs = media => TARGET_DIR_MEDIA.includes(media) ? (ARTICLE_SUBS[media] || []).filter(d => !TARGET_DIR_SKIP.includes(d)) : null;
function targetTree() {
  const out = [];
  META.media.filter(m => !m.block).forEach(m => {
    const dirs = targetDirs(m.media);
    if (dirs && dirs.length) {
      out.push({ id: m.id, name: m.name, editable: false, level: 0, kids: dirs.map(d => m.media + '|' + d) });
      dirs.forEach(d => out.push({ id: m.media + '|' + d, name: d, editable: true, level: 1 }));
      return;
    }
    const blocks = META.media.filter(b => b.media === m.media && b.block);
    const leaves = blocks.filter(b => !b.group);
    if (!leaves.length) { out.push({ id: m.id, name: m.name, editable: true, level: 0 }); return; }
    out.push({ id: m.id, name: m.name, editable: false, level: 0, kids: leaves.map(b => b.id) });
    let group = null;
    blocks.forEach(b => {
      if (b.group) { group = { id: b.id, name: b.name, editable: false, level: 1, kids: [] }; out.push(group); }
      else { if (group) group.kids.push(b.id); out.push({ id: b.id, name: b.name, editable: true, level: group ? 2 : 1 }); }
    });
  });
  return out;
}
/** 目標値。編集できる行はそのまま、メディア・グループ・累計は配下の合計 */
function targetOf(id, ym, type, src) {
  if (type === 'total') { const a = targetOf(id, ym, 'new', src), b = targetOf(id, ym, 'rewrite', src); return a == null && b == null ? null : (a || 0) + (b || 0); }
  const data = (src || TARGETS)[ym] || {};
  const tree = targetTree();
  const leafIds = id === ALL ? tree.filter(r => r.editable).map(r => r.id) : (tree.find(r => r.id === id) || {}).kids || [id];
  let sum = 0, has = false;
  leafIds.forEach(x => { const v = data[x] && data[x][type]; if (v != null) { sum += v; has = true; } });
  if (id === ALL) {   // ディレクトリに分ける前にメディア全体で入れた目標も数える（ディレクトリの目標がない月だけ）
    tree.filter(r => r.level === 0 && !r.editable).forEach(r => { const v = data[r.id] && data[r.id][type]; if (v != null && !(r.kids || []).some(k => data[k] && data[k][type] != null)) { sum += v; has = true; } });
  } else if (!has && data[id] && data[id][type] != null) return data[id][type];
  return has ? sum : null;
}
function articleInfo(id) {
  const ids = id === ALL ? topIds() : [id];
  const t = { tNew: targetOf(id, CUR_MONTH, 'new'), tRw: targetOf(id, CUR_MONTH, 'rewrite'), published: 0, scheduled: 0, pending: 0, draft: 0, hasStatus: false, connected: 0 };
  t.hasTarget = t.tNew != null || t.tRw != null; t.tNew = t.tNew || 0; t.tRw = t.tRw || 0;
  const de = id !== ALL && ent(id); if (de && de.dirSub) { t.hasStatus = true; t.published = pubCount(de.media, de.sub); t.sites = 1; return t; }   // ディレクトリは進行管理の完了の件数
  ids.map(x => ent(x) && ent(x).block ? ent(x).media : x).filter((x, i, a) => a.indexOf(x) === i).forEach(x => {
    const st = ARTICLES.settings.find(v => v.media === x), ss = ARTICLES.status.find(v => v.media === x);
    if (st && st.connected) t.connected++;
    if (ss) { t.hasStatus = true; t.published += Number(ss.published); if (ss.scheduled != null) { t.hasPipe = true; ['scheduled', 'pending', 'draft'].forEach(k => t[k] += Number(ss[k])); } }
  });
  t.sites = ids.length;
  return t;
}
const daysIn = ym => Number(monthEnd(ym).slice(8));
function progressRow(label, done, target) {
  if (target === undefined) return '<div class="row" style="justify-content:space-between; margin-top:8px"><span>' + label + '</span><span class="num">' + (done == null ? '—' : done + '本') + '</span></div>';   // 目標を立てない指標（簡易リライト・微調整）
  const day = Number(todayJst().slice(8)), expected = Math.max(day - 1, 0) / daysIn(CUR_MONTH);
  if (target == null || !target) return `<div class="row" style="justify-content:space-between; margin-top:8px"><span>${label}</span><span class="num">${done == null ? '—' : done + '本'}<span class="note">（目標未設定）</span></span></div>`;
  const r = (done || 0) / target;
  return `<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px"><div class="row" style="justify-content:space-between"><span>${label}</span><span class="num">${done == null ? 0 : done} / ${target}本（${(r * 100).toFixed(0)}%）</span></div>
    <div class="progress"><span class="${r >= expected ? 'over' : 'under'}" style="width:${Math.min(r, 1) * 100}%"></span></div></div>`;
}
function articleBlock(id) {
  const a = monthVal(siteOf(id), CUR_MONTH), info = articleInfo(id), day = Number(todayJst().slice(8));
  const sumDone = a.posts == null && a.rewrites == null && a.lite == null ? null : (a.posts || 0) + (a.rewrites || 0) + (a.lite || 0);
  return `${progressRow('新規公開', a.posts, info.hasTarget ? info.tNew : null)}${progressRow('リライト', a.rewrites, info.hasTarget ? info.tRw : null)}${progressRow('簡易リライト', a.lite, undefined)}${progressRow('微調整', a.tweak, undefined)}${progressRow('合計（新規＋リライト＋簡易リライト）', sumDone, info.hasTarget ? info.tNew + info.tRw : null)}
    <div class="pipeline"><div><span>公開中（累計）</span><b>${info.hasStatus ? nf.format(info.published) : '—'}</b></div><div><span>予約投稿</span><b>${info.hasPipe ? info.scheduled : '—'}</b></div><div><span>レビュー待ち</span><b>${info.hasPipe ? info.pending : '—'}</b></div><div><span>下書き</span><b>${info.hasPipe ? info.draft : '—'}</b></div></div>
    <p class="note" style="margin:8px 0 0">${mLabel(CUR_MONTH)}・${day}日時点。緑は昨日までの目安（${Math.round(Math.max(day - 1, 0) / daysIn(CUR_MONTH) * 100)}%）以上、黄は目安より遅れ。WordPress連携 ${info.connected}／${info.sites}サイト${info.connected < info.sites ? '（未連携のサイトは公開数・リライト数のみスプレッドシートの値）' : ''}</p>`;
}
// ================= 記事進捗（BEST半期・着地予測・日別推移・記事一覧・年間累計） =================
// BEST年度：5月〜翌4月。上期＝5〜10月、下期＝11〜翌4月
const fyOf = ym => { const [y, m] = ym.split('-').map(Number); return m >= 5 ? y : y - 1; };
const fyMonths = fy => Array.from({ length: 12 }, (_, i) => shiftMonth(fy + '-05', i));
function halfOf(ym) {
  const fy = fyOf(ym), m = Number(ym.slice(5)), upper = m >= 5 && m <= 10;
  const startYm = upper ? fy + '-05' : fy + '-11';
  return { fy, upper, start: startYm, end: shiftMonth(startYm, 5), label: fy + '年度' + (upper ? '上期' : '下期'), range: mLabel(startYm) + '〜' + mLabel(shiftMonth(startYm, 5)) };
}
const monthsFrom = (a, b) => { const out = []; for (let m = a; m <= b; m = shiftMonth(m, 1)) out.push(m); return out; };
const ART_TYPES = [['new', '新規公開'], ['rewrite', 'リライト'], ['lite', '簡易リライト'], ['tweak', '微調整'], ['total', '合計（新規＋リライト＋簡易リライト）']];
const DIR_PATHS = { 'ゴキブリ': ['/cockroach/'], 'シロアリ': ['/termite/'], 'ハチ': ['/wasp/'], 'その他害虫': ['/other-insects/'], 'コウモリ': ['/bat/'], 'ネズミ': ['/rat/'], 'その他害獣': ['/other-animals/'] };
DIR_PATHS['害虫'] = [].concat(DIR_PATHS['ゴキブリ'], DIR_PATHS['シロアリ'], DIR_PATHS['ハチ'], DIR_PATHS['その他害虫']);
DIR_PATHS['害獣'] = [].concat(DIR_PATHS['コウモリ'], DIR_PATHS['ネズミ'], DIR_PATHS['その他害獣']);
const LISTS = {};
async function loadList(ym) { if (!LISTS[ym]) LISTS[ym] = await api('/articles/list?ym=' + ym); return LISTS[ym]; }
function listFor(rows, id) {
  if (id === ALL) return rows;
  const e = ent(id); if (!e) return [];
  if (e.dirSub) {   // ディレクトリ：記事URL・タイトルで進行管理の記事と照合
    const pathOf = u => { try { return decodeURIComponent(new URL(u).pathname).replace(/\/+$/, '').toLowerCase(); } catch (x) { return ''; } }, normT = t => String(t || '').replace(/\s/g, '');
    const mine = (ITEMS || []).filter(x => x.media === e.media && x.sub === e.sub), ps = new Set(mine.map(x => x.url && pathOf(x.url)).filter(Boolean)), ts = new Set(mine.map(x => normT(x.title)).filter(Boolean));
    return rows.filter(r => r.media === e.media && (ps.has(pathOf(r.link)) || ts.has(normT(r.title))));
  }
  return rows.filter(r => r.media === e.media && (!e.block || (DIR_PATHS[e.block] || []).some(p => String(r.link).includes(p))));
}
/** 実績本数（進行管理のアップロード日で数えた本数。微調整はWordPressとの差） */
function actualOf(id, ym, type) {
  // まとまり（害虫・害獣などのグループ）の行は、配下の行の実績の合計（グループそのものの本数は集計されていないため。2026-10-29）
  const grp = id !== ALL && targetTree().find(x => x.id === id && x.level > 0 && !x.editable && (x.kids || []).length);
  if (grp) { const vs = grp.kids.map(k => actualOf(k, ym, type)); return vs.every(x => x == null) ? null : vs.reduce((a, x) => a + (x || 0), 0); }
  const v = monthVal(id, ym), n = v.posts, r = v.rewrites, l = v.lite;
  if (type === 'new') return n; if (type === 'rewrite') return r; if (type === 'lite') return l; if (type === 'tweak') return v.tweak;
  return n == null && r == null && l == null ? null : (n || 0) + (r || 0) + (l || 0);
}
const dayDone = () => YESTERDAY.slice(0, 7) === CUR_MONTH ? Number(YESTERDAY.slice(8)) : 0;   // 昨日までの日数（今月）
function forecastMonth(actual) { const d = dayDone(), dim = daysIn(CUR_MONTH); return actual == null ? null : d ? actual / d * dim : actual; }
function judge(forecast, target) {
  if (target == null || !target) return ['目標なし', 'off'];
  const r = (forecast || 0) / target;
  return r >= 1 ? ['達成見込み', 'ok'] : r >= 0.8 ? ['要注意', 'wait'] : ['未達見込み', 'ng'];
}
const pct = (a, b) => b ? Math.round((a || 0) / b * 100) + '%' : '—';
const rateColor = r => r == null ? 'transparent' : r >= 1 ? 'color-mix(in srgb, var(--good) 28%, transparent)' : r >= 0.8 ? 'color-mix(in srgb, var(--warn) 28%, transparent)' : 'color-mix(in srgb, var(--bad) 22%, transparent)';
function bar(r, expected) { return '<div class="progress"><span class="' + (r >= (expected == null ? 1 : expected) ? 'over' : 'under') + '" style="width:' + Math.min(r || 0, 1) * 100 + '%"></span></div>'; }

/** 今月の着地予測と必要ペース（1指標分） */
function monthCard(id, type, label) {
  const a = actualOf(id, CUR_MONTH, type), t = targetOf(id, CUR_MONTH, type), f = forecastMonth(a), [jl, jc] = judge(f, t);
  const dim = daysIn(CUR_MONTH), left = dim - dayDone(), need = t != null ? Math.max(t - (a || 0), 0) : null;
  return '<div class="kpi" data-src="WordPress"><div class="lbl"><span>' + label + '</span><span class="pill ' + jc + '">' + jl + '</span></div>'
    + '<div class="val">' + (a == null ? '—' : a) + '<small> / ' + (t == null ? '—' : t) + '本</small></div>'
    + (t ? bar((a || 0) / t, dayDone() / dim) : '')
    + '<div class="note">着地予測 <b class="num">' + (f == null ? '—' : Math.round(f)) + '本</b>' + (t ? '（' + pct(f, t) + '）' : '') + '</div>'
    + '<div class="note">' + (need == null ? '目標未設定' : need === 0 ? '目標達成済み' : '残り' + left + '日で <b class="num">' + need + '本</b>（1日 ' + (left ? (need / left).toFixed(1) : need) + '本・週 ' + (left ? (need / left * 7).toFixed(1) : need) + '本）') + '</div></div>';
}
/** 半期・年間の集計（実績・目標・着地予測） */
function periodStat(id, months, type) {
  let act = 0, tgt = 0, hasT = false, hasA = false, done = [];
  months.forEach(mm => {
    if (mm > CUR_MONTH) return;
    const a = actualOf(id, mm, type); if (a != null) { act += a; hasA = true; }
    if (mm < CUR_MONTH) done.push(a || 0);
  });
  let tMonths = 0; months.forEach(mm => { const t = targetOf(id, mm, type); if (t != null) { tgt += t; hasT = true; tMonths++; } });
  // 着地予測：今月は日割りペース、残りの月は直近3か月の平均ペース
  const recent = done.slice(-3), avg = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
  const curA = months.includes(CUR_MONTH) ? actualOf(id, CUR_MONTH, type) || 0 : 0;
  const future = months.filter(mm => mm > CUR_MONTH).length;
  const fc = act - curA + (months.includes(CUR_MONTH) ? forecastMonth(curA) : 0) + future * avg;
  return { act: hasA ? act : null, tgt: hasT ? tgt : null, fc: Math.round(fc), finished: months[months.length - 1] < CUR_MONTH, tMonths };
}
function halfRows(id) {
  const out = [], cur = halfOf(CUR_MONTH);
  for (let h = halfOf('2024-05'); h.start <= cur.start; h = halfOf(shiftMonth(h.end, 1))) out.push(h);
  return out.reverse();
}
function viewArticles() {
  const typeSel = state.artType || 'total';
  if (state.mode === 'compare') {
    return { html: '<section class="panel" id="ar-body"><p class="loading">読み込み中…</p></section><section class="panel" id="ar-half"></section>', view: '記事進捗（各メディア比較）', after: async () => {
      await Promise.all([loadArticles(), loadList(CUR_MONTH)]);
      const ids = targetTree().map(r => r.id), h = halfOf(CUR_MONTH), hm = monthsFrom(h.start, h.end);
      const rows = ids.map(id => {
        const a = actualOf(id, CUR_MONTH, 'total'), t = targetOf(id, CUR_MONTH, 'total'), f = forecastMonth(a);
        return { id, a, t, f, r: t ? (f || 0) / t : null, an: actualOf(id, CUR_MONTH, 'new'), tn: targetOf(id, CUR_MONTH, 'new'), ar: actualOf(id, CUR_MONTH, 'rewrite'), tr: targetOf(id, CUR_MONTH, 'rewrite'), half: periodStat(id, hm, 'total') };
      }).sort((x, y) => (x.r == null ? 9 : x.r) - (y.r == null ? 9 : y.r));
      const left = daysIn(CUR_MONTH) - dayDone();
      $('ar-body').innerHTML = H('今月の着地予測 <small>' + mLabel(CUR_MONTH) + '・昨日まで' + dayDone() + '日分・遅れている順</small>', ['WordPress']) + '<div class="table-wrap"><table><thead><tr><th>メディア</th><th class="num">新規</th><th class="num">リライト</th><th class="num">合計</th><th class="num">着地予測（合計）</th><th>判定</th><th class="num">必要ペース（1日）</th><th class="num">' + h.label + ' 合計</th><th class="num">半期着地予測</th></tr></thead><tbody>'
        + rows.map(x => { const [jl, jc] = judge(x.f, x.t), need = x.t != null ? Math.max(x.t - (x.a || 0), 0) : null, e = ent(x.id);
          return '<tr><td>' + (e && e.block ? '　' : '') + esc(mediaName(x.id)) + '</td><td class="num">' + (x.an ?? '—') + ' / ' + (x.tn ?? '—') + '</td><td class="num">' + (x.ar ?? '—') + ' / ' + (x.tr ?? '—') + '</td><td class="num">' + (x.a ?? '—') + ' / ' + (x.t ?? '—') + '</td>'
            + '<td class="num">' + (x.f == null ? '—' : Math.round(x.f)) + (x.t ? '（' + pct(x.f, x.t) + '）' : '') + '</td><td style="text-align:left"><span class="pill ' + jc + '">' + jl + '</span></td>'
            + '<td class="num">' + (need == null ? '—' : need === 0 ? '達成済み' : (left ? (need / left).toFixed(1) : need) + '本') + '</td>'
            + '<td class="num">' + (x.half.act ?? '—') + ' / ' + (x.half.tgt ?? '—') + '</td><td class="num">' + x.half.fc + (x.half.tgt ? '（' + pct(x.half.fc, x.half.tgt) + '）' : '') + '</td></tr>'; }).join('')
        + '</tbody></table></div><p class="note">着地予測：今月は昨日までの日割りペース。半期は残りの月を直近3か月の平均ペースで計算。ディレクトリの今月分は記事URLから集計。</p>';
      $('ar-half').innerHTML = H('半期の結果 <small>合計（新規＋リライト）・全メディア</small>', ['WordPress']) + halfTable(ALL);
    } };
  }
  const id = state.media, h = halfOf(CUR_MONTH), hm = monthsFrom(h.start, h.end), fy = fyOf(CUR_MONTH), fm = fyMonths(fy);
  const typeSeg = '<div class="seg" role="group" aria-label="種類">' + ART_TYPES.map(([k, l]) => '<button type="button" data-art="' + k + '" aria-pressed="' + (k === typeSel) + '">' + l.replace('（新規＋リライト＋簡易リライト）', '') + '</button>').join('') + '</div>';
  const nowLabel = mLabel(CUR_MONTH) + '・' + YESTERDAY.slice(5).replace('-', '/') + '（昨日）まで' + dayDone() + '日分';
  const mediaKey = id === ALL ? null : (ent(id) || {}).media;
  return { html: '<section class="panel" id="ar-now">' + H('今月の進捗 <small>' + nowLabel + '・' + esc(mediaName(id)) + '</small>', ['WordPress'])
      + '<div class="kpis" id="ar-cards" style="grid-template-columns: repeat(auto-fit, minmax(170px,1fr))"><p class="loading">読み込み中…</p></div>'
      + '<div class="grid2" style="margin-top:14px"><div><h3 class="am-h">日別の推移 <span class="note">' + mLabel(CUR_MONTH) + '・累積・目標ペースつき</span></h3><div class="chart-box sm"><canvas id="c-daily"></canvas></div></div><div id="ar-pipe"></div></div>'
      + '<div id="ar-list" style="margin-top:14px"><p class="loading">読み込み中…</p></div></section>'
    + '<section class="panel" id="ar-half">' + H('半期進捗 <small>' + h.label + '（' + h.range + '）</small>', ['WordPress']) + '</section>'
    + '<section class="grid2"><div class="panel">' + H('年間累計 <small>' + fy + '年度（' + mLabel(fm[0]) + '〜' + mLabel(fm[11]) + '）</small>', ['WordPress'], typeSeg) + '<div class="chart-box sm"><canvas id="c-fy"></canvas></div><div id="ar-fy"></div></div><div class="panel" id="ar-hist">' + H('半期の結果 <small>これまでの半期</small>', ['WordPress']) + '</div></section>'
    + '<section class="panel" id="ar-map">' + H('達成率マップ <small>' + fy + '年度（' + mLabel(fm[0]) + '〜' + mLabel(fm[11]) + '）・' + ART_TYPES.find(x => x[0] === typeSel)[1] + '・実績／目標</small>', ['WordPress']) + '</section>',
    view: '記事進捗（' + mediaName(id) + '）', after: async () => {
      document.querySelectorAll('[data-art]').forEach(b => b.onclick = () => { state.artType = b.dataset.art; render(); });
      const mySeq = renderSeq;   /* この描画の番号（あとから別の描画が始まったら、ここで書き込むのをやめる） */
      await Promise.all([loadArticles(), loadList(CUR_MONTH), loadItems()]);   // ディレクトリの記事の照合に進行管理の記事も使う
      if (mySeq !== renderSeq) return;
      const list = listFor(LISTS[CUR_MONTH], id);
      // 今月のカード
      $('ar-cards').innerHTML = ART_TYPES.map(([k, l]) => monthCard(id, k, l)).join('');
      // 制作中（WordPressの今の件数）
      const info = articleInfo(id);
      $('ar-pipe').innerHTML = '<h3 class="am-h">公開中の記事 <span class="note">今の件数（WordPress・毎日3時台に更新）</span></h3><div class="pipeline"><div><span>公開中（累計）</span><b>' + (info.hasStatus ? nf.format(info.published) : '—') + '</b></div></div>'
        + '<p class="note" style="margin-top:8px">着地予測は、昨日までの1日あたりのペースで月末まで進んだ場合の本数です。' + (ent(id) && ent(id).block ? '予約・下書きの件数はサイト全体の値です。' : '') + '</p>';
      // 日別推移（累積）
      const dim = daysIn(CUR_MONTH), days = Array.from({ length: dim }, (_, i) => CUR_MONTH + '-' + String(i + 1).padStart(2, '0'));
      const daily = await loadDaily(days[0], days[days.length - 1]);
      if (mySeq !== renderSeq) return;
      const cum = key => { const ser = daySeries(daily, id, key, days[0], days[days.length - 1]); let c = 0; return days.map((d, i) => { if (d > YESTERDAY) return null; c += ser[i] || 0; return c; }); };
      const tt = targetOf(id, CUR_MONTH, 'total');
      const cn = cum('posts'), cr = cum('rewrites'), cl = cum('lite');
      const ds = [{ label: '新規公開（累積）', data: cn, borderColor: css('--wp-ink'), backgroundColor: css('--wp-ink'), tension: .2, pointRadius: 0, borderWidth: 2 },
        { label: 'リライト（累積）', data: cr, borderColor: css('--s7'), backgroundColor: css('--s7'), tension: .2, pointRadius: 0, borderWidth: 2 },
        { label: '簡易リライト（累積）', data: cl, borderColor: css('--s3'), backgroundColor: css('--s3'), tension: .2, pointRadius: 0, borderWidth: 2 }];
      ds.push({ label: '合計（累積）', data: cn.map((v, i) => v == null ? null : v + cr[i] + cl[i]), borderColor: css('--fg'), tension: .2, pointRadius: 0, borderWidth: 1.5 });
      if (tt) ds.push({ label: '合計の目標ペース', data: days.map((d, i) => +(tt * (i + 1) / dim).toFixed(1)), borderColor: css('--muted'), borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 });
      chart('c-daily', { type: 'line', data: { labels: days.map(d => Number(d.slice(8)) + '日'), datasets: ds }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 10 }, grid: { color: css('--grid') } }, y: { ticks: { color: css('--muted'), precision: 0 }, grid: { color: css('--grid') }, beginAtZero: true } } }) });
      // 今月の記事一覧（今月の枠の中）
      const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date)), hasUpd = list.some(r => r.kind === 'rewrite');
      await loadItems();
      if (mySeq !== renderSeq) return;
      const pathOf = u => { try { return decodeURIComponent(new URL(u).pathname).replace(/\/+$/, '').toLowerCase(); } catch (e) { return ''; } }, normT = t => String(t || '').replace(/\s/g, '');
      const byPath = new Map(), byTitle = new Map();
      ITEMS.forEach(x => { const k = x.url && pathOf(x.url); if (k && !byPath.has(x.media + k)) byPath.set(x.media + k, x); if (x.title) byTitle.set(x.media + normT(x.title), x); });
      const itemOf = r => byPath.get(r.media + pathOf(r.link)) || byTitle.get(r.media + normT(r.title)) || null;
      const NOW_INFO = [['genre', 'カテゴリ'], ['urgency', '緊急性'], ['target', 'ターゲット層'], ['query_type', 'クエリタイプ'], ['position', 'ポジション']];   // タイトルの右に記事の情報（2026-10-27 ユーザー指定）
      const showSup = sorted.some(r => isSupMedia(r.media)), who = (x, k) => x && x[k] ? esc(personName(x[k], x.media)) : '<span class="note">—</span>';   // 更新した記事があるときだけ「最初の公開日」の列
      $('ar-list').innerHTML = '<h3 class="am-h">WordPressで今月公開・更新された記事 <span class="note">' + mLabel(CUR_MONTH) + '・新規公開 ' + list.filter(r => r.kind === 'new').length + '本・更新 ' + list.filter(r => r.kind === 'rewrite').length + '本（照合用）</span></h3>'
        + (sorted.length ? '<div class="table-wrap"><table class="am-table now-list"><thead><tr><th class="c-ctr w-date">日付</th><th class="c-ctr w-kind">種類</th>' + (id === ALL ? '<th class="c-txt w-media">メディア</th>' : '') + '<th class="c-txt">タイトル</th>' + NOW_INFO.map(([, l]) => '<th class="c-txt">' + l + '</th>').join('') + '<th class="c-txt">構成</th><th class="c-txt">執筆</th><th class="c-txt">アップロード</th>' + (showSup ? '<th class="c-txt">監修</th>' : '') + (hasUpd ? '<th class="c-ctr w-first">最初の公開日</th>' : '') + '</tr></thead><tbody>'
          + sorted.map(r => '<tr><td class="c-ctr">' + r.date.slice(5).replace('-', '/') + '</td><td class="c-ctr"><span class="pill ' + (r.kind === 'new' ? 'ok' : 'wait') + '">' + (r.kind === 'new' ? '新規公開' : '更新') + '</span></td>'
            + (id === ALL ? '<td class="c-txt">' + esc((META.media.find(m => m.media === r.media && !m.block) || {}).name || r.media) + '</td>' : '')
            + '<td class="c-txt title-cell"><a href="' + escUrl(r.link) + '" target="_blank" rel="noopener" title="' + esc(r.title) + '">' + esc(r.title) + '</a></td>'
            + (x => NOW_INFO.map(([k]) => '<td class="c-txt">' + (x && x[k] ? esc(x[k]) : '<span class="note">—</span>') + '</td>').join('') + '<td class="c-txt">' + who(x, 'director') + '</td><td class="c-txt">' + who(x, 'writer') + '</td><td class="c-txt">' + who(x, 'upload_owner') + '</td>' + (showSup ? '<td class="c-txt">' + who(x, 'supervisor') + '</td>' : ''))(itemOf(r))
            + (hasUpd ? '<td class="c-ctr">' + (r.kind === 'rewrite' ? r.published.replace(/-/g, '/') : '<span class="note">—</span>') + '</td>' : '') + '</tr>').join('')
          + '</tbody></table></div>' : '<p class="empty">今月はまだ公開・リライトされた記事がありません</p>')
        + '<p class="note">WordPressの公開済みの投稿です（10分ごとに更新）。「更新」は先月以前に公開されて今月更新された記事で、このうち進行管理のリライト・簡易リライトにない分が「微調整」です。上の本数とグラフは進行管理のアップロード日で数えています。</p>';
      // BEST半期進捗
      const dimRate = (hm.indexOf(CUR_MONTH) + dayDone() / dim) / 6;
      $('ar-half').innerHTML = H('半期進捗 <small>' + h.label + '（' + h.range + '）・' + esc(mediaName(id)) + '・経過 ' + Math.round(dimRate * 100) + '%</small>', ['WordPress'])
        + '<div class="table-wrap"><table><thead><tr><th>種類</th><th class="num">実績</th><th class="num">半期目標</th><th style="min-width:160px">進捗</th><th class="num">着地予測</th><th>判定</th><th class="num">残り必要本数</th>' + hm.map(mm => '<th class="num">' + Number(mm.slice(5)) + '月</th>').join('') + '</tr></thead><tbody>'
        + ART_TYPES.map(([k, l]) => { const st = periodStat(id, hm, k), [jl, jc] = judge(st.fc, st.tgt);
          return '<tr><td>' + l + '</td><td class="num">' + (st.act ?? '—') + '</td><td class="num">' + (st.tgt ?? '—') + '</td><td>' + (st.tgt ? bar((st.act || 0) / st.tgt, dimRate) : '') + '</td><td class="num">' + st.fc + (st.tgt ? '（' + pct(st.fc, st.tgt) + '）' : '') + '</td><td style="text-align:left"><span class="pill ' + jc + '">' + jl + '</span></td><td class="num">' + (st.tgt == null ? '—' : Math.max(st.tgt - (st.act || 0), 0)) + '</td>'
            + hm.map(mm => { const a = mm <= CUR_MONTH ? actualOf(id, mm, k) : null, t = targetOf(id, mm, k), r = a != null && t ? a / t : null; return '<td class="num" style="background:' + (mm < CUR_MONTH ? rateColor(r) : 'transparent') + '">' + (a ?? '—') + '<span class="note">/' + (t ?? '—') + '</span></td>'; }).join('') + '</tr>'; }).join('')
        + '</tbody></table></div><p class="note">着地予測：今月は昨日までの日割りペース、残りの月は直近3か月の平均ペースで計算。月の色は達成率（緑100%以上・黄80%以上・赤80%未満）。</p>';
      // 年間累計
      let ca = 0, ct = 0;
      const cumA = fm.map(mm => { if (mm > CUR_MONTH) return null; ca += actualOf(id, mm, typeSel) || 0; return ca; });
      const cumT = fm.map(mm => { const t = targetOf(id, mm, typeSel); ct += t || 0; return ct || null; });
      chart('c-fy', { type: 'bar', data: { labels: fm.map(mm => Number(mm.slice(5)) + '月'), datasets: [
        { label: '実績（月）', data: fm.map(mm => mm > CUR_MONTH ? null : actualOf(id, mm, typeSel)), backgroundColor: css('--wp-soft'), borderRadius: 2 },
        { label: '累計実績', data: cumA, type: 'line', borderColor: css('--wp-ink'), backgroundColor: css('--wp-ink'), pointRadius: 2, tension: .2 },
        { label: '累計目標', data: cumT, type: 'line', borderColor: css('--muted'), borderDash: [5, 4], pointRadius: 0, tension: .2 },
      ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { display: false } }, y: { ticks: { color: css('--muted'), precision: 0 }, grid: { color: css('--grid') }, beginAtZero: true } } }) });
      const fyst = periodStat(id, fm, typeSel);
      $('ar-fy').innerHTML = '<p class="note">' + fy + '年度の年間実績 <b class="num">' + (fyst.act ?? '—') + '</b> ／ 年間目標 <b class="num">' + (fyst.tgt ?? '—') + '</b>（' + pct(fyst.act, fyst.tgt) + '）・年間着地予測 <b class="num">' + fyst.fc + '</b>' + (fyst.tgt ? '（' + pct(fyst.fc, fyst.tgt) + '）' : '') + '</p>';
      $('ar-hist').innerHTML = H('半期の結果 <small>' + esc(mediaName(id)) + '・これまでの半期</small>', ['WordPress']) + halfTable(id);
      // 達成率マップ（メディアを選んでいるときは、そのメディア（とディレクトリ）だけ）
      const tree = targetTree().filter(r => !mediaKey || ((ent(r.id) || {}).media === mediaKey && (!(ent(id) || {}).dirSub || r.id === id)));   // ディレクトリを選んだときはその行だけ
      const cell = (rid, mm) => { const a = mm <= CUR_MONTH ? actualOf(rid, mm, typeSel) : null, t = targetOf(rid, mm, typeSel), rr = a != null && t ? a / t : null; return '<td class="num" style="background:' + (mm < CUR_MONTH ? rateColor(rr) : 'transparent') + '">' + (a ?? '—') + '<span class="note">/' + (t ?? '—') + '</span></td>'; };
      $('ar-map').innerHTML = H('達成率マップ <small>' + fy + '年度（' + mLabel(fm[0]) + '〜' + mLabel(fm[11]) + '）・' + esc(mediaName(id)) + '・' + ART_TYPES.find(x => x[0] === typeSel)[1] + '・実績／目標</small>', ['WordPress'], typeSeg)
        + '<div class="table-wrap"><table class="ttable"><thead><tr><th>メディア</th>' + fm.map(mm => '<th class="num">' + Number(mm.slice(5)) + '月</th>').join('') + '<th class="num">年間</th></tr></thead><tbody>'
        + tree.map(r => { const st = periodStat(r.id, fm, typeSel);
          return '<tr class="' + (r.editable ? '' : 'calc') + '"><td style="padding-left:' + (10 + r.level * 18) + 'px">' + esc(r.name) + '</td>' + fm.map(mm => cell(r.id, mm)).join('') + '<td class="num"><b>' + (st.act ?? '—') + '</b><span class="note">/' + (st.tgt ?? '—') + '</span></td></tr>'; }).join('')
        + (mediaKey ? '' : '<tr class="total"><td>全メディア合計</td>' + fm.map(mm => cell(ALL, mm)).join('') + '<td class="num"><b>' + (periodStat(ALL, fm, typeSel).act ?? '—') + '</b><span class="note">/' + (periodStat(ALL, fm, typeSel).tgt ?? '—') + '</span></td></tr>')
        + '</tbody></table></div><p class="note">色は終わった月の達成率（緑100%以上・黄80%以上・赤80%未満）。今月以降は色なし。</p>';
      document.querySelectorAll('[data-art]').forEach(b => b.onclick = () => { state.artType = b.dataset.art; render(); });
    } };
}
function halfTable(id) {
  const hs = halfRows(id);
  return '<div class="table-wrap"><table><thead><tr><th>期間</th>' + ART_TYPES.map(([, l]) => '<th class="num">' + l.replace('（新規＋リライト）', '') + '</th>').join('') + '<th>結果</th></tr></thead><tbody>'
    + hs.map(h => { const ms = monthsFrom(h.start, h.end), st = ART_TYPES.map(([k]) => periodStat(id, ms, k)), tot = st[ART_TYPES.findIndex(x => x[0] === 'total')], finished = h.end < CUR_MONTH, partial = x => x.tgt != null && x.tMonths < ms.length;
      const [jl, jc] = partial(tot) ? ['目標が一部の月だけ', 'off'] : finished ? (tot.tgt ? ((tot.act || 0) >= tot.tgt ? ['達成', 'ok'] : ['未達', 'ng']) : ['目標なし', 'off']) : judge(tot.fc, tot.tgt);
      return '<tr><td>' + h.label + '<br><span class="note">' + h.range + '</span></td>' + st.map(x => '<td class="num">' + (x.act ?? '—') + '<span class="note">/' + (x.tgt ?? '—') + '</span><br><span class="note">' + (partial(x) ? '目標は' + x.tMonths + 'か月分' : pct(x.act, x.tgt)) + '</span></td>').join('')
        + '<td style="text-align:left"><span class="pill ' + jc + '">' + (finished ? jl : '進行中・' + jl) + '</span></td></tr>'; }).join('')
    + '</tbody></table></div>';
}
/** API・連携設定：AI で情報を読み取ってよいアカウント（承認）と、検知した記録（2026-10-28 ユーザー指定） */
async function drawAiAccess() {
  const box = $('api-ai'); if (!box) return;
  let d; try { d = await api('/admin/ai-access'); } catch (e) { box.innerHTML = '<div class="panel-head"><h2>AI からのアクセス</h2></div><p class="note">' + esc(e.message) + '</p>'; return; }
  const KIND = { bot: 'AI の収集ロボット（ブロック済み）', automation: '画面の自動操作', rate: '大量の読み込み' };
  box.innerHTML = '<div class="panel-head"><h2>AI からのアクセス</h2><span class="pill ' + (d.alerts.length ? 'wait' : 'ok') + '">' + (d.alerts.length ? '検知 ' + d.alerts.length + '件' : '検知なし') + '</span></div>'
    + '<p class="note">ログインしていない人や AI には、ログイン画面だけを配っています（ダッシュボードの本体とデータは、登録済みのアカウントでログインした人だけ）。名乗っている AI の収集ロボットは入口で断り、検索・AI 学習の対象外にしています。ログインした人の画面が自動操作されている、または短時間に大量に読み込んでいるときは、下の「承認したアカウント」以外なら記録して、本人の画面に表示し、日比野さんへメールします' + (d.queued ? '（メールの送信のしくみの準備中のため、送信待ち ' + d.queued + '件）' : '') + '。</p>'
    + '<h3 class="am-h">承認したアカウント <span class="note">AI で読み取ってもよいアカウント。検知の対象外</span></h3>'
    + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">メールアドレス</th><th class="c-txt">メモ</th><th class="c-txt">承認した人・日</th><th class="c-ctr">操作</th></tr></thead><tbody>'
    + (d.approved.length ? d.approved.map(a => '<tr><td class="c-txt">' + esc(a.email) + '</td><td class="c-txt">' + esc(a.note || '') + '</td><td class="c-txt">' + esc((a.by || '') + ' ' + String(a.at || '').slice(0, 10)) + '</td><td class="c-ctr"><button class="btn sm" type="button" data-aidel="' + esc(a.email) + '">承認を外す</button></td></tr>').join('') : '<tr><td class="c-txt" colspan="4"><span class="note">まだありません</span></td></tr>')
    + '</tbody></table></div>'
    + '<div class="row" style="gap:8px; flex-wrap:wrap; align-items:flex-end; margin:8px 0 14px"><label class="field">アカウント<input id="ai-email" list="ai-users" placeholder="メールアドレス"><datalist id="ai-users">' + d.users.map(u => '<option value="' + esc(u.email) + '">' + esc(u.name) + '</option>').join('') + '</datalist></label><label class="field">メモ<input id="ai-note" placeholder="例：分析で Claude を使う"></label><button class="btn primary" type="button" id="ai-add">承認する</button></div>'
    + '<h3 class="am-h">検知した記録 <span class="note">新しい順・100件まで</span></h3>'
    + (d.alerts.length ? '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-ctr">日時</th><th class="c-txt">内容</th><th class="c-txt">アカウント</th><th class="c-txt">場所</th><th class="c-txt">ブラウザなど</th></tr></thead><tbody>'
      + d.alerts.map(a => '<tr><td class="c-ctr">' + esc(String(a.at || '').slice(0, 16).replace('T', ' ')) + '</td><td class="c-txt">' + esc(KIND[a.kind] || a.label || a.kind) + (a.detail ? '<br><span class="note">' + esc(a.detail) + '</span>' : '') + '</td><td class="c-txt">' + esc(a.email || '（ログインなし）') + '</td><td class="c-txt">' + esc(a.path || '') + '</td><td class="c-txt"><span class="note">' + esc(String(a.ua || '').slice(0, 80)) + '</span></td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">検知した記録はありません</p>');
  $('ai-add').onclick = async () => { try { await apiSend('PUT', '/admin/ai-access', { email: $('ai-email').value.trim(), note: $('ai-note').value.trim() }); toast('承認しました'); drawAiAccess(); } catch (e) { alert(e.message); } };
  box.querySelectorAll('[data-aidel]').forEach(b => b.onclick = async () => { if (!confirm(b.dataset.aidel + ' の承認を外しますか？')) return; try { await apiSend('DELETE', '/admin/ai-access/' + encodeURIComponent(b.dataset.aidel), {}); toast('承認を外しました'); drawAiAccess(); } catch (e) { alert(e.message); } });
}

// ================= KW追従（Ahrefs Rank Tracker） =================
// 順位の帯（サマリ・KW追従で共通）
const RANK_BANDS = [['1〜3位', p => p != null && p <= 3, () => css('--good')], ['4〜10位', p => p > 3 && p <= 10, () => 'color-mix(in srgb, ' + css('--good') + ' 45%, transparent)'], ['11〜30位', p => p > 10 && p <= 30, () => css('--warn')], ['31位〜', p => p > 30, () => css('--muted')], ['圏外', p => p == null, () => css('--grid')]];
const MONEY_BLUE = '#3d7be0', MONEY_RED = '#d9534f';   // 収益は青、支出は赤
const ACT_LABEL = { new: '新規記事', rewrite: 'リライト', lite: '簡易リライト' };
const ymdShort = d => d ? d.slice(2, 4) + '/' + Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : '';
/** KW追従から進行管理にリライト候補を追加（選んだKWごとにリライト／簡易リライトを選ぶ） */
async function openRewriteCandidate(list, done) {
  const opt = i => '<label class="rw-opt"><input type="radio" name="rw-' + i + '" value="リライト" checked>リライト</label><label class="rw-opt"><input type="radio" name="rw-' + i + '" value="簡易リライト">簡易リライト</label>';
  openModal('<h2>リライト候補にする <small class="note">' + list.length + '件</small></h2>'
    + (list.length > 1 ? '<div class="row" style="gap:6px; margin-bottom:6px"><span class="note">まとめて：</span><button class="btn sm" type="button" data-rwall="リライト">すべてリライト</button><button class="btn sm" type="button" data-rwall="簡易リライト">すべて簡易リライト</button></div>' : '')
    + '<div class="rw-list">' + list.map((x, i) => '<div class="rw-row"><span class="rw-kw" title="' + esc(x.kw) + '">' + esc(x.kw) + (list.some(y => y.media !== x.media) ? ' <span class="note">' + esc(mediaLabel(x.media)) + '</span>' : '') + '</span><span class="rw-opts">' + opt(i) + '</span></div>').join('') + '</div>'
    + '<p class="note">No.・記事URL・検索Volは元の記事（同じKWの新規記事）から入ります。進行状況は「未着手」で追加します。</p><p class="err" id="rw-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="rw-go">進行管理に追加</button></div>');
  document.querySelectorAll('[data-rwall]').forEach(b => b.onclick = () => document.querySelectorAll('.rw-list input[value="' + b.dataset.rwall + '"]').forEach(r => { r.checked = true; }));
  $('rw-go').onclick = async () => {
    const fail = m => { $('rw-err').innerHTML = m; $('rw-err').hidden = false; };
    $('rw-go').disabled = true; $('rw-go').textContent = '追加しています…';
    try { await loadItems(); } catch (e) { $('rw-go').disabled = false; return fail(esc(e.message)); }
    const nk = x => String(x || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, '').toLowerCase();
    const ng = [];
    let ok = 0;
    for (const [i, { media, kw }] of list.entries()) {
      const type = (document.querySelector('input[name="rw-' + i + '"]:checked') || {}).value || 'リライト';
      const same = ITEMS.filter(x => x.media === media && nk(x.kw) === nk(kw));
      const src = same.find(x => /新規/.test(x.type || '')) || same.sort((a, b) => String(a.upload_date || '9').localeCompare(String(b.upload_date || '9')))[0];
      if (!src) { ng.push(kw + '（進行管理に同じKWの記事がありません）'); continue; }
      const body = { media, kw: src.kw, type, status: '未着手', no: src.no || null, url: src.url || null };
      if (src.sub) body.sub = src.sub;
      try { const res = await apiSend('POST', '/article-items', body); ITEMS.push(Object.assign({}, body, { key: res.key, source: 'dashboard', vol_avg: src.vol_avg, title: src.title })); ok++; }
      catch (e) { ng.push(kw + '（' + e.message + '）'); }
    }
    if (ng.length) { $('rw-go').textContent = '閉じる'; $('rw-go').disabled = false; $('rw-go').onclick = () => { closeModal(); if (done) done(); }; return fail(ok + '件を追加しました。追加できなかったKW：<br>' + ng.map(esc).join('<br>')); }
    closeModal(); if (done) done();
  };
}
const rankCls = p => p == null ? 'rk-out' : p <= 3 ? 'rk-top3' : p <= 10 ? 'rk-top10' : p <= 30 ? 'rk-top30' : 'rk-low';
const rankTxt = p => p == null ? '圏外' : String(Math.round(p));
/** CV率のマス：CV÷PV、小数1桁。1%以上＝青、0.5%以上＝黄、0.5%未満＝赤（2026-11-13 ユーザー指定） */
function kwCvrCell(g) {
  if (!g || !(g.pv > 0)) return '<td class="c-ctr kw-mc"><span class="note">—</span></td>';
  const v = (g.cv || 0) / g.pv * 100, c = v >= 1 ? 'hi' : v >= 0.5 ? 'mid' : 'lo';
  return '<td class="c-ctr kw-mc"><span class="kw-cvr kw-cvr-' + c + '">' + v.toFixed(1) + '%</span></td>';
}
function viewKw() {
  const f = state.kwFilter = state.kwFilter || { device: 'all', sort: 'vol', q: '', cell: 'rank' };
  if (!f.devAll) { f.device = 'all'; f.devAll = true; }   /* はじめは「全体」（SP・PCの平均。2026-11-02 ユーザー指定） */
  f.cell = f.cell || 'rank';
  const e = state.media === ALL ? null : ent(state.media), media = e ? e.media : null;
  return { html: '<section class="panel" id="kw-body"><p class="loading">読み込み中…</p></section>', view: 'KW追従', after: async () => {
    const isAll = !media;   // メディア累計：全メディアのKWを1つの表に
    const d = await api('/kw-rank?media=' + encodeURIComponent(isAll ? '__all__' : media) + (isAll ? '&full=1' : ''));
    const draw = () => {
    clearCharts();
    const rowsBoth = d.rows.filter(r => (!e || !e.block || String(r.tags || '').split('、').includes(e.block))), rows = rowsBoth.filter(r => r.device === f.device);
    const months = [...new Set(rowsBoth.map(r => r.ym))].sort();
    const head = H('KW追従 <small>' + esc(mediaName(state.media)) + '・Ahrefs Rank Tracker</small>', ['Ahrefs']) + (d.pending ? '<div class="art-alert">⚠ Rank Tracker のKW上限に達したため、' + (isAll ? '全メディア' : 'このメディア') + 'の完了記事のKWのうち <b>' + d.pending + '件</b> が未登録です（順位を取得していません）。上限を増やすと、次の同期で自動で追加します。</div>' : '');
    if (!months.length) {
      $('kw-body').innerHTML = head + '<p class="empty">' + (d.connected ? (d.project ? 'まだ順位を取得していません。毎月2日に前月末時点の順位を自動で取得します（管理 →「API・連携設定」の Ahrefs から今すぐ取得もできます）。' : 'このメディアの Rank Tracker プロジェクトはまだありません。毎週月曜に、進行管理で「完了」の記事のKWを自動で登録します。') : 'Ahrefs と未接続です。管理者が「API・連携設定」で Ahrefs の APIキーを保存すると、自動で連携が始まります。') + '</p>';
      return;
    }
    const last = months[months.length - 1], prev = months[months.length - 2];
    const canRw = canEditArticles();   // 進行管理に追加できる人だけチェックボックス
    const byKw = new Map();
    rowsBoth.forEach(r => { const rm = r.media || media, k = rm + '|' + r.keyword; const o = byKw.get(k) || { kw: r.keyword, media: rm, pos: {}, posBy: { mobile: {}, desktop: {} }, url: null, vol: null, traffic: null, kd: null }; const p = r.position == null ? null : Number(r.position); (o.posBy[r.device] || (o.posBy[r.device] = {}))[r.ym] = p; if (r.device === f.device) o.pos[r.ym] = p; if (r.ym === last && (r.device === f.device || o.url == null)) { o.url = r.url; o.vol = r.volume == null ? null : Number(r.volume); o.traffic = r.traffic == null ? null : Number(r.traffic); o.kd = r.kd == null ? null : Number(r.kd); } byKw.set(k, o); });
    /* 全体：SP・PCの順位の平均（片方が圏外ならもう片方、両方圏外なら圏外） */
    const avgPos = (o, m) => { const sp = o.posBy.mobile || {}, pc = o.posBy.desktop || {}, n = [sp[m], pc[m]].filter(v => v != null); return n.length ? n.reduce((a, v) => a + v, 0) / n.length : null; };
    if (f.device === 'all') byKw.forEach(o => { o.pos = {}; new Set([...Object.keys(o.posBy.mobile || {}), ...Object.keys(o.posBy.desktop || {})]).forEach(m => { o.pos[m] = avgPos(o, m); }); });
    const normK = x => String(x || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const pathOf = u => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch (e) { return null; } };
    const looseK = x => normK(x).replace(/\s+/g, '');
    const arts = new Map((d.articles || []).map(x => [(x.media || media) + '|' + x.kw, x]));
    const ga = {}; (d.pages || []).forEach(p => { const k = (p.media || media) + '|' + (String(p.page_path || '').split('?')[0].replace(/\/+$/, '') || '/'); const o = (ga[k] = ga[k] || {}); const c = (o[p.ym] = o[p.ym] || { pv: 0, cv: 0 }); c.pv += Number(p.pv) || 0; c.cv += Number(p.cv) || 0; });
    byKw.forEach(o => { o.art = arts.get(o.media + '|' + looseK(o.kw)) || {}; o.mismatch = !o.art.url ? 'KWが進行管理にありません' : (o.url && pathOf(o.url) !== pathOf(o.art.url) ? '検索結果に出ているのは別のページです：' + o.url : ''); o.link = o.art.url || o.url; o.page = pathOf(o.link); o.ga = (o.page && ga[o.media + '|' + o.page]) || {}; });
    if (!isAll && state.artSub && artSubs(media)) [...byKw.keys()].forEach(k => { if (!((byKw.get(k).art || {}).subs || []).includes(state.artSub)) byKw.delete(k); });   // ディレクトリを選んでいるときは、そのディレクトリの記事のKWだけ
    /* 全角・半角、カタカナ・ひらがなの違いを無視して絞り込む。空白で区切ると、すべての語を含むKW（2026-11-05 ユーザー指定） */
    const kanaK = x => looseK(x).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)), qWords = normK(f.q).split(' ').map(kanaK).filter(Boolean);
    let list = [...byKw.values()].filter(o => { const k = kanaK(o.kw); return qWords.every(w => k.includes(w)); });
    const hasKd = [...byKw.values()].some(o => o.kd != null);   // KD は Rank Tracker に値があるメディアだけ列を出す（2026-10-27 ユーザー指定）
    const cur = o => o.pos[last], diff = o => o.pos[prev] == null || cur(o) == null ? null : o.pos[prev] - cur(o);
    /* CV率＝CV÷PV（最新の月。PVがない記事は並び替えでいちばん下）（2026-11-13 ユーザー指定） */
    const cvrOf = o => { const g = o.ga[last]; return g && g.pv > 0 ? (g.cv || 0) / g.pv * 100 : null; };
    const sorters = { cvrhi: (a, b) => (cvrOf(a) == null) - (cvrOf(b) == null) || (cvrOf(b) || 0) - (cvrOf(a) || 0), cvrlo: (a, b) => (cvrOf(a) == null) - (cvrOf(b) == null) || (cvrOf(a) || 0) - (cvrOf(b) || 0), vol: (a, b) => (b.vol || 0) - (a.vol || 0), pos: (a, b) => (cur(a) == null ? 999 : cur(a)) - (cur(b) == null ? 999 : cur(b)), up: (a, b) => (diff(b) || 0) - (diff(a) || 0), down: (a, b) => (diff(a) || 0) - (diff(b) || 0), traffic: (a, b) => (b.traffic || 0) - (a.traffic || 0), pv: (a, b) => ((b.ga[last] || {}).pv || 0) - ((a.ga[last] || {}).pv || 0), cv: (a, b) => ((b.ga[last] || {}).cv || 0) - ((a.ga[last] || {}).cv || 0) || ((b.ga[last] || {}).pv || 0) - ((a.ga[last] || {}).pv || 0) };   /* CVが多い順（2026-10-28 ユーザー指定）。同じなら PV */
    list.sort(sorters[f.sort] || sorters.vol);
    // 順位の分布（最新月）
    const all = [...byKw.values()], bands = [['1〜3位', o => cur(o) != null && cur(o) <= 3, 'rk-top3'], ['4〜10位', o => cur(o) > 3 && cur(o) <= 10, 'rk-top10'], ['11〜30位', o => cur(o) > 10 && cur(o) <= 30, 'rk-top30'], ['31位〜', o => cur(o) > 30, 'rk-low'], ['圏外', o => cur(o) == null, 'rk-out']];
    const showMonths = months.slice(-12);
    const BAND_FN = { 'rk-top3': p => p != null && p <= 3, 'rk-top10': p => p > 3 && p <= 10, 'rk-top30': p => p > 10 && p <= 30, 'rk-low': p => p > 30, 'rk-out': p => p == null };
    const bandCount = (c, m) => all.filter(o => m in o.pos && BAND_FN[c](o.pos[m])).length;
    $('kw-body').innerHTML = head
      + '<h3 class="am-h">順位分布の推移 <span class="note">月末時点のKW数（' + (f.device === 'all' ? '全体＝SP・PCの平均' : f.device === 'mobile' ? 'スマホ' : 'PC') + '）</span></h3><div class="chart-box sm"><canvas id="c-kwdist"></canvas></div>'
      + '<div class="row" style="margin:14px 0 10px"><span class="note">グラフ・件数の端末</span><div class="seg" role="group" aria-label="グラフ・件数の端末"><button type="button" data-dev="all" aria-pressed="' + (f.device === 'all') + '">全体</button><button type="button" data-dev="mobile" aria-pressed="' + (f.device === 'mobile') + '">スマホ</button><button type="button" data-dev="desktop" aria-pressed="' + (f.device === 'desktop') + '">PC</button></div>'
      + '<label class="field">並び替え<select id="kw-sort">' + [['vol', '検索Volが多い順'], ['pos', '順位が高い順'], ['up', '前月から上がった順'], ['down', '前月から下がった順'], ['pv', 'PVが多い順（GA4）'], ['cv', 'CVが多い順（GA4）'], ['cvrhi', 'CV率が高い順（GA4）'], ['cvrlo', 'CV率が低い順（GA4）']].map(([k, l]) => '<option value="' + k + '"' + (f.sort === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
      + '<label class="field">キーワード<input id="kw-q" type="search" value="' + esc(f.q) + '" placeholder="KWで絞り込み"></label><span class="note">' + mLabel(last) + '末時点・' + all.length + 'KW</span></div>'
      + '<div class="kw-bands">' + bands.map(([l, fn, c]) => { const n = bandCount(c, last), cmp = (m, lab) => { if (!m || !months.includes(m)) return '<span class="kw-cmp">' + lab + ' —</span>'; const x = n - bandCount(c, m), good = c === 'rk-low' || c === 'rk-out' ? x < 0 : x > 0; return '<span class="kw-cmp ' + (x === 0 ? '' : good ? 'kw-up' : 'kw-down') + '">' + lab + ' ' + (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x) + '</span>'; }; return '<div class="kw-band ' + c + '"><span>' + l + '</span><b>' + n + '</b><div class="kw-cmps">' + cmp(prev, '前月比') + cmp(shiftMonth(last, -12), '前年比') + '</div></div>'; }).join('') + '</div>'
      + (canRw ? '<div class="row bulk-bar" id="kw-bulk" hidden><b id="kw-bulk-n" class="num"></b><button class="btn primary" type="button" id="kw-bulk-go">リライト候補にする</button><button class="btn" type="button" id="kw-bulk-clear">選択を解除</button></div>' : '')
      + '<div class="table-wrap am-scroll"><table class="am-table kw-table"><thead><tr>' + (canRw ? '<th class="c-ctr kw-chk" rowspan="2"></th>' : '') + '<th class="c-txt" rowspan="2">記事</th><th class="c-ctr" rowspan="2">最新のアクション</th><th class="c-txt" rowspan="2">検索KW</th>' + (isAll ? '<th class="c-txt" rowspan="2">メディア</th>' : '') + '<th class="c-num" rowspan="2">検索Vol</th>' + (hasKd ? '<th class="c-num" rowspan="2" title="キーワード難易度（Ahrefs）：検索結果の上位10位に入る難しさ。0〜100で、大きいほど難しい">KD</th>' : '') + [...showMonths].reverse().map(m => '<th class="c-ctr kw-mh" colspan="6">' + mLabel(m) + '</th>').join('') + '</tr><tr>' + showMonths.map(() => '<th class="c-ctr kw-m1 kw-mc" title="SPとPCの順位の平均（片方が圏外ならもう片方の順位）">全体</th><th class="c-ctr kw-mc">SP</th><th class="c-ctr kw-mc">PC</th><th class="c-num kw-mc">PV</th><th class="c-num kw-mc">CV</th><th class="c-ctr kw-mc" title="CV÷PV。1%以上＝青、0.5%以上1%未満＝黄、0.5%未満＝赤">CV率</th>').join('') + '</tr></thead><tbody>'
      + list.map((o, i) => { const df = diff(o); return '<tr>' + (canRw ? '<td class="c-ctr kw-chk">' + (o.art.candidate ? '<input type="checkbox" disabled title="進行管理に' + ACT_LABEL[o.art.candidate] + 'の予定があります">' : '<input type="checkbox" data-kwpick="' + i + '">') + '</td>' : '')
        + '<td class="c-txt kw-art' + (o.mismatch ? ' kw-mis' : '') + '"' + (o.mismatch ? ' title="' + esc(o.mismatch) + '"' : '') + '>' + (o.link ? '<a href="' + escUrl(o.link) + '" target="_blank" rel="noopener" title="' + esc((o.art.title ? o.art.title + '\n' : '') + o.link) + '">' + esc(o.art.title || o.link.replace(/^https?:\/\/[^/]+/, '')) + '</a>' : '<span class="note">—</span>') + '</td>'
        + '<td class="c-ctr kw-act">' + (o.art.action ? '<span class="act act-' + o.art.action.kind + '">' + ACT_LABEL[o.art.action.kind] + ' ' + ymdShort(o.art.action.date) + '</span>' : '<span class="note">—</span>') + (o.art.candidate ? ' <span class="act act-cand" title="進行管理に' + ACT_LABEL[o.art.candidate] + 'の予定があります">候補済み</span>' : '') + '</td>'
        + '<td class="c-txt kw-cell"><b>' + esc(o.kw) + '</b></td>' + (isAll ? '<td class="c-txt kw-media">' + esc(mediaLabel(o.media)) + '</td>' : '')
        + '<td class="c-num">' + (o.vol == null ? '—' : nf.format(o.vol)) + '</td>' + (hasKd ? '<td class="c-num">' + (o.kd == null ? '—' : o.kd) + '</td>' : '')
        + [...showMonths].reverse().map(m => { const sp = o.posBy.mobile || {}, pc = o.posBy.desktop || {}, rk = (has, p) => has ? '<span class="rk ' + rankCls(p) + '">' + rankTxt(p) + '</span>' : '<span class="note">—</span>', nums = [sp[m], pc[m]].filter(v => v != null), avg = nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null, hasAny = (m in sp) || (m in pc);
          return '<td class="c-ctr kw-m1 kw-mc">' + rk(hasAny, avg) + '</td><td class="c-ctr kw-mc">' + rk(m in sp, sp[m]) + '</td><td class="c-ctr kw-mc">' + rk(m in pc, pc[m]) + '</td><td class="c-num kw-mc">' + (o.ga[m] ? nf.format(Math.round(o.ga[m].pv)) : '<span class="note">—</span>') + '</td><td class="c-num kw-mc">' + (o.ga[m] ? nf.format(Math.round(o.ga[m].cv)) : '<span class="note">—</span>') + '</td>' + kwCvrCell(o.ga[m]); }).join('')   /* 順位は 全体（SP・PCの平均）・SP・PC を並べる。PV・CV は GA4（端末の合計）（2026-11-02 ユーザー指定） */
        + '</tr>'; }).join('')
      + '</tbody></table></div><p class="note">AhrefsのRank Trackerの順位です（日本）。毎週月曜に、進行管理で「完了」になった記事の検索KWを Rank Tracker に自動で追加し、毎月2日に前月末時点の順位を取得します。「—」はその月にまだ追跡していなかったKWです。「記事」は進行管理の記事（新規の公開記事を優先）で、押すと記事が開きます。背景が赤い記事は、KWが進行管理にないか、検索結果に出ているページが進行管理の記事URLと違うもの（マウスを乗せると内容が出ます）。KDはキーワード難易度（0〜100、大きいほど上位表示が難しい）です。「最新のアクション」は進行管理のアップロード日がいちばん新しいもの、左のチェックボックスで選んで「リライト候補にする」を押すと、進行管理にリライト・簡易リライトの行を追加します（候補済みのKWは選べません）。PV・CVはGA4のページ別の値で、進行管理の記事URL（なければAhrefsで表示されたURL）のページです。</p>';
    document.querySelectorAll('#kw-body [data-dev]').forEach(b => b.onclick = () => { f.device = b.dataset.dev; draw(); });
    // チェックボックス → まとめてリライト候補に
    const picked = new Set();
    const syncKw = () => { const bar = $('kw-bulk'); if (!bar) return; bar.hidden = !picked.size; $('kw-bulk-n').textContent = picked.size + '件を選択中'; const all = $('kw-all'), boxes = [...document.querySelectorAll('#kw-body [data-kwpick]')]; if (all) { all.checked = boxes.length > 0 && boxes.every(b => b.checked); all.indeterminate = !all.checked && boxes.some(b => b.checked); } };
    document.querySelectorAll('#kw-body [data-kwpick]').forEach(b => b.onchange = () => { const o = list[Number(b.dataset.kwpick)]; if (b.checked) picked.add(o); else picked.delete(o); b.closest('tr').classList.toggle('picked', b.checked); syncKw(); });
    if ($('kw-all')) $('kw-all').onchange = ev => { document.querySelectorAll('#kw-body [data-kwpick]').forEach(b => { b.checked = ev.target.checked; b.onchange(); }); };
    if ($('kw-bulk-clear')) $('kw-bulk-clear').onclick = () => { document.querySelectorAll('#kw-body [data-kwpick]').forEach(b => { b.checked = false; b.onchange(); }); };
    if ($('kw-bulk-go')) $('kw-bulk-go').onclick = () => openRewriteCandidate([...picked].map(o => ({ media: o.media, kw: o.kw })), () => render());
    // 順位分布の推移（積み上げ）
    const distColors = { 'rk-top3': css('--good'), 'rk-top10': 'color-mix(in srgb, ' + css('--good') + ' 45%, transparent)', 'rk-top30': css('--warn'), 'rk-low': css('--muted'), 'rk-out': css('--grid') };
    chart('c-kwdist', { type: 'bar', data: { labels: months.map(mShort), datasets: bands.map(([l, , c]) => ({ label: l, backgroundColor: distColors[c], stack: 'a', data: months.map(m => { const at = [...byKw.values()].filter(o => m in o.pos); const p = o => o.pos[m]; return at.filter(o => c === 'rk-top3' ? p(o) != null && p(o) <= 3 : c === 'rk-top10' ? p(o) > 3 && p(o) <= 10 : c === 'rk-top30' ? p(o) > 10 && p(o) <= 30 : c === 'rk-low' ? p(o) > 30 : p(o) == null).length; }) })) }, options: baseOpts({ scales: stackScales() }) });
    $('kw-sort').onchange = ev => { f.sort = ev.target.value; draw(); };
    /* 日本語の変換中は描き直さない（描き直すと変換中の文字が消える）。変換が確定したら絞り込む（2026-11-05 ユーザー指定） */
    let t; const kwQ = $('kw-q'), runQ = () => { clearTimeout(t); t = setTimeout(() => { if (kwQ.dataset.composing) return; f.q = kwQ.value.trim(); draw(); const q = $('kw-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300); };
    kwQ.addEventListener('compositionstart', () => { kwQ.dataset.composing = '1'; clearTimeout(t); });
    kwQ.addEventListener('compositionend', () => { delete kwQ.dataset.composing; runQ(); });
    kwQ.oninput = ev => { if (ev.isComposing || kwQ.dataset.composing) return; runQ(); };
    };
    draw();
  } };
}
const viewPlan = () => placeholder('プランニング比（次の開発で追加）', ['要素が多いため、次の開発で追加します。タブの場所だけ確保しています。']);
const viewRevenue = () => placeholder('収益管理ダッシュボード（開発予定）', ['メディア数値ダッシュボードの完成後に開発します。ログインと権限は共通で、ユーザー管理から両方まとめて設定します。']);

// ================= 管理：ユーザー =================
const PERM_LABEL = { admin: '管理者', viewer: '閲覧', none: 'なし' };
const ARTICLE_PERM_LABEL = { admin: '管理者', editor: '編集', viewer: '閲覧', none: 'なし' };
const STATUS_LABEL = { active: ['利用中', 'ok'], pending: ['承認待ち', 'wait'], disabled: ['停止中', 'off'], invited: ['追加済み（未ログイン）', 'wait'] };
const permPill = v => `<span class="pill ${v === 'admin' || v === 'editor' ? 'ok' : v === 'viewer' ? 'wait' : 'off'}">${ARTICLE_PERM_LABEL[v] || v}</span>`;
const dt = s => s ? new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
function viewUsers() {
  return { html: '<p class="note">一人ひとりに「役割」を設定します。役割ごとの操作権限は「権限管理」で決めます。「契約から自動」にした人は、契約管理（ログイン用メールアドレス）のポジションで役割と見られるメディアが決まります。新しく登録した人は「承認待ち」で表示されます。</p><section class="panel" id="u-body"><p class="loading">読み込み中…</p></section>',
    view: 'ユーザー管理', after: loadUsers };
}
let USERS = [];
const roleCell = u => u.role === 'auto' ? (u.roleEff && u.roleEff !== 'auto' ? esc(roleLabel(u.roleEff)) + '<br>' : '') + '<span class="note">契約から自動</span>' : u.role ? esc(roleLabel(u.role)) : '<span class="note">未設定<br>（以前の個別設定）</span>';
/** 管理者のユーザー（管理者でない人は変更できない） */
const isAdminUser = u => u.role === 'admin' || (!u.role && !!u.perms && u.perms.media === 'admin');
async function loadUsers() {
  USERS = await api('/admin/users');
  const scopeOf = u => u.scope === 'all' ? 'すべて' : (u.scope || []).length ? (u.scope || []).map(m => esc(mediaLabel(m))).join('<br>') : '—';
  $('u-body').innerHTML = '<div class="row" style="justify-content:flex-end; margin-bottom:8px"><button class="btn primary" type="button" id="u-add">＋ ユーザーを追加</button></div><div class="table-wrap"><table class="am-table user-table"><thead><tr><th class="c-txt">名前</th><th class="c-txt">メールアドレス</th><th class="c-ctr">役割</th><th class="c-ctr">見られるメディア</th><th class="c-ctr">状態</th><th class="c-ctr">最終ログイン</th><th class="c-ctr">操作</th></tr></thead><tbody>'
    + USERS.map((u, i) => {
      const st = STATUS_LABEL[u.status] || [u.status, 'off'], locked = !isAdmin() && isAdminUser(u);
      return '<tr><td class="c-txt u-name"><b>' + esc(u.name) + '</b></td><td class="c-txt u-mail" title="' + esc(u.email) + '">' + esc(u.email) + '</td><td class="c-ctr">' + roleCell(u) + '</td>'
        + '<td class="c-ctr u-scope">' + scopeOf(u) + '</td><td class="c-ctr"><span class="pill ' + st[1] + '">' + st[0] + '</span></td><td class="c-ctr num">' + dt(u.lastLoginAt) + '</td>'
        + '<td class="c-ctr">' + (u.invite ? (u.role === 'admin' && !isAdmin() ? '<span class="note">管理者のみ変更可</span>' : '<button class="btn sm" type="button" data-inv-edit="' + i + '">変更</button> <button class="btn sm" type="button" data-inv-mail="' + i + '" title="' + esc(u.mailedAt ? '送信済み：' + dt(u.mailedAt) : u.mailError ? '送れませんでした：' + u.mailError : 'まだ送っていません') + '">' + (u.mailedAt ? '案内メール再送' : '案内メール') + '</button> <button class="btn sm" type="button" data-inv-del="' + i + '">取り消し</button>'
            + (u.mailedAt ? '<div class="note">送信 ' + dt(u.mailedAt) + '</div>' : u.mailError ? '<div class="err" style="font-size:11px">送信できず</div>' : ''))
          : locked ? '<span class="note" title="管理者の役割は管理者だけが変更できます">管理者のみ変更可</span>'
          : '<button class="btn sm ' + (u.status === 'pending' ? 'primary' : '') + '" type="button" data-edit="' + i + '">' + (u.status === 'pending' ? '承認して役割を設定' : '役割を編集') + '</button>') + '</td></tr>';
    }).join('') + '</tbody></table></div>'
    + '<p class="note">このダッシュボードに入れるのは、ここで追加した人だけです（追加されていない人がログインしても、入れず、この一覧にも載りません）。追加した人は、そのメールアドレスで初めてログインしたときに「利用中」になります。業務委託の役割にするには、先に契約管理で同じメールアドレスの契約を登録してください。</p>';
  document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => openUserModal(USERS[Number(btn.dataset.edit)]));
  document.querySelectorAll('[data-inv-edit]').forEach(btn => btn.onclick = () => openInviteModal(USERS[Number(btn.dataset.invEdit)]));
  document.querySelectorAll('[data-inv-mail]').forEach(btn => btn.onclick = async () => {
    const u = USERS[Number(btn.dataset.invMail)];
    if (!confirm(u.email + ' に案内メール（ダッシュボードのURLとログイン方法）を marketing@best-24.jp から送ります。よろしいですか？')) return;
    btn.disabled = true;
    try { await apiSend('POST', '/admin/users/invite/' + encodeURIComponent(u.email) + '/mail', {}); toast('案内メールを送りました'); loadUsers(); } catch (e) { alert('送れませんでした：' + e.message); btn.disabled = false; }
  });
  document.querySelectorAll('[data-inv-del]').forEach(btn => btn.onclick = async () => {
    const u = USERS[Number(btn.dataset.invDel)];
    if (!confirm(u.email + ' の追加を取り消します。この人はログインできなくなります。よろしいですか？')) return;
    try { await apiSend('DELETE', '/admin/users/invite/' + encodeURIComponent(u.email)); loadUsers(); } catch (e) { alert(e.message); }
  });
  $('u-add').onclick = () => openInviteModal(null);
}
/** ユーザーを追加（ログイン前に登録）。追加された人だけがログインできる（2026-10-14 ユーザー指定） */
function openInviteModal(u) {
  const medias = META.media.filter(m => !m.block).map(m => m.media), v = u || { role: 'auto', scope: 'all' }, scoped = Array.isArray(v.scope) ? v.scope : [];
  openModal('<h2>' + (u ? '追加したユーザーを変更' : 'ユーザーを追加') + '</h2><div class="form-grid">'
    + (u ? '' : '<label style="grid-column:1/-1">登録されている人から選ぶ<select id="iv-pick"><option value="">読み込んでいます…</option></select></label>')
    + '<label>メールアドレス<input id="iv-email" type="email" value="' + esc(v.email || '') + '"' + (u ? ' disabled' : '') + ' placeholder="ログインに使うメールアドレス"></label>'
    + '<label>名前<input id="iv-name" value="' + esc(u ? v.name : '') + '"></label>'
    + '<label>役割<select id="iv-role"><option value="auto"' + (v.role === 'auto' ? ' selected' : '') + '>契約から自動（契約管理のポジション）</option>' + Object.entries(ROLE_LABELS).filter(([k]) => k !== 'admin' || isAdmin()).map(([k, l]) => '<option value="' + k + '"' + (v.role === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>'
    + '<label id="iv-scope-wrap">見られるメディア<select id="iv-scope"><option value="all"' + (v.scope === 'all' ? ' selected' : '') + '>すべて</option><option value="some"' + (v.scope !== 'all' ? ' selected' : '') + '>選択したメディアのみ</option></select></label>'
    + '<div class="full" id="iv-media-list" style="grid-column:1/-1; display:flex; flex-wrap:wrap; gap:6px 14px; font-size:13px">' + medias.map((m, i) => '<label style="flex-direction:row; align-items:center; gap:4px; color:var(--fg)"><input type="checkbox" id="iv-m-' + i + '" value="' + esc(m) + '"' + (scoped.includes(m) ? ' checked' : '') + '>' + esc(mediaLabel(m)) + '</label>').join('') + '</div>'
    + (u ? '' : '<label class="full" style="grid-column:1/-1; flex-direction:row; align-items:center; gap:6px; color:var(--fg)"><input type="checkbox" id="iv-mail" checked>案内メールを送る（marketing@best-24.jp から、ダッシュボードのURLと Googleアカウントでのログイン方法）</label>')
    + '</div><p class="note" id="iv-note"></p><p class="err" id="iv-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="iv-save">' + (u ? '保存' : '追加') + '</button></div>');
  const sync = () => {
    const role = $('iv-role').value, auto = role === 'auto', out = ['auto', 'out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'].includes(role);
    $('iv-scope-wrap').hidden = auto; $('iv-media-list').hidden = auto || $('iv-scope').value === 'all';
    $('iv-note').textContent = out ? 'この役割にするには、契約管理でこのメールアドレスを入れた契約中の契約が必要です。「契約から自動」は、契約の担当メディア・担当ディレクトリだけが見えます。' : '操作できる内容は「権限管理」の設定で決まります。';
  };
  if (v.resta) { $('iv-role').value = 'resta'; $('iv-role').disabled = true; }   /* REsta社員は役割を変えられない（2026-10-30） */
  $('iv-role').onchange = sync; $('iv-scope').onchange = sync; sync();
  // 契約管理（契約中）・BEST社員管理（退職済み以外）に登録されている人から選ぶと、メール・名前・役割が入る（2026-10-28 ユーザー指定）
  if (!u) api('/admin/users/candidates').then(d => {
    const pick = $('iv-pick'); if (!pick) return;
    const list = d.contracts.map(c => Object.assign({ kind: 'c', role: 'auto', label: c.name + '（' + (c.position || '契約') + '）' }, c))
      .concat(d.staff.map(x => Object.assign({ kind: x.role === 'resta' ? 'r' : 's', label: x.name + '（' + x.empType + '）' }, x)));
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
    const opts = k => list.map((x, i) => [x, i]).filter(([x]) => x.kind === k).sort(([a], [b]) => byName(a, b)).map(([x, i]) => '<option value="' + i + '">' + esc(x.label) + ' ' + esc(x.email) + '</option>').join('');
    pick.innerHTML = '<option value="">選ばずに入力する</option>' + (d.contracts.length ? '<optgroup label="契約管理（契約中）">' + opts('c') + '</optgroup>' : '') + (opts('s') ? '<optgroup label="BEST社員管理">' + opts('s') + '</optgroup>' : '') + (opts('r') ? '<optgroup label="REsta社員管理">' + opts('r') + '</optgroup>' : '');   /* REsta社員は分けて出す（2026-10-30 ユーザー指定） */
    pick.onchange = () => { const x = list[pick.value]; if (!x) return; $('iv-email').value = x.email; $('iv-name').value = x.name; if (x.role) $('iv-role').value = x.role; sync(); };
  }).catch(() => { const pick = $('iv-pick'); if (pick) pick.innerHTML = '<option value="">（一覧を読み込めませんでした）</option>'; });
  $('iv-save').onclick = async () => {
    const role = $('iv-role').value, scope = role === 'auto' || $('iv-scope').value === 'all' ? 'all' : medias.filter((m, i) => $('iv-m-' + i).checked);
    try {
      $('iv-save').disabled = true;
      const r = await apiSend('POST', '/admin/users', { email: u ? v.email : $('iv-email').value.trim(), name: $('iv-name').value.trim(), role, scope, sendMail: !u && $('iv-mail').checked });
      closeModal(); loadUsers();
      if (r.mail) r.mail.ok ? toast('追加して、案内メールを送りました') : alert('追加しましたが、案内メールを送れませんでした：' + r.mail.error + '\n（一覧の「案内メール」から送り直せます）');
    } catch (e) { $('iv-err').textContent = e.message; $('iv-err').hidden = false; $('iv-save').disabled = false; }
  };
}
function openUserModal(u) {
  if (!isAdmin() && isAdminUser(u)) return;
  const medias = META.media.filter(m => !m.block).map(m => m.media);
  const scoped = Array.isArray(u.scope) ? u.scope : [];
  const cur = u.role || (u.perms && u.perms.media === 'admin' ? 'admin' : 'auto');
  openModal('<h2>' + esc(u.name) + ' の役割</h2><p class="note">' + esc(u.email) + '</p><div class="form-grid">'
    + '<label>役割<select id="pm-role"><option value="auto"' + (cur === 'auto' ? ' selected' : '') + '>契約から自動（契約管理のポジション）</option>' + Object.entries(ROLE_LABELS).filter(([k]) => k !== 'admin' || isAdmin()).map(([k, l]) => '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>'
    + '<label>状態<select id="pm-status"><option value="active"' + (u.status !== 'disabled' ? ' selected' : '') + '>利用中</option><option value="disabled"' + (u.status === 'disabled' ? ' selected' : '') + '>停止中</option></select></label>'
    + '<label id="pm-scope-wrap">見られるメディア<select id="pm-scope"><option value="all"' + (u.scope === 'all' ? ' selected' : '') + '>すべて</option><option value="some"' + (u.scope !== 'all' ? ' selected' : '') + '>選択したメディアのみ</option></select></label>'
    + '<div class="full" id="pm-media-list" style="grid-column:1/-1; display:flex; flex-wrap:wrap; gap:6px 14px; font-size:13px">' + medias.map((m, i) => '<label style="flex-direction:row; align-items:center; gap:4px; color:var(--fg)"><input type="checkbox" id="pm-m-' + i + '" value="' + esc(m) + '"' + (scoped.includes(m) ? ' checked' : '') + '>' + esc(m) + '</label>').join('') + '</div>'
    + '</div><p class="note" id="pm-note"></p><p class="err" id="pm-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="pm-save">' + (u.status === 'pending' ? '承認して保存' : '保存') + '</button></div>');
  const sync = () => {
    const auto = $('pm-role').value === 'auto';
    $('pm-scope-wrap').hidden = auto; $('pm-media-list').hidden = auto || $('pm-scope').value === 'all';
    $('pm-note').textContent = auto ? '契約管理で、このメールアドレス（' + u.email + '）を「ログイン用メールアドレス」に入れた契約から、役割（ディレクター→業務委託ディレクター、ライター→業務委託ライターなど）と見られるメディアが決まります。契約がない人は「契約外ライター」になります。'
      : $('pm-role').value === 'admin' ? '管理者は、すべての操作とユーザー管理・権限管理・契約管理などの管理メニューを使えます。' : '操作できる内容は「権限管理」の設定で決まります。';
  };
  if (u.resta) { $('pm-role').value = 'resta'; $('pm-role').disabled = true; $('pm-note').insertAdjacentHTML('afterend', '<p class="note">REsta社員管理に登録されている人なので、役割は「REsta社員」だけです。</p>'); }
  $('pm-role').onchange = sync; $('pm-scope').onchange = sync; sync();
  $('pm-save').onclick = async () => {
    const role = $('pm-role').value, scope = $('pm-scope').value === 'all' ? 'all' : medias.filter((m, i) => $('pm-m-' + i).checked);
    try {
      $('pm-save').disabled = true;
      await apiSend('PATCH', '/admin/users/' + encodeURIComponent(u.uid), Object.assign({ status: $('pm-status').value, role }, role === 'auto' ? {} : { scope }));
      closeModal(); loadUsers();
    } catch (e) { $('pm-err').textContent = e.message; $('pm-err').hidden = false; $('pm-save').disabled = false; }
  };
}
// ================= 管理：権限管理（役割ごとの操作権限） =================
function viewRoles() {
  return { html: '<section class="panel" id="ro-body"><p class="loading">読み込み中…</p></section>', view: '権限管理', after: async () => {
    const d = ROLE_DEF = await api('/admin/roles');
    const roles = d.roles, mat = {};
    roles.forEach(([id]) => { mat[id] = new Set(d.matrix[id] || []); });
    const cell = (role, cap) => role === 'admin' ? '<td class="c-ctr"><input type="checkbox" checked disabled></td>' : '<td class="c-ctr"><input type="checkbox" data-role="' + role + '" data-cap="' + cap + '"' + (mat[role].has(cap) ? ' checked' : '') + '></td>';
    $('ro-body').innerHTML = H('権限管理 <small>役割ごとに、できる操作を決めます</small>', ['ユーザー管理', '契約管理'])
      + '<div class="table-wrap"><table class="am-table role-table"><thead><tr><th class="c-txt">操作</th>' + roles.map(([, l]) => '<th class="c-ctr role-h">' + esc(l) + '</th>').join('') + '</tr></thead><tbody>'
      + d.caps.map(([k, g, l], i) => (g === '管理メニュー' && d.caps[i - 1][1] !== '管理メニュー' ? '<tr class="role-sep"><td class="c-txt" colspan="' + (roles.length + 1) + '"><b>管理メニュー</b> <span class="note">メニューごとに使える役割を決めます。「管理者」の役割を付ける・管理者の設定を変えるのは管理者だけです。</span></td></tr>' : '') + '<tr><td class="c-txt"><b>' + esc(g) + '</b>：' + esc(l) + '</td>' + roles.map(([id]) => cell(id, k)).join('') + '</tr>').join('')
      + '</tbody></table></div><div class="row" style="justify-content:flex-end; margin-top:10px"><span class="note" id="ro-msg" style="margin-right:auto"></span><button class="btn primary" type="button" id="ro-save">保存</button></div>'
      + '<h2 style="margin-top:18px">契約管理との紐づけ</h2><p class="note">ユーザー管理で役割を「契約から自動」にした人は、契約管理で「ログイン用メールアドレス」が一致する契約中の契約から、次の役割になります（複数あれば上の役割）。見られるメディアは契約しているメディアです。契約がない人は「契約外ライター」です。報酬管理の担当者・記事管理の担当者のプルダウンも、同じ契約から作っています。</p>'
      + '<div class="table-wrap"><table class="am-table" style="max-width:520px"><thead><tr><th class="c-txt">契約管理のポジション</th><th class="c-txt">役割</th></tr></thead><tbody>' + Object.entries(d.positionRole).map(([p, r]) => '<tr><td class="c-txt">' + esc(p) + '</td><td class="c-txt">' + esc(roleLabel(r)) + '</td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note">「自分が担当の記事だけ表示」は、進行管理・記事一覧で、契約管理の氏名（またはユーザー名）がディレクション・執筆・アップロード・監修のどれかの担当になっている記事だけを表示します。管理者だけは、左上の「UI確認」で各役割の画面を確認できます。</p>';
    $('ro-save').onclick = async () => {
      const matrix = {};
      roles.forEach(([id]) => { if (id !== 'admin') matrix[id] = [...document.querySelectorAll('#ro-body input[data-role="' + id + '"]:checked')].map(x => x.dataset.cap); });
      try { $('ro-save').disabled = true; await apiSend('PUT', '/admin/roles', { matrix }); ROLE_DEF = null; $('ro-msg').textContent = '保存しました（反映まで最大1分）'; }
      catch (e) { $('ro-msg').textContent = '保存できませんでした：' + e.message; }
      finally { $('ro-save').disabled = false; }
    };
  } };
}
// ================= 管理：システム構造 =================
let SYSTEM = null;
function viewSystem() {
  return { html: '<section class="panel" id="sys-body"><p class="loading">読み込み中…</p></section>', view: 'システム構造', after: async () => {
    const d = SYSTEM = await api('/system'), m = d.map, edit = d.canEdit && !(me && me._preview);
    const node = n => '<div class="sys-node"><b>' + esc(n.name) + '</b><span>' + esc(n.desc) + '</span></div>';
    const lanes = m.lanes.map((l, i) => (i ? '<div class="sys-arrow" aria-hidden="true">→</div>' : '') + '<div class="sys-lane"><h3>' + esc(l.title) + '</h3>' + l.nodes.map(node).join('') + '</div>').join('');
    const runBtn = it => !edit ? '' : it.edit === 'gas' ? '<a class="btn sm" href="' + escUrl(m.links.gas) + '" target="_blank" rel="noopener">GASを開く</a>'
      : it.edit === 'kintone' ? '<button class="btn sm" type="button" data-run="/admin/kintone/collect">今すぐ実行</button>'
      : it.edit === 'kwvol' ? '<button class="btn sm" type="button" data-go="api">API・連携設定へ</button>'
      : it.edit === 'moshimo' ? '<button class="btn sm" type="button" data-run="/admin/moshimo/run">今すぐ実行</button>'
      : it.edit === 'ahrefs-sync' ? '<button class="btn sm" type="button" data-run="/admin/ahrefs/sync">今すぐ実行</button>'
      : it.edit === 'ahrefs-fetch' ? '<button class="btn sm" type="button" data-run="/admin/ahrefs/fetch">今すぐ実行</button>'
      : it.edit === 'media' ? '<button class="btn sm" type="button" data-go="media">メディア管理へ</button>' : '';
    const note = it => { const n = d.notes[it.id]; return (n && n.text ? '<div class="sys-note">' + esc(n.text).replace(/\n/g, '<br>') + '<span class="note">（' + esc(n.by || '') + '）</span></div>' : '') + (edit ? '<button class="linkbtn" type="button" data-note="' + esc(it.id) + '">メモを' + (n && n.text ? '編集' : '追加') + '</button>' : ''); };
    $('sys-body').innerHTML = H('システム構造 <small>Ver ' + esc(m.version) + '（' + esc(m.updated.replace(/-/g, '/')) + ' 更新）</small>', ['全体'])
      + '<p class="note">このダッシュボードが、どこから・いつ・何を使ってデータを集め、どこにためて表示しているかの全体図です。WEBアプリを更新するたびに、この画面も更新します。' + (edit ? '管理者は、各スケジュールのメモの追加と、収集の手動実行ができます。' : 'この画面は閲覧のみです。') + '</p>'
      + '<h2>全体の流れ</h2><div class="sys-flow">' + lanes + '</div>'
      + '<h2>データの流れ（何が・何を使って・どこへ）</h2><div class="table-wrap"><table class="am-table sys-table"><thead><tr><th class="c-txt">どこから</th><th class="c-ctr"></th><th class="c-txt">何を使って（いつ）</th><th class="c-ctr"></th><th class="c-txt">どこへ</th><th class="c-txt">中身</th></tr></thead><tbody>'
      + m.flows.map(f => '<tr><td class="c-txt"><b>' + esc(f.from) + '</b></td><td class="c-ctr sys-ar">→</td><td class="c-txt">' + esc(f.via) + '</td><td class="c-ctr sys-ar">→</td><td class="c-txt"><b>' + esc(f.to) + '</b></td><td class="c-txt">' + esc(f.what) + '</td></tr>').join('') + '</tbody></table></div>'
      + '<h2>実行スケジュール（いつ・何が動くか）</h2><div class="sys-sched">' + m.schedule.map(it => '<div class="sys-card"><div class="sys-when">' + esc(it.when) + '</div><div class="sys-main"><b>' + esc(it.name) + '</b><div class="sys-meta"><span class="pill">' + esc(it.tool) + '</span> <code>' + esc(it.where) + '</code></div><p>' + esc(it.what) + '</p><p class="note">' + esc(it.fail) + '</p>' + note(it) + '</div><div class="sys-act">' + runBtn(it) + '</div></div>').join('') + '</div>'
      + '<h2>データの保存先</h2><div class="table-wrap"><table class="am-table sys-table"><thead><tr><th class="c-ctr">種類</th><th class="c-txt">名前</th><th class="c-txt">中身</th><th class="c-txt">入れているもの</th></tr></thead><tbody>'
      + m.stores.map(x => '<tr><td class="c-ctr"><span class="pill ' + (x.kind === 'BigQuery' ? 'ok' : x.kind === 'Firestore' ? 'wait' : 'off') + '">' + esc(x.kind) + '</span></td><td class="c-txt"><code>' + esc(x.name) + '</code></td><td class="c-txt">' + esc(x.what) + '</td><td class="c-txt">' + esc(x.by) + '</td></tr>').join('') + '</tbody></table></div>'
      + (noMoney() || !(m.changelog || []).length ? '' : '<h2>更新履歴</h2><div class="sys-log">') + (noMoney() ? [] : m.changelog || []).map(c => '<div><b>Ver ' + esc(c.ver) + '</b> <span class="note">' + esc(c.date.replace(/-/g, '/')) + '</span><ul>' + c.items.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>').join('') + (noMoney() || !(m.changelog || []).length ? '' : '</div>');
    document.querySelectorAll('#sys-body [data-go]').forEach(b => b.onclick = () => { state.view = b.dataset.go; render(); });
    document.querySelectorAll('#sys-body [data-run]').forEach(b => b.onclick = async () => {
      if (!confirm('今すぐ実行します。よろしいですか？（数分かかることがあります）')) return;
      b.disabled = true; b.textContent = '実行中…';
      try { await apiSend('POST', b.dataset.run, {}); b.textContent = '実行しました'; } catch (e) { b.textContent = '失敗：' + e.message; b.disabled = false; }
    });
    document.querySelectorAll('#sys-body [data-note]').forEach(b => b.onclick = () => {
      const id = b.dataset.note, it = m.schedule.find(x => x.id === id), cur = (d.notes[id] || {}).text || '';
      openModal('<h2>メモ：' + esc(it.name) + '</h2><p class="note">' + esc(it.when) + '・' + esc(it.tool) + '</p><textarea id="sys-memo" rows="5" style="width:100%">' + esc(cur) + '</textarea><p class="err" id="sys-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="sys-save">保存</button></div>');
      $('sys-save').onclick = async () => { try { await apiSend('PUT', '/admin/system-notes', { id, text: $('sys-memo').value }); closeModal(); render(); } catch (e) { $('sys-err').textContent = e.message; $('sys-err').hidden = false; } };
    });
  } };
}
function viewLogs() {
  return { html: `<div class="row"><label class="field">ユーザー<select id="log-user"><option value="">すべて</option></select></label><span class="note">直近300件を表示します</span></div><section class="panel" id="l-body"><p class="loading">読み込み中…</p></section>`,
    view: 'アクセスログ', after: async () => {
      const logs = await api('/admin/logs');
      const users = [...new Set(logs.map(l => l.email))];
      $('log-user').innerHTML += users.map(e => `<option>${esc(e)}</option>`).join('');
      const draw = () => { const f = $('log-user').value; const rows = logs.filter(l => !f || l.email === f);
        $('l-body').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>日時</th><th>ユーザー</th><th>見た画面・操作</th><th>接続元IP</th></tr></thead><tbody>${rows.map(l => `<tr><td class="num">${dt(l.at)}</td><td style="text-align:left">${esc(l.name)}（${esc(l.email)}）</td><td style="text-align:left">${esc(l.view)}</td><td style="text-align:left" class="num">${esc(l.ip)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">ログはまだありません</p>'; };
      $('log-user').onchange = draw; draw();
    } };
}
function viewJobs() {
  return { html: `<p class="note">毎日3時台に、GA4は直近3日・Search Consoleは直近5日を取り直します。エラーが出た日は管理者にメールが届きます。</p><section class="panel" id="j-body"><p class="loading">読み込み中…</p></section>`,
    view: '収集ジョブ', after: async () => {
      const jobs = await api('/admin/jobs');
      $('j-body').innerHTML = `<h2>実行履歴 <small>直近14日</small></h2>` + (jobs.length ? `<div class="table-wrap"><table><thead><tr><th>実行</th><th>処理</th><th>メディア</th><th>期間</th><th>結果</th><th>内容</th></tr></thead><tbody>
        ${jobs.map(j => `<tr><td class="num">${esc(j.run_at)}</td><td style="text-align:left">${esc(j.job)}</td><td style="text-align:left">${esc(j.media)}</td><td class="num">${esc(j.date_from)}〜${esc(j.date_to)}</td><td style="text-align:left"><span class="pill ${j.status === 'OK' ? 'ok' : 'ng'}">${j.status === 'OK' ? '成功' : 'エラー'}</span></td><td style="text-align:left; white-space:normal">${esc(j.message)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">記録はまだありません</p>');
    } };
}
const SITE_URLS = { '生活お助け': 'https://otasuke-honpo.com/', '害獣お助け': 'https://gaijyu.otasuke-honpo.com/', 'ハチお助け': 'https://hachi.otasuke-honpo.com/', '水まわりお助け': 'https://mizu.otasuke-honpo.com/',
  'カギお助け': 'https://kagi.otasuke-honpo.com/', 'ガラスお助け': 'https://glass.otasuke-honpo.com/', '屋根外壁お助け': 'https://roof.otasuke-honpo.com/', 'シロアリお助け': 'https://shiroari.otasuke-honpo.com/',
  'BEST365': 'https://best365.best24.co.jp/', '害虫害獣コンシェルジュ': 'https://gaichugaiju.best24.co.jp/' };
let WP = [];
function wpPill(w) {
  if (!w || !w.url) return '<span class="pill off">未設定</span>';
  if (w.lastError) return `<span class="pill ng" title="${esc(w.lastError)}">エラー</span>`;
  return `<span class="pill ok">接続済み</span>`;
}
/** WordPress のログイン（ユーザー名＋アプリケーションパスワード）。サイトURLとは別に表示（2026-11-13 ユーザー指定） */
function wpLoginPill(w) {
  if (!w || !w.url) return '<span class="note">—</span>';
  if (w.user && w.hasPassword) return '<span class="pill ok" title="ユーザー名：' + esc(w.user) + '">設定済み</span>';
  if (w.user || w.hasPassword) return '<span class="pill wait" title="ユーザー名とアプリケーションパスワードの両方が必要です">途中</span>';
  return '<span class="pill off">未設定</span>';
}
function viewMediaAdmin() {
  return { html: `<div class="row"><p class="note" style="margin:0; margin-right:auto">WordPressは各サイトの「WordPress設定」から接続します。登録後は毎日3時台に記事数を自動で取得します。GA4・Search Consoleの対象の追加は、今はスプレッドシートの「自動集計設定」タブで行います。</p><button class="btn" type="button" id="add-media">＋ メディア追加</button></div>
    <section class="panel" id="ma-body"><p class="loading">読み込み中…</p></section>`,
    view: 'メディア管理', after: async () => {
      $('add-media').onclick = () => openModal(`<h2>メディア追加</h2>
        <p class="note">今の段階では、スプレッドシートの「自動集計設定」タブに、タブ名・GA4プロパティID・Search Consoleのプロパティを1行追加してください。翌日3時の収集から対象になります。追加後、この画面の「WordPress設定」からWordPressも接続できます。</p>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" data-close>閉じる</button></div>`);
      await drawMediaAdmin();
    } };
}
async function drawMediaAdmin() {
  WP = await api('/admin/wp');
  await loadItems();
  const byMedia = Object.fromEntries(WP.map(w => [w.media, w]));
  $('ma-body').innerHTML = `<div class="table-wrap"><table class="ma-table"><thead><tr><th>メディア</th><th>GA4のデータ</th><th>Search Consoleのデータ</th><th>WordPress<br><span class="note">サイトURL</span></th><th>WordPress<br><span class="note">ログイン</span></th><th>最終取得</th><th>監修者あり</th><th>関連KW</th><th>操作</th></tr></thead><tbody>
    ${META.media.map(m => { if (m.block) return `<tr><td>　${esc(mediaName(m.id))}</td><td class="num">${m.ga4From ? m.ga4From + ' 〜 ' + m.ga4To : '—'}</td><td class="num">（サイト単位）</td><td colspan="6" style="text-align:left"><span class="note">ディレクトリ</span></td></tr>`;
      const w = byMedia[m.media];
      return `<tr><td>${esc(m.name)}</td><td class="num">${m.ga4From ? m.ga4From + ' 〜 ' + m.ga4To : '—'}</td><td class="num">${m.sc ? m.sc.first + ' 〜 ' + m.sc.last : '—'}</td>
        <td style="text-align:left">${wpPill(w)}</td><td>${wpLoginPill(w)}</td><td class="num" style="white-space:normal">${w && w.lastCollectedAt ? dt(w.lastCollectedAt) : '—'}${w && w.lastError ? '<br><span class="err">' + esc(w.lastError) + '</span>' : ''}</td>
        <td style="text-align:center"><input type="checkbox" data-sup-media="${esc(m.media)}" ${isSupMedia(m.media) ? 'checked' : ''} title="監修者ありにすると、記事管理に監修有無・監修担当の列と「構成監修者確認」「記事監修者確認」が使えるようになります"></td>
        <td style="text-align:center"><input type="checkbox" data-rel-media="${esc(m.media)}" ${isRelMedia(m.media) ? 'checked' : ''} title="表示にすると、進行管理の検索KWの右に関連KWの列が出ます（1行に1つ）"></td>
        <td style="text-align:left"><button class="btn sm ${w && w.url ? '' : 'primary'}" type="button" data-wp="${esc(m.media)}">WordPress設定</button></td></tr>`; }).join('')}
    </tbody></table></div>`;
  document.querySelectorAll('[data-wp]').forEach(btn => btn.onclick = () => openWpModal(btn.dataset.wp, byMedia[btn.dataset.wp]));
  document.querySelectorAll('[data-rel-media]').forEach(cb => cb.onchange = async () => {
    const media = cb.dataset.relMedia;
    try { await apiSend('PUT', '/article-settings', { media, relatedKw: cb.checked }); REL_KW_MEDIA = cb.checked ? REL_KW_MEDIA.concat(media) : REL_KW_MEDIA.filter(m => m !== media); }
    catch (e) { cb.checked = !cb.checked; alert('変更できませんでした：' + e.message); }
  });
  document.querySelectorAll('[data-sup-media]').forEach(cb => cb.onchange = async () => {
    const media = cb.dataset.supMedia;
    try { await apiSend('PUT', '/article-settings', { media, supervised: cb.checked }); SUPERVISED = cb.checked ? SUPERVISED.concat(media) : SUPERVISED.filter(m => m !== media); }
    catch (e) { cb.checked = !cb.checked; alert('変更できませんでした：' + e.message); }
  });
}
function openWpModal(media, w) {
  w = w || {};
  const name = (META.media.find(m => m.media === media && !m.block) || {}).name || media;
  openModal(`<h2>WordPress設定：${esc(name)}</h2>
    <h3 class="am-h">① サイトURLの登録 ${wpPill(w)}</h3>
    <p class="note">公開記事数・新規・リライト・記事タイトル・カテゴリ・タグ・マイブロック・公開ページの本文は、URLだけで取得できます。</p>
    <div class="form-grid">
      <label class="full">サイトのURL<input id="wp-url" type="url" value="${esc(w.url || SITE_URLS[media] || '')}" placeholder="https://example.com/"></label>
    </div>
    <h3 class="am-h">② ログイン設定（任意） ${wpLoginPill(w)}</h3>
    <p class="note">予約投稿・レビュー待ち・下書きの件数と、記事の編集画面の中身（構成シートで既存記事のブロックを確実に見分ける）を取るときに使います。WordPressの「ユーザー」→「プロフィール」で発行した<b>アプリケーションパスワード</b>（ログイン用のパスワードとは別のもの。編集者以上のユーザーで発行）を入力してください。</p>
    <div class="form-grid">
      <label>ユーザー名<input id="wp-user" value="${esc(w.user || '')}" autocomplete="off"></label>
      <label>アプリケーションパスワード<input id="wp-pass" type="password" autocomplete="new-password" placeholder="${w.hasPassword ? '登録済み（' + esc(w.passHint) + '）。変更する場合のみ入力' : 'xxxx xxxx xxxx xxxx xxxx xxxx'}"></label>
    </div>
    <div class="test-result" id="wp-result"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="wp-test">接続テスト</button><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="wp-save">保存して記事数を取得</button></div>`);
  const val = () => ({ url: $('wp-url').value.trim(), user: $('wp-user').value.trim(), password: $('wp-pass').value.trim() });
  const msg = (html, cls) => { $('wp-result').innerHTML = `<span class="${cls || ''}">${html}</span>`; };
  const busy = on => { ['wp-test', 'wp-save'].forEach(id => { $(id).disabled = on; }); };
  $('wp-test').onclick = async () => {
    busy(true); msg('接続しています…', 'note');
    try {
      const r = await apiSend('POST', '/admin/wp/' + encodeURIComponent(media) + '/test', val());
      const st = r.status, au = st.auth || {};
      const authHtml = au.ok ? `<span class="pill ok">認証OK</span> 予約 ${st.scheduled}件／レビュー待ち ${st.pending}件／下書き ${st.draft}件`
        : au.reason === 'HEADER' ? `<span class="pill wait">認証できません</span> サーバーが認証情報を受け取れていません。WordPressの <b>.htaccess</b> の「# BEGIN WordPress」の上に次の1行を追加すると解決することが多いです。<br><code>SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1</code>`
        : `<span class="pill wait">認証なし</span> ${esc(au.reason || '')}（予約・下書きの件数は取得しません）`;
      msg(`<span class="pill ok">公開記事の取得OK</span> 公開中 ${nf.format(st.published)}件<br>${authHtml}`);
    } catch (e) { msg('<span class="pill ng">接続できません</span> ' + esc(e.message)); }
    busy(false);
  };
  $('wp-save').onclick = async () => {
    busy(true); msg('保存しています…', 'note');
    try {
      await apiSend('PUT', '/admin/wp/' + encodeURIComponent(media), val());
      msg('保存しました。記事数を取得しています（初回は2024年1月からさかのぼるため、1〜2分かかります）…', 'note');
      const r = await apiSend('POST', '/admin/wp/' + encodeURIComponent(media) + '/collect', {});
      msg(`<span class="pill ok">取得完了</span> ${r.detail.months}か月分を保存しました。今月は新規 ${r.detail.current.posts_new}本・リライト ${r.detail.current.rewrites}本です。`);
      ARTICLES = null; MONTHLY = await api('/monthly');
      drawMediaAdmin();
    } catch (e) { msg('<span class="pill ng">エラー</span> ' + esc(e.message)); }
    busy(false);
  };
}
// ---- 記事目標設定（管理者） ----
let TEDIT = null, TDIRTY = false;
function viewTargets() {
  const y = Number(state.tYear || CUR_MONTH.slice(0, 4)), type = state.tType || 'new';
  const months = Array.from({ length: 12 }, (_, i) => y + '-' + String(i + 1).padStart(2, '0'));
  const years = [y - 1, y, y + 1];
  return { html: `<div class="row">
      <label class="field">年<select id="t-year">${years.map(v => `<option value="${v}" ${v === y ? 'selected' : ''}>${v}年</option>`).join('')}</select></label>
      <div class="seg" role="group" aria-label="目標の種類"><button type="button" data-tt="new" aria-pressed="${type === 'new'}">新規公開</button><button type="button" data-tt="rewrite" aria-pressed="${type === 'rewrite'}">リライト</button><button type="button" data-tt="total" aria-pressed="${type === 'total'}">合計（新規＋リライト）</button></div>
      <span class="note" id="t-state" style="margin-right:auto"></span>
      <button class="btn" type="button" id="t-reset">元に戻す</button><button class="btn primary" type="button" id="t-save">保存</button></div>
    <p class="note">月ごとの目標本数を入力します。害虫害獣コンシェルジュ・害獣お助け本舗・水まわりお助け本舗・屋根外壁お助け本舗はディレクトリごとに入力し、メディア全体（とグループ）の行は自動で合計されます。「目標・工数」で社員が申請した月ごとの記事目標を管理者が承認すると、ここに自動で入ります。空欄は「目標なし」です。新規公開とリライトは上の切り替えで入力し、「合計」では新規＋リライトの本数を確認できます（合計は入力できません）。</p>
    <section class="panel" id="t-body"><p class="loading">読み込み中…</p></section>`,
    view: '記事目標設定', after: async () => {
      if (!TEDIT || TEDIT.year !== y) {
        const data = await api('/targets?from=' + months[0] + '&to=' + months[11]);
        TEDIT = { year: y, data: JSON.parse(JSON.stringify(data)) }; TDIRTY = false;
      }
      drawTargets(months, type);
      $('t-year').onchange = ev => { if (TDIRTY && !confirmLeave()) { ev.target.value = y; return; } state.tYear = Number(ev.target.value); render(); };
      document.querySelectorAll('[data-tt]').forEach(b => b.onclick = () => { state.tType = b.dataset.tt; render(); });
      $('t-reset').onclick = () => { TEDIT = null; render(); };
      $('t-save').onclick = async () => {
        $('t-save').disabled = true; $('t-state').textContent = '保存しています…';
        try {
          const payload = {}; months.forEach(mm => { payload[mm] = TEDIT.data[mm] || {}; });
          await apiSend('PUT', '/admin/targets', { months: payload });
          TDIRTY = false; ARTICLES = null; $('t-state').textContent = '保存しました';
        } catch (e) { $('t-state').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
        $('t-save').disabled = false;
      };
    } };
}
// 未保存の変更があるまま年を切り替えたときは、その場で注意を出して止める（confirm() は使えないため2回押しで確定）
let leaveArmed = false;
function confirmLeave() { if (leaveArmed) { leaveArmed = false; TDIRTY = false; return true; } leaveArmed = true; $('t-state').innerHTML = '<span class="err">保存していない変更があります。もう一度切り替えると変更を破棄します</span>'; return false; }
function drawTargets(months, type) {
  const tree = targetTree();
  const cell = (r, mm) => {
    if (!r.editable || type === 'total') return `<td class="num" data-calc="${esc(r.id)}" data-ym="${mm}"></td>`;
    const v = ((TEDIT.data[mm] || {})[r.id] || {})[type];
    return `<td class="num"><input class="tin" type="number" min="0" inputmode="numeric" aria-label="${esc(r.name)} ${mm}" data-id="${esc(r.id)}" data-ym="${mm}" value="${v != null ? v : ''}"></td>`;
  };
  $('t-body').innerHTML = H(`${type === 'new' ? '新規公開' : type === 'rewrite' ? 'リライト' : '合計（新規＋リライト）'}の目標本数 <small>${months[0].slice(0, 4)}年</small>`, ['WordPress']) + `<div class="table-wrap"><table class="ttable"><thead><tr><th>メディア</th>${months.map(mm => `<th class="num">${Number(mm.slice(5))}月</th>`).join('')}<th class="num">年間合計</th></tr></thead><tbody>
    ${tree.map(r => `<tr class="${r.editable ? '' : 'calc'}"><td style="padding-left:${10 + r.level * 18}px">${esc(r.name)}${r.editable ? '' : ' <span class="note">（合計）</span>'}</td>${months.map(mm => cell(r, mm)).join('')}<td class="num" data-rowtotal="${esc(r.id)}"></td></tr>`).join('')}
    <tr class="total"><td>全メディア合計</td>${months.map(mm => `<td class="num" data-calc="${ALL}" data-ym="${mm}"></td>`).join('')}<td class="num" data-rowtotal="${ALL}"></td></tr>
    </tbody></table></div>`;
  const update = () => {
    document.querySelectorAll('#t-body [data-calc]').forEach(td => { const v = targetOf(td.dataset.calc, td.dataset.ym, type, TEDIT.data); td.textContent = v == null ? '—' : nf.format(v); });
    document.querySelectorAll('#t-body [data-rowtotal]').forEach(td => {
      let sum = 0, has = false; months.forEach(mm => { const v = targetOf(td.dataset.rowtotal, mm, type, TEDIT.data); if (v != null) { sum += v; has = true; } });
      td.textContent = has ? nf.format(sum) : '—';
    });
    $('t-state').textContent = TDIRTY ? '保存していない変更があります' : '';
  };
  document.querySelectorAll('#t-body .tin').forEach(inp => inp.oninput = () => {
    const mm = inp.dataset.ym, id = inp.dataset.id, raw = inp.value.trim();
    const m = TEDIT.data[mm] = TEDIT.data[mm] || {}; const o = m[id] = m[id] || { new: null, rewrite: null };
    o[type] = raw === '' ? null : Math.max(0, Math.floor(Number(raw)) || 0);
    TDIRTY = true; leaveArmed = false; update();
  });
  update();
}
/* API・連携設定を、使っているダッシュボード（大カテゴリ）ごとのタブに分ける（2026-11-06 ユーザー指定：連携が多くなったため）。
   cats＝出すタブ（最初がおもなカテゴリ）、label＝カードの上の「ダッシュボード・画面」。連携を足したら、ここにも1行足す */
const API_TABS = [['media', 'メディア数値'], ['articles', 'コンテンツ作成'], ['revenue', '収益'], ['expenses', '支出情報'], ['ai', 'AIツール'], ['common', '共通'], ['all', 'すべて']];
const API_CARDS = {
  'api-google': { cats: ['media'], label: 'メディア数値・PV・CV・表示回数・クリック・掲載順位' },
  'api-wp': { cats: ['media', 'articles'], label: 'メディア数値・記事数／コンテンツ作成・記事の公開' },
  'api-kintone': { cats: ['media', 'revenue'], label: 'メディア数値・コール・成約／収益・案件の売上' },
  'api-kwvol': { cats: ['media', 'articles'], label: 'メディア数値・シミュレーション（季節性）／コンテンツ作成・記事管理のKW' },
  'api-ahrefs': { cats: ['media'], label: 'メディア数値・KW追従（順位）' },
  'api-moshimo': { cats: ['revenue'], label: '収益・ASP（もしもアフィリエイト）' },
  'api-copy': { cats: ['articles'], label: 'コンテンツ作成・進行管理（自動コピペチェック）' },
  'api-compete': { cats: ['articles'], label: 'コンテンツ作成・構成シート（競合調査）' },
  'api-aicost': { cats: ['expenses'], label: '支出情報・ツール利用費（AIの利用料）' },
  'api-supabase': { cats: ['ai'], label: 'AIツール・AI MEDIAシミュレーション（AIの作業机）' },
  'api-aimedia': { cats: ['ai'], label: 'AIツール・AI MEDIAシミュレーション（キー・モデル）' },
  'api-gmail': { cats: ['common'], label: '共通・お知らせメール（請求・招待など）' }
};
function apiTabsApply() {
  const t = state.apiTab || 'media';
  document.querySelectorAll('[data-apitab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.apitab === t)));
  Object.entries(API_CARDS).forEach(([id, c]) => { const el = $(id); if (!el) return; el.dataset.label = c.label; el.hidden = !(t === 'all' || c.cats.includes(t)); });
}
function viewApi() {
  const ok = !META.gaErrors24h;   // GA4・SC のジョブだけ（ほかのジョブのエラーは「収集ジョブ」で見る）
  const tabs = API_TABS.map(([k, l]) => { const n = k === 'all' ? Object.keys(API_CARDS).length : Object.values(API_CARDS).filter(c => c.cats.includes(k)).length; return '<button type="button" data-apitab="' + k + '" aria-pressed="false">' + l + ' <span class="note">' + n + '</span></button>'; }).join('');
  return { html: `<div class="seg api-tabs" role="tablist">${tabs}</div><section class="cards api-cards">
    <div class="panel" id="api-google"><div class="panel-head"><h2>Google（GA4・Search Console）</h2><span class="pill ${ok ? 'ok' : 'ng'}">${ok ? '接続OK' : '直近24時間にエラーあり'}</span></div>
      <dl class="card-kv"><dt>収集</dt><dd>Apps Script から毎日3時台に BigQuery へ保存</dd><dt>最終収集</dt><dd>${esc(META.gaLastRun || '—')}</dd><dt>保存先</dt><dd>BigQuery：best_media</dd></dl></div>
    <div class="panel" id="api-wp"><div class="panel-head"><h2>WordPress</h2><span class="pill off">確認中…</span></div></div>
    <div class="panel" id="api-kintone"><div class="panel-head"><h2>kintone</h2><span class="pill off">確認中…</span></div></div>
    <div class="panel" id="api-kwvol"><div class="panel-head"><h2>検索Vol（Ahrefs）</h2><span class="pill off">確認中…</span></div></div>
    <div class="panel" id="api-moshimo"><div class="panel-head"><h2>もしもアフィリエイト</h2><span class="pill off">確認中…</span></div></div>
${isAdmin() && !PREVIEW_UID ? '<div class="panel" id="api-gmail"><div class="panel-head"><h2>メール送信（Gmail）</h2><span class="pill off">確認中…</span></div></div>' : ''}
    <div class="panel" id="api-aicost"><div class="panel-head"><h2>AI の API の費用（Claude・OpenAI）</h2><span class="pill off">確認中…</span></div></div>
${isAdmin() && !PREVIEW_UID ? '<div class="panel" id="api-supabase"><div class="panel-head"><h2>Supabase（AIの作業机）</h2><span class="pill off">確認中…</span></div></div>' : ''}
${isAdmin() && !PREVIEW_UID ? '<div class="panel" id="api-aimedia"><div class="panel-head"><h2>AI MEDIAシミュレーション</h2><span class="pill off">確認中…</span></div></div>' : ''}
    <div class="panel" id="api-copy"><div class="panel-head"><h2>コピペチェック（Brave Search）</h2><span class="pill off">確認中…</span></div></div>
    <div class="panel" id="api-compete"><div class="panel-head"><h2>競合調査（Brave Search）</h2><span class="pill off">確認中…</span></div></div>
    <div class="panel" id="api-ahrefs"><div class="panel-head"><h2>Ahrefs（KW追従）</h2><span class="pill off">確認中…</span></div></div>
  </section>`, view: 'API・連携設定', after: async () => {
    apiTabsApply(); document.querySelectorAll('[data-apitab]').forEach(b => b.onclick = () => { state.apiTab = b.dataset.apitab; apiTabsApply(); });
    drawKwVol(); drawKintone(); drawAhrefs(); drawMoshimo(); drawCopySetting(); drawCompeteSetting(); drawGmail(); drawAiCost(); drawSupabase(); drawAiMediaSettings();
    const list = await api('/admin/wp'), n = list.filter(w => w.url).length, err = list.filter(w => w.lastError).length;
    $('api-wp').innerHTML = `<div class="panel-head"><h2>WordPress</h2><span class="pill ${err ? 'ng' : n ? 'ok' : 'off'}">${err ? 'エラーあり' : n ? n + 'サイト接続済み' : '未設定'}</span></div>
      <dl class="card-kv"><dt>接続方式</dt><dd>各サイトのREST API（アプリケーションパスワード）</dd><dt>取得内容</dt><dd>投稿の公開数（累計・新規）、リライト数（その月に更新された、それ以前公開の投稿）、予約・レビュー待ち・下書きの件数</dd><dt>取得タイミング</dt><dd>毎日3時台</dd><dt>設定場所</dt><dd>メディア管理 →「WordPress設定」</dd></dl>`;
  } };
}

/** API・連携設定：Supabase（AIの作業机）。URL と service_role キーは Secret Manager へ（画面・チャットに出さない）（2026-11-05 ユーザー指定） */
async function drawSupabase() {
  const box = $('api-supabase'); if (!box) return;
  const head = '<div class="panel-head"><h2>Supabase（AIの作業机）</h2>';
  let d; try { d = await api('/admin/supabase'); } catch (e) { box.innerHTML = head + '</div><p class="err">' + esc(e.message) + '</p>'; return; }
  const tbl = Object.keys(d.tables || {}), okN = tbl.filter(t => d.tables[t]).length;
  const pill = d.ready ? '<span class="pill ok">接続済み・表あり</span>' : d.connected ? '<span class="pill wait">つながった・表がまだ</span>' : '<span class="pill off">未設定</span>';
  box.innerHTML = head + pill + '</div>'
    + '<p class="note">設計図どおり、BigQuery が原本、Supabase が AI の作業机です。毎日（4:40 のインデックス確認のついで）BigQuery から予測と月の実績の写しを入れ、答え合わせの表・AIの提案・あなたの判断（OK／却下と理由）・AIの費用の記録をここに置きます。毎日書き込むので、無料プランの一時停止も防げます。</p>'
    + (d.connected ? '<p>表：' + okN + '／' + tbl.length + '　' + tbl.map(t => '<span class="pill ' + (d.tables[t] ? 'ok' : 'off') + '">' + t + '</span>').join(' ') + '</p>' : '')
    + (d.ready ? '<p>最後の写し：' + (d.lastCopy ? esc(fmtJst(d.lastCopy)) : 'まだ') + '　<button class="btn sm" type="button" id="sb-copy">今すぐ写す</button></p>' : '')
    + (d.connected && (!d.ready || !d.teamReady || !d.errReady) ? '<h3 class="am-h">' + (d.ready && d.teamReady ? 'AIエラーチェッカーの表を足す（1回だけ）</h3><p class="note">AIエラーチェッカーの点検の材料と報告・指摘・あなたの判断を残す表です（2026-11-13）。前に作った表はそのまま残ります（何度実行しても大丈夫）。</p>' : d.ready ? 'AIチームの表を足す（1回だけ）</h3><p class="note">どのAIが何を読んだか・ループで使ったトークン量・月ごとのモデルを残す表です（2026-11-06）。なくても答え合わせは動きます。</p>' : '表を作る（1回だけ）</h3>') + '<ol class="note"><li>Supabase の画面で、左の「SQL Editor」を開く</li><li>下の文を全部コピーして貼り、「Run」を押す</li><li>ここで「もう一度確かめる」を押す</li></ol>'
      + '<textarea id="sb-sql" readonly rows="8" style="width:100%; font-family:monospace; font-size:11px">' + esc(d.sql) + '</textarea><div class="row" style="gap:6px"><button class="btn sm" type="button" id="sb-sqlcopy">コピー</button><button class="btn sm" type="button" id="sb-recheck">もう一度確かめる</button></div>' : '')
    + '<h3 class="am-h">接続先' + (d.connected ? '（変えるときだけ）' : '') + '</h3>'
    + '<p class="note">Supabase の画面 → Project Settings →「Data API」にある「Project URL」と、「API Keys」にある secret キー（sb_secret_ で始まるもの。古い形式なら Legacy の service_role）を入れてください。publishable／anon のキーではありません。キーは Secret Manager に保存し、画面には出しません。チャットには貼らないでください。</p>'
    + '<div class="row" style="gap:6px; flex-wrap:wrap"><input id="sb-url" autocomplete="off" placeholder="https://xxxx.supabase.co" style="min-width:20em"><input type="password" id="sb-key" autocomplete="off" placeholder="secret キー（sb_secret_…）" style="min-width:22em"><button class="btn sm" type="button" id="sb-save">保存</button></div>'
    + '<p class="err" id="sb-err" hidden></p>';
  const err = m => { $('sb-err').textContent = m; $('sb-err').hidden = !m; };
  $('sb-save').onclick = async () => { const url = $('sb-url').value.trim(), key = $('sb-key').value.trim(); if (!url || !key) return err('URLとキーの両方を入れてください');
    const b = $('sb-save'); b.disabled = true; b.textContent = '確かめています…';
    try { const r = await apiSend('PUT', '/admin/supabase', { url, key }); toast(r.ready ? '保存しました（表もあります）' : '保存しました。次に表を作ってください'); drawSupabase(); } catch (e) { err(e.message); b.disabled = false; b.textContent = '保存'; } };
  if ($('sb-sqlcopy')) $('sb-sqlcopy').onclick = async () => { try { await navigator.clipboard.writeText(d.sql); toast('コピーしました'); } catch (e) { $('sb-sql').select(); } };
  if ($('sb-recheck')) $('sb-recheck').onclick = () => drawSupabase();
  if ($('sb-copy')) $('sb-copy').onclick = async () => { const b = $('sb-copy'); b.disabled = true; b.textContent = '写しています…';
    try { const r = await apiSend('POST', '/admin/supabase/copy', {}); toast(r.ok ? '写しました（予測 ' + r.predictions + '行・実績 ' + r.actuals + '行）' : (r.skipped || r.error || '写せませんでした')); drawSupabase(); } catch (e) { err(e.message); b.disabled = false; b.textContent = '今すぐ写す'; } };
}
/** API・連携設定：AI の API の費用（Admin キーを入れると、毎月の費用を AI費に入れる。2026-10-29 ユーザー指定） */
async function drawAiCost() {
  const box = $('api-aicost'); if (!box) return;
  const head = '<div class="panel-head"><h2>AI の API の費用（Claude・OpenAI）</h2>';
  let d; try { d = await api('/admin/ai-costs'); } catch (e) { box.innerHTML = head + '</div><p class="err">' + esc(e.message) + '</p>'; return; }
  const P = [['anthropic', 'Claude（Anthropic）', 'sk-ant-admin…', 'https://console.anthropic.com/settings/admin-keys'], ['openai', 'OpenAI', 'sk-admin-…', 'https://platform.openai.com/settings/organization/admin-keys']];
  const n = P.filter(([k]) => d.providers[k].hasKey).length;
  box.innerHTML = head + '<span class="pill ' + (n ? 'ok' : 'off') + '">' + (n ? n + '件 連携済み' : '未設定') + '</span></div>'
    + '<p class="note">Admin キーを入れると、API の利用料（税抜き・ドル）を毎月読み、その月の月末のレートで円にして「ツール利用費」に入れます（' + mLabel(d.start) + 'から）。メディアへの分け方は Ahrefs の順位追跡のKW数の割合です。キーは Secret Manager に保存し、画面には出しません。</p>'
    + P.map(([k, l, ph, url]) => { const x = d.providers[k], c = x[d.cur], pv = x[d.prev];
      return '<h3 class="am-h">' + l + ' <span class="pill ' + (x.hasKey ? 'ok' : 'off') + '">' + (x.hasKey ? '連携済み' : '未設定') + '</span></h3>'
        + (x.hasKey ? '<p>' + mLabel(d.prev) + '：' + (pv ? yenUsd(pv.yen, pv.usd) : '—') + '　' + mLabel(d.cur) + '（途中）：' + (c ? yenUsd(c.yen, c.usd) : '—') + '</p>' : '') + (x.error ? '<p class="err">' + esc(x.error) + '</p>' : '')
        + '<div class="row" style="gap:6px; flex-wrap:wrap"><input type="password" autocomplete="off" id="aik-' + k + '" placeholder="' + (x.hasKey ? '変えるときだけ入力（' + ph + '）' : ph) + '" style="min-width:22em"><button class="btn sm" type="button" data-aik="' + k + '">保存</button><a class="note" href="' + url + '" target="_blank" rel="noopener">キーを作る画面</a></div>'; }).join('')
    + '<p class="err" id="aik-err" hidden></p>';
  box.querySelectorAll('[data-aik]').forEach(b => b.onclick = async () => {
    const k = b.dataset.aik, v = $('aik-' + k).value.trim(); if (!v) return;
    b.disabled = true; b.textContent = '確かめています…';
    try { await apiSend('PUT', '/admin/ai-costs', { provider: k, key: v }); toast('保存しました'); drawAiCost(); } catch (e) { $('aik-err').textContent = e.message; $('aik-err').hidden = false; b.disabled = false; b.textContent = '保存'; }
  });
}
/** API・連携設定：メール送信（Gmail）。送信元のアドレス本人が「送信だけ」を許可する方式。フル管理者だけ（2026-10-28 ユーザー指定） */
async function drawGmail() {
  const box = $('api-gmail'); if (!box) return;
  const head = '<div class="panel-head"><h2>メール送信（Gmail）</h2>';
  let g; try { g = await api('/admin/gmail'); } catch (e) { box.innerHTML = head + '</div><p class="err">' + esc(e.message) + '</p>'; return; }
  const st = g.connected ? ['ok', '連携済み'] : g.hasClient ? ['wait', '未連携'] : ['off', '未設定'];
  box.innerHTML = head + '<span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>送信元</dt><dd><b>' + esc(g.sender) + '</b> だけ（ほかのアドレスからは送れません）</dd>'
    + '<dt>連携するアカウント</dt><dd>' + (g.account ? '<b>' + esc(g.account) + '</b>' : '<span class="err">未設定</span>') + '</dd>'
    + '<dt>しくみ</dt><dd>' + esc(g.sender) + ' はグループでログインできないため、' + esc(g.account || '連携するアカウント') + ' で「メールの送信」だけを許可し、送信元を ' + esc(g.sender) + ' にして送ります（メールを読む・消すことはできません）。許可は Secret Manager に保存し、画面には出しません</dd>'
    + '<dt>事前の準備</dt><dd>' + esc(g.account || '連携するアカウント') + ' の Gmail →「設定」→「アカウント」→「他のメールアドレスを追加」で ' + esc(g.sender) + ' を登録しておく</dd>'
    + (g.connected ? '<dt>連携</dt><dd>' + esc((g.connectedAt || '').slice(0, 16).replace('T', ' ')) + '（' + esc(g.connectedBy) + '）</dd>' : '')
    + (g.lastError ? '<dt>エラー</dt><dd class="err">' + esc(g.lastError) + '</dd>' : '')
    + '<dt>送信待ち</dt><dd>' + g.queued + '件</dd>'
    + '<dt>リダイレクトURI</dt><dd><code>' + esc(g.redirectUri) + '</code><br><span class="note">OAuth クライアントの「承認済みのリダイレクト URI」に入れます</span></dd></dl>'
    + '<div class="form-grid" style="margin-top:10px">'
    + '<label class="full">クライアントID' + (g.hasClient ? '（保存済み。変えるときだけ入力）' : '') + '<input id="gm-id" autocomplete="off" placeholder="…apps.googleusercontent.com"></label>'
    + '<label class="full">クライアントシークレット' + (g.hasClient ? '（保存済み。変えるときだけ入力）' : '') + '<input id="gm-secret" type="password" autocomplete="off" placeholder="' + (g.hasClient ? '••••••••' : '') + '"></label>'
    + '<label class="full">連携するアカウント（' + esc(g.sender) + ' を送信元に登録した人）<input id="gm-account" value="' + esc(g.account || me.email || '') + '"></label>'
    + '<label class="full">送信元のアドレス<input id="gm-sender" value="' + esc(g.sender) + '"></label></div>'
    + '<p class="err" id="gm-err" hidden></p><div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px; flex-wrap:wrap">'
    + '<button class="btn" type="button" id="gm-save">保存</button>'
    + (g.hasClient ? '<button class="btn primary" type="button" id="gm-start">' + (g.connected ? '連携し直す' : g.account ? esc(g.account) + ' で連携する' : '連携する') + '</button>' : '')
    + (g.connected ? '<button class="btn" type="button" id="gm-test">自分にテスト送信</button>' + (g.queued ? '<button class="btn" type="button" id="gm-flush">送信待ちを送る</button>' : '') + '<button class="btn" type="button" id="gm-off">連携を解除</button>' : '')
    + '</div><p class="note">連携・解除・設定はフル管理者だけができます。「連携する」を押すと Google の画面が開くので、' + esc(g.account || '連携するアカウント') + ' を選んで許可してください。</p>';
  const err = m => { $('gm-err').textContent = m; $('gm-err').hidden = false; };
  $('gm-save').onclick = async () => {
    const id = $('gm-id').value.trim(), sec = $('gm-secret').value.trim(), sender = $('gm-sender').value.trim(), account = $('gm-account').value.trim();
    if ((sender !== g.sender || account !== g.account) && g.connected && !confirm('送信元・連携するアカウントを変えると、連携し直しが必要です。変えますか？')) return;
    try { await apiSend('PUT', '/admin/gmail', Object.assign({ sender, account }, id || sec ? { clientId: id, clientSecret: sec } : {})); toast('保存しました'); drawGmail(); } catch (e) { err(e.message); }
  };
  if ($('gm-start')) $('gm-start').onclick = async () => { try { const r = await apiSend('POST', '/admin/gmail/start', {}); window.open(r.url, '_blank', 'noopener'); toast('Google の画面で ' + g.account + ' を選んで許可してください'); } catch (e) { err(e.message); } };
  if ($('gm-test')) $('gm-test').onclick = async () => { try { const r = await apiSend('POST', '/admin/gmail/test', {}); toast(r.to + ' に送りました'); } catch (e) { err(e.message); } };
  if ($('gm-flush')) $('gm-flush').onclick = async () => { try { const r = await apiSend('POST', '/admin/gmail/flush', {}); toast(r.sent + '件 送りました'); drawGmail(); } catch (e) { err(e.message); } };
  if ($('gm-off')) $('gm-off').onclick = async () => { if (!confirm('Gmail の連携を解除しますか？（メールが送れなくなります）')) return; try { await apiSend('POST', '/admin/gmail/disconnect', {}); toast('解除しました'); drawGmail(); } catch (e) { err(e.message); } };
}

/** API・連携設定：Ahrefs（KW追従） */
/** API・連携設定：コピペチェック（Brave Search API の無料分。2026-10-28 ユーザー指定） */
async function drawCopySetting() {
  const box = $('api-copy'); if (!box) return;
  let a; try { a = await api('/admin/copycheck'); } catch (e) { box.innerHTML = '<div class="panel-head"><h2>コピペチェック（Brave Search）</h2></div><p class="err">' + esc(e.message) + '</p>'; return; }
  const st = !a.hasKey ? ['off', '未設定'] : a.used >= a.limit ? ['ng', '今月の上限'] : ['ok', '利用中'];
  box.innerHTML = '<div class="panel-head"><h2>コピペチェック（Brave Search）</h2><span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>しくみ</dt><dd>進行管理で記事URL・ライティングURL（Google ドキュメント）を入れるとチェック。本文から最大' + a.perArticle + '文を選んで Brave で検索し、自社メディア以外のページで見つかった割合（一致率）を出す</dd>'
    + '<dt>今月の検索回数</dt><dd><b class="num">' + a.used + '</b> / ' + a.limit + '回（無料分 約1,000回の手前で止めます。1記事 約' + a.perArticle + '回＝月 約' + Math.floor(a.limit / a.perArticle) + '記事）</dd>'
    + '<dt>チェック済み</dt><dd>' + a.checks + '件</dd>'
    + '<dt>原稿の共有先</dt><dd>ライティングURL（Google ドキュメント）は、ドキュメントかフォルダ・共有ドライブを <b>' + esc(a.saEmail || '') + '</b> に「閲覧者」で共有すると読めます</dd>'
    + '<dt>除くドメイン</dt><dd>' + a.excluded.map(esc).join('、') + '</dd></dl>'
    + '<div class="form-grid" style="margin-top:10px"><label class="full">APIキー' + (a.hasKey ? '（保存済み。変えるときだけ入力）' : '') + '<input id="cc-key" type="password" autocomplete="off" placeholder="' + (a.hasKey ? '••••••••' : 'Brave Search API のキー') + '"></label>'
    + '<label class="full">ほかに除くドメイン（1行に1つ。例：example.com）<textarea id="cc-ex" rows="3">' + esc(a.exclude.join('\n')) + '</textarea></label></div>'
    + '<p class="err" id="cc-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn primary" type="button" id="cc-save">保存</button></div>'
    + '<p class="note">APIキーは Secret Manager に保存し、画面には表示しません。自社メディアのドメインは自動で除きます。</p>';
  $('cc-save').onclick = async () => {
    const k = $('cc-key').value.trim(), ex = $('cc-ex').value.split(/\s+/).map(x => x.trim()).filter(Boolean);
    $('cc-save').disabled = true;
    try { await apiSend('PUT', '/admin/copycheck', Object.assign({ exclude: ex }, k ? { apiKey: k } : {})); toast('保存しました'); drawCopySetting(); } catch (e) { $('cc-err').textContent = e.message; $('cc-err').hidden = false; $('cc-save').disabled = false; }
  };
}
/** API・連携設定：競合調査（構成シート）のメディアごとの今月の回数・費用・上限（2026-11-13 ユーザー指定） */
async function drawCompeteSetting() {
  const box = $('api-compete'); if (!box) return;
  let a; try { a = await api('/admin/competitor'); } catch (e) { box.innerHTML = '<div class="panel-head"><h2>競合調査（Brave Search）</h2></div><p class="err">' + esc(e.message) + '</p>'; return; }
  const usd = v => '$' + (Math.round((v || 0) * 1000) / 1000).toFixed(3), mL = ym => ym.replace('-', '年') + '月';
  const tot = k => a.rows.reduce((x, r) => x + ((r[k] || {}).queries || 0), 0), totC = k => a.rows.reduce((x, r) => x + ((r[k] || {}).costUsd || 0), 0);
  box.innerHTML = '<div class="panel-head"><h2>競合調査（Brave Search）</h2><span class="pill ok">' + mL(a.ym) + ' ' + tot('now') + '回</span></div>'
    + '<dl class="card-kv"><dt>しくみ</dt><dd>構成シートの「競合調査」で、検索KWを Brave で1回検索し、上位のコンテンツのページを' + a.top + '件まで読みます（地図・SNS・動画・通販・データベース系などは除く）。コピペチェックと同じ Brave の無料分（全体で月 約1,000回）を使います</dd>'
    + '<dt>費用</dt><dd>1回 ' + usd(a.priceUsd) + '（Brave の料金）。メディアごとに、その月の月末のレートで円にして、支出の「ツール利用費」に入れます</dd><dt>上限</dt><dd>メディアごとの今月の回数。超えたら、そのメディアは来月まで取得できません（空欄＝' + a.defaultLimit + '回）</dd></dl>'
    + '<div class="table-wrap"><table class="am-table fx-table" style="width:auto"><colgroup><col style="width:190px"><col style="width:120px"><col style="width:110px"><col style="width:120px"><col style="width:110px"><col style="width:110px"></colgroup><thead><tr><th class="c-txt">メディア</th><th class="c-num">' + mL(a.ym) + '<br>回数</th><th class="c-num">' + mL(a.ym) + '<br>費用</th><th class="c-num">' + mL(a.prev) + '<br>回数・費用</th><th class="c-num">上限（回）</th><th class="c-ctr">状態</th></tr></thead><tbody>'
    + a.rows.map(r => { const n = (r.now || {}).queries || 0, full = n >= r.limit; return '<tr><td class="c-txt">' + esc(mediaLabel(r.media)) + '</td><td class="c-num">' + n + ((r.now || {}).ahrefsUnits ? '<div class="note">Ahrefs ' + nf.format(r.now.ahrefsUnits) + 'ユニット</div>' : '') + '</td><td class="c-num">' + usd((r.now || {}).costUsd) + '</td><td class="c-num">' + ((r.prev || {}).queries || 0) + '回・' + usd((r.prev || {}).costUsd) + '</td>'
      + '<td class="c-num"><input type="number" min="0" max="1000" data-cl="' + esc(r.media) + '" value="' + (r.limitSet ? r.limit : '') + '" placeholder="' + a.defaultLimit + '" style="width:80px"></td><td class="c-ctr">' + (full ? '<span class="pill ng">今月の上限</span>' : '<span class="pill ok">利用可</span>') + '</td></tr>'; }).join('')
    + '<tr><td class="c-txt"><b>合計</b></td><td class="c-num"><b>' + tot('now') + '</b></td><td class="c-num"><b>' + usd(totC('now')) + '</b></td><td class="c-num">' + tot('prev') + '回・' + usd(totC('prev')) + '</td><td></td><td></td></tr></tbody></table></div>'
    + '<p class="err" id="cl-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn primary" type="button" id="cl-save">上限を保存</button></div>';
  $('cl-save').onclick = async () => { const limits = {}; document.querySelectorAll('[data-cl]').forEach(el => { limits[el.dataset.cl] = el.value.trim(); });
    try { await apiSend('PUT', '/admin/competitor', { limits }); toast('保存しました'); drawCompeteSetting(); } catch (e) { $('cl-err').textContent = e.message; $('cl-err').hidden = false; } };
}
async function drawAhrefs() {
  const a = await api('/admin/ahrefs');
  const st = a.lastError ? ['ng', 'エラーあり'] : a.lastFetchResult ? ['ok', '取得済み'] : a.hasKey ? ['wait', '接続済み・未取得'] : ['off', '未設定'];
  const when = x => x ? x.slice(0, 16).replace('T', ' ') : '—';
  $('api-ahrefs').innerHTML = '<div class="panel-head"><h2>Ahrefs（KW追従）</h2><span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>KWの登録</dt><dd>毎週月曜 5時：進行管理で「完了」の記事の検索KWのうち、Rank Tracker に未登録のものを追加（メディアごとのプロジェクトがなければ自動作成）</dd>'
    + '<dt>順位の取得</dt><dd>毎月2日 5時：前月末時点の順位・URL・検索Vol・トラフィックを取得して「KW追従」に表示</dd>'
    + (a.pending.length ? '<dt>未登録のKW</dt><dd><span class="err">Rank Tracker のKW上限に達したため未登録：' + a.pending.map(p => esc(p.name) + ' ' + p.n + '件').join('、') + '（合計 ' + a.pending.reduce((x, p) => x + p.n, 0) + '件）</span><br><span class="note">Ahrefsの上限を増やすと、次の同期（毎週月曜。「今すぐKWを同期」でも可）で自動で追加します</span></dd>' : '')
    + '<dt>プロジェクト</dt><dd>' + (a.projects.length ? a.projects.map(p => esc(p.name) + '（ID ' + esc(p.id) + '）').join('、') : '—') + '</dd>'
    + '<dt>最終同期</dt><dd>' + esc(when(a.lastSyncAt)) + (a.lastSyncResult ? '<br>' + esc(a.lastSyncResult) : '') + '</dd>'
    + '<dt>最終取得</dt><dd>' + esc(when(a.lastFetchAt)) + (a.lastFetchResult ? '<br>' + esc(a.lastFetchResult) : '') + (a.lastError ? '<br><span class="err">' + esc(a.lastError) + '</span>' : '') + '</dd></dl>'
    + '<div class="form-grid" style="margin-top:10px"><label class="full">APIキー' + (a.hasKey ? '（保存済み。変えるときだけ入力）' : '') + '<input id="ahr-key" type="password" autocomplete="off" placeholder="' + (a.hasKey ? '••••••••' : 'Ahrefs の Account settings → API keys で発行したキー') + '"></label></div>'
    + '<p class="err" id="ahr-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px; flex-wrap:wrap"><button class="btn" type="button" id="ahr-sync"' + (a.hasKey ? '' : ' disabled') + '>今すぐKWを同期</button><button class="btn" type="button" id="ahr-fetch"' + (a.hasKey ? '' : ' disabled') + '>今すぐ順位を取得</button><button class="btn primary" type="button" id="ahr-save">保存</button></div>'
    + '<p class="note">APIキーは Secret Manager に保存し、画面には表示しません。使う API（プロジェクト・KWの登録、Rank Tracker の順位）は Ahrefs の API units を消費しません。</p>';
  const fail = m => { $('ahr-err').textContent = m; $('ahr-err').hidden = !m; };
  $('ahr-save').onclick = async () => {
    const k = $('ahr-key').value.trim(); if (!k) return fail('APIキーを入力してください');
    $('ahr-save').disabled = true;
    try { fail(''); await apiSend('PUT', '/admin/ahrefs', { apiKey: k }); drawAhrefs(); } catch (e) { fail(e.message); $('ahr-save').disabled = false; }
  };
  const run = (id, path, label) => { $(id).onclick = async () => { $(id).disabled = true; $(id).textContent = label + '中…（数分かかることがあります）'; try { const r = await apiSend('POST', path, {}); if (!r.ok) fail(r.error); drawAhrefs(); } catch (e) { fail(e.message); $(id).disabled = false; } }; };
  run('ahr-sync', '/admin/ahrefs/sync', 'KWを同期'); run('ahr-fetch', '/admin/ahrefs/fetch', '順位を取得');
}
/** API・連携設定：もしもアフィリエイト（毎月2日・15日に自動でログインしてCSVを取る。2026-10-14 ユーザー指定） */
async function drawMoshimo() {
  const a = await api('/admin/moshimo');
  const st = a.lastError ? ['ng', 'エラーあり'] : a.lastResult ? ['ok', '取得済み'] : a.hasLogin ? ['wait', '登録済み・未取得'] : ['off', '未設定'];
  $('api-moshimo').innerHTML = '<div class="panel-head"><h2>もしもアフィリエイト</h2><span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>取得内容</dt><dd>報酬の月次レポート（メディア全体＋メディアごと）の直近3か月分。収益情報 →「もしもアフィリエイト」に入ります</dd>'
    + '<dt>取得タイミング</dt><dd>毎月2日・15日 5時30分</dd>'
    + '<dt>ログインID</dt><dd>' + (a.hasLogin ? esc(a.account) + '（保存済み）' : '未登録') + '</dd>'
    + '<dt>最終取得</dt><dd>' + esc(a.lastRunAt ? a.lastRunAt.slice(0, 16).replace('T', ' ') : '—') + (a.lastError ? '<br><span class="err">' + esc(a.lastError) + '</span>' : a.lastResult ? '<br>' + esc(a.lastResult) : '') + '</dd></dl>'
    + '<div class="form-grid" style="margin-top:10px"><label>ログインID' + (a.hasLogin ? '（変えるときだけ入力）' : '') + '<input id="msm-acc" autocomplete="off"></label>'
    + '<label>パスワード<input id="msm-pw" type="password" autocomplete="new-password" placeholder="' + (a.hasLogin ? '••••••••' : '') + '"></label></div>'
    + '<p class="err" id="msm-a-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px; flex-wrap:wrap"><button class="btn" type="button" id="msm-all"' + (a.hasLogin ? '' : ' disabled') + '>過去分をすべて取得</button><button class="btn" type="button" id="msm-run"' + (a.hasLogin ? '' : ' disabled') + '>今すぐ取得（直近3か月）</button><button class="btn primary" type="button" id="msm-a-save">保存</button></div>'
    + '<p class="note">IDとパスワードは Secret Manager に保存し、画面には表示しません。ログインに画像認証などが出るようになった場合は自動取得が止まるので、収益管理の画面からCSVを取り込んでください。</p>';
  const fail = m => { $('msm-a-err').textContent = m; $('msm-a-err').hidden = !m; };
  $('msm-a-save').onclick = async () => {
    const acc = $('msm-acc').value.trim(), pw = $('msm-pw').value;
    if (!acc || !pw) return fail('IDとパスワードを両方入力してください');
    $('msm-a-save').disabled = true;
    try { fail(''); await apiSend('PUT', '/admin/moshimo', { account: acc, password: pw }); drawMoshimo(); } catch (e) { fail(e.message); $('msm-a-save').disabled = false; }
  };
  const run = (id, all, wait) => { $(id).onclick = async () => {
    const b = $(id), label = b.textContent; b.disabled = true; b.textContent = '取得中…（' + wait + 'ほどかかります）';
    try { const r = await apiSend('POST', '/admin/moshimo/run', { all }); if (!r.ok) fail(r.error); if (me.perms.media !== 'none') MONTHLY = await api('/monthly'); DAILY_CACHE.clear(); drawMoshimo(); } catch (e) { fail(e.message); b.disabled = false; b.textContent = label; }
  }; };
  run('msm-run', false, '1分');
  run('msm-all', true, '3〜5分');   // 2021年〜今月の全部（2026-10-14 ユーザー指定）
}
/** API・連携設定：検索Vol（Ahrefs のキーワード調査。2026-10-13 ユーザー指定で Google広告から切り替え） */
async function drawKwVol() {
  const a = await api('/admin/kwvol');
  if (!$('api-kwvol')) return;   /* 読み込みの間にほかの画面へ移ったとき（2026-11-06 巡回で見つかった） */
  const nf0 = n => n == null ? '—' : Number(n).toLocaleString();
  const u = a.units;
  const st = a.lastError ? ['ng', 'エラーあり'] : !a.hasKey ? ['off', '未設定'] : a.enabled ? ['ok', '毎月自動で取得'] : ['wait', '停止中（プラン変更待ち）'];
  $('api-kwvol').innerHTML = '<div class="panel-head"><h2>検索Vol（Ahrefs）</h2><span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>取得内容</dt><dd>記事管理の検索KWの検索Vol（Ahrefs・日本・直近12か月の平均）。取得のたびに保存して、毎月の値をためていきます</dd>'
    + '<dt>取得タイミング</dt><dd>毎月5日 4時台（下の「毎月の自動取得」が有効のときだけ）</dd>'
    + '<dt>対象のKW</dt><dd>' + nf0(a.targets) + 'KW<br><span class="note">記事のKW ' + nf0(a.total) + '件のうち、Rank Tracker に登録済みの ' + nf0(a.tracked) + '件は順位の取得で検索Volも取れているので除いています</span></dd>'
    + '<dt>使うユニットの目安</dt><dd>1回あたり 約' + nf0(a.estimate) + 'ユニット<span class="note">（1KWにつき10ユニット・1回の呼び出しは最低50ユニット）</span></dd>'
    + '<dt>Ahrefsのユニット</dt><dd>' + (u ? '残り ' + nf0(u.left) + ' ／ ' + nf0(u.limit) + '（今月の使用 ' + nf0(u.used) + '）' + (u.resetDate ? '<br><span class="note">' + esc(String(u.resetDate).slice(0, 10)) + ' にリセット' + (u.plan ? '・プラン：' + esc(u.plan) : '') + '</span>' : '') : a.unitsError ? '<span class="err">' + esc(a.unitsError) + '</span>' : '—') + '</dd>'
    + '<dt>最終取得</dt><dd>' + esc(a.lastRunAt ? a.lastRunAt.slice(0, 16).replace('T', ' ') : '—') + (a.lastError ? '<br><span class="err">' + esc(a.lastError) + '</span>' : a.lastResult ? '<br>' + esc(a.lastResult) : '') + '</dd></dl>'
    + '<label class="field" style="flex-direction:row; align-items:center; gap:6px; margin-top:10px"><input type="checkbox" id="kv-enabled"' + (a.enabled ? ' checked' : '') + (a.hasKey ? '' : ' disabled') + '>毎月の自動取得を有効にする</label>'
    + '<p class="err" id="kv-err" hidden></p><div class="row" style="justify-content:flex-end; margin-top:8px; flex-wrap:wrap"><button class="btn" type="button" id="kv-test"' + (a.hasKey ? '' : ' disabled') + '>お試し（10KW）</button><button class="btn" type="button" id="kv-run"' + (a.hasKey && a.targets ? '' : ' disabled') + '>今すぐ全KWを取得</button></div>'
    + '<p class="note">APIキーは下の「Ahrefs（KW追従）」と同じものを使います。お試しは約100ユニットを使い、使った量を「最終取得」に表示します。</p>';
  const fail = m => { $('kv-err').textContent = m; $('kv-err').hidden = !m; };
  $('kv-enabled').onchange = async e => {
    const on = e.target.checked;
    if (on && !confirm('毎月5日に、対象のKWの検索Volを自動で取得します（1回あたり 約' + nf0(a.estimate) + 'ユニット）。有効にしますか？')) { e.target.checked = false; return; }
    try { fail(''); await apiSend('PUT', '/admin/kwvol', { enabled: on }); drawKwVol(); } catch (err) { fail(err.message); e.target.checked = !on; }
  };
  const run = (id, body, msg) => { $(id).onclick = async () => {
    if (!confirm(msg)) return;
    const b = $(id), label = b.textContent; b.disabled = true; b.textContent = '取得中…（数分かかることがあります）';
    try { const r = await apiSend('POST', '/admin/kwvol/run', body); if (!r.ok) fail(r.error); ITEMS = null; drawKwVol(); } catch (e) { fail(e.message); b.disabled = false; b.textContent = label; }
  }; };
  run('kv-test', { limit: 10 }, '対象のKWのうち10KWだけ取得します（約100ユニット）。よろしいですか？');
  run('kv-run', {}, '対象の ' + nf0(a.targets) + 'KW をすべて取得します（約' + nf0(a.estimate) + 'ユニット）。よろしいですか？');
}

/** API・連携設定：kintone（SEO回線の案件。お客様情報は取り込まない） */
async function drawKintone() {
  const k = await api('/admin/kintone');
  const st = k.lastError ? ['ng', 'エラーあり'] : k.lastResult ? ['ok', '取得済み'] : k.hasToken ? ['wait', '未取得'] : ['off', '未設定'];
  const medias = topMedia();
  const guess = v => (medias.find(m => String(v).startsWith(m.name)) || {}).media || '';
  $('api-kintone').innerHTML = '<div class="panel-head"><h2>kintone（案件管理）</h2><span class="pill ' + st[0] + '">' + st[1] + '</span></div>'
    + '<dl class="card-kv"><dt>取得内容</dt><dd>回線種別が「' + esc(k.lineType) + '」の案件だけ。受付日時・回線名・問い合わせ内容・都道府県・市区町村・作業員・担当会社・有効コール／訪問確定フラグ・結果・売上合計金額・部材費控除額（毎日4時台に取り直し）</dd>'
    + '<dt>お客様情報</dt><dd>お客様名・カナ名・電話番号・メールアドレス・郵便番号・町名・番地・建物名は取得しません（kintoneから受け取る項目を固定しています）。</dd>'
    + '<dt>最終取得</dt><dd>' + esc(k.lastRunAt ? k.lastRunAt.slice(0, 16).replace('T', ' ') : '—') + (k.lastError ? '<br><span class="err">' + esc(k.lastError) + '</span>' : k.lastResult ? '<br>' + esc(k.lastResult) : '') + '</dd></dl>'
    + '<div class="form-grid"><label>サブドメイン（〇〇〇.cybozu.com の〇〇〇）<input id="kt-sub" value="' + esc(k.subdomain) + '"></label><label>アプリID<input id="kt-app" inputmode="numeric" value="' + esc(k.appId) + '"></label>'
    + '<label class="full">APIトークン（「レコード閲覧」だけ）' + (k.hasToken ? '（保存済み。変えるときだけ入力）' : '') + '<input id="kt-token" type="password" autocomplete="off" placeholder="' + (k.hasToken ? '••••••••' : 'アプリの設定 → APIトークン で発行') + '"></label></div>'
    + '<div class="row" style="justify-content:flex-end; margin-top:6px"><button class="btn" type="button" id="kt-run"' + (k.hasToken ? '' : ' disabled') + '>今すぐ取得</button><button class="btn primary" type="button" id="kt-save">接続情報を保存</button></div>'
    + (k.lineValues.length ? '<h3 class="am-h">回線名とメディア <span class="note">回線名の先頭がメディア名なら自動で対応づけます。違う場合だけ選び直してください</span></h3><div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">回線名</th><th class="c-num">件数</th><th class="c-txt">メディア</th></tr></thead><tbody>'
      + k.lineValues.map((m, i) => { const cur = k.mediaMap[m.value] || guess(m.value); return '<tr><td class="c-txt">' + esc(m.value || '（空欄）') + '</td><td class="c-num">' + nf.format(m.count) + '</td><td class="c-txt"><select data-mv="' + i + '"><option value="">（どのメディアにも入れない）</option>' + medias.map(x => '<option value="' + esc(x.media) + '"' + (cur === x.media ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></td></tr>'; }).join('')
      + '</tbody></table></div><div class="row" style="justify-content:flex-end; margin-top:6px"><button class="btn primary" type="button" id="kt-mm">対応づけを保存</button></div>' : '')
    + '<p class="err" id="kt-err" hidden></p>';
  const fail = m => { $('kt-err').textContent = m; $('kt-err').hidden = !m; };
  $('kt-save').onclick = async () => { try { fail(''); await apiSend('PUT', '/admin/kintone', { subdomain: $('kt-sub').value.trim(), appId: $('kt-app').value.trim(), token: $('kt-token').value.trim() }); drawKintone(); } catch (e) { fail(e.message); } };
  $('kt-run').onclick = async () => { const b = $('kt-run'); b.disabled = true; b.textContent = '取得中…'; try { const r = await apiSend('POST', '/admin/kintone/collect', {}); if (!r.ok) fail(r.error); SEO = null; drawKintone(); } catch (e) { fail(e.message); } };
  if ($('kt-mm')) $('kt-mm').onclick = async () => {
    const mediaMap = {}; document.querySelectorAll('#api-kintone [data-mv]').forEach(el => { const v = k.lineValues[Number(el.dataset.mv)].value; if (el.value && el.value !== guess(v)) mediaMap[v] = el.value; });
    try { fail(''); await apiSend('PUT', '/admin/kintone', { mediaMap }); SEO = null; drawKintone(); } catch (e) { fail(e.message); }
  };
}

// ================= 記事管理（メディアごと。各メディアの記事管理シート＋ダッシュボードでの入力） =================
let ITEMS = null, SUPERVISED = [], PEOPLE = [];
// シートの進行状況の書き方 → ダッシュボードの段階（2026-10-09 ユーザー決定）
const STATUS_ALIAS = { '最終化': '完了', '構成レビュー中': '構成作成完了', '記事レビュー中': '記事執筆完了', '監修者確認完了': '記事監修者確認', '監修者確認中': '構成監修者確認', '構成・監修者確認中': '構成作成完了', '構成確認中（BEST）': '構成作成完了', '構成確認中(BEST)': '構成作成完了', '': '未着手' };
// 担当者の列ごとに選べるポジション（PM〜アシスタント兼ライターはディレクション〜アップロード、ライターは執筆・アップロードのみ、監修は監修者）
const DIR_POSITIONS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター'];
/** ディレクション担当が空の記事のディレクション担当（2026-10-27 ユーザー指定）：記事の月（アップロード日→依頼日→今月）の、メディア担当管理の担当から決める。
 *  休職中（契約管理の休職期間）の人は除く。契約管理・メディア担当管理を変えるとそのまま反映される */
let UNIT_DIRECTORS = null, UNIT_SUPS = null;
const SUP_AUTO_UNTIL = '2026-10-28';   // 監修担当を自動で補うのは、この日までにアップロード（なければ依頼）した記事だけ。これからの記事には入れない（2026-10-28 ユーザー指定）
/** 監修担当が空の記事：その月のメディア担当管理の「監修者」（ディレクトリ → メディア全体の順）（2026-10-28 ユーザー指定） */
const supervisorDefault = x => { if (!UNIT_SUPS) return ''; const m = String(x.upload_date || x.request_date || todayJst()).slice(0, 7), map = UNIT_SUPS[m] || UNIT_SUPS[Object.keys(UNIT_SUPS).filter(k => k <= m).sort().pop()] || {}; return map[x.media + '|' + (x.sub || '')] || map[x.media + '|'] || ''; };
/** プレスリリース（2026-10-31 ユーザー指定）：担当＝画面で直した人 → シートの「ディレクター相談」の名前 → その月のそのメディアのディレクション担当 */
let PRESS_ITEMS = null;
const isPressStaff = () => isAdmin() || (!!me && ['exec', 'employee', 'contract', 'parttime'].includes(me.roleEff));
/** ライター（業務委託ライター・契約外ライター）：コンテンツ作成は月次進行管理だけ（2026-11-04 ユーザー指定） */
const isWriterOnly = () => !isAdmin() && !!me && ['out_writer', 'free_writer'].includes(me.roleEff);
/** プレスリリース進行管理を見られる人：社員に加えて、業務委託のディレクション担当（PM・ディレクター・AD・アシスタント兼ライター）は見るだけ（2026-11-04 ユーザー指定） */
const canSeePress = () => hasCap('press_view', () => isPressStaff() || (!!me && ['out_director', 'out_ad', 'out_aw'].includes(me.roleEff)));   /* プレスリリース進行管理を見られる人：管理者・BEST役員・BEST社員 */
const PRESS_NONE = '（担当なし）';   /* 担当を外したリリース（自動で担当を補わない）（2026-10-31 ユーザー指定） */
/** シートの「（徳良さん）」のような名字だけの名前 → 契約管理・BEST社員管理のフルネーム（1人だけ当てはまるとき）（2026-11-02） */
const fullPersonName = (v, media) => { if (!v) return ''; const p = personName(v, media); if (p && p !== v) return p; const k = String(v).replace(/さん$/, '').replace(/[\s　]/g, ''); const names = [...new Set(((typeof CONTRACTS !== 'undefined' && CONTRACTS && CONTRACTS.contracts) || []).map(c => c.name).concat((STAFF_NAMES || []).map(x => x.name)).filter(Boolean))]; const hit = names.filter(n => String(n).replace(/[\s　]/g, '').startsWith(k)); return hit.length === 1 ? hit[0] : v; };
const pressOwner = x => x.owner === PRESS_NONE ? '' : x.owner || (x.sheetOwner ? fullPersonName(x.sheetOwner, x.media) : '') || directorDefault({ media: x.media, sub: x.sub, upload_date: x.date }) || '';
const directorDefault = x => { if (!UNIT_DIRECTORS) return ''; const m = String(x.upload_date || x.request_date || todayJst()).slice(0, 7), map = UNIT_DIRECTORS[m] || UNIT_DIRECTORS[Object.keys(UNIT_DIRECTORS).filter(k => k <= m).sort().pop()] || {}; return map[x.media + '|' + (x.sub || '')] || map[x.media + '|'] || ''; };
const WRITER_FROM_UPLOAD = ['カギお助け', 'ガラスお助け'];
/** 幸谷さんがまとめて請求するメディア：記事の担当者（清水さんなど幸谷さん独自の契約の人）は、そのメディアを担当メディアに持つ契約（＝幸谷さん）でだけ計算する（2026-10-30 ユーザー指定） */
const OWN_BILLING_MEDIA = ['カギお助け', 'ガラスお助け'];
/** 同じメディアで、検索KW とアップロード日が同じ記事は1本として数える（ガラスお助けの「進行中」と「過去記事」に同じ記事が2行ある。2026-10-30） */
const dedupeArts = rs => { const seen = new Set(); return rs.filter(r => { const kw = String(r.kw || r.keyword || '').trim(); if (!kw || !r.upload_date) return true; const k = r.media + '|' + kw + '|' + r.upload_date; if (seen.has(k)) return false; seen.add(k); return true; }); };
/** ディレクトリごとにまとめて1つの契約で計算するもの：水まわりお助け本舗の過去制作は井上さん（ハドリー）の担当記事（担当者名は藤内・神保など）（2026-10-30 ユーザー指定） */
const SUB_OWNER = { '水まわりお助け|過去制作': 'isp1yZpozx7MIQPIeUdT' };
const subOwner = r => SUB_OWNER[r.media + '|' + (r.sub || '')] || '';
/** その契約から見た記事：まとめて計算するディレクトリの記事は、その契約の人の担当（主の担当の欄に名前）にし、ほかの契約からは外す */
const ownView = (c, rs) => rs.filter(r => !subOwner(r) || subOwner(r) === c.id).map(r => subOwner(r) ? Object.assign({}, r, { director: '', writer: '', upload_owner: '', supervisor: '', image_owner: '', [RW_ROLE_KEY[c.category] || 'writer']: c.name })
  : OWN_BILLING_MEDIA.includes(r.media) && mediasAt(c, String(r.upload_date || '').slice(0, 7)).includes(r.media) ? Object.assign({}, r, { upload_owner: c.name })
  : GENRE_ALL[c.id] && r.media === GENRE_ALL[c.id][0] && r.sub === GENRE_ALL[c.id][1] && String(r.upload_date || '') <= (GENRE_ALL[c.id][2] || '9999') ? Object.assign({}, r, { writer: c.name, upload_owner: c.name, image_owner: c.name }) : r);
/** そのメディア・ディレクトリの記事は、担当者の名前にかかわらず全部その人の記事として数える契約（ほかの契約からは外さない）。
 *  工藤さんの BEST365 外壁屋根：工藤さんの請求管理シートには、はしば・とくさんが書いた記事も含めて全記事が文字数×9円・アップロード・画像で入っている（2026-11-02） */
const GENRE_ALL = { YJ0IkAGdcsZHGdLDNO1Q: ['BEST365', '外壁屋根', '2025-12-31'] };   /* 3つ目＝この日まで（工藤さんは 2026-01 から休職） */   /* カギ・ガラスのアップロードは、アップロード担当の名前にかかわらず幸谷さんの分（チームの人がアップロード。2026-10-31 ユーザー指定） */
/** その月の担当メディア（以前の契約内容の期間に medias があればそれ）（2026-10-31） */
const mediasAt = (c, ym) => { const pp = (c.pastPays || []).find(p => p.from <= ym && ym <= p.to); if (pp && (pp.medias || []).length) return pp.medias;
  /* 担当メディアの変更（2026-11-13）：その月より前の一番新しい変更の後のメディア。最初の変更より前の月は、その変更の前のメディア */
  const ch = (c.mediaChanges || []).slice().sort((a, b) => a.from.localeCompare(b.from)), done = ch.filter(x => x.from <= ym).pop();
  if (done) return done.medias; if (ch.length && (ch[0].prevMedias || []).length) return ch[0].prevMedias; return c.baseMedias || c.medias || []; };
/** 報酬を払う月：請求月（bill_ym。アップロード月と違う月にまとめて請求したとき）があればその月、なければアップロード日の月（2026-10-31 ユーザー指定） */
/* bill_ym は「YYYY-MM」（全員）か「名前=YYYY-MM」（その人だけ）をカンマ区切り。同じ記事でも人によって請求月が違う（No.041：種石さん7月・横山さん8月。2026-11-02） */
const billYms = r => String(r.bill_ym || '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const i = s.lastIndexOf('='); return i < 0 ? { who: '', ym: s } : { who: s.slice(0, i).trim(), ym: s.slice(i + 1).trim() }; });
const billMonthFor = (c, r) => { const b = billYms(r), own = c && b.find(x => x.who && x.who === c.name), all = b.find(x => !x.who); return own ? own.ym : all ? all.ym : String(r.upload_date || '').slice(0, 7); };
const paidIn = (r, m) => { if (!((r.upload_date || '') <= todayJst())) return false; const b = billYms(r), all = b.find(x => !x.who); return (all ? all.ym : String(r.upload_date || '').slice(0, 7)) === m || b.some(x => x.who && x.ym === m); };
/* bill_skip：その契約者には払わない記事（契約者名をカンマ区切り。請求管理シートに載っていない記事。種石さんの No.062。2026-11-02） */
const billableFor = (c, r) => r.status !== 'BEST365から移管' && !String(r.bill_skip || '').split(',').map(s => s.trim()).includes(c.name) && (!c._multi || (c.medias || []).concat(...(c.pastPays || []).map(p => p.medias || [])).includes(r.media)) && (!OWN_BILLING_MEDIA.includes(r.media) || mediasAt(c, String(r.upload_date || '').slice(0, 7)).includes(r.media));   /* カギ・ガラスは、その月にそのメディアを担当していた契約だけ（幸谷さんのガラスは 2026-02 から。2026-10-31 ユーザー指定） */   /* 移管前の記事は BEST365 の行で数える（屋根外壁お助けの「BEST365から移管」の行は二重になるので数えない。2026-10-30 ユーザー指定） */   // 執筆担当が空ならアップロード担当を執筆担当に（2026-10-27 ユーザー指定）
const ROLE_POSITIONS = { director: DIR_POSITIONS, writer: DIR_POSITIONS.concat('ライター'), upload_owner: DIR_POSITIONS.concat('ライター'), supervisor: ['監修者'] };
const peopleFor = (media, k) => {
  /* 監修者の契約がないメディア（屋根外壁お助け本舗など）は、そのメディアのディレクター・BEST社員も監修担当に選べる（2026-11-06 ユーザー指定：監修担当が「担当外」のまま紐づかなかった） */
  const pos = k === 'supervisor' && !PEOPLE.some(p => p.media === media && ROLE_POSITIONS.supervisor.includes(p.position)) ? ROLE_POSITIONS.supervisor.concat(DIR_POSITIONS) : (ROLE_POSITIONS[k] || []);
  return [...new Set(PEOPLE.filter(p => p.media === media && (p.staff || pos.includes(p.position)) && (p.writerType !== '自社ライター' || k === 'writer')).map(p => p.name))];
};   // BEST社員は担当メディアのどの担当にも選べる（2026-10-28）   // BEST社員は担当メディアのどの担当にも選べる（2026-10-28）
let KNOWN_PEOPLE = new Set();   // 契約管理・BEST社員管理に登録されている名前（退職・契約解除も含む）
const normName = s => String(s || '').normalize('NFKC').replace(/\s/g, '');   // 「〇〇（自社ライター）」は執筆担当だけ
// 制作判断の表記ゆれをまとめる（2026-10-10 ユーザー指定）
const typeAlias = t => { const v = String(t || '').trim(), z = v.replace(/[％]/g, '%').replace(/[〜~]/g, '～');
  if (/^リライト[（(]新規[）)]$/.test(z)) return 'リライト(新規)';   // 2026-10-28 ユーザー指定：独立した制作判断（単価は新規と同じ）
  if (/^リライト[（(]30%～50%[）)]$/.test(z) || /^簡易リライト[（(]30%未満[）)]$/.test(z)) return '簡易リライト';
  if (z === '保留') return '';
  if (z === '既存記事差し替え') return '新規';   // ガラスお助け（2026-10-10 はリライト、2026-10-31 ユーザー指定で新規に変更）
  return v; };
// 進行状況が空欄の記事を「完了」にする条件。洗面台は構成URL・ライティングURLもそろっていること（2026-10-10 ユーザー指定）
// 記事URLが先に入るシート（水まわり洗面台・ガラス進行中）は、構成URL・ライティングURLもそろって完了（2026-10-10 ユーザー指定）
const BLANK_DONE_NEEDS = { '水まわりお助け': { '洗面台': ['outline_url', 'writing_url'] }, 'ガラスお助け': { '進行中': ['outline_url', 'writing_url'] } };
const blankDone = x => !!String(x.url || '').trim() && ((BLANK_DONE_NEEDS[x.media] || {})[x.sub] || []).every(k => !!String(x[k] || '').trim());
// 制作判断が空欄のときの既定値（ガラスお助けの過去記事②はリライト記事一覧）
const TYPE_DEFAULT_BY_SUB = { 'ガラスお助け': { '過去記事②': 'リライト' } };
const NEED_SUB_MEDIA = ['害獣お助け'];
const DESIGN_DIRECTOR = { '害獣お助け': '日比野' };
async function loadItems() {
  await loadPersonNames();   // 担当者の名前をそろえる（2026-10-27）
  if (!ITEMS) {
    const [r, ud, pr] = await Promise.all([api('/article-items'), api('/unit-directors').catch(() => null), api('/press-items').catch(() => ({ items: [] }))]);
    PRESS_ITEMS = (pr.items || []).filter(x => x.media);   // プレスリリース（2026-10-31）
    UNIT_DIRECTORS = ud ? ud.months : null; UNIT_SUPS = ud ? ud.sups || null : null;
    SUPERVISED = r.supervised || []; REL_KW_MEDIA = r.relatedKw || []; PEOPLE = r.people || []; KNOWN_PEOPLE = new Set(r.known || []);
    // 進行状況が空欄の記事：記事URLがあれば「完了」（公開済み）、なければ「未着手」（2026-10-10 ユーザー決定）
    // 監修有無に監修者の名前が入っている記事は「あり」にして、名前は監修担当へ
    (r.items || []).forEach(x => { const sv = String(x.supervision || '').trim(); if (sv && sv !== 'あり' && sv !== 'なし') { x.supervisor = x.supervisor || sv; x.supervision = 'あり'; } });
    ITEMS = (r.items || []).map(x => Object.assign(x, { type_raw: x.type, query_type: x.query_type ? String(x.query_type).trim().toUpperCase() : x.query_type, position: x.position === 'キラーページ(子)' ? 'キラーページ' : x.position, type: typeAlias(x.type) || ((TYPE_DEFAULT_BY_SUB[x.media] || {})[x.sub] || ''), status: x.status ? (STATUS_ALIAS[x.status] || x.status) : (blankDone(x) ? '完了' : '未着手') }));
    // ディレクトリが空の記事（害獣お助け：シート最下部の数式が切れている行）は載せない（2026-10-10 ユーザー指定）
    ITEMS = ITEMS.filter(x => !(NEED_SUB_MEDIA.includes(x.media) && x.source === 'sheet' && !x.sub));
    // 構成URLが「なし」の記事は空欄（害獣お助け：設計シートなし）。進行状況も構成作成完了にしない
    ITEMS.forEach(x => { if (/^(なし|無し|ナシ)$/.test(String(x.outline_url || '').trim())) { x.outline_url = null; if (x.source === 'sheet' && x.status === '構成作成完了' && NEED_SUB_MEDIA.includes(x.media)) x.status = '未着手'; } });
    // 設計完了（設計シートあり）の記事のディレクション担当（シートに列がないメディア。2026-10-10 ユーザー指定）
    ITEMS.forEach(x => { const d = DESIGN_DIRECTOR[x.media]; if (d && x.source === 'sheet' && !x.director && String(x.outline_url || '').trim()) x.director = d; });
    // 執筆担当の欄が空のシート（カギお助け・ガラスお助け。担当者はアップロード担当の欄に書く運用）は、アップロード担当の人を執筆担当として扱う（2026-10-27 ユーザー指定）
    // 専門レベル「A(監修者必須)」「要監修」は監修あり、「監修者不要」「監修不要」は監修なし（シロアリお助け：監修有無の列がなく専門レベルで決まる。2026-10-31 ユーザー指定）
    const supByLevel = x => { const e = String(x.expertise || ''); return /必須|要監修/.test(e) ? 'あり' : /不要/.test(e) ? 'なし' : ''; };
    const SV_MEDIA = new Set(ITEMS.filter(x => String(x.supervision || '').trim() || String(x.supervisor || '').trim()).map(x => x.media));
    /* 専門レベルで監修を決めるメディアのリライトは、監修の請求に入っていない＝監修なし（シロアリお助け No.057 のリライト。2026-10-31 ユーザー指定） */
    const isRw = x => /リライト/.test(String(x.type || '') + String(x.type_raw || '')) || /[（(]リライト[）)]/.test(String(x.kw || ''));
    ITEMS.forEach(x => { if (!String(x.supervision || '').trim() && !SV_MEDIA.has(x.media) && supByLevel(x)) x.supervision = isRw(x) ? 'なし' : supByLevel(x); });
    const LEVEL_MEDIA = new Set(ITEMS.filter(x => !SV_MEDIA.has(x.media) && supByLevel(x)).map(x => x.media));   // 専門レベルで監修が決まるメディア   // シートに監修の列があるメディア（監修有無か監修担当が入っている記事がある）
    ITEMS.forEach(x => { if (x.source === 'sheet' && !String(x.director || '').trim()) { const d = directorDefault(x); if (d) x.director = d; } if (x.source === 'sheet' && !String(x.supervisor || '').trim() && !SV_MEDIA.has(x.media) && (LEVEL_MEDIA.has(x.media) ? x.supervision === 'あり' : String(x.upload_date || x.request_date || '9999') <= SUP_AUTO_UNTIL)) { const sv = supervisorDefault(x); if (sv) x.supervisor = sv; } });   // 監修担当を補うのは、シートに監修の列がないメディア（どの記事にも監修有無・監修担当がない。今はシロアリお助け）だけ（2026-10-28 ユーザー指定：水まわり・BEST365・ガラスには自動で入れない）   // ディレクション担当の列がないシート
    // 最新対応が空欄の記事は、未着手以外は新規（2026-10-27 ユーザー指定）
    ITEMS.forEach(x => { if (!String(x.type || '').trim() && x.status && x.status !== '未着手') x.type = '新規'; });
    ITEMS.forEach(x => { if (WRITER_FROM_UPLOAD.includes(x.media) && x.source === 'sheet' && !String(x.writer || '').trim() && String(x.upload_owner || '').trim()) x.writer = x.upload_owner; });
    // BEST365 から移ってきた記事（記事No.の範囲で決める。2026-10-10 ユーザー指定：屋根 001〜028、外壁 301〜313）
    ITEMS.forEach(x => { const n = Number(String(x.no || '').replace(/\D/g, '')), rg = (MIGRATED_NO[x.media] || {})[x.sub]; if (rg && x.source === 'sheet' && n >= rg[0] && n <= rg[1]) x.status = 'BEST365から移管'; });
  }
  return ITEMS;
}
// 構成チェック中・記事チェック中・アップロードチェック中（2026-10-28 ユーザー指定）
const STATUS_ORDER = ['未着手', '構成作成中', '構成作成完了', '構成チェック中', '構成監修者確認', '記事執筆中', '記事執筆完了', '記事チェック中', '記事監修者確認', 'アップロードチェック中', '完了', 'BEST365から移管', '記事移管中', '記事移管完了'];
// BEST365 から移ってきた記事（受け入れ側のメディアだけ）。行は濃いめのオレンジ
const IMPORT_STATUSES = ['BEST365から移管'], IMPORT_MEDIA = ['屋根外壁お助け'];
// BEST365 から移ってきた記事の記事No.の範囲（メディア → ディレクトリ → [最初, 最後]）
const MIGRATED_NO = { '屋根外壁お助け': { '屋根': [1, 28], '外壁': [301, 313] } };
// 記事の移管（BEST365 だけ）。移管完了の記事は記事一覧に出さず、背景をグレーにする
const MIGRATE_STATUSES = ['記事移管中', '記事移管完了'], MIGRATE_MEDIA = ['BEST365'];
// 停止したディレクトリ（記事はすべて移管済み）
const STOPPED_SUBS = { 'BEST365': ['外壁屋根', '電気設備'] };
const isStopped = r => (STOPPED_SUBS[r.media] || []).includes(r.sub);
const movedOut = r => r.status === '記事移管完了' || isStopped(r);
const stoppedNote = media => media !== ALL && STOPPED_SUBS[media] ? ' <span class="pill moved">ディレクトリ停止：' + STOPPED_SUBS[media].map(esc).join('・') + '</span>' : '';
const statusOptsFor = media => media === ALL ? STATUS_ORDER.slice() : STATUS_ORDER.filter(x => (isSupMedia(media) || !SUP_STATUSES.includes(x)) && (!MIGRATE_STATUSES.includes(x) || MIGRATE_MEDIA.includes(media)) && (!IMPORT_STATUSES.includes(x) || IMPORT_MEDIA.includes(media)));
const SUP_STATUSES = ['構成監修者確認', '記事監修者確認'];
const isSupMedia = m => m === ALL ? SUPERVISED.length > 0 : SUPERVISED.includes(m);
let REL_KW_MEDIA = [];   // 進行管理に関連KWの列を出すメディア（管理 →「メディア管理」で設定。2026-10-28 ユーザー指定）
const isRelMedia = m => m === ALL ? REL_KW_MEDIA.length > 0 : REL_KW_MEDIA.includes(m);
const relKwList = v => String(v || '').split(/[\n\r、，]+|,(?!\d{3}(?!\d))/).map(x => x.trim()).filter(Boolean).reduce((a, x) => { if (/^\d{3}$/.test(x) && a.length && /\d$/.test(a[a.length - 1])) a[a.length - 1] += ',' + x; else a.push(x); return a; }, []);   // 関連KWは1行に1つ   // メディア累計：監修ありのメディアが1つでもあれば
/** 記事ごとの監修あり／なし。未入力なら専門レベルから判断（「監修者不要」→なし、A・B→あり） */
const supOf = r => r.supervision || (/不要/.test(r.expertise || '') ? 'なし' : /必要|要監修/.test(r.expertise || '') || /^[AＡBＢ]/i.test(String(r.expertise || '').trim()) ? 'あり' : '');
const statusesFor = r => STATUS_ORDER.filter(x => (isSupMedia(r.media) && supOf(r) !== 'なし' || !SUP_STATUSES.includes(x)) && (!MIGRATE_STATUSES.includes(x) || MIGRATE_MEDIA.includes(r.media)) && (!IMPORT_STATUSES.includes(x) || IMPORT_MEDIA.includes(r.media)));
const isAdminArticles = () => !!me && (me.perms.media === 'admin' || me.perms.articles === 'admin');
const TYPE_OPTIONS = ['新規', 'リライト(新規)', 'リライト', '簡易リライト'];   // リライト(新規)＝新規並みに書き直すリライト。本数はリライト、単価は新規（2026-10-28 ユーザー指定）
// 全メディア共通の選択肢（2026-10-10 ユーザー指定。構成作成完了以降は入力必須）
const TARGET_OPTIONS = ['潜在層', '顕在層', '比較検討層', '顧客'];
const URGENCY_OPTIONS = ['高', '中', '低'];   // 緊急性（構成作成完了以降は入力必須）
const QUERY_OPTIONS = ['KNOW', 'DO', 'GO', 'BUY', 'DB'];
const POSITION_OPTIONS = ['ピラーページ(親)', 'ピラーページ(子)', 'ロングテールページ', 'キラーページ'];   // 害獣お助けのシートのプルダウンと同じ
// フェーズの色：未着手＝灰、構成作成＝薄い黄、記事執筆＝黄、完了＝緑
// 記事の作成が終わった段階（完了と同じ扱い：「完了以外」の絞り込み・進行中の数・完了の数）
const DONE_STATUSES = ['完了', '記事移管完了', 'BEST365から移管'];
const isDone = st => DONE_STATUSES.includes(st);
const phaseCls = st => st === 'アップロードチェック中' ? 'sup' : st === '記事チェック中' ? 'wait' : st === '構成チェック中' ? 'light' : st === 'BEST365から移管' ? 'import' : st === '記事移管完了' ? 'moved' : st === '記事移管中' ? 'moving' : st === '完了' ? 'ok' : /監修者確認/.test(st || '') ? 'sup' : /^記事執筆/.test(st || '') ? 'wait' : /^構成作成/.test(st || '') ? 'light' : 'off';
const statusPill = st => '<span class="pill ' + phaseCls(st) + '">' + esc(st || '—') + '</span>';
const typePill = t => t ? '<span class="pill ' + (/新規/.test(t) ? 'ok' : 'off') + '">' + esc(t) + '</span>' : '—';
const ymdJa = d => d ? d.replace(/-/g, '/') : '—';
const topMedia = () => META.media.filter(m => !m.block);
const mediaLabel = m => m === ALL ? 'メディア累計' : (topMedia().find(x => x.media === m) || {}).name || m;
/** 記事管理で選んでいるメディア（記事があるメディアを優先） */
function artMedia() {
  if (state.artMedia === ALL && state.media === ALL) return ALL;   // メディア累計
  const list = topMedia().map(m => m.media);
  // メディア数値で選んでいるメディア（ディレクトリならそのメディア）を引き継ぐ
  const fromMedia = state.media !== ALL && ent(state.media) ? ent(state.media).media : null;
  if (fromMedia && list.includes(fromMedia)) state.artMedia = fromMedia;
  if (!list.includes(state.artMedia)) {
    const withItems = ITEMS && list.find(m => ITEMS.some(r => r.media === m));
    state.artMedia = withItems || list[0];
  }
  return state.artMedia;
}
function renderArtMediaSelect() {
  if (ADMIN_MEDIA_VIEWS.includes(state.view)) { const cur = adminMedia(); $('art-media-select').innerHTML = '<option value="' + ALL + '"' + (cur === ALL ? ' selected' : '') + '>メディア累計</option>' + topMedia().map(m => '<option value="' + esc(m.media) + '"' + (m.media === cur ? ' selected' : '') + '>' + esc(m.name) + '</option>').join(''); $('art-sub-field').hidden = true; return; }
  if (state.dash === 'revenue') { const cur = revMedia(); $('art-media-select').innerHTML = '<option value="' + ALL + '"' + (cur === ALL ? ' selected' : '') + '>メディア累計</option>' + topMedia().map(m => '<option value="' + esc(m.media) + '"' + (m.media === cur ? ' selected' : '') + '>' + esc(m.name) + '</option>').join(''); return; }
  const sel = $('art-media-select'), cur = artMedia();
  const cnt = (media, sub) => state.dash === 'articles' && ITEMS ? '（' + nf.format(pubCount(media, sub)) + '件）' : '';
  const cntAll = state.dash === 'articles' && ITEMS ? '（' + nf.format(topMedia().reduce((a, m) => a + pubCount(m.media), 0)) + '件）' : '';
  sel.innerHTML = '<option value="' + ALL + '"' + (cur === ALL ? ' selected' : '') + '>メディア累計' + cntAll + '</option>' + topMedia().map(m => '<option value="' + esc(m.media) + '"' + (m.media === cur ? ' selected' : '') + '>' + esc(m.name) + cnt(m.media) + '</option>').join('');
  // ディレクトリ（ディレクトリのあるメディアだけ）
  const subs = state.dash === 'articles' ? artSubs(cur) : null;
  $('art-sub-field').hidden = !subs;
  if (subs) {
    if (state.artSub && !subs.includes(state.artSub)) state.artSub = '';
    const stopped = STOPPED_SUBS[cur] || [];
    $('art-sub-select').innerHTML = '<option value="">全て' + cnt(cur) + '</option>' + subs.map(x => '<option value="' + esc(x) + '"' + (x === state.artSub ? ' selected' : '') + '>' + esc(x) + (stopped.includes(x) ? '（停止）' : cnt(cur, x)) + '</option>').join('');
  }
}
/** 公開中の記事件数（進行状況が「完了」。移管完了・停止ディレクトリの記事は含めない） */
const pubCount = (media, sub) => (ITEMS || []).filter(r => r.media === media && (!sub || r.sub === sub) && (r.status === '完了' || r.status === 'BEST365から移管') && !movedOut(r)).length;
function itemsFor(id) {
  if (!id || id === ALL) return ITEMS;
  const e = ent(id); if (!e) return [];
  return ITEMS.filter(r => r.media === e.media && (!e.block || (DIR_PATHS[e.block] || []).some(p => String(r.url || '').includes(p))));
}
function statusChips(rows) {
  const cnt = {}; rows.forEach(r => { cnt[r.status || '（空欄）'] = (cnt[r.status || '（空欄）'] || 0) + 1; });
  const keys = STATUS_ORDER.filter(k => cnt[k]).concat(Object.keys(cnt).filter(k => !STATUS_ORDER.includes(k)));
  return '<div class="row" style="gap:6px; margin-bottom:8px">' + keys.map(k => statusPill(k).replace('</span>', ' <b class="num">' + cnt[k] + '</b></span>')).join('') + '<span class="note">全' + rows.length + '件</span></div>';
}
// 表の列（文字は左、数値は右、状態・日付は中央）
const AM_COLS = [
  { k: 'no', h: 'No.', c: 'c-txt' }, { k: 'title', h: '記事タイトル', c: 'c-txt c-title' }, { k: 'url', h: '記事URL', c: 'c-txt c-url' }, { k: 'wp_id', h: '記事ID', c: 'c-num c-person' }, { k: 'kw', h: '検索KW', c: 'c-txt c-kw' }, { k: 'sub', h: 'ディレクトリ', c: 'c-txt c-person', subcol: true }, { k: 'vol_avg', h: '検索Vol', c: 'c-num' },
  { k: 'status', h: '進行状況', c: 'c-ctr' }, { k: 'type', h: '最新対応', c: 'c-ctr' }, { k: 'supervision', h: '監修有無', c: 'c-ctr', sup: true }, { k: 'request_date', h: '依頼日', c: 'c-ctr' }, { k: 'upload_date', h: 'アップロード日', c: 'c-ctr' }, { k: 'first_upload', h: '初回アップロード日', c: 'c-ctr', grp: true },
  { k: 'director', h: 'ディレクション', c: 'c-txt c-person' }, { k: 'writer', h: '執筆', c: 'c-txt c-person' }, { k: 'upload_owner', h: 'アップロード', c: 'c-txt c-person' }, { k: 'supervisor', h: '監修', c: 'c-txt c-person', sup: true }, { k: 'chars', h: '文字数', c: 'c-num' }, { k: 'image_count', h: '画像枚数', c: 'c-num' },
];
const AM_EXTRA = [['related_kw', '関連KW'], ['target', 'ターゲット層'], ['query_type', 'クエリタイプ'], ['seo_difficulty', 'SEO難易度'], ['genre', 'ジャンル'], ['cta', 'CTA'], ['appeal_block', '訴求ブロック'],
  ['price_note', '平均価格表記'], ['market_note', '相場への言及'], ['tags', 'タグ'], ['planned_chars', '想定文字数'], ['copy_rate', 'コピペ率'], ['writing_status', '執筆の進行状況'], ['image_owner', '画像制作担当'], ['image_status', '画像の進行状況'],
  ['upload_status', 'アップロードの進行状況'], ['memo', 'メモ']];
function cellOf(r, k) {
  if (k === '_media') return esc(mediaLabel(r.media));   // メディア累計のときのメディア列
  if (['director', 'writer', 'upload_owner', 'supervisor', 'image_owner'].includes(k)) return esc(personName(r[k], r.media));   // 担当者の紐づけで決めた名前で表示（2026-10-27 ユーザー指定）
  if (k === 'title') return r.title ? '<span title="' + esc(r.title) + '">' + esc(r.title) + '</span>' : '<span class="note">—</span>';
  if (k === 'kw' && kwMissing(r)) return '<span class="note">KW未選定</span>';
  if (k === 'kw') return '<span class="kw">' + esc(r.kw || '') + '</span>' + (r.source === 'dashboard' ? ' <span class="pill wait">追加</span>' : r.edited ? ' <span class="pill wait" title="' + esc((r.editedBy || '') + ' ' + (r.editedAt || '').slice(0, 10)) + '">修正</span>' : '');
  if (k === 'vol_avg') return r.vol_avg == null ? '—' : '<span title="' + (r.vol_src === 'ahrefs' ? 'Ahrefs・直近12か月の平均（' + esc(r.vol_ym || '') + ' 時点）' : 'スプレッドシートの値（Ahrefs 未取得）') + '">' + nf.format(r.vol_avg) + (r.vol_src === 'ahrefs' ? '' : '<span class="note">*</span>') + '</span>';
  if (k === 'first_upload') return ymdJa(r._first) + (r._versions > 1 ? ' <span class="note" title="同じKWの記事（新規・リライト）の件数">全' + r._versions + '件</span>' : '');
  if (k === 'wp_id') return r.wp_id ? '<span title="WordPressの記事ID">' + esc(r.wp_id) + '</span>' : '—';
  if (k === 'chars' || k === 'image_count') return r[k] == null ? '—' : nf.format(r[k]);
  if (k === 'status') return statusPill(r.status);
  if (k === 'type') return typePill(r.type);
  if (k === 'supervision') { const v = supOf(r); return v ? '<span class="pill ' + (v === 'あり' ? 'supy' : 'off') + '">' + esc(v) + '</span>' : '—'; }
  if (k === 'request_date' || k === 'upload_date') return ymdJa(r[k]);
  if (k === 'url') return r.url ? '<a href="' + escUrl(r.url) + '" target="_blank" rel="noopener">' + esc(r.url.replace(/^https?:\/\/[^\/]+/, '') || '/') + '</a>' : '—';
  return esc(r[k] == null ? '' : r[k]);
}
/** INDEX のマーク：○ インデックス済み／△ 申請したがまだ確認できない／× インデックスされていない。押すと Search Console の URL検査を開く */
const IDX_MARK = { ok: ['○', 'インデックス済み'], pending: ['△', '申請済み（次の確認で登録されたら○）'], ng: ['×', 'インデックスされていません'] };
function idxCell(r, x) {
  if (!x) return '<span class="note" title="まだ確認していません（毎日少しずつ確認します）">—</span>';
  const m = IDX_MARK[x.state] || IDX_MARK.ng;
  return '<button type="button" class="idx-mark idx-' + x.state + '" data-idxurl="' + esc(String(r.url).trim()) + '" data-idxsite="' + esc(x.site || '') + '" data-idxmedia="' + esc(r.media) + '" title="' + esc(m[1] + (x.coverage ? '（' + x.coverage + '）' : '') + (x.checkedAt ? '・確認 ' + String(x.checkedAt).slice(0, 10) : '') + (x.state === 'ok' ? '' : '。押すと Search Console の URL検査が開きます。「インデックス登録をリクエスト」を押してください')) + '">' + m[0] + '</button>';
}
/** INDEX のマークを押したとき：Search Console の URL検査を開き、ok 以外は「申請済み」を記録して△に */
function bindIdx(box, index) {
  box.querySelectorAll('[data-idxurl]').forEach(b => b.onclick = async () => {
    const url = b.dataset.idxurl, site = b.dataset.idxsite, x = index[url];
    window.open('https://search.google.com/search-console/inspect?' + (site ? 'resource_id=' + encodeURIComponent(site) + '&' : '') + 'id=' + encodeURIComponent(url), '_blank', 'noopener');
    if (!x || x.state === 'ok') return;
    try { await apiSend('POST', '/index-request', { url, media: b.dataset.idxmedia }); x.state = 'pending'; const tr = b.closest('tr'); tr.classList.remove('idx-ng'); tr.classList.add('idx-pending'); b.className = 'idx-mark idx-pending'; b.textContent = '△'; toast('申請済みにしました（Search Console でリクエストしてください）'); } catch (e) { alert(e.message); }
  });
}
function itemTable(rows, opt) {
  const sup = rows.some(r => isSupMedia(r.media)), multi = new Set(rows.map(r => r.media)).size > 1;
  let COLS = (multi ? [{ k: '_media', h: 'メディア', c: 'c-txt c-person' }] : []).concat(AM_COLS.filter(c => (!c.sup || sup) && (!c.grp || opt.grouped) && (!c.subcol || rows.some(r => r.sub))));
  if (opt.index) { const i = COLS.findIndex(c => c.k === 'url'); COLS.splice(i + 1, 0, { k: '_index', h: 'INDEX', c: 'c-ctr' }); }   // メディア累計では先頭にメディア列
  const head = '<thead><tr>' + COLS.map(c => '<th class="' + c.c.replace(' c-title', '').replace(' c-kw', '') + '">' + c.h + '</th>').join('')
    + (opt.extra ? AM_EXTRA.map(([, h]) => '<th class="c-txt">' + h + '</th>').join('') + '<th class="c-txt">資料</th>' : '') + '</tr></thead>';
  const ix = r => opt.index && opt.index[String(r.url || '').trim()];
  const body = rows.map(r => '<tr class="ph-row-' + (isStopped(r) ? 'moved' : phaseCls(r.status)) + (kwMissing(r) ? ' kw-missing' : '') + (ix(r) ? ' idx-' + ix(r).state : '') + '" ' + (kwMissing(r) ? 'title="KW未選定"' : '') + '>' + COLS.map(c => '<td class="' + c.c + '">' + (c.k === '_index' ? idxCell(r, ix(r)) : cellOf(r, c.k)) + '</td>').join('')
    + (opt.extra ? AM_EXTRA.map(([k]) => '<td class="c-txt">' + (k === 'image_owner' ? cellOf(r, k) : esc(r[k] == null ? '' : r[k])) + '</td>').join('')
      + '<td class="c-txt">' + (r.outline_url ? '<a href="' + escUrl(r.outline_url) + '" target="_blank" rel="noopener">構成</a> ' : '') + (r.writing_url ? '<a href="' + escUrl(r.writing_url) + '" target="_blank" rel="noopener">原稿</a>' : '') + '</td>' : '') + '</tr>').join('');
  return '<div class="table-wrap am-scroll"><table class="am-table sticky2">' + head + '<tbody>' + body + '</tbody></table></div>';
}
const noItems = m => '<p class="empty">' + esc(mediaLabel(m)) + 'の記事管理シートはまだ取り込まれていません。管理者がApps Scriptの importArticleSheets を実行すると表示されます。</p>';
const byNo = (a, b) => (Number(a.no) || 1e9) - (Number(b.no) || 1e9);

/** 過去3か月＋今月の記事目標と成果（選んでいるメディア） */
function recentPerf(media) {
  const months = [shiftMonth(LAST_FULL, -2), shiftMonth(LAST_FULL, -1), LAST_FULL, CUR_MONTH];
  return '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">月</th><th class="c-num">記事目標</th><th class="c-num">記事実績</th><th class="c-txt" style="min-width:140px">達成率</th><th class="c-num">新規</th><th class="c-num">リライト</th><th class="c-num">PV</th><th class="c-num">CV</th><th class="c-num">CV率</th>' + (noMoney() ? '' : '<th class="c-num">収益合計(税抜き)</th>') + '</tr></thead><tbody>'
    + months.map(mm => {
      const t = targetOf(media, mm, 'total'), a = actualOf(media, mm, 'total'), v = monthVal(media, mm), r = t ? (a || 0) / t : null, cur = mm === CUR_MONTH;
      return '<tr><td class="c-txt">' + mLabel(mm) + (cur ? ' <span class="note">（途中）</span>' : '') + '</td><td class="c-num">' + (t ?? '—') + '</td><td class="c-num">' + (a ?? '—') + '</td>'
        + '<td class="c-txt">' + (r == null ? '<span class="note">目標なし</span>' : '<div class="row" style="gap:6px; flex-wrap:nowrap"><div class="progress" style="flex:1"><span class="' + (r >= (cur ? dayDone() / daysIn(CUR_MONTH) : 1) ? 'over' : 'under') + '" style="width:' + Math.min(r, 1) * 100 + '%"></span></div><span class="num">' + Math.round(r * 100) + '%</span></div>') + '</td>'
        + '<td class="c-num">' + (actualOf(media, mm, 'new') ?? '—') + '</td><td class="c-num">' + (actualOf(media, mm, 'rewrite') ?? '—') + '</td>'
        + '<td class="c-num">' + fmt('pv', v.pv) + '</td><td class="c-num">' + fmt('cv', v.cv) + '</td><td class="c-num">' + fmt('cvr', v.cvr) + '</td>' + (noMoney() ? '' : '<td class="c-num">' + fmt('revenue', v.revenue) + '</td>') + '</tr>';
    }).join('') + '</tbody></table></div><p class="note">記事実績は、このメディアのWordPressで公開（新規）・更新（リライト）された記事数です。</p>';
}

/** メディア数値ダッシュボードの「記事一覧」（抜粋） */
function viewArtList() {
  return { html: '<section class="panel" id="al-body">' + H('最近の記事 <small>' + esc(mediaName(state.media)) + '・進行中と最近アップロードした記事</small>', ['記事管理']) + '<p class="loading">読み込み中…</p></section>',
    view: '記事一覧（' + mediaName(state.media) + '）', after: async () => {
      await loadItems();
      const rows = itemsFor(state.media);
      const go = '<button class="linkbtn" type="button" id="al-go">記事一覧で全件を見る →</button>';
      if (!rows.length) { $('al-body').innerHTML = H('最近の記事', ['記事管理'], go) + '<p class="empty">このメディアの記事管理シートはまだ取り込まれていません。</p>'; }
      else {
        const doing = rows.filter(r => !isDone(r.status)).sort((a, b) => STATUS_ORDER.indexOf(b.status) - STATUS_ORDER.indexOf(a.status) || String(b.request_date || '').localeCompare(String(a.request_date || '')));
        const recent = rows.filter(r => r.upload_date).sort((a, b) => b.upload_date.localeCompare(a.upload_date)).slice(0, 15);
        $('al-body').innerHTML = H('最近の記事 <small>' + esc(mediaName(state.media)) + '・進行中と最近アップロードした記事</small>', ['記事管理'], go) + statusChips(rows)
          + '<h3 class="am-h">進行中の記事 <span class="note">' + doing.length + '件（完了以外）</span></h3>'
          + (doing.length ? itemTable(doing.slice(0, 30), {}) + (doing.length > 30 ? '<p class="note">ほか' + (doing.length - 30) + '件は記事管理で確認できます</p>' : '') : '<p class="empty">進行中の記事はありません</p>')
          + '<h3 class="am-h">最近アップロードした記事 <span class="note">新しい順・15件</span></h3>'
          + (recent.length ? itemTable(recent, {}) : '<p class="empty">アップロード日の入った記事がありません</p>');
      }
      $('al-go').onclick = () => { if (state.media !== ALL) state.artMedia = (ent(state.media) || {}).media; state.dash = 'articles'; state.view = 'am-list'; render(); };
    } };
}

/** 記事管理：記事一覧（選んでいるメディアの全件・絞り込み） */
function viewAmList() {
  const f = state.amFilter = state.amFilter || {};
  return { html: '<section class="panel" id="am-perf"><p class="loading">読み込み中…</p></section><section class="panel" id="am-filter"></section><section class="panel" id="am-body"></section>', view: '記事管理：記事一覧', after: async () => {
    await Promise.all([loadItems(), loadArticles()]);
    const media = artMedia(); renderArtMediaSelect();
    const all = ITEMS.filter(r => inArt(r, media) && !movedOut(r) && String(r.url || '').trim() && (isDone(r.status) || (r.upload_date && r.upload_date <= todayJst())));   // 公開記事だけ（記事URLがあり、完了かアップロード日が今日まで）（2026-10-28 ユーザー指定）   // 記事移管完了・停止ディレクトリの記事は出さない
    $('am-perf').innerHTML = H('過去3か月の記事目標と成果 <small>' + esc(mediaLabel(media)) + '</small>', ['WordPress', 'GA4', 'kintone', 'ASP']) + recentPerf(media);
    if (!all.length) { $('am-filter').innerHTML = H('公開記事一覧', ['記事管理']) + noItems(media); $('am-body').hidden = true; return; }
    $('am-filter').innerHTML = H('絞り込み', ['記事管理']) + '<div class="row">' + filterControls('f-', f, all, media)
      + '<label class="field">並び順<select id="f-sort"><option value="upload"' + (f.sort === 'upload' || !f.sort ? ' selected' : '') + '>アップロード日が新しい順</option><option value="request"' + (f.sort === 'request' ? ' selected' : '') + '>依頼日が新しい順</option><option value="vol"' + (f.sort === 'vol' ? ' selected' : '') + '>検索Volが多い順</option><option value="no"' + (f.sort === 'no' ? ' selected' : '') + '>記事No.順</option></select></label>'
      + '<label class="field" style="gap:4px"><input type="checkbox" id="f-extra"' + (f.extra ? ' checked' : '') + '>すべての列を表示</label></div>';
    const IDX = await api('/index-status?media=' + encodeURIComponent(media === ALL ? '__all__' : media)).then(d => d.status || {}).catch(() => ({}));   // Search Console のインデックス状況
    const draw = () => {
      readFilters('f-', f, media); f.sort = $('f-sort').value; f.extra = $('f-extra').checked;
      let rows = latestByKw(all).filter(matchFilters(f, media));   // 同じKWは最新のアップロード日の1行
      const by = { upload: (a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')), request: (a, b) => String(b.request_date || '').localeCompare(String(a.request_date || '')), vol: (a, b) => (b.vol_avg || 0) - (a.vol_avg || 0), no: byNo };
      rows = rows.sort(by[f.sort] || by.upload);
      const shown = rows.slice(0, f.limit || 200);
      $('am-body').innerHTML = H('公開記事一覧 <small>' + esc(mediaLabel(media)) + '・' + rows.length + '件' + (rows.length > shown.length ? '（' + shown.length + '件を表示）' : '') + '</small>' + stoppedNote(media), ['記事管理']) + statusChips(rows)
        + itemTable(shown, { extra: f.extra, grouped: true, index: IDX })
        + (rows.length > shown.length ? '<div class="row" style="justify-content:center; margin-top:10px"><button class="btn" type="button" id="am-more">さらに200件表示</button></div>' : '')
        + '<p class="note">取り込み：' + esc((all.find(r => r.imported) || {}).imported || '—') + '。記事タイトルはWordPressの公開記事から表示しています（未公開の記事は「—」）。検索VolはAhrefsの直近12か月平均（* はまだ取得していないKWで、シートの値）。「修正」「追加」は進行管理で入力した記事です。</p>';
      const more = $('am-more'); if (more) more.onclick = () => { f.limit = (f.limit || 200) + 200; draw(); };
      bindIdx($('am-body'), IDX);
    };
    const redraw = () => { f.limit = 200; draw(); };
    bindFilters('f-', media, redraw); $('f-sort').onchange = redraw; $('f-extra').onchange = redraw;
    draw();
  } };
}

/** 記事管理：進行管理（一覧のままプルダウン・手入力。変えたらすぐ保存） */
const PG_COLS = [
  { k: 'no', h: 'No.', w: 'w-no', kind: 'text' }, { k: 'kw', h: '検索KW', w: 'w-kw', kind: 'text' }, { k: 'related_kw', h: '関連KW', w: 'w-kw', kind: 'lines', rel: true }, { k: 'vol_avg', h: '検索Vol', kind: 'vol' },
  { k: 'status', h: '進行状況', w: 'w-st', kind: 'status' }, { k: 'type', h: '制作判断', hList: '最新対応', w: 'w-ty', kind: 'type' }, { k: 'urgency', h: '緊急性', w: 'w-sp', kind: 'sel', opts: URGENCY_OPTIONS }, { k: 'target', h: 'ターゲット層', w: 'w-ty', kind: 'sel', opts: TARGET_OPTIONS }, { k: 'query_type', h: 'クエリタイプ', w: 'w-ty', kind: 'sel', opts: QUERY_OPTIONS }, { k: 'position', h: 'ポジション', w: 'w-ty', kind: 'sel', opts: POSITION_OPTIONS }, { k: 'supervision', h: '監修有無', w: 'w-sp', kind: 'sup', sup: true }, { k: 'request_date', h: '依頼日', w: 'w-dt', kind: 'date' }, { k: 'upload_date', h: 'アップロード日', w: 'w-dt', kind: 'date' },
  { k: 'director', h: 'ディレクション担当', w: 'w-p', kind: 'person' }, { k: 'writer', h: '執筆担当', w: 'w-p', kind: 'person' }, { k: 'target_ym', h: 'アップロード目標月', w: 'w-dt', kind: 'month' }, { k: 'upload_owner', h: 'アップロード担当', w: 'w-p', kind: 'person' }, { k: 'supervisor', h: '監修担当', w: 'w-p', kind: 'person', sup: true }, { k: 'genre', h: 'カテゴリ', w: 'w-p', kind: 'opt', src: 'categories' }, { k: 'tags', h: 'タグ', w: 'w-tags', kind: 'tags' }, { k: 'cta', h: 'CTA', w: 'w-p', kind: 'opt', src: 'cta' }, { k: 'appeal_block', h: '訴求ブロック', w: 'w-p', kind: 'opt', src: 'appeal' }, { k: 'outline_url', h: '構成URL', w: 'w-url', kind: 'doc' }, { k: 'writing_url', h: 'ライティングURL', w: 'w-url', kind: 'doc' }, { k: '_copyw', h: 'コピペ（簡易）', w: 'w-sp', kind: 'copy', src: 'writing_url' }, { k: 'copy_rate', h: 'コピペ率（CCD）', w: 'w-ccd', kind: 'ccd' },{ k: 'chars', h: '文字数', w: 'w-n', kind: 'num' }, { k: 'image_count', h: '画像制作枚数', w: 'w-n', kind: 'num' }, { k: 'url', h: '記事URL', w: 'w-url', kind: 'doc' }, { k: '_copy', h: 'コピペ', w: 'w-sp', kind: 'copy', src: 'url' }, { k: 'title', h: '記事タイトル', kind: 'ro' }, { k: 'memo', h: 'メモ', w: 'w-memo', kind: 'text' },
];
// 進行管理の列のそろえ方：長い文字（KW・URL・メモなど）は左、それ以外（選択・日付・数値など）は見出しも中身も中央
const pgAl = c => c.kind === 'vol' ? 'c-num' : (c.kind === 'ro' || c.kind === 'doc' || c.kind === 'lines' || (c.kind === 'text' && c.k !== 'no')) ? 'c-txt' : 'c-ctr';
/** 進行管理の一括変更で選べる項目（選ぶ形の項目と日付） */
const BULK_COLS = media => PG_COLS.filter(c => ['status', 'type', 'sel', 'sup', 'person', 'date', 'month', 'opt'].includes(c.kind) && (!c.sup || isSupMedia(media)));
const normKwStr = s => String(s || '').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
/** リライトの元になる記事：同じメディアで、KWが完全一致する記事（新規を優先、なければ一番古い記事） */
function rewriteSource(media, kw, self) {
  const k = normKwStr(kw);
  if (!k) return null;
  const hits = ITEMS.filter(x => x !== self && x.media === media && normKwStr(x.kw) === k);
  return hits.find(x => /新規/.test(x.type || '')) || hits.sort((a, b) => String(a.upload_date || '9').localeCompare(String(b.upload_date || '9')))[0] || null;
}
/** 記事一覧：同じKWの記事は、最新のアップロード日の1行にまとめる（初回アップロード日と件数をつける） */
function latestByKw(rows) {
  const groups = new Map();
  rows.forEach(r => { const k = normKwStr(r.kw) ? r.media + '|' + normKwStr(r.kw) : 'key|' + r.key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()].map(g => {
    const sorted = [...g].sort((a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')));
    const top = sorted[0], ups = g.map(x => x.upload_date).filter(Boolean).sort();
    const firstNew = g.filter(x => /新規/.test(x.type || '') && x.upload_date).map(x => x.upload_date).sort()[0];
    return Object.assign({}, top, { _first: firstNew || ups[0] || null, _versions: g.length });
  });
}
// ディレクトリを選べるメディア（記事管理シートの「ディレクトリ」）
const ARTICLE_SUBS = { '水まわりお助け': ['トイレ', 'キッチン', '洗面台', 'お風呂', '過去制作', 'BEST365移管'], 'BEST365': ['水回り', 'カギ', '外壁屋根', '電気設備'], '屋根外壁お助け': ['屋根', '外壁'], 'ガラスお助け': ['進行中', '過去記事', '過去記事②'], '害虫害獣コンシェルジュ': ['ゴキブリ', 'シロアリ', 'ハチ', 'その他害虫', 'コウモリ', 'ネズミ', 'その他害獣'], '害獣お助け': ['ネズミ駆除', 'コウモリ駆除', 'アライグマ駆除', 'イタチ駆除', 'ハクビシン駆除', 'タヌキ駆除', 'アナグマ駆除', 'テン駆除', 'モグラ駆除', 'その他害獣駆除', '害獣駆除'] };
const artSubs = media => ARTICLE_SUBS[media] || null;
/** 記事管理で選んでいるメディア・ディレクトリの記事か */
const inArt = (r, media) => (media === ALL || r.media === media) && (state.dash !== 'articles' || !state.artSub || !artSubs(media) || r.sub === state.artSub);
const kwMissing = r => !normKwStr(r.kw);
const DOC_URL = /^https:\/\/docs\.google\.com\/(spreadsheets|document)\/d\//;
/** 進行状況を変えるときに足りない項目。構成作成完了以降＝担当者全員と構成URL、記事執筆完了以降＝ライティングURL、完了＝すべての項目 */
function missingFor(r, status) {
  if (MIGRATE_STATUSES.includes(status) || IMPORT_STATUSES.includes(status)) return [];   // 移管は入力チェックなし
  const i = STATUS_ORDER.indexOf(status), need = [];
  if (i < 0) return need;
  const sup = isSupMedia(r.media) && supOf(r) === 'あり';
  const has = k => r[k] != null && String(r[k]).trim() !== '';
  const persons = PG_COLS.filter(c => c.kind === 'person' && (!c.sup || sup));
  if (i >= STATUS_ORDER.indexOf('構成作成完了')) { persons.forEach(c => { if (!has(c.k)) need.push(c.h); }); if (!has('outline_url')) need.push('構成URL'); PG_COLS.filter(c => c.kind === 'sel' && !c.optional).forEach(c => { if (!has(c.k)) need.push(c.h); }); }
  if (i >= STATUS_ORDER.indexOf('記事執筆完了') && !has('writing_url')) need.push('ライティングURL');
  /* コピペ率（CCD）は「完了」にするときに必須（2026-11-13 ユーザー指定で記事執筆完了から → 完了に戻す。文字数の自動入力〈記事執筆完了〉とそろえる） */
  if (status === '完了' && !has('copy_rate')) need.push('コピペ率（CCD）');
  /* ガイドライン確認（全項目チェック、または未対応の理由）がそろわないと「完了」にできない（2026-11-13 ユーザー指定。サーバーでも止める） */
  if (status === '完了') { const gm = guideMissingFor(r); if (gm && gm.length) need.push('ガイドライン確認（残り' + gm.length + '項目）'); }
  if (status === '完了') PG_COLS.filter(c => !['ro', 'vol', 'status', 'person', 'opt', 'tags', 'sel', 'copy', 'ccd', 'lines'].includes(c.kind) && c.k !== 'memo' && c.k !== 'outline_url' && c.k !== 'writing_url' && (!c.sup || isSupMedia(r.media))).forEach(c => { if (c.kind === 'sup' ? !supOf(r) : !has(c.k)) need.push(c.h); });
  return need;
}
function showInputError(title, lines, foot) {
  openModal('<h2>' + esc(title) + '</h2><ul class="miss">' + lines.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul><p class="note">' + esc(foot || '入力してから、もう一度選んでください。') + '</p><div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" data-close>OK</button></div>');
}
/** 記事一覧・進行管理で共通の絞り込み。進行管理の列（PG_COLS）の並びから自動で作るので、列を増やす・並べ替えると両方の絞り込みに反映される */
const filterCols = media => PG_COLS.filter(c => ['status', 'type', 'sup', 'person'].includes(c.kind) && (!c.sup || isSupMedia(media)));
function filterControls(p, f, rows, media) {
  const PERSON_KEYS = ['director', 'writer', 'upload_owner', 'supervisor', 'image_owner'];
  const uniq = k => [...new Set(rows.map(r => PERSON_KEYS.includes(k) ? personName(r[k], r.media) : r[k]).filter(Boolean))].sort();   // 担当者は紐づけた名前でまとめる（2026-10-27）
  const sel = (c, opts) => '<label class="field">' + (c.kind === 'status' ? '進行状況' : p === 'f-' && c.hList ? c.hList : c.h) + '<select id="' + p + c.k + '"><option value="">すべて</option>'
    + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === (f[c.k] || '') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
  return filterCols(media).map(c => {
    if (c.kind === 'status') return sel(c, [['doing', '完了以外']].concat(statusOptsFor(media).map(x => [x, x])));
    if (c.kind === 'sup') return sel(c, [['あり', 'あり'], ['なし', 'なし']]);
    return sel(c, uniq(c.k).map(x => [x, x]));
  }).join('') + '<label class="field">キーワード<input id="' + p + 'q" type="search" value="' + esc(f.q || '') + '" placeholder="タイトル・KW・No.・URLで検索"></label>';
}
function readFilters(p, f, media) {
  filterCols(media).forEach(c => { const el = $(p + c.k); f[c.k] = el ? el.value : ''; });
  f.q = $(p + 'q') ? $(p + 'q').value.trim() : '';
}
function matchFilters(f, media) {
  const cols = filterCols(media), q = (f.q || '').toLowerCase();
  return r => cols.every(c => {
    const v = f[c.k]; if (!v) return true;
    if (c.kind === 'status') return v === 'doing' ? !isDone(r.status) : r.status === v;
    if (c.kind === 'sup') return supOf(r) === v;
    return (['director', 'writer', 'upload_owner', 'supervisor', 'image_owner'].includes(c.k) ? personName(r[c.k], r.media) : r[c.k]) === v;
  }) && (!q || [r.title, r.kw, r.no, r.url, r.related_kw, r.genre, r.tags].some(x => String(x || '').toLowerCase().includes(q)));
}
function bindFilters(p, media, onChange) {
  filterCols(media).forEach(c => { const el = $(p + c.k); if (el) el.onchange = onChange; });
  let t; $(p + 'q').oninput = () => { clearTimeout(t); t = setTimeout(onChange, 250); };
}
/* コピペ率（CCD）の記録：CCD（https://ccd.cloud/）で分けてチェックした結果を入れると平均を出す。値はシートの「コピペ率」と同じ項目（copy_rate）に「平均35%（36%・38%・34%）」の形で保存（2026-11-05 ユーザー指定） */
const ccdParse = v => { const s = String(v || '').normalize('NFKC').trim(); if (!s) return []; const m = s.match(/^平均\s*[\d.]+%?\s*\((.*)\)$/); if (m) return m[1].split('・').map(x => parseFloat(x)).filter(x => !isNaN(x)); return /^[\d.]+\s*%?$/.test(s) ? [parseFloat(s)] : null; };
const ccdFormat = ps => { ps = ps.filter(x => x != null && !isNaN(x)); if (!ps.length) return ''; const r1 = x => Math.round(x * 10) / 10; return ps.length === 1 ? r1(ps[0]) + '%' : '平均' + r1(ps.reduce((a, x) => a + x, 0) / ps.length) + '%（' + ps.map(x => r1(x) + '%').join('・') + '）'; };
const ccdBtn = (v, i) => { const s = String(v || '').trim(), ps = ccdParse(s), short = !s ? '入力' : ps && ps.length > 1 ? s.replace(/（.*$/, '') + '（' + ps.length + '）' : s.length > 10 ? s.replace(/\s+/g, ' ').slice(0, 9) + '…' : s;
  return '<button type="button" class="btn sm ccd-btn' + (s ? '' : ' ccd-empty') + '" data-ccd="' + i + '" title="' + esc(s ? 'CCDの結果：' + s + '\n押すと編集' : 'CCDでチェックした結果を記録') + '">' + esc(short) + '</button>'; };
let CCD_EX = null;
/** コピペ（簡易）は参考程度。CCDでのチェックと入力を促す案内（進行管理・月次進行管理の上）（2026-11-13 ユーザー指定） */
const CCD_NOTE = '<div class="ccd-note">⚠ <b>コピペ（簡易）は参考程度です。</b>原稿は必ず <a href="https://ccd.cloud/" target="_blank" rel="noopener">CCD（ccd.cloud）</a>でチェックし、結果を「コピペ率（CCD）」の「入力」から記録してください。<span class="note">（進行状況を「記事執筆完了」より先に進めるときに必須）</span></div>';   // CCDで除外するドメイン（一度読んだら使い回す）
/** CCDの結果を入れる画面（分けてチェックした数だけ行を足す） */
function openCcdModal(r, onSave) {
  const cur = String(r.copy_rate || '').trim(), parsed = ccdParse(cur), ps = parsed && parsed.length ? parsed.slice() : [null];
  const rowHtml = (x, n) => '<div class="row ccd-row"><span class="note">' + (n + 1) + 'つ目</span><input type="number" min="0" max="100" step="0.1" inputmode="decimal" class="ccd-in" value="' + (x == null ? '' : x) + '" aria-label="' + (n + 1) + 'つ目のコピペ率"><span>%</span><button type="button" class="btn sm" data-ccd-del="' + n + '" title="この行を消す"' + (n === 0 ? ' hidden' : '') + '>×</button></div>';
  const read = () => [...document.querySelectorAll('#ccd-rows .ccd-in')].map(x => x.value === '' ? null : Number(x.value));
  const paint = () => { $('ccd-rows').innerHTML = ps.map(rowHtml).join(''); bind(); calc(); };
  const calc = () => { const v = read().filter(x => x != null && !isNaN(x)); const bad = v.some(x => x < 0 || x > 100); $('ccd-avg').textContent = bad ? '0〜100で入力してください' : v.length ? ccdFormat(v).replace(/^平均/, '').replace(/（.*$/, '') + (v.length > 1 ? '（' + v.length + 'つの平均）' : '') : '—'; $('ccd-save').disabled = bad; };
  const bind = () => { document.querySelectorAll('#ccd-rows .ccd-in').forEach((x, n) => { x.oninput = () => { ps[n] = x.value === '' ? null : Number(x.value); calc(); }; x.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('ccd-save').click(); } }; }); document.querySelectorAll('#ccd-rows [data-ccd-del]').forEach(b => b.onclick = () => { ps.splice(Number(b.dataset.ccdDel), 1); paint(); }); };
  openModal('<h2>コピペ率（CCD）</h2><p class="note">' + esc(r.kw || r.title || '') + '</p>'
    + '<p class="note">CCD（<a href="https://ccd.cloud/" target="_blank" rel="noopener">ccd.cloud</a>）でチェックした結果の%を入れてください。原稿を分けてチェックしたときは「＋ 行を追加」で分けた数だけ入れると、平均を出して保存します。</p>'
    + (cur && !parsed ? '<p class="note">今の記録（シートから取り込んだ内容）：<br><span style="white-space:pre-wrap">' + esc(cur) + '</span><br>保存すると、下で入れた内容に置き換わります。</p>' : '')
    + '<div class="ccd-ex"><div class="row" style="justify-content:space-between"><b>CCDで除外するドメイン</b><button type="button" class="btn sm" id="ccd-ex-copy" disabled>コピー</button></div>'
    + '<p class="note">自社メディアのドメインです。CCDの除外ドメインの欄に貼り付けてからチェックしてください。</p><textarea id="ccd-ex-list" rows="4" readonly aria-label="CCDで除外するドメイン">読み込み中…</textarea></div>'
    + '<div id="ccd-rows"></div><div class="row"><button type="button" class="btn sm" id="ccd-add">＋ 行を追加</button><span class="note">平均：<b id="ccd-avg">—</b></span></div>'
    + '<div class="row" style="justify-content:flex-end; margin-top:12px">' + (cur ? '<button type="button" class="btn" id="ccd-clear">記録を消す</button>' : '') + '<button type="button" class="btn" data-close>閉じる</button><button type="button" class="btn primary" id="ccd-save">保存</button></div>');
  /* 除外するドメイン（自社メディア＋API・連携設定で足したもの）を1行に1つで出して、コピーできるように（2026-11-05 ユーザー指定） */
  (CCD_EX ? Promise.resolve(CCD_EX) : api('/copycheck/exclude').then(d => (CCD_EX = d.domains || []))).then(list => {
    const ta = $('ccd-ex-list'), b = $('ccd-ex-copy'); if (!ta) return;
    ta.value = list.join('\n'); ta.rows = Math.min(Math.max(list.length, 2), 8); b.disabled = !list.length;
    b.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.select(); document.execCommand('copy'); } b.textContent = 'コピーしました'; setTimeout(() => { if ($('ccd-ex-copy')) b.textContent = 'コピー'; }, 1500); };
    ta.onfocus = () => ta.select();
  }).catch(e => { const ta = $('ccd-ex-list'); if (ta) ta.value = '読み込めませんでした：' + e.message; });
  paint();
  const first = document.querySelector('#ccd-rows .ccd-in'); if (first) first.focus();
  $('ccd-add').onclick = () => { ps.push(null); paint(); const ins = document.querySelectorAll('#ccd-rows .ccd-in'); ins[ins.length - 1].focus(); };
  $('ccd-save').onclick = () => { const v = ccdFormat(read()); if (!v) return alert('%を1つ以上入れてください（記録を消すときは「記録を消す」）'); closeModal(); onSave(v); };
  if ($('ccd-clear')) $('ccd-clear').onclick = () => { if (!confirm('コピペ率（CCD）の記録を消します。よろしいですか？')) return; closeModal(); onSave(''); };
}
function pgCell(r, c, i) {
  let v = r[c.k] == null ? '' : String(r[c.k]); const id = 'data-i="' + i + '" data-k="' + c.k + '"';
  const blank = cur => cur ? '' : '<option value="" selected disabled hidden>選択</option>';
  const opts = (list) => blank(v) + list.concat(v && !list.includes(v) ? [v] : []).map(o => '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
  if (c.kind === 'ro') return '<td class="c-txt c-title">' + cellOf(r, 'title') + '</td>';
  if (c.kind === 'lines') { const ls = relKwList(v); return '<td class="' + c.w + ' ' + pgAl(c) + '"><textarea class="kw-lines' + (ls.length ? '' : ' kw-empty') + '" ' + id + ' rows="' + (ls.length ? 3 : 1) + '" placeholder="1行に1つ" title="関連KWは1行に1つ（Enterで改行）">' + esc(ls.join('\n')) + '</textarea></td>'; }
  if (c.kind === 'copy') return '<td class="' + c.w + ' c-ctr" data-copycell="' + c.src + '">' + copyCell(r[c.src]) + '</td>';
  if (c.kind === 'ccd') return '<td class="' + c.w + ' c-ctr"><input type="hidden" ' + id + ' value="' + esc(v) + '">' + ccdBtn(v, i) + '</td>';
  if (c.kind === 'vol') return '<td class="c-num">' + cellOf(r, 'vol_avg') + '</td>';
  if (c.kind === 'status') return '<td class="' + c.w + ' ' + pgAl(c) + '"><select class="ph-' + phaseCls(v) + '" ' + id + '>' + blank(v) + STATUS_ORDER.filter(x => statusesFor(r).includes(x) || x === v).map(o => '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>' + guideSlot(r) + '</td>';
  if (c.kind === 'sup') { const cur = supOf(r); return '<td class="' + c.w + ' ' + pgAl(c) + '"><select class="' + (cur === 'あり' ? 'sup-yes' : '') + '" ' + id + ' title="' + (r.supervision ? '' : '専門レベルから判断しています') + '">' + blank(cur) + ['あり', 'なし'].map(o => '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></td>'; }
  if (c.kind === 'type') return '<td class="' + c.w + ' ' + pgAl(c) + '"><select ' + id + '>' + opts(TYPE_OPTIONS) + '</select></td>';
  if (c.kind === 'sel') return '<td class="' + c.w + ' ' + pgAl(c) + '"><select ' + id + (v ? '' : ' class="unsel"') + '>' + opts(c.opts) + '</select></td>';
  if (c.kind === 'date') return '<td class="' + c.w + ' ' + pgAl(c) + '"><input type="date" ' + id + ' value="' + esc(v) + '"></td>';
  if (c.kind === 'month') return '<td class="' + c.w + ' ' + pgAl(c) + '"><input type="month" ' + id + ' value="' + esc(v) + '"' + (r.writer && !v && !r.upload_date ? ' class="need-no"' : '') + '></td>';   /* アップロード目標月（2026-11-04） */
  if (c.kind === 'num') return '<td class="' + c.w + ' ' + pgAl(c) + '">' + (c.k === 'chars' ? '<div class="chars-cell">' : '') + '<input type="number" inputmode="numeric" ' + id + ' value="' + esc(v) + '">' + (c.k === 'chars' ? charsGetBtn(r) + '</div>' : '') + '</td>';
  if (c.kind === 'person') {
    // 契約管理に契約中の人がいれば、その人たちから選ぶ（契約がまだ登録されていないメディアは手入力）
    const names = peopleFor(r.media, c.k);
    if (!PEOPLE.some(p => p.media === r.media)) return '<td class="' + c.w + ' ' + pgAl(c) + '"><input list="pg-people" ' + id + ' value="' + esc(v) + '"></td>';
    if (v && !names.includes(v) && names.includes(personName(v, r.media))) v = personName(v, r.media);
    if (v && !names.includes(v)) { const hit = names.find(n => normName(n) === normName(v)); if (hit) v = hit; }   // 空白の有無だけの違いは同じ人   // 苗字だけなどの書き方は、担当者の紐づけで決めた契約者名で選ぶ（2026-10-27 ユーザー指定）
    /* 監修担当は「なし」を選ぶと未入力に戻せる（全メディア共通。2026-11-09 ユーザー指定） */
    const noneOpt = c.k === 'supervisor' ? '<option value="">なし</option>' : '';
    return '<td class="' + c.w + ' ' + pgAl(c) + '"><select class="person-sel" ' + id + '>' + blank(v) + noneOpt + names.concat(v && !names.includes(v) ? [v] : []).map(o => '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(o) + (names.includes(o) ? '' : KNOWN_PEOPLE.has(o) || KNOWN_PEOPLE.has(personName(o, r.media)) ? '（担当外）' : '（未登録）') + '</option>').join('') + '</select></td>';
  }
  if (c.kind === 'tags') {   // 公開済み（WordPress にある記事）は WordPress のタグ。まだの記事はチェックボックスで選ぶ
    if (r.wp_tags) return '<td class="' + c.w + ' ' + pgAl(c) + '"><span class="tag-count wp" title="' + esc(r.wp_tags.join('、') || 'タグなし') + '">WP ' + r.wp_tags.length + '件</span></td>';   // タグ名はマウスを乗せると出る
    const n = parseTags(v).length;
    return '<td class="' + c.w + ' ' + pgAl(c) + '"><input type="hidden" ' + id + ' value="' + esc(v) + '"><button class="btn sm tag-btn' + (n ? '' : ' unsel') + '" type="button" data-tags="' + i + '">' + (n ? 'タグ ' + n + '件' : '未選択') + '</button></td>';
  }
  // カテゴリ：公開済み（WordPress にある記事）は WordPress のカテゴリを表示（変更は WordPress で）
  if (c.kind === 'opt' && c.src === 'categories' && r.wp_categories) return '<td class="' + c.w + ' ' + pgAl(c) + '"><span class="wp-cat" title="' + esc(r.wp_categories.join('、')) + '">' + (r.wp_categories.length ? esc(r.wp_categories.join('、')) : '<span class="note">未選択</span>') + '</span> <span class="tag-count wp">WP</span></td>';
  if (c.kind === 'opt') {   // カテゴリ・タグは WordPress、CTA・訴求ブロックは各種設定（＋シートにある値）。空欄は「未選択」
    const list = optNames(c.src, r.media);
    /* CTA・訴求ブロック：シートの書き方が違っても、同じマイブロックならその名前を選んだ状態で出す（保存はしない）。どれとも合わなければ「（設定にない名前）」を付けて出す（2026-11-05 ユーザー指定） */
    let sel = v, extra = [];
    if (v && !list.includes(v)) { const m = (c.src === 'cta' || c.src === 'appeal') ? list.filter(n => blockHit(n, r, c.k)) : []; if (m.length === 1) sel = m[0]; else extra = [v]; }
    return '<td class="' + c.w + ' ' + pgAl(c) + '"><select ' + id + (v ? '' : ' class="unsel"') + (sel !== v ? ' title="シートの値：' + esc(v) + '"' : '') + '><option value="">未選択</option>' + list.map(o => '<option value="' + esc(o) + '"' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + extra.map(o => '<option value="' + esc(o) + '" selected>' + esc(o) + '（設定にない名前）</option>').join('') + '</select></td>';
  }
  /* 構成URL：構成シート（本アプリ）なら「構成シート」のリンク。「構成」ボタンで 作る／読み込む／URLを添付 を選ぶ（2026-11-12 ユーザー指定） */
  if (c.kind === 'doc' && c.k === 'outline_url') {
    const app = isOutlineUrl(v), pick = r.key && !app ? '<button class="btn sm ol-pick" type="button" data-olpick="' + i + '" title="構成を用意する（本アプリで作る・読み込む・URLを添付）">構成</button>' : '';
    return '<td class="' + c.w + ' ' + pgAl(c) + '"><div class="doc-cell">' + (app ? '<input type="hidden" ' + id + ' value="' + esc(v) + '"><a class="ol-link" href="' + escUrl(v) + '">構成シート</a>' : '<input type="url" ' + id + ' value="' + esc(v) + '" placeholder="スプシ／ドキュメントのURL" title="' + esc(v) + '">' + (v ? '<a href="' + escUrl(v) + '" target="_blank" rel="noopener">開く</a>' : '')) + pick + '</div></td>';
  }
  if (c.kind === 'doc') return '<td class="' + c.w + ' ' + pgAl(c) + '"><div class="doc-cell"><input type="url" ' + id + ' value="' + esc(v) + '" placeholder="' + (c.k === 'url' ? '記事のURL' : 'スプシ／ドキュメントのURL') + '" title="' + esc(v) + '">' + (v ? '<a href="' + escUrl(v) + '" target="_blank" rel="noopener">開く</a>' : '') + '</div></td>';
  if (c.k === 'kw' && isSupMedia(r.media) && supOf(r) === 'あり') return '<td class="' + c.w + ' ' + pgAl(c) + '"><input class="kw-sup" ' + id + ' value="' + esc(v) + '" title="監修あり：' + esc(v) + '"></td>';
  return '<td class="' + c.w + ' ' + pgAl(c) + '"><input ' + id + ' value="' + esc(v) + '"' + (c.k === 'url' || c.k === 'memo' || c.k === 'kw' ? ' title="' + esc(v) + '"' : '') + '></td>';
}
/** コンテンツ進行管理の下の「プレスリリース」（全メディア。右上のメディアで絞る）（2026-10-31 ユーザー指定） */
async function drawPressPanel(viewOnly) {   /* viewOnly：コンテンツ進行管理の下（そのメディアのリリースを見るだけ） */
  const box = $('press-body'); if (!box) return;
  /* 保存して描き直しても、いまのスクロール位置のまま（いちばん上に戻らない）（2026-11-02 ユーザー指定） */
  const scrollers = () => [document.scrollingElement, $('content'), document.querySelector('main'), box.querySelector('.table-wrap')].filter(Boolean);
  const keep = scrollers().map(el => [el, el.scrollTop, el.scrollLeft]), keepTw = [...box.querySelectorAll('.table-wrap')].map(el => [el.scrollTop, el.scrollLeft]);
  await loadItems();
  const cts = (await loadContracts().catch(() => ({ contracts: [] }))).contracts || [], stf = (await loadStaffNames()) || [];
  // 進行担当＝BEST社員だけ。構成・ライティング・画像・アップロード担当＝BEST社員か、そのリリースのメディア・月のディレクション担当（2026-11-02 ユーザー指定）
  /* BEST社員はそのリリースの日に在籍していた人だけ（入社日〜退職日。退職した人は出さない）（2026-11-02 ユーザー指定） */
  /* さらに、その月に BEST MEDIA の担当（メディア・プレスリリース・BEST MEDIA の PM など）がある人だけ（経理など担当のない人は出さない）。担当の登録がない月は前の月を引き継ぐ（2026-11-02 ユーザー指定） */
  const bmAt = (s, m) => { const am = s.assignMedia || {}, k = Object.keys(am).filter(y => y <= m).sort().pop(); return !!k && (am[k] || []).some(md => !/^__(kurashi|dev)/.test(md)); };
  const staffAt = x => { const d = String(x.date || todayJst()), m = d.slice(0, 7); return [...new Set(stf.filter(s => (!s.joinDate || s.joinDate <= d) && (!s.retireDate || s.retireDate >= d) && bmAt(s, m)).map(s => s.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')); };
  const dirOf = x => directorDefault({ media: x.media, sub: x.sub, upload_date: x.date || todayJst() }) || '';
  /* そのメディアを担当していた業務委託（PM・ディレクター・アシスタントディレクター・アシスタント兼ライター。リリースの月に契約中）。ライターは出さない（2026-11-02 ユーザー指定） */
  const DIR_POS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター'];
  /* 例外で選べる人：BEST365 は小野さん、ハチお助け本舗は井上さん（2026-11-02 ユーザー指定） */
  const PRESS_EXTRA = { BEST365: ['小野 雄人'], 'ハチお助け': ['井上雄輝'] };
  const dirsAt = x => { const m = String(x.date || todayJst()).slice(0, 7); return cts.filter(c => c.category !== 'site' && c.category !== 'supervision' && DIR_POS.includes(c.position) && (!c.startMonth || String(c.startMonth).slice(0, 7) <= m || (c.pastPays || []).some(p => p.from <= m)) && (!c.endDate || String(c.endDate).slice(0, 7) >= m) && mediasAt(c, m).includes(x.media)).map(c => c.name).concat(PRESS_EXTRA[x.media] || []); };
  const ownerOpts = (x, k) => k === 'manager' ? staffAt(x) : [...new Set([dirOf(x)].concat(dirsAt(x)).concat(x.sheetOwner && cts.some(c => personName(x.sheetOwner, x.media) === c.name) ? [personName(x.sheetOwner, x.media)] : []).concat(staffAt(x)).filter(Boolean))];
  const am = artMedia(), list = (PRESS_ITEMS || []).filter(x => am === ALL || x.media === am).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const canEdit = viewOnly !== true && isPressStaff() && (isAdmin() || (me && me.perms && ['admin', 'editor'].includes(me.perms.articles))), money = !noMoney() && isPressStaff();
  // 担当のプルダウン（k：manager＝進行担当／outlineOwner＝構成／owner＝ライティング／imageOwner＝画像／uploadOwner＝アップロード）
  const pick = (x, k, cur, hint) => { const opts = ownerOpts(x, k), hit = opts.find(n => n === cur || personName(cur, x.media) === n || fullPersonName(cur, x.media) === n), extra = cur && !hit ? [cur] : [];
    if (!canEdit) return esc(cur || '—');
    return '<select class="press-in" data-pid="' + esc(x.id) + '" data-pk="' + k + '"' + (k === 'owner' && !cur ? ' style="border-color:var(--bad)"' : '') + '><option value="">（選ぶ）</option>' + (k === 'owner' ? '<option value="' + PRESS_NONE + '"' + (x.owner === PRESS_NONE ? ' selected' : '') + '>' + PRESS_NONE + '</option>' : '') + extra.concat(opts).map(n => '<option value="' + esc(n) + '"' + (n === (hit || cur) ? ' selected' : '') + '>' + esc(n) + (extra.includes(n) ? '（選べる人にない）' : '') + '</option>').join('') + '</select>' + (hint ? '<br><span class="note">' + hint + '</span>' : ''); };
  const urlIn = (x, k, v) => canEdit ? '<div class="doc-cell"><input class="press-in press-url" data-pid="' + esc(x.id) + '" data-pk="' + k + '" type="url" value="' + esc(v || '') + '" placeholder="https://" title="' + esc(v || '') + '">' + (v ? '<a href="' + escUrl(v) + '" target="_blank" rel="noopener">開く</a>' : '') + '</div>'
    : (v ? '<a href="' + escUrl(v) + '" target="_blank" rel="noopener">開く</a>' : '<span class="note">—</span>');
  const ownerHow = x => x.owner ? '' : x.sheetOwner ? '' :   /* 「シートの「ディレクター相談」」の補足は出さない（2026-11-02 ユーザー指定） */ pressOwner(x) ? 'その月のディレクション担当' : '<span class="err">担当不明</span>';
  const isDoc = x => /docs\.google\.com\/document/.test(x.draftUrl || '');
  const charsCell = x => (Number(x.chars) > 0 ? nf.format(x.chars) : x.charsError ? '<span class="err" title="' + esc(x.charsError) + '">読めない</span>' : isDoc(x) ? '<span class="note">未取得</span>' : '<span class="note">—</span>')
    + (canEdit && isDoc(x) ? '<br><button class="btn sm" type="button" data-pchars="' + esc(x.id) + '" title="ライティングURL（Google ドキュメント）から文字数を数えます">数える</button>' : '');
  // 状態（プルダウン）。アップロードURL（公開URL）があれば「公開済み」（2026-11-02 ユーザー指定）
  const PRESS_STATUS = ['未着手', '構成作成中', 'ライティング中', '社内チェック中', '入稿・配信設定済み', '公開済み', '中止'];
  const stOf = x => x.status || (x.published ? '公開済み' : '未着手');
  const stCell = x => canEdit ? '<select class="press-in press-st' + (stOf(x) === '公開済み' ? ' st-pub' : '') + '" data-pid="' + esc(x.id) + '" data-pk="status">' + PRESS_STATUS.map(s => '<option value="' + s + '"' + (s === stOf(x) ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>'
    : '<span class="pill ' + (stOf(x) === '公開済み' ? 'ok' : 'wait') + '">' + esc(stOf(x)) + '</span>';
  const titleCell = x => x.prTitle ? esc(x.prTitle) + (x.title && x.title !== x.prTitle ? '' : '') : esc(x.title || '');
  const unk = list.filter(x => x.published && x.media !== '__kurashi' && !pressOwner(x) && x.owner !== PRESS_NONE);
  const BULK = [['manager', '進行担当'], ['outlineOwner', '構成担当'], ['owner', 'ライティング担当'], ['imageOwner', '画像担当'], ['uploadOwner', 'アップロード担当'], ['status', '状態']];
  /* プロジェクト（シートのスケジュールのタブの期間）ごとに見出しの行を入れる（2026-11-02 ユーザー指定）。画面で追加したリリースは、リリース日が入る期間のプロジェクト */
  let PROJ = {}; try { PROJ = (await api('/press-projects')).managers || {}; } catch (e) { /* 担当なしで表示 */ }
  const projLabel = t => String(t || '').replace(/^スケジュール/, '').replace(/[〜~]/g, '～').trim();
  const projRange = l => { const m = l.match(/(\d{4})年(\d{1,2})月～(?:(\d{4})年)?(\d{1,2})月/); if (!m) return null; const y1 = Number(m[1]), m1 = Number(m[2]), m2 = Number(m[4]), y2 = m[3] ? Number(m[3]) : (m2 < m1 ? y1 + 1 : y1); return [y1 + '-' + String(m1).padStart(2, '0'), y2 + '-' + String(m2).padStart(2, '0')]; };
  const projOf0 = x => projOf(x);
  const projOf = x => { if (/^スケジュール/.test(x.tab || '')) return projLabel(x.tab); const ym = String(x.date || '').slice(0, 7); return PROJS.find(l => { const r = projRange(l); return r && ym >= r[0] && ym <= r[1]; }) || '（プロジェクト未設定）'; };
  const PROJS = [...new Set((PRESS_ITEMS || []).filter(x => /^スケジュール/.test(x.tab || '')).map(x => projLabel(x.tab)).concat(Object.keys(PROJ).filter(l => projRange(l))))];
  /* リリースがまだないプロジェクト（追加したばかり・これからの期間）は、進行中の表に見出しだけ出す */
  const emptyProj = viewOnly === true ? [] : PROJS.filter(l => !(PRESS_ITEMS || []).some(x => projOf0(x) === l) && projRange(l)[1] >= CUR_MONTH).sort((a, b) => projRange(b)[0].localeCompare(projRange(a)[0]));
  const nCols = (canEdit ? 1 : 0) + 16 + (money ? 2 : 0);
  const projRow = (l, L) => { const mgr = PROJ[l] || '', opts = staffAt(L[0] || {}), sel = canEdit && viewOnly !== true && l !== '（プロジェクト未設定）' ? '<select class="press-proj-mgr" data-proj="' + esc(l) + '"><option value="">（選ぶ）</option>' + opts.concat(mgr && !opts.includes(mgr) ? [mgr] : []).map(n => '<option' + (n === mgr ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>' : '<b>' + esc(mgr || '未設定') + '</b>';
    return '<div class="press-proj-head"><div class="press-proj-in"><b>' + esc(l === '（プロジェクト未設定）' ? l : l + 'プレスリリース') + '</b><span>' + (viewOnly === true ? '担当：' : 'プロジェクト進行担当：') + sel + '</span>' + (viewOnly === true && am !== ALL ? '<span>' + esc(mediaLabel(am)) + '</span>' : '') + '<span class="note">' + L.length + '件</span></div></div>'; };
  const groups = L => { const g = {}; L.forEach(x => { (g[projOf(x)] = g[projOf(x)] || []).push(x); }); return Object.entries(g).sort((a, b) => String(b[1][0].date || '').localeCompare(String(a[1][0].date || ''))); };
  const tbl = (L, empty, withEmpty) => groups(L).map(([l, xs]) => projRow(l, xs) + tblOne(xs)).join('') + (withEmpty ? emptyProj.map(l => projRow(l, []) + '<p class="note" style="margin:4px 0 14px">まだリリースはありません</p>').join('') : '') + (L.length || (withEmpty && emptyProj.length) ? '' : '<p class="empty">' + empty + '</p>');
  const tblOne = L => '<div class="table-wrap am-scroll" style="margin-bottom:14px"><table class="am-table press-table' + (canEdit ? ' has-check' : '') + '"><thead><tr>' + (canEdit ? '<th class="c-ctr press-chk"><input type="checkbox" class="press-all" title="すべて選ぶ"></th>' : '') + '<th class="c-ctr">リリース日</th><th class="c-txt">メディア</th><th class="c-txt">ディレクトリ</th><th class="c-ctr">No.</th><th class="c-txt">タイトル</th><th class="c-ctr">状態</th>'
    + '<th class="c-txt">進行担当</th><th class="c-txt">構成URL</th><th class="c-txt">構成担当</th><th class="c-txt">ライティングURL</th><th class="c-txt">ライティング担当</th><th class="c-num">文字数</th><th class="c-num">画像枚数</th><th class="c-txt">画像担当</th><th class="c-txt">アップロードURL</th><th class="c-txt">アップロード担当</th>' + (money ? '<th class="c-num">調査費</th><th class="c-num">配信費</th>' : '') + '</tr></thead><tbody>'
    + L.map(x => { const out = x.media === '__kurashi', mLab = (out ? 'Eparkくらしのレスキュー' : mediaLabel(x.media)) + (x.sub ? '（' + x.sub + '）' : '');
      return '<tr' + (x.published ? '' : ' class="press-plan"') + '>' + (canEdit ? '<td class="c-ctr press-chk"><input type="checkbox" data-ppick="' + esc(x.id) + '"></td>' : '')
        + '<td class="c-ctr">' + esc(x.date ? x.date.replace(/-/g, '/') : '—') + '</td><td class="c-txt press-media">' + esc(out ? 'Eparkくらしのレスキュー' : mediaLabel(x.media)) + (out ? '<br><span class="note">BEST MEDIA外</span>' : '') + '</td><td class="c-txt press-dir">' + (canEdit && artSubs(x.media) ? '<select class="press-in press-sub' + (x.sub ? '' : ' unsel') + '" data-pid="' + esc(x.id) + '" data-pk="sub"><option value="">（ディレクトリ）</option>' + artSubs(x.media).concat(x.sub && !artSubs(x.media).includes(x.sub) ? [x.sub] : []).map(d => '<option value="' + esc(d) + '"' + (d === x.sub ? ' selected' : '') + '>' + esc(d) + '</option>').join('') + '</select>' : x.sub ? esc(x.sub) : '<span class="note">—</span>') + '</td><td class="c-ctr">' + (canEdit ? '<input class="press-in press-no" data-pid="' + esc(x.id) + '" data-pk="no" value="' + esc(x.no || '') + '">' : esc(x.no || '')) + '</td><td class="c-txt press-title" title="' + esc(x.prTitle ? 'PR TIMES の公開タイトル' : 'シートのタイトル') + '">' + titleCell(x) + '</td>'
        + '<td class="c-ctr">' + stCell(x) + '</td>'
        + '<td class="c-txt">' + pick(x, 'manager', x.manager || '') + '</td>'
        + '<td class="c-txt">' + urlIn(x, 'outlineUrl', x.outlineUrl) + '</td><td class="c-txt">' + pick(x, 'outlineOwner', x.outlineOwner || '') + '</td>'
        + '<td class="c-txt">' + urlIn(x, 'draftUrl', x.draftUrl) + '</td><td class="c-txt">' + pick(x, 'owner', pressOwner(x), ownerHow(x)) + '</td>'
        + '<td class="c-num">' + charsCell(x) + '</td>'
        + '<td class="c-num">' + (canEdit ? '<input class="press-in press-num" data-pid="' + esc(x.id) + '" data-pk="imageCount" inputmode="numeric" value="' + esc(x.imageCount ?? '') + '" placeholder="枚">' : esc(x.imageCount ?? '—')) + '</td><td class="c-txt">' + pick(x, 'imageOwner', x.imageOwner || '') + '</td>'
        + '<td class="c-txt">' + urlIn(x, 'url', x.url) + '</td><td class="c-txt">' + pick(x, 'uploadOwner', x.uploadOwner || '') + '</td>'
        + (money ? '<td class="c-num">' + ((x.research ?? ((x.scr || 0) + (x.svy || 0))) ? yen0(x.research ?? ((x.scr || 0) + (x.svy || 0))) : '<span class="note">—</span>') + '</td><td class="c-num">' + (x.dist ? yen0(x.dist) : '<span class="note">—</span>') + '</td>' : '') + '</tr>'; }).join('')
    + '</tbody></table></div>';
  box.innerHTML = H((viewOnly === true ? 'プレスリリース' : 'プレスリリース進行管理') + ' <small>' + esc(am === ALL ? '全メディア' : mediaLabel(am)) + '・' + list.length + '件（公開 ' + list.filter(x => x.published).length + '件）</small>', ['プレスリリースのシート'])
    + (canEdit ? '<div class="row" style="justify-content:flex-end; gap:8px; margin-bottom:6px"><button class="btn sm" type="button" id="press-proj-add">＋ プロジェクトを追加</button><button class="btn primary sm" type="button" id="press-add">＋ 新規リリースを追加</button></div>' : viewOnly === true && isPressStaff() ? '<p class="note">入力・追加は コンテンツ作成 →「プレスリリース進行管理」で行います。ここではこのメディアのリリースを表示します。</p>' : '')
    + (unk.length ? '<p class="err">ライティング担当が決まらない公開済みのリリースが ' + unk.length + '件あります。</p>' : '')
    + (canEdit ? '<p class="note">左のチェックボックスで選ぶと、そのプロジェクトの表の上にバーが出て、担当・状態をまとめて変更・まとめて削除できます（表の見出しのチェックで、その表をすべて選ぶ）。</p>' : '')
    + (canEdit ? '<div class="row bulk-bar" id="press-bulk" hidden><b id="press-bulk-n" class="num"></b><label class="field">項目<select id="press-bulk-k">' + BULK.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select></label><label class="field">変更後<select id="press-bulk-v"></select></label><button class="btn primary" type="button" id="press-bulk-go">まとめて変更</button><button class="btn" type="button" id="press-bulk-del">まとめて削除</button><button class="btn" type="button" id="press-bulk-clear">選択を解除</button></div>' : '')
    + (() => { const done = x => x.published || x.status === '中止', prog = list.filter(x => !done(x)), pub = list.filter(done);
      return '<h3 class="am-h">進行中 <small class="note">' + prog.length + '件</small></h3>' + tbl(prog, '進行中のプレスリリースはありません', true) + '<h3 class="am-h" style="margin-top:18px">公開済み <small class="note">' + list.filter(x => x.published).length + '件' + (pub.length > list.filter(x => x.published).length ? '・中止 ' + (pub.length - list.filter(x => x.published).length) + '件' : '') + '</small></h3>' + tbl(pub, '公開済みのプレスリリースはありません'); })()
    + '<p class="note">元：プレスリリースのシート（スケジュールのタブ）。ここで入れた担当・URL・画像作成枚数・状態はシートより優先します（シートには書き込みません。削除もダッシュボードで隠すだけ）。タイトルは、アップロードURL（PR TIMES の公開ページ）があればそのページのタイトル、なければシートのタイトル。進行担当はBEST社員、構成・ライティング・画像・アップロード担当はBEST社員かそのメディアのディレクション担当から選びます。ライティング担当が空のときは、シートの「ディレクター相談」の名前 → その月のそのメディアのディレクション担当。文字数はライティングURL（Google ドキュメント）からコンテンツ進行管理と同じ数え方で自動で数えます（「数える」でいますぐ数え直し）。原稿を dashboard-app@bestmedia-510909.iam.gserviceaccount.com に閲覧者で共有していないと「読めない」になります。アップロードURL（公開URL）が入るか、状態を「公開済み」にすると公開済み。</p>';
  { const tws = [...box.querySelectorAll('.table-wrap')]; keep.forEach(([el, t, l]) => { if (el.isConnected) { el.scrollTop = t; el.scrollLeft = l; } }); keepTw.forEach(([t, l], k) => { if (tws[k]) { tws[k].scrollTop = t; tws[k].scrollLeft = l; } }); }
  if ($('press-proj-add')) $('press-proj-add').onclick = () => {
    const opts = staffAt({});
    openModal('<h2>プロジェクトを追加</h2><div class="form-grid"><label class="field">開始月<input id="pp-from" type="month" value="' + CUR_MONTH + '"></label><label class="field">終了月<input id="pp-to" type="month" value="' + shiftMonth(CUR_MONTH, 1) + '"></label>'
      + '<label class="field" style="grid-column:1/-1">プロジェクト進行担当<select id="pp-mgr"><option value="">（選ぶ）</option>' + opts.map(n => '<option>' + esc(n) + '</option>').join('') + '</select></label></div>'
      + '<p class="note">「○年○月～○月プレスリリース」として表に見出しが出ます。リリースは「＋ 新規リリースを追加」で、リリース日がこの期間に入るように追加してください。</p><p class="err" id="pp-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="pp-save">追加する</button></div>');
    $('pp-save').onclick = async () => { const f = $('pp-from').value, t = $('pp-to').value, err = m => { $('pp-err').textContent = m; $('pp-err').hidden = false; };
      if (!/^\d{4}-\d{2}$/.test(f) || !/^\d{4}-\d{2}$/.test(t) || t < f) return err('開始月と終了月を正しく入れてください');
      const label = Number(f.slice(0, 4)) + '年' + Number(f.slice(5)) + '月～' + (t.slice(0, 4) !== f.slice(0, 4) ? Number(t.slice(0, 4)) + '年' : '') + Number(t.slice(5)) + '月';
      if (PROJS.includes(label)) return err(label + ' のプロジェクトはもうあります');
      try { await apiSend('PUT', '/press-projects', { label, manager: $('pp-mgr').value }); closeModal(); toast(label + 'プレスリリースを追加しました'); drawPressPanel(viewOnly); } catch (e) { err(e.message); } };
  };
  if ($('press-add')) $('press-add').onclick = () => {
    const mOpts = topMedia().map(m => [m.media, m.name]).concat([['__kurashi', 'Eparkくらしのレスキュー']]);
    openModal('<h2>新規リリースを追加</h2><div class="form-grid"><label class="field">リリース日<input id="pa-date" type="date"></label><label class="field">メディア<select id="pa-media">' + mOpts.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === am ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>'
      + '<label class="field">ディレクトリ<select id="pa-sub"></select></label><label class="field">No.（自動。直せます）<input id="pa-no"></label><label class="field" style="grid-column:1/-1">タイトル<input id="pa-title"></label></div>'
      + '<p class="note">担当・URL・画像作成枚数は、追加したあとに表で入れてください。追加したリリースはダッシュボードだけに保存します（シートには書き込みません）。</p><p class="err" id="pa-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px"><button class="btn" type="button" data-close>やめる</button><button class="btn primary" type="button" id="pa-save">追加する</button></div>');
    const nextNo = m => String(Math.max(0, ...(PRESS_ITEMS || []).map(y => parseInt(String(y.no || '').replace(/[^0-9]/g, ''), 10)).filter(n => isFinite(n))) + 1);   /* 次の番号（No.はメディアをまたいだ通し番号）（2026-11-02 ユーザー指定） */
    const fillSub = () => { const subs = artSubs($('pa-media').value) || []; $('pa-sub').innerHTML = subs.length ? '<option value="">（選ぶ）</option>' + subs.map(d => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('') : '<option value="">（ディレクトリなし）</option>'; $('pa-sub').disabled = !subs.length; };
    fillSub(); $('pa-no').value = nextNo($('pa-media').value); $('pa-media').onchange = () => { $('pa-no').value = nextNo($('pa-media').value); fillSub(); };
    $('pa-save').onclick = async () => { try { await apiSend('POST', '/press-items', { date: $('pa-date').value, media: $('pa-media').value, sub: $('pa-sub').value, no: $('pa-no').value, title: $('pa-title').value }); closeModal(); ITEMS = null; toast('追加しました'); render(); } catch (e) { $('pa-err').textContent = e.message; $('pa-err').hidden = false; } };
  };
  box.querySelectorAll('.press-proj-mgr').forEach(el => el.onchange = async () => { try { await apiSend('PUT', '/press-projects', { label: el.dataset.proj, manager: el.value }); toast('プロジェクト進行担当を保存しました'); drawPressPanel(viewOnly); } catch (e) { alert(e.message); } });
  box.querySelectorAll('.press-in').forEach(el => el.onchange = async () => {
    const k = el.dataset.pk, v = el.value.trim();
    try { await apiSend('PUT', '/press-items/' + encodeURIComponent(el.dataset.pid), { [k]: v }); const x = PRESS_ITEMS.find(y => y.id === el.dataset.pid); if (x) { x[k] = k === 'imageCount' ? (v ? Number(v) : null) : v; if (k === 'url' || k === 'status') x.published = /^http/.test(x.url || '') || x.status === '公開済み'; if (k === 'draftUrl') { x.chars = null; x.charsError = ''; } } toast('保存しました'); drawPressPanel(viewOnly); }
    catch (e) { alert(e.message); }
  });
  // 文字数をいま数える
  box.querySelectorAll('[data-pchars]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = '数えています…';
    const x = PRESS_ITEMS.find(y => y.id === b.dataset.pchars);
    try { const r = await apiSend('POST', '/press-items/' + encodeURIComponent(b.dataset.pchars) + '/chars', {}); if (x) { x.chars = r.chars; x.charsError = ''; } toast('文字数：' + nf.format(r.chars)); }
    catch (e) { if (x) x.charsError = e.message; alert(e.message); }
    drawPressPanel(viewOnly);
  });
  // 削除（1件・まとめて）
  const delIds = async ids => { if (!ids.length || !confirm(ids.length + '件のリリースを削除します。よろしいですか？（シートのリリースはダッシュボードで隠すだけで、シートは変わりません）')) return; let ng = 0; for (const id of ids) { try { await apiSend('DELETE', '/press-items/' + encodeURIComponent(id)); } catch (e) { ng++; } } PRESS_ITEMS = (PRESS_ITEMS || []).filter(y => !ids.includes(y.id)); toast((ids.length - ng) + '件を削除しました' + (ng ? '（' + ng + '件は失敗）' : '')); drawPressPanel(viewOnly); };
  box.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => delIds([b.dataset.pdel]));
  // まとめて編集（チェックボックスで選んで、担当・状態をまとめて変更）（2026-11-02 ユーザー指定）
  if (canEdit && $('press-bulk')) {
    const picked = new Set(), bar = $('press-bulk');
    const fillV = () => { const k = $('press-bulk-k').value, xs = list.filter(x => picked.has(x.id));
      if (k === 'status') { $('press-bulk-v').innerHTML = PRESS_STATUS.map(s => '<option value="' + s + '">' + s + '</option>').join(''); return; }
      const opts = [...new Set(xs.flatMap(x => ownerOpts(x, k)))].sort((a, b) => a.localeCompare(b, 'ja'));
      $('press-bulk-v').innerHTML = '<option value="">（空にする）</option>' + (k === 'owner' ? '<option value="' + PRESS_NONE + '">' + PRESS_NONE + '</option>' : '') + opts.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join(''); };
    const upd = () => { bar.hidden = !picked.size; $('press-bulk-n').textContent = picked.size + '件を選択中'; if (picked.size) fillV(); };
    let curWrap = null;
    const scope = el => { const w = el.closest('.table-wrap'); if (w === curWrap) return; picked.clear(); box.querySelectorAll('[data-ppick]').forEach(c => { if (!w.contains(c)) c.checked = false; }); box.querySelectorAll('.press-all').forEach(a => { if (!w.contains(a)) a.checked = false; }); curWrap = w; w.parentNode.insertBefore(bar, w.previousElementSibling && w.previousElementSibling.classList.contains('tw-topscroll') ? w.previousElementSibling : w); };
    box.querySelectorAll('[data-ppick]').forEach(c => c.onchange = () => { scope(c); c.checked ? picked.add(c.dataset.ppick) : picked.delete(c.dataset.ppick); upd(); });
    box.querySelectorAll('.press-all').forEach(a => a.onchange = e => { scope(a); a.closest('.table-wrap').querySelectorAll('[data-ppick]').forEach(c => { c.checked = e.target.checked; c.checked ? picked.add(c.dataset.ppick) : picked.delete(c.dataset.ppick); }); upd(); });
    $('press-bulk-k').onchange = fillV;
    $('press-bulk-clear').onclick = () => { picked.clear(); box.querySelectorAll('[data-ppick]').forEach(c => { c.checked = false; }); box.querySelectorAll('.press-all').forEach(a => { a.checked = false; }); upd(); };
    $('press-bulk-del').onclick = () => delIds([...picked]);
    $('press-bulk-go').onclick = async () => { const k = $('press-bulk-k').value, v = $('press-bulk-v').value; if (!confirm(picked.size + '件の' + BULK.find(b => b[0] === k)[1] + 'を「' + (v || '空') + '」にします。よろしいですか？')) return; let ng = 0; for (const id of picked) { try { await apiSend('PUT', '/press-items/' + encodeURIComponent(id), { [k]: v }); const x = PRESS_ITEMS.find(y => y.id === id); if (x) { x[k] = v; if (k === 'status') x.published = /^http/.test(x.url || '') || v === '公開済み'; } } catch (e) { ng++; } } toast((picked.size - ng) + '件を変更しました' + (ng ? '（' + ng + '件は失敗）' : '')); drawPressPanel(viewOnly); };
  }
}
/** 月次進行管理（2026-11-04 ユーザー指定）：アップロード目標月ごとに、誰にどの記事を割り振っているか。
 *  ディレクション担当は担当メディアの全員分、ライターは自分の分だけ。ライターが入力できるのは ライティングURL・文字数・コピペ率（CCD）・画像枚数・進行状況・アップロードURL・アップロード日（入れるとコンテンツ進行管理の表と請求に反映）。
 *  目標月がない記事は、アップロード日がその月の記事を出す。 */
function viewAmMonthly() {
  const ym = state.amMonth || CUR_MONTH, writerOnly = isWriterOnly();
  return { html: '<section class="panel" id="amm-body"><p class="loading">読み込み中…</p></section>', view: '月次進行管理', after: async () => {
    const mySeq = renderSeq;
    await loadItems(); await loadPersonNames(); await loadGuide();   /* ガイドライン確認（2026-11-13） */
    if (mySeq !== renderSeq) return;
    const media = artMedia(), box = $('amm-body');
    const inMonth = r => (r.target_ym ? r.target_ym === ym : String(r.upload_date || '').slice(0, 7) === ym) && !r.deleted && (writerOnly || inArt(r, media));
    const list = ITEMS.filter(inMonth), nm = r => r.writer ? personName(r.writer, r.media) : '（執筆担当なし）';
    const done = r => !!r.upload_date && String(r.upload_date) <= todayJst(), wrote = r => STATUS_ORDER.indexOf(r.status) >= STATUS_ORDER.indexOf('記事執筆完了');
    const groups = {}; list.forEach(r => { (groups[nm(r)] = groups[nm(r)] || []).push(r); });
    const names = Object.keys(groups).sort((a, b) => (a === '（執筆担当なし）') - (b === '（執筆担当なし）') || a.localeCompare(b, 'ja'));
    const inp = (r, k, type, ph) => '<input class="amm-in" data-key="' + esc(r.key) + '" data-k="' + k + '" type="' + type + '"' + (type === 'number' ? ' inputmode="numeric"' : '') + ' placeholder="' + (ph || '') + '" value="' + esc(r[k] == null ? '' : String(r[k])) + '">';
    const stSel = r => '<select class="amm-in ph-' + phaseCls(r.status || '') + '" data-key="' + esc(r.key) + '" data-k="status">' + (r.status ? '' : '<option value="" selected disabled hidden>選択</option>') + STATUS_ORDER.filter(x => statusesFor(r).includes(x) || x === r.status).map(o => '<option' + (o === r.status ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>' + guideSlot(r);
    /* 列の定義（幅を決めて、担当者ごとの表で左右の位置をそろえる。入力欄はコンテンツ進行管理と同じ見た目）（2026-11-05 ユーザー指定）
       a：そろえ方（txt＝左、ctr＝中央）。見出しも中身も同じそろえ方 */
    const docIn = (r, k, ph) => '<div class="doc-cell">' + inp(r, k, 'url', ph) + (r[k] ? '<a href="' + escUrl(r[k]) + '" target="_blank" rel="noopener">開く</a>' : '') + '</div>';
    const COLS = [].concat(
      media === ALL || writerOnly ? [{ h: 'メディア', w: 130, a: 'txt', td: r => esc(mediaLabel(r.media)) + (r.sub ? '<br><span class="note">' + esc(r.sub) + '</span>' : '') }] : artSubs(media) ? [{ h: 'ディレクトリ', w: 110, a: 'txt', td: r => esc(r.sub || '—') }] : [],
      [{ h: 'No.', w: 64, a: 'ctr', td: r => esc(r.no || '') }, { h: '検索KW', w: 190, a: 'txt', td: r => esc(r.kw || '') }, { h: '制作判断', w: 84, a: 'ctr', td: r => esc(r.type || '') }],
      writerOnly ? [] : [{ h: 'ディレクション担当', w: 120, a: 'txt', td: r => esc(r.director ? personName(r.director, r.media) : '—') }],
      [{ h: '依頼日', w: 92, a: 'ctr', td: r => r.request_date ? esc(String(r.request_date).slice(0, 10).replace(/-/g, '/')) : '<span class="note">—</span>' },   /* 依頼日を表示（2026-11-13 ユーザー指定） */
       { h: 'アップロード目標月', w: 110, a: 'ctr', td: r => r.target_ym ? esc(mLabel(r.target_ym)) : '<span class="note">なし</span>' },
       { h: '進行状況', w: 150, a: 'ctr', td: stSel },
       { h: '構成URL', w: 96, a: 'ctr', td: r => r.outline_url ? '<a href="' + escUrl(r.outline_url) + '" target="_blank" rel="noopener">構成を開く</a>' : '<span class="note">—</span>' },   /* 構成URL（見るだけ。2026-11-04 ユーザー指定） */
       { h: 'ライティングURL', w: 230, a: 'txt', td: r => docIn(r, 'writing_url', 'https://docs.google.com/…') },
       { h: '文字数', w: 96, a: 'ctr', td: r => '<div class="chars-cell">' + inp(r, 'chars', 'number', '文字') + charsGetBtn(r) + '</div>' },
       { h: 'コピペ率（CCD）', w: 120, a: 'ctr', td: r => '<input type="hidden" class="amm-in" data-key="' + esc(r.key) + '" data-k="copy_rate" value="' + esc(r.copy_rate || '') + '">' + ccdBtn(r.copy_rate, esc(r.key)) },   /* コピペ率（CCD）：ライターも入力（2026-11-05 ユーザー指定） */
       { h: '画像枚数', w: 84, a: 'ctr', td: r => inp(r, 'image_count', 'number', '枚') },
       { h: 'アップロードURL', w: 230, a: 'txt', td: r => docIn(r, 'url', 'https://…') },
       { h: 'アップロード日', w: 140, a: 'ctr', td: r => inp(r, 'upload_date', 'date') }]);
    const tblW = COLS.reduce((a, c) => a + c.w, 0);
    const row = r => '<tr class="ph-row-' + phaseCls(r.status || '') + '">' + COLS.map(c => '<td class="c-' + c.a + '">' + c.td(r) + '</td>').join('') + '</tr>';
    const head = '<tr>' + COLS.map(c => '<th class="c-' + c.a + '">' + c.h + '</th>').join('') + '</tr>';
    const colg = '<colgroup>' + COLS.map(c => '<col style="width:' + c.w + 'px">').join('') + '</colgroup>';
    const sum = '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">' + (writerOnly ? '' : '執筆担当') + '</th><th class="c-num">割り振り</th><th class="c-num">執筆完了</th><th class="c-num">アップロード済み</th></tr></thead><tbody>'
      + names.map(n => { const L = groups[n]; return '<tr><td class="c-txt"><b>' + esc(n) + '</b></td><td class="c-num">' + L.length + '本</td><td class="c-num">' + L.filter(wrote).length + '</td><td class="c-num">' + L.filter(done).length + '</td></tr>'; }).join('')
      + '<tr class="total"><td class="c-txt"><b>合計</b></td><td class="c-num"><b>' + list.length + '本</b></td><td class="c-num"><b>' + list.filter(wrote).length + '</b></td><td class="c-num"><b>' + list.filter(done).length + '</b></td></tr></tbody></table></div>';
    box.innerHTML = H('月次進行管理 <small>' + esc(writerOnly ? 'あなたに割り振られた記事' : (media === ALL ? '全メディア' : mediaLabel(media))) + '・アップロード目標月ごと</small>', [], manualBtn('writer'))
      + CCD_NOTE.replace('コピペ（簡易）は参考程度です。', 'コピペ率（CCD）の入力をお願いします。')   /* 月次進行管理にはコピペ（簡易）の列がないので言い方を変える（2026-11-13） */
      + '<div class="row" style="gap:8px; align-items:center; margin-bottom:10px"><button class="btn sm" type="button" id="amm-prev">◀ 前の月</button><b style="font-size:20px">' + esc(mLabel(ym)) + '</b><button class="btn sm" type="button" id="amm-next">次の月 ▶</button>' + (ym !== CUR_MONTH ? '<button class="btn sm" type="button" id="amm-cur">今月</button>' : '') + '</div>'
      + (list.length ? sum + names.map(n => '<h3 class="am-h">' + esc(n) + ' <small class="note">' + groups[n].length + '本</small></h3><div class="table-wrap am-scroll"><table class="am-table pg-table amm-table" style="width:' + tblW + 'px">' + colg + '<thead>' + head + '</thead><tbody>' + groups[n].sort((a, b) => String(a.media + a.no).localeCompare(String(b.media + b.no), 'ja', { numeric: true })).map(row).join('') + '</tbody></table></div>').join('')
        : '<p class="empty">' + esc(mLabel(ym)) + 'にアップロード目標の記事はありません。</p>')
      + '<p class="note">' + (writerOnly ? 'ここで入れた内容は、そのままコンテンツ進行管理と報酬・請求に入ります。報酬は実際のアップロード日の月で数えます。' : '割り振りは、コンテンツ進行管理で執筆担当とアップロード目標月を入れると、ここに出ます。目標月がない記事は、アップロード日がその月の記事を出しています。報酬・請求は実際のアップロード日の月で数えます。') + '</p>';
    const go = d => { state.amMonth = shiftMonth(ym, d); render(); };
    $('amm-prev').onclick = () => go(-1); $('amm-next').onclick = () => go(1); if ($('amm-cur')) $('amm-cur').onclick = () => { state.amMonth = CUR_MONTH; render(); };
    /* コピペ率（CCD）：画面で入れた%を保存して、ボタンの表示を変える（2026-11-05 ユーザー指定） */
    const ccdClick = function () { const b = this, td = b.parentNode, el = td.querySelector('[data-k="copy_rate"]'), r = ITEMS.find(x => x.key === el.dataset.key); if (!r) return;
      openCcdModal(r, async v => { el.value = v; await saveAmm(el); td.querySelector('[data-ccd]').outerHTML = ccdBtn(r.copy_rate, b.dataset.ccd); td.querySelector('[data-ccd]').onclick = ccdClick; }); };
    box.querySelectorAll('[data-ccd]').forEach(b => b.onclick = ccdClick);
    box.querySelectorAll('.amm-in').forEach(el => el.onchange = () => saveAmm(el));
    async function saveAmm(el) {
      const r = ITEMS.find(x => x.key === el.dataset.key), k = el.dataset.k, v = el.value.trim(); if (!r) return;
      if (k === 'writing_url' && v && !DOC_URL.test(v)) { el.value = r[k] || ''; return showInputError('URLを保存できません', ['ライティングURLは Google ドキュメントの URL（https://docs.google.com/…）を入れてください。']); }
      if (k === 'url' && v && !/^https?:\/\//i.test(v)) { el.value = r[k] || ''; return showInputError('URLを保存できません', ['アップロードURLは http:// か https:// で始まるURLを入れてください。']); }
      if (k === 'status') { const miss = missingFor(r, v); if (miss.length) { el.value = r.status || ''; return showInputError('「' + v + '」にできません', miss.map(x => x + (/^ガイドライン確認/.test(x) ? 'が終わっていません（「ガイドライン確認」ボタンから）' : 'が入力されていません'))); } }
      const td = el.closest('td'); td.classList.remove('saved', 'failed'); td.classList.add('saving');
      try {
        const sres = await apiSend('PATCH', '/article-items', { key: r.key, fields: { [k]: v } });
        r[k] = v === '' ? null : (k === 'chars' || k === 'image_count' ? Number(v) : v);
        charsFromRes(r, sres, el.closest('tr')); if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); }
        td.classList.remove('saving'); td.classList.add('saved'); toast('保存しました');
        if (k === 'status') el.className = 'amm-in ph-' + phaseCls(v);
        if (k === 'writing_url' && v) fillChars(r, el.closest('tr'), v);   /* 原稿の文字数を自動で入れる */
      } catch (e) { td.classList.remove('saving'); td.classList.add('failed'); el.value = r[k] == null ? '' : String(r[k]); alert('保存できませんでした：' + e.message); }
    }
  } };
}
function viewAmProgress() {
  const f = state.pgFilter = state.pgFilter || {};   // 進行状況の絞り込みは「すべて」から
  return { html: '<section class="panel" id="pg-body"><p class="loading">読み込み中…</p></section>', view: '記事管理：コンテンツ進行管理', after: async () => {
    await Promise.all([loadItems(), loadCopy(), loadGuide()]);   /* ガイドライン確認（2026-11-13） */
    if (artMedia() === ALL) await Promise.all(topMedia().map(m => loadArtOptions(m.media).catch(() => {})));   // メディア累計：各行のメディアの選択肢
    else await loadArtOptions(artMedia()).catch(() => {});
    const media = artMedia(); renderArtMediaSelect();
    if (!canEditArticles()) { $('pg-body').innerHTML = '<p class="empty">記事を編集する権限がありません。管理者に「記事管理：編集」の権限をもらってください。</p>'; return; }
    let rows = [];
    const picked = new Set();   // チェックした行（保存済みの行だけ）
    const bulkOK = canBulk();
    const people = [...new Set(ITEMS.flatMap(r => [r.writer, r.director, r.upload_owner, r.supervisor]).filter(Boolean))].sort();
    const PG = PG_COLS.filter(c => (!c.sup || isSupMedia(media)) && (!c.rel || isRelMedia(media)));
    const head = CCD_NOTE + '<div class="row" style="margin-bottom:8px">' + filterControls('p-', f, ITEMS.filter(r => inArt(r, media)), media) + '</div><div class="row" style="margin-bottom:8px">'
      + (media === ALL ? '<span class="note">KWを追加するときは、右上でメディアを選んでください（メディア累計では追加できません）</span>' : '')
      + '<button class="btn primary" type="button" id="pg-add"' + (media === ALL ? ' hidden' : '') + '>＋ 新規KW追加</button><button class="btn rewrite" type="button" id="pg-add-rw"' + (media === ALL ? ' hidden' : '') + ' title="過去に新規で作った記事と同じKWをリライトするときに使います">＋ リライトKW追加</button><button class="btn rewrite-lite" type="button" id="pg-add-lite"' + (media === ALL ? ' hidden' : '') + ' title="過去に新規で作った記事と同じKWを簡易リライトするときに使います">＋ 簡易リライトKW追加</button>' + (isSupMedia(media) ? '<span class="pill supy">監修者ありのメディア</span>' : '') + '<span class="note" id="pg-msg">変更するとすぐに保存され、記事一覧に反映されます。</span></div>'
      + (!bulkOK ? '' : '<div class="row bulk-bar" id="pg-bulk" hidden><b id="pg-bulk-n" class="num"></b><select id="pg-bulk-op"><option value="">一括操作を選ぶ</option><option value="delete">KWを削除</option>' + BULK_COLS(media).map(c => '<option value="' + c.k + '">' + esc(c.h) + 'を変更</option>').join('') + '</select><span id="pg-bulk-val"></span><button class="btn primary" type="button" id="pg-bulk-go" disabled>適用</button><button class="btn" type="button" id="pg-bulk-clear">選択を解除</button></div>');
    const draw = () => {
      readFilters('p-', f, media);
      const pending = rows.filter(r => !r.key), ok = matchFilters(f, media);
      const ps = state.pgSort && state.pgSort.k ? state.pgSort : null, pc = ps && (ps.k === '_media' ? { k: 'media', kind: 'text' } : PG_COLS.find(c => c.k === ps.k));
      const sv = (r, c) => { const v = c.k === 'media' ? mediaLabel(r.media) : c.kind === 'person' ? (r[c.k] ? personName(r[c.k], r.media) : '') : r[c.k]; return v == null ? '' : v; };
      const cmpCol = (a, b) => { if (!pc) return 0; const x = sv(a, pc), y = sv(b, pc), ex = x === '' || x == null, ey = y === '' || y == null; if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1;   /* 空欄はいつも下 */
        let d; if (pc.k === 'no') d = byNo(a, b); else if (pc.kind === 'status') d = STATUS_ORDER.indexOf(x) - STATUS_ORDER.indexOf(y); else if (pc.kind === 'num' || pc.kind === 'vol') d = Number(x) - Number(y); else d = String(x).localeCompare(String(y), 'ja', { numeric: true });
        return ps.dir === 'desc' ? -d : d; };
      rows = pending.concat(ITEMS.filter(r => inArt(r, media) && ok(r)).sort((a, b) => {
        if (pc) { const d = cmpCol(a, b); if (d) return d; }
        const sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);
        return (sa < 0 ? -1 : sa) - (sb < 0 ? -1 : sb) || byNo(a, b);
      }));
      const shown = rows.slice(0, f.limit || 100);
      function sortMark(k) { return state.pgSort && state.pgSort.k === k ? (state.pgSort.dir === 'desc' ? ' ▼' : ' ▲') : ''; }
      $('pg-table').innerHTML = '<div class="table-wrap am-scroll"><table class="am-table pg-table sticky2' + (bulkOK ? ' has-check' : '') + '"><thead><tr>' + (bulkOK ? '<th class="c-ctr pg-chk"><input type="checkbox" id="pg-all" title="表示中の行をすべて選ぶ"></th>' : '') + (media === ALL ? '<th class="c-txt pg-sort" data-pgsort="_media">メディア' + sortMark('_media') + '</th>' : '') + PG.map(c => c.kind === 'copy' || c.kind === 'tags' ? '<th class="' + pgAl(c) + '">' + c.h + '</th>' : '<th class="' + pgAl(c) + ' pg-sort" data-pgsort="' + c.k + '" title="押すと並び替え（昇順 → 降順 → 元の並び）">' + c.h + sortMark(c.k) + '</th>').join('') + '<th></th></tr></thead><tbody>'
        + shown.map((r, i) => '<tr class="ph-row-' + (isStopped(r) ? 'moved' : phaseCls(r.status)) + (r.key ? '' : ' pending') + (r.key && kwMissing(r) ? ' kw-missing' : '') + (picked.has(r) ? ' picked' : '') + '">' + (bulkOK ? '<td class="c-ctr pg-chk">' + (r.key ? '<input type="checkbox" data-pick="' + i + '"' + (picked.has(r) ? ' checked' : '') + '>' : '') + '</td>' : '') + (media === ALL ? '<td class="c-txt" style="white-space:nowrap">' + esc(mediaLabel(r.media)) + '</td>' : '') + PG.map(c => pgCell(r, c, i)).join('') + '<td class="c-ctr">' + (!r.key || r.source === 'dashboard' ? '<button class="linkbtn" type="button" data-del="' + i + '" title="この行を削除">削除</button>' : '') + '</td></tr>').join('')
        + '</tbody></table></div>' + (rows.length > shown.length ? '<div class="row" style="justify-content:center; margin-top:10px"><button class="btn" type="button" id="pg-more">さらに100件表示（残り' + (rows.length - shown.length) + '件）</button></div>' : '')
        + (rows.length ? '' : '<p class="empty">該当する記事はありません</p>');
      const more = $('pg-more'); if (more) more.onclick = () => { f.limit = (f.limit || 100) + 100; draw(); };
      document.querySelectorAll('#pg-table [data-pgsort]').forEach(th => th.onclick = () => { const k = th.dataset.pgsort, cur = state.pgSort || {}; state.pgSort = cur.k !== k ? { k, dir: 'asc' } : cur.dir === 'asc' ? { k, dir: 'desc' } : null; save(); draw(); });
      document.querySelectorAll('#pg-table [data-k]').forEach(el => el.onchange = () => saveCell(rows[Number(el.dataset.i)], el));
      document.querySelectorAll('#pg-table [data-tags]').forEach(b => b.onclick = () => openTagPicker(rows[Number(b.dataset.tags)], b));
      document.querySelectorAll('#pg-table [data-olpick]').forEach(b => b.onclick = () => openOutlineChooser(rows[Number(b.dataset.olpick)], b));   /* 構成シート（2026-11-12） */
      /* コピペ率（CCD）：画面で入れた%を保存して、ボタンの表示を変える（2026-11-05 ユーザー指定） */
      const ccdClick = function () { const b = this, td = b.parentNode, i = Number(b.dataset.ccd), r = rows[i], el = td.querySelector('[data-k="copy_rate"]');
        openCcdModal(r, async v => { el.value = v; await saveCell(r, el); const nb = td.querySelector('[data-ccd]'); nb.outerHTML = ccdBtn(r.copy_rate, i); td.querySelector('[data-ccd]').onclick = ccdClick; }); };
      document.querySelectorAll('#pg-table [data-ccd]').forEach(b => b.onclick = ccdClick);
      document.querySelectorAll('#pg-table [data-del]').forEach(el => el.onclick = () => delRow(rows[Number(el.dataset.del)], el));
      document.querySelectorAll('#pg-table [data-pick]').forEach(el => el.onchange = () => { const r = rows[Number(el.dataset.pick)]; if (el.checked) picked.add(r); else picked.delete(r); el.closest('tr').classList.toggle('picked', el.checked); syncBulk(); });
      if (bulkOK) $('pg-all').onchange = ev => { shown.filter(r => r.key).forEach(r => { if (ev.target.checked) picked.add(r); else picked.delete(r); }); draw(); };
      syncBulk();
    };
    /** 一括操作のバー：選んだ件数と、全選択のチェック */
    const syncBulk = () => {
      const n = picked.size, bar = $('pg-bulk');
      if (!bar) return;
      bar.hidden = !n; $('pg-bulk-n').textContent = n + '件を選択中';
      const all = $('pg-all'), vis = rows.slice(0, f.limit || 100).filter(r => r.key);
      if (all) { all.checked = vis.length > 0 && vis.every(r => picked.has(r)); all.indeterminate = !all.checked && vis.some(r => picked.has(r)); }
      $('pg-bulk-go').disabled = !n || !$('pg-bulk-op').value || ($('pg-bulk-op').value !== 'delete' && !$('pg-bulk-v'));
    };
    /** 一括変更の値を選ぶ欄 */
    const bulkInput = k => {
      const c = PG_COLS.find(x => x.k === k); if (!c) return '';
      const sel = list => '<select id="pg-bulk-v"><option value="" selected disabled hidden>選択</option>' + list.map(o => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') + '</select>';
      if (c.kind === 'status') return sel(statusOptsFor(media));
      if (c.kind === 'type') return sel(TYPE_OPTIONS);
      if (c.kind === 'sel') return sel(c.opts);
      if (c.kind === 'sup') return sel(['あり', 'なし']);
      if (c.kind === 'person') return PEOPLE.some(p => p.media === media) ? sel(peopleFor(media, c.k)) : '<input id="pg-bulk-v" list="pg-people" placeholder="名前">';
      if (c.kind === 'date') return '<input type="date" id="pg-bulk-v">';
      if (c.kind === 'month') return '<input type="month" id="pg-bulk-v">';
      if (c.kind === 'opt') return '<select id="pg-bulk-v"><option value="">未選択にする</option>' + optNames(c.src, media).map(o => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') + '</select>';
      return '';
    };
    /** 選んだ行に順番に保存（同時に5件まで） */
    const runEach = async (list, fn) => { const q = list.slice(); let ng = 0; await Promise.all(Array.from({ length: Math.min(5, q.length) }, async () => { while (q.length) { const r = q.shift(); try { await fn(r); } catch (e) { ng++; } } })); return ng; };
    async function applyBulk() {
      const op = $('pg-bulk-op').value, list = [...picked];
      if (!op || !list.length) return;
      if (op === 'delete') {
        if (!confirm(list.length + '件のKW（行）を削除します。よろしいですか？\n（スプレッドシートから取り込んだ記事はダッシュボードに表示しなくなるだけで、シートは変わりません）')) return;
        msg('削除しています…');
        const ng = await runEach(list, async r => {
          if (r.source === 'dashboard') await apiSend('DELETE', '/article-items', { key: r.key });
          else await apiSend('PATCH', '/article-items', { key: r.key, fields: { deleted: '1' } });
          ITEMS = ITEMS.filter(x => x !== r); rows = rows.filter(x => x !== r); picked.delete(r);
        });
        draw(); msg((list.length - ng) + '件を削除しました' + (ng ? '（' + ng + '件は削除できませんでした）' : ''), !!ng); return;
      }
      const el = $('pg-bulk-v'), val = el ? el.value.trim() : '';
      const c = PG_COLS.find(x => x.k === op);
      if (!c || (!val && c.kind !== 'opt')) return msg('変更する値を選んでください', true);
      if ((op === 'outline_url' || op === 'writing_url') && val && !DOC_URL.test(val) && !(op === 'outline_url' && isOutlineUrl(val))) return msg('GoogleスプレッドシートかGoogleドキュメントのURLを入力してください', true);
      // 進行状況は、足りない項目がある行は変えない
      const skip = [], ok = list.filter(r => {
        if (op === 'status') { const miss = statusesFor(r).includes(val) ? missingFor(r, val) : ['この記事では選べない進行状況']; if (miss.length) { skip.push((r.kw || r.no || '（KWなし）') + '：' + miss.join('・')); return false; } }
        return true;
      });
      msg('保存しています…');
      const ng = await runEach(ok, async r => { const sres = await apiSend('PATCH', '/article-items', { key: r.key, fields: { [op]: val } }); r[op] = val === '' ? null : val; charsFromRes(r, sres, null, true); if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } });
      picked.clear(); draw();
      msg(c.h + 'を' + (ok.length - ng) + '件変更しました' + (ng ? '（' + ng + '件は保存できませんでした）' : '') + (skip.length ? '（' + skip.length + '件は変更していません）' : ''), !!(ng || skip.length));
      if (skip.length) showInputError(skip.length + '件は「' + val + '」にしていません', skip.slice(0, 15).concat(skip.length > 15 ? ['ほか' + (skip.length - 15) + '件'] : []), '足りない項目を入力してから、もう一度選んでください。');
    }
    const msg = (t, bad) => { $('pg-msg').textContent = t; $('pg-msg').style.color = bad ? 'var(--bad)' : ''; };
    async function saveCell(r, el) {
      const k = el.dataset.k, td = el.closest('td'); let v = el.value.trim();
      if ((k === 'outline_url' || k === 'writing_url') && v && !DOC_URL.test(v) && !(k === 'outline_url' && isOutlineUrl(v))) { el.value = r[k] || ''; return showInputError('URLを保存できません', ['GoogleスプレッドシートかGoogleドキュメントのURL（https://docs.google.com/…）を入力してください']); }
      if (k === 'kw' && (r._rewrite || (/リライト/.test(r.type || '') && r.source === 'dashboard'))) {
        const src = rewriteSource(media, v, r);
        if (!src) { el.value = r.kw || ''; return showInputError((r.type || 'リライト') + 'KWを保存できません', ['「' + v + '」と完全に一致するKWの記事が、' + mediaLabel(media) + 'にありません。', 'リライトは、過去に新規で作った記事と同じKWで入力してください（スペースの位置なども同じにしてください）。'], 'KWを確認して、もう一度入力してください。'); }
        if (!r.key) { Object.assign(r, { no: src.no || null, url: src.url || null, vol_avg: src.vol_avg, vol_src: src.vol_src, vol_ym: src.vol_ym, title: src.title }); r.kw = v; }
      }
      // 新規の記事は No. が必須（2026-10-10 ユーザー指定）
      const isNew = r.type === '新規' && !r._rewrite;
      if (isNew && k === 'no' && !v && (r.key || r.kw)) { el.value = r.no || ''; return showInputError('No.を空欄にできません', ['新規の記事は No. の入力が必須です。'], 'No.を入力してください。'); }
      if (isNew && !r.key && k !== 'no' && !r.no && (k === 'kw' ? v : r.kw)) {
        r[k] = v === '' ? null : v;
        const noEl = el.closest('tr').querySelector('[data-k="no"]'); if (noEl) noEl.classList.add('need-no');
        return showInputError('まだ保存されていません', ['新規の記事は No. の入力が必須です。'], 'この行の No. を入力すると保存されます。');
      }
      if (k === 'no' && v) el.classList.remove('need-no');
      /* 執筆担当を入れたら、アップロード目標月も必須（ディレクション担当でも。2026-11-04 ユーザー指定）：目標月を入れたときに2つまとめて保存 */
      const tmEl = el.closest('tr').querySelector('[data-k="target_ym"]');
      if (k === 'writer' && v && !r.target_ym) { r._pendWriter = v; if (tmEl) { tmEl.classList.add('need-no'); tmEl.focus(); } return showInputError('まだ保存されていません', ['執筆担当を入れたら、アップロード目標月も必須です。'], 'この行のアップロード目標月を選ぶと保存されます。'); }
      if (k === 'target_ym' && !v && (r._pendWriter || r.writer)) { el.value = r.target_ym || ''; return showInputError('アップロード目標月を空にできません', ['執筆担当が入っている記事は、アップロード目標月が必須です。']); }
      if (k === 'target_ym' && v && tmEl) tmEl.classList.remove('need-no');
      if (k === 'related_kw') { v = relKwList(v).join('\n'); el.value = v; }   // 関連KWは1行に1つ
      if (!r.key && r._rewrite && k !== 'kw' && !r.kw) { el.value = r[k] || ''; return msg('先に検索KWを入れてください（過去の記事と同じKW）', true); }
      if (k === 'status') { const miss = missingFor(r, v); if (miss.length) { el.value = r.status || ''; return showInputError('「' + v + '」にできません', miss.map(x => x + (/^ガイドライン確認/.test(x) ? 'が終わっていません（「ガイドライン確認」ボタンから）' : 'が入力されていません'))); } }
      if (k === 'supervision') { r.supervision = v || null; el.className = supOf(r) === 'あり' ? 'sup-yes' : ''; const kwEl = el.closest('tr').querySelector('[data-k="kw"]'); if (kwEl) kwEl.classList.toggle('kw-sup', supOf(r) === 'あり'); const s2 = el.closest('tr').querySelector('[data-k="status"]'); if (s2) { const cur = s2.value; s2.innerHTML = (cur ? '' : '<option value="" selected disabled hidden>選択</option>') + statusesFor(r).map(o => '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>').join(''); } }
      if (el.dataset.k && PG_COLS.find(c => c.k === el.dataset.k && (c.kind === 'opt' || c.kind === 'sel'))) el.classList.toggle('unsel', !v);
      if (k === 'status') { el.className = 'ph-' + phaseCls(v); const tr = el.closest('tr'); tr.className = tr.className.replace(/ph-row-\w+/, 'ph-row-' + phaseCls(v)); }
      td.className = td.className.replace(/ ?(saving|saved|failed)/g, '') + ' saving';
      try {
        if (r.key) {
          const fx = { [k]: v }; if (k === 'target_ym' && r._pendWriter) fx.writer = r._pendWriter;
          const sres = await apiSend('PATCH', '/article-items', { key: r.key, fields: fx });
          r[k] = v === '' ? null : (k === 'chars' || k === 'image_count' ? Number(v) : v);
          charsFromRes(r, sres, el.closest('tr'));
          if (fx.writer) { r.writer = fx.writer; delete r._pendWriter; }
          if (k === 'url' || k === 'writing_url') { const cc = el.closest('tr').querySelector('[data-copycell="' + k + '"]'); if (cc) cc.innerHTML = copyCell(v); const tr = el.closest('tr'); setTimeout(async () => { if (k === 'writing_url' && v && /^https:\/\/docs\.google\.com\/document\//.test(v.trim())) await fillChars(r, tr, v); if (v && !(COPY[v.trim()] && COPY[v.trim()].status === 'done')) runCopy(v); }, 0); }   // 記事URLを入れたらコピペチェック（2026-10-28 ユーザー指定）
          if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); }
        } else {
          r[k] = v === '' ? null : v;
          if (!r.kw && !r.url) { td.className = td.className.replace(' saving', ''); return msg('検索KWか記事URLを入れると保存されます'); }
          if (r._pendWriter && k === 'target_ym') { r.writer = r._pendWriter; delete r._pendWriter; }
          if (r.writer && !r.target_ym) { td.className = td.className.replace(' saving', ''); return msg('アップロード目標月を入れると保存されます'); }
          const body = { media }; if (r.sub) body.sub = r.sub; PG_COLS.forEach(c => { if (c.kind !== 'ro' && c.kind !== 'vol' && c.kind !== 'copy' && r[c.k] != null) body[c.k] = r[c.k]; });
          const res = await apiSend('POST', '/article-items', body);
          Object.assign(r, { key: res.key, source: 'dashboard', media, editedBy: me.email }); delete r._rewrite; ITEMS.push(r);
          ['url', 'writing_url'].filter(f => r[f]).slice(0, 1).forEach(f => { const cc = el.closest('tr').querySelector('[data-copycell="' + f + '"]'); if (cc) cc.innerHTML = copyCell(r[f]); if (!(COPY[r[f].trim()] && COPY[r[f].trim()].status === 'done')) setTimeout(() => runCopy(r[f]), 0); });   // 記事URLを入れたらコピペチェック
          el.closest('tr').classList.remove('pending');
          if (/リライト/.test(r.type || '')) { draw(); msg(r.type + 'KWを追加しました（No.・記事URLは元の記事から入れました）'); return; }
        }
        if (k === 'outline_url' || k === 'writing_url' || k === 'url') { const cell = td.querySelector('.doc-cell'); const a0 = cell.querySelector('a'); if (a0) a0.remove(); if (v) cell.insertAdjacentHTML('beforeend', '<a href="' + escUrl(v) + '" target="_blank" rel="noopener">開く</a>'); }
        td.className = td.className.replace(' saving', ' saved'); msg('保存しました（' + new Date().toTimeString().slice(0, 5) + '）');
        setTimeout(() => { td.className = td.className.replace(' saved', ''); }, 1500);
      } catch (e) {
        td.className = td.className.replace(' saving', ' failed'); msg('保存できませんでした：' + e.message, true);
        /* 文字数がドキュメントの文字数を超えたら、元の値に戻してエラーを出す（2026-11-12 ユーザー指定） */
        if (k === 'chars') { el.value = r.chars == null ? '' : r.chars; showInputError('文字数を保存できません', [e.message], '文字数を直して、もう一度入力してください。'); }
      }
    }
    async function delRow(r, el) {
      if (r.key && el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'もう一度押すと削除'; return; }
      try {
        if (r.key) { await apiSend('DELETE', '/article-items', { key: r.key }); ITEMS = ITEMS.filter(x => x !== r); }
        rows = rows.filter(x => x !== r); draw(); msg('削除しました');
      } catch (e) { msg('削除できませんでした：' + e.message, true); }
    }
    // WordPressで公開された新規記事が進行管理より多いとき：シートの更新をお願いするアラート
    api('/article-gaps').then(gs => { const g = gs.filter(x => (media === ALL || x.media === media) && (!state.artSub || !x.sub || x.sub === state.artSub)), el = $('pg-alert');   /* ディレクトリごと（2026-10-28 ユーザー指定） */ if (!el || !g.length) return; /* メディア名を出して、1件ずつ改行（2026-10-26 ユーザー指定） */
      el.innerHTML = '⚠ WordPressで公開された新規記事が、進行管理より多くなっています。記事管理シート（アップロード日・制作判断）を更新してください。' + g.slice().sort((a, b) => mediaLabel(a.media).localeCompare(mediaLabel(b.media), 'ja') || b.ym.localeCompare(a.ym)).map(x => '<br>・' + esc(mediaLabel(x.media) + (x.sub ? '／' + x.sub : '')) + '　' + mLabel(x.ym) + '：WordPress <b>' + x.wp + '本</b>、進行管理 <b>' + x.posts + '本</b>（' + (x.wp - x.posts) + '本不足）').join(''); el.hidden = false; }).catch(() => {});
    $('pg-body').innerHTML = '<div class="art-alert" id="pg-alert" hidden></div>' + H('進行管理 <small>' + esc(mediaLabel(media)) + '</small>' + stoppedNote(media), ['記事管理'], manualBtn('director')) + head + '<datalist id="pg-people">' + people.map(p => '<option value="' + esc(p) + '">').join('') + '</datalist><div id="pg-table"></div>'
      + '<p class="note">スプレッドシートには書き込みません。ここで変えた項目は、シートを取り込み直してもダッシュボードの値が優先されます。検索VolはAhrefsの直近12か月平均を自動表示します（入力・修正はできません。* はまだ取得していないKWで、シートの値）。削除できるのは、ここで追加した行だけです。</p>';
    bindFilters('p-', media, () => { f.limit = 100; draw(); });
    if (bulkOK) $('pg-bulk-op').onchange = () => { $('pg-bulk-val').innerHTML = bulkInput($('pg-bulk-op').value); const v0 = $('pg-bulk-v'); if (v0) v0.oninput = v0.onchange = syncBulk; syncBulk(); };
    if (bulkOK) $('pg-bulk-go').onclick = () => { $('pg-bulk-go').disabled = true; applyBulk().finally(syncBulk); };
    if (bulkOK) $('pg-bulk-clear').onclick = () => { picked.clear(); draw(); };
    const addRow = row => { if (state.artSub && artSubs(media)) row.sub = state.artSub;
      if (me.perms.own && !row.writer) row.writer = (me.personNames || [])[0] || me.name;   /* 担当だけの人が追加したKWは自分の担当 */ rows.unshift(row); draw(); const first = document.querySelector('#pg-table [data-k="kw"]'); if (first) first.focus(); };
    $('pg-add').onclick = () => { addRow({ media, status: '未着手', type: '新規' }); msg('新規の記事は No. と検索KWを入れると保存されます（No. は入力必須です）'); };
    const addRewrite = type => { addRow({ media, status: '未着手', type, _rewrite: true }); msg(type + 'するKWを、過去の記事と同じ表記で入力してください（No.・検索Vol・記事URLは過去の記事から入ります）'); };
    $('pg-add-rw').onclick = () => addRewrite('リライト');
    $('pg-add-lite').onclick = () => addRewrite('簡易リライト');
    draw();
  } };
}

/** 担当者の名前をそろえる：記事管理に書かれた名前（苗字だけ・旧姓など）→ 担当者の紐づけで決めた人の名前（2026-10-27 ユーザー指定）。
 *  担当なし（ー・不要など）は「担当なし」。紐づけない・未設定はそのまま */
let PERSON_NAMES = null;
async function loadPersonNames() { if (PERSON_NAMES) return PERSON_NAMES; try { PERSON_NAMES = (await api('/person-names')).list || []; } catch (e) { PERSON_NAMES = []; } return PERSON_NAMES; }
const personName = (alias, media) => { const a = String(alias || '').trim(); if (!a || !PERSON_NAMES) return a; const l = PERSON_NAMES.find(x => x.alias === a && x.media === media) || PERSON_NAMES.find(x => x.alias === a && !x.media); return !l ? a : l.action === 'none' ? '担当なし' : l.action === 'link' && l.name ? l.name : a; };
/** 担当別の表の行：紐づけた人ごとにまとめる。元の書き方（別名）も返す */
const groupByPerson = (rows, field) => { const g = {}; rows.forEach(r => { const a = String(r[field] || '').trim(); if (!a) return; const n = personName(a, r.media); (g[n] = g[n] || { name: n, aliases: new Set(), rows: [] }).rows.push(r); g[n].aliases.add(a); }); return Object.values(g); };
const personCell = x => esc(x.name);   /* 紐づけ前の書き方は出さない（2026-10-27 ユーザー指定） */

/** 制作状況：記事進捗（目標と実績）→ 進行状況・担当別 → 記事一覧 を1つの画面に（2026-10-27 ユーザー指定） */
function viewProduction() {
  const a = viewArticles(), b = viewAmStatus(), c = viewAmList();
  const grp = (id, t, note) => '<section class="prod-grp" id="' + id + '"><h2 class="prod-h">' + t + (note ? ' <small>' + note + '</small>' : '') + '</h2></section>';
  return { html: grp('pg-now', '今月の進捗') + grp('pg-half', '半期進捗') + grp('pg-year', '年間累計', '<select id="pg-type" aria-label="種類">' + ART_TYPES.map(([k, l]) => '<option value="' + k + '"' + (k === (state.artType || 'total') ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>') + grp('pg-list', '公開記事一覧') + '<div id="prod-src">' + a.html + b.html + c.html + '</div>', view: '制作状況', after: async () => {
    // 部品をまとまりごとに並べ替えてから中身を作る（中身は id で書き込むので、場所を動かしても同じ）
    const mv = (gid, ...els) => els.forEach(el => { if (el) $(gid).appendChild(el); });
    const fyPanel = $('c-fy') ? $('c-fy').closest('.panel') : null, gridOf = el => el ? el.closest('.grid2') : null;
    const wm = gridOf($('as-writer'));
    mv('pg-now', $('ar-now'), $('as-media'), $('as-writer'));
    mv('pg-half', $('ar-half'), $('ar-hist'), $('as-half'));
    mv('pg-year', $('as-month'), $('ar-map'), fyPanel);
    $('pg-type').onchange = ev => { state.artType = ev.target.value; render(); };
    mv('pg-list', $('am-perf'), $('am-filter'), $('am-body'));
    [gridOf($('ar-hist')), wm].forEach(g => { if (g && !g.children.length) g.remove(); });
    ['as-writer', 'as-month', 'ar-hist'].forEach(k => { if ($(k)) $(k).classList.add('panel'); });
    if ($('prod-src')) { $('prod-src').querySelectorAll('.grid2').forEach(g => { if (!g.children.length) g.remove(); }); if (!$('prod-src').children.length) $('prod-src').remove(); }
    const mySeq = renderSeq;
    await a.after(); if (mySeq !== renderSeq) return; await b.after(); if (mySeq !== renderSeq) return; await c.after(); if (mySeq !== renderSeq) return;
    if ($('am-perf')) $('am-perf').hidden = true;   // 過去3か月の目標と成果は、上の記事進捗と同じなので出さない
    ['as-media', 'as-writer'].forEach(k => { if ($(k)) $(k).remove(); });   // 今月の進捗の「進行状況」「執筆担当別」はわかりにくいので出さない（2026-10-27 ユーザー指定）
  } };
}
/** 記事管理：制作状況（選んでいるメディア） */
function viewAmStatus() {
  return { html: '<section class="panel" id="as-media"><p class="loading">読み込み中…</p></section><section class="panel" id="as-half"></section><section class="grid2 even"><div class="panel" id="as-writer"></div><div class="panel" id="as-month"></div></section>', view: '記事管理：制作状況', after: async () => {
    const mySeq = renderSeq;
    await loadItems(); await loadPersonNames(); await loadPastBy();
    if (mySeq !== renderSeq) return;   /* 読み込み中に別の画面に切り替わった（2026-11-04） */
    const media = artMedia(); renderArtMediaSelect();
    const allRows = ITEMS.filter(r => inArt(r, media));
    if (!allRows.length) { $('as-media').innerHTML = H('制作状況', ['記事管理']) + noItems(media); $('as-writer').parentNode.hidden = true; return; }
    const mSel = state.asMonth || CUR_MONTH, inM = d => String(d || '').startsWith(mSel);
    const rows = allRows.filter(r => inM(r.upload_date) || inM(r.request_date) || (mSel === CUR_MONTH && r.status && r.status !== '未着手' && !isDone(r.status)));
    const monthSel = '<label class="field" style="flex-direction:row; align-items:center; gap:6px">月<input type="month" id="as-ym" value="' + mSel + '" max="' + CUR_MONTH + '"></label>';
    const sts = statusOptsFor(media).concat([...new Set(rows.map(r => r.status).filter(x => x && !STATUS_ORDER.includes(x)))]);
    const count = (rs, k, v) => rs.filter(r => r[k] === v).length;
    $('as-media').innerHTML = H('進行状況 <small>' + esc(mediaLabel(media)) + '・' + mLabel(mSel) + '：この月に依頼・アップロードした記事' + (mSel === CUR_MONTH ? 'と作業中の記事' : '') + '</small>' + stoppedNote(media), ['記事管理'], monthSel) + statusChips(rows)
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">最新対応</th>' + sts.map(x => '<th class="c-num">' + esc(x) + '</th>').join('') + '<th class="c-num">合計</th></tr></thead><tbody>'
      + [...new Set(rows.map(r => r.type || '（空欄）'))].sort((a, b) => { const o = t => ['新規', 'リライト(新規)', '簡易リライト', 'リライト'].indexOf(t) >= 0 ? ['新規', 'リライト(新規)', '簡易リライト', 'リライト'].indexOf(t) : t === '（空欄）' ? 99 : 50; return o(a) - o(b); }).map(ty =>   /* 新規・簡易リライト・リライトの順、空欄はいちばん下（2026-10-27 ユーザー指定） */ { const rs = rows.filter(r => (r.type || '（空欄）') === ty); return '<tr><td class="c-txt">' + esc(ty) + '</td>' + sts.map(x => '<td class="c-num">' + count(rs, 'status', x) + '</td>').join('') + '<td class="c-num"><b>' + rs.length + '</b></td></tr>'; }).join('')
      + '</tbody></table></div>';
    if (isSupMedia(media)) {
      const sups = groupByPerson(rows, 'supervisor');
      $('as-media').insertAdjacentHTML('beforeend', '<h3 class="am-h">監修あり／なし</h3><div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">監修有無</th>' + sts.map(x => '<th class="c-num">' + esc(x) + '</th>').join('') + '<th class="c-num">合計</th></tr></thead><tbody>'
        + ['あり', 'なし', ''].map(v => { const rs = rows.filter(r => supOf(r) === v); return rs.length ? '<tr><td class="c-txt">' + (v || '未設定') + '</td>' + sts.map(x => '<td class="c-num">' + count(rs, 'status', x) + '</td>').join('') + '<td class="c-num"><b>' + rs.length + '</b></td></tr>' : ''; }).join('') + '</tbody></table></div>'
        + '<h3 class="am-h">監修担当別 <span class="note">監修者確認中＝構成監修者確認・記事監修者確認</span></h3><div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">監修担当</th><th class="c-num">監修者確認中</th><th class="c-num">完了</th><th class="c-num">合計</th></tr></thead><tbody>'
        + (sups.length ? sups.map(w => { const rs = w.rows; return '<tr><td class="c-txt">' + personCell(w) + '</td><td class="c-num"><b>' + rs.filter(r => SUP_STATUSES.includes(r.status)).length + '</b></td><td class="c-num">' + count(rs, 'status', '完了') + '</td><td class="c-num">' + rs.length + '</td></tr>'; }).join('') : '<tr><td class="c-txt" colspan="4"><span class="note">監修担当が入った記事はまだありません</span></td></tr>') + '</tbody></table></div>');
    }
    const writers = groupByPerson(rows, 'writer');
    $('as-writer').innerHTML = H('執筆担当別 <small>' + mLabel(mSel) + '・進行中＝完了以外</small>', ['記事管理']) + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">執筆担当</th><th class="c-num">進行中</th><th class="c-num">完了</th></tr></thead><tbody>'
      + writers.map(w => { const rs = w.rows; return { w, doing: rs.filter(r => !isDone(r.status)).length, done: rs.filter(r => isDone(r.status)).length, all: rs.length }; }).sort((a, b) => b.doing - a.doing || b.all - a.all)
        .map(x => '<tr><td class="c-txt">' + personCell(x.w) + '</td><td class="c-num"><b>' + x.doing + '</b></td><td class="c-num">' + x.done + '</td></tr>')   /* 合計の列はなし（2026-10-27 ユーザー指定） */.join('') + '</tbody></table></div>';
    drawWorkHalf(allRows, media);
    $('as-ym').onchange = ev => { if (ev.target.value) { state.asMonth = ev.target.value; render(); } };
    // 月別アップロード数：年間累計・達成率マップと同じ年度（5月〜翌4月）・同じ種類（2026-10-27 ユーザー指定）
    const ty = state.artType || 'total', tyL = (ART_TYPES.find(x => x[0] === ty) || [, ''])[1], months = fyMonths(fyOf(CUR_MONTH)).filter(m => m <= CUR_MONTH);
    const upIn = (mm, re) => allRows.filter(r => (r.upload_date || '').startsWith(mm) && r.upload_date <= todayJst() && re(r.type || '')).length;
    const DS = { new: ['新規', t => /新規/.test(t) || !t, '--wp-ink'], rewrite: ['リライト', t => /^リライト/.test(t), '--wp-soft'], lite: ['簡易リライト', t => /簡易リライト/.test(t), '--s3'] };
    $('as-month').innerHTML = H('月別アップロード数 <small>' + fyOf(CUR_MONTH) + '年度・' + esc(tyL.replace('（新規＋リライト＋簡易リライト）', '')) + '・アップロード日</small>', ['記事管理']) + '<div class="chart-box sm"><canvas id="c-am"></canvas></div>'
      + (ty === 'tweak' ? '<p class="note">微調整は WordPress で更新された記事から数えます（進行管理のリライト・簡易リライトを除いた本数）。</p>' : '');
    const sets = ty === 'tweak' ? [{ label: '微調整', data: months.map(mm => actualOf(state.media, mm, 'tweak') || 0), backgroundColor: css('--s4'), stack: 'a' }]
      : (ty === 'total' ? ['new', 'rewrite', 'lite'] : [ty]).map(k => ({ label: DS[k][0], data: months.map(mm => upIn(mm, DS[k][1])), backgroundColor: css(DS[k][2]), stack: 'a' }));
    chart('c-am', { type: 'bar', data: { labels: months.map(mShort), datasets: sets }, options: baseOpts({ scales: stackScales() }) });
  } };
}

/** 半期の担当実績：担当（紐づけた人でまとめる）× カテゴリ（ディレクトリ）× 月。セルは新規・リライト・簡易リライトの本数 */
const WH_ROLES = [['writer', '執筆'], ['director', 'ディレクション'], ['supervisor', '監修'], ['upload_owner', 'アップロード']];
function drawWorkHalf(rows, media) {
  const today = todayJst(), counted = rows.filter(r => r.upload_date && r.upload_date <= today && !MIGRATE_STATUSES.includes(r.status) && !IMPORT_STATUSES.includes(r.status));   // 先の日付・移管は数えない
  const cur = halfOf(CUR_MONTH).start, first = counted.length ? halfOf(counted.map(r => r.upload_date.slice(0, 7)).sort()[0]).start : cur, halves = [];
  for (let h = cur; h >= first; h = shiftMonth(h, -6)) halves.push(h);
  const start = state.whHalf && halves.includes(state.whHalf) ? state.whHalf : cur, role = state.whRole || 'writer', ms = Array.from({ length: 6 }, (_, i) => shiftMonth(start, i));
  const inHalf = counted.filter(r => ms.includes(r.upload_date.slice(0, 7))), tyOf = r => /簡易リライト/.test(r.type) ? '簡易リライト' : /リライト/.test(r.type) ? 'リライト' : '新規';
  const cell = rs => { if (!rs.length) return '<span class="note">—</span>'; const c = {}; rs.forEach(r => { c[tyOf(r)] = (c[tyOf(r)] || 0) + 1; }); return ['新規', 'リライト', '簡易リライト'].filter(t => c[t]).map(t => '<span class="wh-' + (t === '新規' ? 'n' : t === 'リライト' ? 'r' : 'l') + '">' + t + ' <b>' + c[t] + '</b></span>').join('<br>'); };
  const catOf = r => (media === ALL ? mediaLabel(r.media) + '／' : '') + (r.sub || '（ディレクトリなし）');
  const people = groupByPerson(inHalf, role).map(g => Object.assign(g, { total: g.rows.length })).sort((a, b) => b.total - a.total);
  const none = inHalf.filter(r => !String(r[role] || '').trim());
  if (none.length) people.push({ name: '（担当の記入なし）', aliases: new Set(), rows: none, total: none.length });
  $('as-half').innerHTML = H('半期の担当実績 <small>アップロード日の月で数える（先の日付・移管は数えない。最新対応が空欄は新規）</small>', ['記事管理'])
    + '<div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px"><label class="field">半期<select id="wh-half">' + halves.map(h => '<option value="' + h + '"' + (h === start ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label>'
    + '<label class="field">担当<select id="wh-role">' + WH_ROLES.map(([k, l]) => '<option value="' + k + '"' + (k === role ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label></div>'
    + (people.length ? '<div class="table-wrap"><table class="am-table wh-table"><thead><tr><th class="c-txt">担当者</th><th class="c-txt">カテゴリ</th>' + ms.map(m => '<th class="c-txt">' + mLabel(m) + '</th>').join('') + '<th class="c-txt">半期の合計</th></tr></thead><tbody>'
      + people.map(g => { const cats = [...new Set(g.rows.map(catOf))].sort();
        return cats.map((c, i) => { const rs = g.rows.filter(r => catOf(r) === c);
          return '<tr' + (i === 0 ? ' class="wh-first"' : '') + '>' + (i === 0 ? '<td class="c-txt" rowspan="' + (cats.length + (cats.length > 1 ? 1 : 0)) + '"><b>' + personCell(g) + '</b></td>' : '') + '<td class="c-txt">' + esc(c) + '</td>' + ms.map(m => '<td class="c-txt">' + cell(rs.filter(r => r.upload_date.startsWith(m))) + '</td>').join('') + '<td class="c-txt">' + cell(rs) + '</td></tr>'; }).join('')
          + (cats.length > 1 ? '<tr class="wh-sum"><td class="c-txt">計</td>' + ms.map(m => '<td class="c-txt">' + cell(g.rows.filter(r => r.upload_date.startsWith(m))) + '</td>').join('') + '<td class="c-txt">' + cell(g.rows) + '</td></tr>' : ''); }).join('')
      + '</tbody></table></div>' : '<p class="empty">この半期にアップロードした記事はありません。</p>');
  $('wh-half').onchange = ev => { state.whHalf = ev.target.value; drawWorkHalf(rows, media); };
  $('wh-role').onchange = ev => { state.whRole = ev.target.value; drawWorkHalf(rows, media); };
}

// ================= 契約管理（2026-10-14 ユーザー指定で作り直し：1契約に複数メディア・ディレクトリ、報酬の内訳、変更履歴、書面） =================
let CONTRACTS = null;
async function loadContracts() {
  if (CONTRACTS && !!CONTRACTS._exp !== expFull()) CONTRACTS = null;   /* 支出情報（全員分）とほかの画面で分ける */
  if (!CONTRACTS) { CONTRACTS = await api('/contracts'); CONTRACTS._exp = expFull();
    /* 同じ人の契約がメディアごとに分かれているとき（徳良さん：BEST365 と屋根外壁お助け）は、それぞれの契約でその担当メディアの記事だけ数える（2026-10-30） */
    { const cnt = {}; CONTRACTS.contracts.forEach(c => { const k = String(c.name || '').replace(/[s　]/g, ''); cnt[k] = (cnt[k] || 0) + 1; }); CONTRACTS.contracts.forEach(c => { c._multi = cnt[String(c.name || '').replace(/[s　]/g, '')] > 1; }); }
    CONTRACTS.contracts.forEach(c => { c.category = c.category || (c.position === 'サイト作成・修正' ? 'site' : c.position === '監修者' ? 'supervision' : c.position === 'ライター' ? 'writing' : 'direction'); }); }
  return CONTRACTS;
}
const CAT_LABEL = { direction: 'ディレクション', writing: 'ライティング', supervision: '監修', site: 'サイト作成・修正' };
const rolesOf = pos => Object.entries(ROLE_POSITIONS).filter(([, ps]) => ps.includes(pos)).map(([k]) => ({ director: 'ディレクション', writer: '執筆', upload_owner: 'アップロード', supervisor: '監修' })[k]);
const yen0 = v => v == null ? '—' : '¥' + nf.format(Math.round(v));
const PAY_ITEMS = { press: ['プレスリリース', '円/本'], articleNew: ['新規記事', '円/記事'], articleRewrite: ['リライト', '円/記事'], articleLite: ['簡易リライト', '円/記事'], article: ['記事単価', '円/記事'], upload: ['アップロード単価', '円/記事'], char: ['文字単価', '円/字'], image: ['画像作成単価', '円/枚'], hour: ['時間単価', '円/時間'], supervise: ['記事監修（オプション）', '円/記事'] };
const PAY_FIELDS_C = { 記事単価: ['articleNew', 'articleRewrite', 'articleLite', 'upload'], 文字単価: ['char', 'image', 'upload'], 単発発注: [] };   // 単発発注＝継続契約なし（2026-10-14 ユーザー指定）   // 時間単価は記事監修と同じオプション（2026-10-14 ユーザー指定）
const payAmt = (k, v) => v == null || v === '' ? '—' : (k === 'char' ? nf.format(v) + '円/字' : yen0(v) + PAY_ITEMS[k][1].replace('円', ''));
/** 契約内容の短い表示（一覧用） */
function payLabel(c) {
  const p = c.pay || {};
  if (!p.type) return '—';
  const amt = (k, v) => payAmt(k, v).replace('円/字', '円');   /* 一覧では「/字」を付けない（2026-10-29 ユーザー指定） */
  const parts = (PAY_FIELDS_C[p.type] || []).filter(k => p[k] != null).map(k => PAY_ITEMS[k][0].replace('単価', '') + ' ' + amt(k, p[k]));
  if (p.uploadNewOnly && p.upload != null) parts.push('（アップロードは新規だけ）');
  if (p.superviseOn) parts.push('監修 ' + payAmt('supervise', p.supervise));
  if (p.hourOn) parts.push('時間 ' + payAmt('hour', p.hour));
  if (p.press != null && p.press !== '') parts.push('プレスリリース ' + payAmt('press', p.press));
  (p.direction || []).forEach((x, i) => parts.push('ディレクション' + (i + 1) + ' ' + (x.cond || '') + (x.amount != null ? ' ' + yen0(x.amount) : '')));
  if (p.otherOn) parts.push('その他 ' + (p.otherNote || ''));
  return (p.type === '単発発注' ? '単発発注（継続契約なし）' : p.type) + (parts.length ? '：' + parts.join(' ｜ ') : '');   /* 区切りは「｜」（2026-10-29 ユーザー指定） */
}
const subsLabel = c => Object.entries(c.subs || {}).filter(([m]) => (c.medias || []).includes(m)).map(([m, l]) => mediaLabel(m) + '：' + l.join('・')).join('　') || 'すべて';
const onLeave = c => !!c.leaveStart && c.leaveStart <= todayJst() && (!c.leaveEnd || c.leaveEnd > todayJst());   // 復職日が未入力なら休職中
const ctStatus = c => c.status === '契約解除' ? (c.active ? '解除予定' : '契約解除') : onLeave(c) ? '休職中' : c.active ? '契約中' : c.startMonth && c.startMonth > CUR_MONTH ? '開始前' : '期間外';
const POS_GROUPS = [['direction', 'ディレクション', ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター']], ['writing', 'ライティング', ['ライター']], ['other', 'その他', ['監修者', 'サイト作成・修正']]];
const groupPositions = g => (POS_GROUPS.find(x => x[0] === g) || [])[2] || null;
/** 分類（ポジションの左）とポジションの絞り込み。分類を選ぶと、ポジションはその分類のものだけ */
const posFilterHtml = (positions, f) => {
  const gp = groupPositions(f.grp), list = gp ? positions.filter(x => gp.includes(x)) : positions;
  if (f.pos && !list.includes(f.pos)) f.pos = '';
  return '<label class="field">分類<select id="ct-grp-f"><option value="">すべて</option>' + POS_GROUPS.map(([k, l, ps]) => '<option value="' + k + '"' + (k === f.grp ? ' selected' : '') + ' title="' + esc(ps.join('・')) + '">' + esc(l) + '</option>').join('') + '</select></label>'
    + '<label class="field">ポジション<select id="ct-pos-f"><option value="">すべて</option>' + list.map(x => '<option value="' + esc(x) + '"' + (x === f.pos ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>';
};
const posMatch = (pos, f) => (!f.grp || (groupPositions(f.grp) || []).includes(pos)) && (!f.pos || pos === f.pos);
const CT_COLS = [
  { k: 'name', h: '契約者名', v: c => c.name + (c.entity === '企業' && c.company && c.company !== c.name ? '（' + c.company + '）' : '') },
  { k: 'entity', h: '契約形態', v: c => c.entity || '' }, { k: 'position', h: '契約ポジション', v: c => c.position === '監修者' && c.title ? '監修者（' + c.title + '）' : c.position || '' },
  { k: 'medias', h: '担当メディア', v: c => (c.medias || []).map(mediaLabel).join('・') + (c.mediaChanges || []).filter(x => x.from > todayJst().slice(0, 7)).map(x => '（' + mLabel(x.from) + 'から ' + x.medias.map(mediaLabel).join('・') + '）').join('') },   /* 担当変更の予定も出す（2026-11-13） */ { k: 'subs', h: '担当ディレクトリ', v: subsLabel },
  { k: 'pay', h: '契約内容', v: c => payLabel(c) + ((c.pastPays || []).length ? '（以前の契約あり：' + c.pastPays.length + '件）' : '') }, { k: 'startMonth', h: '契約月', v: c => c.startMonth ? mLabel(c.startMonth) : '' },
  { k: 'status', h: '状態', v: ctStatus }, { k: 'route', h: '採用経路', v: c => (c.route || '') + (c.routeNote ? '（' + c.routeNote + '）' : '') },
  { k: 'invoice', h: 'インボイス', v: c => c.invoice ? '登録あり' : '—' },
  { k: 'billingStaffId', h: '請求担当（メイン）', v: c => staffNameOf(c.billingStaffId) }, { k: 'billingSubStaffId', h: '請求担当（サブ）', v: c => staffNameOf(c.billingSubStaffId) },   // BEST社員（2026-10-28 ユーザー指定）
];
let STAFF_NAMES = null;
async function loadStaffNames() { if (!STAFF_NAMES) STAFF_NAMES = (await api('/staff-names').catch(() => ({ staff: [] }))).staff || []; return STAFF_NAMES; }
const staffNameOf = id => (id && STAFF_NAMES && (STAFF_NAMES.find(x => x.id === id) || {}).name) || '—';
function viewContracts() {
  const f = state.ctFilter = state.ctFilter || { sort: 'name', dir: 1, status: 'active' };
  return { html: '<section class="panel" id="ct-body"><p class="loading">読み込み中…</p></section>', view: '契約管理', after: async () => {
    CONTRACTS = null;
    await loadStaffNames();   // 請求担当の名前
    const data = await loadContracts(), medias = topMedia();
    const sel = (id, label, opts, v) => '<label class="field">' + label + '<select id="' + id + '">' + opts.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === (v || '') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    f.media = adminMedia() === ALL ? '' : adminMedia();   // メディアは右上で選ぶ（メディア累計あり）
    $('ct-body').innerHTML = H('契約管理 <small>' + esc(f.media ? mediaLabel(f.media) : 'メディア累計') + '</small>', ['契約管理'])
      + '<div class="row" style="margin-bottom:8px; flex-wrap:wrap">' + posFilterHtml(data.positions, f)
      + sel('ct-status', '状態', [['active', '契約中のみ'], ['leave', '休職中'], ['', 'すべて'], ['ended', '契約解除・期間外']], f.status)
      + '<label class="field">キーワード<input id="ct-q" type="search" value="' + esc(f.q || '') + '" placeholder="契約者名・メモで検索"></label>'
      + (data.canEdit ? '<button class="btn primary" type="button" id="ct-add">＋ 契約を追加</button>' : '') + '</div><div id="ct-table"></div>'
      + '<p class="note">見出しを押すと並べ替えます。「契約書類」で、契約書（PDF）を表示します。契約内容とこれまでの変更（書面）も、そこから開けます。契約書類と書面を見られるのは、管理者・BEST役員・BEST正社員・本人だけです。メールアドレスを入れると、ユーザー管理で業務委託の役割にしたとき、この契約と紐づきます（業務委託の役割は、契約がないと付けられません）。</p>';
    const draw = () => {
      f.pos = $('ct-pos-f').value; f.status = $('ct-status').value; f.q = $('ct-q').value.trim().toLowerCase();
      const col = CT_COLS.find(c => c.k === f.sort) || CT_COLS[0];
      const list = data.contracts.filter(c => (!f.media || (c.medias || []).includes(f.media)) && posMatch(c.position, f) && (f.status === 'active' ? c.active : f.status === 'leave' ? onLeave(c) : f.status === 'ended' ? !c.active : true)
        && (!f.q || [c.name, c.company, c.memo, c.title].some(x => String(x || '').toLowerCase().includes(f.q))))
        .sort((x, y) => f.dir * String(col.v(x)).localeCompare(String(col.v(y)), 'ja', { numeric: true }) || String(x.name).localeCompare(y.name, 'ja'));
      $('ct-table').innerHTML = list.length ? '<div class="table-wrap am-scroll"><table class="am-table ct-list"><thead><tr>' + CT_COLS.map(c => '<th class="c-txt" data-sort="' + c.k + '" style="cursor:pointer; white-space:nowrap">' + c.h + (f.sort === c.k ? (f.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '<th class="c-ctr">操作</th></tr></thead><tbody>'
        // 解除予定は、状態を濃いグレー・行を薄いグレーに（2026-10-26 ユーザー指定）
        + list.map(c => '<tr class="' + (ctStatus(c) === '契約解除' ? 'ct-row-ended' : onLeave(c) ? 'ct-row-leave' : ctStatus(c) === '解除予定' ? 'ct-row-ending' : '') + '">' + CT_COLS.map(col => {
          const v = col.v(c);
          if (col.k === 'status') return '<td class="c-ctr"><span class="pill ' + (onLeave(c) ? 'wait' : ctStatus(c) === '契約解除' ? 'off' : ctStatus(c) === '解除予定' ? 'ending' : c.active ? 'ok' : 'off') + '">' + esc(v) + '</span>' + (c.endDate ? '<br><span class="note">' + esc(c.endDate.replace(/-/g, '/')) + '</span>' : '') + '</td>';
          if (col.k === 'name') return '<td class="c-txt"><b>' + esc(v) + '</b></td>';
          return '<td class="c-txt">' + esc(v) + '</td>';
        }).join('') + '<td class="c-ctr" style="white-space:nowrap">' + (data.canEdit ? '<button class="btn sm" type="button" data-ct="' + esc(c.id) + '">編集</button> ' : '') + '<button class="btn sm' + ((c.files || []).length ? '' : ' no-file') + '" type="button" data-cfile="' + esc(c.id) + '"' + ((c.files || []).length ? '' : ' title="契約書類がまだありません"') + '>契約書類</button></td></tr>'   /* 契約書類がない人はグレー（2026-10-26 ユーザー指定） */).join('') + '</tbody></table></div>'
        : '<p class="empty">該当する契約はありません。' + (data.canEdit ? '「＋ 契約を追加」から登録してください。' : '') + '</p>';
      document.querySelectorAll('#ct-table [data-sort]').forEach(th => th.onclick = () => { if (f.sort === th.dataset.sort) f.dir = -f.dir; else { f.sort = th.dataset.sort; f.dir = 1; } draw(); });
      document.querySelectorAll('#ct-table [data-ct]').forEach(btn => btn.onclick = () => contractModal(data.contracts.find(c => c.id === btn.dataset.ct)));
      document.querySelectorAll('#ct-table [data-cfile]').forEach(btn => btn.onclick = () => openContractFiles(btn.dataset.cfile));
    };
    ['ct-pos-f', 'ct-status'].forEach(id => { $(id).onchange = draw; });
    $('ct-grp-f').onchange = ev => { f.grp = ev.target.value; f.pos = ''; render(); };
    let t; $('ct-q').oninput = () => { clearTimeout(t); t = setTimeout(draw, 200); };
    if ($('ct-add')) $('ct-add').onclick = () => contractModal(null, { medias: f.media ? [f.media] : [], startMonth: CUR_MONTH, entity: '個人', route: '', pay: { type: '記事単価' } });
    draw();
  } };
}
function contractModal(c, init) {
  const d = CONTRACTS, v = c || Object.assign({ status: '契約中' }, init), p = v.pay || { type: '記事単価' };
  const opt = (list, cur) => list.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('');
  const chk = (name, val, on, label) => '<label style="flex-direction:row; align-items:center; gap:4px; color:var(--fg); font-weight:normal"><input type="checkbox" name="' + name + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '>' + esc(label) + '</label>';
  const box = inner => '<div style="display:flex; flex-wrap:wrap; gap:4px 14px; font-size:13px; padding:6px 0">' + inner + '</div>';
  openModal('<h2>' + (c ? '契約を編集' : '契約を追加') + (c && c.status === '契約解除' ? ' <span class="pill off">契約解除</span>' : '') + '</h2><div class="form-grid">'
    + '<label>契約者名<input id="ct-name" value="' + esc(v.name || '') + '"></label>'
    + '<label>メールアドレス<input id="ct-email" type="email" value="' + esc(v.email || '') + '" placeholder="ダッシュボードにログインするメール"></label>'
    + '<label>契約形態<select id="ct-entity">' + opt([['個人', '個人'], ['企業', '企業']], v.entity || '個人') + '</select></label>'
    + '<label id="ct-company-wrap">会社名<input id="ct-company" value="' + esc(v.company || '') + '"></label>'
    + '<label>契約ポジション<select id="ct-pos">' + opt(d.positions.map(x => [x, x]), v.position || 'ライター') + '</select></label>'
    + '<label id="ct-title-wrap">肩書・資格（監修者）<input id="ct-title" value="' + esc(v.title || '') + '" placeholder="例：一級建築士"></label>'
    + '<label>契約月<input id="ct-month" type="month" value="' + esc(v.startMonth || CUR_MONTH) + '"></label>'
    + '<label>採用経路<select id="ct-route">' + opt([['', '選んでください']].concat(d.routes.map(x => [x, x])), v.route || '') + '</select></label>'
    + '<label id="ct-route-note-wrap">採用経路（くわしく）<input id="ct-route-note" value="' + esc(v.routeNote || '') + '" placeholder="紹介者名など"></label>'
    + '<label>状態<select id="ct-status-sel">' + opt([['契約中', '契約中'], ['休職', '休職'], ['契約解除', '契約解除']], v.status === '休職' || (v.leaveStart && !v.leaveEnd) ? '休職' : v.status || '契約中') + '</select></label>'
    + '<label id="ct-end-wrap">契約解除日<input id="ct-end-date" type="date" value="' + esc(v.endDate || '') + '"></label>'
    + '<label id="ct-leave-s-wrap">休職開始日<input id="ct-leave-s" type="date" value="' + esc(v.leaveStart || '') + '"></label><label id="ct-leave-e-wrap">復職日（未入力なら休職中）<input id="ct-leave-e" type="date" value="' + esc(v.leaveEnd || '') + '"></label>'
    + '<label>インボイス番号<input id="ct-invoice" value="' + esc(v.invoice || '') + '" placeholder="T1234567890123（未登録なら空欄）"></label>'
    + ['billingStaffId', 'billingSubStaffId'].map((k, i) => '<label>請求担当（' + (i ? 'サブ' : 'メイン') + '・BEST社員）<select id="ct-billing' + (i ? '-sub' : '') + '"><option value="">未設定</option>' + (STAFF_NAMES || []).filter(x => !x.retired || x.id === v[k]).map(x => '<option value="' + esc(x.id) + '"' + (x.id === v[k] ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label>').join('')
    + '<div class="full"><b style="font-size:13px">担当メディア</b>（複数選べます。その人には担当メディアだけが表示されます）' + box(topMedia().map(m => chk('ct-media', m.media, (v.medias || []).includes(m.media), m.name)).join('')) + '</div>'
    + '<div class="full" id="ct-subs"></div>'
    /* 担当メディアの変更（どの月からどのメディアに担当変更するか）（2026-11-13 ユーザー指定） */
    + '<div class="full"><b style="font-size:13px">担当メディアの変更</b> <span class="note">その月になると、担当メディアが変更後のメディアに切り替わります。変更前でも、変更後のメディアの進行管理で担当に選べます。</span><div id="ct-mc"></div><button class="btn sm" type="button" id="ct-mc-add">＋ 担当変更を追加</button></div>'
    + '<div class="full"><b style="font-size:13px">契約内容</b><div class="row" style="flex-wrap:wrap; gap:8px; align-items:flex-end; margin-top:4px"><label class="field">報酬の形<select id="ct-paytype">' + opt(d.payTypes.map(x => [x, x]), p.type || '記事単価') + '</select></label><span id="ct-payfields" style="display:contents"></span></div>'
    + '<div class="row" style="gap:8px; align-items:flex-end; margin-top:6px">' + chk('ct-sup-on', '1', !!p.superviseOn, '記事監修を追加（オプション）') + '<label class="field" id="ct-sup-wrap">記事監修の単価（円/記事）<input id="ct-sup" inputmode="decimal" value="' + esc(p.supervise ?? '') + '"></label></div>'
    + '<div class="row" style="gap:8px; align-items:flex-end; margin-top:6px">' + chk('ct-upnew', '1', !!p.uploadNewOnly, 'アップロード単価は新規記事だけ（リライトはアップロード込み）') + '</div>'
    + '<div class="row" style="gap:8px; align-items:flex-end; margin-top:6px"><label class="field">プレスリリース単価（円/本。担当のリリース1本あたり）<input id="ct-press" inputmode="decimal" value="' + esc(p.press ?? '') + '"></label></div>'
    + '<div class="row" style="gap:8px; align-items:flex-end; margin-top:6px">' + chk('ct-hour-on', '1', !!p.hourOn, '時間単価を追加（オプション）') + '<label class="field" id="ct-hour-wrap">時間単価（円/時間）<input id="ct-hour" inputmode="decimal" value="' + esc(p.hour ?? '') + '"></label></div>'
    + '<div class="row" style="gap:8px; align-items:flex-end; margin-top:6px">' + chk('ct-other-on', '1', !!p.otherOn, 'その他報酬を追加（オプション）') + '<label class="field" id="ct-other-wrap" style="flex:1">その他報酬（内容と金額をメモで）<input id="ct-other" value="' + esc(p.otherNote || '') + '" placeholder="例：プレスリリース作成 1本35,000円"></label></div>'
    + '<div style="margin-top:10px"><b style="font-size:13px">ディレクション費</b> <span class="note">条件ごとに金額を入れます（例：条件1「月10本まで」15,000円）</span><div id="ct-dir"></div><button class="btn sm" type="button" id="ct-dir-add">＋ 条件を追加</button></div></div>'
    + '<div class="full" style="margin-top:6px">' + chk('ct-past-on', '1', (v.pastPays || []).length > 0, '以前の契約内容を入れる（ある場合だけ）') + '<div id="ct-past-wrap"><p class="note">期間（開始月〜終了月）ごとに、その時の契約内容を入れます。報酬管理の報酬額では、その期間の月にはこの内容を使います。</p><div id="ct-past"></div><button class="btn sm" type="button" id="ct-past-add">＋ 期間を追加</button></div></div>'
    + '<div class="full" id="ct-ws-wrap"><b style="font-size:13px">ライティング担当</b>（記事の執筆担当に選べるようにします）' + box(d.writerSources.map(x => chk('ct-ws', x, (v.writerSources || []).includes(x), x + ({ '自らライティング': '（本人が執筆する）', '自社ライター': '（自分で手配するライター）' }[x] || '（BESTと契約しているライター）'))).join('')) + '</div>'
    + '<label class="full">メモ<textarea id="ct-memo" rows="2">' + esc(v.memo || '') + '</textarea></label>'
    // 契約書類（PDF）：追加のときも編集のときもアップロードできる。スプレッドシートからは取り込まない（2026-10-26 ユーザー指定）
    + '<div class="full"><b style="font-size:13px">契約書類（PDF）</b> <span class="note">' + (c && (c.files || []).length ? '登録済み：' + esc(c.files.map(f => f.label).join('、')) : 'なし') + '</span><div class="row" style="gap:8px; align-items:flex-end; margin-top:4px; flex-wrap:wrap"><label class="field">書類の名前<input id="ct-file-label" value="契約書" style="width:12em"></label><label class="field">PDFファイル<input type="file" id="ct-file" accept="application/pdf"></label>' + (c ? '<button class="btn" type="button" id="ct-file-add">今すぐ追加</button>' : '') + '</div><p class="note" style="margin:2px 0 0">ファイルを選んで「保存」を押すと、契約と一緒に保存します。</p></div>'
    + (c ? '<label class="full">今回の変更内容（書面の変更履歴に残ります）<input id="ct-note" placeholder="例：記事単価を5,000円→6,000円に変更"></label>' : '')
    + '</div><p class="note" id="ct-roles"></p><p class="err" id="ct-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end; flex-wrap:wrap; gap:6px">'
    + (c && isAdmin() ? '<button class="btn" type="button" id="ct-del" style="margin-right:auto">削除</button>' : '')
    + (c ? '<button class="btn" type="button" id="ct-doc">書面</button>' : '')
    + '<button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="ct-save">保存</button></div>');
  const checked = name => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map(x => x.value);
  const subsCur = Object.assign({}, v.subs || {});
  // 担当ディレクトリ：選んだメディアのうち、ディレクトリがあるメディアだけ（何も選ばなければ全ディレクトリ）
  const drawSubs = () => {
    document.querySelectorAll('input[name^="ct-sub|"]').forEach(x => { const m = x.name.slice(7); subsCur[m] = checked(x.name); });
    const ms = checked('ct-media').filter(m => artSubs(m));
    $('ct-subs').innerHTML = ms.length ? '<b style="font-size:13px">担当ディレクトリ</b>（選んだディレクトリの記事だけが表示されます。何も選ばなければ、そのメディアのすべて）'
      + ms.map(m => '<div style="margin-top:4px"><span class="note">' + esc(mediaLabel(m)) + '</span>' + box(artSubs(m).map(s => chk('ct-sub|' + m, s, (subsCur[m] || []).includes(s), s)).join('')) + '</div>').join('') : '';
  };
  const drawPay = () => {
    const type = $('ct-paytype').value, cur = {}; document.querySelectorAll('[data-pay]').forEach(x => { cur[x.dataset.pay] = x.value; });
    $('ct-payfields').innerHTML = PAY_FIELDS_C[type].map(k => '<label class="field">' + PAY_ITEMS[k][0] + '（' + PAY_ITEMS[k][1] + '）<input data-pay="' + k + '" inputmode="decimal" value="' + esc(cur[k] ?? p[k] ?? '') + '"></label>').join('');
  };
  const syncPos = () => {
    const pos = $('ct-pos').value;
    $('ct-title-wrap').hidden = pos !== '監修者';
    $('ct-ws-wrap').hidden = !d.writerSourcePositions.includes(pos);
    $('ct-roles').textContent = '記事管理で選べる担当：' + rolesOf(pos).join('・');
  };
  const syncMisc = () => { $('ct-company-wrap').hidden = $('ct-entity').value !== '企業'; $('ct-route-note-wrap').hidden = !$('ct-route').value; $('ct-sup-wrap').hidden = !checked('ct-sup-on').length; $('ct-hour-wrap').hidden = !checked('ct-hour-on').length; $('ct-other-wrap').hidden = !checked('ct-other-on').length;
    const st = $('ct-status-sel').value; $('ct-end-wrap').hidden = st !== '契約解除' && !$('ct-end-date').value; $('ct-leave-s-wrap').hidden = $('ct-leave-e-wrap').hidden = st !== '休職' && !$('ct-leave-s').value;
    if (st === '契約解除' && !$('ct-end-date').value) $('ct-end-date').value = todayJst(); if (st === '休職' && !$('ct-leave-s').value) $('ct-leave-s').value = todayJst(); };
  document.querySelectorAll('input[name="ct-media"]').forEach(x => x.onchange = drawSubs);
  $('ct-paytype').onchange = drawPay; $('ct-pos').onchange = syncPos; $('ct-entity').onchange = syncMisc; $('ct-route').onchange = syncMisc;
  document.querySelector('input[name="ct-sup-on"]').onchange = syncMisc; document.querySelector('input[name="ct-hour-on"]').onchange = syncMisc; document.querySelector('input[name="ct-other-on"]').onchange = syncMisc; $('ct-status-sel').onchange = syncMisc;
  // ディレクション費の条件の行（条件1・条件2…）
  const dirRow = (x, i) => '<div class="row ct-dir-row" style="gap:6px; align-items:flex-end; margin:4px 0"><span class="note" style="min-width:3.5em">条件' + (i + 1) + '</span><input data-dc placeholder="条件（例：月10本まで）" value="' + esc(x.cond || '') + '" style="flex:1"><input data-da inputmode="numeric" placeholder="金額（円）" value="' + esc(x.amount ?? '') + '" style="width:8em"><button class="linkbtn" type="button" data-dir-del="' + i + '">削除</button></div>';
  const readDir = () => [...document.querySelectorAll('#ct-dir .ct-dir-row')].map(r => ({ cond: r.querySelector('[data-dc]').value, amount: r.querySelector('[data-da]').value }));
  const drawDir = list => { $('ct-dir').innerHTML = list.map(dirRow).join(''); document.querySelectorAll('[data-dir-del]').forEach(b => b.onclick = () => { const l = readDir(); l.splice(Number(b.dataset.dirDel), 1); drawDir(l); }); };
  drawDir((p.direction || []).length ? p.direction : []);
  $('ct-dir-add').onclick = () => drawDir(readDir().concat([{}]));
  // 以前の契約内容（期間ごと）。項目は今の契約内容と同じ（記事監修・時間単価は空欄なら「なし」）
  const pastFields = type => (PAY_FIELDS_C[type] || []).concat(['supervise', 'hour', 'press']);
  const pastHtml = (x, i) => {
    const pp = x.pay || { type: '記事単価' }, type = pp.type || '記事単価';
    return '<div class="ct-past-row" data-pi="' + i + '" style="border:1px solid var(--line); border-radius:8px; padding:8px; margin:6px 0">'
      + '<div class="row" style="gap:6px; align-items:flex-end; flex-wrap:wrap"><b style="font-size:13px">以前の契約 ' + (i + 1) + '</b>'
      + '<label class="field">開始月<input type="month" data-pf value="' + esc(x.from || '') + '"></label><label class="field">終了月<input type="month" data-pt value="' + esc(x.to || '') + '"></label>'
      + '<label class="field">報酬の形<select data-ptype>' + opt(d.payTypes.map(t => [t, t]), type) + '</select></label>'
      + '<button class="linkbtn" type="button" data-past-del="' + i + '" style="margin-left:auto">この期間を削除</button></div>'
      // その期間に担当していたメディア（2026-10-26 ユーザー指定）
      + '<div class="row" style="gap:4px 10px; flex-wrap:wrap; margin-top:4px; align-items:center"><span class="note">担当メディア</span>' + topMedia().map(m => '<label style="flex-direction:row; align-items:center; gap:4px; color:var(--fg); font-weight:normal"><input type="checkbox" data-pm value="' + esc(m.media) + '"' + ((x.medias || []).includes(m.media) ? ' checked' : '') + '>' + esc(m.name) + '</label>').join('') + '</div>'
      + '<div class="row" style="gap:6px; align-items:flex-end; flex-wrap:wrap; margin-top:4px">' + pastFields(type).map(k => '<label class="field">' + PAY_ITEMS[k][0] + '（' + PAY_ITEMS[k][1] + '）<input data-pk="' + k + '" inputmode="decimal" value="' + esc(pp[k] ?? '') + '" style="width:7em"></label>').join('')
      + '<label style="flex-direction:row; align-items:center; gap:4px; font-weight:normal"><input type="checkbox" data-pun' + (pp.uploadNewOnly ? ' checked' : '') + '>アップロードは新規だけ</label>'
      + '<label class="field" style="flex:1">その他報酬（メモ）<input data-pk="otherNote" value="' + esc(pp.otherNote || '') + '"></label></div>'
      + '<div style="margin-top:4px"><span class="note">ディレクション費（条件と金額）</span>' + (pp.direction || []).map((y, j) => '<div class="row ct-pdir" style="gap:6px; margin:2px 0"><span class="note" style="min-width:3.5em">条件' + (j + 1) + '</span><input data-pdc value="' + esc(y.cond || '') + '" style="flex:1"><input data-pda inputmode="numeric" value="' + esc(y.amount ?? '') + '" style="width:8em"></div>').join('')
      + '<button class="linkbtn" type="button" data-pdir-add="' + i + '">＋ 条件を追加</button></div>'
      + '<label class="field" style="margin-top:4px">メモ<input data-pn value="' + esc(x.note || '') + '"></label></div>';
  };
  const readPast = () => [...document.querySelectorAll('#ct-past .ct-past-row')].map(r => {
    const type = r.querySelector('[data-ptype]').value, pay = { type, direction: [...r.querySelectorAll('.ct-pdir')].map(y => ({ cond: y.querySelector('[data-pdc]').value.trim(), amount: y.querySelector('[data-pda]').value.trim() })).filter(y => y.cond || y.amount) };
    r.querySelectorAll('[data-pk]').forEach(el => { pay[el.dataset.pk] = el.value.trim(); });
    pay.superviseOn = !!pay.supervise; pay.hourOn = !!pay.hour; pay.otherOn = !!pay.otherNote; pay.uploadNewOnly = !!r.querySelector('[data-pun]:checked');
    return { from: r.querySelector('[data-pf]').value, to: r.querySelector('[data-pt]').value, medias: [...r.querySelectorAll('[data-pm]:checked')].map(el => el.value), pay, note: r.querySelector('[data-pn]').value.trim() };
  });
  const drawPast = list => {
    $('ct-past').innerHTML = list.map(pastHtml).join('');
    document.querySelectorAll('[data-past-del]').forEach(b => b.onclick = () => { const l = readPast(); l.splice(Number(b.dataset.pastDel), 1); drawPast(l); });
    document.querySelectorAll('[data-ptype]').forEach(el => el.onchange = () => drawPast(readPast()));
    document.querySelectorAll('[data-pdir-add]').forEach(b => b.onclick = () => { const l = readPast(), x = l[Number(b.dataset.pdirAdd)]; x.pay.direction = (x.pay.direction || []).concat([{}]); drawPast(l); });
  };
  drawPast(v.pastPays || []);
  $('ct-past-add').onclick = () => drawPast(readPast().concat([{ pay: { type: ($('ct-paytype') || {}).value || '記事単価' } }]));
  const syncPast = () => { $('ct-past-wrap').hidden = !checked('ct-past-on').length; if (checked('ct-past-on').length && !document.querySelector('#ct-past .ct-past-row')) $('ct-past-add').onclick(); };
  document.querySelector('input[name="ct-past-on"]').onchange = syncPast; syncPast();
  const mcHtml = (x, i) => '<div class="ct-mc-row" style="border:1px solid var(--line); border-radius:8px; padding:8px; margin:6px 0"><div class="row" style="gap:6px; align-items:flex-end; flex-wrap:wrap"><b style="font-size:13px">担当変更 ' + (i + 1) + '</b>'
    + '<label class="field">この月から<input type="month" data-mcf value="' + esc(x.from || '') + '"></label><label class="field" style="flex:1">メモ<input data-mcn value="' + esc(x.note || '') + '" placeholder="例：水まわりお助け本舗に移動"></label>'
    + '<button class="linkbtn" type="button" data-mc-del="' + i + '" style="margin-left:auto">削除</button></div>'
    + '<div class="row" style="gap:4px 10px; flex-wrap:wrap; margin-top:4px; align-items:center"><span class="note">変更後の担当メディア</span>' + topMedia().map(m => '<label style="flex-direction:row; align-items:center; gap:4px; color:var(--fg); font-weight:normal"><input type="checkbox" data-mcm value="' + esc(m.media) + '"' + ((x.medias || []).includes(m.media) ? ' checked' : '') + '>' + esc(m.name) + '</label>').join('') + '</div>'
    + ((x.prevMedias || []).length ? '<p class="note" style="margin:4px 0 0">変更前：' + esc(x.prevMedias.map(mediaLabel).join('・')) + '</p>' : '') + '<input type="hidden" data-mcp value="' + esc((x.prevMedias || []).join('	')) + '"></div>';
  const readMc = () => [...document.querySelectorAll('#ct-mc .ct-mc-row')].map(r => ({ from: r.querySelector('[data-mcf]').value, medias: [...r.querySelectorAll('[data-mcm]:checked')].map(el => el.value), note: r.querySelector('[data-mcn]').value.trim(), prevMedias: r.querySelector('[data-mcp]').value ? r.querySelector('[data-mcp]').value.split('	') : [] }));
  const drawMc = list => { $('ct-mc').innerHTML = list.map(mcHtml).join(''); document.querySelectorAll('[data-mc-del]').forEach(b => b.onclick = () => { const l = readMc(); l.splice(Number(b.dataset.mcDel), 1); drawMc(l); }); };
  drawMc(v.mediaChanges || []);
  $('ct-mc-add').onclick = () => drawMc(readMc().concat([{ from: shiftMonth(todayJst().slice(0, 7), 1), medias: [] }]));
  drawSubs(); drawPay(); syncPos(); syncMisc();
  const fail = m => { $('ct-err').textContent = m; $('ct-err').hidden = false; };
  const done = () => { CONTRACTS = null; ITEMS = null; closeModal(); render(); toast('保存されました'); };
  const body = () => {
    drawSubs();
    const pay = { type: $('ct-paytype').value, press: $('ct-press').value.trim(), uploadNewOnly: !!checked('ct-upnew').length, superviseOn: !!checked('ct-sup-on').length, supervise: $('ct-sup').value.trim(), hourOn: !!checked('ct-hour-on').length, hour: $('ct-hour').value.trim(), otherOn: !!checked('ct-other-on').length, otherNote: $('ct-other').value.trim(), direction: [...document.querySelectorAll('#ct-dir .ct-dir-row')].map(r => ({ cond: r.querySelector('[data-dc]').value.trim(), amount: r.querySelector('[data-da]').value.trim() })).filter(x => x.cond || x.amount) };
    document.querySelectorAll('[data-pay]').forEach(x => { pay[x.dataset.pay] = x.value.trim(); });
    const medias = checked('ct-media'), subs = {}; medias.forEach(m => { if ((subsCur[m] || []).length) subs[m] = subsCur[m]; });
    return { name: $('ct-name').value.trim(), email: $('ct-email').value.trim(), entity: $('ct-entity').value, company: $('ct-entity').value === '企業' ? $('ct-company').value.trim() : '',
      position: $('ct-pos').value, title: $('ct-pos').value === '監修者' ? $('ct-title').value.trim() : '', startMonth: $('ct-month').value, route: $('ct-route').value, routeNote: $('ct-route-note').value.trim(),
      invoice: $('ct-invoice').value.trim(), billingStaffId: $('ct-billing') ? $('ct-billing').value : undefined, billingSubStaffId: $('ct-billing-sub') ? $('ct-billing-sub').value : undefined, status: $('ct-status-sel').value === '休職' ? '契約中' : $('ct-status-sel').value, endDate: $('ct-end-date').value, leaveStart: $('ct-leave-s').value, leaveEnd: $('ct-leave-e').value || ($('ct-status-sel').value === '契約中' && $('ct-leave-s').value ? todayJst() : ''), medias,   /* 休職→契約中に戻したら、復職日は今日 */ subs, pay, mediaChanges: readMc().map(x => Object.assign(x, { prevMedias: x.prevMedias.length ? x.prevMedias : medias })), writerSources: checked('ct-ws'), pastPays: checked('ct-past-on').length ? readPast() : [], memo: $('ct-memo').value.trim(), changeNote: c ? $('ct-note').value.trim() : undefined };
  };
  $('ct-save').onclick = async () => {
    const b = body();
    if (!b.name) return fail('契約者名を入力してください');
    if (!b.medias.length) return fail('担当メディアを1つ以上選んでください');
    if (!b.route) return fail('採用経路を選んでください');
    if (b.mediaChanges.some(x => !x.from)) return fail('担当変更の「この月から」を選んでください');
    if (b.mediaChanges.some(x => !x.medias.length)) return fail('担当変更の変更後の担当メディアを1つ以上選んでください');
    const file = $('ct-file') && $('ct-file').files[0];
    if (file && file.size > 20 * 1024 * 1024) return fail('PDFは20MBまでです');
    let id = c && c.id;
    try { if (c) await apiSend('PATCH', '/contracts/' + encodeURIComponent(c.id), b); else id = (await apiSend('POST', '/contracts', b)).id; } catch (e) { return fail(e.message); }
    if (file) { try { await uploadContractFile(id, file); } catch (e) { alert('契約は保存しましたが、PDFを保存できませんでした：' + e.message + '（編集から追加し直してください）'); } }
    done();
  };
  const act = (id, payload, confirmMsg) => { const el = $(id); if (el) el.onclick = async () => { if (confirmMsg && !confirm(confirmMsg())) return; try { await apiSend('PATCH', '/contracts/' + encodeURIComponent(c.id), payload()); done(); } catch (e) { fail(e.message); } }; };
  act('ct-terminate', () => ({ status: '契約解除', endDate: $('ct-end').value, changeNote: '契約解除（' + $('ct-end').value.replace(/-/g, '/') + '）' }), () => c.name + ' さんの契約を、' + $('ct-end').value.replace(/-/g, '/') + ' で解除します。よろしいですか？（解除した契約は「状態：すべて」で見られます）');
  act('ct-reopen', () => ({ status: '契約中', changeNote: '再契約' }), () => c.name + ' さんを再契約（契約中）に戻します。よろしいですか？');
  if ($('ct-doc')) $('ct-doc').onclick = () => openContractDoc(c.id);
  // 契約書類（PDF）を追加：公開できない専用の保管場所に保存（2026-10-14 ユーザー指定）
  if ($('ct-file-add')) $('ct-file-add').onclick = async () => {
    const file = $('ct-file').files[0];
    if (!file) return fail('PDFファイルを選んでください');
    if (file.size > 20 * 1024 * 1024) return fail('PDFは20MBまでです');
    try {
      $('ct-file-add').disabled = true; $('ct-file-add').textContent = '保存中…';
      await uploadContractFile(c.id, file);
      done();
    } catch (e) { fail(e.message); $('ct-file-add').disabled = false; $('ct-file-add').textContent = '今すぐ追加'; }
  };
  const del = $('ct-del');
  if (del) del.onclick = async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'もう一度押すと削除（変更履歴も消えます）'; return; }
    try { await apiSend('DELETE', '/contracts/' + encodeURIComponent(c.id)); done(); } catch (e) { fail(e.message); }
  };
}
/** 契約書類（PDF）を契約に保存（公開できない専用の保管場所） */
async function uploadContractFile(id, file) {
  const tok = await fbAuth.currentUser.getIdToken();
  const res = await fetch('/api/contracts/' + encodeURIComponent(id) + '/files?label=' + encodeURIComponent(($('ct-file-label') && $('ct-file-label').value.trim()) || '契約書類') + '&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/pdf' }, body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '保存できませんでした');
}
/** 契約書類（PDF）を別ウィンドウで表示。1つ目は開いたときに表示する（2026-10-26 ユーザー指定）。URLで共有はできない */
async function openContractFiles(id) {
  const w = window.open('', '_blank');
  if (!w) return alert('ポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください');
  w.document.write('<p style="font-family:sans-serif">読み込み中…</p>');
  let d; try { d = await api('/contracts/' + encodeURIComponent(id) + '/doc'); } catch (e) { w.document.body.innerHTML = '<p style="font-family:sans-serif">表示できません：' + esc(e.message) + '</p>'; return; }
  const c = d.contract, files = c.files || [];
  w.document.open();
  w.document.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>契約書類 ' + esc(c.name) + '</title><meta name="robots" content="noindex"><style>'
    + 'body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;color:#222;margin:16px;line-height:1.6}h1{font-size:18px;margin:0 0 8px}.meta{font-size:12px;color:#666}.secret{color:#b00;font-weight:bold;font-size:12px}'
    + '.bar{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.bar button{font-size:13px;padding:5px 12px;cursor:pointer}.bar button.on{background:#222;color:#fff}</style></head><body>'
    + '<p class="secret">社外秘：本人・管理者・BEST役員・BEST正社員以外への共有は禁止</p><h1>契約書類：' + esc(c.name) + '</h1>'
    + '<div class="bar">' + files.map((f, n) => '<button data-file="' + n + '">' + esc(f.label || '契約書類') + (f.name ? '（' + esc(f.name) + '）' : '') + '</button>').join('') + '<button id="to-doc">契約内容（書面）を見る</button></div>'
    + (files.length ? '<div id="pdf-view"></div>' : '<p class="meta">登録されている契約書類はありません。契約管理の「編集」から PDF を追加できます。</p>')
    + '</body></html>');
  w.document.close();
  w.document.getElementById('to-doc').onclick = () => openContractDoc(id);
  const show = async n => {
    w.document.querySelectorAll('[data-file]').forEach(b => b.classList.toggle('on', b.dataset.file === String(n)));
    const box = w.document.getElementById('pdf-view'); box.innerHTML = '<p class="meta">読み込み中…</p>';
    try {
      const tok = await fbAuth.currentUser.getIdToken();
      const res = await fetch('/api/contracts/' + encodeURIComponent(id) + '/file/' + n, { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
      if (!res.ok) throw new Error('表示できません（' + res.status + '）');
      const blob = await res.blob();
      if (!/pdf|image/.test(blob.type)) { box.innerHTML = '<p class="meta">この書類は PDF ではないため、ここでは表示できません（' + esc(files[n].name || '') + '）。</p>'; return; }
      box.innerHTML = '<iframe src="' + URL.createObjectURL(blob) + '" style="width:100%;height:85vh;border:1px solid #bbb"></iframe>';
    } catch (e) { box.innerHTML = '<p class="meta">' + esc(e.message) + '</p>'; }
  };
  w.document.querySelectorAll('[data-file]').forEach(b => b.onclick = () => show(b.dataset.file));
  if (files.length) show(0);
}
/** 書面：契約内容とこれまでの変更を、印刷できる別ウィンドウに表示（データはこの画面の中だけ。URLで共有はできない） */
async function openContractDoc(id) {
  const w = window.open('', '_blank');
  if (!w) return alert('ポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください');
  w.document.write('<p style="font-family:sans-serif">読み込み中…</p>');
  let d; try { d = await api('/contracts/' + encodeURIComponent(id) + '/doc'); } catch (e) { w.document.body.innerHTML = '<p style="font-family:sans-serif">表示できません：' + esc(e.message) + '</p>'; return; }
  const mn = m => d.mediaNames[m] || m;
  const terms = c => {
    const p = c.pay || {}, row = (k, val) => '<tr><th>' + k + '</th><td>' + val + '</td></tr>';
    return '<table>' + row('契約者名', esc(c.name) + (c.entity === '企業' && c.company && c.company !== c.name ? '（' + esc(c.company) + '）' : ''))
      + row('契約形態', esc(c.entity || '—')) + row('契約ポジション', esc(c.position || '—') + (c.position === '監修者' && c.title ? '（' + esc(c.title) + '）' : ''))
      + row('契約月', c.startMonth ? esc(c.startMonth.replace('-', '年') + '月') : '—') + row('担当メディア', esc((c.medias || []).map(mn).join('、') || '—'))
      + row('担当ディレクトリ', esc(Object.entries(c.subs || {}).filter(([m]) => (c.medias || []).includes(m)).map(([m, l]) => mn(m) + '：' + l.join('・')).join('／') || 'すべて'))
      + row('契約内容', esc(p.type === '単発発注' ? '単発発注（継続契約なし）' : p.type || '—') + '<br>' + (PAY_FIELDS_C[p.type] || []).map(k => esc(PAY_ITEMS[k][0]) + '：' + esc(payAmt(k, p[k]))).join('<br>') + (p.superviseOn ? '<br>記事監修（オプション）：' + esc(payAmt('supervise', p.supervise)) : '') + (p.hourOn ? '<br>時間単価（オプション）：' + esc(payAmt('hour', p.hour)) : '') + (p.otherOn ? '<br>その他報酬：' + esc(p.otherNote || '') : '') + (p.direction || []).map((x, i) => '<br>ディレクション費（条件' + (i + 1) + '）：' + esc(x.cond || '') + (x.amount != null ? ' ' + esc(yen0(x.amount)) : '')).join(''))
      + (WRITER_SRC_POS.includes(c.position) ? row('ライティング担当', esc((c.writerSources || []).join('、') || '—')) : '')
      + row('採用経路', esc((c.route || '—') + (c.routeNote ? '（' + c.routeNote + '）' : ''))) + row('メールアドレス', esc(c.email || '—'))
      + row('インボイス番号', esc(c.invoice || '登録なし')) + row('請求担当', esc(staffNameOf(c.billingStaffId) + (c.billingSubStaffId ? '（サブ：' + staffNameOf(c.billingSubStaffId) + '）' : ''))) + row('状態', esc(c.status || '契約中') + (c.endDate ? '（' + esc(c.endDate.replace(/-/g, '/')) + ' 解除）' : '') + (c.leaveStart ? '<br>休職：' + esc(c.leaveStart.replace(/-/g, '/')) + '〜' + (c.leaveEnd ? esc(c.leaveEnd.replace(/-/g, '/')) + '（復職）' : '（休職中）') : ''))
      + (c.memo ? row('メモ', esc(c.memo).replace(/\n/g, '<br>')) : '') + '</table>';
  };
  const c = d.contract, at = s => s ? new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';   // 日本時間で表示
  w.document.open();
  w.document.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>契約内容 ' + esc(c.name) + '</title><meta name="robots" content="noindex"><style>'
    + 'body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;color:#222;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6}h1{font-size:20px;border-bottom:2px solid #222;padding-bottom:6px}h2{font-size:15px;margin-top:28px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}th{width:28%;background:#f4f4f4;font-weight:normal}'
    + '.secret{color:#b00;font-weight:bold;font-size:12px}.meta{font-size:12px;color:#666}.bar{margin:12px 0}.bar button{font-size:14px;padding:6px 14px}details{margin:8px 0;border:1px solid #ddd;padding:6px 10px}summary{cursor:pointer}'
    + '@media print{.bar{display:none}details{border:none;padding:0}details>summary{list-style:none}}</style></head><body>'
    + '<div class="bar"><button onclick="window.print()">印刷・PDFで保存</button> <span class="meta">PDFにするときは、印刷の画面で「PDFに保存」を選んでください</span></div>'
    + '<p class="secret">社外秘：本人・管理者・BEST役員・BEST正社員以外への共有は禁止</p><h1>業務委託 契約内容</h1>'
    + '<p class="meta">表示日時：' + esc(new Date().toLocaleString('ja-JP')) + '　最終更新：' + esc(at(c.updatedAt || c.createdAt)) + '　版：第' + (c.version || 1) + '版</p>'
    + '<h2>現在の契約内容</h2>' + terms(c)
    + ((c.pastPays || []).length ? '<h2>以前の契約内容</h2>' + c.pastPays.map(x => '<table style="margin-bottom:8px"><tr><th>期間</th><td>' + esc(x.from.replace('-', '/')) + '〜' + esc(x.to.replace('-', '/')) + '</td></tr>' + ((x.medias || []).length ? '<tr><th>担当メディア</th><td>' + esc(x.medias.map(m => mediaLabel(m)).join('・')) + '</td></tr>' : '') + '<tr><th>契約内容</th><td>' + esc(payLabel({ pay: x.pay })) + '</td></tr>' + (x.note ? '<tr><th>メモ</th><td>' + esc(x.note) + '</td></tr>' : '') + '</table>').join('') : '')
    + '<h2>契約書類</h2>' + ((c.files || []).length ? '<div class="bar" style="display:block">' + c.files.map((f, n) => '<p><button data-file="' + n + '">' + esc(f.label || '契約書類') + '</button> <span class="meta">' + esc(f.name || '') + '</span></p>').join('') + '</div><div id="pdf-view"></div>' : '<p class="meta">登録されている契約書類はありません。</p>')
    + '<h2>変更履歴</h2>' + (d.history.length ? d.history.map(h => '<details><summary>' + esc(at(h.savedAt)) + ' まで有効だった内容（第' + (h.version || 1) + '版）→ 変更：' + esc(h.replaceNote || '') + '</summary>' + terms(h) + '</details>').join('') : '<p class="meta">変更はまだありません。</p>')
    + '</body></html>');
  w.document.close();
  // 契約書類（PDF）：ボタンを押したときだけ、ログインの確認つきで読み込んで、この書面の中に表示（URLで共有はできない）
  w.document.querySelectorAll('[data-file]').forEach(b => b.onclick = async () => {
    const box = w.document.getElementById('pdf-view'); box.innerHTML = '<p class="meta">読み込み中…</p>';
    try {
      const tok = await fbAuth.currentUser.getIdToken();
      const res = await fetch('/api/contracts/' + encodeURIComponent(id) + '/file/' + b.dataset.file, { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
      if (!res.ok) throw new Error('表示できません（' + res.status + '）');
      const url = URL.createObjectURL(await res.blob());
      box.innerHTML = '<iframe src="' + url + '" style="width:100%;height:80vh;border:1px solid #bbb"></iframe>';
    } catch (e) { box.innerHTML = '<p class="meta">' + esc(e.message) + '</p>'; }
  });
}
const WRITER_SRC_POS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター'];
/** 画面右上：自分の契約がある人に「契約内容」ボタン */
async function setupMyContract() {
  try {
    const r = await api('/my-contracts'), list = r.contracts || [];
    const chip = document.querySelector('.user-chip'); if (!chip || !list.length || $('my-contract')) return;
    const b = document.createElement('button'); b.className = 'linkbtn'; b.id = 'my-contract'; b.type = 'button'; b.textContent = '契約内容';
    b.onclick = () => { if (list.length === 1) return openContractDoc(list[0].id); openModal('<h2>契約内容</h2>' + list.map(c => '<p><button class="btn" type="button" data-mydoc="' + esc(c.id) + '">' + esc(c.position || '') + '（' + esc(c.status) + '）</button></p>').join('') + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>閉じる</button></div>'); document.querySelectorAll('[data-mydoc]').forEach(x => x.onclick = () => { closeModal(); openContractDoc(x.dataset.mydoc); }); };
    chip.insertBefore(b, $('logout'));
  } catch (e) { /* 契約がない人は何も出さない */ }
}

// ================= 報酬管理（契約中の人だけ。今月の担当記事数と報酬額） =================
function viewRewards() {
  const f = state.rwFilter = state.rwFilter || { ym: CUR_MONTH };
  return { html: '<section class="panel" id="rw-body"><p class="loading">読み込み中…</p></section>', view: '報酬管理', after: async () => {
    await loadItems();
    const media = ALL;   // 報酬管理はメディアで絞らない（2026-10-28 ユーザー指定）
    const data = await loadContracts();
    const mine = state.view === 'rw-mine';
    const list = data.contracts.filter(c => (media === ALL || (c.medias || []).includes(media)) && c.active && (!mine || myBilling(c)));   // メディア累計：契約中の全員
    const months = RW_MONTHS();
    // その月にアップロード（完了）した記事を担当別に数える
    const done = ITEMS.filter(r => inArt(r, media) && (r.upload_date || '').startsWith(f.ym));
    await loadTimesheets(list, f.ym);
    const calc = c => rewardCalc(c, f.ym, done);

    const rows = list.map(c => Object.assign({ c }, calc(c))).sort((a, b) => (mine ? billRank(a.c) - billRank(b.c) : 0) || Object.keys(CAT_LABEL).indexOf(a.c.category) - Object.keys(CAT_LABEL).indexOf(b.c.category) || String(a.c.name).localeCompare(b.c.name, 'ja'));
    const total = rows.reduce((a, r) => a + (r.est || 0), 0);
    const invByMonth = {}; await Promise.all(months.filter(m => m >= INVOICE_START).map(m => api('/invoices?ym=' + m).then(x => { invByMonth[m] = x.invoices || []; }).catch(() => { invByMonth[m] = []; })));
    const INVS = invByMonth[f.ym] || [], invOf = c => INVS.find(v => v.contractId === c.id);   /* 請求（2026-10-29） */
    await loadPastBy();
    const invCell = (c, r) => { const v = invOf(c); if (!v && f.ym < INVOICE_START) return pastCell(c, f.ym, r && r.est); if (!v) return r && (r.n || r.up || r.sup || r.est) ? '<span class="pill ng">要請求</span>' : '<span class="note">対応記事なし</span>'; const st = INV_STATUS[v.status] || [v.status, 'off']; return '<button type="button" class="pill ' + st[1] + ' inv-pill" data-invchk="' + esc(v.id) + '" title="押すと請求書と確認">' + st[0] + (['checking', 'finance_returned'].includes(v.status) ? '・要確認' : '') + '</button><br><span class="note">' + yen0(v.total) + (v.issueDate ? '<br>請求日 ' + Number(v.issueDate.slice(5, 7)) + '/' + Number(v.issueDate.slice(8, 10)) : '') + invChecker(v) + '</span>'; };   /* 請求日も（2026-10-29 ユーザー指定） */
    $('rw-body').innerHTML = H((mine ? '担当者一覧' : '契約者一覧') + ' <small>' + (mine ? 'あなたが請求担当の契約中の人' : '契約中の人') + '</small>', ['契約管理', '記事管理'])
      + '<div class="row" style="margin-bottom:8px"><label class="field">対象月<select id="rw-ym">' + months.map(m => '<option value="' + m + '"' + (m === f.ym ? ' selected' : '') + '>' + mLabel(m) + '（' + invMonthState(m, invByMonth[m] || []) + '）</option>').join('') + '</select></label><span class="note">' + mLabel(f.ym) + 'にアップロードした記事 ' + done.length + '件・報酬額合計 <b>' + yen0(total) + '</b></span></div>'
      + (rows.length ? '<div class="table-wrap"><table class="am-table rw-table"><thead><tr><th class="c-txt">氏名</th>' + (mine ? '<th class="c-ctr">担当</th>' : '') + '<th class="c-ctr">請求</th><th class="c-num">担当記事</th><th class="c-num">文字数</th><th class="c-num">報酬額（税抜き）</th><th class="c-txt">区分</th><th class="c-txt">ポジション</th><th class="c-txt">契約内容</th></tr></thead><tbody>'
        + rows.map(r => { const lv = onLeave(r.c), ending = ctStatus(r.c) === '解除予定', d = x => x ? Number(x.slice(5, 7)) + '/' + Number(x.slice(8, 10)) : ''; return '<tr class="' + (lv ? 'ct-row-leave' : ending ? 'ct-row-ending' : '') + '"><td class="c-txt"><b>' + esc(r.c.name) + '</b>' + (lv ? '<br><span class="note">休職中（' + d(r.c.leaveStart) + '〜' + (r.c.leaveEnd ? d(r.c.leaveEnd) : '復職日未定') + '）</span>' : ending ? '<br><span class="note">契約解除予定（' + d(r.c.endDate) + '）</span>' : '') + '</td>' + (mine ? '<td class="c-ctr">' + billTag(r.c) + '</td>' : '') + '<td class="c-ctr">' + invCell(r.c, r) + '</td>'
          + '<td class="c-num">' + r.n + '</td><td class="c-num">' + nf.format(r.chars) + '</td><td class="c-num"><b>' + yen0(r.est) + '</b>' + (r.hourly ? '<br><span class="note">＋時間単価分（稼働時間が必要）</span>' : '') + (r.dirLeft ? '<br><span class="note">＋ディレクション費（条件による）</span>' : '') + '</td>'
          + '<td class="c-txt">' + CAT_LABEL[r.c.category] + '</td><td class="c-txt">' + esc(r.c.category === 'supervision' ? (r.c.title || '監修者') : r.c.position) + '</td><td class="c-txt">' + esc(payLabel(r.c)) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<p class="empty">' + esc(mediaLabel(media)) + 'で契約中の担当者はいません。管理 →「契約管理」から登録してください。</p>')
      + '<p class="note">契約管理で「契約中」の人だけを表示しています。担当記事は、その月にアップロード日が入った記事のうち、ディレクション＝ディレクション担当、ライティング＝執筆担当、監修＝監修担当がその人の記事です。報酬額は、新規記事・リライト・簡易リライトの単価×それぞれの担当記事数＋アップロード単価×アップロードした記事数、文字単価×文字数＋画像作成単価×画像枚数＋アップロード単価×アップロードした記事数、記事監修（オプション）×監修した記事数です。時間単価（オプション）は稼働時間がないため、報酬額に含めていません。</p>';
    $('rw-ym').onchange = ev => { f.ym = ev.target.value; render(); };
    document.querySelectorAll('[data-invchk]').forEach(b => b.onclick = () => invCheckModal(INVS.find(v => v.id === b.dataset.invchk), render));
  } };
}

/** 管理者：報酬管理一覧（2026-10-29 ユーザー指定）
 *  氏名（固定）・ポジション・契約内容（1行に1条件）のあとに、今月から過去の月へ「請求状況・担当記事・報酬額」を横に並べる（横にスクロール） */
const payLines = c => { const t = payLabel(c), i = t.indexOf('：'); return i < 0 ? [t] : [t.slice(0, i)].concat(t.slice(i + 1).split(' ｜ ')); };
function viewRewardsAll(opts) {
  const asc = !!(opts && opts.asc);   /* 支出管理の業務委託費：左が古い月・右が最新月（2026-11-02 ユーザー指定） */
  return { html: '<section class="panel" id="rw-body"><p class="loading">読み込み中…</p></section><section class="panel" id="rw-body-ended" hidden></section>', view: '報酬管理一覧', after: async () => {
    await loadItems();
    const data = await loadContracts();
    const byCat = (a, b) => Object.keys(CAT_LABEL).indexOf(a.category) - Object.keys(CAT_LABEL).indexOf(b.category) || String(a.name).localeCompare(b.name, 'ja');
    let ended = data.contracts.filter(c => !c.active && c.category !== 'site').sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')) || byCat(a, b));   // 契約解除の人（別の枠。2026-10-30 ユーザー指定）。契約解除日が新しい人から（2026-10-31 ユーザー指定）
    let list = data.contracts.filter(c => c.active && c.category !== 'site').sort((a, b) => Object.keys(CAT_LABEL).indexOf(a.category) - Object.keys(CAT_LABEL).indexOf(b.category) || String(a.name).localeCompare(b.name, 'ja'));   /* サイト作成・修正（テクノグラム・businessbay）は外す＝サイト制作・修正費で数える（2026-11-02 ユーザー指定） */
    /* 同じ人に契約中の契約があれば、解除した契約（別メディア）は契約解除の枠に出さず、契約中の行のすぐ下に並べる（2026-10-31 ユーザー指定 A。徳良さんの BEST365） */
    const nk = c => String(c.name || '').replace(/[\s　]/g, ''), actKeys = new Set(list.map(nk)), sibIds = new Set(ended.filter(c => actKeys.has(nk(c))).map(c => c.id));
    const sibs = ended.filter(c => sibIds.has(c.id)); ended = ended.filter(c => !sibIds.has(c.id));
    list = list.flatMap(c => [c].concat(sibs.filter(x => nk(x) === nk(c))));
    // 月：今月から、いちばん早い契約開始月まで（最大36か月）
    const first = list.concat(ended).map(c => c.startMonth).filter(Boolean).sort()[0] || shiftMonth(CUR_MONTH, -11), months = [];
    for (let m = CUR_MONTH; m >= first && months.length < 36; m = shiftMonth(m, -1)) months.push(m);
    if (asc) months.reverse();   /* 左が古い月・右が最新月 */
    const invByMonth = {}; await Promise.all(months.filter(m => m >= INVOICE_START).map(m => api('/invoices?ym=' + m).then(x => { invByMonth[m] = x.invoices || []; }).catch(() => { invByMonth[m] = []; })));
    await loadPastBy();
    await loadTimesheetsMany(list.concat(ended), months);   // 月ごとに読むと読み込みが多くなるので、まとめて
    const today = todayJst(), doneOf = {}; months.forEach(m => { doneOf[m] = ITEMS.filter(r => paidIn(r, m)); });
    // 契約前の月は「契約前」、契約中に請求がなかった月はグレー（2026-10-30 ユーザー指定）
    const startOf = c => [c.startMonth].concat((c.pastPays || []).map(p => p.from)).filter(s => /^\d{4}-\d{2}/.test(String(s || ''))).map(s => String(s).slice(0, 7)).sort()[0] || '';
    if (opts && opts.onMedia) {   /* 契約者単位の支払額（合計の行と同じ計算）を、シートの請求のメディア → 進行管理の担当記事のメディア → 契約の担当メディア の順で分ける */
      /* 契約管理シートのメディア名が「生活お助け本舗」の行は、ディレクトリの列（屋根・ガラス・水回り・ハチ・シロアリ）のメディア。井上さんは水回り・ハチの2行なので金額で分ける */
      const INOUE_HACHI = { '2025-02': [1070000], '2025-03': [920000], '2025-04': [920000], '2025-05': [820000], '2025-06': [730000], '2025-07': [720000], '2025-08': [720000], '2025-09': [860000], '2025-10': [590000], '2025-11': [440000] };
      const SEIKATSU = { '小松央直': '屋根外壁お助け', '江連良介': 'ガラスお助け', '斎藤一樹': 'シロアリお助け' };
      const rowMedia = r => { if (!/^生活お助け/.test(String(r.media || ''))) return r.media; const n = nmKey(r.name); if (SEIKATSU[n]) return SEIKATSU[n]; if (n === '井上雄輝') return (INOUE_HACHI[r.ym] || []).includes(Number(r.subtotal)) ? 'ハチお助け' : '水まわりお助け'; return r.media; };
      const valid = new Set(topIds()), mid = x => { x = String(x || ''); return valid.has(x) ? x : valid.has(x.replace(/本舗$/, '')) ? x.replace(/本舗$/, '') : ''; }, byM = {}, byMS = {}, byMC = {};
      list.concat(ended).forEach(c => months.forEach(m => {
        if (startOf(c) && m < startOf(c)) return; const endM = !c.active && c.endDate ? String(c.endDate).slice(0, 7) : ''; if (endM && m > endM) return;
        const e0 = rewardCalc(c, m, doneOf[m]).est || 0, sh = m < INVOICE_START ? pastSubAcc(c, m) : null, useSheet = sh != null && (sheetAccepted(c, m) || !(e0 > 0));
        const e = sh != null && sheetAccepted(c, m) ? sh : e0 > 0 && sh != null ? e0 + sheetExtra(c, m) : e0, amt = e > 0 ? e : (sh > 0 ? sh : 0);
        if (!(amt > 0)) return;
        let w = {};
        if (useSheet) pastHits(c, m).forEach(r => { const k = mid(rowMedia(r)); if (k) w[k] = (w[k] || 0) + (Number(r.subtotal) || 0); });
        if (!Object.values(w).some(v => v > 0)) { w = {}; invItemsByMedia(c, m, doneOf[m]).items.forEach(i => { const k = mid(i.media); if (k) w[k + '|' + (i.sub || '')] = (w[k + '|' + (i.sub || '')] || 0) + (Number(i.qty) || 0) * (Number(i.unit) || 0); }); }
        if (!Object.values(w).some(v => v > 0)) { w = {}; const ms = mediasAt(c, m).map(mid).filter(Boolean); (ms.length ? ms : ['（メディア不明）']).forEach(k => { w[k] = 1; }); }
        const t = Object.values(w).reduce((a, v) => a + v, 0); Object.entries(w).forEach(([k, v]) => { if (v > 0) { const mk = k.split('|')[0], sk = k.includes('|') ? k : k + '|'; (byM[mk] = byM[mk] || {})[m] = (byM[mk][m] || 0) + amt * v / t; (byMS[sk] = byMS[sk] || {})[m] = (byMS[sk][m] || 0) + amt * v / t; const cn = c.name || c.company || c.id; ((byMC[mk] = byMC[mk] || {})[cn] = byMC[mk][cn] || {})[m] = (byMC[mk][cn][m] || 0) + amt * v / t; } });
      }));
      opts.onMedia(byM, months.slice().sort(), byMS, byMC);
    }
    if (opts && opts.noRender) return;   /* 計算だけ（支出一覧） */
    const cell = (c, m) => {
      if (startOf(c) && m < startOf(c)) return '<td class="c-ctr rwa-m rwa-pre"><span class="note">契約前</span></td><td class="c-num rwa-m rwa-pre"></td><td class="c-num rwa-m rwa-end rwa-pre"></td>';
      const endM = !c.active && c.endDate ? String(c.endDate).slice(0, 7) : '';
      // くらしのレスキューに移った人（契約のメモに「くらしのレスキューに移籍」）は「くらしのレスキューに担当変更」で薄いグリーン（2026-10-30 ユーザー指定）
      if (endM && m > endM && /くらしのレスキュー/.test(c.memo || '') && /移籍|移動|担当変更/.test(c.memo || '')) return '<td class="c-ctr rwa-m rwa-kurashi" colspan="3"><span class="note">くらしのレスキューに担当変更</span></td>';
      if (endM && m > endM) return '<td class="c-ctr rwa-m rwa-gray"><span class="note">契約終了</span></td><td class="c-num rwa-m rwa-gray"></td><td class="c-num rwa-m rwa-end rwa-gray"></td>';
      const x = rewardCalc(c, m, doneOf[m]), v = (invByMonth[m] || []).find(i => i.contractId === c.id), has = x.n || x.up || x.sup || x.est;
      // 過去の月：スプレッドシートの請求の小計（税抜き）と比べる（2026-10-30 ユーザー指定）
      //  進行管理で計算できる → そのまま／シートと違う → 差を表示（同じになれば消える）／進行管理になくシートにある → シートの金額
      const sheet = m < INVOICE_START ? pastSubAcc(c, m) : null, acc = sheet != null && sheetAccepted(c, m), est = (x.est || 0) + (sheet != null && (x.est || 0) > 0 ? sheetExtra(c, m) : 0), diff = !acc && sheet != null && est > 0 && Math.abs(est - sheet) > 1 ? est - sheet : 0;
      const g = !v && !has && !(sheet > 0) && (m >= INVOICE_START || !pastBy(c, m)) ? ' rwa-none' : '';   /* 請求も担当記事もない月だけ濃いグレー（担当記事・報酬額がある月は記録がなくてもグレーにしない。2026-10-30 ユーザー指定） */
      const amt = acc && sheetWaived(c, m) ? '<b>' + yen0(0) + '</b><br><span class="note" title="' + esc(SHEET_WAIVE.get(c.id + '_' + m) || '') + '">特例で請求なし</span>'   /* 2026-11-05 */
        : acc ? '<b>' + yen0(sheet) + '</b><br><button type="button" class="linkbtn rwa-acc" data-rdiff="' + esc(c.id) + '|' + m + '" title="差異ありでOKにした月。押すと内訳と取り消し">スプレッドシートから引用</button>'
        : est > 0 ? '<b>' + yen0(est) + '</b>' + (diff ? '<br><button type="button" class="rwa-diff" data-rdiff="' + esc(c.id) + '|' + m + '" title="差の理由と直すところ">シート ' + yen0(sheet) + '（差 ' + (diff > 0 ? '+' : '−') + yen0(Math.abs(diff)) + '）▸</button>' : '')
        : sheet > 0 ? '<b>' + yen0(sheet) + '</b><br><span class="note">スプレッドシートから</span>' : '<span class="note">' + (x.est === 0 ? '¥0' : '—') + '</span>';
      const st = v ? '<button type="button" class="pill ' + (INV_STATUS[v.status] || ['', 'off'])[1] + ' inv-pill" data-invchk="' + esc(v.id) + '">' + (INV_STATUS[v.status] || [v.status])[0] + '</button>' + (v.checkedBy ? '<br><span class="note">' + invChecker(v).replace(/^<br>/, '') + '</span>' : '')
        : m < INVOICE_START ? pastCell(c, m, acc ? sheet : est > 0 ? est : sheet) : has ? '<span class="pill ng">要請求</span>' : '<span class="note">対応記事なし</span>';
      return '<td class="c-ctr rwa-m' + g + '">' + st + '</td><td class="c-num rwa-m' + g + '">' + (x.n || '<span class="note">0</span>') + '</td><td class="c-num rwa-m rwa-end' + g + '">' + amt + (x.dirLeft ? '<br><span class="note">＋ディレクション費</span>' : '') + '</td>';
    };
    /** 合計の差：進行管理とシートの両方に金額がある人の差を足したもの（2026-10-30 ユーザー指定） */
    /** その人のシートとの差の合計（過去の月。差がなければ空）（2026-10-31 ユーザー指定） */
    const personDiffVal = c => { let d = 0, n = 0; months.filter(m => m < INVOICE_START).forEach(m => { if (startOf(c) && m < startOf(c)) return; const e0 = rewardCalc(c, m, doneOf[m]).est || 0, s = pastSubAcc(c, m); if (!(e0 > 0) || s == null || sheetAccepted(c, m)) return; const e = e0 + sheetExtra(c, m); if (Math.abs(e - s) > 1) { d += e - s; n++; } }); return { d, n }; };
    const personDiff = c => { const { d, n } = personDiffVal(c); return n ? '<br><span class="rwa-diff">シートとの差 ' + (d > 0 ? '+' : '−') + yen0(Math.abs(d)) + '（' + n + 'か月）</span>' : ''; };
    /** 表全体のシートとの差（合計の行の名前の下。2026-10-31 ユーザー指定） */
    const allDiff = L => { let d = 0, n = 0, p = 0; L.forEach(c => { const v = personDiffVal(c); if (v.n) { d += v.d; n += v.n; p++; } }); return n ? '<br><span class="rwa-diff">シートとの差 ' + (d > 0 ? '+' : '−') + yen0(Math.abs(d)) + '（' + p + '人・' + n + 'か月）</span>' : ''; };
    const totDiff = (L, m) => { if (m >= INVOICE_START) return ''; let d = 0, n = 0; L.forEach(c => { const e0 = rewardCalc(c, m, doneOf[m]).est || 0, s = pastSubAcc(c, m), e = e0 > 0 && s != null ? e0 + sheetExtra(c, m) : e0; if (e > 0 && s != null && !sheetAccepted(c, m) && Math.abs(e - s) > 1) { d += e - s; n++; } }); return n ? '<br><span class="rwa-diff">シートとの差 ' + (d > 0 ? '+' : '−') + yen0(Math.abs(d)) + '（' + n + '人）</span>' : ''; };
    const sum = (L, m) => L.reduce((a, c) => { const e0 = rewardCalc(c, m, doneOf[m]).est || 0, s = m < INVOICE_START ? pastSubAcc(c, m) : null, e = s != null && sheetAccepted(c, m) ? s : e0 > 0 && s != null ? e0 + sheetExtra(c, m) : e0; return a + (e > 0 ? e : (s > 0 ? s : 0)); }, 0);   /* 進行管理になくシートにある月はシートの金額 */
    const table = L => '<div class="table-wrap am-scroll rwa-wrap"><table class="am-table rw-table rwa-table"><thead>'
      + '<tr><th class="c-txt rwa-name" rowspan="2">氏名</th><th class="c-txt rwa-pos" rowspan="2">ポジション</th><th class="c-txt rwa-pay" rowspan="2">契約内容</th>'
      + months.map((m, i) => '<th class="c-ctr rwa-mh rwa-end" colspan="3">' + (m === CUR_MONTH ? '今月の請求<br>' : '') + mLabel(m) + '<br><span class="note">' + esc(invMonthState(m, invByMonth[m] || [])) + '</span></th>').join('') + '</tr>'
      + '<tr>' + months.map(() => '<th class="c-ctr">請求状況</th><th class="c-num">担当記事</th><th class="c-num rwa-end">支払額（税抜き）</th>').join('') + '</tr></thead><tbody>'
      + '<tr class="total"><td class="c-txt rwa-name"><b>合計</b>' + allDiff(L) + '</td><td></td><td></td>' + months.map(m => '<td></td><td></td><td class="c-num rwa-end"><b>' + yen0(sum(L, m)) + '</b>' + totDiff(L, m) + '</td>').join('') + '</tr>'   /* 合計は表のいちばん上（2026-10-30 ユーザー指定） */
      + L.map(c => { const lv = onLeave(c), ending = ctStatus(c) === '解除予定', d = x => x ? Number(x.slice(5, 7)) + '/' + Number(x.slice(8, 10)) : '';
        if (sibIds.has(c.id)) return '<tr class="rwa-sib"><td class="c-txt rwa-name"><span class="note">└ 同じ人の別の契約</span><br><b>' + esc(c.name) + '</b><br><span class="note">' + esc((c.medias || []).map(mediaLabel).join('・')) + '：' + (c.endDate ? ymJp(String(c.endDate).slice(0, 7)) + 'で終了' : '契約解除') + '</span>' + personDiff(c) + '</td>'
          + '<td class="c-txt rwa-pos">' + esc(c.category === 'supervision' ? (c.title || '監修者') : c.position || '') + '</td><td class="c-txt rwa-pay">' + payLines(c).map((l, i) => i === 0 ? '<b>' + esc(l) + '</b>' : esc(l)).join('<br>') + '</td>' + months.map(m => cell(c, m)).join('') + '</tr>';
        return '<tr class="' + (lv ? 'ct-row-leave' : ending ? 'ct-row-ending' : '') + '"><td class="c-txt rwa-name"><b>' + esc(c.name) + '</b>' + (sibs.some(x => nk(x) === nk(c)) ? '<br><span class="note">' + esc(sibs.filter(x => nk(x) === nk(c)).map(x => (x.medias || []).map(mediaLabel).join('・') + '：' + (x.endDate ? ymJp(String(x.endDate).slice(0, 7)) + 'で終了' : '契約解除')).join('、')) + '（下の行）</span>' : '') + (lv ? '<br><span class="note">休職中（' + d(c.leaveStart) + '〜' + (c.leaveEnd ? d(c.leaveEnd) : '復職日未定') + '）</span>' : ending ? '<br><span class="note">契約解除予定（' + d(c.endDate) + '）</span>' : '') + personDiff(c) + '</td>'
          + '<td class="c-txt rwa-pos">' + esc(c.category === 'supervision' ? (c.title || '監修者') : c.position || '') + '</td><td class="c-txt rwa-pay">' + payLines(c).map((l, i) => i === 0 ? '<b>' + esc(l) + '</b>' : esc(l)).join('<br>') + '</td>'
          + months.map(m => cell(c, m)).join('') + '</tr>'; }).join('')
      + '</tbody></table></div>';
    $('rw-body').innerHTML = H((asc ? '業務委託費（契約者単位）' : '報酬管理一覧') + ' <small>契約中・' + (asc ? '過去の月から今月へ（右が最新）' : '今月から過去の月へ') + '（横にスクロール）</small>', ['契約管理', '記事管理']) + table(list)
      + '<p class="note">支払額（税抜き）は契約内容の単価×その月に完了した担当記事（過去の月はスプレッドシートの請求と照合）。請求状況はこのWEBアプリでの請求（' + ymJp(INVOICE_START) + '分から）。状態を押すと請求書と確認の画面が開きます。</p>';
    if (ended.length) { const e = $('rw-body-ended'); e.hidden = false; e.innerHTML = H((asc ? '業務委託費（契約者単位）' : '報酬管理一覧') + ' <small>契約解除・' + (asc ? '過去の月から今月へ（右が最新）' : '今月から過去の月へ') + '（横にスクロール）</small>', ['契約管理', '記事管理']) + table(ended) + '<p class="note">契約解除日より後の月は「契約終了」です。</p>'; }
    document.querySelectorAll('[data-invchk]').forEach(b => b.onclick = () => { const v = Object.values(invByMonth).flat().find(x => x.id === b.dataset.invchk); if (v) invCheckModal(v, render); });
    document.querySelectorAll('[data-rdiff]').forEach(b => b.onclick = () => { const [id, m] = b.dataset.rdiff.split('|'), c = list.concat(ended).find(x => x.id === id); if (c) sheetDiffModal(c, m, rewardCalc(c, m, doneOf[m])); });
    // 表の上にも横スクロールのバーを付ける（下までスクロールしなくても横に動かせるように。2026-10-30 ユーザー指定）
    document.querySelectorAll('.rwa-wrap').forEach(w => {
      const bar = document.createElement('div'); bar.className = 'rwa-topscroll'; bar.innerHTML = '<div></div>'; w.parentNode.insertBefore(bar, w); { const tb = document.querySelector('.topbar'); bar.style.top = (tb ? Math.round(tb.getBoundingClientRect().height) : 0) + 'px'; }   /* 上の帯の下に止まる */
      const size = () => { bar.firstChild.style.width = w.scrollWidth + 'px'; bar.hidden = w.scrollWidth <= w.clientWidth + 1; }; size(); setTimeout(size, 300);
      const sync = (from, to) => () => { if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft; };
      bar.addEventListener('scroll', sync(bar, w)); w.addEventListener('scroll', sync(w, bar));
      if (asc) { const toEnd = () => { w.scrollLeft = w.scrollWidth; bar.scrollLeft = bar.scrollWidth; }; toEnd(); setTimeout(toEnd, 350); }   /* はじめは最新月（右端） */
    });
    document.querySelectorAll('.rwa-table').forEach(t => { const r1 = t && t.tHead.rows[0]; if (r1) { const h = r1.cells[3] ? r1.cells[3].getBoundingClientRect().height : 0; [...t.tHead.rows[1].cells].forEach(th => { th.style.top = h + 'px'; }); } });   /* 見出し2段目は1段目の高さの下に固定 */
  } };
}
/** 稼働表（ディレクション費が時間単価の人。見本＝管理シート(Dir)）（2026-10-28 ユーザー指定） */
const TS_W = [['writing', 'ライティング'], ['image', '画像作成'], ['upload', 'アップロード'], ['rewrite', 'リライト']];
const TS_D = [['meeting', '1.ミーティング'], ['strategy', '2.戦略立案'], ['production', '3.制作管理'], ['operation', '4.運用管理'], ['team', '5.チームマネジメント'], ['knowledge', '6.ナレッジ共有']];
/** 時間単価のディレクション費（またはオプションの時間単価）の単価。なければ null */
const tsRate = c => { const p = c.pay || {}, d = (p.direction || []).find(x => /時間/.test(x.cond || '')); return d && d.amount != null ? Number(d.amount) : p.hourOn && p.hour != null ? Number(p.hour) : null; };
const tsSum = (days, grp) => Object.values(days || {}).reduce((a, x) => a + (grp ? Object.values(x[grp] || {}) : Object.values(x.w || {}).concat(Object.values(x.d || {}))).reduce((b, v) => b + (Number(v) || 0), 0), 0);
const hFmt = v => (Math.round(v * 100) / 100).toLocaleString('ja-JP');
/** 何か月分の稼働表をまとめて読む（1人1回） */
async function loadTimesheetsMany(cs, months) { for (const c of cs) { if (tsRate(c) == null) continue; c._ts = c._ts || {}; const need = months.filter(m => !c._ts[m]); if (!need.length) continue; const r = await api('/contracts/' + encodeURIComponent(c.id) + '/timesheets?months=' + need.join(',')).catch(() => ({ months: {} })); need.forEach(m => { c._ts[m] = (r.months || {})[m] || { days: {}, canEdit: false }; }); } }
async function loadTimesheets(cs, ym) { for (const c of cs) { if (tsRate(c) == null) continue; c._ts = c._ts || {}; if (!c._ts[ym]) c._ts[ym] = await api('/contracts/' + encodeURIComponent(c.id) + '/timesheet/' + ym).catch(() => ({ days: {}, canEdit: false })); } }
/** 稼働表の画面（月の日ごと） */
function timesheetHtml(c, ym) {
  const t = (c._ts || {})[ym] || { days: {} }, rate = tsRate(c), ed = !!t.canEdit, n = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0).getDate();
  const inp = (day, grp, k, v) => '<input class="ts-in" type="number" min="0" max="24" step="0.25" data-tsd="' + day + '" data-tsg="' + grp + '" data-tsk="' + k + '" value="' + (v == null ? '' : v) + '"' + (ed ? '' : ' disabled') + '>';
  const rows = Array.from({ length: n }, (_, i) => { const day = String(i + 1).padStart(2, '0'), x = t.days[day] || {}, dt = new Date(ym + '-' + day + 'T00:00:00'), wd = '日月火水木金土'[dt.getDay()];
    const dirH = TS_D.reduce((a, [k]) => a + (Number((x.d || {})[k]) || 0), 0), wH = TS_W.reduce((a, [k]) => a + (Number((x.w || {})[k]) || 0), 0);
    return '<tr class="' + (dt.getDay() === 0 || dt.getDay() === 6 ? 'ts-off' : '') + '"><td class="c-ctr">' + Number(day) + '</td><td class="c-ctr">' + wd + '</td><td class="c-ctr">' + inp(day, '', 'plan', x.plan) + '</td><td class="c-txt"><input class="ts-note" data-tsd="' + day + '" data-tsg="" data-tsk="planNote" value="' + esc(x.planNote || '') + '"' + (ed ? '' : ' disabled') + '></td>'
      + TS_W.map(([k]) => '<td class="c-ctr">' + inp(day, 'w', k, (x.w || {})[k]) + '</td>').join('') + TS_D.map(([k]) => '<td class="c-ctr">' + inp(day, 'd', k, (x.d || {})[k]) + '</td>').join('')
      + '<td class="c-txt"><input class="ts-note" data-tsd="' + day + '" data-tsg="" data-tsk="note" value="' + esc(x.note || '') + '"' + (ed ? '' : ' disabled') + '></td><td class="c-num">' + hFmt(wH + dirH) + '</td><td class="c-num">' + hFmt(dirH) + '</td><td class="c-num">' + yen0(dirH * rate) + '</td></tr>'; }).join('');
  const dirT = tsSum(t.days, 'd'), wT = tsSum(t.days, 'w');
  return '<div class="ts-wrap"><h3 class="am-h">稼働表 <span class="note">' + mLabel(ym) + '・時間は15分単位（15分＝0.25・30分＝0.5・45分＝0.75・60分＝1）。前月分は毎月2日まで、次月の稼働予定は毎月20日までに入力してください</span></h3>'
    + '<div class="kpis rwp-kpis"><div class="kpi"><span>ディレクター業務</span><b>' + hFmt(dirT) + '時間</b></div><div class="kpi"><span>ライター業務</span><b>' + hFmt(wT) + '時間</b></div><div class="kpi"><span>ディレクター業務の報酬（' + yen0(rate) + '／時間・税抜き）</span><b>' + yen0(dirT * rate) + '</b></div></div>'
    + '<div class="table-wrap am-scroll"><table class="am-table ts-table"><thead><tr><th class="c-ctr" rowspan="2">日</th><th class="c-ctr" rowspan="2">曜日</th><th class="c-ctr" rowspan="2">予定時間</th><th class="c-txt" rowspan="2">予定内容</th><th class="c-ctr ts-gw" colspan="4">ライター業務（時間）</th><th class="c-ctr ts-gd" colspan="6">ディレクター業務（時間）</th><th class="c-txt" rowspan="2">詳細</th><th class="c-num" rowspan="2">合計</th><th class="c-num" rowspan="2">ディレクター</th><th class="c-num" rowspan="2">報酬額</th></tr><tr>'
    + TS_W.map(([, l]) => '<th class="c-ctr ts-gw">' + l + '</th>').join('') + TS_D.map(([, l]) => '<th class="c-ctr ts-gd">' + l + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + (ed ? '<div class="row" style="justify-content:flex-end; margin-top:8px"><span class="note" style="margin-right:auto">' + (t.updatedAt ? '最終保存：' + esc(String(t.updatedAt).slice(0, 16).replace('T', ' ')) : 'まだ保存していません') + '</span><button class="btn primary" type="button" data-tssave="' + esc(c.id) + '">稼働表を保存</button></div>' : '')
    + '<p class="note">ライター業務（ライティング・画像作成・アップロード・リライト）は記録用で、報酬は文字数・枚数・本数の単価で別に計算します。報酬額＝ディレクター業務の時間×時間単価です。</p></div>';
}
/** 構成を担当した／していない記事の出し分け（表示だけ） */
function bindOutlineFilter(box) {
  box.querySelectorAll('.rwp-olf').forEach(seg => seg.querySelectorAll('[data-olf]').forEach(b => b.onclick = () => {
    seg.querySelectorAll('[data-olf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const tb = seg.nextElementSibling; tb.querySelectorAll('tbody tr').forEach(tr => { tr.hidden = b.dataset.olf !== 'all' && tr.dataset.ol !== b.dataset.olf; });
  }));
}
function bindTimesheets(box, cs, ym, onSaved) {
  bindOutlineFilter(box);
  box.querySelectorAll('[data-tssave]').forEach(b => b.onclick = async () => {
    const c = cs.find(x => x.id === b.dataset.tssave), wrap = b.closest('.ts-wrap'), days = {};
    wrap.querySelectorAll('[data-tsd]').forEach(el => { const d = el.dataset.tsd, g = el.dataset.tsg, k = el.dataset.tsk, o = (days[d] = days[d] || { w: {}, d: {} }); if (g) o[g][k] = el.value; else o[k] = el.value; });
    try { await apiSend('PUT', '/contracts/' + encodeURIComponent(c.id) + '/timesheet/' + ym, { days }); delete c._ts[ym]; toast('稼働表を保存しました'); onSaved(); } catch (e) { alert(e.message); }
  });
}
/** 報酬の単価を決める種類。シートで「リライト(30%〜50%)」の記事はリライトの単価（本数の数え方は簡易リライトのまま）（2026-10-28 ユーザー指定） */
const payType = r => /^リライト[（(]30[%％]?[～〜~-]50[%％][）)]$/.test(String(r.type_raw || '').trim()) ? 'リライト' : (r.type || '新規');
/** 報酬額：契約内容の単価 × その月にアップロードした担当記事。担当者名は紐づけた名前でも照合（2026-10-28） */
const RW_ROLE_KEY = { direction: 'director', writing: 'writer', supervision: 'supervisor' };
function rewardCalc(c, ym, done) {
  done = ownView(c, dedupeArts(done.filter(r => billableFor(c, r) && (!r.bill_ym || billMonthFor(c, r) === ym))));   // カギ・ガラスは幸谷さんの請求だけ。請求月はその人の分（billMonthFor）
  const past = (c.pastPays || []).find(x => x.from <= ym && ym <= x.to);   // 以前の契約の期間の月は、その時の契約内容
  const is = (v, media) => !!v && (v === c.name || personName(v, media) === c.name);
  const p = (past && past.pay) || c.pay || {}, k = p.type === '文字単価' ? 'writer' : (RW_ROLE_KEY[c.category] || 'writer'), by = key => done.filter(r => is(r[key], r.media));   /* 文字単価の人は執筆担当の記事（2026-10-31） */
  const main = by(k), up = by('upload_owner').filter(r => !p.uploadNewOnly || payType(r) === '新規'), sup = by('supervisor'), img = done.filter(r => is(r.image_owner || r.writer, r.media));
  const n = main.length, chars = main.reduce((a, r) => a + (Number(r.chars) || 0), 0), images = img.reduce((a, r) => a + (Number(r.image_count) || 0), 0);
  const mine = done.filter(r => ['director', 'writer', 'upload_owner', 'supervisor'].some(x => is(r[x], r.media)));
  let est = null; const add = v => { if (v != null && isFinite(v)) est = (est || 0) + v; };
  if (p.type === '記事単価') {
    const cnt = t => main.filter(r => payType(r) === t).length, aNew = p.articleNew ?? p.article;
    if (aNew != null) add(aNew * (cnt('新規') + cnt('リライト(新規)'))); if (p.articleRewrite != null) add(p.articleRewrite * cnt('リライト')); if (p.articleLite != null) add(p.articleLite * cnt('簡易リライト'));
    if (p.upload != null) add(p.upload * up.length);
  }
  /* 構成担当：ディレクション担当の欄が自分、または「（構成作成：名前）」が自分（2026-10-31 ユーザー指定） */
  const olr = (p.direction || []).find(d => /構成/.test(d.cond || '') && /文字/.test(d.cond || '') && d.amount != null), olName = r => { const m = String(r.director || '').match(/構成(?:作成|案)?s*[：:]s*([^）)、,／/]+)/); return m ? m[1].trim() : ''; };
  const outline = olr ? done.filter(r => is(r.director, r.media) || (olName(r) && is(olName(r), r.media))) : [], outlineChars = outline.reduce((a, r) => a + (Number(r.chars) || 0), 0);
  /* 構成も執筆も自分の記事は、文字単価ではなく構成の単価（尾崎さん：構成案作成の場合 3円。2026-10-31 ユーザー指定） */
  const olOver = p.type === '文字単価' && k === 'writer' ? outline.filter(r => main.includes(r)) : [], olOverChars = olOver.reduce((a, r) => a + (Number(r.chars) || 0), 0);
  if (p.type === '文字単価') { if (p.char != null) add(p.char * (chars - olOverChars)); if (p.image != null) add(p.image * images); if (p.upload != null) add(p.upload * up.length); }
  if (p.superviseOn && p.supervise != null) add(p.supervise * sup.length);
  if (olr) add(Number(olr.amount) * outlineChars);   // 構成担当の記事の文字数 × 構成の文字単価（執筆も自分の記事は上で文字単価を引いている）
  // ディレクション費の条件が「監修ありの記事」「監修なしの記事」：ディレクション担当の記事ごとに、監修有無で単価（2026-10-30 ユーザー指定）
  const amt = d => d && d.amount !== '' && d.amount != null && isFinite(Number(d.amount)) ? Number(d.amount) : null;
  const supD = (p.direction || []).find(d => /監修あり/.test(d.cond || '') && amt(d) != null), noSupD = (p.direction || []).find(d => /監修なし/.test(d.cond || '') && amt(d) != null);
  const hasSup = r => r.supervision === 'あり' || (!r.supervision && !!String(r.supervisor || '').trim() && !/^(不要|なし|無し|ー|－|-|—|×)$/.test(String(r.supervisor || '').trim()));   /* 監修担当が「不要」は監修なし（東さんの BEST365 水回り。2026-10-31） */
  const dirArts = supD || noSupD ? by('director') : [], dirSup = supD ? dirArts.filter(hasSup) : [], dirNoSup = noSupD ? dirArts.filter(r => !hasSup(r)) : [];
  if (supD) add(amt(supD) * dirSup.length); if (noSupD) add(amt(noSupD) * dirNoSup.length);
  // プレスリリース：その月に公開した担当のリリース × プレスリリース単価（2026-10-31 ユーザー指定）
  /* 契約の pay.pressSameMonth があればリリース日の月の報酬（種石さん。2026-11-02） */
  const pressMode = p.press != null && p.press !== '' ? 'fixed' : p.type === '記事単価' && (p.articleNew ?? p.article) != null ? 'article' : p.type === '文字単価' && p.char != null ? 'char' : '';
  const pressRate = pressMode === 'fixed' ? Number(p.press) : pressMode === 'article' ? Number(p.articleNew ?? p.article) : pressMode === 'char' ? Number(p.char) : null;
  const press = pressMode ? (PRESS_ITEMS || []).filter(x => x.status !== '中止' && (x.published || (x.date && String(x.date) <= todayJst())) && (x.billYm ? x.billYm === ym : String(x.date || '').slice(0, 7) === (p.pressSameMonth ? ym : shiftMonth(ym, 1))) && x.media !== '__kurashi' && billableFor(c, { media: x.media, upload_date: ym + '-01', status: '' })   /* リリース日の前の月の報酬（原稿を書き終えた月に近い。2026-10-31 ユーザー指定） */ && is(pressOwner(x), x.media)) : [];
  const pressChars = press.reduce((a, x) => a + (Number(x.chars) || 0), 0), pressAmt = pressMode === 'char' ? pressRate * pressChars : (pressRate || 0) * press.length;
  if (press.length) add(pressAmt);
  const prM = (PRESS_ITEMS || []).filter(x => x.status !== '中止' && (x.published || (x.date && String(x.date) <= todayJst())) && (x.billYm ? x.billYm === ym : String(x.date || '').slice(0, 7) === (p.pressSameMonth ? ym : shiftMonth(ym, 1))) && x.media !== '__kurashi' && billableFor(c, { media: x.media, upload_date: ym + '-01', status: '' }));
  const pressImg = p.type === '文字単価' && p.image != null ? prM.filter(x => is(x.imageOwner || pressOwner(x), x.media)).reduce((a, x) => a + (Number(x.imageCount) || 0), 0) : 0, pressUp = p.upload != null ? prM.filter(x => is(x.uploadOwner, x.media)).length : 0;
  if (pressImg) add(Number(p.image) * pressImg); if (pressUp) add(Number(p.upload) * pressUp);
  const tsr = tsRate(c), ts = (c._ts || {})[ym], dirHours = ts ? tsSum(ts.days, 'd') : null;
  if (tsr != null && dirHours != null) add(dirHours * tsr);   // 稼働表のディレクター業務の時間 × 時間単価（2026-10-28）
  const dirLeft = (p.direction || []).filter(d => !(/時間/.test(d.cond || '') && tsr != null) && d !== olr && d !== supD && d !== noSupD).length > 0;   // まだ自動で計算できないディレクション費
  return { pressImg, pressUp, press, pressMode, pressRate, pressChars, pressAmt, pressNoChars: pressMode === 'char' ? press.filter(x => !(Number(x.chars) > 0)).length : 0, dirSup, dirNoSup, dirSupRate: supD ? amt(supD) : null, dirNoSupRate: noSupD ? amt(noSupD) : null, hasSup, outline, outlineChars, outlineRate: olr ? Number(olr.amount) : null, olOverChars, dirLeft, dirHours, tsRate: tsr, n, chars, images, all: mine.length, mine, main, upList: up, supList: sup, imgList: img, k, up: up.length, sup: sup.length, est, hourly: !!p.hourOn, direction: (p.direction || []).length > 0, pay: p, past: !!past };
}
/** 1人分の報酬の画面（業務委託の本人の画面と、BEST社員の「操作画面確認」で共通） */
function rewardPersonHtml(cs, ym, months) {
  const done = ITEMS.filter(r => paidIn(r, ym));
  return '<div class="row" style="margin-bottom:10px"><label class="field">対象月<select id="rwp-ym">' + months.map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + (m === CUR_MONTH ? '（途中）' : '') + '</option>').join('') + '</select></label></div>'
    + cs.map(c => { const x = rewardCalc(c, ym, done), p = x.pay || {};
      const tyCnt = t => x.main.filter(r => payType(r) === t).length, ROLE_L = { director: 'ディレクション', writer: '執筆', supervisor: '監修' };
      // 数字のカード：契約内容に単価がある項目だけ。文字数はいつも出す
      const cards = [];
      if (p.type === '記事単価') {
        if ((p.articleNew ?? p.article) != null) { cards.push(['新規記事', tyCnt('新規') + '本']); if (tyCnt('リライト(新規)')) cards.push(['リライト(新規)', tyCnt('リライト(新規)') + '本']); }
        if (p.articleRewrite != null) cards.push(['リライト', tyCnt('リライト') + '本']);
        if (p.articleLite != null) cards.push(['簡易リライト', tyCnt('簡易リライト') + '本']);
        if ((p.articleNew ?? p.article) == null && p.articleRewrite == null && p.articleLite == null && x.k !== 'supervisor') cards.push([ROLE_L[x.k] + 'の記事', x.n + '本']);
      } else if (x.k !== 'supervisor' || !p.superviseOn) cards.push([(ROLE_L[x.k] || '担当') + 'の記事', x.n + '本']);
      if (p.superviseOn) cards.push(['監修', x.sup + '本']);
      cards.push(['文字数', nf.format(x.chars)]);
      if (p.type === '文字単価' && p.image != null) cards.push(['画像', nf.format(x.images) + '枚']);
      if (p.upload != null) cards.push(['アップロード', x.up + '本']);
      if (x.tsRate != null) cards.push(['ディレクター業務', hFmt(x.dirHours || 0) + '時間']);
      if (x.outlineRate != null) cards.push(['構成（' + x.outline.length + '本）の文字数', nf.format(x.outlineChars)]);
      if (x.dirSupRate != null) cards.push(['ディレクション（監修あり）', x.dirSup.length + '本']);
      if (x.dirNoSupRate != null) cards.push(['ディレクション（監修なし）', x.dirNoSup.length + '本']);
      cards.push(['報酬額（税抜き）' + (x.past ? '・以前の契約内容' : ''), yen0(x.est)]);   /* 税抜きと補足（2026-10-28 ユーザー指定） */
      // 表：請求に関係する担当の記事だけ（主の担当＋単価があるアップロード・監修・画像）
      const keys = [x.k].concat(p.upload != null ? ['upload_owner'] : [], p.superviseOn ? ['supervisor'] : [], (x.outlineRate != null || x.dirSupRate != null || x.dirNoSupRate != null) && x.k !== 'director' ? ['director'] : []), showImg = p.type === '文字単価' && p.image != null;
      const isMe = (v, media) => !!v && (v === c.name || personName(v, media) === c.name);
      const rows = ownView(c, dedupeArts(done.filter(r => billableFor(c, r)))).filter(r => keys.some(k => isMe(r[k], r.media)) || (showImg && isMe(r.image_owner || r.writer, r.media)));
      // 記事ごとの金額（契約内容の単価で。稼働表の分は入らない）
      const artPay = r => { let v = 0; const tyP = { 新規: p.articleNew ?? p.article, 'リライト(新規)': p.articleNew ?? p.article, リライト: p.articleRewrite, 簡易リライト: p.articleLite }[payType(r)];
        if (isMe(r[x.k], r.media)) { if (p.type === '記事単価' && x.k !== 'supervisor' && tyP != null) v += Number(tyP); if (p.type === '文字単価' && p.char != null) v += p.char * (Number(r.chars) || 0); }
        if (p.type === '文字単価' && p.image != null && isMe(r.image_owner || r.writer, r.media)) v += p.image * (Number(r.image_count) || 0);
        if (p.upload != null && isMe(r.upload_owner, r.media) && (!p.uploadNewOnly || payType(r) === '新規')) v += Number(p.upload);
        if (p.superviseOn && p.supervise != null && isMe(r.supervisor, r.media)) v += Number(p.supervise);
        if (x.outlineRate != null && isMe(r.director, r.media)) v += x.outlineRate * (Number(r.chars) || 0);
        if (isMe(r.director, r.media)) { if (x.hasSup(r) && x.dirSupRate != null) v += x.dirSupRate; if (!x.hasSup(r) && x.dirNoSupRate != null) v += x.dirNoSupRate; }
        return v; };
      const isOl = r => x.outlineRate != null && isMe(r.director, r.media);
      const grpRow = (l, rs) => '<tr><td class="c-txt"><b>' + l + '</b></td><td class="c-num">' + rs.length + '本</td><td class="c-num">' + nf.format(rs.reduce((a, r) => a + (Number(r.chars) || 0), 0)) + '</td>' + (showImg ? '<td class="c-num">' + nf.format(rs.reduce((a, r) => a + (Number(r.image_count) || 0), 0)) + '枚</td>' : '') + '<td class="c-num"><b>' + yen0(rs.reduce((a, r) => a + artPay(r), 0)) + '</b></td></tr>';
      const olSummary = x.outlineRate == null ? '' : '<div class="table-wrap"><table class="am-table rwp-split"><thead><tr><th class="c-txt">区分</th><th class="c-num">記事数</th><th class="c-num">文字数</th>' + (showImg ? '<th class="c-num">画像</th>' : '') + '<th class="c-num">金額（税抜き）</th></tr></thead><tbody>'
        + grpRow('合計の担当記事', rows) + grpRow('構成担当', rows.filter(isOl)) + grpRow('構成未担当', rows.filter(r => !isOl(r))) + '</tbody></table></div>';
      const olTabs = x.outlineRate == null ? '' : '<div class="seg rwp-olf" role="group">' + [['all', '合計'], ['ol', '構成担当'], ['nol', '構成未担当']].map(([k, l], i) => '<button type="button" data-olf="' + k + '" aria-pressed="' + (i === 0) + '">' + l + '</button>').join('') + '</div>';
      const roleTxt = r => keys.filter(k => isMe(r[k], r.media)).map(k => ({ director: x.outlineRate != null ? '構成' : 'ディレクション', writer: '執筆', upload_owner: 'アップロード', supervisor: '監修' })[k]).concat(showImg && isMe(r.image_owner || r.writer, r.media) && !keys.includes('writer') ? ['画像'] : []).join('・');
      return '<div class="rwp-card"><div class="rwp-head"><b>' + esc(c.name) + '</b><span class="note">' + esc(CAT_LABEL[c.category] || '') + '・' + esc(c.category === 'supervision' ? (c.title || '監修者') : c.position) + '・' + esc((c.medias || []).map(mediaLabel).join('、')) + '</span></div>'
        + '<div class="kpis rwp-kpis">' + cards.map(([l, v]) => '<div class="kpi"><span>' + esc(mLabel(ym) + 'の' + l).replace(mLabel(ym) + 'の報酬額', '報酬額') + '</span><b>' + v + '</b></div>').join('') + '</div>'
        + olSummary
        + '<p class="note">契約内容：' + esc(payLabel(c)) + (x.tsRate != null ? '　（時間単価の分は下の稼働表から計算）' : x.hourly ? '　＋時間単価分（稼働時間が必要）' : '') + (x.outlineRate != null ? '　（構成案作成の分は、構成担当の記事の文字数×' + x.outlineRate + '円で計算）' : '') + (x.dirLeft ? '　＋ディレクション費（条件による）' : '') + '</p>'
        + (rows.length ? olTabs + '<div class="table-wrap"><table class="am-table rwp-list"><thead><tr><th class="c-ctr">アップロード日</th><th class="c-txt">メディア</th><th class="c-txt">検索KW</th><th class="c-txt">記事タイトル</th><th class="c-ctr">種類</th><th class="c-txt">担当</th><th class="c-num">文字数</th>' + (showImg ? '<th class="c-num">画像</th>' : '') + '</tr></thead><tbody>'
          + rows.sort((a, b) => String(b.upload_date).localeCompare(String(a.upload_date))).map(r => '<tr data-ol="' + (isOl(r) ? 'ol' : 'nol') + '"><td class="c-ctr">' + esc(String(r.upload_date).slice(5).replace('-', '/')) + '</td><td class="c-txt">' + esc(mediaLabel(r.media)) + '</td><td class="c-txt">' + esc(r.kw || '') + '</td><td class="c-txt c-title">' + (r.url ? '<a href="' + escUrl(r.url) + '" target="_blank" rel="noopener">' + esc(r.title || r.url) + '</a>' : esc(r.title || '—')) + '</td><td class="c-ctr">' + esc(payType(r)) + '</td><td class="c-txt">' + esc(roleTxt(r)) + '</td><td class="c-num">' + (r.chars ? nf.format(r.chars) : '—') + '</td>' + (showImg ? '<td class="c-num">' + (r.image_count ? nf.format(r.image_count) : '—') + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>'
          : '<p class="empty">' + mLabel(ym) + 'に完了した中で担当した記事はありません。</p>') + (x.tsRate != null ? timesheetHtml(c, ym) : '') + '</div>'; }).join('')
    + '<p class="note">担当記事は、その月に完了した（アップロード日が入った）記事のうち、あなたが担当（ディレクション・執筆・アップロード・監修）の記事です。報酬額は契約内容の単価×本数で計算した税抜きの金額です（消費税は含みません）。</p>';
}
const RW_MONTHS = () => Array.from({ length: 12 }, (_, i) => shiftMonth(CUR_MONTH, -i));   /* 報酬の対象月は今月＋過去11か月（2026-10-29 ユーザー指定） */
/** 業務委託の本人：自分の報酬だけ */
function viewRewardMe() {
  const ym = state.rwpYm = state.rwpYm || CUR_MONTH;
  return { html: '<section class="panel" id="rwp-inv"><p class="loading">読み込み中…</p></section><section class="panel" id="rwp-body"><p class="loading">読み込み中…</p></section>', view: '報酬（本人）', after: async () => {
    await loadItems();
    const cs = ((await api('/my-reward-contracts')).contracts || []).filter(c => c.category !== 'site');
    if (cs.length) drawInvoicePanel($('rwp-inv'), cs); else $('rwp-inv').remove();   /* 請求（2026-10-29 ユーザー指定） */
    await loadTimesheets(cs, ym);
    $('rwp-body').innerHTML = H('報酬 <small>' + esc((me && me.name) || '') + '</small>', ['契約管理', '記事管理'], manualBtn('contractor')) + (cs.length ? rewardPersonHtml(cs, ym, RW_MONTHS()) : '<p class="empty">あなたのメールアドレスの契約が見つかりません。管理者にお問い合わせください。</p>');
    if ($('rwp-ym')) $('rwp-ym').onchange = ev => { state.rwpYm = ev.target.value; render(); };
    bindTimesheets($('rwp-body'), cs, ym, render);
  } };
}
/** BEST社員：業務委託の人それぞれの画面がどう見えるか（プルダウンで選ぶ） */
/** 人の選択リスト：名前｜ポジション　担当（メイン＝青・サブ＝黄の枠） */
const billRank = c => ({ メイン: 0, サブ: 1 })[billRole(c)] ?? 2;   /* メインを上に */
const billTag = c => { const r = billRole(c); return r ? '<span class="wp-tag wp-' + (r === 'メイン' ? 'main' : 'sub') + '">' + r + '</span>' : ''; };
const whoLine = c => '<span class="wp-name">' + esc(c.name) + '</span><span class="wp-sep">｜</span><span class="wp-pos">' + esc(c.category === 'supervision' ? (c.title || '監修者') : c.position || '') + '</span>' + billTag(c);
function whoPicker(list, cur) {
  const c = list.find(x => x.id === cur);
  return '<div class="wp" id="wp"><button type="button" class="wp-btn" id="wp-btn" aria-haspopup="listbox">' + (c ? whoLine(c) : '選んでください') + '<span class="wp-arrow">▾</span></button>'
    + '<div class="wp-list" id="wp-list" role="listbox" hidden>' + list.map(x => '<button type="button" role="option" class="wp-opt' + (x.id === cur ? ' on' : '') + '" data-wp="' + esc(x.id) + '">' + whoLine(x) + '</button>').join('') + '</div></div>';
}
function bindWhoPicker(onPick) {
  const btn = $('wp-btn'), lst = $('wp-list'); if (!btn) return;
  btn.onclick = ev => { ev.stopPropagation(); lst.hidden = !lst.hidden; if (!lst.hidden) { const on = lst.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' }); } };
  lst.querySelectorAll('[data-wp]').forEach(b => b.onclick = () => { lst.hidden = true; onPick(b.dataset.wp); });
  const close = ev => { if (!document.body.contains(lst)) return document.removeEventListener('click', close); if (!ev.target.closest('#wp')) lst.hidden = true; };
  document.addEventListener('click', close);
}
function viewRewardPreview() {
  const ym = state.rwpYm = state.rwpYm || CUR_MONTH;
  return { html: '<section class="panel" id="rwp-body"><p class="loading">読み込み中…</p></section>', view: '報酬：操作画面確認', after: async () => {
    await loadItems();
    const pf = state.rwpPos = state.rwpPos || {};
    const data = await loadContracts(), onlyMine = state.rwpOnlyMine !== false, list = data.contracts.filter(c => c.active && c.category !== 'site' && posMatch(c.position, pf) && (!onlyMine || !!billRole(c))).sort((a, b) => billRank(a) - billRank(b) || String(a.name).localeCompare(b.name, 'ja'));
    if (!list.some(c => c.id === state.rwpWho)) state.rwpWho = (list[0] || {}).id;
    const c = list.find(x => x.id === state.rwpWho), shown = c ? list.filter(x => x.email && c.email ? x.email === c.email : x.id === c.id) : [];
    await loadTimesheets(shown, ym);
    $('rwp-body').innerHTML = H('操作画面確認 <small>業務委託の人に見えている「報酬」の画面</small>', ['契約管理', '記事管理'])
      + '<div class="row" style="margin-bottom:10px; flex-wrap:wrap; align-items:flex-end"><label class="field" style="flex-direction:row; align-items:center; gap:6px"><input type="checkbox" id="rwp-mine"' + (onlyMine ? ' checked' : '') + '>担当のみ表示</label>' + posFilterHtml(data.positions.filter(x => x !== 'サイト作成・修正'), pf) + '<div class="field">業務委託契約者の表示画面' + whoPicker(list, state.rwpWho) + '</div></div>'
      + (c ? '<div class="rwp-preview"><section class="panel" id="rwp-inv-prev"><p class="loading">読み込み中…</p></section>' + rewardPersonHtml(shown, ym, RW_MONTHS()) + '</div>' : '<p class="empty">' + (onlyMine ? 'あなたが請求担当の人がいません。契約管理で「請求担当」を設定するか、「担当のみ表示」のチェックを外してください。' : '契約中の業務委託の人がいません。') + '</p>');
    bindWhoPicker(id => { state.rwpWho = id; render(); });
    $('ct-grp-f').onchange = ev => { pf.grp = ev.target.value; pf.pos = ''; render(); };
    $('ct-pos-f').onchange = ev => { pf.pos = ev.target.value; render(); };
    $('rwp-mine').onchange = ev => { state.rwpOnlyMine = ev.target.checked; render(); };
    bindTimesheets($('rwp-body'), shown, ym, render);
    if ($('rwp-ym')) $('rwp-ym').onchange = ev => { state.rwpYm = ev.target.value; render(); };
    if ($('rwp-inv-prev')) drawInvoicePanel($('rwp-inv-prev'), shown, true);   /* 請求の部分（確認用。2026-10-29） */
  } };
}

// ================= 収益管理：月次・期間比較（kintone＋アフィリエイトの合計。2026-10-14 ユーザー指定） =================
// kintone＝加盟店（SEO回線）の収益、アフィリエイト＝もしものCSV（なければスプレッドシート）。どちらも税抜き
const REV_PARTS = [['revenue', '合計', ''], ['revPartner', 'kintone（加盟店）', 'kintone'], ['revAffiliate', 'アフィリエイト', 'ASP']];   // 合計をいちばん左に（2026-10-14 ユーザー指定）
const revNote = '<p class="note">kintone は加盟店（SEO回線）の収益（控除後・税抜き）、アフィリエイトはもしもアフィリエイトの承認成果金額（税抜き。CSVがない月はスプレッドシートの値÷1.1）。前年比・期間比は（今の値÷比べる値）。100%より上（緑）＝増えた、下（赤）＝減った。</p>';
function viewRevTotal(mode) {
  const media = revMedia(), id = media === ALL ? ALL : media, name = media === ALL ? 'メディア累計' : mediaLabel(media);
  if (!MONTHLY || !Object.keys(MONTHLY).length) return { html: '<section class="panel">' + H('収益', ['kintone', 'ASP']) + '<p class="empty">この画面は「メディア数値」を見る権限がある人だけ表示できます。</p></section>', view: '収益管理', after: async () => renderArtMediaSelect() };
  if (mode === 'monthly') {
    const months = MONTHS.filter(m => m <= CUR_MONTH).slice().reverse().slice(0, 24);
    return { html: '<section class="panel" id="rt-body"></section>', view: '収益情報：月次', after: async () => {
      renderArtMediaSelect();
      const val = (m, k) => { const v = monthVal(id, m)[k]; return v == null ? null : v; };
      const rows = months.map(m => {
        const ly = shiftMonth(m, -12);
        return '<tr><td class="c-txt">' + mLabel(m) + (m === CUR_MONTH ? '<span class="note">（途中）</span>' : '') + '</td>'
          + REV_PARTS.map(([k]) => '<td class="num">' + (k === 'revenue' ? '<b>' + yenF(val(m, k)) + '</b>' : yenF(val(m, k))) + '</td>' + rateCell('revenue', val(m, k), val(ly, k))).join('') + '</tr>';
      }).join('');
      $('rt-body').innerHTML = H('収益 月次 <small>' + esc(name) + '・kintone＋アフィリエイト・税抜き</small>', ['kintone', 'ASP'])
        + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">月</th>' + REV_PARTS.map(([, l]) => '<th class="num">' + l + '</th><th class="num">前年比</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' + revNote;
    } };
  }
  // 期間比較
  const f = state.rtf = state.rtf || { aFrom: LAST_FULL + '-01', aTo: monthEnd(LAST_FULL), bFrom: shiftMonth(LAST_FULL, -1) + '-01', bTo: monthEnd(shiftMonth(LAST_FULL, -1)) };
  const fix = d => d > YESTERDAY ? YESTERDAY : d;
  const aF = f.aFrom, aT = fix(f.aTo), bF = f.bFrom, bT = fix(f.bTo);
  const dIn = (i, v) => '<input type="date" id="' + i + '" value="' + v + '" max="' + YESTERDAY + '">';
  return { html: '<section class="panel"><div class="row"><span class="field"><b style="color: var(--fg)">期間A</b>' + dIn('rt-af', aF) + '〜' + dIn('rt-at', aT) + '</span><span class="field"><b style="color: var(--fg)">期間B</b>' + dIn('rt-bf', bF) + '〜' + dIn('rt-bt', bT) + '</span></div>'
    + '<p class="note" style="margin:8px 0 0">各400日まで。アフィリエイトは月の金額を日割りにして合計しています。</p></section><section class="panel" id="rt-body"><p class="loading">読み込み中…</p></section><section class="panel" id="rt-trend"></section>',
  view: '収益情報：期間比較', after: async () => {
    renderArtMediaSelect();
    [['rt-af', 'aFrom'], ['rt-at', 'aTo'], ['rt-bf', 'bFrom'], ['rt-bt', 'bTo']].forEach(([i, k]) => { $(i).onchange = ev => { f[k] = ev.target.value; render(); }; });
    const [da, db] = await Promise.all([loadDaily(aF, aT), loadDaily(bF, bT)]);
    const A = rangeVal(da, id, aF, aT), B = rangeVal(db, id, bF, bT);
    $('rt-body').innerHTML = H('期間A と 期間B <small>' + esc(name) + '・税抜き</small>', ['kintone', 'ASP'])
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">項目</th><th class="num">期間A<br><span class="note">' + dLabel(aF) + '〜' + dLabel(aT) + '</span></th><th class="num">期間B<br><span class="note">' + dLabel(bF) + '〜' + dLabel(bT) + '</span></th><th class="num">期間比</th><th class="num">差額</th></tr></thead><tbody>'
      + REV_PARTS.map(([k, l]) => { const a = A[k], b = B[k], d = a == null && b == null ? null : (a || 0) - (b || 0);
        return '<tr' + (k === 'revenue' ? ' class="total"' : '') + '><td class="c-txt">' + (k === 'revenue' ? '<b>' + l + '</b>' : l) + '</td><td class="num">' + yenF(a) + '</td><td class="num">' + yenF(b) + '</td>' + rateCell('revenue', a, b)
          + '<td class="num"><span class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d == null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '') + yenF(Math.abs(d))) + '</span></td></tr>'; }).join('') + '</tbody></table></div>' + revNote;
    // 推移：どちらも31日以内なら日ごと、それより長ければ月ごとに、経過順で並べて比べる
    const byDay = dayList(aF, aT).length <= 31 && dayList(bF, bT).length <= 31;
    const groups = (from, to) => { if (byDay) return dayList(from, to).map(d => ({ l: dLabel(d), from: d, to: d })); const out = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) out.push({ l: mLabel(m), from: m + '-01' < from ? from : m + '-01', to: monthEnd(m) > to ? to : monthEnd(m) }); return out; };
    const ga = groups(aF, aT), gb = groups(bF, bT), len = Math.max(ga.length, gb.length);
    const v = (daily, g, k) => g ? rangeVal(daily, id, g.from, g.to)[k] : null;
    let trs = '';
    for (let i = 0; i < len; i++) {
      const a = ga[i], b = gb[i];
      trs += '<tr><td class="c-txt">' + (i + 1) + (byDay ? '日目' : 'か月目') + '</td><td class="c-txt note">' + (a ? a.l : '—') + '／' + (b ? b.l : '—') + '</td>'
        + REV_PARTS.map(([k]) => '<td class="num">' + yenF(v(da, a, k)) + '</td><td class="num note">' + yenF(v(db, b, k)) + '</td>' + rateCell('revenue', v(da, a, k), v(db, b, k))).join('') + '</tr>';
    }
    $('rt-trend').innerHTML = H('比較期間の推移 <small>' + (byDay ? '日ごと' : '月ごと') + '・A と B を経過順に並べて比較</small>', ['kintone', 'ASP'])
      + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt" rowspan="2"></th><th class="c-txt" rowspan="2">A／B</th>' + REV_PARTS.map(([, l]) => '<th class="c-ctr" colspan="3">' + l + '</th>').join('') + '</tr><tr>' + REV_PARTS.map(() => '<th class="num">A</th><th class="num">B</th><th class="num">期間比</th>').join('') + '</tr></thead><tbody>' + trs + '</tbody></table></div>';
  } };
}
// もしもアフィリエイトのタブ：月次一覧・前年比・期間比較の切り替え（2026-10-14 ユーザー指定）
const MSM_VIEW = () => state.msmView || 'list';
const MSM_ITEMS = [['apr_amount', '承認成果金額（収益）', true], ['occ_amount', '発生成果金額（参考）', true], ['apr_count', '承認成果数', false], ['occ_count', '発生成果数', false], ['clicks', 'クリック', false], ['imp', 'インプレッション', false]];
function msmModeBar(months) {
  const asc = months.slice().reverse();
  const f = state.msmf = state.msmf || {};
  if (!f.aFrom || !asc.includes(f.aFrom)) { f.aTo = asc.filter(m => m < CUR_MONTH).pop() || asc[asc.length - 1]; f.aFrom = f.aTo; f.bTo = shiftMonth(f.aTo || CUR_MONTH, -1); f.bFrom = f.bTo; }
  const mSel = (i, v) => '<select id="' + i + '">' + asc.map(m => '<option value="' + m + '"' + (m === v ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select>';
  return '<div class="row" style="margin:8px 0; flex-wrap:wrap; gap:8px; align-items:flex-end"><label class="field">表示<select id="msm-view">' + [['list', '月次一覧'], ['yoy', '前年比'], ['range', '期間比較']].map(([k, l]) => '<option value="' + k + '"' + (k === MSM_VIEW() ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
    + (MSM_VIEW() === 'range' && asc.length ? '<span class="field"><b style="color: var(--fg)">期間A</b>' + mSel('msm-af', f.aFrom) + '〜' + mSel('msm-at', f.aTo) + '</span><span class="field"><b style="color: var(--fg)">期間B</b>' + mSel('msm-bf', f.bFrom) + '〜' + mSel('msm-bt', f.bTo) + '</span>' : '') + '</div>';
}
function msmBindMode() {
  $('msm-view').onchange = ev => { state.msmView = ev.target.value; render(); };
  [['msm-af', 'aFrom'], ['msm-at', 'aTo'], ['msm-bf', 'bFrom'], ['msm-bt', 'bTo']].forEach(([i, k]) => { const el = $(i); if (el) el.onchange = ev => { state.msmf[k] = ev.target.value; render(); }; });
}
const msmFmt = (yen, v) => v == null ? '—' : yen ? yenF(v) : nf.format(v);
/** 前年比：月ごとに、前年同月と比べる */
function msmYoy(months, get, ex) {
  if (!months.length) return '<p class="empty">まだデータがありません。</p>';
  const val = (m, k, yen) => { const v = get(m, k); return yen ? ex(v) : v; };
  return '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt" rowspan="2">月</th>' + MSM_ITEMS.slice(0, 3).map(([, l]) => '<th class="c-ctr" colspan="3">' + l + '</th>').join('') + '</tr><tr>' + MSM_ITEMS.slice(0, 3).map(() => '<th class="num">当月</th><th class="num">前年同月</th><th class="num">前年比</th>').join('') + '</tr></thead><tbody>'
    + months.map(m => { const ly = shiftMonth(m, -12); return '<tr><td class="c-txt">' + mLabel(m) + '</td>' + MSM_ITEMS.slice(0, 3).map(([k, , yen]) => '<td class="num">' + msmFmt(yen, val(m, k, yen)) + '</td><td class="num note">' + msmFmt(yen, val(ly, k, yen)) + '</td>' + rateCell('revenue', val(m, k, yen), val(ly, k, yen))).join('') + '</tr>'; }).join('')
    + '</tbody></table></div><p class="note">金額は税抜き。前年比は（当月÷前年同月）。100%より上（緑）＝増えた、下（赤）＝減った。前年同月のデータがない月は「—」です。</p>';
}
/** 期間比較：月の範囲Aと範囲Bを比べる＋経過順の推移 */
function msmRange(months, get, ex) {
  if (!months.length) return '<p class="empty">まだデータがありません。</p>';
  const f = state.msmf, list = (a, b) => { const out = []; for (let m = a; m <= b; m = shiftMonth(m, 1)) out.push(m); return a <= b ? out : []; };
  const A = list(f.aFrom, f.aTo), B = list(f.bFrom, f.bTo);
  const sum = (ms, k, yen) => { let s = null; ms.forEach(m => { const v = get(m, k); if (v != null) s = (s || 0) + v; }); return yen ? ex(s) : s; };
  const head = '<th class="num">期間A<br><span class="note">' + (A.length ? mLabel(A[0]) + '〜' + mLabel(A[A.length - 1]) : '—') + '</span></th><th class="num">期間B<br><span class="note">' + (B.length ? mLabel(B[0]) + '〜' + mLabel(B[B.length - 1]) : '—') + '</span></th><th class="num">期間比</th>';
  const summary = '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">項目</th>' + head + '</tr></thead><tbody>'
    + MSM_ITEMS.map(([k, l, yen], i) => '<tr' + (i === 0 ? ' class="total"' : '') + '><td class="c-txt">' + (i === 0 ? '<b>' + l + '</b>' : l) + '</td><td class="num">' + msmFmt(yen, sum(A, k, yen)) + '</td><td class="num">' + msmFmt(yen, sum(B, k, yen)) + '</td>' + rateCell('revenue', sum(A, k, yen), sum(B, k, yen)) + '</tr>').join('') + '</tbody></table></div>';
  const len = Math.max(A.length, B.length);
  let trs = '';
  for (let i = 0; i < len; i++) {
    const a = A[i], b = B[i], va = a ? ex(get(a, 'apr_amount')) : null, vb = b ? ex(get(b, 'apr_amount')) : null;
    trs += '<tr><td class="c-txt">' + (i + 1) + 'か月目</td><td class="c-txt">' + (a ? mLabel(a) : '—') + '</td><td class="num">' + yenF(va) + '</td><td class="c-txt">' + (b ? mLabel(b) : '—') + '</td><td class="num">' + yenF(vb) + '</td>' + rateCell('revenue', va, vb) + '</tr>';
  }
  return (A.length && B.length ? '' : '<p class="err">期間の始まりが終わりより後になっています。</p>') + summary
    + '<h3 style="margin:14px 0 6px; font-size:14px">比較期間の推移 <span class="note">承認成果金額（税抜き）・経過順</span></h3><div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt"></th><th class="c-txt">期間A</th><th class="num">金額</th><th class="c-txt">期間B</th><th class="num">金額</th><th class="num">期間比</th></tr></thead><tbody>' + trs + '</tbody></table></div>'
    + '<p class="note">金額は税抜き。前年比・期間比は（今の値÷比べる値）。100%より上（緑）＝増えた、下（赤）＝減った。</p>';
}
// ================= 収益管理（kintone・SEO回線） =================
let SEO = null;
async function loadSeo() { if (!SEO) SEO = await api('/revenue/seo'); return SEO; }
/** 収益管理で選んでいるメディア（メディア累計あり。メディア数値の選択と共有） */
function revMedia() { if (state.media === ALL) return ALL; const e = ent(state.media); return e ? e.media : ALL; }
const REV_DIMS = [['line_class', '回線分類'], ['line_name', '回線名'], ['inquiry', '問合せ内容'], ['inquiry2', '問合せ内容2'], ['pref', '都道府県'], ['partner', '作業員']];
const REV_COLS = [
  ['calls', 'コール数', a => nf.format(a.calls)], ['visits', '訪問確定', a => nf.format(a.visits)], ['vrate', '訪問率', a => a.calls ? (a.visits / a.calls * 100).toFixed(1) + '%' : '—'],
  ['contracts', '成約数', a => nf.format(a.contracts)], ['crate', '現場成約率', a => a.visits ? (a.contracts / a.visits * 100).toFixed(1) + '%' : '—'],
  ['sales', '売上(控除後)', a => yenF(a.sales)], ['sv', '訪問単価', a => a.visits ? yenF(a.sales / a.visits) : '—'], ['sc', '成約単価', a => a.contracts ? yenF(a.sales / a.contracts) : '—'],
  ['revenue', '収益(控除後)', a => a.revenue == null ? '—' : yenF(a.revenue)], ['rv', '収益訪問単価', a => a.revenue != null && a.visits ? yenF(a.revenue / a.visits) : '—'], ['rc', '収益成約単価', a => a.revenue != null && a.contracts ? yenF(a.revenue / a.contracts) : '—'],
  ['deduct', '控除額', a => a.deduct ? yenF(a.deduct) : '—'],
];
const yenF = v => v == null || !isFinite(v) ? '—' : '¥' + nf.format(Math.floor(v));
const revSortVal = (a, k) => ({ vrate: a.calls ? a.visits / a.calls : -1, crate: a.visits ? a.contracts / a.visits : -1, sv: a.visits ? a.sales / a.visits : -1, sc: a.contracts ? a.sales / a.contracts : -1, rv: a.visits ? (a.revenue || 0) / a.visits : -1, rc: a.contracts ? (a.revenue || 0) / a.contracts : -1 })[k] ?? (a[k] ?? -1);
function revAgg(rows) {
  const a = { calls: 0, visits: 0, contracts: 0, sales: 0, deduct: 0, revenue: 0, unmatched: 0, hasRev: false };
  rows.forEach(r => { a.calls += +r.calls; a.visits += +r.visits; a.contracts += +r.contracts; a.sales += +r.sales; a.deduct += +r.deduct || 0; a.unmatched += +r.unmatched || 0; if (r.revenue != null) { a.revenue += +r.revenue; a.hasRev = true; } });
  if (!a.hasRev) a.revenue = null;
  return a;
}
/** 項目別の表（見出しを押すと並べ替え） */
function revTable(rows, dim, label, f) {
  const groups = {}; rows.forEach(r => { const k = r[dim] || '（空欄）'; (groups[k] = groups[k] || []).push(r); });
  const sortK = f.sort || 'revenue', dir = f.dir || -1;
  const list = Object.entries(groups).map(([k, rs]) => ({ k, a: revAgg(rs) })).sort((x, y) => dir * (revSortVal(x.a, sortK) - revSortVal(y.a, sortK)) || x.k.localeCompare(y.k, 'ja'));
  const tot = revAgg(rows);
  return '<div class="table-wrap am-scroll"><table class="am-table rev-table"><thead><tr><th class="c-txt">' + esc(label) + '</th>' + REV_COLS.map(([k, h]) => '<th class="c-num" data-rsort="' + k + '" style="cursor:pointer; white-space:nowrap">' + h + (sortK === k ? (dir < 0 ? ' ▼' : ' ▲') : '') + '</th>').join('') + '</tr></thead><tbody>'
    + list.map(x => '<tr><td class="c-txt">' + esc(x.k) + '</td>' + REV_COLS.map(([, , fn]) => '<td class="c-num">' + fn(x.a) + '</td>').join('') + '</tr>').join('')
    + '<tr class="total"><td class="c-txt"><b>総計</b></td>' + REV_COLS.map(([, , fn]) => '<td class="c-num"><b>' + fn(tot) + '</b></td>').join('') + '</tr></tbody></table></div>';
}
function revBindSort(f, redraw) { document.querySelectorAll('[data-rsort]').forEach(th => th.onclick = () => { if (f.sort === th.dataset.rsort) f.dir = -(f.dir || -1); else { f.sort = th.dataset.rsort; f.dir = -1; } redraw(); }); }
/** 比較の表（前年比・期間比較） */
function revCompare(rowsA, rowsB, dim, label, la, lb) {
  const keys = [...new Set(rowsA.concat(rowsB).map(r => r[dim] || '（空欄）'))];
  const pick = (rs, k) => revAgg(rs.filter(r => (r[dim] || '（空欄）') === k));
  const KEYS = [['calls', 'コール数', v => nf.format(v)], ['contracts', '成約数', v => nf.format(v)], ['sales', '売上(控除後)', yenF], ['revenue', '収益(控除後)', v => v == null ? '—' : yenF(v)]];
  const diff = (a, b) => a == null || b == null ? '—' : b ? '<span class="' + (a >= b ? 'up' : 'down') + '">' + ratioTxt((a - b) / Math.abs(b)) + '</span>' : (a ? '新規' : '—');
  const rowsHtml = (k, A, B, bold) => '<tr' + (bold ? ' class="total"' : '') + '><td class="c-txt">' + (bold ? '<b>' + esc(k) + '</b>' : esc(k)) + '</td>' + KEYS.map(([kk, , fn]) => '<td class="c-num">' + fn(A[kk]) + '</td><td class="c-num note">' + fn(B[kk]) + '</td><td class="c-num">' + diff(A[kk], B[kk]) + '</td>').join('') + '</tr>';
  const list = keys.map(k => ({ k, A: pick(rowsA, k), B: pick(rowsB, k) })).sort((x, y) => (y.A.revenue || y.A.sales) - (x.A.revenue || x.A.sales));
  return '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt" rowspan="2">' + esc(label) + '</th>' + KEYS.map(([, h]) => '<th class="c-ctr" colspan="3">' + h + '</th>').join('') + '</tr><tr>' + KEYS.map(() => '<th class="c-num">' + esc(la) + '</th><th class="c-num">' + esc(lb) + '</th><th class="c-num">' + (la === 'A' ? '期間比' : '前年比') + '</th>').join('') + '</tr></thead><tbody>'
    + list.map(x => rowsHtml(x.k, x.A, x.B)).join('') + rowsHtml('総計', revAgg(rowsA), revAgg(rowsB), true) + '</tbody></table></div>';
}
function viewRev(mode) {
  const f = state.rvf = state.rvf || { dim: 'line_class', flt: {}, ym: LAST_FULL, from: addDays(YESTERDAY, -29), to: YESTERDAY, aFrom: LAST_FULL + '-01', aTo: monthEnd(LAST_FULL), bFrom: shiftMonth(LAST_FULL, -1) + '-01', bTo: monthEnd(shiftMonth(LAST_FULL, -1)) };
  const title = { monthly: '月次', daily: '日次', yoy: '前年比', range: '期間比較', area: 'エリア' }[mode];
  return { html: '<section class="panel" id="rv-filter"><p class="loading">読み込み中…</p></section><section class="panel" id="rv-body"></section><section class="panel" id="rv-sub" hidden></section>', view: '収益情報：kintone（' + title + '）', after: async () => {
    renderArtMediaSelect();
    const d = await loadSeo(), media = revMedia();
    const base = d.rows.filter(r => media === ALL || r.media === media);
    const months = [...new Set(base.map(r => r.date.slice(0, 7)))].sort().reverse();
    if (!months.includes(f.ym)) f.ym = months.find(m => m <= LAST_FULL) || months[0] || LAST_FULL;
    const uniq = k => [...new Set(base.map(r => r[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    const sel = (id, label, opts, v) => '<label class="field">' + label + '<select id="' + id + '">' + opts.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === (v || '') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    const period = mode === 'daily' ? '<label class="field">期間<input type="date" id="rv-from" value="' + f.from + '"> 〜 <input type="date" id="rv-to" value="' + f.to + '"></label>'
      : mode === 'range' ? '<label class="field">期間A<input type="date" id="rv-af" value="' + f.aFrom + '"> 〜 <input type="date" id="rv-at" value="' + f.aTo + '"></label><label class="field">期間B<input type="date" id="rv-bf" value="' + f.bFrom + '"> 〜 <input type="date" id="rv-bt" value="' + f.bTo + '"></label>'
      : sel('rv-ym', '対象月', months.map(m => [m, mLabel(m) + (m === CUR_MONTH ? '（途中）' : '')]), f.ym);
    $('rv-filter').innerHTML = H('収益（kintone・SEO回線） <small>' + esc(media === ALL ? 'メディア累計' : mediaLabel(media)) + '</small>', ['kintone'])
      + '<div class="row">' + sel('rv-kmode', '表示', [['monthly', '月次'], ['daily', '日次'], ['yoy', '前年比'], ['range', '期間比較'], ['area', 'エリア']], mode) + period + (mode === 'daily' || mode === 'area' ? '' : sel('rv-dim', 'ディメンション', REV_DIMS, f.dim)) + '</div>'
      + '<div class="row" style="margin-top:6px">' + REV_DIMS.map(([k, l]) => sel('rv-f-' + k, l, [['', 'すべて']].concat(uniq(k).map(v => [v, v])), f.flt[k])).join('') + '</div>'
      + '<p class="note">売上・収益はすべて控除後・税抜（売上合計金額(税込) − 部材費控除額）÷1.1。成約＝結果「03.完了報告」、訪問確定・コール＝kintoneのフラグ。問合せ内容2は「カギ」を一つにまとめたものです。'
      + (d.rules ? '' : '<br><span class="err">収益の条件表がまだ取り込まれていないため、収益は計算していません（Apps Script の importRevenueTables を実行してください）。</span>') + '</p>';
    const filtered = () => base.filter(r => REV_DIMS.every(([k]) => !f.flt[k] || r[k] === f.flt[k]));
    const inRange = (rs, a, b) => rs.filter(r => r.date >= a && r.date <= b);
    const draw = () => {
      const rows = filtered(), dimLabel = (REV_DIMS.find(x => x[0] === f.dim) || REV_DIMS[0])[1];
      let html = '', sub = '';
      if (mode === 'monthly') {
        const cur = rows.filter(r => r.date.startsWith(f.ym));
        const un = revAgg(cur).unmatched;
        html = H(mLabel(f.ym) + ' <small>' + dimLabel + '別</small>', ['kintone']) + revTable(cur, f.dim, dimLabel, f)
          + (un ? '<p class="note">収益の条件表に当てはまらなかった案件が ' + un + '件あります（KT商材・外注先・都道府県・期間のどれかが条件表にない）。この分の収益は0円で計算しています。</p>' : '');
        const last = []; for (let m = f.ym, i = 0; i < 13; i++, m = shiftMonth(m, -1)) last.push(m);
        sub = H('月別の推移 <small>直近13か月</small>', ['kintone']) + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">月</th>' + REV_COLS.map(([, h]) => '<th class="c-num">' + h + '</th>').join('') + '</tr></thead><tbody>'
          + last.map(m => { const a = revAgg(rows.filter(r => r.date.startsWith(m))); return '<tr><td class="c-txt">' + mLabel(m) + '</td>' + REV_COLS.map(([, , fn]) => '<td class="c-num">' + fn(a) + '</td>').join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      } else if (mode === 'daily') {
        const days = []; for (let x = f.from; x <= f.to; x = addDays(x, 1)) days.push(x);
        const rs = inRange(rows, f.from, f.to);
        html = H('日別 <small>' + f.from.replace(/-/g, '/') + '〜' + f.to.replace(/-/g, '/') + '</small>', ['kintone']) + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">日付</th>' + REV_COLS.map(([, h]) => '<th class="c-num">' + h + '</th>').join('') + '</tr></thead><tbody>'
          + days.slice().reverse().map(x => { const a = revAgg(rs.filter(r => r.date === x)); return '<tr><td class="c-txt">' + x.replace(/-/g, '/') + '</td>' + REV_COLS.map(([, , fn]) => '<td class="c-num">' + fn(a) + '</td>').join('') + '</tr>'; }).join('')
          + '<tr class="total"><td class="c-txt"><b>総計</b></td>' + REV_COLS.map(([, , fn]) => '<td class="c-num"><b>' + fn(revAgg(rs)) + '</b></td>').join('') + '</tr></tbody></table></div>';
      } else if (mode === 'yoy') {
        const ly = shiftMonth(f.ym, -12);
        html = H(mLabel(f.ym) + ' と ' + mLabel(ly) + '（前年同月） <small>' + dimLabel + '別</small>', ['kintone']) + revCompare(rows.filter(r => r.date.startsWith(f.ym)), rows.filter(r => r.date.startsWith(ly)), f.dim, dimLabel, mLabel(f.ym), mLabel(ly));
      } else if (mode === 'range') {
        html = H('期間A と 期間B <small>' + dimLabel + '別</small>', ['kintone']) + revCompare(inRange(rows, f.aFrom, f.aTo), inRange(rows, f.bFrom, f.bTo), f.dim, dimLabel, 'A', 'B')
          + '<p class="note">A：' + f.aFrom.replace(/-/g, '/') + '〜' + f.aTo.replace(/-/g, '/') + '　B：' + f.bFrom.replace(/-/g, '/') + '〜' + f.bTo.replace(/-/g, '/') + '</p>';
      } else if (mode === 'area') {
        const cur = rows.filter(r => r.date.startsWith(f.ym));
        html = H(mLabel(f.ym) + ' <small>都道府県別</small>', ['kintone']) + revTable(cur, 'pref', '都道府県', f);
        sub = H('市区町村別 <small>' + mLabel(f.ym) + (f.flt.pref ? '・' + esc(f.flt.pref) : '・都道府県を絞り込むと見やすくなります') + '</small>', ['kintone'])
          + revTable(cur.map(r => Object.assign({}, r, { area: (r.pref || '') + ' ' + (r.city || '（不明）') })), 'area', '市区町村', Object.assign({}, f, { sort: 'calls' }));
      }
      $('rv-body').innerHTML = html; $('rv-sub').hidden = !sub; $('rv-sub').innerHTML = sub;
      revBindSort(f, draw);
    };
    const bind = (id, fn) => { const el = $(id); if (el) el.onchange = () => { fn(el.value); draw(); }; };
    $('rv-kmode').onchange = ev => { state.rvKMode = ev.target.value; render(); };   // kintone のタブの中で月次〜エリアを切り替える
    bind('rv-ym', v => { f.ym = v; }); bind('rv-dim', v => { f.dim = v; }); bind('rv-from', v => { f.from = v; }); bind('rv-to', v => { f.to = v; });
    bind('rv-af', v => { f.aFrom = v; }); bind('rv-at', v => { f.aTo = v; }); bind('rv-bf', v => { f.bFrom = v; }); bind('rv-bt', v => { f.bTo = v; });
    REV_DIMS.forEach(([k]) => bind('rv-f-' + k, v => { f.flt[k] = v; }));
    draw();
  } };
}

// ================= 収益管理：もしもアフィリエイト（成果報酬レポートのCSVを取り込む。公開APIがないため） =================
// 収益は承認成果金額、発生成果金額は参考で並べる。金額は税込みなので 1.1 で割って税抜きで表示（2026-10-14 ユーザー指定）
const MSM_ALL = '_all';
const MSM_COLS = { '期間': 'ym', 'インプレッション数': 'imp', 'クリック数': 'clicks', 'クリック金額': 'click_amount', '発生成果数': 'occ_count', '発生成果金額': 'occ_amount', '承認成果数': 'apr_count', '承認成果金額': 'apr_amount', '報酬額': 'reward' };
/** CSVを行・列に分ける（"" で囲まれた値・中のカンマに対応） */
function csvRows(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); out.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.some(x => x.trim()));
}
/** もしものCSV（Shift_JIS）を読んで、月ごとの行にする */
function parseMoshimo(buf) {
  let text = new TextDecoder('shift_jis').decode(buf);
  if (!text.includes('期間')) text = new TextDecoder('utf-8').decode(buf);
  const rows = csvRows(text.replace(/^﻿/, ''));
  const head = (rows[0] || []).map(h => MSM_COLS[h.trim()] || null);
  if (!head.includes('ym') || !head.includes('apr_amount')) throw new Error('もしもアフィリエイトの成果報酬レポート（月別）のCSVではないようです。見出しに「期間」「承認成果金額」が必要です');
  const num = s => { const t = String(s || '').replace(/[\\¥￥,\s円]/g, ''); return t === '' || t === '-' ? null : Number(t); };
  const out = [];
  rows.slice(1).forEach(r => {
    const o = {};
    head.forEach((k, i) => { if (k) o[k] = k === 'ym' ? String(r[i] || '').trim() : num(r[i]); });
    const m = o.ym.match(/^(\d{4})\D+(\d{1,2})/);
    if (!m) return;   // 合計の行など
    o.ym = m[1] + '-' + m[2].padStart(2, '0');
    if (Object.keys(o).some(k => k !== 'ym' && o[k] != null && !isFinite(o[k]))) throw new Error(mLabel(o.ym) + ' の数値が読めません');
    out.push(o);
  });
  if (!out.length) throw new Error('取り込める月の行がありません');
  return out;
}
function viewMoshimo() {
  return { html: '<section class="panel" id="msm-body">' + H('もしもアフィリエイト', ['ASP']) + '<p class="loading">読み込み中…</p></section>', view: '収益情報：もしもアフィリエイト', after: async () => {
    renderArtMediaSelect();
    const d = await api('/revenue/moshimo'), media = revMedia(), tax = d.tax || 1.1, isAll = media === ALL;
    const ex = v => v == null ? null : Math.round(v / tax * 100) / 100;   // 税抜き（3300 ÷ 1.1 が 2999.99… にならないよう丸める）
    const byMedia = {}; d.rows.forEach(r => { (byMedia[r.media] = byMedia[r.media] || {})[r.ym] = r; });
    const key = isAll ? MSM_ALL : media;
    const months = [...new Set(d.rows.filter(r => r.media === key || (isAll && r.media !== MSM_ALL)).map(r => r.ym))].sort().reverse();
    const get = (ym, k) => { const r = (byMedia[key] || {})[ym]; return r ? r[k] : null; };
    const sumMedia = ym => { let s = null; Object.keys(byMedia).forEach(m => { const r = m !== MSM_ALL && byMedia[m][ym]; if (r && r.apr_amount != null) s = (s || 0) + r.apr_amount; }); return s; };
    const cell = v => '<td class="num">' + (v == null ? '—' : nf.format(v)) + '</td>', ycell = v => '<td class="num">' + yenF(v) + '</td>';
    const table = !months.length ? '<p class="empty">' + (isAll ? 'まだCSVを取り込んでいません。' : esc(mediaName(media)) + ' のCSVはまだ取り込んでいません。') + '</p>'
      : '<div class="table-wrap"><table><thead><tr><th>月</th><th class="num">インプレッション</th><th class="num">クリック</th><th class="num">発生成果数</th><th class="num">発生成果金額<br><span class="note">参考・税抜き</span></th><th class="num">承認成果数</th><th class="num">承認成果金額<br><span class="note">収益・税抜き</span></th>'
        + (isAll ? '<th class="num">各メディアの合計<br><span class="note">承認・税抜き</span></th><th class="num">メディア未割当<br><span class="note">全体 − 合計</span></th>' : '') + '<th>取り込み</th></tr></thead><tbody>'
        + months.map(ym => {
          const r = (byMedia[key] || {})[ym], all = get(ym, 'apr_amount'), sm = isAll ? sumMedia(ym) : null;
          return '<tr><td>' + mLabel(ym) + '</td>' + cell(get(ym, 'imp')) + cell(get(ym, 'clicks')) + cell(get(ym, 'occ_count')) + ycell(ex(get(ym, 'occ_amount'))) + cell(get(ym, 'apr_count')) + '<td class="num"><b>' + yenF(ex(all)) + '</b></td>'
            + (isAll ? ycell(ex(sm)) + ycell(all != null ? ex(all - (sm || 0)) : null) : '')
            + '<td class="note">' + (r ? esc(r.uploaded_at || '') + '<br>' + esc((r.uploaded_by || '').split('@')[0]) : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    const opts = '<option value="' + MSM_ALL + '"' + (isAll ? ' selected' : '') + '>メディア全体</option>' + topMedia().map(m => '<option value="' + esc(m.media) + '"' + (m.media === media ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
    const upload = !d.canUpload ? '' : '<div class="panel" style="margin-top:12px"><div class="panel-head"><h2>CSVを取り込む</h2></div>'
      + '<p class="note">毎月2日・15日に、直近3か月分を自動で取り込みます（設定は API・連携設定 →「もしもアフィリエイト」）。それ以外の月を入れたいときは、もしもアフィリエイトの管理画面 → レポート → 報酬 → 月次でダウンロードしたCSVを選んでください。同じ月・同じメディアは、新しく取り込んだ値で置き換えます（承認が増えたら取り込み直してください）。</p>'
      + '<div class="row" style="flex-wrap:wrap; gap:8px; align-items:flex-end; margin-top:8px"><label class="field">どのメディアのCSVか<select id="msm-media">' + opts + '</select></label>'
      + '<label class="field">CSVファイル<input type="file" id="msm-file" accept=".csv,text/csv"></label></div>'
      + '<p class="err" id="msm-err" hidden></p><div id="msm-preview"></div></div>';
    $('msm-body').innerHTML = H('もしもアフィリエイト <small>' + (isAll ? 'メディア全体' : esc(mediaName(media))) + '・月別</small>', ['ASP'])
      + '<p class="note">収益として数えるのは<b>承認成果金額</b>です（発生成果金額は、あとで否認されて減ることがあるので参考）。金額はすべて税抜き（CSVの税込み金額 ÷ ' + tax + '）。'
      + (isAll ? 'メディア全体のCSVはメディアに分けられないため、収益の集計には各メディアのCSVを使います。「メディア未割当」は、まだメディアごとのCSVを取り込んでいない分です。' : 'このメディアの収益（月次・サマリなど）は、CSVを取り込んだ月はこの承認成果金額を使い、取り込んでいない月はスプレッドシートの値を使います。') + '</p>'
      + msmModeBar(months) + (MSM_VIEW() === 'list' ? table : MSM_VIEW() === 'yoy' ? msmYoy(months, get, ex) : msmRange(months, get, ex)) + upload;
    msmBindMode();
    if (!d.canUpload) return;
    const fail = m => { $('msm-err').textContent = m; $('msm-err').hidden = !m; };
    let rows = null, fileName = '';
    const preview = () => {
      $('msm-preview').innerHTML = '';
      if (!rows) return;
      const target = $('msm-media').value, tName = target === MSM_ALL ? 'メディア全体' : mediaName(target);
      $('msm-preview').innerHTML = '<p style="margin-top:8px">' + esc(fileName) + '：<b>' + rows.length + 'か月分</b>（' + mLabel(rows[0].ym) + '〜' + mLabel(rows[rows.length - 1].ym) + '）を「<b>' + esc(tName) + '</b>」として取り込みます。</p>'
        + '<div class="table-wrap"><table><thead><tr><th>月</th><th class="num">発生成果金額（税込み）</th><th class="num">承認成果金額（税込み）</th><th class="num">承認成果金額（税抜き）</th></tr></thead><tbody>'
        + rows.map(r => '<tr><td>' + mLabel(r.ym) + '</td><td class="num">' + yenF(r.occ_amount) + '</td><td class="num">' + yenF(r.apr_amount) + '</td><td class="num">' + yenF(ex(r.apr_amount)) + '</td></tr>').join('') + '</tbody></table></div>'
        + '<div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn primary" type="button" id="msm-save">取り込む</button></div>';
      $('msm-save').onclick = async () => {
        $('msm-save').disabled = true; $('msm-save').textContent = '取り込み中…';
        try {
          await apiSend('POST', '/revenue/moshimo', { media: $('msm-media').value, file: fileName, rows });
          if (me.perms.media !== 'none') MONTHLY = await api('/monthly');   // 月次・サマリのアフィリエイトに反映
          DAILY_CACHE.clear(); render();
        } catch (e) { fail(e.message); $('msm-save').disabled = false; $('msm-save').textContent = '取り込む'; }
      };
    };
    $('msm-media').onchange = preview;   // メディアを変えたら表示し直す
    $('msm-file').onchange = async ev => {
      fail(''); rows = null; fileName = '';
      const file = ev.target.files[0];
      if (file) { try { rows = parseMoshimo(await file.arrayBuffer()); fileName = file.name; } catch (e) { fail(e.message); } }
      preview();
    };
  } };
}

// ================= 記事管理：各種設定（カテゴリ・タグ・CTA・訴求ブロック） =================
const ART_OPTS = {};
async function loadArtOptions(media, force) {
  if (force || !ART_OPTS[media]) ART_OPTS[media] = Promise.all([api('/wp-terms?media=' + encodeURIComponent(media)).catch(() => ({ categories: [], tags: [], connected: false })), api('/article-blocks?media=' + encodeURIComponent(media))])
    .then(([terms, blocks]) => (ART_OPTS[media + '#'] = { terms, blocks }));
  return ART_OPTS[media];
}
const parseTags = s => [...new Set(String(s || '').split(/[、,，\n]/).map(x => x.trim()).filter(Boolean))];
/** タグをチェックボックスで選ぶ（選んだ数を表示）。保存は進行管理のほかの項目と同じくすぐ */
function openTagPicker(r, btn) {
  const o = ART_OPTS[r.media + '#'] || { terms: { tags: [] } }, cur = parseTags(btn.closest('td').querySelector('input[type=hidden]').value);
  const all = [...new Set(o.terms.tags.map(t => t.name).concat(cur))];
  openModal('<h2>タグを選ぶ <small class="note">' + esc(r.kw || '') + '</small></h2><div class="row" style="margin-bottom:8px"><input id="tg-q" type="search" placeholder="タグを探す" style="flex:1"><b id="tg-n" class="num"></b></div>'
    + '<div class="tag-list" id="tg-list">' + (all.length ? all.map((t, i) => '<label class="tag-item"><input type="checkbox" value="' + esc(t) + '"' + (cur.includes(t) ? ' checked' : '') + '> ' + esc(t) + '</label>').join('') : '<p class="empty">WordPressにタグがありません</p>') + '</div>'
    + '<div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn" type="button" id="tg-clear" style="margin-right:auto">すべて外す</button><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="tg-save">決定</button></div>');
  const count = () => { $('tg-n').textContent = '選択中 ' + document.querySelectorAll('#tg-list input:checked').length + '件'; };
  document.querySelectorAll('#tg-list input').forEach(cb => cb.onchange = count); count();
  $('tg-q').oninput = ev => { const q = ev.target.value.trim().toLowerCase(); document.querySelectorAll('#tg-list .tag-item').forEach(l => { l.hidden = q && !l.textContent.toLowerCase().includes(q); }); };
  $('tg-clear').onclick = () => { document.querySelectorAll('#tg-list input').forEach(cb => { cb.checked = false; }); count(); };
  $('tg-save').onclick = () => {
    const picked = [...document.querySelectorAll('#tg-list input:checked')].map(cb => cb.value), el = btn.closest('td').querySelector('input[type=hidden]');
    el.value = picked.join('、'); closeModal();
    btn.textContent = picked.length ? 'タグ ' + picked.length + '件' : '未選択'; btn.classList.toggle('unsel', !picked.length);
    el.dispatchEvent(new Event('change'));
  };
}
const sheetValues = (media, k) => [...new Set((ITEMS || []).filter(r => r.media === media && r[k]).map(r => String(r[k]).trim()).filter(Boolean))];
/** プルダウンの選択肢：カテゴリ・タグは WordPress、CTA・訴求ブロックは登録済み＋シートにある名前 */
/** シートの CTA・訴求ブロックの値が、マイブロックの名前と同じものか（2026-10-26 ユーザー指定で名前の書き方の違いを吸収）
 *  ・全角半角・空白・かっこ・「の」の違いは同じ名前として扱う（例：CTA4（洗面台水漏れ）＝ CTA4(洗面台の水漏れ)）
 *  ・訴求ブロックが「高・中・低」だけのときは、記事のディレクトリ（トイレ・洗面台など）を名前に含み、末尾が同じ段階のブロック */
const blockNorm = s => String(s || '').normalize('NFKC').replace(/[\s()（）「」【】\[\]_＿・]/g, '').replace(/の/g, '').toLowerCase();
/* 「CTA00」「テキストCTA」「訴求」「ブロック」を除いても同じなら同じブロック（例：ハチ駆除＝CTA00ハチ駆除、金庫＝テキストCTA（金庫）、スズメバチ_高＝スズメバチ訴求ブロック_高）（2026-11-05 ユーザー指定） */
const blockCore = s => blockNorm(s).replace(/cta\d*|テキスト|訴求|ブロック/g, '');
function blockHit(name, r, key) {
  const v = String(r[key] || '').trim(); if (!v) return false;
  if (blockNorm(v) === blockNorm(name)) return true;
  const cv = blockCore(v); if (cv && cv === blockCore(name)) return true;
  const lv = v.normalize('NFKC').match(/^(高|中|低)$/);
  return !!(lv && r.sub && new RegExp('[_＿]' + lv[1] + '$').test(name) && blockNorm(name).includes(blockNorm(r.sub)));
}
/** プルダウンの選択肢：カテゴリ・タグは WordPress、CTA・訴求ブロックは「カテゴリ・タグ・ブロック」（マイブロック）の名前だけ。
 *  シートの値は選択肢に足さない（書き方の違う同じ名前が2つ並ぶため。2026-11-05 ユーザー指定） */
function optNames(src, media) {
  const o = ART_OPTS[media + '#'] || { terms: { categories: [], tags: [] }, blocks: { cta: [], appeal: [] } };
  if (src === 'categories' || src === 'tags') return o.terms[src].map(t => t.name);
  const names = (o.blocks[src] || []).map(b => b.name);
  if (!names.length) return sheetValues(media, src === 'cta' ? 'cta' : 'appeal_block').sort((a, b) => a.localeCompare(b, 'ja'));   // マイブロックがないメディア（害虫害獣コンシェルジュなど）は、今までどおりシートにある値から選ぶ
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'ja'));
}
// ---------- ガイドライン確認（記事ごと。2026-11-13 ユーザー指定） ----------
/* 進行状況が「記事執筆完了」以降の記事に「ガイドライン確認」を出す。全項目チェック、または未対応の理由を入れないと「完了」にできない（サーバーの PATCH /article-items でも止める）。
   判定はいつも今のガイドラインの項目で行う（ガイドラインを変えたら随時反映）。将来 AI でもチェックするので、チェックは項目IDごとに保存 */
let GUIDE = null;
const GUIDE_FROM = ['記事執筆完了', '記事チェック中', '記事監修者確認', 'アップロードチェック中', '完了'];
async function loadGuide(force) {
  if (GUIDE && !force) return GUIDE;
  try { GUIDE = await api('/guide-checks'); } catch (e) { GUIDE = { guides: {}, checks: {}, err: e.message }; }
  return GUIDE;
}
const guideItemDone = c => !!c && (c.ok === true || String(c.reason || '').trim() !== '');
/** 終わっていない項目（ガイドラインを読み込めていなければ null＝画面では止めない。サーバーで止める） */
function guideMissingFor(r) {
  const g = GUIDE && GUIDE.guides && GUIDE.guides[r.media]; if (!g) return null;
  const it = ((GUIDE.checks || {})[r.key] || {}).items || {};
  return g.sections.flatMap(s => s.items.filter(x => !guideItemDone(it[x.id])).map(x => s.title + '：' + x.title));
}
const guideTotal = r => { const g = GUIDE && GUIDE.guides && GUIDE.guides[r.media]; return g ? g.sections.reduce((a, s) => a + s.items.length, 0) : 0; };
function guideBtnHtml(r, status) {
  if (!r.key || !GUIDE_FROM.includes(status) || !GUIDE || !GUIDE.guides || !GUIDE.guides[r.media]) return '';
  const miss = guideMissingFor(r) || [], tot = guideTotal(r), ok = !miss.length;
  return '<button class="guide-btn' + (ok ? ' ok' : '') + '" type="button" data-guide="' + esc(r.key) + '" title="サイトのガイドラインに沿っているかの確認（全項目そろわないと「完了」にできません）">' + (ok ? '✓ ' : '') + 'ガイドライン確認 ' + (tot - miss.length) + '/' + tot + '</button>';
}
const guideSlot = r => '<span class="guide-slot" data-gslot="' + esc(r.key || '') + '">' + guideBtnHtml(r, r.status || '') + '</span>';
function refreshGuideSlots(key, status) {
  const r = (ITEMS || []).find(x => x.key === key); if (!r) return;
  document.querySelectorAll('[data-gslot]').forEach(s => { if (s.dataset.gslot !== key) return; const sel = s.closest('td') && s.closest('td').querySelector('select[data-k="status"]'); s.innerHTML = guideBtnHtml(r, status || (sel ? sel.value : r.status) || ''); });
}
/* 進行状況を変えたら、ボタンを出す・消す（保存の処理はそれぞれの画面のまま） */
document.addEventListener('change', ev => { const el = ev.target; if (!el || !el.matches || !el.matches('select[data-k="status"]')) return; const s = el.closest('td') && el.closest('td').querySelector('[data-gslot]'); if (s && s.dataset.gslot) setTimeout(() => refreshGuideSlots(s.dataset.gslot, el.value), 0); });
document.addEventListener('click', ev => { const b = ev.target && ev.target.closest && ev.target.closest('[data-guide]'); if (!b) return; const r = (ITEMS || []).find(x => x.key === b.dataset.guide); if (r) openGuideCheck(r); });
function openGuideCheck(r) {
  const g = GUIDE && GUIDE.guides && GUIDE.guides[r.media]; if (!g) return;
  const cur = Object.assign({}, ((GUIDE.checks || {})[r.key] || {}).items || {}), can = canEditArticles(), dis = can ? '' : ' disabled';
  const ck = GUIDE.checks[r.key];
  openModal('<h2>ガイドライン確認 <small class="note">' + esc(mediaLabel(r.media)) + (r.no ? '　No.' + esc(r.no) : '') + '　' + esc(r.kw || '') + '</small></h2>'
    + '<p class="note">項目ごとに「確認した」にチェックするか、対応しない場合はその理由を入れてください。全部そろうと「完了」にできます。項目はコンテンツ作成 →「コンセプト」の「ガイドライン」で直せます（直すと、ここにもすぐ反映されます）。' + (ck && ck.by ? '<br>最終更新：' + esc(ck.by) + (ck.at ? '（' + esc(String(ck.at).slice(0, 16).replace('T', ' ')) + '）' : '') : '') + '</p>'
    + '<div class="row" style="gap:8px;margin-bottom:6px">' + '<button class="btn sm" type="button" disabled title="これから作ります">AIでチェック（準備中）</button><span class="note" id="gc-count"></span></div>'
    + '<div class="gc-list">' + g.sections.map(s => '<h3 class="gc-h">' + esc(s.title) + '</h3>' + s.items.map(x => { const c = cur[x.id] || {};
      return '<div class="gc-item" data-gcid="' + esc(x.id) + '"><label class="gc-ok"><input type="checkbox" data-gcok' + (c.ok === true ? ' checked' : '') + dis + '><b>' + esc(x.title) + '</b></label>' + (x.desc ? '<div class="note">' + esc(x.desc) + '</div>' : '')
        + '<input class="gc-reason" data-gcreason placeholder="対応しない場合は理由を入力" value="' + esc(c.ok === true ? '' : c.reason || '') + '"' + (c.ok === true ? ' hidden' : '') + dis + '></div>'; }).join('')).join('') + '</div>'
    + (g.refs && g.refs.length ? '<p class="note">参考：' + g.refs.map(x => '<a href="' + escUrl(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>').join('　') + '</p>' : '')
    + '<p class="err" id="gc-err" hidden></p><div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px"><button class="btn" type="button" data-close>' + (can ? 'キャンセル' : '閉じる') + '</button>' + (can ? '<button class="btn primary" type="button" id="gc-save">保存</button>' : '') + '</div>');
  const read = () => { const o = {}; document.querySelectorAll('[data-gcid]').forEach(d => { const ok = d.querySelector('[data-gcok]').checked, rs = d.querySelector('[data-gcreason]').value.trim(); if (ok) o[d.dataset.gcid] = { ok: true }; else if (rs) o[d.dataset.gcid] = { ok: false, reason: rs }; }); return o; };
  const count = () => { const o = read(), tot = g.sections.reduce((a, s) => a + s.items.length, 0), n = Object.keys(o).length; $('gc-count').textContent = n + ' / ' + tot + ' 項目' + (n === tot ? '（そろいました）' : ''); };
  document.querySelectorAll('[data-gcid]').forEach(d => { const cb = d.querySelector('[data-gcok]'), rs = d.querySelector('[data-gcreason]'); cb.onchange = () => { rs.hidden = cb.checked; count(); }; rs.oninput = count; });
  /* 「すべて確認した」は置かない。1記事ずつ全項目を必ず確認する（2026-11-16 ユーザー指定） */
  count();
  if ($('gc-save')) $('gc-save').onclick = async () => {
    const btn = $('gc-save'); btn.disabled = true;
    try { const res = await apiSend('PUT', '/guide-checks', { key: r.key, media: r.media, items: read() }); GUIDE.checks[r.key] = { items: res.items, by: me.name || me.email, at: new Date().toISOString() }; closeModal(); refreshGuideSlots(r.key); toast(res.missing && res.missing.length ? 'ガイドライン確認を保存しました（残り' + res.missing.length + '項目）' : 'ガイドライン確認がそろいました'); }
    catch (e) { btn.disabled = false; $('gc-err').textContent = e.message; $('gc-err').hidden = false; }
  };
}

// ---------- コンセプト（メディアごと。2026-11-13 ユーザー指定） ----------
/* コンセプト・ペルソナ（メディア1つ＋ディレクトリごと）・サイトのガイドライン・競合サイト（Ahrefs。ボタンを押したときだけ）。
   ペルソナは構成シートの「ペルソナをコピー」（メディアから／ディレクトリから）で使う。ガイドラインは記事のガイドライン確認の項目になる */
let CP = null;
const CP_TABS = [['concept', 'コンセプト'], ['persona', 'ペルソナ'], ['guide', 'ガイドライン'], ['compete', '競合サイト']];
const CP_LONG = ['purpose', 'article_purpose', 'wants', 'concept', 'goal', 'quality'];
const CP_PH = { purpose: 'このメディアは何のためにあるか', url: 'https://…', article_purpose: '記事を作る目的（集客・問い合わせ・ブランディングなど）', wants: '読者・会社がこのメディアに求めるもの', concept: 'メディアのコンセプト（一言で）', cv_tel: '0120-…', cv_form: 'https://…（問い合わせフォームのURL）', goal: '数値目標など（月間PV・問い合わせ件数など）', quality: '記事に求める品質（専門性・文字数・画像・監修など）' };
const canConcept = () => hasCap('concept_view', () => !!me && !!me.perms && me.perms.articles !== 'none');
function viewAmConcept() {
  return { html: '<section class="panel" id="cp-body"><p class="loading">読み込み中…</p></section>', view: 'コンテンツ作成：コンセプト', after: async () => {
    const mySeq = renderSeq;
    await loadItems(); if (mySeq !== renderSeq) return;
    const media = artMedia(); renderArtMediaSelect();
    const box = $('cp-body');
    if (media === ALL) { box.innerHTML = H('コンセプト <small>メディア累計</small>', []) + '<p class="empty">コンセプトはメディアごとです。右上でメディアを選んでください。</p>'; return; }
    let d; try { d = await api('/concept?media=' + encodeURIComponent(media)); } catch (e) { if (mySeq === renderSeq) box.innerHTML = H('コンセプト', []) + '<p class="err">' + esc(e.message) + '</p>'; return; }
    if (mySeq !== renderSeq) return;
    CP = { media, d, tab: state.cpTab || 'concept', showEx: false };
    cpInitSubs(); paintConcept();
  } };
}
/** ディレクトリ（記事管理のディレクトリ＋保存済み）。URLの推定＝そのディレクトリの記事URLで多い「ドメイン/最初のフォルダ/」 */
function cpInitSubs() {
  const saved = CP.d.subs || [], names = [...new Set((artSubs(CP.media) || []).concat(saved.map(s => s.sub)))];
  CP.subs = names.map(n => { const s = saved.find(x => x.sub === n) || {}; return { sub: n, url: s.url || '', persona: Object.assign({}, s.persona || {}) }; });
  CP.persona = Object.assign({}, CP.d.persona || {});
}
/** 右上でディレクトリを選んでいたら、そのディレクトリだけ出す（全てなら全部） */
const cpSubShown = sub => !state.artSub || state.artSub === sub;
function cpGuessUrl(sub) {
  const cnt = {}; (ITEMS || []).filter(r => r.media === CP.media && r.sub === sub && /^https?:\/\//.test(r.url || '')).forEach(r => { try { const u = new URL(r.url), seg = u.pathname.split('/').filter(Boolean)[0]; if (seg) { const k = u.origin + '/' + seg + '/'; cnt[k] = (cnt[k] || 0) + 1; } } catch (e) { /* URLでない */ } });
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '';
}
/** 代表KW＝進行管理の検索KWで、検索Volが多い順に10個 */
function cpRepKws(sub) {
  const seen = new Set();
  return (ITEMS || []).filter(r => r.media === CP.media && !r.deleted && (!sub || r.sub === sub) && normKwStr(r.kw)).sort((a, b) => (Number(b.vol_avg) || 0) - (Number(a.vol_avg) || 0))
    .filter(r => { const k = normKwStr(r.kw).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10).map(r => normKwStr(r.kw));
}
async function cpSave(part, val) {
  const res = await apiSend('PUT', '/concept', Object.assign({ media: CP.media, version: CP.d.version }, typeof part === 'object' ? part : { [part]: val }));
  CP.d = Object.assign(CP.d, res); GUIDE = null;   /* ガイドラインを変えたら記事の判定も読み直す */
  return res;
}
/* ディレクトリごとに色（ペルソナ・競合サイトで同じ色。メディアは -1）（2026-11-16 ユーザー指定：色を付けて見やすく） */
const cpColor = i => i < 0 ? 'cp-cm' : 'cp-c' + (i % 8);
/* 長い文は途切れさせない：中身に合わせて高さを伸ばす（2026-11-16 ユーザー指定） */
function cpAutosize(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }
function paintConcept() {
  const d = CP.d, ed = d.canEdit, dis = ed ? '' : ' disabled', box = $('cp-body'); if (!box) return;
  if (!CP_TABS.some(t => t[0] === CP.tab)) CP.tab = 'concept';
  const tabs = '<div class="seg cp-tabs">' + CP_TABS.map(([k, l]) => '<button type="button" data-cptab="' + k + '" aria-pressed="' + (CP.tab === k) + '">' + l + '</button>').join('') + '</div>';
  const upd = d.updatedAt ? '<span class="note">最終更新：' + esc(d.updatedBy) + '（' + esc(String(d.updatedAt).slice(0, 16).replace('T', ' ')) + '）</span>' : '';
  let body = '';
  if (CP.tab === 'concept') {
    const c = d.concept || {};
    body = '<div class="cp-form">' + (d.keys || []).map(([k, l]) => '<label class="cp-f' + (CP_LONG.includes(k) ? ' cp-long' : '') + '"><span class="cp-l">' + esc(l) + '</span>' + (CP_LONG.includes(k) ? '<textarea rows="4" class="cp-auto" data-cpc="' + k + '" placeholder="' + esc(CP_PH[k] || '') + '"' + dis + '>' + esc(c[k] || '') + '</textarea>'
      : '<input data-cpc="' + k + '" value="' + esc(c[k] || (k === 'url' ? '' : '')) + '" placeholder="' + esc(k === 'url' && d.siteUrl ? d.siteUrl : CP_PH[k] || '') + '"' + dis + '>') + '</label>').join('') + '</div>'
      + (ed ? '<div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" id="cp-save-c">コンセプトを保存</button></div>' : '');
  } else if (CP.tab === 'persona') {
    const ta = (A, m, i) => '<div class="cp-pta"><label><span class="ol-pl">考え</span><textarea rows="2" class="cp-auto" data-' + A + '="persona_thought" data-cpi="' + i + '"' + dis + '>' + esc(m.persona_thought || '') + '</textarea></label><label><span class="ol-pl">悩み</span><textarea rows="2" class="cp-auto" data-' + A + '="persona_worry" data-cpi="' + i + '"' + dis + '>' + esc(m.persona_worry || '') + '</textarea></label></div>';
    const block = (i, m) => '<div class="cp-pbox" data-cpbox="' + i + '">' + olPersonaHtml(dis, m, 'cpp') + ta('cpp', m, i) + '</div>';
    body = '<p class="note">メディアのペルソナ1つと、ディレクトリごとのペルソナです。構成シートの「ペルソナをコピー」→「メディアから」「ディレクトリから」で記事にコピーできます。</p>'
      + '<div class="cp-dir ' + cpColor(-1) + '"><h3 class="cp-dir-h">メディア：' + esc(mediaLabel(CP.media)) + '</h3>' + block(-1, CP.persona) + '</div>'
      + CP.subs.map((s, i) => cpSubShown(s.sub) ? '<div class="cp-dir ' + cpColor(i) + '"><h3 class="cp-dir-h">ディレクトリ：' + esc(s.sub) + '</h3>' + block(i, s.persona) + '</div>' : '').join('')
      + (ed ? '<div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" id="cp-save-p">ペルソナを保存</button></div>' : '');
  } else if (CP.tab === 'guide') {
    const g = CP.g = CP.g || JSON.parse(JSON.stringify(d.guideline));
    body = '<p class="note">記事の「ガイドライン確認」の項目です（進行状況が「記事執筆完了」以降の記事に出ます）。項目を直すと、各記事の判定は今の項目で行います。' + (d.guidelineDefault ? '<b>今は初期値です。</b>' : '') + '</p>'
      + g.sections.map((s, si) => '<div class="cp-gsec"><div class="row cp-gsec-h">' + (ed ? '<input class="cp-gst" data-gs="' + si + '" value="' + esc(s.title) + '"><button class="linkbtn" type="button" data-gsup="' + si + '">↑</button><button class="linkbtn" type="button" data-gsdel="' + si + '">見出しごと削除</button>' : '<b>' + esc(s.title) + '</b>') + '<span class="note">' + s.items.length + '項目</span></div>'
        + '<table class="am-table cp-gtbl"><thead><tr><th class="c-ctr" style="width:40px">#</th><th class="c-txt" style="width:200px">項目</th><th class="c-txt">説明</th>' + (ed ? '<th style="width:110px"></th>' : '') + '</tr></thead><tbody>'
        + s.items.map((x, ii) => '<tr><td class="c-ctr">' + (ii + 1) + '</td>' + (ed ? '<td class="c-txt"><input data-gi="' + si + ':' + ii + '" data-gf="title" value="' + esc(x.title) + '"></td><td class="c-txt"><input data-gi="' + si + ':' + ii + '" data-gf="desc" value="' + esc(x.desc) + '"></td><td class="c-ctr"><button class="linkbtn" type="button" data-giup="' + si + ':' + ii + '">↑</button><button class="linkbtn" type="button" data-gidel="' + si + ':' + ii + '">削除</button></td>'
          : '<td class="c-txt"><b>' + esc(x.title) + '</b></td><td class="c-txt" style="white-space:normal">' + esc(x.desc) + '</td>') + '</tr>').join('') + '</tbody></table>'
        + (ed ? '<button class="btn sm" type="button" data-giadd="' + si + '">＋ 項目を追加</button>' : '') + '</div>').join('')
      + (ed ? '<div class="row"><button class="btn sm" type="button" id="cp-gsadd">＋ 見出しを追加</button></div>' : '')
      + '<h3 class="am-h">参考リンク</h3>' + (ed ? (g.refs || []).map((x, i) => '<div class="row cp-gref"><input data-gr="' + i + '" data-gf="title" value="' + esc(x.title) + '" placeholder="名前"><input data-gr="' + i + '" data-gf="url" value="' + esc(x.url) + '" placeholder="https://…" style="flex:1"><button class="linkbtn" type="button" data-grdel="' + i + '">削除</button></div>').join('') + '<button class="btn sm" type="button" id="cp-gradd">＋ リンクを追加</button>'
        : '<ul>' + (g.refs || []).map(x => '<li><a href="' + escUrl(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a></li>').join('') + '</ul>')
      + (ed ? '<div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px">' + (d.guidelineDefault ? '' : '<button class="btn" type="button" id="cp-greset">初期値に戻す</button>') + '<button class="btn" type="button" id="cp-gcancel">変更を取り消す</button><button class="btn primary" type="button" id="cp-save-g">ガイドラインを保存</button></div>' : '');
  } else {
    const marks = Object.fromEntries((d.marks || []).map(m => [m.domain, m.mark]));
    const latest = (sub, method) => (d.competitors || []).find(x => (x.sub || '') === sub && x.method === method);
    const nfmt = v => v == null ? '<span class="note">—</span>' : nf.format(v);
    const tbl = (res, method) => {
      if (!res) return '<p class="empty">まだ取得していません</p>';
      let list = res.list.slice().sort((a, b) => (marks[b.domain] === 'star') - (marks[a.domain] === 'star'));
      const nEx = list.filter(x => marks[x.domain] === 'exclude').length;
      if (!CP.showEx) list = list.filter(x => marks[x.domain] !== 'exclude');
      return '<p class="note">' + esc(String(res.at || '').slice(0, 16).replace('T', ' ')) + ' ' + esc(res.name || res.by || '') + 'が取得' + (res.kws && res.kws.length ? '／代表KW：' + esc(res.kws.join('、')) : '') + (res.target ? '／対象：' + esc(res.target) : '') + (nEx ? '／除外 ' + nEx + '件' : '') + '</p>'
        + '<div class="table-wrap"><table class="am-table cp-ctbl"><thead><tr><th class="c-txt">サイト名</th><th class="c-txt">ドメイン</th><th class="c-num">DR</th><th class="c-num">オーガニックトラフィック</th><th class="c-num">' + (method === 'overlap' ? '共通KW数' : '上位に出たKW数') + '</th><th></th></tr></thead><tbody>'
        + list.map(x => { const mk = marks[x.domain] || ''; return '<tr class="' + (mk === 'star' ? 'cp-star' : mk === 'exclude' ? 'cp-ex' : '') + '"><td class="c-txt">' + (mk === 'star' ? '★ ' : '') + esc(x.name || x.domain) + '</td><td class="c-txt"><a href="https://' + esc(x.domain) + '/" target="_blank" rel="noopener">' + esc(x.domain) + '</a></td><td class="c-num">' + nfmt(x.dr) + '</td><td class="c-num">' + nfmt(x.traffic) + '</td><td class="c-num">' + (method === 'overlap' ? nfmt(x.common) : nfmt(x.hits) + (x.best ? '<span class="note">（最高' + x.best + '位）</span>' : '')) + '</td>'
          + '<td class="c-ctr" style="white-space:nowrap">' + (ed ? '<button class="linkbtn" type="button" data-cpmark="' + esc(x.domain) + '" data-mk="star">' + (mk === 'star' ? '★解除' : '★重要') + '</button> <button class="linkbtn" type="button" data-cpmark="' + esc(x.domain) + '" data-mk="exclude">' + (mk === 'exclude' ? '除外を戻す' : '除外') + '</button>' : '') + '</td></tr>'; }).join('')
        + '</tbody></table></div>';
    };
    const targets = [{ sub: '', label: 'メディア全体：' + mediaLabel(CP.media) }].concat(CP.subs.map(s => ({ sub: s.sub, label: 'ディレクトリ：' + s.sub })));
    body = '<p class="note">Ahrefs から取るのは「取得」を押したときだけです（Ahrefs のユニットを使います）。上位10件・大手サイトも含みます（自社メディアは除く）。「★重要」「除外」はメディアごとに残ります。</p>'
      + '<label class="note"><input type="checkbox" id="cp-showex"' + (CP.showEx ? ' checked' : '') + '> 除外したサイトも表示</label>'
      + targets.map((t, ti) => { if (t.sub && !cpSubShown(t.sub)) return ''; const s = CP.subs.find(x => x.sub === t.sub), guess = t.sub ? cpGuessUrl(t.sub) : '';
        return '<div class="cp-ctarget cp-dir ' + cpColor(ti - 1) + '"><h3 class="cp-dir-h">' + esc(t.label) + '</h3>'
          + (t.sub ? '<div class="row" style="gap:6px;align-items:center"><span class="note">ディレクトリのURL</span><input class="cp-durl" data-cpdurl="' + ti + '" value="' + esc(s.url || '') + '" placeholder="' + esc(guess || 'https://…/ディレクトリ/') + '"' + dis + ' style="flex:1;max-width:460px">' + (guess && !s.url ? '<span class="note">（空欄なら記事URLから推定：' + esc(guess) + '）</span>' : '') + '</div>' : '')
          + '<div class="cp-cgrid">' + [['overlap', 'KWがかぶるサイト'], ['serp', '代表KWの検索上位']].map(([m, l]) => '<div class="cp-cbox"><div class="row" style="justify-content:space-between"><b>' + l + '</b>' + (ed ? '<button class="btn sm primary" type="button" data-cpfetch="' + ti + '" data-method="' + m + '">取得（Ahrefs）</button>' : '') + '</div>' + tbl(latest(t.sub, m), m) + '</div>').join('') + '</div></div>'; }).join('');
  }
  box.innerHTML = H('コンセプト <small>' + esc(mediaLabel(CP.media)) + '</small>', CP.tab === 'compete' ? ['Ahrefs'] : [], upd) + tabs + (ed ? '' : '<p class="note">見るだけです（編集は権限管理の「コンセプトの編集」がある人）。</p>') + '<div class="cp-body">' + body + '</div>';
  box.querySelectorAll('textarea.cp-auto').forEach(el => { cpAutosize(el); el.addEventListener('input', () => cpAutosize(el)); });
  bindConcept();
}
function bindConcept() {
  const box = $('cp-body'), d = CP.d, err = e => alert('保存できませんでした：' + e.message);
  box.querySelectorAll('[data-cptab]').forEach(b => b.onclick = () => { if (CP.tab === 'guide' && CP.gDirty && !confirm('ガイドラインの変更を保存していません。移動すると消えます。よろしいですか？')) return; if (CP.tab === 'guide') { CP.g = null; CP.gDirty = false; } CP.tab = state.cpTab = b.dataset.cptab; paintConcept(); });
  if ($('cp-save-c')) $('cp-save-c').onclick = async () => { const c = {}; box.querySelectorAll('[data-cpc]').forEach(el => { if (el.value.trim()) c[el.dataset.cpc] = el.value.trim(); }); if (c.url && !/^https?:\/\//.test(c.url)) return alert('URLは http:// か https:// で始めてください'); if (c.cv_form && !/^https?:\/\//.test(c.cv_form)) return alert('CV（フォーム）は http:// か https:// で始まるURLを入れてください');
    try { await cpSave('concept', c); paintConcept(); toast('コンセプトを保存しました'); } catch (e) { err(e); } };
  // ペルソナ：入力をそのまま CP に入れる。家族構成を変えたら人数の欄を出し直す
  const target = i => Number(i) < 0 ? CP.persona : CP.subs[Number(i)].persona;
  box.querySelectorAll('[data-cpbox]').forEach(bx => { const i = bx.dataset.cpbox; bx.querySelectorAll('[data-cpp]').forEach(el => { el.oninput = el.onchange = ev => { const m = target(i), k = el.dataset.cpp, v = el.value; if (el.tagName === 'SELECT') el.classList.toggle('ol-ph', !v); if (String(v).trim()) m[k] = v; else delete m[k];
    if (/^persona_family/.test(k)) { const t = olFamilyTotal(m); if (t != null) m.persona_family_total = String(t); else delete m.persona_family_total; if (ev.type === 'change') { const y = window.scrollY; paintConcept(); window.scrollTo(0, y); } } }; }); });
  if ($('cp-save-p')) $('cp-save-p').onclick = async () => { try { await cpSave({ persona: CP.persona, subs: CP.subs.map(s => ({ sub: s.sub, url: s.url, persona: s.persona })) }); cpInitSubs(); paintConcept(); toast('ペルソナを保存しました'); } catch (e) { err(e); } };
  // ガイドライン（保存を押すまで画面の中だけ）
  if (CP.tab === 'guide' && d.canEdit) {
    const g = CP.g, dirty = () => { CP.gDirty = true; }, re = () => { const y = window.scrollY; paintConcept(); window.scrollTo(0, y); };
    const ix = v => v.split(':').map(Number);
    box.querySelectorAll('[data-gs]').forEach(el => el.oninput = () => { g.sections[Number(el.dataset.gs)].title = el.value; dirty(); });
    box.querySelectorAll('[data-gi]').forEach(el => el.oninput = () => { const [a, b] = ix(el.dataset.gi); g.sections[a].items[b][el.dataset.gf] = el.value; dirty(); });
    box.querySelectorAll('[data-gr]').forEach(el => el.oninput = () => { g.refs[Number(el.dataset.gr)][el.dataset.gf] = el.value; dirty(); });
    box.querySelectorAll('[data-giadd]').forEach(b => b.onclick = () => { g.sections[Number(b.dataset.giadd)].items.push({ title: '', desc: '' }); dirty(); re(); });
    box.querySelectorAll('[data-gidel]').forEach(b => b.onclick = () => { const [a, c] = ix(b.dataset.gidel); const it = g.sections[a].items[c]; if (it.title && !confirm('「' + it.title + '」を削除します。よろしいですか？（記事のチェックは、項目を戻したときのために残します）')) return; g.sections[a].items.splice(c, 1); dirty(); re(); });
    box.querySelectorAll('[data-giup]').forEach(b => b.onclick = () => { const [a, c] = ix(b.dataset.giup); if (!c) return; const L = g.sections[a].items; [L[c - 1], L[c]] = [L[c], L[c - 1]]; dirty(); re(); });
    box.querySelectorAll('[data-gsup]').forEach(b => b.onclick = () => { const a = Number(b.dataset.gsup); if (!a) return; [g.sections[a - 1], g.sections[a]] = [g.sections[a], g.sections[a - 1]]; dirty(); re(); });
    box.querySelectorAll('[data-gsdel]').forEach(b => b.onclick = () => { const a = Number(b.dataset.gsdel); if (!confirm('見出し「' + g.sections[a].title + '」と、その中の項目' + g.sections[a].items.length + '個を削除します。よろしいですか？')) return; g.sections.splice(a, 1); dirty(); re(); });
    box.querySelectorAll('[data-grdel]').forEach(b => b.onclick = () => { g.refs.splice(Number(b.dataset.grdel), 1); dirty(); re(); });
    if ($('cp-gsadd')) $('cp-gsadd').onclick = () => { g.sections.push({ title: '新しい見出し', items: [] }); dirty(); re(); };
    if ($('cp-gradd')) $('cp-gradd').onclick = () => { g.refs = g.refs || []; g.refs.push({ title: '', url: '' }); dirty(); re(); };
    if ($('cp-gcancel')) $('cp-gcancel').onclick = () => { CP.g = null; CP.gDirty = false; re(); };
    if ($('cp-greset')) $('cp-greset').onclick = async () => { if (!confirm('ガイドラインを初期値に戻します。よろしいですか？（今の内容は履歴に残ります）')) return; try { await cpSave('guideline', null); CP.g = null; CP.gDirty = false; re(); toast('初期値に戻しました'); } catch (e) { err(e); } };
    if ($('cp-save-g')) $('cp-save-g').onclick = async () => {
      const empty = g.sections.flatMap(s => s.items).filter(x => !String(x.title || '').trim()).length; if (empty && !confirm('項目名が空の行が' + empty + '個あります。空の行は保存しません。よろしいですか？')) return;
      const badRef = (g.refs || []).find(x => x.title && x.url && !/^https?:\/\//.test(x.url)); if (badRef) return alert('参考リンクのURLは http:// か https:// で始めてください：' + badRef.title);
      try { await cpSave('guideline', g); CP.g = null; CP.gDirty = false; re(); toast('ガイドラインを保存しました（記事のガイドライン確認にも反映）'); } catch (e) { err(e); } };
  }
  // 競合サイト
  if ($('cp-showex')) $('cp-showex').onchange = ev => { CP.showEx = ev.target.checked; paintConcept(); };
  box.querySelectorAll('[data-cpdurl]').forEach(el => el.onchange = async () => { const t = CP.subs[Number(el.dataset.cpdurl) - 1], v = el.value.trim(); if (v && !/^https?:\/\//.test(v)) { el.value = t.url || ''; return alert('URLは https:// から入れてください'); } t.url = v;
    try { await cpSave('subs', CP.subs.map(s => ({ sub: s.sub, url: s.url, persona: s.persona }))); toast('ディレクトリのURLを保存しました'); } catch (e) { err(e); } });
  box.querySelectorAll('[data-cpmark]').forEach(b => b.onclick = async () => {
    const dm = b.dataset.cpmark, mk = b.dataset.mk, list = (d.marks || []).filter(m => m.domain !== dm), cur = (d.marks || []).find(m => m.domain === dm);
    if (!(cur && cur.mark === mk)) list.push({ domain: dm, mark: mk });
    try { await cpSave('marks', list); paintConcept(); } catch (e) { err(e); } });
  box.querySelectorAll('[data-cpfetch]').forEach(b => b.onclick = async () => {
    const ti = Number(b.dataset.cpfetch), sub = ti ? CP.subs[ti - 1].sub : '', method = b.dataset.method;
    const dirUrl = ti ? (CP.subs[ti - 1].url || cpGuessUrl(sub)) : '', kws = method === 'serp' ? cpRepKws(sub) : [];
    if (method === 'overlap' && ti && !dirUrl) return alert('ディレクトリのURLを入れてください（記事URLから推定できませんでした）');
    if (method === 'serp' && !kws.length) return alert('代表KWがありません（進行管理に検索KWがある記事がありません）');
    if (!confirm((method === 'overlap' ? 'KWがかぶるサイトを Ahrefs から取得します。\n対象：' + (ti ? dirUrl : d.siteUrl) : '代表KW（' + kws.length + '個）の検索上位を Ahrefs から取得します。\n' + kws.join('、')) + '\n\nAhrefs のユニットを使います。よろしいですか？')) return;
    b.disabled = true; b.textContent = '取得中…';
    try { const res = await apiSend('POST', '/concept/competitors', { media: CP.media, sub, method, kws, dirUrl }); d.competitors = [res.result].concat((d.competitors || []).filter(x => !((x.sub || '') === sub && x.method === method))); paintConcept(); toast('競合サイトを取得しました（' + res.result.list.length + '件）'); }
    catch (e) { b.disabled = false; b.textContent = '取得（Ahrefs）'; alert('取得できませんでした：' + e.message); }
  });
}

function viewAmSettings() {
  return { html: '<section class="grid2 even"><div class="panel" id="st-cat"><p class="loading">読み込み中…</p></div><div class="panel" id="st-tag"></div></section><section class="panel" id="st-cta"></section><section class="panel" id="st-appeal"></section><section class="panel" id="st-content"></section>', view: '記事管理：各種設定', after: async () => {
    await loadItems();
    const media = artMedia(); renderArtMediaSelect();
    if (media === ALL) {   // カテゴリ・タグ・CTA はメディアごとの設定なので、メディア累計では一覧だけ
      $('st-cat').innerHTML = H('各種設定 <small>メディア累計</small>', ['記事管理']) + '<p class="empty">カテゴリ・タグ・CTA・訴求ブロックはメディアごとの設定です。右上でメディアを選んでください。</p>';
      ['st-tag', 'st-cta', 'st-appeal', 'st-content'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
      return;
    }
    const { terms, blocks } = await loadArtOptions(media, true);
    const edit = canEditArticles();
    const termTable = (list, label) => !terms.connected ? '<p class="empty">このメディアはWordPressがまだ連携されていません（管理 → メディア管理 → WordPress設定）。</p>'
      : list.length ? '<div class="table-wrap am-scroll" style="max-height:360px"><table class="am-table"><thead><tr><th class="c-txt">' + label + '</th><th class="c-txt">スラッグ</th><th class="c-num">記事数</th></tr></thead><tbody>'
        + list.map(t => '<tr><td class="c-txt">' + (t.parent ? '　└ ' : '') + esc(t.name) + '</td><td class="c-txt note">' + esc(t.slug) + '</td><td class="c-num">' + nf.format(t.count || 0) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<p class="empty">' + label + 'はありません</p>';
    $('st-cat').innerHTML = H('カテゴリ <small>' + esc(mediaLabel(media)) + '・WordPressから自動取得（この画面では変更できません）・' + terms.categories.length + '件</small>', ['WordPress']) + termTable(terms.categories, 'カテゴリ');
    $('st-tag').innerHTML = H('タグ <small>' + esc(mediaLabel(media)) + '・WordPressから自動取得（この画面では変更できません）・' + terms.tags.length + '件</small>', ['WordPress']) + termTable(terms.tags, 'タグ');
    // CTA・訴求ブロック・記事用コンテンツ：WordPress の「マイブロック」から自動取得（この画面では編集しない。2026-10-26 ユーザー指定）
    const blockPanel = (kind, label, sheetKey) => {
      const list = blocks[kind] || [];
      // 入れ込み記事数：進行管理（記事管理シート）の「CTA」「訴求ブロック」の欄から数える（2026-10-26 ユーザー指定で名前の書き方の違いを吸収）
      // ・全角半角・空白・かっこ・「の」の違いは同じ名前として扱う（例：CTA4（洗面台水漏れ）＝ CTA4(洗面台の水漏れ)）
      // ・訴求ブロックが「高・中・低」だけのときは、記事のディレクトリ（トイレ・洗面台など）を名前に含み、末尾が同じ段階のブロックとして数える
      const hit = (b, r) => blockHit(b.name, r, sheetKey);
      const mine = (ITEMS || []).filter(r => r.media === media);
      const used = b => sheetKey ? mine.filter(r => hit(b, r)).length : null;
      const notInWp = sheetKey ? sheetValues(media, sheetKey).filter(n => !mine.some(r => String(r[sheetKey] || '').trim() === n && list.some(b => hit(b, r)))) : [];
      return H(label + ' <small>' + esc(mediaLabel(media)) + '・WordPressのマイブロックから自動取得（この画面では変更できません）・' + list.length + '件</small>', ['WordPress'])
        + (!blocks.available ? '<p class="empty">このメディアの WordPress には「マイブロック」がありません。</p>'
          : list.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">' + label + '名</th>' + (sheetKey ? '<th class="c-num">入れ込み記事数</th>' : '') + '<th class="c-txt">ショートコード</th><th class="c-txt">WordPressの更新日</th></tr></thead><tbody>'
            + list.map(b => '<tr><td class="c-txt"><b>' + esc(b.name) + '</b></td>' + (sheetKey ? '<td class="c-num">' + used(b) + '</td>' : '') + '<td class="c-txt"><code class="code-peek" style="user-select:all">' + esc(b.code) + '</code></td><td class="c-txt note">' + esc((b.updatedAt || '').slice(0, 10).replace(/-/g, '/')) + '</td></tr>').join('') + '</tbody></table></div>'
          : '<p class="empty">タイトルに「' + (kind === 'cta' ? 'CTA' : kind === 'appeal' ? '訴求' : '') + '」が入ったマイブロックはありません</p>')
        + (notInWp.length ? '<p class="note">記事管理シートにあって、どのマイブロックとも照合できなかった名前：' + notInWp.map(esc).join('、') + '</p>' : '')
        + '<p class="note">' + (kind === 'cta' ? 'タイトルに「CTA」が入ったマイブロックです。' : kind === 'appeal' ? 'タイトルに「訴求」が入ったマイブロックです。' : 'タイトルに「CTA」「訴求」が入っていないマイブロックです。') + (sheetKey ? '進行管理の「' + label + '」のプルダウンでは、ここにある名前を選べます。' : '') + 'ショートコードはクリックで全体を選べます。</p>';
    };
    $('st-cta').innerHTML = blockPanel('cta', 'CTA', 'cta');
    $('st-appeal').innerHTML = blockPanel('appeal', '訴求ブロック', 'appeal_block');
    $('st-content').innerHTML = blockPanel('content', '記事用コンテンツ', '');
  } };
}

// ================= モーダル =================
function openModal(inner) { const m = $('modal'); m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${inner}</div>`; m.hidden = false; m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal); m.onclick = ev => { if (ev.target === m) closeModal(); }; }
function closeModal() { const m = $('modal'); m.hidden = true; m.innerHTML = ''; }
/** 画面の下に短いお知らせを出す（数秒で消える） */
function toast(msg) { let t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f6f54;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;z-index:60;box-shadow:0 4px 14px rgba(0,0,0,.2);transition:opacity .3s'; document.body.appendChild(t); } t.textContent = msg; t.style.opacity = '1'; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => { t.hidden = true; }, 300); }, 2500); }

// ================= 管理：支出管理（契約管理シートから1回だけ取り込んだ請求。照合と人ごとの内訳）（2026-10-14 ユーザー指定） =================
// 支出の金額は SEO数値管理シートのまま。ここでは、請求（人ごと・税抜きの小計）と、シートのディレクション費＋記事制作費＋プレスリリース費を並べて差を見る
// ================= 単発発注などの請求書の取り込み（2026-10-29 ユーザー指定） =================
const EXP_ST = { draft: ['確認待ち', 'wait'], confirmed: ['確定', 'ok'] };
const yenN = v => Number(String(v || '').replace(/[^\d.-]/g, '')) || 0;
/** 円の表記。ドルのものは括弧でドルを添える（2026-10-29 ユーザー指定） */
const yenUsd = (yen, usd) => nf.format(Math.round(yen || 0)) + '円' + (usd != null ? '（$' + Number(usd).toLocaleString('en-US') + '）' : '');
/** 定額のサービス（ツール・AI費）：毎月自動で支出に入る。ドルはその月の月末のレートで円に。メディアは Ahrefs の順位追跡のKW数の割合で分ける */
async function drawSubs(cat) {   /* cat：その区分のサービスだけ表示（保存は全部）（2026-11-02 ユーザー指定） */
  const box = $('ex-subs'); if (!box) return;
  let d; try { d = await api('/subscriptions'); } catch (e) { box.remove(); return; }
  const rate = d.fx && d.fx.rate, list = d.items.map(x => Object.assign({}, x));
  const draw = () => {
    const sh = Object.entries(d.shares || {}).sort((a, b) => b[1] - a[1]);
    box.innerHTML = H('定額のサービス <small>' + (Array.isArray(cat) ? 'ツール利用費' : cat ? esc(COST_LABELS[cat] || '') : 'ツール利用費') + '。毎月自動で支出に入ります（税抜き）</small>', [])
      + '<p class="note">ドルのサービスは、その月の月末の為替レートで円に換算します' + (rate ? '（今月の目安：1ドル＝' + rate + '円・' + esc(d.fx.date) + '）' : '') + '。メディアへの分け方は Ahrefs の順位追跡のKW数の割合：' + sh.map(([m, v]) => esc(mediaLabel(m)) + ' ' + Math.round(v * 1000) / 10 + '%').join('・') + '</p>'
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">サービス</th><th class="c-txt">' + (d.groups ? '小項目' : '区分') + '</th><th class="c-num">月額（税抜き）</th><th class="c-ctr">通貨</th><th class="c-num">今月の円</th><th class="c-ctr">開始月</th><th class="c-ctr">終了月</th><th class="c-txt">メモ</th><th></th></tr></thead><tbody>'
      + list.map((x, i) => cat && !(Array.isArray(cat) ? cat.includes(x.category) : x.category === cat) ? '' : '<tr data-sub="' + i + '"><td class="c-txt"><input data-f="name" value="' + esc(x.name) + '" style="min-width:16em"></td><td class="c-txt">' + (d.groups ? '<select data-f="group">' + Object.entries(d.groups).map(([k, l]) => '<option value="' + k + '"' + (x.group === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' : '<select data-f="category">' + Object.entries(d.cats).map(([k, l]) => '<option value="' + k + '"' + (x.category === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>') + '</td>'
        + '<td class="c-num"><input data-f="amount" inputmode="decimal" value="' + (x.amount || '') + '" style="width:7em"></td><td class="c-ctr"><select data-f="currency"><option value="JPY"' + (x.currency !== 'USD' ? ' selected' : '') + '>円</option><option value="USD"' + (x.currency === 'USD' ? ' selected' : '') + '>ドル</option></select></td>'
        + '<td class="c-num">' + (x.currency === 'USD' ? (rate ? yenUsd(x.amount * rate, x.amount) : '—') : yenUsd(x.amount)) + '</td><td class="c-ctr"><input data-f="startYm" type="month" value="' + esc(x.startYm || '') + '"></td><td class="c-ctr"><input data-f="endYm" type="month" value="' + esc(x.endYm || '') + '"></td>'
        + '<td class="c-txt"><input data-f="note" value="' + esc(x.note || '') + '"></td><td><button class="linkbtn" type="button" data-subdel="' + i + '">×</button></td></tr>').join('') + '</tbody></table></div>'
      + '<p class="err" id="sub-err" hidden></p><div class="row" style="justify-content:space-between; margin-top:8px"><button class="btn sm" type="button" id="sub-add">＋ サービスを追加</button><button class="btn primary" type="button" id="sub-save">保存</button></div>';
    const read = () => box.querySelectorAll('[data-sub]').forEach(tr => { const x = list[Number(tr.dataset.sub)]; tr.querySelectorAll('[data-f]').forEach(el => { x[el.dataset.f] = el.dataset.f === 'amount' ? Number(el.value) || 0 : el.value.trim(); }); if (x.group && x.category !== 'cost_site') x.category = x.group === 'ai' ? 'cost_ai' : 'cost_tool'; });   /* 小項目が AIツールなら AI費、ほかはツール */
    box.querySelectorAll('[data-f]').forEach(el => el.onchange = () => { read(); draw(); });
    box.querySelectorAll('[data-subdel]').forEach(b => b.onclick = () => { read(); list.splice(Number(b.dataset.subdel), 1); draw(); });
    $('sub-add').onclick = () => { read(); list.push({ name: '', category: (Array.isArray(cat) ? cat[0] : cat) || 'cost_tool', group: 'other', amount: 0, currency: 'JPY', startYm: CUR_MONTH, endYm: '', note: '' }); draw(); };
    $('sub-save').onclick = async () => { read(); try { await apiSend('PUT', '/subscriptions', { items: list }); toast('保存しました（支出に入るまで最大10分）'); if (box.dataset.after) render(); } catch (e) { $('sub-err').textContent = e.message; $('sub-err').hidden = false; } };
  };
  draw();
}
/** 確認の画面のアラート（サーバーと同じ決まり。ng＝確定できない、warn＝注意） */
function expChecks(v) {
  const a = [], add = (l, m) => a.push([l, m]), isYm = x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x || '');
  if (!v.textLength) add('warn', 'PDF から文字を読み取れませんでした（画像の PDF の可能性）。項目をすべて手で入力してください');
  if (!v.vendor) add('ng', '請求元（会社名・氏名）が入っていません');
  if (!v.issueDate) add('ng', '請求日が入っていません');
  if (!isYm(v.ym)) add('ng', '計上する月（何月分の支出か）が入っていません');
  if (!(v.total > 0)) add('ng', '請求金額（税込み）が入っていません');
  if (!(v.subtotal > 0)) add('ng', '小計（税抜き）が入っていません');
  if (!COST_LABELS[v.category] || v.category === 'cost_staff') add('ng', '支出の区分を選んでください');
  { const lt = (v.links || []).reduce((a, l) => a + (Number(l.amount) || 0), 0); if (v.category === 'cost_press' && v.subtotal > 0 && lt > v.subtotal + 1) add('ng', 'リリースに紐づけた金額の合計（' + nf.format(lt) + '円）が小計（税抜き）より多くなっています'); if ((v.links || []).some(l => !l.releaseId)) add('ng', '紐づけるリリースを選んでください'); }
  const al = (v.allocations || []).reduce((s2, x) => s2 + (Number(x.amount) || 0), 0);
  if (!(v.allocations || []).length || v.allocations.some(x => !x.media)) add('ng', 'メディアを選んでください');
  else if (v.subtotal > 0 && Math.round(al) !== Math.round(v.subtotal)) add('ng', 'メディアの配分の合計（' + nf.format(al) + '円）が小計（税抜き）と合っていません');
  if (v.subtotal > 0 && v.total > 0 && Math.round(v.subtotal + (v.tax || 0) - (v.withholding || 0)) !== Math.round(v.total)) add('warn', '小計＋消費税' + (v.withholding ? '−源泉所得税' : '') + ' が請求金額と合っていません');
  if (v.subtotal > 0 && Math.abs((v.tax || 0) - Math.floor(v.subtotal * 0.1)) > 1) add('warn', '消費税が小計の10%ではありません（軽減税率・端数・免税などを確認してください）');
  if (!/^T\d{13}$/.test(v.invoiceNo || '')) add('warn', 'インボイス登録番号（T＋13けた）がありません。免税事業者の場合は仕入税額控除の対象外です');
  if (v.toBest === false) add('warn', '宛名に「BEST株式会社」が見つかりません。宛名を確認してください');
  if (!v.dueDate) add('warn', '支払期日が入っていません');
  if (!(v.bank || {}).bankName || !(v.bank || {}).number) add('warn', '振込先（銀行名・口座番号）が入っていません');
  return a;
}
async function expFetch(pathName, opt) { const tok = await fbAuth.currentUser.getIdToken(); return fetch('/api' + pathName, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, (opt || {}).headers || {}) })); }
/* 区分ごとの支出の追加：PDF の取り込みか手で入力。vendors＝よく使う支払い先のボタン（プレスリリース費＝PR TIMES・freaaasy）（2026-11-02 ユーザー指定） */
/* opt：{ box（枠のid。はじめは ex-imp）, vendorRe（その支払い先の分だけ出す）, title } */
let EXP_IMP_ARGS = {}, EXP_LIST_CACHE = null;
/** 支出一覧のディレクトリ単位：「メディア|」（ディレクトリなし）の金額を、その月にそのメディアで支出があるディレクトリ（なければ期間中に出てくるディレクトリ）で均等に分ける。ディレクトリのないメディアはそのまま（2026-11-04 ユーザー指定） */
function spreadDirs(DS) {
  const out = {}, subsAt = {}, subsAll = {};
  Object.values(DS).forEach(o => Object.entries(o).forEach(([key, byYm]) => { const [m, sb] = key.split('|'); if (!sb) return; (subsAll[m] = subsAll[m] || new Set()).add(sb); Object.entries(byYm).forEach(([ym, v]) => { if (v) ((subsAt[m] = subsAt[m] || {})[ym] = subsAt[m][ym] || new Set()).add(sb); }); }));
  const put = (k, key, ym, v) => { ((out[k] = out[k] || {})[key] = out[k][key] || {})[ym] = (out[k][key][ym] || 0) + v; };
  Object.entries(DS).forEach(([k, o]) => Object.entries(o).forEach(([key, byYm]) => { const [m, sb] = key.split('|'); Object.entries(byYm).forEach(([ym, v]) => {
    if (sb) return put(k, key, ym, v);
    const dirs = [...((subsAt[m] || {})[ym] || subsAll[m] || [])];
    if (!dirs.length) return put(k, key, ym, v);
    dirs.forEach(d => put(k, m + '|' + d, ym, v / dirs.length)); }); }));
  return out;
}   /* 支出一覧の計算結果（10分） */
async function drawExpImport(cat, vendors, opt) {
  if (cat === undefined) { for (const [id, a] of Object.entries(EXP_IMP_ARGS)) if ($(id)) await drawExpImport(...a); return; }
  opt = opt || {}; const boxId = opt.box || 'ex-imp'; EXP_IMP_ARGS[boxId] = [cat, vendors, opt];
  const box = $(boxId); if (!box) return;
  let d; try { d = await api('/expense-invoices'); } catch (e) { box.remove(); return; }   // 権限がない人には出さない
  const list = (d.list || []).filter(v => (!cat || v.category === cat || (!v.category && cat === 'cost_site')) && (!opt.vendorRe || opt.vendorRe.test(v.vendor || '')) && (!opt.notVendorRe || !opt.notVendorRe.test(v.vendor || '')));
  const Q = sel => box.querySelector(sel);
  box.innerHTML = H(opt.title || ((cat ? COST_LABELS[cat] + 'の追加' : '請求書の取り込み')) + ' <small>PDF をアップロードするか、この画面から入力 → 内容を確認して「確定」→ 支出と経理部宛ての請求メールに入ります</small>', [])
    + '<div class="row" style="gap:8px; margin-bottom:8px; flex-wrap:wrap"><label class="btn primary" style="cursor:pointer">＋ 請求書（PDF）をアップロード<input type="file" class="exi-file" accept="application/pdf" hidden></label>' + (vendors || []).map(n => '<button class="btn" type="button" data-eximan="' + esc(n) + '">＋ ' + esc(n) + 'をこの画面から入力</button>').join('') + (opt.vendorRe ? '' : '<button class="btn" type="button" data-eximan="">＋ この画面から入力</button>') + '<span class="note exi-msg"></span></div>'
    + (list.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-ctr">状態</th><th class="c-txt">請求元</th><th class="c-txt">件名</th><th class="c-ctr">計上月</th><th class="c-txt">区分</th><th class="c-txt">メディア</th><th class="c-num">請求金額（税込み）</th><th class="c-ctr">注意</th><th class="c-txt">操作</th></tr></thead><tbody>'
      + list.map((v, i) => { const ck = expChecks(v), ng = ck.filter(x => x[0] === 'ng').length, wn = ck.filter(x => x[0] === 'warn').length, st = v.sentAt ? ['経理部へ送付済み', 'ok'] : EXP_ST[v.status] || [v.status, 'off'];
        return '<tr><td class="c-ctr"><span class="pill ' + st[1] + '">' + st[0] + '</span></td><td class="c-txt">' + esc(v.vendor || '（未入力）') + '</td><td class="c-txt">' + esc(v.subject || v.fileName || '') + '</td><td class="c-ctr">' + (v.ym ? mLabel(v.ym) : '—') + '</td><td class="c-txt">' + esc(COST_LABELS[v.category] || '—') + '</td><td class="c-txt">' + esc((v.allocations || []).map(x => mediaLabel(x.media)).join('・') || '—') + '</td><td class="c-num">' + yen0(v.total) + '</td>'
          + '<td class="c-ctr">' + (v.status === 'confirmed' ? '' : (ng ? '<span class="pill ng">要修正 ' + ng + '</span> ' : '') + (wn ? '<span class="pill wait">注意 ' + wn + '</span>' : '')) + '</td><td class="c-txt"><button class="btn sm" type="button" data-exi="' + i + '">' + (v.status === 'confirmed' ? '内容を見る' : '確認する') + '</button></td></tr>'; }).join('') + '</tbody></table></div>'
      : '<p class="empty">まだ取り込んだ請求書はありません。</p>');
  Q('.exi-file').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return; const msg = Q('.exi-msg'); msg.textContent = '読み取っています…';
    try { if (me && me._preview) throw new Error('UI確認中は保存できません'); const r = await expFetch('/expense-invoices?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: f }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); msg.textContent = ''; if (cat && !j.invoice.category) j.invoice.category = cat; if ((vendors || []).length === 1 && !j.invoice.vendor) j.invoice.vendor = vendors[0]; await drawExpImport(); expModal(j.invoice); }
    catch (e) { msg.textContent = '取り込めませんでした：' + e.message; }
  };
  box.querySelectorAll('[data-exi]').forEach(b => b.onclick = () => expModal(list[Number(b.dataset.exi)]));
  box.querySelectorAll('[data-eximan]').forEach(b => b.onclick = async () => { try { if (me && me._preview) throw new Error('UI確認中は保存できません'); const r = await apiSend('POST', '/expense-invoices/manual', { category: cat || '', vendor: b.dataset.eximan }); await drawExpImport(); expModal(r.invoice); } catch (e2) { Q('.exi-msg').textContent = e2.message; } });
}
/** 内容の確認（左に PDF、右に項目とアラート）→ 下書き保存・確定 */
async function expModal(v0) {
  const v = JSON.parse(JSON.stringify(v0)); v.bank = v.bank || {}; v.allocations = (v.allocations || []).length ? v.allocations : [{ media: '', amount: v.subtotal || 0 }]; v.links = v.links || [];
  if (v.category === 'cost_press' && !PRESS_ITEMS) { try { await loadItems(); } catch (e) { /* 読めなくても入力はできる */ } }
  /* プレスリリース費：どのリリースのどのフェーズに使ったか（2026-11-02 ユーザー指定）。紐づけるとメディアの配分も紐づけから作る */
  const isPR = () => /PR\s*TIMES/i.test(v.vendor || ''), isFree = () => /free?a+sy|フリージー/i.test(v.vendor || '');
  const PHASES = () => isPR() ? ['配信'] : isFree() ? ['スクリーニング調査', '本調査（アンケート）'] : ['調査', '配信', 'その他'];
  const relLabel = x => (x.date ? x.date.replace(/-/g, '/') + ' ' : '') + (x.media === '__kurashi' ? 'くらしのレスキュー' : mediaLabel(x.media)) + (x.no ? ' No.' + x.no : '') + ' ' + String(x.title || '').slice(0, 40);
  const relOpts = () => (PRESS_ITEMS || []).filter(x => x.status !== '中止').slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const linksFromForm = () => { const rows = [...document.querySelectorAll('[data-exl]')]; if (rows.length || v.links.length) v.links = rows.map(r => ({ releaseId: r.querySelector('.exl-rel').value, phase: r.querySelector('.exl-ph').value, amount: yenN(r.querySelector('.exl-amt').value) })); };
  const allocFromLinks = () => { if (!v.links.some(l => l.releaseId)) return; const by = {}; let t = 0; v.links.forEach(l => { const x = (PRESS_ITEMS || []).find(y => y.id === l.releaseId); if (!x || x.media === '__kurashi') return; by[x.media] = (by[x.media] || 0) + (l.amount || 0); t += l.amount || 0; }); v.allocations = Object.entries(by).map(([media, amount]) => ({ media, amount })); if ((v.subtotal || 0) - t > 0) v.allocations.push({ media: '', amount: (v.subtotal || 0) - t }); if (!v.allocations.length) v.allocations = [{ media: '', amount: v.subtotal || 0 }]; };
  const locked = v.status === 'confirmed' || !!v.sentAt, medias = topMedia().map(m => m.media);
  let pdfUrl = ''; if (!v.manual) try { const r = await expFetch('/expense-invoices/' + encodeURIComponent(v.id) + '/file'); pdfUrl = URL.createObjectURL(await r.blob()); } catch (e) { /* 表示できなくても入力はできる */ }
  const inp = (k, label, req, type, ph) => afRow(label, req, '<input data-ex="' + k + '"' + (type ? ' type="' + type + '"' : '') + ' placeholder="' + (ph || '') + '" value="' + esc(String(v[k] ?? '')) + '"' + (locked ? ' disabled' : '') + '>', k);
  const read = () => { linksFromForm(); document.querySelectorAll('[data-ex]').forEach(el => { const k = el.dataset.ex; v[k] = ['subtotal', 'tax', 'withholding', 'total'].includes(k) ? yenN(el.value) : el.value.trim(); }); document.querySelectorAll('[data-exb]').forEach(el => { v.bank[el.dataset.exb] = el.value.trim(); }); v.allocations = [...document.querySelectorAll('[data-exa]')].map(r => ({ media: r.querySelector('select').value, amount: yenN(r.querySelector('input').value) })); if (v.category === 'cost_press') allocFromLinks(); };
  const draw = () => {
    const ck = expChecks(v);
    wideModal('<h2>' + (v.manual ? '支出の入力' : '請求書の確認') + ' <small class="note">' + esc(v.fileName || '') + '</small></h2><div class="exi-grid"><div class="exi-pdf">' + (pdfUrl ? '<iframe src="' + pdfUrl + '" title="請求書"></iframe>' : (v.manual ? '<p class="note">この画面から入力した支出です（PDF なし）。右の項目をすべて入力してください。</p>' : '<p class="note">PDF を表示できませんでした</p>')) + '</div><div class="exi-form">'
      + (ck.length ? '<div class="exi-alerts">' + ck.map(([l, m]) => '<p class="' + (l === 'ng' ? 'err' : 'exi-warn') + '">' + (l === 'ng' ? '要修正：' : '注意：') + esc(m) + '</p>').join('') + '</div>' : '<p class="exi-ok">必要な項目はそろっています</p>')
      + '<div class="af">' + inp('vendor', '請求元（会社名・氏名）', true) + inp('subject', '件名', false, '', '例）2026年11月分 ○○作成') + inp('issueDate', '請求日', true, 'date') + inp('dueDate', '支払期日', false, 'date') + inp('ym', '計上する月', true, 'month') + inp('invoiceNo', 'インボイス登録番号', false, '', 'T＋13けた')
      + inp('subtotal', '小計（税抜き）', true, '', '例）100000') + inp('tax', '消費税', false) + inp('withholding', '源泉所得税', false) + inp('total', '請求金額（税込み）', true)
      + afRow('支出の区分', true, '<select data-ex="category"' + (locked ? ' disabled' : '') + '><option value="">選んでください</option>' + Object.entries(COST_LABELS).filter(([k]) => k !== 'cost_staff').map(([k, l]) => '<option value="' + k + '"' + (v.category === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>', 'category')
      + afRow('メディアの配分（税抜き）', true, '<div style="display:flex; flex-direction:column; gap:6px; width:100%">' + v.allocations.map((a, i) => '<div class="row" data-exa="' + i + '" style="gap:6px"><select' + (locked ? ' disabled' : '') + '><option value="">メディア</option>' + medias.map(m => '<option value="' + esc(m) + '"' + (a.media === m ? ' selected' : '') + '>' + esc(mediaLabel(m)) + '</option>').join('') + '</select><input class="af-num" inputmode="numeric" value="' + (a.amount || '') + '"' + (locked ? ' disabled' : '') + '>' + (locked || v.allocations.length < 2 ? '' : '<button class="linkbtn" type="button" data-exdel="' + i + '">×</button>') + '</div>').join('') + (locked ? '' : '<button class="btn sm" type="button" id="exa-add" style="align-self:flex-start">＋ メディアを足す（金額を分ける）</button>') + '</div>', 'alloc')
      + (v.category === 'cost_press' ? afRow('リリースとの紐づけ', false, '<div style="display:flex; flex-direction:column; gap:6px; width:100%">' + v.links.map((l, i) => '<div class="row" data-exl="' + i + '" style="gap:6px; flex-wrap:wrap"><select class="exl-rel" style="max-width:340px"' + (locked ? ' disabled' : '') + '><option value="">リリースを選ぶ</option>' + relOpts().map(x => '<option value="' + esc(x.id) + '"' + (x.id === l.releaseId ? ' selected' : '') + '>' + esc(relLabel(x)) + '</option>').join('') + '</select><select class="exl-ph"' + (locked ? ' disabled' : '') + '>' + PHASES().concat(l.phase && !PHASES().includes(l.phase) ? [l.phase] : []).map(ph => '<option' + (ph === l.phase ? ' selected' : '') + '>' + esc(ph) + '</option>').join('') + '</select><input class="af-num exl-amt" inputmode="numeric" placeholder="金額（税抜き）" value="' + (l.amount || '') + '"' + (locked ? ' disabled' : '') + '>' + (locked ? '' : '<button class="linkbtn" type="button" data-exldel="' + i + '">×</button>') + '</div>').join('') + (locked ? '' : '<button class="btn sm" type="button" id="exl-add" style="align-self:flex-start">＋ リリースを紐づける</button>') + '<span class="note">紐づけた金額はそのリリースの' + (isPR() ? '配信費' : isFree() ? '調査費' : '費用') + 'になります（プレスリリース進行管理に表示）。メディアの配分は紐づけから自動で作ります。紐づけていない残りは、計上月に配信したリリースで分けます。</span></div>', 'links') : '')
      + afRow('振込先', false, '<div style="display:flex; flex-wrap:wrap; gap:6px"><input data-exb="bankName" placeholder="銀行名" value="' + esc(v.bank.bankName || '') + '"' + (locked ? ' disabled' : '') + '><input data-exb="branch" placeholder="支店名" value="' + esc(v.bank.branch || '') + '"' + (locked ? ' disabled' : '') + '><input data-exb="number" class="af-num" placeholder="口座番号" value="' + esc(v.bank.number || '') + '"' + (locked ? ' disabled' : '') + '><input data-exb="holder" placeholder="口座名義" value="' + esc(v.bank.holder || '') + '"' + (locked ? ' disabled' : '') + '></div>', 'bank')
      + afRow('メモ', false, '<input data-ex="note" value="' + esc(v.note || '') + '"' + (locked ? ' disabled' : '') + '>', 'note') + '</div>'
      + '<p class="err" id="exi-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:10px; flex-wrap:wrap">'
      + (v.sentAt ? '<span class="note">経理部へ送付済みのため変更できません</span>' : v.status === 'confirmed' ? '<button class="btn" type="button" id="exi-unconf">確定を取り消す</button>' : '<button class="btn" type="button" id="exi-del">削除</button><button class="btn" type="button" id="exi-save">下書き保存</button><button class="btn primary" type="button" id="exi-conf">確定する</button>')
      + '<button class="btn" type="button" data-close>閉じる</button></div></div></div>');
    if (locked) return;
    document.querySelectorAll('[data-ex], [data-exb], [data-exa] select, [data-exa] input').forEach(el => el.onchange = () => { read(); draw(); });
    document.querySelectorAll('[data-exdel]').forEach(b => b.onclick = () => { read(); v.allocations.splice(Number(b.dataset.exdel), 1); draw(); });
    if ($('exa-add')) $('exa-add').onclick = () => { read(); v.allocations.push({ media: '', amount: 0 }); draw(); };
    document.querySelectorAll('[data-exl] select, [data-exl] input').forEach(el => el.onchange = () => { read(); draw(); });
    document.querySelectorAll('[data-exldel]').forEach(b => b.onclick = () => { read(); v.links.splice(Number(b.dataset.exldel), 1); allocFromLinks(); draw(); });
    if ($('exl-add')) $('exl-add').onclick = () => { read(); v.links.push({ releaseId: '', phase: PHASES()[0], amount: 0 }); draw(); };
    const save = async action => { read(); if (action === 'confirm' && expChecks(v).some(x => x[0] === 'ng')) { $('exi-err').textContent = '要修正の項目を直してから確定してください'; $('exi-err').hidden = false; return; }
      if (action === 'confirm' && !confirm('この内容で確定します。支出に入り、' + mLabel(v.ym) + '分の経理部宛ての請求メールに入ります。よろしいですか？')) return;
      try { await apiSend('PUT', '/expense-invoices/' + encodeURIComponent(v.id), Object.assign({}, v, { action })); closeModal(); toast(action === 'confirm' ? '確定しました' : '保存しました'); drawExpImport(); } catch (e) { $('exi-err').textContent = e.message; $('exi-err').hidden = false; } };
    $('exi-save').onclick = () => save(''); $('exi-conf').onclick = () => save('confirm');
    $('exi-del').onclick = async () => { if (!confirm('この請求書の取り込みを削除しますか？')) return; try { await apiSend('DELETE', '/expense-invoices/' + encodeURIComponent(v.id)); closeModal(); drawExpImport(); } catch (e) { $('exi-err').textContent = e.message; $('exi-err').hidden = false; } };
  };
  draw();
  if (v.status === 'confirmed' && !v.sentAt) setTimeout(() => { const b = $('exi-unconf'); if (b) b.onclick = async () => { if (!confirm('確定を取り消しますか？（支出からも外れます）')) return; try { await apiSend('PUT', '/expense-invoices/' + encodeURIComponent(v.id), Object.assign({}, v, { action: 'unconfirm' })); closeModal(); drawExpImport(); } catch (e) { alert(e.message); } }; }, 0);
}
/** 支出管理の月ごとの表：月（左が古い月・右が最新月。最大36か月） */
const expMonths = ms => { const first = [...new Set(ms)].filter(Boolean).sort()[0] || shiftMonth(CUR_MONTH, -11), out = []; for (let m = CUR_MONTH; m >= first && out.length < 36; m = shiftMonth(m, -1)) out.push(m); return out.reverse(); };
const expMonthTable = (rows, months) => { const tot = m => rows.reduce((a, [, o]) => a + (o[m] || 0), 0); return '<div class="table-wrap am-scroll ex-mtable"><table class="am-table rw-table"><thead><tr><th class="c-txt">名前</th>' + months.map(m => '<th class="num">' + mLabel(m) + '</th>').join('') + '<th class="num">合計</th></tr></thead><tbody>'
  + '<tr class="total"><td class="c-txt"><b>合計</b></td>' + months.map(m => '<td class="num' + (tot(m) ? '' : ' rwa-none') + '"><b>' + yen0(tot(m)) + '</b></td>').join('') + '<td class="num"><b>' + yen0(months.reduce((a, m) => a + tot(m), 0)) + '</b></td></tr>'
  + rows.map(([name, o]) => '<tr><td class="c-txt"><b>' + esc(name) + '</b></td>' + months.map(m => '<td class="num' + (o[m] ? '' : ' rwa-none') + '">' + (o[m] ? yen0(o[m]) : '<span class="note">—</span>') + '</td>').join('') + '<td class="num"><b>' + yen0(months.reduce((a, m) => a + (o[m] || 0), 0)) + '</b></td></tr>').join('')
  + (rows.length ? '' : '<tr><td class="c-txt" colspan="' + (months.length + 2) + '"><span class="note">まだありません</span></td></tr>') + '</tbody></table></div>'; };
const expScrollEnd = () => { document.querySelectorAll('.ex-mtable').forEach(w => { w.scrollLeft = w.scrollWidth; }); setTimeout(() => document.querySelectorAll('.ex-mtable').forEach(w => { w.scrollLeft = w.scrollWidth; }), 300); };   /* はじめは最新月（右端） */
/** 支出管理（2026-11-02 ユーザー指定）：タブで分ける。支出一覧は管理者・BEST役員・BEST社員、ほかは管理者だけ */
const EXP_TABS = [['list', '支出一覧', 'all'], ['staff', 'BEST人件費'], ['site', 'サイト制作・修正費'], ['outsource', '業務委託費'], ['press', 'プレスリリース費'], ['tool', 'ツール利用費']];
/** 支出一覧と同じ計算（BEST人件費・サイト制作・修正費・業務委託費・プレスリリース費・ツール・AI費）。DM＝メディア単位、DS＝「メディア|ディレクトリ」単位（2026-11-04〜05） */
async function expComputeAll() {
  const ids = topIds(), miss = [], DM = {}, DS = {};
    const put1 = (T, k, key, ym, v) => { ((T[k] = T[k] || {})[key] = T[k][key] || {})[ym] = (T[k][key][ym] || 0) + Number(v); };
    const add = (k, media, ym, v, sub) => { if (!v || !media || !ym || ym > CUR_MONTH) return; put1(DM, k, media, ym, v); put1(DS, k, media + '|' + (sub || ''), ym, v); };
    const fromMonthly = (k, keys) => ids.forEach(id => Object.entries(MONTHLY[id] || {}).forEach(([m, o]) => keys.forEach(kk => add(k, id, m, ((o || {}).costs || {})[kk]))));
    // BEST人件費
    try { const r = await api('/expenses/staff-costs'); (r.rows || []).forEach(x => add('cost_staff', x.media, x.ym, x.value, x.common ? '' : x.sub)); } catch (e) { miss.push('BEST人件費'); }
    // サイト制作・修正費
    await loadPastBy(); (PAST_BY || []).filter(r => ['テクノグラム', 'businessbay'].includes(nmKey(r.name)) && Number(r.subtotal) > 0).forEach(r => add('cost_site', r.media, r.ym, r.subtotal));
    let inv = []; try { inv = ((await api('/expense-invoices')).list || []).filter(v => v.status === 'confirmed'); } catch (e) { /* 権限がない人 */ }
    inv.forEach(v => { const k = v.category === 'cost_ai' ? 'cost_ai' : v.category; if (!['cost_site', 'cost_tool', 'cost_ai'].includes(k)) return; (v.allocations || []).forEach(x => add(k === 'cost_site' ? 'cost_site' : '__skip', x.media, v.ym, x.amount)); });   /* ツール・AI の請求は下の MONTHLY に入っている */
    // 業務委託費（報酬管理一覧と同じ計算をメディアに分けたもの）
    try { await new Promise((ok, ng) => { const v = viewRewardsAll({ asc: true, noRender: true, onMedia: (byM, _ms, byMS) => { Object.entries(byMS || {}).forEach(([k, o]) => Object.entries(o).forEach(([ym, val]) => add('cost_article', k.split('|')[0], ym, val, k.split('|')[1]))); ok(); } }); v.after().catch(ng); setTimeout(() => ng(new Error('timeout')), 120000); }); } catch (e) { miss.push('業務委託費'); fromMonthly('cost_article', ['cost_article', 'cost_direction']); }
    // プレスリリース費（リリースごとの調査費＋配信費。くらしのレスキューは除く）
    try { if (!PRESS_ITEMS) await loadItems(); const today = todayJst(); (PRESS_ITEMS || []).filter(x => x.media !== '__kurashi' && x.date && (x.published && x.date <= today || (x.feeLinks || []).length)).forEach(x => add('cost_press', x.media, String(x.date).slice(0, 7), (x.research ?? ((x.scr || 0) + (x.svy || 0))) + (x.dist || 0), x.sub)); } catch (e) { miss.push('プレスリリース費'); }
    // ツール・AI費（定額のサービス・AI の API・取り込んだ請求。シートの値はない）
    fromMonthly('cost_tool', ['cost_tool', 'cost_ai']);   /* AI費もツール利用費に入れる（2026-11-13 ユーザー指定：区分ごとの合計などに「AI費」の行を出さない） */
  return { DM, DS, miss };
}
/** 支出の計算値をサーバーに保存する（管理者の画面が裏で12時間ごと）。月次・サマリ・シミュレーションなどの支出はこの値を使う（2026-11-05 ユーザー指定：シートの値を使わない） */
let EXP_SYNCING = false;
async function expSyncComputed(force) {
  if (EXP_SYNCING || !isAdmin() || (me && me._preview)) return; EXP_SYNCING = true;
  try {
    if (!force) { const m = await api('/expenses/computed-meta').catch(() => ({})); if (m.at && Date.now() - Date.parse(m.at) < 12 * 3600 * 1000) return; }
    const r = await expComputeAll();
    if (r.miss.includes('業務委託費')) return;   /* 業務委託費を計算できなかったときは保存しない */
    const pick = T => Object.fromEntries(['cost_article', 'cost_site', 'cost_press'].map(k => [k, T[k] || {}]));
    await apiSend('PUT', '/expenses/computed', { media: pick(r.DM), dirs: pick(r.DS), miss: r.miss });
    MONTHLY = await api('/monthly'); DAILY_CACHE.clear();
    if (state.dash === 'media' && !['sim'].includes(state.view)) render();
  } catch (e) { console.warn('支出の計算値の保存：' + e.message); } finally { EXP_SYNCING = false; }
}
function viewExpenses(tab) {
  const tabs = EXP_TABS.filter(t => t[2] === 'all' || isAdmin() || (expStaffMe() && EXP_STAFF_TABS.includes(t[0])));
  const f = tab && tabs.some(t => t[0] === tab) ? tab : tabs[0][0];
  const bar0 = '<div class="seg ex-tabs" role="tablist" style="margin-bottom:10px; flex-wrap:wrap">' + tabs.map(([k, l]) => '<button type="button" data-extab="' + k + '" aria-pressed="' + (k === f) + '">' + esc(l) + '</button>').join('') + '</div>';
  const bar = '';   /* 左のメニューで切り替えるので、タブのボタンは出さない */
  const later = (title, txt) => ({ html: bar + '<section class="panel">' + H(title) + '<p class="empty">' + txt + '</p></section>', view: '支出情報', after: bindTabs });
  function bindTabs() { document.querySelectorAll('[data-extab]').forEach(b => b.onclick = () => { state.exTab = b.dataset.extab; render(); }); }
  if (f === 'list') return { html: '<section class="panel" id="ex-list-chart"><p class="loading">各タブの支出を集計しています（少し時間がかかります）…</p></section><section class="panel" id="ex-list-table"></section><section class="panel" id="ex-list-total"></section>', view: '支出情報', after: async () => {
    /* 支出一覧（2026-11-02 ユーザー指定）：SEO数値管理シートの支出ではなく、支出情報の各タブの計算を合計する
       BEST人件費＝社員の給与・稼働％／サイト制作・修正費＝契約管理シートのテクノグラム・businessbay＋取り込んだ請求／業務委託費＝報酬管理一覧と同じ支払額／プレスリリース費＝リリースごとの調査費・配信費／ツール・AI費＝定額のサービス・API・取り込んだ請求 */
    const CATS = Object.keys(COST_LABELS), COL = { cost_staff: '#3b6fd8', cost_article: '#f08c00', cost_site: '#12a37f', cost_press: '#e0457b', cost_tool: '#7a52d6', cost_ai: '#11a5c2' };
    const unit = state.exUnit || 'media', ids = topIds(), miss = [], C = EXP_LIST_CACHE && EXP_LIST_CACHE.until > Date.now() ? EXP_LIST_CACHE : null, D = {};   /* 計算は expComputeAll（月次などの支出にも使う。2026-11-05） */
    if (!C) { const r = await expComputeAll(); EXP_LIST_CACHE = { D: r.DM, DS: r.DS, miss: r.miss, until: Date.now() + 10 * 60 * 1000 }; }
    const E = EXP_LIST_CACHE; Object.assign(D, unit === 'dir' ? spreadDirs(E.DS) : E.D);   /* D は表示用（キャッシュの中身を消さない） */ miss.splice(0, miss.length, ...E.miss);    const val = (id, m) => Object.fromEntries(CATS.map(k => [k, ((D[k] || {})[id] || {})[m] || 0]));
    const P = [['cur', '今月'], ['prev', '先月'], ['3', '直近3か月'], ['12', '直近12か月'], ['fy', '今年度（4月〜）']], per = state.exPeriod || '12';
    const monthsOf = p => { const out = []; if (p === 'cur') return [CUR_MONTH]; if (p === 'prev') return [shiftMonth(CUR_MONTH, -1)]; if (p === 'fy') { const y = Number(CUR_MONTH.slice(0, 4)) - (Number(CUR_MONTH.slice(5)) < 4 ? 1 : 0); for (let m = y + '-04'; m <= CUR_MONTH; m = shiftMonth(m, 1)) out.push(m); return out; } for (let i = Number(p) - 1; i >= 0; i--) out.push(shiftMonth(CUR_MONTH, -i)); return out; };
    const keysAll = [...new Set(Object.values(D).flatMap(o => Object.keys(o)))];
    const allIds = unit === 'dir' ? keysAll.sort((x, y) => { const [ma, sa] = x.split('|'), [mb, sb] = y.split('|'), ia = ids.indexOf(ma), ib = ids.indexOf(mb); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (sa ? 1 : 0) - (sb ? 1 : 0) || sa.localeCompare(sb, 'ja'); }) : ids.concat(keysAll.filter(m => !ids.includes(m)));
    const lab = id => { if (unit !== 'dir') return mediaLabel(id) || id; const [m, sb] = id.split('|'); return (mediaLabel(m) || m) + (sb ? '｜' + sb : '（ディレクトリなし）'); };
    const ms = monthsOf(per), tot = {}; allIds.forEach(id => { tot[id] = {}; ms.forEach(m => { const o = val(id, m); CATS.forEach(k => { tot[id][k] = (tot[id][k] || 0) + (o[k] || 0); }); }); });
    const used = CATS.filter(k => allIds.some(id => tot[id][k])), meds = allIds.filter(id => used.some(k => tot[id][k])), sumOf = id => used.reduce((a2, k) => a2 + tot[id][k], 0);
    $('ex-list-chart').innerHTML = H('支出一覧 <small>' + (unit === 'dir' ? 'ディレクトリ' : 'メディア') + 'ごとの費用と内訳（税抜き）</small>') + '<div class="row" style="gap:8px; margin-bottom:8px"><label class="field">期間<select id="exl-per">' + P.map(([k, l]) => '<option value="' + k + '"' + (k === per ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label><button class="btn sm" type="button" id="exl-reload" title="10分以内に計算した結果を使っています">計算し直す</button><div class="seg" role="group"><button type="button" data-exunit="media" aria-pressed="' + (unit !== 'dir') + '">メディア単位</button><button type="button" data-exunit="dir" aria-pressed="' + (unit === 'dir') + '">ディレクトリ単位</button></div><span class="note">' + esc(mLabel(ms[0]) + (ms.length > 1 ? '〜' + mLabel(ms[ms.length - 1]) : '')) + '</span></div>'
      + (meds.length ? '<div style="position:relative; height:' + Math.max(260, meds.length * (unit === 'dir' ? 30 : 44) + 80) + 'px"><canvas id="exl-chart"></canvas></div>' : '<p class="empty">この期間の支出はありません。</p>')
      + (miss.length ? '<p class="note">' + esc(miss.join('・')) + 'は、この画面の権限では計算できないため' + (miss.includes('業務委託費') ? '（業務委託費はSEO数値管理シートの値）' : '入っていません') + '。</p>' : '');
    $('exl-per').onchange = e => { state.exPeriod = e.target.value; render(); };
    document.querySelectorAll('[data-exunit]').forEach(b => b.onclick = () => { state.exUnit = b.dataset.exunit; render(); });
    $('exl-reload').onclick = () => { EXP_LIST_CACHE = null; render(); };
    if (meds.length) chart('exl-chart', { type: 'bar', data: { labels: meds.map(lab), datasets: used.map(k => ({ label: COST_LABELS[k], data: meds.map(id => Math.round(tot[id][k])), backgroundColor: COL[k] || '#999' })) },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, ticks: { callback: v => '¥' + Number(v).toLocaleString('ja-JP') } }, y: { stacked: true } }, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: c => c.dataset.label + '：' + yen0(c.raw) + '（' + (sumOf(meds[c.dataIndex]) ? Math.round(c.raw / sumOf(meds[c.dataIndex]) * 1000) / 10 : 0) + '%）', footer: it => '合計：' + yen0(sumOf(meds[it[0].dataIndex])) } } } } });
    const dot = k => '<span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:' + (COL[k] || '#999') + '; margin-right:4px"></span>';
    const all = k => meds.reduce((a2, id) => a2 + tot[id][k], 0), allSum = used.reduce((a2, k) => a2 + all(k), 0);
    $('ex-list-table').innerHTML = H((unit === 'dir' ? 'ディレクトリごとの費用' : 'メディアごとの費用') + ' <small>' + esc(P.find(p => p[0] === per)[1]) + '</small>') + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">' + (unit === 'dir' ? 'メディア｜ディレクトリ' : 'メディア') + '</th>' + used.map(k => '<th class="c-num">' + dot(k) + esc(COST_LABELS[k]) + '</th>').join('') + '<th class="c-num">合計</th></tr></thead><tbody>'
      + '<tr class="total"><td class="c-txt"><b>合計</b></td>' + used.map(k => '<td class="c-num"><b>' + yen0(all(k)) + '</b></td>').join('') + '<td class="c-num"><b>' + yen0(allSum) + '</b></td></tr>'
      + meds.map(id => '<tr><td class="c-txt"><b>' + esc(lab(id)) + '</b></td>' + used.map(k => '<td class="c-num">' + (tot[id][k] ? yen0(tot[id][k]) : '<span class="note">—</span>') + '</td>').join('') + '<td class="c-num"><b>' + yen0(sumOf(id)) + '</b></td></tr>').join('')
      + (meds.length ? '' : '<tr><td class="c-txt" colspan="' + (used.length + 2) + '"><span class="note">ありません</span></td></tr>') + '</tbody></table></div>';
    const yms = [...new Set(Object.values(D).flatMap(o => Object.values(o).flatMap(x => Object.keys(x))))];
    const months = expMonths(yms.filter(m => m >= '2024-08' && m <= CUR_MONTH));
    const rowsT = CATS.map(k => [COST_LABELS[k], Object.fromEntries(months.map(m => [m, allIds.reduce((a2, id) => a2 + (val(id, m)[k] || 0), 0)]))]).filter(([, o]) => Object.values(o).some(v => v));
    $('ex-list-total').innerHTML = H('区分ごとの合計 <small>メディアで分けない・月ごと</small>') + expMonthTable(rowsT, months) + '<p class="note">支出情報の各タブ（BEST人件費・サイト制作・修正費・業務委託費・プレスリリース費・ツール利用費）の計算を、区分ごとに全メディアで合計（税抜き）。SEO数値管理シートの支出の値は使っていません。ディレクトリ単位：人件費は稼働％のディレクトリ、業務委託費は担当記事のディレクトリ、プレスリリース費はリリースのディレクトリ。メディア全体の稼働％・共通の担当・シートの請求・サイト・ツールなど、ディレクトリが決まらない分は、そのメディアのディレクトリ（その月に支出があるディレクトリ）で均等に分けています。ディレクトリのないメディアは「（ディレクトリなし）」。</p>';
    expScrollEnd();
  } };
  if (f === 'staff') return { html: '<section class="panel" id="ex-staff-media"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-staff-person"><p class="loading">読み込み中…</p></section>', view: '支出情報', after: async () => {
    const rows = (await api('/expenses/staff-costs').catch(() => ({ rows: [] }))).rows || [];
    const byMedia = {}, byPerson = {}; rows.forEach(r => { if (r.ym > CUR_MONTH) return; const mk = r.media, pk = r.staff || '（名前なし）'; (byMedia[mk] = byMedia[mk] || {})[r.ym] = (byMedia[mk][r.ym] || 0) + r.value; (byPerson[pk] = byPerson[pk] || {})[r.ym] = (byPerson[pk][r.ym] || 0) + r.value; });
    const months = expMonths(rows.map(r => r.ym));
    $('ex-staff-media').innerHTML = H('BEST人件費（メディア単位）') + expMonthTable(Object.keys(byMedia).sort((a, b) => topIds().indexOf(a) - topIds().indexOf(b)).map(k => [mediaLabel(k), byMedia[k]]), months) + '<p class="note">BEST社員管理の月の給与＋賞与÷6 を、承認された稼働％（なければ担当メディアで等分）でメディアに分けた金額（税抜き）。PM・プレスリリース・報酬サポート・業務サポートなど BEST MEDIA の共通の担当の分は、その月にあるメディア（SEO数値管理シートにデータがある最初の月から）で均等に分けています（合計は社員単位と同じ）。稼働％がまだない月は前の月の稼働％で分けています。くらしのレスキュー・開発の担当の分は入りません。</p>';
    const res = await api('/expenses/staff-costs').catch(() => ({ persons: [] })), ps = (res.persons || []);
    const RANK = ['役員', '執行役員', '部長', 'PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント', 'アシスタント候補', 'サポート'];
    const rk = p => { const a = RANK.indexOf(p.empType === '役員' || p.empType === '執行役員' ? p.empType : p.position); return a < 0 ? 99 : a; };
    const prefer = (list, order) => list.slice().sort((a, b) => { const ia = order.findIndex(n => String(a.name).startsWith(n)), ib = order.findIndex(n => String(b.name).startsWith(n)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || rk(a) - rk(b) || String(a.joinDate).localeCompare(String(b.joinDate)); });
    const cur = prefer(ps.filter(p => !p.retired), ['日比野', '星', '永澤', '菅原', '丸澤']), ret = prefer(ps.filter(p => p.retired), ['恩田', '鈴木', '峰', '犬飼']);   /* 並び順（2026-11-02 ユーザー指定） */
    const pm = expMonths(ps.map(p => String(p.joinDate || '').slice(0, 7)));
    const ptable = list => { const tot = m => list.reduce((a, p) => a + ((p.months || {})[m] || 0), 0); return '<div class="table-wrap am-scroll ex-mtable"><table class="am-table rw-table"><thead><tr><th class="c-txt">名前</th>' + pm.map(m => '<th class="num">' + mLabel(m) + '</th>').join('') + '<th class="num">合計</th></tr></thead><tbody>'
      + '<tr class="total"><td class="c-txt"><b>合計</b></td>' + pm.map(m => '<td class="num"><b>' + yen0(tot(m)) + '</b></td>').join('') + '<td class="num"><b>' + yen0(pm.reduce((a, m) => a + tot(m), 0)) + '</b></td></tr>'
      + list.map(p => { const j = String(p.joinDate || '').slice(0, 7), e = String(p.endDate || '').slice(0, 7); return '<tr><td class="c-txt"><b>' + esc(p.name) + '</b> <button class="btn sm" type="button" data-sdet="' + esc(p.name) + '">詳細</button><br><span class="note">' + esc([p.empType, p.position].filter(Boolean).join('・')) + (p.endDate ? '・' + (p.retired ? '退職 ' : '退職予定 ') + esc(String(p.endDate).replace(/-/g, '/')) : '') + '</span></td>'
        + pm.map(m => j && m < j ? '<td class="num rwa-pre"><span class="note">入社前</span></td>' : e && m > e ? '<td class="num rwa-gray"><span class="note">退職</span></td>' : '<td class="num' + ((p.months || {})[m] ? '' : ' rwa-none') + '">' + ((p.months || {})[m] ? yen0(p.months[m]) : '<span class="note">—</span>') + '</td>').join('') + '<td class="num"><b>' + yen0(pm.reduce((a, m) => a + ((p.months || {})[m] || 0), 0)) + '</b></td></tr>'; }).join('')
      + (list.length ? '' : '<tr><td class="c-txt" colspan="' + (pm.length + 2) + '"><span class="note">いません</span></td></tr>') + '</tbody></table></div>'; };
    $('ex-staff-person').innerHTML = H('BEST人件費（社員単位）') + '<h3 class="am-h">現職</h3>' + ptable(cur) + '<h3 class="am-h">退職者</h3>' + ptable(ret) + '<p class="note">社員ごとの人件費（月の給与・時給×時間＋賞与÷6）のうち、BEST MEDIA の担当の分（くらしのレスキュー・開発の担当の分を除く）。正社員・契約社員・アルバイト・役員を含みます。入社前・退職後の月はグレー。</p>';
    document.querySelectorAll('[data-sdet]').forEach(b => b.onclick = () => {
      const n = b.dataset.sdet, R = rows.filter(r => r.staff === n), lab = k => mediaLabel(k) || k, ord = (a, b2) => topIds().indexOf(a) - topIds().indexOf(b2);
      const tbl = fn => { const o = {}; R.filter(fn).forEach(r => { (o[r.media] = o[r.media] || {})[r.ym] = (o[r.media][r.ym] || 0) + r.value; }); return Object.keys(o).sort(ord).map(k => [lab(k), o[k]]); };
      const ms = expMonths(R.map(r => r.ym));
      wideModal('<h2>' + esc(n) + ' の人件費（メディアごと）</h2>' + '<h3 class="am-h">合計</h3>' + expMonthTable(tbl(() => true), ms)
        + '<h3 class="am-h">うち 担当メディアの分（稼働％）</h3>' + expMonthTable(tbl(r => !r.common), ms)
        + '<h3 class="am-h">うち 共通の担当の分（PM・プレスリリース・報酬サポート・業務サポートなど。その月にあるメディアで均等）</h3>' + expMonthTable(tbl(r => r.common), ms)
        + '<div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>');
      expScrollEnd();
    });
    addTopScrolls && addTopScrolls(); expScrollEnd();
  } };
  if (f === 'press') return { html: '<section class="panel" id="ex-imp-free"></section><section class="panel" id="ex-imp-prt"></section><section class="panel" id="ex-imp"></section><section class="panel" id="ex-press-total"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-press-research"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-press-dist"><p class="loading">読み込み中…</p></section>' /* 請求の入力をいちばん上に（2026-11-05 ユーザー指定） */, view: '支出情報', after: async () => {
    /* プレスリリース費（2026-11-02 ユーザー指定）：いちばん上に合計、次に調査費（Freeasy）、次に配信費（PR TIMES）。リリースごとの金額はプレスリリース進行管理と同じ（どのリリースのどのフェーズかは支出の「リリースとの紐づけ」） */
    ITEMS = null; await loadItems();
    const today = todayJst(), P = (PRESS_ITEMS || []).filter(x => x.media !== '__kurashi' && x.date && (x.published && x.date <= today || (x.feeLinks || []).length));
    const research = x => x.research ?? ((x.scr || 0) + (x.svy || 0)), dist = x => x.dist || 0, ymOf = x => String(x.date).slice(0, 7);
    const byMedia = fn => { const o = {}; P.forEach(x => { const v = fn(x); if (v) (o[x.media] = o[x.media] || {})[ymOf(x)] = ((o[x.media] || {})[ymOf(x)] || 0) + v; }); return Object.keys(o).sort((a, b) => topIds().indexOf(a) - topIds().indexOf(b)).map(k => [mediaLabel(k), o[k]]); };
    const months = expMonths(P.map(ymOf).filter(m => m >= '2025-04'));
    const sumRow = (label, fn) => { const o = {}; P.forEach(x => { const v = fn(x); if (v) o[ymOf(x)] = (o[ymOf(x)] || 0) + v; }); return [label, o]; };
    $('ex-press-total').innerHTML = H('プレスリリース費 合計') + expMonthTable([sumRow('調査費（Freeasy）', research), sumRow('配信費（PR TIMES）', dist)], months) + '<h3 class="am-h">メディアごと</h3>' + expMonthTable(byMedia(x => research(x) + dist(x)), months) + '<p class="note">プレスリリース進行管理の調査費＋配信費（税抜き）を、リリース日の月・メディアで集計。くらしのレスキューの分は入りません。</p>';
    const SRC = { link: '支出に紐づけ', expense: '支出（計上月で按分）', sheet: 'シート' };
    const relTable = (kind, fn) => { const L2 = P.filter(x => fn(x) > 0).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return '<div class="table-wrap am-scroll" style="max-height:420px"><table class="am-table"><thead><tr><th class="c-ctr">リリース日</th><th class="c-txt">メディア</th><th class="c-ctr">No.</th><th class="c-txt">タイトル</th><th class="c-txt">フェーズ</th><th class="c-num">金額（税抜き）</th><th class="c-txt">元</th></tr></thead><tbody>'
        + L2.map(x => { const lk = (x.feeLinks || []).filter(l => l.kind === kind), src = (x.feeSrc || {})[kind] || 'sheet';
          const ph = lk.length ? lk.map(l => esc(l.phase || '—') + ' ' + yen0(l.amount) + '<span class="note">（' + esc(l.vendor || '') + '）</span>').join('<br>') : kind === 'research' && src === 'sheet' ? [x.scr ? 'スクリーニング ' + yen0(x.scr) : '', x.svy ? 'アンケート ' + yen0(x.svy) : ''].filter(Boolean).join('<br>') : kind === 'dist' ? '配信' : '—';
          return '<tr><td class="c-ctr">' + esc(String(x.date).replace(/-/g, '/')) + '</td><td class="c-txt">' + esc(mediaLabel(x.media)) + (x.sub ? '<br><span class="note">' + esc(x.sub) + '</span>' : '') + '</td><td class="c-ctr">' + esc(x.no || '') + '</td><td class="c-txt" style="min-width:260px">' + esc(x.title || '') + '</td><td class="c-txt">' + ph + '</td><td class="c-num"><b>' + yen0(fn(x)) + '</b></td><td class="c-txt"><span class="note">' + esc(SRC[src] || src) + '</span></td></tr>'; }).join('')
        + (L2.length ? '' : '<tr><td colspan="7" class="c-txt"><span class="note">ありません</span></td></tr>') + '</tbody></table></div>'; };
    $('ex-press-research').innerHTML = H('調査費（Freeasy）') + expMonthTable(byMedia(research), months) + '<h3 class="am-h">リリースごと</h3>' + relTable('research', research) + '<p class="note">Freeasy の請求を上で入力して「リリースとの紐づけ」でリリースとフェーズ（スクリーニング調査・本調査）を選ぶと、そのリリースの調査費になります。紐づけていない月はシートのスクリーニング＋アンケート費用。</p>';
    $('ex-press-dist').innerHTML = H('配信費（PR TIMES）') + expMonthTable(byMedia(dist), months) + '<h3 class="am-h">リリースごと</h3>' + relTable('dist', dist) + '<p class="note">PR TIMES の請求を上で入力して「リリースとの紐づけ」でリリースを選ぶと、そのリリースの配信費になります。紐づけていない分は、計上月に配信したリリースの本数で分けます（支出がない月はシートの集計表の「リリース費」の月額）。</p>';
    expScrollEnd();
    await drawExpImport('cost_press', ['Freeasy'], { box: 'ex-imp-free', vendorRe: /free?a+sy|フリージー/i, title: 'Freeasy の請求の入力' });
    await drawExpImport('cost_press', ['PR TIMES'], { box: 'ex-imp-prt', vendorRe: /PR\s*TIMES/i, title: 'PR TIMES の請求の入力' });
    await drawExpImport('cost_press', [], { box: 'ex-imp', notVendorRe: /free?a+sy|フリージー|PR\s*TIMES/i, title: 'そのほかのプレスリリース費' });
  } };   /* プレスリリース費（2026-11-02 ユーザー指定） */
  if (f === 'site') return { html: '<section class="panel" id="ex-imp"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-site-media"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-site-person"><p class="loading">読み込み中…</p></section>' /* 入力をいちばん上に（2026-11-05） */, view: '支出情報', after: async () => {
    await loadPastBy();
    const SITE_VENDORS = ['テクノグラム', 'businessbay'];   /* 契約管理シートの15・16行目（2026-11-02 ユーザー指定） */
    const rows = (PAST_BY || []).filter(r => SITE_VENDORS.includes(nmKey(r.name)) && Number(r.subtotal) > 0);
    try { ((await api('/expense-invoices')).list || []).filter(v => v.status === 'confirmed' && v.category === 'cost_site').forEach(v => (v.allocations || []).forEach(x => { if (x.media && x.amount) rows.push({ name: v.vendor || '（請求元なし）', media: x.media, ym: v.ym, subtotal: x.amount }); })); } catch (e) { /* 権限がない人 */ }   /* 取り込んで確定した請求も（2026-11-02） */
    const byMedia = {}, byV = {}; rows.forEach(r => { const v = Number(r.subtotal) || 0, mk = mediaLabel(r.media || '') || '（メディア不明）'; (byMedia[mk] = byMedia[mk] || {})[r.ym] = (byMedia[mk][r.ym] || 0) + v; (byV[r.name] = byV[r.name] || {})[r.ym] = (byV[r.name][r.ym] || 0) + v; });
    const months = expMonths(rows.map(r => r.ym));
    $('ex-site-media').innerHTML = H('サイト制作・修正費（メディア単位）', ['契約管理シート']) + expMonthTable(Object.entries(byMedia), months) + '<p class="note">契約管理シートのテクノグラム・businessbay の請求（税抜きの小計）を、請求のメディアごとに月で並べています。</p>';
    $('ex-site-person').innerHTML = H('サイト制作・修正費（支払い単位）', ['契約管理シート']) + expMonthTable(Object.entries(byV), months) + '<p class="note">テクノグラム・businessbay の請求（税抜きの小計）を、支払い先ごとに月で並べています。</p>';
    expScrollEnd(); drawExpImport('cost_site');
  } };
  if (f === 'tool' || f === 'ai') return { html: '<section class="panel" id="ex-imp"></section><section class="panel" id="ex-tool-media"><p class="loading">読み込み中…</p></section><section class="panel" id="ex-tool-groups"><p class="loading">読み込み中…</p></section>' /* 入力をいちばん上に（2026-11-05） */, view: '支出情報', after: async () => {
    /* ツール利用費（2026-11-02 ユーザー指定）：いちばん上に定額のサービスの保存・追加、次にメディア単位、次に小項目ごとの表（サーバー・ドメイン／画像ツール／SEOツール／AIツール） */
    const ids = topIds(), months = expMonths(ids.flatMap(id => Object.keys(MONTHLY[id] || {})).filter(m => m >= '2026-10'));
    const cst = (id, m) => { const c = ((MONTHLY[id] || {})[m] || {}).costs || {}; return Number(c.cost_tool || 0) + Number(c.cost_ai || 0); };
    $('ex-tool-media').innerHTML = H('ツール利用費（メディア単位）') + expMonthTable(ids.map(id => [mediaLabel(id), Object.fromEntries(months.map(m => [m, cst(id, m)]))]).filter(([, o]) => Object.values(o).some(v => v)), months) + '<p class="note">定額のサービス・AI の API の費用・取り込んだ請求（ツール・AI費）を、Ahrefs の順位追跡のKW数の割合でメディアに分けた金額（税抜き）。</p>';
    let d = { items: [], groups: {} }, mr = []; try { d = await api('/subscriptions'); mr = (await api('/subscriptions/monthly')).rows || []; } catch (e) { $('ex-tool-groups').remove(); await drawExpImport('cost_tool', [], { title: 'ツール・AIの単発の請求の追加' }); return; }   /* 入力欄は出す（2026-11-05） */
    const EXPECT = { server: [['エックスサーバー', /エックスサーバー|xserver/i]], image: [['AC（写真AC・イラストAC など）', /(^|[^a-z])AC([^a-z]|$)|写真AC|イラストAC|ACワークス/i], ['Canva', /canva/i]], seo: [['Ubersuggest', /ubersuggest/i], ['Ahrefs', /ahrefs/i]], ai: [['ChatGPT', /chatgpt|openai/i], ['Claude Code', /claude/i]] };
    const API = [['openai_api', 'OpenAI API（使った分）'], ['anthropic_api', 'Claude API（使った分）']];
    const val = sub => Object.fromEntries(mr.filter(r => r.sub === sub).map(r => [r.ym, r.value]));
    const ms2 = expMonths(mr.map(r => r.ym).concat(d.items.map(x => x.startYm)).filter(m => m && m <= CUR_MONTH));
    const html = Object.entries(d.groups).map(([g, label]) => {
      const its = d.items.filter(x => x.group === g && x.category !== 'cost_site'), rows = its.map(x => [x.name + (x.currency === 'USD' ? '（$' + x.amount + '/月）' : ''), val(x.id)]);
      if (g === 'ai') API.forEach(([k, n]) => { if (mr.some(r => r.sub === k)) rows.push([n, val(k)]); });
      const miss = (EXPECT[g] || []).filter(([, re]) => !its.some(x => re.test(x.name))).map(([n]) => n);
      if (g === 'other' && !rows.length) return '';
      return '<h3 class="am-h">' + esc(label) + '</h3>' + expMonthTable(rows, ms2) + (miss.length ? '<p class="note">未登録：' + miss.map(esc).join('・') + '（管理 →「支出管理」の「＋ サービスを追加」で小項目「' + esc(label) + '」を選んで登録してください）</p>' : '') + (g === 'server' ? '<p class="note">エックスサーバーとの連動（請求額の自動取得）は、使える方法を確認してから作ります。今は月額を登録してください。</p>' : '') + (g === 'seo' ? '<p class="note">Ahrefs はくらしのレスキューと50%ずつ使っているので、BEST MEDIA の支出は登録した金額の半分です（2026-11-05〜）。</p>' : '');
    }).join('');
    $('ex-tool-groups').innerHTML = H('ツール利用費（小項目ごと）') + html;
    expScrollEnd();
    await drawExpImport('cost_tool', [], { title: 'ツール・AIの単発の請求の追加' });
  } };   /* ツール利用費（AI利用費をまとめた）（2026-11-02 ユーザー指定） */
  // 業務委託費：報酬管理一覧と同じ表（左が古い月・右が最新月。はじめは最新月）＋契約管理シートとの照合（以前の画面）
  const v = viewRewardsAll({ asc: true, onMedia: (byM, months, _byMS, byMC) => {
    const ids = topIds(), rowsM = Object.keys(byM).sort((a, b) => (ids.indexOf(a) < 0 ? 99 : ids.indexOf(a)) - (ids.indexOf(b) < 0 ? 99 : ids.indexOf(b))).map(k => [mediaLabel(k) || k, byM[k]]);
    const keysM = Object.keys(byM).sort((a, b) => (ids.indexOf(a) < 0 ? 99 : ids.indexOf(a)) - (ids.indexOf(b) < 0 ? 99 : ids.indexOf(b)));
    $('ex-out-media').innerHTML = H('業務委託費（メディア単位）') + expMonthTable(rowsM, months) + '<div class="row" style="gap:6px; flex-wrap:wrap; margin:8px 0"><span class="note">メディアごとの内訳（契約者ごと）：</span>' + keysM.map(k => '<button class="btn sm" type="button" data-exmd="' + esc(k) + '">' + esc(mediaLabel(k) || k) + '</button>').join('') + '</div>' + '<p class="note">下の「業務委託費（契約者単位）」の支払額（税抜き）を、メディアごとに分けたもの（合計は契約者単位と同じ）。分け方：スプレッドシートの請求を使った月はその請求のメディア、進行管理で計算した月は担当記事のメディア、どちらもなければ契約の担当メディアで等分。</p>';
    document.querySelectorAll('[data-exmd]').forEach(b => b.onclick = () => { const k = b.dataset.exmd, P = byMC[k] || {}, sum = o => Object.values(o).reduce((a2, x) => a2 + x, 0);
      const rows = Object.entries(P).sort((x, y) => sum(y[1]) - sum(x[1]));
      const sheet = Object.fromEntries(months.map(m => { const c = ((MONTHLY[k] || {})[m] || {}).costs || {}; return [m, Number(c.cost_article || 0) + Number(c.cost_direction || 0)]; }));   /* 参考：SEO数値管理シートの記事制作費＋ディレクション費（11月分からは確認済みの請求） */
      wideModal('<h2>' + esc(mediaLabel(k) || k) + ' の業務委託費（契約者ごと）</h2>' + expMonthTable(rows, months) + '<h3 class="am-h">参考：SEO数値管理シートの記事制作費＋ディレクション費</h3>' + expMonthTable([['シートの値', sheet]], months) + '<p class="note">上の表は報酬管理一覧の支払額を、そのメディアの分だけ人ごとに並べたもの（ほかのメディアの分は入りません）。シートの値と大きく違う月は、報酬管理一覧のその人の月で記事・請求を確認してください。</p><div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>');
      expScrollEnd(); });
  } });
  return { html: '<section class="panel" id="ex-out-media"><p class="loading">読み込み中…</p></section>' + v.html, view: '支出情報', after: async () => {
    await v.after(); expScrollEnd();
  } };
}
function viewExpensesLegacy() {
  const f = state.exFilter = state.exFilter || { media: '', ym: '' };
  return { html: '<section class="panel" id="ex-body"><p class="loading">読み込み中…</p></section>', view: '支出情報', after: async () => {
    f.media = adminMedia() === ALL ? '' : adminMedia();   // メディアは右上で選ぶ（メディア累計あり）
    const d = await api('/expenses/invoices');
    if (!d.invoices.length) { $('ex-body').innerHTML = H('支出管理', ['契約管理シート']) + '<p class="empty">まだ請求を取り込んでいません。契約管理の「シートから取り込み」を実行すると、2024年8月以降の請求が入ります。</p>'; return; }
    const yms = [...new Set(d.invoices.map(r => r.ym))].sort().reverse();
    const medias = [...new Set(d.invoices.map(r => r.media).filter(Boolean))];
    const inv = d.invoices.filter(r => (!f.media || r.media === f.media) && (!f.ym || r.ym === f.ym));
    // 照合：メディア×月で、請求の小計の合計 と シートの（ディレクション＋記事制作＋プレスリリース）
    const key = r => r.media + '|' + r.ym, sum = {}, sh = {};
    d.invoices.forEach(r => { const k = key(r); sum[k] = (sum[k] || 0) + (r.subtotal || 0); });
    d.sheet.forEach(r => { if (r.item === 'cost_site') return; const k = key(r); sh[k] = (sh[k] || 0) + Number(r.value || 0); });
    const keys = [...new Set(Object.keys(sum).concat(Object.keys(sh)))].filter(k => { const [m, ym] = k.split('|'); return m && ym >= '2024-08' && (!f.media || m === f.media) && (!f.ym || ym === f.ym); }).sort((a, b) => b.split('|')[1].localeCompare(a.split('|')[1]) || a.localeCompare(b));
    const sel = (id, label, opts, v) => '<label class="field">' + label + '<select id="' + id + '">' + opts.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === (v || '') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    $('ex-body').innerHTML = H('支出管理 <small>' + esc(f.media ? mediaLabel(f.media) : 'メディア累計') + '・契約管理シートの請求（2024年8月〜）</small>', ['契約管理シート', '支出'])
      + '<div class="row" style="margin-bottom:8px">' + sel('ex-ym', '月', [['', 'すべて']].concat(yms.map(m => [m, mLabel(m)])), f.ym) + '</div>'
      + '<p class="note">支出の金額は、これまでどおり SEO数値管理シートの値を使います（二重にはなりません）。この画面は、契約管理シートの請求（人ごと・税抜きの小計）との照合と、内訳の確認用です。</p>'
      + '<h3 class="am-h">照合 <span class="note">メディア×月：請求の小計の合計 と SEO数値管理シート（ディレクション費＋業務委託費＋プレスリリース費）</span></h3>'
      + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">月</th><th class="c-txt">メディア</th><th class="num">請求（小計）</th><th class="num">SEO数値管理シート</th><th class="num">差</th></tr></thead><tbody>'
      + keys.map(k => { const [m, ym] = k.split('|'), a = sum[k] || 0, b = sh[k] || 0, diff = a - b; return '<tr><td class="c-txt">' + mLabel(ym) + '</td><td class="c-txt">' + esc(mediaLabel(m)) + '</td><td class="num">' + yen0(a) + '</td><td class="num">' + yen0(b) + '</td><td class="num">' + (Math.abs(diff) < 1 ? '<span class="pill ok">一致</span>' : '<span class="' + (diff > 0 ? 'down' : 'up') + '">' + (diff > 0 ? '+' : '−') + yen0(Math.abs(diff)) + '</span>') + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<h3 class="am-h" style="margin-top:14px">人ごとの請求 <span class="note">' + inv.length + '件</span></h3>'
      + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">月</th><th class="c-txt">メディア</th><th class="c-txt">氏名</th><th class="num">小計（税抜き）</th><th class="num">消費税</th><th class="num">源泉徴収</th><th class="num">請求金額</th><th class="c-txt">内訳</th><th class="c-txt">担当</th></tr></thead><tbody>'
      + inv.map(r => '<tr><td class="c-txt">' + mLabel(r.ym) + '</td><td class="c-txt">' + esc(mediaLabel(r.media || '')) + '</td><td class="c-txt"><b>' + esc(r.name) + '</b></td><td class="num">' + yen0(r.subtotal) + '</td><td class="num">' + yen0(r.tax) + '</td><td class="num">' + yen0(r.withholding) + '</td><td class="num">' + yen0(r.billed) + '</td><td class="c-txt" style="font-size:12px">' + r.lines.map(l => esc(l.label) + ' ' + yen0(l.amount)).join('<br>') + '</td><td class="c-txt">' + esc(r.by || '') + '</td></tr>').join('')
      + '</tbody></table></div>';
    $('ex-ym').onchange = ev => { f.ym = ev.target.value; render(); };
  } };
}

// ================= BEST社員管理（2026-10-27 ユーザー指定で作り直し） =================
// 社員（正社員・契約社員・アルバイト）の登録、月ごとの担当（メディア×ポジション）、半期の賞与・昇給額・評価、経歴書類（PDF）。
// 生年月日・給与・賞与・昇給額・評価・経歴書類を見られるのは、管理者だけ（2026-10-27 ユーザー指定。本人も見られない）
let MY_STAFF = null;   // 自分が社員として登録されているか（業務委託のアシスタント兼ライター以上は contractor: true。記事目標だけ）
let STAFF_META = null;
async function loadStaffMeta() { if (!STAFF_META) STAFF_META = await api('/staff-eval'); return STAFF_META; }
const halfLabel = start => { const h = halfOf(start); return h.label + '（' + h.range + '）'; };
const halfStarts = () => { const cur = halfOf(CUR_MONTH).start; return [shiftMonth(cur, 6), cur, shiftMonth(cur, -6), shiftMonth(cur, -12), shiftMonth(cur, -18)]; };
const STAFF_STATE_PILL = { 現職: 'ok', 退職予定: 'ending', 退職済み: 'off', 昇格予定: 'wait' };
const WORK_STATUS = { none: ['未入力', 'off'], draft: ['未申請', 'off'], submitted: ['承認待ち', 'wait'], approved: ['承認済み', 'ok'], rejected: ['却下', 'ng'] };
const posFor = empType => (STAFF_META ? STAFF_META.positions : []).filter(p => (p !== 'アシスタント候補' || empType === '契約社員') && (p !== 'サポート' || empType === 'アルバイト'));
// 役員に昇格した人は、退職日の翌月から役員（入社日は最初の入社日のまま）（2026-10-27 ユーザー指定）
const staffPromoted = s => (s.retireType === '昇格' || s.retireType === '役員昇格') && !!s.retireDate;
/** 月単位の変更（changes）と半期の値（halfTypes など）のうち、その月までで新しいほう（2026-10-27 ユーザー指定） */
const staffLatest = (s, ym, field, map) => { let c = null; (s.changes || []).forEach(x => { const v = x[field]; if (v != null && v !== '' && x.from <= ym && (!c || x.from > c.from)) c = { from: x.from, value: v }; }); const hs = halfOf(ym).start; let k = null; Object.entries((s.changes || []).length ? {} : map || {}).forEach(([h, v]) => { if (v != null && v !== '' && h <= hs && (!k || h > k)) k = h; }); return c && (!k || c.from >= k) ? c : k ? { from: k, value: map[k] } : null; };
const staffEmpAt = (s, ym) => { if (staffPromoted(s) && s.promoDate && ym >= s.promoDate.slice(0, 7)) return s.promoTo || '役員'; const c = staffLatest(s, ym, 'empType', s.halfTypes); return c ? c.value : s.empType; };
const staffPosAt = (s, ym) => { const c = staffLatest(s, ym, 'position', null); return c ? c.value : ''; };
const HOURS_TYPES_UI = ['アルバイト', '契約社員', '正社員'];   // 月の稼働時間を入れられる区分（2026-10-27 ユーザー指定）
const NO_EVAL_TYPES = ['アルバイト', '役員', '執行役員'];
const payLabelOf = t => t === 'アルバイト' ? '時給' : t === '執行役員' ? '年俸' : t === '役員' ? '月額報酬' : '月給';
/** 報酬の表示：区分ごとに（月給／時給／月額報酬／年俸）（2026-10-27 ユーザー指定） */
/** 来月以降に予定されている変更（いちばん近いもの） */
const nextChange = (s, field) => (s.changes || []).filter(c => c.from > CUR_MONTH && c[field] != null && c[field] !== '').sort((a, b) => a.from.localeCompare(b.from))[0] || null;
/** 報酬の列：入社時 → 今 → 予定 を縦に並べる（2026-10-27 ユーザー指定） */
function payText(s) {
  const it = s.empType, initV = it === 'アルバイト' ? s.initHourly : it === '執行役員' ? s.initAnnual : s.initMonthly;
  const nx = nextChange(s, 'pay');
  const cell = (lab, kind, amount, extra, strong) => '<span class="note">' + lab + '</span><span>' + kind + '</span><span class="num" style="text-align:right' + (strong ? '; font-weight:700' : '') + '">' + amount + '</span><span class="note">' + (extra || '') + '</span>';
  const cur = s.payNow && s.payNow.label ? s.payNow : null;
  return '<div style="display:grid; grid-template-columns:3.2em 2.6em 7.5em auto; gap:2px 6px; align-items:baseline; white-space:nowrap">'
    + cell('入社時', payLabelOf(it), yen0(initV))
    + cell('現在', cur ? cur.label : payLabelOf(staffEmpAt(s, CUR_MONTH)), cur ? yen0(cur.value) : '—', '', true)
    + (s.payNext ? cell('予定', s.payNext.label, yen0(s.payNext.value), mLabel(s.payNext.from) + '〜') : nx ? cell('予定', payLabelOf(staffEmpAt(s, nx.from)), yen0(nx.pay), mLabel(nx.from) + '〜') : '') + '</div>';
}
function payNowText(s) {
  if (s.payNow && s.payNow.label) return s.payNow.label + ' ' + yen0(s.payNow.value) + (s.payNow.label === '時給' && s.initHours ? '<br><span class="note">月' + s.initHours + '時間の目安</span>' : '');   // 昇給額込み（サーバーで計算）
  return payNowOld(s);
}
function payNowOld(s) {
  // 今の区分の報酬（月単位・半期で変えたものがあればそれ。なければ登録時）（2026-10-27）
  const t = staffEmpAt(s, CUR_MONTH), c = staffLatest(s, CUR_MONTH, 'pay', s.halfPays);
  if (staffPromoted(s) && t === (s.promoTo || '役員') && t !== s.empType && s.promoPay != null && !(c && c.from >= s.promoDate.slice(0, 7))) return (t === '執行役員' ? '年俸 ' : '月額 ') + yen0(s.promoPay);
  const v = c ? c.value : t === 'アルバイト' ? s.initHourly : t === '執行役員' ? s.initAnnual : s.initMonthly;
  return payLabelOf(t) + ' ' + yen0(v) + (t === 'アルバイト' && s.initHours && !c ? '<br><span class="note">月' + s.initHours + '時間の目安</span>' : '');
}
/** 区分ごとの報酬の入力欄 */
function payFieldsHtml(empType, v) {
  const f = (id, label, val) => '<label>' + label + '<input id="' + id + '" inputmode="numeric" value="' + (val ?? '') + '"></label>';
  if (empType === 'アルバイト') return f('sf-hourly', '時給（円）', v.initHourly) + f('sf-hours', '月の勤務時間の目安（時間。人件費の計算に使う）', v.initHours);
  if (empType === '執行役員') return f('sf-annual', '年俸（円）', v.initAnnual);
  if (empType === '役員') return f('sf-monthly', '月額報酬（円）', v.initMonthly);
  return f('sf-annual', '想定年収（円）', v.initAnnual) + f('sf-monthly', '月の給与（円）', v.initMonthly);
}
const staffEnd = s => staffPromoted(s) ? s.execRetireDate : s.retireDate;
/** 勤続（入社日から、退職日か今日まで） */
const tenureOf = s => { if (!s.joinDate) return '—'; const end = staffEnd(s) && staffEnd(s) < todayJst() ? staffEnd(s) : todayJst(); let m = (Number(end.slice(0, 4)) - Number(s.joinDate.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(s.joinDate.slice(5, 7)); if (end.slice(8) < s.joinDate.slice(8)) m--; m = Math.max(0, m); return (m >= 12 ? Math.floor(m / 12) + '年' : '') + (m % 12) + 'か月'; };
// 一覧の「区分」：今の区分（最新）と今のポジションを太字で。その下に、いつからいつに昇格・降格したかの経緯（2026-10-27 ユーザー指定）
const EMP_RANK = { アルバイト: 1, 契約社員: 2, 正社員: 3, 執行役員: 4, 役員: 5 };
function empHistory(s) {
  const ev = [{ ym: (s.joinDate || '').slice(0, 7), t: s.empType }];
  if (!(s.changes || []).length) Object.entries(s.halfTypes || {}).forEach(([h, t]) => { if (t) ev.push({ ym: h, t }); });
  (s.changes || []).forEach(c => { if (c.empType) ev.push({ ym: c.from, t: c.empType }); });
  if (staffPromoted(s) && s.promoDate) ev.push({ ym: s.promoDate.slice(0, 7), t: s.promoTo || '役員' });
  ev.sort((a, b) => a.ym.localeCompare(b.ym));
  const out = []; ev.forEach(x => { if (!out.length || out[out.length - 1].t !== x.t) out.push(x); });
  return out;
}
const empTypeText = s => {
  const ym = staffEnd(s) && staffEnd(s) < todayJst() ? staffEnd(s).slice(0, 7) : CUR_MONTH;   // 退職済みの人は最後の月
  const now = staffEmpAt(s, ym), pos = staffPosAt(s, ym) || [...new Set(((s.assign || {})[ym] || []).map(a => a.position))].join('・');
  const h = empHistory(s);
  const hist = h.length > 1 ? '<br><span class="note">' + h.map((x, k) => (k ? (EMP_RANK[x.t] > EMP_RANK[h[k - 1].t] ? ' → <b>昇格</b> ' : EMP_RANK[x.t] < EMP_RANK[h[k - 1].t] ? ' → <b>降格</b> ' : ' → ') : '') + esc(x.t) + '（' + mLabel(x.ym) + '〜' + (h[k + 1] ? mLabel(shiftMonth(h[k + 1].ym, -1)) : '') + '）').join('') + '</span>' : '';
  const nt = nextChange(s, 'empType'), np = nextChange(s, 'position');
  const next = [nt ? esc(nt.empType) + '（' + mLabel(nt.from) + '〜）' : '', np ? esc(np.position) + '（' + mLabel(np.from) + '〜）' : ''].filter(Boolean).join('・');
  return '<b>' + esc(now) + '</b>' + (pos ? '・' + esc(pos) : '') + hist + (next ? '<br><span class="note">予定：' + next + '</span>' : '');
};
// 担当の大枠：BEST MEDIA（今のメディア）と Eparkくらしのレスキュー（まだダッシュボードなし。担当・稼働の%・目標だけ）（2026-10-27 ユーザー指定）
const KURASHI = '__kurashi', KURASHI_LABEL = 'Eparkくらしのレスキュー';
const PRESS = '__press', PRESS_LABEL = 'プレスリリース';   // 担当の選択肢（2026-10-27 ユーザー指定。管理表はこのあと作る）
const BM_REWARD = '__bm_reward', KURASHI_REWARD = '__kurashi_reward';   // 報酬サポート（2026-10-27 ユーザー指定）
const DEV_AI_SELF = '__dev_ai_self', DEV_AI_CORP = '__dev_ai_corp';   // 開発（2026-10-27 ユーザー指定）
const BM_OPS = '__bm_ops', KURASHI_OPS = '__kurashi_ops';   // 業務サポート（2026-10-27 ユーザー指定）
const BM_PM = '__bm_pm', KURASHI_PM = '__kurashi_pm';   // プロジェクトマネジメント（2026-10-27 ユーザー指定）
const BM_SUPPORT = '__bm_support', KURASHI_DIR = '__kurashi_dir';   // 監修・記事サポート／ディレクション・採用サポート（2026-10-27 ユーザー指定）
const NON_MEDIA_UNITS = [KURASHI, PRESS, BM_PM, KURASHI_PM, BM_REWARD, KURASHI_REWARD, BM_OPS, KURASHI_OPS, DEV_AI_SELF, DEV_AI_CORP, BM_SUPPORT, KURASHI_DIR];
const UNIT_LABELS = { [KURASHI]: KURASHI_LABEL + '：コンテンツ制作',   /* 2026-10-27 ユーザー指定で名前を変更 */ [PRESS]: PRESS_LABEL, [BM_REWARD]: 'BEST MEDIA：報酬サポート', [KURASHI_REWARD]: KURASHI_LABEL + '：報酬サポート', [BM_OPS]: 'BEST MEDIA：業務サポート', [BM_PM]: 'BEST MEDIA：プロジェクトマネジメント', [KURASHI_PM]: KURASHI_LABEL + '：プロジェクトマネジメント', [KURASHI_OPS]: KURASHI_LABEL + '：業務サポート', [BM_SUPPORT]: 'BEST MEDIA：監修・記事サポート', [KURASHI_DIR]: KURASHI_LABEL + '：ディレクション・採用サポート', [DEV_AI_SELF]: '開発：AI自社開発', [DEV_AI_CORP]: '開発：AIウエルスパーク開発'   /* 2026-10-27 ユーザー指定で「AI企業開発」から名前を変更 */ };
const unitLabel = m => UNIT_LABELS[m] || mediaLabel(m);
const assignText = rows => (rows || []).map(a => unitLabel(a.media) + (a.sub ? '／' + a.sub : '') + '：' + a.position).join('、');
/** 担当の選択肢：記事目標設定の行と同じ単位（ディレクトリがあるメディアはディレクトリごと。メディア全体も選べる）（2026-10-27 ユーザー指定） */
function assignChoices() {
  const tree = targetTree(), out = [];
  out.push({ media: BM_PM, sub: '', label: UNIT_LABELS[BM_PM], group: 'BEST MEDIA' });   // いちばん上
  topMedia().forEach(m => {
    const subs = tree.filter(r => r.editable && r.id.startsWith(m.media + '|')).map(r => r.id.slice(m.media.length + 1));
    out.push({ media: m.media, sub: '', label: m.name + (subs.length ? '（全体）' : ''), group: 'BEST MEDIA' });
    subs.forEach(x => out.push({ media: m.media, sub: x, label: m.name + '／' + x, group: 'BEST MEDIA' }));
  });
  out.push({ media: BM_REWARD, sub: '', label: UNIT_LABELS[BM_REWARD], group: 'BEST MEDIA' });
  out.push({ media: BM_OPS, sub: '', label: UNIT_LABELS[BM_OPS], group: 'BEST MEDIA' });
  out.push({ media: PRESS, sub: '', label: PRESS_LABEL, group: PRESS_LABEL });
  out.push({ media: KURASHI_PM, sub: '', label: UNIT_LABELS[KURASHI_PM], group: KURASHI_LABEL });   // いちばん上
  out.push({ media: KURASHI_DIR, sub: '', label: UNIT_LABELS[KURASHI_DIR], group: KURASHI_LABEL });   // 関係図では PM の横
  out.push({ media: KURASHI, sub: '', label: UNIT_LABELS[KURASHI], group: KURASHI_LABEL });
  out.push({ media: KURASHI_REWARD, sub: '', label: UNIT_LABELS[KURASHI_REWARD], group: KURASHI_LABEL });
  out.push({ media: KURASHI_OPS, sub: '', label: UNIT_LABELS[KURASHI_OPS], group: KURASHI_LABEL });
  out.push({ media: DEV_AI_SELF, sub: '', label: UNIT_LABELS[DEV_AI_SELF], group: '開発' });
  out.push({ media: DEV_AI_CORP, sub: '', label: UNIT_LABELS[DEV_AI_CORP], group: '開発' });
  return out;
}
const dateJp = s => s ? s.replace(/-/g, '/') : '—';
const ageOf = b => { if (!b) return ''; const t = todayJst(); let a = Number(t.slice(0, 4)) - Number(b.slice(0, 4)); if (t.slice(5) < b.slice(5)) a--; return a + '歳'; };
/* 操作マニュアル（2026-11-05 ユーザー指定）：画面の右上のボタン → GET /api/manuals/:key（Markdown）を表示。毎月初にタスクスケジューラーの claude -p が機能の変更を見て更新する */
const manualBtn = key => '<button class="btn sm manual-btn" type="button" data-manual="' + key + '" title="この画面の操作マニュアル">📖 マニュアル</button> ';
function mdToHtml(md) {
  const inl = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const L = String(md || '').replace(/\r/g, '').split('\n'), out = []; let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push('<h' + n + ' class="man-h">' + inl(m[2]) + '</h' + n + '>'); i++; continue; }
    if (/^\|/.test(l)) { const rows = []; while (i < L.length && /^\|/.test(L[i])) rows.push(L[i++]); const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim()); const body = rows.filter(r => !/^\|[\s:|-]+\|?\s*$/.test(r));
      out.push('<div class="table-wrap"><table class="am-table"><thead><tr>' + cells(body[0]).map(c => '<th class="c-txt">' + inl(c) + '</th>').join('') + '</tr></thead><tbody>' + body.slice(1).map(r => '<tr>' + cells(r).map(c => '<td class="c-txt">' + inl(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'); continue; }
    if (/^\s*[-*]\s+/.test(l)) { const it = []; while (i < L.length && /^\s*[-*]\s+/.test(L[i])) it.push(L[i++].replace(/^\s*[-*]\s+/, '')); out.push('<ul>' + it.map(x => '<li>' + inl(x) + '</li>').join('') + '</ul>'); continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { const it = []; while (i < L.length && /^\s*\d+[.)]\s+/.test(L[i])) it.push(L[i++].replace(/^\s*\d+[.)]\s+/, '')); out.push('<ol>' + it.map(x => '<li>' + inl(x) + '</li>').join('') + '</ol>'); continue; }
    if (/^>\s?/.test(l)) { const it = []; while (i < L.length && /^>\s?/.test(L[i])) it.push(L[i++].replace(/^>\s?/, '')); out.push('<blockquote class="man-note">' + it.map(inl).join('<br>') + '</blockquote>'); continue; }
    const p = []; while (i < L.length && L[i].trim() && !/^(#|\||\s*[-*]\s|\s*\d+[.)]\s|>)/.test(L[i])) p.push(L[i++]); out.push('<p>' + p.map(inl).join('<br>') + '</p>');
  }
  return out.join('');
}
async function openManual(key) {
  wideModal('<div class="manual"><p class="loading">読み込み中…</p></div>');
  try { const d = await api('/manuals/' + encodeURIComponent(key)); const box = document.querySelector('#modal .manual'); if (box) box.innerHTML = mdToHtml(d.md) + '<p class="note" style="margin-top:14px">最終更新：' + esc(String(d.updatedAt || '').slice(0, 10) || '—') + '</p><div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>'; }
  catch (e) { const box = document.querySelector('#modal .manual'); if (box) box.innerHTML = '<p class="err">マニュアルを読み込めませんでした：' + esc(e.message) + '</p><div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>閉じる</button></div>'; }
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-manual]'); if (b) { e.preventDefault(); openManual(b.dataset.manual); } });
function wideModal(inner) { openModal(inner); const m = document.querySelector('#modal .modal'); if (m) m.classList.add('wide'); }

/** 経歴書類（PDF）を別ウィンドウで表示（管理者だけ。URLで共有はできない） */
async function openStaffDoc(id, n, title) {
  const w = window.open('', '_blank');
  if (!w) return alert('ポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください');
  w.document.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>' + esc(title) + '</title><meta name="robots" content="noindex"></head><body style="margin:12px;font-family:sans-serif"><p style="color:#b00;font-weight:bold;font-size:12px">社外秘：管理者以外への共有は禁止</p><h1 style="font-size:17px">' + esc(title) + '</h1><div id="v">読み込み中…</div></body></html>');
  w.document.close();
  try {
    const tok = await fbAuth.currentUser.getIdToken();
    const res = await fetch('/api/staff/' + encodeURIComponent(id) + '/docs/' + n, { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
    if (!res.ok) throw new Error('表示できません（' + res.status + '）');
    w.document.getElementById('v').innerHTML = '<iframe src="' + URL.createObjectURL(await res.blob()) + '" style="width:100%;height:88vh;border:1px solid #bbb"></iframe>';
  } catch (e) { w.document.getElementById('v').textContent = e.message; }
}
async function uploadStaffDoc(id, label, file) {
  const tok = await fbAuth.currentUser.getIdToken();
  const res = await fetch('/api/staff/' + encodeURIComponent(id) + '/docs?label=' + encodeURIComponent(label) + '&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/pdf' }, body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '保存できませんでした');
}
const docsHtml = s => (s.docs || []).length ? s.docs.map((f, n) => '<button class="btn sm" type="button" data-sdoc="' + n + '">' + esc(f.label) + '</button>').join(' ') : '<span class="note">なし</span>';

/** BEST社員管理の一覧だけを描き直す（保存のあと、区分・報酬・担当を新しい値に） */
async function refreshStaffList() { const v = RENDER.staff(); const box = document.querySelector('#st-body'); if (!box) return; const tmp = document.createElement('div'); tmp.innerHTML = v.html; box.replaceWith(tmp.firstElementChild); await v.after(); }
/** 管理 → BEST社員管理 */
function viewStaff() {
  return { html: '<section class="panel" id="st-body"><p class="loading">読み込み中…</p></section>', view: 'BEST社員管理', after: async () => {
    await loadStaffMeta();
    const d = await api('/staff'), am = adminMedia(), f = state.stFilter = state.stFilter || { status: 'now' };
    let list = d.staff;
    if (am !== ALL) list = list.filter(s => s.current.some(a => a.media === am) || Object.values(s.assign || {}).some(rows => rows.some(a => a.media === am)));
    if (f.status === 'now') list = list.filter(s => s.status !== '退職済み'); else if (f.status === 'gone') list = list.filter(s => s.status === '退職済み');
    $('st-body').innerHTML = H('BEST社員管理 <small>' + esc(am === ALL ? 'メディア累計' : mediaLabel(am)) + '・' + list.length + '人</small>', ['BEST社員管理'])
      + '<div class="row" style="flex-wrap:wrap; gap:8px; margin-bottom:8px; align-items:flex-end"><label class="field">状態<select id="st-f">' + [['now', '現職・退職予定'], ['gone', '退職済み'], ['all', 'すべて']].map(([k, l]) => '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label><button class="btn primary" type="button" id="st-add">＋ 社員を登録</button></div>'
      + (list.length ? '<div class="table-wrap am-scroll"><table class="am-table ct-list"><thead><tr><th class="c-txt">名前</th><th class="c-txt">区分</th><th class="c-txt">今月の担当（メディア：ポジション）</th><th class="c-txt">入社日</th><th class="c-txt">勤続</th><th class="c-txt">退職日</th><th class="c-ctr">状態</th>' + (d.canSecret ? '<th class="c-txt">報酬（入社時・現在・予定）</th><th class="c-txt">経歴書類</th>' : '') + '<th class="c-ctr">操作</th></tr></thead><tbody>'
        + list.map(s => '<tr class="' + (s.status === '退職済み' ? 'ct-row-ended' : s.status === '退職予定' ? 'ct-row-ending' : '') + '"><td class="c-txt"><b>' + esc(s.name) + '</b><br><span class="note">' + esc(s.email) + '</span></td><td class="c-txt">' + empTypeText(s) + '</td>'
          + '<td class="c-txt">' + (s.status === '退職済み' ? '<span class="note">—</span>' : s.current.length ? esc(assignText(s.current)) : '<span class="note">未設定</span>') + '</td><td class="c-txt">' + dateJp(s.joinDate) + '</td><td class="c-txt">' + tenureOf(s) + '</td><td class="c-txt">' + (staffPromoted(s) ? (s.execRetireDate ? dateJp(s.execRetireDate) + '<br><span class="note">役員の退任日</span>' : '—') : s.retireDate ? dateJp(s.retireDate) : '—') + '</td>'
          + '<td class="c-ctr"><span class="pill ' + (STAFF_STATE_PILL[s.status] || 'off') + '">' + s.status + '</span></td>'
          + (d.canSecret ? '<td class="c-txt">' + payText(s) + '</td><td class="c-txt" data-sid="' + esc(s.id) + '">' + docsHtml(s) + '</td>' : '')
          + '<td class="c-ctr" style="white-space:nowrap"><button class="btn sm" type="button" data-se="' + esc(s.id) + '">編集</button> <button class="btn sm" type="button" data-sa="' + esc(s.id) + '">担当</button>' + (d.canSecret ? ' <button class="btn sm" type="button" data-sh="' + esc(s.id) + '">半期</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="empty">該当する社員はいません。「＋ 社員を登録」から登録してください。</p>')
      + '<p class="note">「担当」で、月ごとにどのメディアをどのポジションで担当するかを決めます。「半期」で、賞与・昇給額・評価（MKTスキル指標・行動評価・業績評価）を入れます（アルバイト・役員は評価なし）。担当は、記事目標設定と同じくディレクトリ単位で選べます。生年月日・給与・賞与・昇給額・評価・経歴書類は、管理者だけが見られます（本人も見られません）。評価の「本人」の欄は、半期の画面の「入力する欄」で切り替えて入力します。'
      + 'ユーザー管理で正社員・契約社員・アルバイトの役割のユーザーを追加するときは、ここに同じ名前・メールアドレス・区分の登録が必要です。月ごとの稼働の%と記事目標は「目標・工数」で入力・承認します。</p>';
    // 承認待ちの記事目標（目標・稼働工数設定で申請されたもの）
    try { const pend = (await api('/work-pending')).list; if (pend.length) { const box = document.createElement('div'); box.className = 'panel'; box.style.margin = '0 0 10px'; box.innerHTML = '<b>承認待ち（' + pend.length + '件）</b><div class="row" style="gap:6px; flex-wrap:wrap; margin-top:6px">' + pend.map((p2, i) => '<button class="btn sm primary" type="button" data-wap="' + i + '">' + (p2.kind === 'res' ? '稼働工数の修正：' : '記事目標：') + esc(p2.name) + '（' + halfLabel(p2.start) + '）</button>').join('') + '</div>'; $('st-body').prepend(box); box.querySelectorAll('[data-wap]').forEach(b2 => b2.onclick = () => { const p2 = pend[Number(b2.dataset.wap)]; (p2.kind === 'res' ? resApproveModal : workApproveModal)(p2.id, p2.start); }); } } catch (e) { /* 管理者でなければ出さない */ }
    const find = id => d.staff.find(s => s.id === id);
    if (!$('st-f')) return;   /* 読み込みの間にほかの画面へ移ったとき（2026-11-06 巡回で見つかった） */
    $('st-f').onchange = ev => { f.status = ev.target.value; render(); };
    $('st-add').onclick = () => staffModal(null, d.canSecret);
    document.querySelectorAll('[data-se]').forEach(b => b.onclick = () => staffModal(find(b.dataset.se), d.canSecret));
    document.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => assignModal(find(b.dataset.sa)));
    document.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => staffHalfModal(find(b.dataset.sh)));
    document.querySelectorAll('[data-sid] [data-sdoc]').forEach(b => { const s = find(b.closest('[data-sid]').dataset.sid); b.onclick = () => openStaffDoc(s.id, b.dataset.sdoc, s.name + '：' + s.docs[Number(b.dataset.sdoc)].label); });
  } };
}

/** 社員の登録・編集 */
function staffModal(s, canSecret) {
  const v = s || { empType: '正社員', joinDate: todayJst(), docs: [] };
  const opt = (list, cur) => list.map(x => '<option value="' + esc(x) + '"' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
  wideModal('<h2>' + (s ? '社員を編集' : '社員を登録') + '</h2><div class="form-grid">'
    + '<label>名前<input id="sf-name" value="' + esc(v.name || '') + '"></label><label>メールアドレス<input id="sf-email" type="email" value="' + esc(v.email || '') + '" placeholder="ダッシュボードにログインするメール"></label>'
    + '<label>入社時の雇用区分 <span class="note">（その後の変更は「半期」で設定）</span><select id="sf-emp">' + opt(STAFF_META.empTypes, v.empType) + '</select></label>'
    + (canSecret ? '<label>生年月日<input id="sf-birth" type="date" value="' + esc(v.birthDate || '') + '"></label>' : '<span></span>')
    + '<label>入社日 <span class="note">（役員に昇格しても最初の入社日のまま）</span><input id="sf-join" type="date" value="' + esc(v.joinDate || '') + '"></label><label>退職日 <span class="note">（空欄＝現職。先の日付＝退職予定）</span><input id="sf-retire" type="date" value="' + esc(v.retireDate || '') + '"></label>'
    + '<label id="sf-rt-wrap">退職の区分<select id="sf-rtype">' + [['退職', '退職'], ['昇格', '役員・執行役員に昇格']].map(([k, l]) => '<option value="' + k + '"' + ((staffPromoted(v) ? '昇格' : '退職') === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label><span id="sf-rt-pad"></span>'
    + '<div class="full form-grid" id="sf-promo" style="padding:0"><label>昇格先<select id="sf-pto">' + ['役員', '執行役員'].map(x => '<option' + ((v.promoTo || '役員') === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label><label>昇格日 <span class="note">（この日から昇格先の区分）</span><input id="sf-pdate" type="date" value="' + esc(v.promoDate || '') + '"></label>'
    + (canSecret ? '<label id="sf-ppay-l"><span id="sf-ppay-t">昇格後の報酬（円）</span><input id="sf-ppay" inputmode="numeric" value="' + (v.promoPay ?? '') + '"></label>' : '') + '<label>退任日 <span class="note">（空欄＝在任中）</span><input id="sf-exret" type="date" value="' + esc(v.execRetireDate || '') + '"></label></div>'
    + '<div class="full"><b style="font-size:13px">入社時の内容</b></div>'
    + '<label>ポジション<select id="sf-pos"></select></label>'
    + (canSecret ? '<div class="full form-grid" id="sf-pay" style="padding:0"></div>' : '')
    + (canSecret ? '<div class="full"><b style="font-size:13px">経歴（履歴書・職務経歴書の PDF）</b> <span id="sf-docs">' + docsHtml(v) + '</span><div class="row" style="gap:8px; align-items:flex-end; margin-top:4px; flex-wrap:wrap"><label class="field">種類<select id="sf-doc-label"><option>履歴書</option><option>職務経歴書</option></select></label><label class="field">PDFファイル<input type="file" id="sf-doc" accept="application/pdf"></label></div><p class="note" style="margin:2px 0 0">ファイルを選んで「保存」を押すと一緒に保存します。管理者だけが見られます。</p></div>' : '')
    + '<label class="full">メモ<textarea id="sf-memo" rows="2">' + esc(v.memo || '') + '</textarea></label></div><p class="err" id="sf-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="sf-save">保存</button></div>');
  const drawPos = () => { const cur = $('sf-pos').value || v.initPosition || ''; $('sf-pos').innerHTML = '<option value="">選んでください</option>' + opt((['正社員', '役員', '執行役員'].includes($('sf-emp').value) ? ['部長'] : []).concat(posFor($('sf-emp').value)), cur); };   /* 部長は入社時のポジションだけ（2026-10-27 ユーザー指定） */
  $('sf-emp').onchange = drawPos; drawPos();
  const drawRet = () => {
    const has = !!$('sf-retire').value, promo = has && $('sf-rtype').value === '昇格';
    $('sf-rt-wrap').hidden = !has; $('sf-promo').hidden = !promo;
    if (promo && !$('sf-pdate').value) $('sf-pdate').value = new Date(Date.parse($('sf-retire').value + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);   // 昇格日の初期値は退職日の翌日
    if ($('sf-ppay-t')) $('sf-ppay-t').textContent = $('sf-pto').value === '執行役員' ? '昇格後の年俸（円）' : '昇格後の月額報酬（円）';
  };
  $('sf-retire').oninput = $('sf-retire').onchange = $('sf-rtype').onchange = $('sf-pto').onchange = drawRet; drawRet();
  // 報酬の入力欄は、雇用区分で変わる（アルバイト＝時給、執行役員＝年俸、役員＝月額報酬、それ以外＝月給）
  const payVals = Object.assign({}, v), drawPay = () => { if (!$('sf-pay')) return; ['sf-annual', 'sf-monthly', 'sf-hourly', 'sf-hours'].forEach(id => { if ($(id)) payVals[{ 'sf-annual': 'initAnnual', 'sf-monthly': 'initMonthly', 'sf-hourly': 'initHourly', 'sf-hours': 'initHours' }[id]] = $(id).value; }); $('sf-pay').innerHTML = payFieldsHtml($('sf-emp').value, payVals); };
  $('sf-emp').onchange = () => { drawPos(); drawPay(); }; drawPay();
  if (s) document.querySelectorAll('#sf-docs [data-sdoc]').forEach(b => b.onclick = () => openStaffDoc(s.id, b.dataset.sdoc, s.name + '：' + s.docs[Number(b.dataset.sdoc)].label));
  $('sf-save').onclick = async () => {
    const fail = m => { $('sf-err').textContent = m; $('sf-err').hidden = false; };
    const b = { name: $('sf-name').value.trim(), email: $('sf-email').value.trim(), empType: $('sf-emp').value, joinDate: $('sf-join').value, retireDate: $('sf-retire').value, retireType: $('sf-retire').value ? $('sf-rtype').value : '退職', promoTo: $('sf-retire').value && $('sf-rtype').value === '昇格' ? $('sf-pto').value : '', promoDate: $('sf-retire').value && $('sf-rtype').value === '昇格' ? $('sf-pdate').value : '', execRetireDate: $('sf-retire').value && $('sf-rtype').value === '昇格' ? $('sf-exret').value : '', initPosition: $('sf-pos').value, memo: $('sf-memo').value };
    if (canSecret) { const val = id => $(id) ? $(id).value.trim() : undefined; Object.assign(b, { birthDate: $('sf-birth').value, initAnnual: val('sf-annual'), initMonthly: val('sf-monthly'), initHourly: val('sf-hourly'), initHours: val('sf-hours'), promoPay: b.promoTo ? val('sf-ppay') : undefined }); Object.keys(b).forEach(k => b[k] === undefined && delete b[k]); }
    if (b.promoTo && !b.promoDate) return fail('昇格日を入力してください');
    if (!b.name) return fail('名前を入力してください');
    if (!b.email) return fail('メールアドレスを入力してください');
    if (!b.joinDate) return fail('入社日を入力してください');
    const file = $('sf-doc') && $('sf-doc').files[0];
    if (file && file.size > 20 * 1024 * 1024) return fail('PDFは20MBまでです');
    let id = s && s.id;
    try { if (s) await apiSend('PATCH', '/staff/' + encodeURIComponent(s.id), b); else id = (await apiSend('POST', '/staff', b)).id; } catch (e) { return fail(e.message); }
    if (file) { try { await uploadStaffDoc(id, $('sf-doc-label').value, file); } catch (e) { alert('保存しましたが、PDFを保存できませんでした：' + e.message); } }
    closeModal(); render(); toast('保存されました');
  };
}

/** 月ごとの担当（どのメディアをどのポジションで） */
const ASSIGN_FIRST_HALF = '2024-11';   // 担当の表で選べるいちばん前の半期
const halfMonthsOf = start => Array.from({ length: 6 }, (_, i) => shiftMonth(start, i));
function assignModal(s) {
  let ym = CUR_MONTH, pos = posFor(staffEmpAt(s, ym)), res = {};
  let workMap = null, halfPos = {}, joinYm = null, endYm = null, tblHalf = null;
  const loadRes = async force => { if (!workMap || force) { try { const w = await api('/staff/' + encodeURIComponent(s.id) + '/work-all'); workMap = w.months; halfPos = w.halves || {}; joinYm = w.joinYm; endYm = w.endYm; } catch (e) { workMap = {}; } } res = (workMap[ym] || {}).resource || {}; };
  const outOf = m => joinYm && m < joinYm ? '入社前' : endYm && m > endYm ? '退職後' : '';
  const locked = m => outOf(m) === '入社前' || (outOf(m) === '退職後' && !((s.assign || {})[m] || []).length);   // 退職後でも、担当が入っている月は直せる
  const posAt = m => (staffPosAt(s, m) ? [staffPosAt(s, m)] : !(s.changes || []).length && halfPos[halfOf(m).start] ? [halfPos[halfOf(m).start]] : posFor(staffEmpAt(s, m))).concat(['監修・記事サポート']);   /* 監修・記事サポートはどの月でも選べる（2026-10-27 ユーザー指定） */
  /** 表の1行：担当（稼働%） */
  const withPct = m => { const rows = (s.assign || {})[m] || [], r = (workMap[m] || {}).resource || {}, seen = new Set(); return rows.map(a => { const k = a.sub ? a.media + '|' + a.sub : a.media, v = r[k] != null ? r[k] : !seen.has(a.media) && a.sub && r[a.media] != null ? r[a.media] : null, p = v != null ? '（' + v + '%）' : ''; seen.add(a.media); return esc(unitLabel(a.media) + (a.sub ? '／' + a.sub : '') + '：' + a.position) + '<b>' + p + '</b>'; }).join('、'); };
  const draw = async () => {
    await loadRes();
    pos = posAt(ym);
    const used = new Set();
    const pctOf = r => { if (!r.media) return ''; const k = r.sub ? r.media + '|' + r.sub : r.media; if (res[k] != null) return res[k]; if (used.has(r.media)) return ''; used.add(r.media); return res[r.media] ?? ''; };
    const rows = (s.assign || {})[ym] || [];
    if (!tblHalf) tblHalf = halfOf(ym).start;
    const halfList = []; for (let h = shiftMonth(halfOf(CUR_MONTH).start, 6); h >= ASSIGN_FIRST_HALF; h = shiftMonth(h, -6)) halfList.push(h);
    const span = halfMonthsOf(tblHalf);   // 選んでいる月の前後6か月
    const choices = assignChoices(), groups = [...new Set(choices.map(c => c.group))];
    const rowHtml = (r, i) => '<div class="row as-row" style="gap:6px; margin:3px 0"><select data-am><option value="">メディア・ディレクトリを選ぶ</option>' + groups.map(g => '<optgroup label="' + esc(g) + '">' + choices.filter(c => c.group === g).map(c => '<option value="' + esc(c.media + '|' + c.sub) + '"' + (c.media === r.media && c.sub === (r.sub || '') ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</optgroup>').join('') + '</select>'
      + '<select data-ap>' + pos.map(p => '<option' + (p === r.position ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select><label class="field" style="flex-direction:row; align-items:center; gap:4px">稼働<input data-apct type="number" min="0" max="100" inputmode="numeric" value="' + (r.pct ?? pctOf(r)) + '" style="width:4.5em">%</label><button class="linkbtn" type="button" data-adel="' + i + '">削除</button></div>';
    const out = outOf(ym), hp = halfPos[halfOf(ym).start];
    wideModal('<h2>担当：' + esc(s.name) + ' <small class="note">' + esc(staffEmpAt(s, ym)) + '（' + mLabel(ym) + '）</small></h2>'
      + '<div class="row" style="gap:8px; align-items:flex-end; flex-wrap:wrap"><label class="field">月<input type="month" id="as-ym" value="' + ym + '"' + (joinYm ? ' min="' + joinYm + '"' : '') + '></label><button class="btn sm" type="button" id="as-prev">前の月の担当をコピー</button>'
      + '<span class="note">' + mLabel(ym) + 'のポジション：' + ((staffPosAt(s, ym) || hp) ? '<b>' + esc(staffPosAt(s, ym) || hp) + '</b>' : '未設定（「半期」の「次のポジション」で設定すると、そのポジションだけ選べます）') + '</span></div>'
      + (out ? '<p class="' + (locked(ym) ? 'err' : 'note') + '">' + mLabel(ym) + ' は' + out + 'の月です' + (locked(ym) ? '。担当を入れられません' : '。すでに入っている担当を直したり消したりできます（新しい月には入れられません）') + '（入社 ' + dateJp(s.joinDate) + (staffEnd(s) ? '・退職 ' + dateJp(staffEnd(s)) : '') + '）。</p>' : '')
      + '<div id="as-rows">' + (rows.length ? rows : [{ media: '', position: pos[0] }]).map(rowHtml).join('') + '</div><button class="btn sm" type="button" id="as-add">＋ 担当を追加</button> <b class="num" id="as-tot"></b>'
      + '<p class="note">稼働の%はディレクトリごとに入れられます（合計100%）。入れると、その月の稼働工数として承認済みになり、BEST人件費はメディアごとに合計して配分します。空欄なら%は変えません。</p>'
      + (['正社員', '契約社員'].includes(staffEmpAt(s, ym)) ? '<label class="field" style="margin-top:6px; flex-direction:row; align-items:center; gap:4px; flex-wrap:wrap">この月の残業時間<input id="as-ot-hh" type="number" min="0" step="1" inputmode="numeric" value="' + ((s.overtime || {})[ym] != null ? Math.floor(s.overtime[ym]) : '') + '" style="width:6em">時間<input id="as-ot-mm" type="number" min="0" max="59" step="1" inputmode="numeric" value="' + ((s.overtime || {})[ym] != null ? Math.round((s.overtime[ym] % 1) * 60) : '') + '" style="width:4.5em">分<span class="note">記録用です</span></label>' : '')   /* 正社員・契約社員の残業時間（2026-10-27 ユーザー指定） */
      + (HOURS_TYPES_UI.includes(staffEmpAt(s, ym)) ? '<label class="field" style="margin-top:6px; flex-direction:row; align-items:center; gap:4px; flex-wrap:wrap">この月の稼働時間<input id="as-hh" type="number" min="0" step="1" inputmode="numeric" value="' + ((s.hours || {})[ym] != null ? Math.floor(s.hours[ym]) : '') + '" placeholder="' + (s.initHours ? '目安 ' + s.initHours : '') + '" style="width:6em">時間<input id="as-mm" type="number" min="0" max="59" step="1" inputmode="numeric" value="' + ((s.hours || {})[ym] != null ? Math.round((s.hours[ym] - Math.floor(s.hours[ym])) * 60) : '') + '" style="width:4.5em">分<span class="note">' + (staffEmpAt(s, ym) === 'アルバイト' ? '人件費は 時給×この時間で毎月計算します（空欄の月は登録時の目安の時間）' : '記録用です（' + esc(staffEmpAt(s, ym)) + 'は月給なので、人件費の計算には使いません）') + '</span></label>' : '')
      + '<label class="field" style="margin-top:6px">この月から次の月まで同じ担当にする（任意）<input type="month" id="as-until" min="' + ym + '"></label>'
      + '<div class="row" style="gap:8px; align-items:flex-end; flex-wrap:wrap; margin-top:10px"><h3 class="am-h" style="margin:0">半期ごとの担当</h3><label class="field">半期<select id="as-thalf">' + halfList.map(h => '<option value="' + h + '"' + (h === tblHalf ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label><span class="note">（ ）は稼働の%。「編集」でその月を編集</span></div>'
      + '<div class="table-wrap"><table class="am-table"><tbody>' + span.map(m => '<tr' + (m === ym ? ' style="background:var(--surface-2); font-weight:bold"' : '') + '><td class="c-txt" style="white-space:nowrap">' + mLabel(m) + (m === CUR_MONTH ? ' <span class="note">今月</span>' : '') + '</td><td class="c-txt">' + (withPct(m) || '<span class="note">—</span>') + ((s.hours || {})[m] != null ? ' <span class="pill off">' + Math.floor(s.hours[m]) + '時間' + (Math.round((s.hours[m] % 1) * 60) ? Math.round((s.hours[m] % 1) * 60) + '分' : '') + '</span>' : '') + ((s.overtime || {})[m] != null ? ' <span class="pill wait">残業 ' + Math.floor(s.overtime[m]) + '時間' + (Math.round((s.overtime[m] % 1) * 60) ? Math.round((s.overtime[m] % 1) * 60) + '分' : '') + '</span>' : '') + ((workMap[m] || {}).resource && !(workMap[m] || {}).approved ? ' <span class="pill wait">未承認</span>' : '') + '</td><td class="c-ctr">' + (locked(m) ? '<span class="note">' + outOf(m) + '</span>' : (outOf(m) ? '<span class="note">' + outOf(m) + '</span> ' : '') + (m === ym ? '<span class="note">編集中</span>' : '<button class="btn sm" type="button" data-asym="' + m + '">編集</button>')) + '</td></tr>').join('') + '</tbody></table></div>'
      + '<p class="err" id="as-err" hidden></p><div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="as-save">保存</button></div>');
    const read = () => [...document.querySelectorAll('#as-rows .as-row')].map(r => { const v = r.querySelector('[data-am]').value, i = v.indexOf('|'), pc = r.querySelector('[data-apct]').value; return { media: i < 0 ? v : v.slice(0, i), sub: i < 0 ? '' : v.slice(i + 1), position: r.querySelector('[data-ap]').value, pct: pc === '' ? null : Number(pc) }; }).filter(r => r.media);
    const showTot = () => { const t = read().reduce((a, r) => a + (r.pct || 0), 0), any = read().some(r => r.pct != null); $('as-tot').textContent = any ? '稼働の合計 ' + t + '%' : ''; $('as-tot').style.color = !any || t === 100 ? '' : 'var(--bad)'; };
    $('as-rows').oninput = showTot; showTot();
    $('as-ym').onchange = ev => { if (ev.target.value) { ym = ev.target.value; tblHalf = halfOf(ym).start; draw(); } };
    $('as-thalf').onchange = ev => { tblHalf = ev.target.value; draw(); };
    document.querySelectorAll('[data-asym]').forEach(b => b.onclick = () => { ym = b.dataset.asym; draw(); });
    if (locked(ym)) { $('as-save').disabled = true; $('as-add').disabled = true; $('as-prev').disabled = true; }
    $('as-add').onclick = () => { const cur = read(); cur.push({ media: '', position: pos[0] }); $('as-rows').innerHTML = cur.map(rowHtml).join(''); bindDel(); };
    const bindDel = () => document.querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { const cur = read(); cur.splice(Number(b.dataset.adel), 1); $('as-rows').innerHTML = (cur.length ? cur : [{ media: '', position: pos[0] }]).map(rowHtml).join(''); bindDel(); });
    bindDel();
    $('as-prev').onclick = () => { const p = (s.assign || {})[shiftMonth(ym, -1)] || []; if (!p.length) return alert('前の月の担当がありません'); $('as-rows').innerHTML = p.map(rowHtml).join(''); bindDel(); };
    $('as-save').onclick = async () => {
      const rows2 = read(), until = $('as-until').value;
      try {
        const hh = $('as-hh'), mmIn = $('as-mm'), body = { rows: rows2, until };
        const ot = $('as-ot-hh'), otm = $('as-ot-mm'), otVal = ot ? (ot.value === '' && otm.value === '' ? '' : Math.round(((Number(ot.value) || 0) + (Number(otm.value) || 0) / 60) * 10000) / 10000) : undefined;
        if (ot) { if (otm.value !== '' && (Number(otm.value) < 0 || Number(otm.value) > 59)) { $('as-err').className = 'err'; $('as-err').textContent = '分は0〜59で入力してください'; $('as-err').hidden = false; return; } body.overtime = otVal; }
        const hoursVal = hh ? (hh.value === '' && mmIn.value === '' ? '' : Math.round(((Number(hh.value) || 0) + (Number(mmIn.value) || 0) / 60) * 10000) / 10000) : undefined;
        if (hh && mmIn.value !== '' && (Number(mmIn.value) < 0 || Number(mmIn.value) > 59)) { $('as-err').className = 'err'; $('as-err').textContent = '分は0〜59で入力してください'; $('as-err').hidden = false; return; }
        if (hh) body.hours = hoursVal;
        const hoursIn = hh ? { value: hoursVal === '' ? '' : String(hoursVal) } : null;
        await apiSend('PUT', '/staff/' + encodeURIComponent(s.id) + '/assign/' + ym, body);
        if (ot) { s.overtime = s.overtime || {}; let mo = ym; do { if (['正社員', '契約社員'].includes(staffEmpAt(s, mo))) s.overtime[mo] = otVal === '' ? null : otVal; mo = shiftMonth(mo, 1); } while (until && mo <= until); }
        if (hoursIn) { s.hours = s.hours || {}; let mm = ym; do { if (HOURS_TYPES_UI.includes(staffEmpAt(s, mm))) s.hours[mm] = hoursIn.value === '' ? null : Number(hoursIn.value); mm = shiftMonth(mm, 1); } while (until && mm <= until); }
        s.assign = s.assign || {}; let m = ym; do { s.assign[m] = rows2.map(r => ({ media: r.media, sub: r.sub, position: r.position })); m = shiftMonth(m, 1); } while (until && m <= until);
        await loadRes(true); await draw(); const e = $('as-err'); e.hidden = false; e.className = 'note'; e.textContent = '保存されました'; toast('保存されました'); if (state.view === 'staff') refreshStaffList();
      } catch (e) { $('as-err').className = 'err'; $('as-err').textContent = e.message; $('as-err').hidden = false; }
    };
    document.querySelectorAll('#modal [data-close]').forEach(b => b.onclick = () => { closeModal(); render(); });
  };
  draw();
}

// ---- 半期：賞与・昇給額・評価 ----
/** 業績評価：その半期に担当したメディアの、目標と実績（記事本数・PV・CV・収益）を自動で並べる */
function staffPerfHtml(st, months) {
  const done = months.filter(m => m <= CUR_MONTH);
  const medias = [...new Set(months.flatMap(m => ((st.assign || {})[m] || []).map(a => a.media)))].filter(m => !NON_MEDIA_UNITS.includes(m));
  if (!medias.length) return '<p class="empty">この半期の担当メディアが登録されていません（「担当」で登録してください）。</p>';
  const sum = (m, k, ms) => ms.reduce((a, ym) => { const v = monthVal(m, ym)[k]; return v == null ? a : (a || 0) + v; }, null);
  const tsum = (m, type, ms) => ms.reduce((a, ym) => { const v = targetOf(m, ym, type); return v == null ? a : (a || 0) + v; }, null);
  const pct = (a, b) => a != null && b ? Math.round(a / b * 100) + '%' : '—';
  return '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">メディア（担当した月）</th><th class="c-num">新規 目標</th><th class="c-num">新規 実績</th><th class="c-num">達成率</th><th class="c-num">リライト 目標</th><th class="c-num">リライト 実績</th><th class="c-num">達成率</th><th class="c-num">PV</th><th class="c-num">前年比</th><th class="c-num">CV</th><th class="c-num">前年比</th><th class="c-num">収益</th><th class="c-num">前年比</th></tr></thead><tbody>'
    + medias.map(m => {
      const ms = done.filter(ym => ((st.assign || {})[ym] || []).some(a => a.media === m)), ly = ms.map(ym => shiftMonth(ym, -12));
      const pos = [...new Set(months.flatMap(ym => ((st.assign || {})[ym] || []).filter(a => a.media === m).map(a => a.position)))].join('・');
      const tn = tsum(m, 'new', ms), tr = tsum(m, 'rewrite', ms), an = sum(m, 'posts', ms), ar = (sum(m, 'rewrites', ms) || 0) + (sum(m, 'lite', ms) || 0);
      const cell = (k, f) => { const a = sum(m, k, ms), b = sum(m, k, ly); return '<td class="c-num">' + (a == null ? '—' : f(a)) + '</td><td class="c-num">' + pct(a, b) + '</td>'; };
      return '<tr><td class="c-txt"><b>' + esc(mediaLabel(m)) + '</b><br><span class="note">' + esc(pos) + '・' + ms.length + 'か月</span></td><td class="c-num">' + (tn ?? '—') + '</td><td class="c-num">' + (an ?? '—') + '</td><td class="c-num">' + pct(an, tn) + '</td><td class="c-num">' + (tr ?? '—') + '</td><td class="c-num">' + ar + '</td><td class="c-num">' + pct(ar, tr) + '</td>'
        + cell('pv', v => nf.format(Math.round(v))) + cell('cv', v => nf.format(Math.round(v))) + cell('revenue', v => yen0(v)) + '</tr>';
    }).join('') + '</tbody></table></div><p class="note">目標は記事目標設定（承認された目標・稼働工数を含む）、実績は進行管理の本数とメディア数値（担当した月だけ、今月までの合計）です。前年比は前年の同じ月の合計との比較です。</p>';
}
/** 半期の画面（管理者は全部、本人は自分の評価の欄だけ入力） */
/** MKTスキル指標の大分類（例：一般的事項、SEOメディア運用／関連ツールの専門知識）。MAX＝そのポジションの「必須（◎）」の満点の合計 */
function skillGroups(col) {
  const out = [];
  STAFF_META.eval.skills.forEach(s => {
    const key = s.cat + (s.sub ? '／' + s.sub : '');
    let g = out.find(x => x.key === key); if (!g) { g = { key, max: 0, n: 0, extra: 0 }; out.push(g); }
    if (s.marks[col] === '◎') { g.max += s.scale.o; g.n++; } else if (s.marks[col] === '★') g.extra++;
  });
  return out.filter(g => g.n || g.extra);
}
/** 半期の画面（管理者だけ。本人の欄も評価者の欄も管理者が入力する）（2026-10-27 ユーザー指定） */
function staffHalfHtml(d) {
  const M = STAFF_META, h = d.half, edit = !!d.isBoss;
  const col = M.evalCol[d.evalPosition] || '';
  const posSel = edit ? '<label class="field">評価のポジション<select id="sh-pos"><option value="">選んでください</option>' + Object.keys(M.evalCol).map(p => '<option' + (p === d.evalPosition ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select></label>' : '<span class="note">評価のポジション：' + esc(d.evalPosition || '未設定') + '</span>';
  // 雇用区分・ポジション・報酬の変更（月単位）。「次の雇用区分・次のポジション・次の報酬」を開始月ごとに入れる（2026-10-27 ユーザー指定）
  const st2 = Object.assign({}, d.staff, { changes: d.changes });
  const opt = (list, cur, empty) => '<option value="">' + empty + '</option>' + list.map(x => '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
  const chRows = d.changes.map((c, i) => { const t = c.empType || staffEmpAt(Object.assign({}, st2, { changes: d.changes.filter((_, j) => j !== i) }), c.from || d.start);
    return '<tr data-ch="' + i + '"><td class="c-txt"><input type="month" data-cf value="' + esc(c.from || '') + '"></td><td class="c-txt"><select data-ce>' + opt(d.empTypes || [], c.empType, '（変えない）') + '</select></td><td class="c-txt"><select data-cp>' + opt(posFor(t), c.position, '（変えない）') + '</select></td>'
      + '<td class="c-txt"><input type="number" min="0" inputmode="numeric" data-cy value="' + (c.pay ?? '') + '" placeholder="（変えない）" style="width:9em"> <span class="note">' + payLabelOf(t) + '</span></td><td class="c-ctr"><button class="linkbtn" type="button" data-cdel="' + i + '">削除</button></td></tr>'; }).join('');
  const monthsTbl = '<table class="am-table"><thead><tr><th class="c-txt">月</th><th class="c-txt">雇用区分</th><th class="c-txt">ポジション</th><th class="c-num">報酬（月額）</th></tr></thead><tbody>' + d.months.map(m => '<tr><td class="c-txt">' + mLabel(m) + '</td><td class="c-txt">' + esc(staffEmpAt(st2, m)) + '</td><td class="c-txt">' + esc(staffPosAt(st2, m) || d.position || '—') + '</td><td class="c-num">' + yen0(d.monthlyPay[m]) + '</td></tr>').join('') + '</tbody></table>';
  const halfPosHtml = '<h3 class="am-h" style="margin-top:0">雇用区分・ポジション・報酬 <span class="note">月単位で変えられます。変えた月から次に変えるまで、その内容になります</span></h3>'
    + (edit ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">開始月</th><th class="c-txt">次の雇用区分</th><th class="c-txt">次のポジション</th><th class="c-txt">次の報酬（円）</th><th></th></tr></thead><tbody>' + (chRows || '<tr><td class="c-txt note" colspan="5">変更はまだありません（入社時の内容のまま）</td></tr>') + '</tbody></table></div><button class="btn sm" type="button" id="sh-ch-add">＋ 変更を追加</button>' : '')
    + '<details style="margin:6px 0"><summary class="note">この半期の月ごとの内容（保存すると反映）</summary><div class="table-wrap">' + monthsTbl + '</div></details>';
  // 賞与は「何か月分」（小数点も可）。金額＝その半期の最初の月の給与 × か月数（2026-10-27 ユーザー指定）
  const base = d.monthlyPay[d.start] || 0, bm = h.bonusMonths;
  const money = halfPosHtml + '<div class="row" style="gap:10px; flex-wrap:wrap; align-items:flex-end">'
    + (edit ? '<label class="field">賞与（何か月分）<input id="sh-bonusm" type="number" min="0" step="0.01" inputmode="decimal" value="' + (bm ?? '') + '" style="width:7em"></label><span class="note" id="sh-bonus-yen">' + (bm != null ? '＝ ' + yen0(bm * base) : (h.bonus != null ? '（以前の入力：' + yen0(h.bonus) + '）' : '')) + '</span><label class="field">昇給額（月額・円。' + (d.raiseFrom ? mLabel(d.raiseFrom) + 'から' : '7月・12月に') + '反映）<input id="sh-raise" inputmode="numeric" value="' + (h.raise ?? '') + '"></label>'
      : '<span>賞与：<b>' + (bm != null ? bm + 'か月分（' + yen0(bm * base) + '）' : yen0(h.bonus)) + '</b></span><span>昇給額：<b>' + yen0(h.raise) + '</b></span>')
    + '<span class="note">月の給与：' + d.months.map(m => mLabel(m).slice(5) + ' ' + yen0(d.monthlyPay[m])).join('／') + '</span></div>';
  if (d.noEval) return money + '<p class="note">' + esc(d.empTypeHalf || 'アルバイト') + 'のため、半期の評価の項目はありません。</p>';
  // MKTスキル指標：大分類ごとに MAX と、本人・評価者の合計点だけを入れる（2026-10-27 ユーザー指定）
  let skillHtml = '<p class="empty">評価のポジションを選ぶと、そのポジションの大分類と MAX が出ます。</p>';
  if (col) {
    const gs = skillGroups(col), sg = h.skillGroups || {}, tot = { max: 0, self: 0, boss: 0 };
    const inp = (key, who, v) => edit ? '<input type="number" min="0" step="1" inputmode="numeric" data-sg="' + esc(key) + '" data-who="' + who + '" value="' + (v ?? '') + '" style="width:5.5em">' : (v ?? '—');
    skillHtml = '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">大分類（MKTスキル指標）</th><th class="c-num">MAX</th><th class="c-ctr">本人</th><th class="c-ctr">評価者</th></tr></thead><tbody>'
      + gs.map(g => { const v = sg[g.key] || {}; tot.max += g.max; if (v.self != null) tot.self += v.self; if (v.boss != null) tot.boss += v.boss;
        return '<tr><td class="c-txt"><b>' + esc(g.key) + '</b><br><span class="note">必須 ' + g.n + '項目' + (g.extra ? '・加点 ' + g.extra + '項目' : '') + '</span></td><td class="c-num">' + g.max + '</td><td class="c-ctr">' + inp(g.key, 'self', v.self) + '</td><td class="c-ctr">' + inp(g.key, 'boss', v.boss) + '</td></tr>'; }).join('')
      + '<tr class="total"><td class="c-txt"><b>合計</b></td><td class="c-num"><b>' + tot.max + '</b></td><td class="c-ctr"><b id="sh-tot-self">' + tot.self + '</b></td><td class="c-ctr"><b id="sh-tot-boss">' + tot.boss + '</b></td></tr></tbody></table></div>'
      + '<p class="note">MAX は、そのポジションの「必須」の項目の満点の合計です（評価シートと同じ）。「加点」の項目ができていれば、MAX を超えて入れても大丈夫です。</p>';
  }
  const lv = col === 'PM' || col === 'D' ? 0 : col ? 1 : -1;
  const beh = M.eval.behavior.map(b => {
    const v = h.behavior[b.cat] || {}, txt = lv >= 0 ? b.levels[lv].text : '';
    const area = who => edit ? '<textarea rows="3" data-bh="' + esc(b.cat) + '" data-who="' + who + '">' + esc(v[who] || '') + '</textarea>' : '<div class="note" style="white-space:pre-wrap">' + (esc(v[who] || '') || '—') + '</div>';
    return '<div style="border:1px solid var(--line); border-radius:8px; padding:8px; margin:6px 0"><b>' + esc(b.cat) + '</b><div class="note" style="white-space:pre-wrap; margin:4px 0">' + esc(txt) + '</div>'
      + '<div class="grid2 even" style="gap:8px"><label class="field">本人' + area('self') + '</label><label class="field">評価者' + area('boss') + '</label></div></div>';
  }).join('');
  const perf = h.perf || {};
  return money
    + '<h3 class="am-h">MKTスキル指標 ' + posSel + '</h3>' + skillHtml
    + '<h3 class="am-h">行動評価 <span class="note">本人・評価者ともに記述</span></h3>' + beh
    + '<h3 class="am-h">業績評価 <span class="note">担当メディアの目標と実績（自動）</span></h3>' + staffPerfHtml(d.staff, d.months)
    + '<div class="row" style="gap:8px; align-items:flex-end; flex-wrap:wrap">' + (edit ? '<label class="field">業績評価のランク<select id="sh-rank"><option value="">選んでください</option>' + M.ranks.map(r => '<option' + (r === perf.rank ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></label><label class="field" style="flex:1">業績評価のコメント<textarea id="sh-perf" rows="2">' + esc(perf.comment || '') + '</textarea></label>'
      : '<span>業績評価のランク：<b>' + esc(perf.rank || '—') + '</b></span><span class="note" style="white-space:pre-wrap">' + esc(perf.comment || '') + '</span>') + '</div>'
    + '<div class="grid2 even" style="gap:8px; margin-top:8px"><label class="field">本人の振り返り（全体）' + (edit ? '<textarea id="sh-selfnote" rows="3">' + esc(h.selfNote || '') + '</textarea>' : '<div class="note" style="white-space:pre-wrap">' + (esc(h.selfNote || '') || '—') + '</div>') + '</label>'
    + '<label class="field">評価者のコメント（全体）' + (edit ? '<textarea id="sh-bossnote" rows="3">' + esc(h.bossNote || '') + '</textarea>' : '<div class="note" style="white-space:pre-wrap">' + (esc(h.bossNote || '') || '—') + '</div>') + '</label></div>';
}
function readStaffHalf(d) {
  const b = { bonusMonths: ($('sh-bonusm') || {}).value, raise: ($('sh-raise') || {}).value };
  if (!d.noEval) {
    b.skillGroups = {}; document.querySelectorAll('[data-sg]').forEach(x => { (b.skillGroups[x.dataset.sg] = b.skillGroups[x.dataset.sg] || {})[x.dataset.who] = x.value; });
    b.behavior = {}; document.querySelectorAll('[data-bh]').forEach(x => { (b.behavior[x.dataset.bh] = b.behavior[x.dataset.bh] || {})[x.dataset.who] = x.value; });
    Object.assign(b, { evalPosition: ($('sh-pos') || {}).value || '', perf: { rank: ($('sh-rank') || {}).value || '', comment: ($('sh-perf') || {}).value || '' }, bossNote: ($('sh-bossnote') || {}).value || '', selfNote: ($('sh-selfnote') || {}).value || '' });
  }
  return b;
}
/** 変更の表の入力を d.changes に戻す */
function readChanges(d) { const rows = [...document.querySelectorAll('[data-ch]')]; if (!rows.length) return; d.changes = rows.map(r => ({ from: r.querySelector('[data-cf]').value, empType: r.querySelector('[data-ce]').value, position: r.querySelector('[data-cp]').value, pay: r.querySelector('[data-cy]').value === '' ? null : Number(r.querySelector('[data-cy]').value) })); }
/** 入力中の値を d に戻す（ポジションを変えて描き直すときに消えないように） */
function keepStaffHalf(d) {
  const k = readStaffHalf(d), h = d.half;
  h.bonusMonths = k.bonusMonths === '' || k.bonusMonths == null ? null : Number(k.bonusMonths); h.raise = k.raise;
  readChanges(d);
  if (k.skillGroups) { h.skillGroups = h.skillGroups || {}; Object.entries(k.skillGroups).forEach(([g, v]) => { h.skillGroups[g] = { self: v.self === '' ? null : Number(v.self), boss: v.boss === '' ? null : Number(v.boss) }; }); }
  if (k.behavior) h.behavior = Object.assign({}, h.behavior, k.behavior);
  if (k.perf) h.perf = k.perf; if (k.selfNote != null) h.selfNote = k.selfNote; if (k.bossNote != null) h.bossNote = k.bossNote;
}
async function staffHalfModal(s, start) {
  start = start || halfOf(CUR_MONTH).start;
  await Promise.all([loadStaffMeta(), loadArticles()]);
  const d = await api('/staff/' + encodeURIComponent(s.id) + '/half/' + start);
  d.changes = JSON.parse(JSON.stringify(d.staff.changes || []));
  const draw = () => {
    wideModal('<h2>半期：' + esc(s.name) + ' <small class="note">' + esc(d.empTypeHalf || d.staff.empType) + '</small></h2>'
      + '<div class="row" style="gap:8px; flex-wrap:wrap; align-items:flex-end"><label class="field">半期<select id="sh-half">' + halfStarts().map(x => '<option value="' + x + '"' + (x === start ? ' selected' : '') + '>' + halfLabel(x) + '</option>').join('') + '</select></label>'
      + '</div>'
      + '<div id="sh-body">' + staffHalfHtml(d) + '</div><p class="err" id="sh-err" hidden></p>'
      + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="sh-save">保存</button></div>');
    $('sh-half').onchange = ev => { closeModal(); staffHalfModal(s, ev.target.value); };
    if ($('sh-ch-add')) $('sh-ch-add').onclick = () => { keepStaffHalf(d); d.changes.push({ from: d.raiseFrom || d.start, empType: '', position: '', pay: null });   /* 昇格・昇給の月（7月・12月）を初期値に */ draw(); };
    document.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => { keepStaffHalf(d); d.changes.splice(Number(b.dataset.cdel), 1); draw(); });
    document.querySelectorAll('[data-ce], [data-cf]').forEach(el => el.onchange = () => { keepStaffHalf(d); draw(); });
    if ($('sh-etype')) $('sh-etype').onchange = ev => { keepStaffHalf(d); const t = ev.target.value; d.empTypeHalf = t; d.noEval = NO_EVAL_TYPES.includes(t); d.positions = posFor(t); if (!d.positions.includes(d.position)) d.position = ''; draw(); };
    if ($('sh-hpos')) $('sh-hpos').onchange = ev => { keepStaffHalf(d); d.position = ev.target.value; if (STAFF_META.evalCol[d.position]) d.evalPosition = d.position; draw(); };
    if ($('sh-pos')) $('sh-pos').onchange = ev => { keepStaffHalf(d); d.evalPosition = ev.target.value; draw(); };
    if ($('sh-bonusm')) $('sh-bonusm').oninput = ev => { const v = ev.target.value; $('sh-bonus-yen').textContent = v === '' ? '' : '＝ ' + yen0(Number(v) * (d.monthlyPay[d.start] || 0)); };
    const sumSg = who => [...document.querySelectorAll('[data-sg][data-who="' + who + '"]')].reduce((a, x) => a + (Number(x.value) || 0), 0);
    document.querySelectorAll('[data-sg]').forEach(x => x.oninput = () => { $('sh-tot-self').textContent = sumSg('self'); $('sh-tot-boss').textContent = sumSg('boss'); });
    $('sh-save').onclick = async () => {
      try { readChanges(d); await apiSend('PUT', '/staff/' + encodeURIComponent(s.id) + '/changes', { changes: d.changes }); s.changes = d.changes; await apiSend('PUT', '/staff/' + encodeURIComponent(s.id) + '/half/' + start, readStaffHalf(d)); closeModal(); if (state.view === 'staff') await refreshStaffList(); toast('保存されました'); staffHalfModal(s, start); }
      catch (e) { $('sh-err').textContent = e.message; $('sh-err').hidden = false; }
    };
  };
  draw();
}

// ================= REsta社員管理（2026-10-30 ユーザー指定） =================
// BEST社員管理と同じ形で、操作は「編集」と「担当」だけ。担当は今は Eparkくらしのレスキューだけ（これから細分化）
function viewResta() {
  return { html: '<section class="panel" id="rs-body"><p class="loading">読み込み中…</p></section>', view: 'REsta社員管理', after: async () => {
    const d = await api('/resta-staff'), unitL = k => d.units[k] || k;
    const cur = s => (s.current || []).map(a => unitL(a.media) + '（' + a.position + '）').join('、');
    $('rs-body').innerHTML = H('REsta社員管理 <small>' + d.staff.length + '人</small>', [])
      + '<div class="row" style="justify-content:flex-end; margin-bottom:8px"><button class="btn primary" type="button" id="rs-add">＋ REsta社員を追加</button></div>'
      + (d.staff.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">名前</th><th class="c-txt">メールアドレス</th><th class="c-ctr">役員</th>' + (d.canSecret ? '<th class="c-ctr">生年月日</th>' : '') + '<th class="c-txt">ポジション</th><th class="c-txt">今月の担当</th><th class="c-txt">操作</th></tr></thead><tbody>'
        + d.staff.map((s, i) => '<tr><td class="c-txt"><b>' + esc(s.name) + '</b></td><td class="c-txt">' + esc(s.email || '—') + '</td><td class="c-ctr">' + (s.exec ? '<span class="pill ok">役員</span>' : '—') + '</td>' + (d.canSecret ? '<td class="c-ctr">' + (s.birthDate ? esc(s.birthDate.replace(/-/g, '/')) : '—') + '</td>' : '') + '<td class="c-txt">' + esc(s.position || '—') + '</td><td class="c-txt">' + (esc(cur(s)) || '<span class="note">—</span>') + '</td>'
          + '<td class="c-txt"><button class="btn sm" type="button" data-rse="' + i + '">編集</button> <button class="btn sm" type="button" data-rsa="' + i + '">担当</button></td></tr>').join('') + '</tbody></table></div>'
        : '<p class="empty">まだ登録がありません。「＋ REsta社員を追加」から登録してください。</p>');
    const edit = s => {
      const v = s || {};
      openModal('<h2>' + (s ? 'REsta社員を編集' : 'REsta社員を追加') + '</h2><div class="form-grid">'
        + '<label>名前<input id="rs-name" value="' + esc(v.name || '') + '"></label><label>メールアドレス<input id="rs-email" type="email" value="' + esc(v.email || '') + '"></label>'
        + '<label>ポジション<select id="rs-pos"><option value="">選んでください</option>' + d.positions.map(p => '<option' + (v.position === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select></label>'
        + (d.canSecret ? '<label>生年月日<input id="rs-birth" type="date" value="' + esc(v.birthDate || '') + '"></label>' : '')
        + '<label style="flex-direction:row; align-items:center; gap:6px"><input type="checkbox" id="rs-exec"' + (v.exec ? ' checked' : '') + '>役員</label></div>'
        + '<p class="err" id="rs-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="rs-save">保存</button></div>');
      $('rs-save').onclick = async () => {
        const b = { name: $('rs-name').value.trim(), email: $('rs-email').value.trim(), position: $('rs-pos').value, exec: $('rs-exec').checked };
        if ($('rs-birth')) b.birthDate = $('rs-birth').value;
        try { await apiSend(s ? 'PUT' : 'POST', '/resta-staff' + (s ? '/' + encodeURIComponent(s.id) : ''), b); closeModal(); toast('保存しました'); render(); } catch (e) { $('rs-err').textContent = e.message; $('rs-err').hidden = false; }
      };
    };
    const assign = s => {
      const ms = []; for (let i = -5; i <= 6; i++) ms.push(shiftMonth(CUR_MONTH, i));
      const at = m => { const a = s.assign || {}; if (Array.isArray(a[m])) return a[m]; const k = Object.keys(a).filter(x => x <= m && Array.isArray(a[x])).sort().pop(); return k ? a[k] : []; };
      const now = at(CUR_MONTH)[0] || {};
      wideModal('<h2>担当：' + esc(s.name) + '</h2>'
        + '<div class="table-wrap"><table class="am-table"><thead><tr>' + ms.map(m => '<th class="c-ctr">' + mLabel(m) + '</th>').join('') + '</tr></thead><tbody><tr>' + ms.map(m => '<td class="c-ctr">' + (at(m).map(a => esc(unitL(a.media)) + '<br><span class="note">' + esc(a.position) + '</span>').join('<br>') || '<span class="note">—</span>') + '</td>').join('') + '</tr></tbody></table></div>'
        + '<h3 class="am-h">担当を変える</h3><div class="form-grid">'
        + '<label>変更する月<input id="rsa-from" type="month" value="' + CUR_MONTH + '"></label><label>この月まで同じ（空なら1か月だけ）<input id="rsa-until" type="month"></label>'
        + '<label style="flex-direction:row; align-items:center; gap:6px"><input type="checkbox" id="rsa-on"' + (now.media ? ' checked' : '') + '>' + esc(unitL('__kurashi')) + 'を担当</label>'
        + '<label>ポジション<select id="rsa-pos"><option value="">選んでください</option>' + d.positions.map(p => '<option' + ((now.position || s.position) === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select></label></div>'
        + '<p class="note">担当のメディアは今は Eparkくらしのレスキューだけです（これから細分化する予定）。チェックを外して保存すると、その月は担当なしになります。</p>'
        + '<p class="err" id="rsa-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="rsa-save">保存</button></div>');
      $('rsa-save').onclick = async () => {
        const rows = $('rsa-on').checked ? [{ media: '__kurashi', position: $('rsa-pos').value }] : [];
        if (rows.length && !rows[0].position) { $('rsa-err').textContent = 'ポジションを選んでください'; $('rsa-err').hidden = false; return; }
        try { await apiSend('PUT', '/resta-staff/' + encodeURIComponent(s.id) + '/assign/' + $('rsa-from').value, { rows, until: $('rsa-until').value }); closeModal(); toast('保存しました'); render(); } catch (e) { $('rsa-err').textContent = e.message; $('rsa-err').hidden = false; }
      };
    };
    $('rs-add').onclick = () => edit(null);
    document.querySelectorAll('[data-rse]').forEach(b => b.onclick = () => edit(d.staff[Number(b.dataset.rse)]));
    document.querySelectorAll('[data-rsa]').forEach(b => b.onclick = () => assign(d.staff[Number(b.dataset.rsa)]));
  } };
}

/** 社員本人：マイページ（基本情報だけ。生年月日・給与・賞与・昇給・評価・経歴書類は管理者だけが見られる。2026-10-27 ユーザー指定） */
function viewMyGoals() {
  return { html: '<section class="panel" id="mg-body"><p class="loading">読み込み中…</p></section>', view: 'マイページ', after: async () => {
    if (!MY_STAFF) MY_STAFF = (await api('/staff/me')).staff;
    if (!MY_STAFF) { $('mg-body').innerHTML = '<p class="empty">BEST社員管理に登録されていません。</p>'; return; }
    const s = MY_STAFF, span = []; for (let m = shiftMonth(CUR_MONTH, -5); m <= CUR_MONTH; m = shiftMonth(m, 1)) span.push(m);
    $('mg-body').innerHTML = H('マイページ <small>' + esc(s.name) + '・' + esc(s.empType) + '</small>', ['BEST社員管理'])
      + '<div class="table-wrap"><table class="am-table"><tbody><tr><th class="c-txt">入社日</th><td class="c-txt">' + dateJp(s.joinDate) + '</td><th class="c-txt">入社時のポジション</th><td class="c-txt">' + esc(s.initPosition || '—') + '</td></tr>'
      + '<tr><th class="c-txt">今月の担当</th><td class="c-txt" colspan="3">' + (esc(assignText(s.current)) || '—') + '</td></tr></tbody></table></div>'
      + '<h3 class="am-h">これまでの担当 <span class="note">直近6か月</span></h3><div class="table-wrap"><table class="am-table"><tbody>' + span.slice().reverse().map(m => '<tr><td class="c-txt">' + mLabel(m) + '</td><td class="c-txt">' + (esc(assignText((s.assign || {})[m])) || '<span class="note">—</span>') + '</td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note">月ごとの稼働の%と記事目標は、ダッシュボードの「目標・工数」で入力・申請してください。</p>';
  } };
}

// ================= 目標・稼働工数管理（2026-10-27 ユーザー指定） =================
// 月ごとに、本人が「どのメディアに何%の稼働を使ったか」と記事目標を入力 → 申請 → 管理者が承認／却下。
// 承認された記事目標は記事目標設定に入り、稼働の%は支出の「BEST人件費」の配分に使う。承認済みの内容を直すときは、もう一度申請が必要
const WORK_VIEWS = [{ id: 'wk-month', l: '目標・稼働工数設定' }, { id: 'wk-articles', l: '記事作成進捗', tag: '目標進捗' }, { id: 'wk-metrics', l: '担当メディア数値進捗', tag: '目標進捗' }];   // 2026-10-27 ユーザー指定
/** その月に目標を立てる行（担当メディアの、記事目標設定の入力行） */
const workRows = assign => targetTree().filter(r => { if (!r.editable) return false; const i = r.id.indexOf('|'), m = i < 0 ? r.id : r.id.slice(0, i), sub = i < 0 ? '' : r.id.slice(i + 1); return (assign || []).some(a => a.media === m && (!a.sub || a.sub === sub)); }).map(r => ({ id: r.id, name: mediaLabel(r.id.split('|')[0]) + (r.id.includes('|') ? '：' + r.name : '') }));
/** 半期の選択肢（前・今・次）。いちばん最初は次の半期（今なら 2026/11〜2027/04） */
const wkHalfOpts = () => { const cur = halfOf(CUR_MONTH).start; return [shiftMonth(cur, 6), cur, shiftMonth(cur, -6)]; };
const resKeyOf = a => a.sub ? a.media + '|' + a.sub : a.media;
const resLabel = k => { const i = k.indexOf('|'); return i < 0 ? unitLabel(k) : unitLabel(k.slice(0, i)) + '／' + k.slice(i + 1); };
/** 半期の内容の表（本人の入力・管理者の確認で共通） */
function workHalfHtml(d, mine) {
  const ms = d.months, units = [...new Set(ms.flatMap(m => (d.assign[m] || []).map(resKeyOf)).concat(ms.flatMap(m => Object.keys(d.work[m].resource || {})), d.extraUnits || []))].filter(k => !(d.hiddenUnits || []).includes(k));
  const rows = []; ms.forEach(m => workRows(d.assign[m]).forEach(r => { if (!rows.some(x => x.id === r.id)) rows.push(r); }));
  const st = ms.map(m => d.work[m].status), status = st.includes('submitted') ? 'submitted' : st.includes('rejected') ? 'rejected' : st.some(x => x === 'approved') && !st.includes('draft') ? 'approved' : st.includes('draft') ? 'draft' : 'none';
  const W = WORK_STATUS[status] || WORK_STATUS.none, lockT = !mine || (status === 'submitted' && !d.canApprove);
  const num = (attr, v, dis) => '<input class="tin" type="number" min="0" inputmode="numeric" ' + attr + ' value="' + (v ?? '') + '"' + (dis ? ' disabled' : '') + ' style="width:4.2em">';
  // 保存済みの月は本人は変えられない（管理者は直接変えられる）。修正するときは申請（2026-10-29 ユーザー指定）
  const resLock = m => mine && !d.canApprove && d.work[m].resLocked && !d.reqMode;
  const resVal = m => d.reqMode && d.work[m].resReq && d.work[m].resReq.status === 'pending' && !d.reqEdited ? d.work[m].resReq.resource : (d.work[m].resource || {});
  const resHead = m => { const rq = d.work[m].resReq; return mLabel(m) + (d.work[m].resLocked && !d.canApprove ? ' <span title="保存済み（修正は申請）">🔒</span>' : '') + (rq && rq.status === 'pending' ? '<br><span class="pill wait" title="' + esc('理由：' + rq.note) + '">修正申請中</span>' : rq && rq.status === 'rejected' ? '<br><span class="pill ng" title="' + esc('却下の理由：' + rq.rejectNote) + '">修正却下</span>' : ''); };
  const resRejects = () => { const r = ms.filter(m => (d.work[m].resReq || {}).status === 'rejected'); return r.length ? '<p class="err">稼働工数の修正が却下されました：' + r.map(m => mLabel(m) + '（' + esc(d.work[m].resReq.rejectNote) + '）').join('、') + '</p>' : ''; };
  const resTbl = units.length ? '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">担当</th>' + ms.map(m => '<th class="c-ctr">' + resHead(m) + '</th>').join('') + '</tr></thead><tbody>'
    + units.map(k => '<tr><td class="c-txt" style="white-space:nowrap">' + esc(resLabel(k)) + (mine ? ' <button class="linkbtn" type="button" data-wr-del="' + esc(k) + '" title="この行を消す（保存済みの月は申請のときだけ）">×</button>' : '') + '</td>' + ms.map(m => '<td class="c-ctr">' + num('data-wr="' + m + '" data-k="' + esc(k) + '"', resVal(m)[k], !mine || resLock(m)) + '</td>').join('') + '</tr>').join('')
    + '<tr class="total"><td class="c-txt"><b>合計</b></td>' + ms.map(m => '<td class="c-ctr"><b data-wrt="' + m + '">' + Object.values(resVal(m)).reduce((x, v) => x + (Number(v) || 0), 0) + '%</b></td>').join('') + '</tr></tbody></table></div>'
    : '<p class="empty">項目がまだありません。下の「＋ 項目を追加」から追加できます。</p>';
  const tgTbl = rows.length ? '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt" rowspan="2">担当</th>' + ms.map(m => '<th class="c-ctr" colspan="2">' + mLabel(m) + '</th>').join('') + '</tr><tr>' + ms.map(() => '<th class="c-ctr">新規</th><th class="c-ctr">リライト</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr><td class="c-txt" style="white-space:nowrap">' + esc(r.name) + '</td>' + ms.map(m => { const v = (d.work[m].targets || {})[r.id] || {}, ap = (d.work[m].approvedTargets || {})[r.id], on = (d.assign[m] || []).some(a => a.media === r.id.split('|')[0] && (!a.sub || r.id.endsWith('|' + a.sub)));
      const t = k => (ap && ap[k] != null && ap[k] !== v[k] ? ' title="承認済み：' + ap[k] + '"' : '');
      return '<td class="c-ctr"' + t('new') + '>' + (on ? num('data-wt="' + m + '" data-row="' + esc(r.id) + '" data-k="new"', v.new, lockT) : '') + '</td><td class="c-ctr"' + t('rewrite') + '>' + (on ? num('data-wt="' + m + '" data-row="' + esc(r.id) + '" data-k="rewrite"', v.rewrite, lockT) : '') + '</td>'; }).join('') + '</tr>').join('') + '</tbody></table></div>'
    : '<p class="empty">記事目標を立てる担当（メディア・ディレクトリ）がありません。</p>';
  const kurashi = ms.some(m => (d.assign[m] || []).some(a => [KURASHI, KURASHI_PM, KURASHI_DIR, KURASHI_REWARD, KURASHI_OPS].includes(a.media)));
  const kg = ms.map(m => d.work[m].kurashiGoal).find(Boolean) || '';
  const rejected = ms.map(m => d.work[m].rejectNote).find(Boolean);
  return (d.staff.contractor ? '' : '<h3 class="am-h">稼働工数（%） <span class="note">月ごとに合計100%。はじめての保存はそのまま使われます。' + (d.canApprove ? '管理者は保存済みの月も直接直せます' : '保存した月（🔒）は変更できません。直すときは「修正を申請」から申請し、管理者が承認すると変わります') + '</span></h3>' + (d.reqMode ? '<p class="note" style="color:var(--bad)">修正の申請中です：保存済みの月（🔒）の数字を直して、理由を入れて「修正を申請する」を押してください。</p>' : '') + resRejects() + resTbl
    + (mine ? '<div class="row" style="justify-content:space-between; margin-top:6px; flex-wrap:wrap; gap:6px"><label class="field" style="flex-direction:row; align-items:center; gap:6px">＋ 項目を追加<select id="wk-res-add"><option value="">選んでください</option>' + (() => { const ch = assignChoices().filter(c => !units.includes(resKeyOf(c))), gs = [...new Set(ch.map(c => c.group))]; return gs.map(g => '<optgroup label="' + esc(g) + '">' + ch.filter(c => c.group === g).map(c => '<option value="' + esc(resKeyOf(c)) + '">' + esc(c.label) + '</option>').join('') + '</optgroup>').join(''); })() + '</select></label>' + (d.reqMode ? '<span class="row" style="gap:6px; flex-wrap:wrap"><input id="wk-req-note" placeholder="修正の理由（必須）" style="min-width:16em"><button class="btn" type="button" id="wk-req-cancel">やめる</button><button class="btn primary" type="button" id="wk-req-send">修正を申請する</button></span>' : '<span class="row" style="gap:6px; flex-wrap:wrap">' + (!d.canApprove && ms.some(m => d.work[m].resLocked) ? (ms.some(m => (d.work[m].resReq || {}).status === 'pending') ? '<button class="btn" type="button" id="wk-req-withdraw">修正申請を取り下げる</button>' : '') + '<button class="btn" type="button" id="wk-req-start">修正を申請</button>' : '') + (ms.some(m => !resLock(m)) ? '<button class="btn primary" type="button" id="wk-res-save">稼働工数を保存</button>' : '') + '</span>') + '</div>' : ''))
    + '<h3 class="am-h">記事目標 <span class="pill ' + W[1] + '">' + W[0] + '</span> <span class="note">新規／リライト。申請して管理者が承認すると、記事目標設定に反映されます</span></h3>'
    + (rejected ? '<p class="err">却下の理由：' + esc(rejected) + '</p>' : '') + tgTbl
    + (kurashi ? '<label class="field" style="margin-top:8px; display:flex">' + KURASHI_LABEL + 'の目標（半期・文章）<textarea id="wk-kgoal" rows="2"' + (lockT ? ' disabled' : '') + '>' + esc(kg) + '</textarea></label>' : '');
}
function viewWork() {
  const start = state.wkHalf = state.wkHalf || halfOf(CUR_MONTH).start;   /* はじめは今の半期（2026-11-05 ユーザー指定） */
  return { html: '<section class="panel" id="wk-body"><p class="loading">読み込み中…</p></section>', view: '目標・稼働工数設定', after: async () => {
    await loadArticles();
    const d = await api('/work-half/me/' + start);
    if (!d.staff) { $('wk-body').innerHTML = '<p class="empty">あなたのアカウントは BEST社員管理に登録されていません。</p>'; return; }
    if (isOutUser()) d.staff.contractor = true;   /* 業務委託の役割（UI確認も含む）は記事目標だけ。稼働工数は出さない（2026-11-06 ユーザー指定） */
    const draw = () => {
      $('wk-body').innerHTML = H('目標・稼働工数設定 <small>' + esc(d.staff.name) + '・' + halfLabel(start) + '</small>', ['BEST社員管理'], manualBtn('staff'))
        + '<div class="row" style="gap:8px; margin-bottom:8px"><label class="field">半期<select id="wk-half">' + wkHalfOpts().map(h => '<option value="' + h + '"' + (h === start ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label></div>'
        + workHalfHtml(d, true) + '<p class="err" id="wk-err" hidden></p>'
        + '<div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px"><button class="btn" type="button" id="wk-tg-save">記事目標を下書き保存</button><button class="btn primary" type="button" id="wk-tg-submit">記事目標を申請する</button></div>'
        + '<p class="note">あなたに紐づく内容だけが表示されます。' + (d.staff.contractor ? '担当メディア・ディレクトリは契約管理の内容です。' : '稼働工数は保存した時点で使われます。') + '記事目標は申請中は変更できません。</p>';
      d.redraw = () => draw();
      bindWorkHalf(d, start, $('wk-body'));
      const keepRes = () => { if (d.reqMode) d.reqEdited = true; document.querySelectorAll('#wk-body [data-wr]').forEach(el => { const r = d.work[el.dataset.wr].resource = d.work[el.dataset.wr].resource || {}; if (el.value === '') delete r[el.dataset.k]; else r[el.dataset.k] = Number(el.value); }); };
      if ($('wk-res-add')) $('wk-res-add').onchange = ev => { if (!ev.target.value) return; keepRes(); d.extraUnits = (d.extraUnits || []).concat(ev.target.value); d.hiddenUnits = (d.hiddenUnits || []).filter(k => k !== ev.target.value); draw(); };
      document.querySelectorAll('#wk-body [data-wr-del]').forEach(b2 => b2.onclick = () => { keepRes(); const k = b2.dataset.wrDel; d.months.forEach(m => { if (!d.canApprove && d.work[m].resLocked && !d.reqMode) return; delete (d.work[m].resource || {})[k]; }); if (d.months.every(m => !(k in (d.work[m].resource || {})))) d.hiddenUnits = (d.hiddenUnits || []).concat(k); draw(); });   /* 保存済みの月（🔒）は申請のときだけ消せる */
      $('wk-half').onchange = ev => { state.wkHalf = ev.target.value; render(); };
    };
    draw();
  } };
}
/** 入力の読み取りと保存のボタン */
function bindWorkHalf(d, start, box) {
  const fail = m => { const e = box.querySelector('#wk-err'); if (e) { e.textContent = m; e.hidden = false; } else alert(m); };
  const readRes = () => { const r = {}; d.months.forEach(m => { r[m] = {}; }); box.querySelectorAll('[data-wr]').forEach(el => { if (el.value !== '') r[el.dataset.wr][el.dataset.k] = Number(el.value); }); return r; };
  const readTg = () => { const r = {}; d.months.forEach(m => { r[m] = {}; }); box.querySelectorAll('[data-wt]').forEach(el => { if (el.value === '') return; ((r[el.dataset.wt][el.dataset.row] = r[el.dataset.wt][el.dataset.row] || {}))[el.dataset.k] = Number(el.value); }); return r; };
  // 稼働工数：月ごとに合計100%（何も入れていない月は除く）。100%でない月は合計と入力欄を赤く（2026-10-29 ユーザー指定）
  const resTot = (r, m) => Object.values(r[m] || {}).reduce((x, v) => x + v, 0);
  const resBad = (r, m) => { const t = resTot(r, m); return Object.keys(r[m] || {}).length > 0 && Math.round(t * 100) !== 10000; };
  const markRes = (r, strict) => d.months.forEach(m => {
    const b = box.querySelector('[data-wrt="' + m + '"]'); if (!b) return;
    const t = resTot(r, m), bad = resBad(r, m); b.textContent = t + '%'; b.style.color = bad ? 'var(--bad)' : '';
    const td = b.closest('td'); if (td) td.classList.toggle('wr-bad', bad && strict);
    box.querySelectorAll('[data-wr="' + m + '"]').forEach(x => x.classList.toggle('wr-bad', bad && strict));
  });
  let strict = false;
  box.querySelectorAll('[data-wr]').forEach(el => el.oninput = () => { d.reqEdited = true; const r = readRes(); markRes(r, strict); if (strict && !d.months.some(m => resBad(r, m))) { const e = box.querySelector('#wk-err'); if (e) e.hidden = true; } });
  markRes(readRes(), false);
  const base = '/work-half/' + encodeURIComponent(d.staff.id) + '/' + start;
  const kg = () => { const t = box.querySelector('#wk-kgoal'); return t ? Object.fromEntries(d.months.map(m => [m, t.value])) : undefined; };
  const rs = box.querySelector('#wk-res-save');
  // 修正の申請（保存済みの月）
  const q = id => box.querySelector('#' + id);
  if (q('wk-req-start')) q('wk-req-start').onclick = () => { d.reqMode = true; d.reqEdited = false; if (d.redraw) d.redraw(); };
  if (q('wk-req-cancel')) q('wk-req-cancel').onclick = () => { d.reqMode = false; render(); };   /* 直した数字は捨てて読み直す */
  if (q('wk-req-withdraw')) q('wk-req-withdraw').onclick = async () => { if (!confirm('稼働工数の修正申請を取り下げますか？')) return; try { await apiSend('POST', base + '/res-cancel', {}); toast('取り下げました'); render(); } catch (e) { fail(e.message); } };
  if (q('wk-req-send')) q('wk-req-send').onclick = async () => {
    const r = readRes(), lockedMs = d.months.filter(m => d.work[m].resLocked), bad = lockedMs.filter(m => resBad(r, m));
    strict = true; markRes(r, true);
    if (bad.length) { fail('申請できません。稼働工数は月ごとに合計100%にしてください：' + bad.map(m => mLabel(m) + '（' + resTot(r, m) + '%）').join('、')); return; }
    const note = q('wk-req-note').value.trim(); if (!note) { q('wk-req-note').classList.add('wr-bad'); fail('修正の理由を入力してください'); return; }
    try { const x = await apiSend('POST', base + '/res-request', { resource: Object.fromEntries(lockedMs.map(m => [m, r[m]])), note }); d.reqMode = false; toast((x.months || []).map(mLabel).join('・') + ' の修正を申請しました（管理者が承認すると変わります）'); render(); } catch (e) { fail(e.message); }
  };
  if (rs) rs.onclick = async () => {
    const r = readRes(), bad = d.months.filter(m => resBad(r, m));
    strict = true; markRes(r, true);
    if (bad.length) { fail('保存できません。稼働工数は月ごとに合計100%にしてください：' + bad.map(m => mLabel(m) + '（' + resTot(r, m) + '%）').join('、')); const x = box.querySelector('.wr-bad'); if (x) x.scrollIntoView({ block: 'nearest', inline: 'center' }); return; }
    const send = d.canApprove ? r : Object.fromEntries(d.months.filter(m => !d.work[m].resLocked).map(m => [m, r[m]]));   /* 保存済みの月は送らない */
    try { await apiSend('PUT', base, { resource: send }); toast('保存されました'); render(); } catch (e) { fail(e.message); }
  };
  const ts = box.querySelector('#wk-tg-save'), tb = box.querySelector('#wk-tg-submit');
  if (ts) ts.onclick = async () => { try { await apiSend('PUT', base, { targets: readTg(), kurashiGoal: kg(), action: 'save' }); toast('保存されました'); render(); } catch (e) { fail(e.message); } };
  if (tb) tb.onclick = async () => { if (!confirm('この半期の記事目標を申請します。管理者が承認すると記事目標設定に反映されます。よろしいですか？')) return; try { await apiSend('PUT', base, { targets: readTg(), kurashiGoal: kg(), action: 'submit' }); toast('申請されました'); render(); } catch (e) { fail(e.message); } };
}
/** 管理者：稼働工数の修正申請を確認して承認・却下（今の% → 申請の%）（2026-10-29 ユーザー指定） */
async function resApproveModal(id, start) {
  const d = await api('/work-half/' + encodeURIComponent(id) + '/' + start);
  const ms = d.months.filter(m => (d.work[m].resReq || {}).status === 'pending');
  const keys = [...new Set(ms.flatMap(m => Object.keys(d.work[m].resource || {}).concat(Object.keys(d.work[m].resReq.resource || {}))))];
  const cell = (a, b) => a === b ? '<span class="note">' + (a ?? '—') + '</span>' : '<s class="note">' + (a ?? '—') + '</s> → <b style="color:var(--bad)">' + (b ?? '—') + '</b>';
  wideModal('<h2>稼働工数の修正申請：' + esc(d.staff.name) + ' <small class="note">' + halfLabel(start) + '</small></h2>'
    + ms.map(m => '<p class="note">' + mLabel(m) + '：理由「' + esc(d.work[m].resReq.note) + '」（' + esc(d.work[m].resReq.by) + '）</p>').join('')
    + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">担当</th>' + ms.map(m => '<th class="c-ctr">' + mLabel(m) + '<br><span class="note">今 → 申請</span></th>').join('') + '</tr></thead><tbody>'
    + keys.map(k => '<tr><td class="c-txt" style="white-space:nowrap">' + esc(resLabel(k)) + '</td>' + ms.map(m => '<td class="c-ctr">' + cell((d.work[m].resource || {})[k], (d.work[m].resReq.resource || {})[k]) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table></div><p class="note">承認すると、その月の稼働工数が申請の内容に変わり、BEST人件費のメディアの配分も変わります。</p>'
    + '<p class="err" id="ra-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; flex-wrap:wrap"><button class="btn" type="button" data-close>閉じる</button><input id="ra-note" placeholder="却下の理由" style="min-width:14em"><button class="btn" type="button" id="ra-reject">却下する</button><button class="btn primary" type="button" id="ra-approve">承認する</button></div>');
  const base = '/work-half/' + encodeURIComponent(id) + '/' + start, fail = m => { $('ra-err').textContent = m; $('ra-err').hidden = false; };
  $('ra-approve').onclick = async () => { try { await apiSend('POST', base + '/res-approve', {}); closeModal(); toast('承認しました'); render(); } catch (e) { fail(e.message); } };
  $('ra-reject').onclick = async () => { const note = $('ra-note').value.trim(); if (!note) return fail('却下の理由を入力してください'); try { await apiSend('POST', base + '/res-reject', { note }); closeModal(); toast('却下しました'); render(); } catch (e) { fail(e.message); } };
}
/** 管理者：申請された記事目標を確認して承認・却下 */
async function workApproveModal(id, start) {
  await loadArticles();
  const d = await api('/work-half/' + encodeURIComponent(id) + '/' + start);
  wideModal('<h2>記事目標の承認：' + esc(d.staff.name) + ' <small class="note">' + halfLabel(start) + '</small></h2>' + workHalfHtml(d, false)
    + '<p class="err" id="wa-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; flex-wrap:wrap"><button class="btn" type="button" data-close>閉じる</button><input id="wa-note" placeholder="却下の理由" style="min-width:14em"><button class="btn" type="button" id="wa-reject">却下する</button><button class="btn primary" type="button" id="wa-approve">承認する</button></div>');
  const base = '/work-half/' + encodeURIComponent(id) + '/' + start, fail = m => { $('wa-err').textContent = m; $('wa-err').hidden = false; };
  $('wa-approve').onclick = async () => { try { await apiSend('POST', base + '/approve', {}); ARTICLES = null; closeModal(); toast('承認しました'); render(); } catch (e) { fail(e.message); } };
  $('wa-reject').onclick = async () => { const note = $('wa-note').value.trim(); if (!note) return fail('却下の理由を入力してください'); try { await apiSend('POST', base + '/reject', { note }); closeModal(); toast('却下しました'); render(); } catch (e) { fail(e.message); } };
}

// ===== 目標進捗（2026-10-27 ユーザー指定） =====
/** 記事作成進捗：自分の担当の、承認された記事目標と実績（進行管理の本数） */
function viewWorkArticles() {
  const start = state.wkpHalf = state.wkpHalf || halfOf(CUR_MONTH).start;
  return { html: '<section class="panel" id="wka-body"><p class="loading">読み込み中…</p></section>', view: '記事作成進捗', after: async () => {
    await loadArticles();
    const d = await api('/work-half/me/' + start);
    if (!d.staff) { $('wka-body').innerHTML = '<p class="empty">あなたのアカウントは BEST社員管理に登録されていません。</p>'; return; }
    const ms = d.months, rows = []; ms.forEach(m => workRows(d.assign[m]).forEach(r => { if (!rows.some(x => x.id === r.id)) rows.push(r); }));
    const tg = (m, id, k) => (((d.work[m].approvedTargets || {})[id]) || {})[k];
    const cell = (m, id, k) => { const t = tg(m, id, k), a = m <= CUR_MONTH ? actualOf(id, m, k) : null; if (t == null && a == null) return '<td class="c-ctr note">—</td>'; const r = t ? (a || 0) / t : null; return '<td class="c-ctr" style="background:' + rateColor(m < CUR_MONTH || r == null ? r : null) + '">' + (a ?? '—') + ' / ' + (t ?? '—') + '</td>'; };
    const sum = (id, k, f) => ms.reduce((x, m) => { const v = f(m, id, k); return v == null ? x : (x || 0) + v; }, null);
    $('wka-body').innerHTML = H('記事作成進捗 <small>' + esc(d.staff.name) + '・' + halfLabel(start) + '</small>', ['進行管理'])
      + '<div class="row" style="gap:8px; margin-bottom:8px"><label class="field">半期<select id="wka-half">' + wkHalfOpts().slice().reverse().map(h => '<option value="' + h + '"' + (h === start ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label></div>'
      + (rows.length ? '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt" rowspan="2">担当</th><th class="c-ctr" rowspan="2">種類</th>' + ms.map(m => '<th class="c-ctr">' + mLabel(m) + '</th>').join('') + '<th class="c-ctr">半期合計</th></tr><tr>' + ms.map(() => '<th class="c-ctr note">実績 / 目標</th>').join('') + '<th class="c-ctr note">実績 / 目標</th></tr></thead><tbody>'
        + rows.map(r => [['new', '新規'], ['rewrite', 'リライト']].map(([k, l], i) => '<tr>' + (i ? '' : '<td class="c-txt" rowspan="2" style="white-space:nowrap">' + esc(r.name) + '</td>') + '<td class="c-ctr">' + l + '</td>' + ms.map(m => cell(m, r.id, k)).join('') + '<td class="c-ctr"><b>' + (sum(r.id, k, (m, id, kk) => m <= CUR_MONTH ? actualOf(id, m, kk) : null) ?? '—') + ' / ' + (sum(r.id, k, tg) ?? '—') + '</b></td></tr>').join('')).join('') + '</tbody></table></div>'
        : '<p class="empty">この半期の担当（メディア・ディレクトリ）がありません。</p>')
      + '<p class="note">目標は、あなたが申請して承認された記事目標です。実績は進行管理のアップロード日で数えた本数（担当ディレクトリ単位）。色は終わった月の達成率（緑＝達成、黄＝8割以上、赤＝8割未満）。</p>';
    $('wka-half').onchange = ev => { state.wkpHalf = ev.target.value; render(); };
  } };
}
/** 担当メディア数値進捗：担当メディア・カテゴリの数値（実績）。目標はこのあと作るプランニングと紐づける（今は仮） */
const WK_METRICS = [['pv', 'PV'], ['sessions', 'セッション'], ['users', 'ユーザー'], ['cv', 'CV（キーイベント）'], ['pos', '平均掲載順位'], ['kCalls', 'コール数'], ['visits', '訪問確定数'], ['contracts', '成約数'], ['revenue', '収益合計'], ['cost', '支出合計'], ['profit', '収支合計']];
function viewWorkMetrics() {
  /* 担当メディア数値進捗（2026-11-06 ユーザー指定：目標をシミュレーションの数字と紐づけ、月ごとの達成率をシミュレーション比較と同じ色で、半期合計の進捗をいちばん上に）
     目標＝保存したシミュレーション結果（BigQuery sim_predictions の理想。その月より前で一番新しい予測）。今月は昨日までの日数で日割り。
     ディレクトリ（カテゴリ）は予測がメディア単位なので、メディアの予測 × そのディレクトリの割合（直近3か月の実績）。支出・平均掲載順位は少ないほうがよいので 目標÷実績 */
  const start = state.wkpHalf = state.wkpHalf || halfOf(CUR_MONTH).start;
  return { html: '<div id="wkm-body"><section class="panel"><p class="loading">読み込み中…</p></section></div>', view: '担当メディア数値進捗', after: async () => {
    const seq = renderSeq;
    const [d] = await Promise.all([api('/work-half/me/' + start), SIM_PRED ? null : api('/sim/predictions').then(r => { SIM_PRED = r.rows || []; }).catch(() => { SIM_PRED = []; })]);
    if (seq !== renderSeq || !$('wkm-body')) return;
    if (!d.staff) { $('wkm-body').innerHTML = '<section class="panel"><p class="empty">あなたのアカウントは BEST社員管理に登録されていません。</p></section>'; return; }
    /* メディア数値の権限がない（または担当メディアが見られる範囲にない）社員にも、担当メディアの実績を読む（2026-11-06） */
    const need = [...new Set(d.months.flatMap(m => (d.assign[m] || []).filter(a => !NON_MEDIA_UNITS.includes(a.media)).map(a => a.media)))].filter(m => !(MONTHLY && MONTHLY[m]));
    if (need.length) { try { const mine = await api('/monthly/mine/' + start); MONTHLY = MONTHLY || {}; Object.entries(mine).forEach(([k, v]) => { if (!MONTHLY[k]) MONTHLY[k] = v; }); } catch (e) { /* 読めなければ今までどおり */ } try { const pr = (await api('/sim/predictions/mine/' + start)).rows || [], have = new Set((SIM_PRED || []).map(r => r.media)); SIM_PRED = (SIM_PRED || []).concat(pr.filter(r => !have.has(r.media))); } catch (e) { /* 目標なしのまま */ } if (seq !== renderSeq || !$('wkm-body')) return; }
    const ms = d.months, curDim = new Date(Date.UTC(Number(CUR_MONTH.slice(0, 4)), Number(CUR_MONTH.slice(5)), 0)).getUTCDate(), curFrac = Math.max(1, Number(todayJst().slice(8, 10)) - 1) / curDim;
    const keys = [...new Set(ms.flatMap(m => (d.assign[m] || []).filter(a => !NON_MEDIA_UNITS.includes(a.media)).map(resKeyOf)))];
    const idOf = k => MONTHLY && MONTHLY[k] ? k : k.split('|')[0];   // カテゴリの数値がなければメディアの数値
    const LB = ['cost', 'pos'], NOSUM = ['pos'];
    const ratio = (k, act, tgt) => act == null || tgt == null ? null : LB.includes(k) ? (act > 0 ? tgt / act : null) : (k === 'profit' ? (tgt > 0 ? act / tgt : null) : (tgt > 0 ? act / tgt : null));
    const cls = r => r == null ? '' : r >= 1 ? 'good' : r >= 0.8 ? 'mid' : 'bad', pct = r => r == null ? '—' : (r * 100).toFixed(1) + '%';
    const last3 = [1, 2, 3].map(i => shiftMonth(CUR_MONTH, -i));
    /* 1つの担当（メディア or カテゴリ）の、月ごとの目標と実績 */
    const plan = k => {
      const id = idOf(k), media = k.split('|')[0], mid = topIds().find(x => simKey(x) === media || x === media) || media, isDir = k.includes('|');
      /* 指標ごとに、カテゴリの数字があればカテゴリ、なければメディア全体（2026-11-06 ユーザー指摘：水まわり／洗面台は記事数・支出しかなく、PVなどが — と目標0になっていた）。収支は収益と支出の両方がカテゴリにあるときだけカテゴリ */
      const last6 = [1, 2, 3, 4, 5, 6].map(i => shiftMonth(CUR_MONTH, -i)), has = mk => last6.some(m => monthVal(id, m)[mk] != null);
      const srcOf = mk => !isDir || id === media ? id : (mk === 'profit' ? (has('revenue') && has('cost')) : has(mk)) ? id : mid;
      const share = mk => { if (srcOf(mk) !== id || !isDir || id === media || NOSUM.includes(mk)) return 1; const a = last3.reduce((s, m) => s + (Number(monthVal(id, m)[mk]) || 0), 0), b = last3.reduce((s, m) => s + (Number(monthVal(mid, m)[mk]) || 0), 0); return b > 0 ? a / b : null; };
      const sh = Object.fromEntries(WK_METRICS.map(([mk]) => [mk, share(mk)]));
      /* 訪問確定数はシミュレーションで予測していないので、目標＝コール数の目標 × 直近12か月の訪問率（訪問確定÷コール）（2026-11-12 ユーザー指定） */
      const vRate = (() => { const s = srcOf('kCalls'); let c = 0, v = 0; [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].forEach(i => { const x = monthVal(s, shiftMonth(CUR_MONTH, -i)); if (x.kCalls != null && x.visits != null) { c += Number(x.kCalls) || 0; v += Number(x.visits) || 0; } }); return c > 0 ? v / c : null; })();
      const tgt = (m, mk, frac) => { if (mk === 'visits') { const c = tgt(m, 'kCalls', frac); return c == null || vRate == null ? null : c * vRate; } const p = scPred(new Set([simKey(mid)]), m, frac); if (!p) return null; const v = mk === 'cv' ? p.cv : p[mk]; if (v == null || sh[mk] == null) return null; return NOSUM.includes(mk) ? v : v * sh[mk]; };
      const rows = WK_METRICS.map(([mk, l]) => {
        const cells = ms.map(m => { const fut = m > CUR_MONTH, frac = m === CUR_MONTH ? curFrac : 1, t = tgt(m, mk, frac), a = fut ? null : monthVal(srcOf(mk), m)[mk], costOk = !['cost', 'profit'].includes(mk) || (unitCostReady(m) && isAdmin()); return { m, a, t, tFull: tgt(m, mk, 1), r: fut || !costOk ? null : ratio(mk, a, t), fut, costOk }; });   /* 支出・収支は、確定した月（翌月5日すぎ）で、人件費まで見える管理者だけ達成率を出す（2026-11-06：今月の支出は途中・社員の画面の支出は人件費を含まないため 4837% のような値になった） */
        const doneC = cells.filter(c => !c.fut), sum = arr => arr.reduce((x, v) => v == null ? x : (x || 0) + v, null);
        const okC = doneC.filter(c => c.costOk), aSum = NOSUM.includes(mk) ? null : sum(okC.map(c => c.a)), tSum = NOSUM.includes(mk) ? null : sum(okC.map(c => c.t)), tHalf = NOSUM.includes(mk) ? null : sum(cells.map(c => c.tFull));
        return { mk, l: l + (isDir && srcOf(mk) !== id ? ' <span class="note">（メディア全体）</span>' : ''), cells, aSum, tSum, tHalf, r: ratio(mk, aSum, tSum) };
      });
      return { id, media, isDir, rows, fellBack: id !== k, hasPred: rows.some(r => r.cells.some(c => c.t != null)) };
    };
    const P = keys.map(k => ({ k, ...plan(k) }));
    /* いちばん上：半期の進捗（担当全体の合計。今日までの実績 ÷ 今日までの目標） */
    const TOP = [['pv', 'PV'], ['cv', 'CV（キーイベント）'], ['kCalls', 'コール数'], ['contracts', '成約数']].concat(noMoney() ? [] : [['revenue', '収益合計'], ['cost', '支出合計'], ['profit', '収支合計']]);
    const agg = mk => { let a = null, t = null, h = null; P.forEach(p => { const r = p.rows.find(x => x.mk === mk); if (!r) return; if (r.aSum != null) a = (a || 0) + r.aSum; if (r.tSum != null) t = (t || 0) + r.tSum; if (r.tHalf != null) h = (h || 0) + r.tHalf; }); return { a, t, h, r: ratio(mk, a, t) }; };
    const topCards = '<h3 class="am-h sum-h">半期の進捗 <span class="note">' + halfLabel(start) + '・今日まで（今月は昨日までの日割り）の実績 ÷ 目標（シミュレーション）</span></h3><section class="kpis wide" style="grid-template-columns:repeat(' + TOP.length + ', minmax(0,1fr))">'
      + TOP.map(([mk, l]) => { const g = agg(mk), money = ['revenue', 'cost', 'profit'].includes(mk);
        return '<div class="kpi"><div class="lbl"><span>' + l + 'の達成率</span></div><div class="val pm-pct ' + cls(g.r) + '" style="font-size:26px">' + pct(g.r) + '</div>'
          + '<div class="progress pm-bar" style="margin:4px 0"><span class="' + cls(g.r) + '" style="width:' + Math.min(g.r || 0, 1) * 100 + '%"></span></div>'
          + '<div class="note">実績 ' + fmt(mk, g.a) + '／' + (money ? '想定 ' : '目標 ') + (mk === 'profit' && g.t != null ? '<b class="' + pmCls(g.t) + '">' + fmt(mk, g.t) + '</b>' : fmt(mk, g.t)) + '<br>半期の' + (money ? '想定' : '目標') + ' ' + fmt(mk, g.h) + '</div></div>'; }).join('') + '</section>';
    /* 月ごと：実績・目標・達成率（色はシミュレーション比較と同じ：緑＝100%以上・黄＝80%以上・赤＝80%未満） */
    const cell = (mk, c) => c.fut ? '<td class="c-num"><span class="note">目標 ' + fmt(mk, c.tFull) + '</span></td>'
      : '<td class="c-num"><div>' + fmt(mk, c.a) + '</div>' + (c.t == null ? '<div class="note">目標なし</div>' : '<div class="note">目標 ' + (mk === 'profit' ? '<span class="' + pmCls(c.t) + '">' + fmt(mk, c.t) + '</span>' : fmt(mk, c.t)) + '</div><div class="pm-pct ' + cls(c.r) + '" style="font-size:12px">' + pct(c.r) + '</div>') + '</td>';
    const tbl = p => '<div class="table-wrap am-scroll"><table class="am-table fx-table"><colgroup><col style="width:170px">' + ms.map(() => '<col style="width:128px">').join('') + '<col style="width:140px"><col style="width:140px"><col style="width:96px"></colgroup>'
      + '<thead><tr><th class="c-txt">指標</th>' + ms.map(m => '<th class="c-num">' + mLabel(m) + (m === CUR_MONTH ? '<br><span class="note">（日割り）</span>' : '') + '</th>').join('') + '<th class="c-num">半期合計<br><span class="note">今日まで</span></th><th class="c-num">目標<br><span class="note">今日まで／半期</span></th><th class="c-num">達成率</th></tr></thead><tbody>'
      + p.rows.filter(r => !(noMoney() && ['revenue', 'cost', 'profit'].includes(r.mk))).map(r => '<tr><td class="c-txt">' + r.l + '</td>' + r.cells.map(c => cell(r.mk, c)).join('')
        + '<td class="c-num"><b>' + (NOSUM.includes(r.mk) ? '—' : fmt(r.mk, r.aSum)) + '</b></td><td class="c-num">' + (NOSUM.includes(r.mk) ? '—' : fmt(r.mk, r.tSum) + '<div class="note">' + fmt(r.mk, r.tHalf) + '</div>') + '</td><td class="c-num"><b class="pm-pct ' + cls(r.r) + '">' + pct(r.r) + '</b></td></tr>').join('') + '</tbody></table></div>';
    $('wkm-body').innerHTML = '<section class="panel">' + H('担当メディア数値進捗 <small>' + esc(d.staff.name) + '・' + halfLabel(start) + '</small>', ['GA4', 'SC', 'kintone', '支出'])
      + '<div class="row" style="gap:8px"><label class="field">半期<select id="wkm-half">' + wkHalfOpts().slice().reverse().map(h => '<option value="' + h + '"' + (h === start ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label>'
      + '<span class="note">目標＝シミュレーション結果（毎月保存している予測）。今月は昨日までの日数で日割り。支出・平均掲載順位は少ないほうがよいので 目標÷実績。訪問確定数の目標＝コール数の目標 × 直近12か月の訪問率（訪問確定÷コール）。支出・収支の達成率は、月が確定してから（翌月5日すぎ）出します。社員の画面の支出には人件費が入らないため、支出・収支の達成率は管理者の画面だけです。</span></div></section>'
      + (keys.length ? topCards + P.map(p => '<section class="panel">' + H(esc(resLabel(p.k)) + (p.fellBack ? ' <small>（カテゴリの数値がないため、メディア全体の数値）</small>' : p.isDir ? ' <small>（カテゴリの数字がある指標は、目標＝メディアのシミュレーション × このカテゴリの割合（直近3か月の実績）。カテゴリの数字がない指標は「メディア全体」の実績と目標）</small>' : '')) + (p.hasPred ? '' : '<p class="note">このメディアはまだシミュレーションの予測を保存していません（シミュレーションの画面を開いた月から保存します）。</p>') + tbl(p) + '</section>').join('')
        : '<section class="panel"><p class="empty">この半期の担当メディアがありません。</p></section>');
    $('wkm-half').onchange = ev => { state.wkpHalf = ev.target.value; render(); };
  } };
}
function workCard(x, i, d) {
  const w = x.work, st = WORK_STATUS[w.status] || WORK_STATUS.none, cur = w.draft || w.approved || { resource: {}, targets: {} }, ap = w.approved;
  const editable = (x.self && w.status !== 'submitted') || d.canManage;
  const resKey = a => a.sub ? a.media + '|' + a.sub : a.media, keyLabel = k => { const i = k.indexOf('|'); return i < 0 ? unitLabel(k) : unitLabel(k.slice(0, i)) + '／' + k.slice(i + 1); };
  const medias = [...new Set(x.assign.map(resKey).concat(Object.keys(cur.resource || {})))];   // ディレクトリごと（2026-10-27 ユーザー指定）
  const rows = workRows(x.assign);
  const inp = (attr, v) => '<input class="tin" type="number" min="0" inputmode="numeric" ' + attr + ' value="' + (v ?? '') + '"' + (editable ? '' : ' disabled') + ' style="width:5em">';
  const diff = (a, b) => ap && JSON.stringify(a ?? null) !== JSON.stringify(b ?? null) ? ' style="background:var(--warn-soft)"' : '';
  return '<div class="panel" style="margin:8px 0; padding:10px" data-wk="' + i + '"><div class="row" style="gap:8px; flex-wrap:wrap; align-items:center"><b>' + esc(x.name) + '</b><span class="note">' + esc(x.empType) + '</span><span class="pill ' + st[1] + '">' + st[0] + '</span>'
    + (ap && w.status !== 'approved' ? '<span class="note">（承認済みの内容あり。変更は承認後に反映）</span>' : '') + (w.rejectNote ? '<span class="err">却下の理由：' + esc(w.rejectNote) + '</span>' : '') + (w.approvedAt ? '<span class="note">承認：' + dateJp(w.approvedAt.slice(0, 10)) + '</span>' : '') + '</div>'
    + '<div class="note">担当：' + (esc(assignText(x.assign)) || '未設定（BEST社員管理の「担当」で登録）') + '</div>'
    + '<h3 class="am-h">稼働工数（%） <span class="note">BEST MEDIA のメディア・プレスリリース・Eparkくらしのレスキューの合計で100%</span></h3>' + (medias.length ? '<div class="row" style="gap:10px; flex-wrap:wrap; align-items:flex-end">' + medias.map(m => '<label class="field"' + diff((cur.resource || {})[m], ((ap && ap.resource) || {})[m]) + '>' + esc(keyLabel(m)) + inp('data-res="' + esc(m) + '"', (cur.resource || {})[m]) + '</label>').join('') + '<b class="num" data-restot>合計 ' + Object.values(cur.resource || {}).reduce((a, v) => a + v, 0) + '%</b></div>' : '<p class="empty">担当メディアがありません。</p>')
    + '<h3 class="am-h">記事目標 <span class="note">新規／リライト</span></h3>' + (rows.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">担当</th><th class="c-ctr">新規</th><th class="c-ctr">リライト</th>' + (ap ? '<th class="c-txt">承認済み</th>' : '') + '</tr></thead><tbody>'
      + rows.map(r => { const v = (cur.targets || {})[r.id] || {}, a = ((ap && ap.targets) || {})[r.id]; return '<tr' + diff(v.new != null || v.rewrite != null ? v : undefined, a) + '><td class="c-txt">' + esc(r.name) + '</td><td class="c-ctr">' + inp('data-tg="' + esc(r.id) + '" data-k="new"', v.new) + '</td><td class="c-ctr">' + inp('data-tg="' + esc(r.id) + '" data-k="rewrite"', v.rewrite) + '</td>' + (ap ? '<td class="c-txt note">' + (a ? '新規 ' + (a.new ?? '—') + '・リライト ' + (a.rewrite ?? '—') : '—') + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>' : '<p class="empty">目標を立てる行がありません。</p>')
    + (x.assign.some(a => [KURASHI, KURASHI_PM, KURASHI_DIR, KURASHI_REWARD, KURASHI_OPS].includes(a.media)) || cur.kurashiGoal ? '<h3 class="am-h">' + KURASHI_LABEL + 'の目標 <span class="note">まだダッシュボードがないので文章で入れます</span></h3><textarea data-kgoal rows="3" style="width:100%"' + (editable ? '' : ' disabled') + '>' + esc(cur.kurashiGoal || '') + '</textarea>' + (ap && ap.kurashiGoal && ap.kurashiGoal !== cur.kurashiGoal ? '<p class="note">承認済み：' + esc(ap.kurashiGoal) + '</p>' : '') : '')
    + '<label class="field" style="margin-top:6px; display:flex">メモ<input data-wnote value="' + esc(w.note || '') + '"' + (editable ? '' : ' disabled') + '></label><p class="err" data-werr hidden></p>'
    + '<div class="row" style="justify-content:flex-end; gap:6px; flex-wrap:wrap">'
    + (editable ? '<button class="btn" type="button" data-wsave>下書き保存</button><button class="btn' + (w.status === 'submitted' ? '' : ' primary') + '" type="button" data-wsubmit>' + (w.status === 'submitted' ? '内容を直して申請し直す' : '申請する') + '</button>' : '<span class="note">申請中のため変更できません</span>')
    + (d.canApprove && w.status === 'submitted' ? '<input data-wrej-note placeholder="却下の理由" style="min-width:12em"><button class="btn" type="button" data-wreject>却下する</button><button class="btn primary" type="button" data-wapprove>承認する</button>' : '') + '</div></div>';
}
function bindWorkCard(x, i, d, ym) {
  const box = document.querySelector('[data-wk="' + i + '"]'); if (!box) return;
  const q = s => box.querySelector(s), fail = m => { const e = q('[data-werr]'); e.textContent = m; e.hidden = false; };
  const read = () => {
    const resource = {}, targets = {};
    box.querySelectorAll('[data-res]').forEach(el => { if (el.value !== '') resource[el.dataset.res] = Number(el.value); });
    box.querySelectorAll('[data-tg]').forEach(el => { if (el.value === '') return; (targets[el.dataset.tg] = targets[el.dataset.tg] || {})[el.dataset.k] = Number(el.value); });
    return { resource, targets, kurashiGoal: q('[data-kgoal]') ? q('[data-kgoal]').value : '', note: q('[data-wnote]').value };
  };
  box.querySelectorAll('[data-res]').forEach(el => el.oninput = () => { const t = Object.values(read().resource).reduce((a, v) => a + v, 0); const b = q('[data-restot]'); b.textContent = '合計 ' + t + '%'; b.style.color = t === 100 ? '' : 'var(--bad)'; });
  const base = '/work/' + encodeURIComponent(x.id) + '/' + ym;
  const send = action => async () => { try { await apiSend('PUT', base, Object.assign(read(), { action })); render(); toast(action === 'submit' ? '申請されました' : '保存されました'); } catch (e) { fail(e.message); } };
  if (q('[data-wsave]')) q('[data-wsave]').onclick = send('save');
  if (q('[data-wsubmit]')) q('[data-wsubmit]').onclick = () => { if (confirm('この内容で申請します。管理者が承認すると、記事目標設定と人件費の配分に反映されます。よろしいですか？')) send('submit')(); };
  if (q('[data-wapprove]')) q('[data-wapprove]').onclick = async () => {
    if (!confirm(x.name + ' さんの ' + mLabel(ym) + ' の目標・稼働工数を承認します。よろしいですか？')) return;
    try { await apiSend('POST', base + '/approve', {}); ARTICLES = null; TEDIT = null; render(); } catch (e) { fail(e.message); }
  };
  if (q('[data-wreject]')) q('[data-wreject]').onclick = async () => {
    const note = q('[data-wrej-note]').value.trim(); if (!note) return fail('却下の理由を入力してください');
    try { await apiSend('POST', base + '/reject', { note }); render(); } catch (e) { fail(e.message); }
  };
}
/** 画面右上：社員として登録されている人に「マイページ」ボタン */
async function setupMyGoals() {
  try {
    MY_STAFF = (await api('/staff/me')).staff;
    renderNav();
    const chip = document.querySelector('.user-chip'); if (!chip || !MY_STAFF || MY_STAFF.contractor || $('my-goals')) return;
    const b = document.createElement('button'); b.className = 'linkbtn'; b.id = 'my-goals'; b.type = 'button'; b.textContent = 'マイページ';
    b.onclick = () => { state.view = 'mygoals'; render(); };
    chip.insertBefore(b, $('logout'));
  } catch (e) { /* 社員でない人は何も出さない */ }
}

// ================= メディア担当管理（2026-10-27 ユーザー指定） =================
// メディア・ディレクトリ（と BEST MEDIA 以外の担当）ごとに担当者（BEST社員とポジション）を決める。
// 上に今の担当者の関係図、下に半期（6か月）の表。メディア担当は基本的に変わらないので、ここで変えない限り同じ担当が続く
const UA_POS_ORDER = ['部長', 'PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント', 'アシスタント兼ライター', 'アシスタント候補', 'サポート', '監修・記事サポート', 'ライター', '監修者'];   // 業務委託のポジションも（2026-10-27）
const uaHalfList = () => { const out = []; for (let h = shiftMonth(halfOf(CUR_MONTH).start, 6); h >= ASSIGN_FIRST_HALF; h = shiftMonth(h, -6)) out.push(h); return out; };
const uaSame = (x, c) => x.media === c.media && (x.sub || '') === (c.sub || '');
/** 絞り込み：all／g:グループ／m:メディア */
const uaFilter = (choices, f) => !f || f === 'all' ? choices : f.startsWith('g:') ? choices.filter(c => c.group === f.slice(2)) : choices.filter(c => c.media === f.slice(2));
function uaWho(d, m, c) { return d.staff.flatMap(st => ((st.byMonth[m] || {}).assign || []).filter(x => uaSame(x, c)).map(x => ({ st, position: x.position }))); }
/** 今の担当者の関係図（グループの PM を上に、その下にメディアごとの箱。箱の中はポジションの順） */
/** 関係図に出す人：その月の担当と、この先の予定（退職・契約終了／担当変更） */
/** その月に休職中なら期間の文字（例：休職 2026/08/01〜2026/12/31）。なければ空 */
const uaLeave = (st, m) => { const l = st.leave; if (!l || !l.start || l.start.slice(0, 7) > m || (l.end && l.end.slice(0, 7) < m)) return ''; return '休職 ' + l.start.replace(/-/g, '/') + '〜' + (l.end ? l.end.replace(/-/g, '/') : ''); };
function uaChartWho(d, c) { const k = x => x.media + '|' + (x.sub || '') + '|' + x.position;
  return d.staff.flatMap(st => (st.chart ? st.chart.assign : []).filter(x => uaSame(x, c)).map(x => { const ch = st.chart, e = ch.end, cg = (ch.changes || {})[k(x)];
    return { st, position: x.position, leave: uaLeave(st, d.at), mark: e ? (e.ym ? mLabel(e.ym) + ' ' : '') + e.label : cg ? mLabel(cg) + ' 担当変更' : '' }; })); }
function uaChart(d, m, choices) {
  const node = (name, note, ext, mark, leave) => '<div class="ua-node' + (mark ? ' gone' : leave ? ' leave' : ext ? ' ext' : '') + '">' + esc(name) + (note ? '<small>' + esc(note) + '</small>' : '') + (leave ? '<small class="ua-mark">' + esc(leave) + '</small>' : '') + (mark ? '<small class="ua-mark">' + esc(mark) + '</small>' : '') + '</div>';
  const levels = list => { const byPos = {}; list.forEach(x => (byPos[x.position] = byPos[x.position] || []).push(x)); const ps = Object.keys(byPos).sort((p1, p2) => (UA_POS_ORDER.indexOf(p1) + 99) % 99 - (UA_POS_ORDER.indexOf(p2) + 99) % 99);
    return ps.map((pos, i) => (i ? '<div class="ua-vline"></div>' : '') + '<div class="ua-level"><span class="ua-pos">' + esc(pos) + '</span><div class="ua-nodes">' + byPos[pos].map(x => node(x.name, x.note, x.ext, x.mark, x.leave)).join('') + '</div></div>').join(''); };
  const groups = [...new Set(choices.map(c => c.group))];
  return groups.map(g => {
    const cs = choices.filter(c => c.group === g), top = cs.filter(c => [BM_PM, KURASHI_PM, KURASHI_DIR].includes(c.media)), rest = cs.filter(c => !top.includes(c));
    const colOf = c => uaChartWho(d, c).map(x => ({ name: x.st.name, position: c.media === KURASHI_DIR ? 'ディレクション・採用サポート' : x.position, ext: x.st.contractor, mark: x.mark, leave: x.leave }));
    const cols = top.map(c => ({ c, people: colOf(c) })).filter(x => x.people.length || x.c.media !== KURASHI_DIR), topPeople = cols.flatMap(x => x.people);
    const boxes = [...new Set(rest.map(c => c.media))].map(md => { const sub = rest.filter(c => c.media === md), people = [];
      sub.forEach(c => uaChartWho(d, c).forEach(x => { const k = x.st.id + x.position + x.mark + x.leave, o = people.find(y => y.k === k); if (o) { if (c.sub) o.subs.push(c.sub); } else people.push({ k, name: x.st.name, position: x.position, ext: x.st.contractor, mark: x.mark, leave: x.leave, subs: c.sub ? [c.sub] : [] }); }));
      people.forEach(x => { x.note = x.subs.length ? x.subs.join('・') : ''; });
      const title = (UNIT_LABELS[md] || '').replace(/^[^：]+：/, '') || (sub[0].label || '').replace(/（全体）$/, '').replace(/／.*$/, '');
      return '<div class="ua-box ua-click' + (people.length ? '' : ' empty') + '" data-uam="' + esc(md) + '" title="押すと編集"><div class="ua-box-h">' + esc(title) + '</div>' + (people.length ? levels(people) : '<p class="note" style="margin:2px 0">担当者なし</p>') + '</div>'; }).join('');
    return '<div class="ua-group"><div class="ua-group-h">' + esc(g) + '</div>' + (cols.length ? '<div class="ua-root-row">' + cols.map(x => '<div class="ua-root ua-click" data-uam="' + esc(x.c.media) + '" title="押すと編集">' + (x.people.length ? levels(x.people) : '<span class="note">PM：担当者なし（押すと編集）</span>') + '</div>').join('') + '</div><div class="ua-vline"></div>' : '') + '<div class="ua-boxes">' + boxes + '</div></div>';
  }).join('');
}
/** 担当に入っているのに選択肢にないディレクトリ（BEST365 の水回りなど。契約のディレクトリ）も行に出す（2026-10-27） */
function uaWithSubs(all, d) {
  const extra = {};
  d.staff.forEach(st => Object.values(st.byMonth).map(b => b.assign).concat(st.chart ? [st.chart.assign] : []).forEach(rows => (rows || []).forEach(x => { if (x.sub && all.some(c => c.media === x.media) && !all.some(c => c.media === x.media && c.sub === x.sub)) (extra[x.media] = extra[x.media] || new Set()).add(x.sub); })));
  return all.flatMap((c, i) => { if (!extra[c.media]) return [c]; const out = [!c.sub && !/（全体）$/.test(c.label) ? Object.assign({}, c, { label: c.label + '（全体）' }) : c];
    if (!all[i + 1] || all[i + 1].media !== c.media) { const name = all.find(y => y.media === c.media && !y.sub).label.replace(/（全体）$/, ''); [...extra[c.media]].sort().forEach(sub => out.push({ media: c.media, sub, label: name + '／' + sub, group: c.group })); }
    return out; });
}
function viewUnitAssign() {
  const start = state.uaHalf = state.uaHalf || halfOf(CUR_MONTH).start, f = state.uaFilter || 'all';
  return { html: '<section class="panel" id="ua-body"><p class="loading">読み込み中…</p></section>', view: 'メディア担当管理', after: async () => {
    await loadStaffMeta();
    const curStart = halfOf(CUR_MONTH).start, at = start === curStart ? CUR_MONTH : start < curStart ? shiftMonth(start, 5) : start, d = await api('/unit-assign/' + start + '?at=' + at);
    const all = uaWithSubs(assignChoices(), d), choices = uaFilter(all, f), groups = [...new Set(all.map(c => c.group))];
    const medias = [...new Set(all.filter(c => !NON_MEDIA_UNITS.includes(c.media)).map(c => c.media))];
    const fOpts = '<option value="all">全メディア</option>' + groups.map(g => '<option value="g:' + esc(g) + '">' + esc(g) + '</option>').join('')
      + '<optgroup label="メディアごと">' + medias.map(md => '<option value="m:' + esc(md) + '">' + esc(mediaLabel(md)) + '</option>').join('') + '</optgroup>';
    const ms = d.months;
    $('ua-body').innerHTML = H('メディア担当管理', ['BEST社員管理'])
      + '<div class="row" style="gap:8px; align-items:flex-end; flex-wrap:wrap; margin-bottom:10px"><label class="field">表示<select id="ua-filter">' + fOpts + '</select></label>'
      + '<label class="field">半期<select id="ua-half">' + uaHalfList().map(h => '<option value="' + h + '"' + (h === start ? ' selected' : '') + '>' + halfLabel(h) + '</option>').join('') + '</select></label></div>'
      + '<h3 class="am-h">' + (at === CUR_MONTH ? '現在の担当者' : mLabel(at) + ' 時点の担当者') + ' <span class="note">' + mLabel(at) + '　<span class="ua-ext-key">赤</span>＝業務委託　<span class="ua-leave-key">黄色</span>＝休職中（期間）　<span class="ua-gone-key">グレー</span>＝退職・契約終了・担当変更の予定（年月）</span></h3><div class="ua-chart">' + uaChart(d, at, choices) + '</div>'
      + '<h3 class="am-h" style="margin-top:16px">半期の担当 <span class="note">' + halfLabel(start) + '</span></h3>'
      + '<div class="table-wrap"><table class="am-table ua-table"><thead><tr><th class="c-txt ua-unit">メディア・ディレクトリ</th>' + ms.map(m => '<th class="c-txt">' + mLabel(m) + '</th>').join('') + '</tr></thead><tbody>'
      + [...new Set(choices.map(c => c.group))].map(g => '<tr><td class="c-txt" colspan="' + (ms.length + 1) + '" style="background:var(--surface-2)"><b>' + esc(g) + '</b></td></tr>' + choices.filter(c => c.group === g).map(c => {
        let prev = null;
        return '<tr><td class="c-txt ua-unit-cell"><div>' + esc(c.label) + '</div><button class="btn sm" type="button" data-ua="' + esc(c.media + '|' + (c.sub || '')) + '">編集</button></td>' + ms.map(m => { const w = uaWho(d, m, c), same = false;
          return '<td class="c-txt' + (same ? ' ua-same' : '') + '">' + (w.length ? w.map(x => { const lv = uaLeave(x.st, m), e = x.st.end, gone = e && e.date && e.date.slice(0, 7) === m; return '<span class="ua-chip' + (gone ? ' ua-gone' : lv ? ' ua-leave' : x.st.contractor ? ' ua-ext' : '') + '"' + (lv ? ' title="' + esc(lv) + '"' : '') + '>' + esc(x.st.name) + '<small>' + esc(x.position) + (lv ? '・休職中' : '') + '</small>' + (gone ? '<small class="ua-mark">' + esc(e.date.replace(/-/g, '/') + ' ' + e.label) + '</small>' : '') + '</span>'; }).join('') : '<span class="note">—</span>') + '</td>'; }).join('')
          + '</tr>'; }).join('')).join('')
      + '</tbody></table></div>'
      + '<p class="note">赤＝業務委託、黄色＝休職中、グレー＝その月で退職・契約解除（日付）。担当はここで変えない限り、次の月以降もそのまま続きます。ここで変えると、BEST社員管理の「担当」、目標・稼働工数設定の行、業績評価の表示も変わります。</p>';
    $('ua-filter').value = f;
    $('ua-filter').onchange = ev => { state.uaFilter = ev.target.value; render(); };
    $('ua-half').onchange = ev => { state.uaHalf = ev.target.value; render(); };
    const openMedia = md => { const cs = all.filter(c => c.media === md); if (cs.length) unitAssignModal(d, cs, cs.length > 1 ? cs[0].label.replace(/（全体）$/, '') : cs[0].label); };
    document.querySelectorAll('[data-ua]').forEach(btn => btn.onclick = () => openMedia(btn.dataset.ua.split('|')[0]));
    document.querySelectorAll('[data-uam]').forEach(el => el.onclick = () => openMedia(el.dataset.uam));   /* 関係図のメディア・担当者を押しても編集できる */
  } };
}
/** 担当の編集：1メディア（全体＋ディレクトリ）または1カテゴリをまとめて。追加・削除できる（2026-10-27 ユーザー指定） */
function unitAssignModal(d, cs, title) {
  let ym = d.months.includes(d.at) ? d.at : d.months.includes(CUR_MONTH) ? CUR_MONTH : d.months[0];
  const load = () => cs.map(c => uaWho(d, ym, c).map(x => ({ staffId: x.st.id, position: x.position })));
  let members = load();
  const info = id => (d.staff.find(x => x.id === id) || { byMonth: {} }).byMonth[ym] || { positions: [] };
  const draw = () => {
    const row = (m, ci, i) => '<div class="row ua-row" style="gap:6px; margin:3px 0; align-items:center"><select data-uas>' + [['BEST社員', false], ['業務委託', true]].map(([gl, ext]) => '<optgroup label="' + gl + '">' + d.staff.filter(x => !!x.contractor === ext && ((x.byMonth[ym] || {}).inRange || x.id === m.staffId)).map(x => '<option value="' + esc(x.id) + '"' + (x.id === m.staffId ? ' selected' : '') + '>' + esc(x.name) + '（' + esc((x.byMonth[ym] || {}).empType || '') + '）</option>').join('') + '</optgroup>').join('') + '</select><select data-uap>' + (info(m.staffId).positions || []).map(p2 => '<option' + (p2 === m.position ? ' selected' : '') + '>' + esc(p2) + '</option>').join('') + '</select><button class="btn sm ua-del" type="button" data-uadel="' + ci + ':' + i + '">削除</button></div>';
    wideModal('<h2>担当者：' + esc(title) + '</h2>'
      + '<label class="field">変更する月<select id="ua-from">' + d.months.map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select></label>'
      + '<div id="ua-units">' + cs.map((c, ci) => '<div class="ua-ubox" data-ci="' + ci + '"><div class="ua-unit-h">' + esc(cs.length > 1 ? c.label.replace(/^[^／]+／/, '') : c.label) + '</div>'
        + (members[ci].length ? members[ci].map((m, i) => row(m, ci, i)).join('') : '<p class="note" style="margin:2px 0">担当者なし</p>') + '<button class="btn sm" type="button" data-uaadd="' + ci + '">＋ 担当者を追加</button></div>').join('') + '</div>'
      + '<label class="field" style="margin-top:8px">〜まで（任意。空欄なら、この月から先もずっと同じ担当）<input type="month" id="ua-until" min="' + ym + '"></label>'
      + '<p class="note">ポジションは、その人のその月のポジションから選べます（業務委託は契約ポジション）。在籍・契約していない月はとばします。業務委託の担当を変えると、契約管理の担当メディア・ディレクトリ（過去の月は「以前の契約内容」の担当メディア）も変わり、契約の変更履歴に残ります。</p><p class="err" id="ua-err" hidden></p>'
      + '<div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="ua-save">まとめて保存</button></div>');
    const read = () => cs.map((c, ci) => [...document.querySelectorAll('.ua-ubox[data-ci="' + ci + '"] .ua-row')].map(r => ({ staffId: r.querySelector('[data-uas]').value, position: r.querySelector('[data-uap]').value })));
    $('ua-from').onchange = ev => { ym = ev.target.value; members = load(); draw(); };
    document.querySelectorAll('.ua-ubox').forEach(box => box.querySelectorAll('[data-uas]').forEach((el, i) => el.onchange = () => { members = read(); members[Number(box.dataset.ci)][i].position = (info(el.value).positions || [])[0] || ''; draw(); }));
    document.querySelectorAll('[data-uadel]').forEach(btn => btn.onclick = () => { members = read(); const [ci, i] = btn.dataset.uadel.split(':').map(Number); members[ci].splice(i, 1); draw(); });
    document.querySelectorAll('[data-uaadd]').forEach(btn => btn.onclick = () => { members = read(); const ci = Number(btn.dataset.uaadd), st = d.staff.find(x => (x.byMonth[ym] || {}).inRange && !members[ci].some(m => m.staffId === x.id)); if (!st) return alert('追加できる人がいません'); members[ci].push({ staffId: st.id, position: (info(st.id).positions || [])[0] || '' }); draw(); });
    $('ua-save').onclick = async () => {
      const list = read(), dup = list.findIndex(ms => new Set(ms.map(m => m.staffId)).size !== ms.length);
      if (dup >= 0) { $('ua-err').textContent = cs[dup].label + ' に同じ人が2回入っています'; $('ua-err').hidden = false; return; }
      try { const r = await apiSend('PUT', '/unit-assign/' + ym, { units: cs.map((c, ci) => ({ media: c.media, sub: c.sub || '', members: list[ci] })), until: $('ua-until').value }); closeModal(); toast('保存されました' + ((r.skipped || []).length ? '（在籍・契約していない月はとばしました）' : '')); render(); }
      catch (e) { $('ua-err').textContent = e.message; $('ua-err').hidden = false; }
    };
  };
  draw();
}

// ================= 担当者の紐づけ（2026-10-27 ユーザー指定） =================
// 記事管理に書かれた担当者名を、BEST社員・業務委託（契約管理）の人に紐づける。シートは書き換えない
const LINK_ACTIONS = { link: '紐づける', none: '担当なし', skip: '紐づけない' };
function viewPeople() {
  const f = state.plFilter = state.plFilter || { show: 'all', q: '' };
  return { html: '<section class="panel" id="pl-body"><p class="loading">読み込み中…</p></section>', view: '担当者の紐づけ', after: async () => {
    const d = await api('/person-links');
    const who = id => d.staff.find(x => x.id === id) || d.contracts.find(x => x.id === id);
    const linkText = l => { if (!l) return '<span class="pill ng">未設定</span>'; if (l.action !== 'link') return '<span class="pill off">' + LINK_ACTIONS[l.action] + '</span>' + (l.note ? ' <span class="note">' + esc(l.note) + '</span>' : '');
      const c = l.contractId && who(l.contractId), st = l.staffId && who(l.staffId);
      return (c ? '業務委託：<b>' + esc(c.name) + '</b>' + (c.status === '契約解除' ? '<span class="note">（契約解除）</span>' : '') : '') + (c && st ? '<br>' : '') + (st ? 'BEST社員：<b>' + esc(st.name) + '</b>' : '') + (c && st ? '<br><span class="note">' + dateJp(st.joinDate) + ' より前は業務委託、以降は社員</span>' : '') + (l.note ? '<br><span class="note">' + esc(l.note) + '</span>' : ''); };
    const rows = [];
    d.names.forEach(n => {
      const all = d.links.find(l => l.alias === n.alias && !l.media), per = d.links.filter(l => l.alias === n.alias && l.media);
      rows.push({ n, media: '', link: all });
      per.forEach(l => rows.push({ n, media: l.media, link: l }));
    });
    const list = rows.filter(r => (f.show === 'all' || (f.show === 'unset' ? !r.link && !d.links.some(l => l.alias === r.n.alias) : !!r.link)) && (!f.q || r.n.alias.includes(f.q)));
    const unset = d.names.filter(n => !d.links.some(l => l.alias === n.alias)).length;
    $('pl-body').innerHTML = H('担当者の紐づけ <small>記事管理の担当者名 ' + d.names.length + '通り・未設定 ' + unset + '</small>', ['記事管理', '契約管理', 'BEST社員管理'])
      + '<div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px; align-items:flex-end"><label class="field">表示<select id="pl-show">' + [['all', 'すべて'], ['unset', '未設定だけ'], ['set', '設定済みだけ']].map(([k, l]) => '<option value="' + k + '"' + (f.show === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label><label class="field">名前で探す<input id="pl-q" value="' + esc(f.q) + '"></label></div>'
      + '<div class="table-wrap am-scroll"><table class="am-table"><thead><tr><th class="c-txt">記事管理の名前</th><th class="c-txt">対象メディア</th><th class="c-txt">役割</th><th class="c-txt">メディア（件数）</th><th class="c-txt">紐づけ先</th><th class="c-ctr">操作</th></tr></thead><tbody>'
      + list.map((r, i) => '<tr><td class="c-txt"><b>' + esc(r.n.alias) + '</b></td><td class="c-txt">' + (r.media ? esc(mediaLabel(r.media)) : '全メディア') + '</td><td class="c-txt note">' + Object.keys(r.n.roles).join('・') + '</td><td class="c-txt note">' + Object.entries(r.n.medias).map(([m, c]) => esc(mediaLabel(m)) + '（' + c + '）').join('、') + '</td><td class="c-txt">' + linkText(r.link) + '</td><td class="c-ctr" style="white-space:nowrap"><button class="btn sm" type="button" data-pl="' + i + '">編集</button></td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note">「紐づける」で業務委託と BEST社員の両方を選ぶと、社員の入社日より前は業務委託、入社日からは社員として数えます。メディアを選んで登録すると、そのメディアだけ別の扱いにできます（例：カギお助け本舗は幸谷さん独自の契約のため紐づけない）。スプレッドシートは書き換えません。</p>';
    $('pl-show').onchange = ev => { f.show = ev.target.value; render(); };
    $('pl-q').onchange = ev => { f.q = ev.target.value.trim(); render(); };
    document.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => personLinkModal(list[Number(b.dataset.pl)], d));
  } };
}
function personLinkModal(r, d) {
  const l = r.link || { action: 'link', media: r.media };
  const opt = (arr, cur, lab) => '<option value="">（なし）</option>' + arr.map(x => '<option value="' + esc(x.id) + '"' + (x.id === cur ? ' selected' : '') + '>' + esc(lab(x)) + '</option>').join('');
  openModal('<h2>担当者の紐づけ：' + esc(r.n.alias) + '</h2><div class="form-grid">'
    + '<label>対象メディア<select id="pl-media"><option value="">全メディア</option>' + Object.keys(r.n.medias).map(m => '<option value="' + esc(m) + '"' + (m === (l.media || '') ? ' selected' : '') + '>' + esc(mediaLabel(m)) + 'だけ</option>').join('') + '</select></label>'
    + '<label>扱い<select id="pl-act">' + Object.entries(LINK_ACTIONS).map(([k, v]) => '<option value="' + k + '"' + (k === l.action ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>'
    + '<label class="full">業務委託（契約管理）<select id="pl-c">' + opt(d.contracts.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja')), l.contractId, x => x.name + '（' + (x.position || '') + (x.status === '契約解除' ? '・契約解除' : '') + '）') + '</select></label>'
    + '<label class="full">BEST社員<select id="pl-s">' + opt(d.staff, l.staffId, x => x.name + '（入社 ' + dateJp(x.joinDate) + '）') + '</select></label>'
    + '<label class="full">メモ<input id="pl-note" value="' + esc(l.note || '') + '"></label></div>'
    + '<p class="note">両方選ぶと、社員の入社日より前は業務委託、入社日からは社員として数えます。</p><p class="err" id="pl-err" hidden></p>'
    + '<div class="row" style="justify-content:flex-end; gap:6px">' + (r.link ? '<button class="btn" type="button" id="pl-del" style="margin-right:auto">この設定を消す</button>' : '') + '<button class="btn" type="button" data-close>キャンセル</button><button class="btn primary" type="button" id="pl-save">保存</button></div>');
  const fail = m => { $('pl-err').textContent = m; $('pl-err').hidden = false; };
  $('pl-save').onclick = async () => { try { await apiSend('PUT', '/person-links', { alias: r.n.alias, media: $('pl-media').value, action: $('pl-act').value, contractId: $('pl-c').value, staffId: $('pl-s').value, note: $('pl-note').value }); closeModal(); toast('保存されました'); render(); } catch (e) { fail(e.message); } };
  if ($('pl-del')) $('pl-del').onclick = async () => { try { await apiSend('DELETE', '/person-links/' + encodeURIComponent(r.link.id), {}); closeModal(); toast('消しました'); render(); } catch (e) { fail(e.message); } };
}

// ================= 描画 =================
/* ================= シミュレーション（2026-11-05 ユーザー指定） =================
   今後12か月の PV → セッション → CV → コール数 → 成約数 → 収益、と支出・収支を、メディアごとに 理想・現実的・悲観 の3通りで計算する（AIは使わない）。
   前提は GET /api/sim/base（sim.js）、実績は MONTHLY。目標記事数を変えるとその場で計算し直す（保存はしない）。
   答え合わせ：毎月その月に最初に開いたときに、記事目標どおりの予測を BigQuery sim_predictions に保存し、実績が出たらずれを出す */
let SIM_BASE = null, SIM_PRED = null, SIM_SAVING = false, SIM_ACH = null, SIM_STAFF = null, SIM_REFRATES = null;   /* SIM_REFRATES：見られない参考メディアの率（2026-11-06） */   /* SIM_STAFF：フル管理者以外の、メディアごと・月ごとの人件費の合計（予測の支出に足す。2026-11-06 ユーザー指定） */   /* SIM_ACH：達成済みの月（サーバーが人件費込みで判定。2026-11-06） */
const SIM_SC = [['ideal', '理想'], ['real', '現実的'], ['pess', '悲観']];   /* 保存（答え合わせ）は3通り */
const SIM_SHOW = [['ideal', 'シミュレーション結果']];   /* 画面は理想だけを「シミュレーション結果」として出す（2026-11-05 ユーザー指定） */
const SIM_MONTHS = (n = 12) => Array.from({ length: n }, (_, i) => shiftMonth(CUR_MONTH, i));
const simKey = id => (ent(id) || {}).media || id;
/* 運用を止めるメディア：その月から支出なし・新しい記事なし（PV・収益は今ある記事の分を続けて計算）。届く月の欄はグレーの「運用停止」（2026-11-09 ユーザー指定：BEST365 は 2026年12月で運用停止） */
const SIM_STOP = { 'BEST365': '2026-12' };
const simStopOf = id => id === ALL ? null : SIM_STOP[simKey(id)] || null;
const simStopPill = ym => '<span class="be-pill gray">' + Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5)) + '月運用停止</span>';
const simHist = (id, ym) => (MONTHLY[id] || {})[ym] || null;
const simPct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
/** ディレクトリのときは、そのディレクトリの実績で計算し、データがない比率・支出は親のメディアの値を使う（支出の固定分は過去12か月のPVの割合で分ける）（2026-11-05 ユーザー指定） */
/** 参考にするメディア（2026-11-05 ユーザー指定）：害虫害獣コンシェルジュは成約・収益の実績がないので、収益の比率を ハチお助け本舗（害獣の側は 害獣お助け本舗）から借りる。
   ゴキブリ・シロアリ・その他害虫はまだ記事がないので、目標を入れたら シロアリお助け本舗 の記事のPVの型・リライトの効き目・収益の比率で計算する */
const SIM_REF = { '害虫害獣コンシェルジュ': { '': { media: 'ハチお助け' }, '害獣': { media: '害獣お助け' }, 'コウモリ': { media: '害獣お助け' }, 'ネズミ': { media: '害獣お助け' }, 'その他害獣': { media: '害獣お助け' },
  'ゴキブリ': { media: 'シロアリお助け', full: true }, 'シロアリ': { media: 'シロアリお助け', full: true }, 'その他害虫': { media: 'シロアリお助け', full: true } },
  '屋根外壁お助け': { '': { media: 'シロアリお助け' } },
  /* シロアリ・ハチは CV からコールにつながる率が低く収益が低すぎるので、CVのあと（CV→コール・成約率・成約1件の収益）を同じ駆除の業種の害獣お助け本舗から借りる。CV率は自分の値（2026-11-05 ユーザー指定） */
  'シロアリお助け': { '': { media: '害獣お助け', post: true } }, 'ハチお助け': { '': { media: '害獣お助け', post: true } } };   /* 屋根外壁お助け本舗の CV・収益もシロアリお助け本舗を参考に（2026-11-05 ユーザー指定） */
function simRefOf(id) { const e = ent(id); if (!e) return null; const t = SIM_REF[e.media]; if (!t) return null; return (e.block && (t[e.name] || t[e.block])) || t['']; }
function simInputs(id) {
  const I = simInputsDir(id), ref = simRefOf(id), rid = ref ? topIds().find(x => simKey(x) === ref.media) : null;
  /* 参考のメディアを見られない人（例：シロアリだけ担当）は、サーバーが返す参考メディアの「率」を使う（2026-11-06 ユーザー指摘：種石さんの画面で収益がほぼ0） */
  if (!rid && ref && SIM_REFRATES && SIM_REFRATES[ref.media]) { const R = SIM_REFRATES[ref.media]; (ref.post ? ['rCall', 'cr', 'revPerContract'] : ['cvr', 'rCall', 'cr', 'revPerContract', 'affPerPv']).forEach(k => { if (R[k] != null) I[k] = R[k]; }); I.refName = ref.media + '本舗'; I.refPost = !!ref.post; return I; }
  if (!rid) return I;
  const R = simInputs(rid);   /* 参考のメディアがさらに別のメディアを参考にしているときは、その値（屋根外壁→シロアリ→害獣など） */
  (ref.post ? ['rCall', 'cr', 'revPerContract'] : ['cvr', 'rCall', 'cr', 'revPerContract', 'affPerPv']).forEach(k => { I[k] = R[k]; });
  if (ref.full) { I.curve = R.curve; I.curveOwn = false; I.curveRef = mediaName(rid); I.rw = R.rw; I.lite = R.lite; I.rwOwn = false; if (!I.season.some(v => v !== 1)) { I.season = R.season; I.sOf = ym => R.season[Number(ym.slice(5)) - 1] || 1; I.seasonNote = mediaName(rid) + 'の値'; } }
  I.refName = mediaName(rid); I.refFull = !!ref.full; I.refPost = !!ref.post;
  return I;
}
function simInputsDir(id) {
  const e = ent(id), parent = e && e.block ? (META.media.find(m => m.media === e.media && !m.block) || {}).id : null;
  const I = simInputsRaw(id); if (!parent) return I;
  const P = simInputsRaw(parent), ok = v => v != null && isFinite(v) && v > 0;
  ['rSess', 'rCall', 'revPerContract', 'affPerPv', 'rUsers', 'rActive', 'rClicks', 'ctr', 'pos'].forEach(k => { if (!ok(I[k])) I[k] = P[k]; });
  ['cvr', 'cr'].forEach(k => { if (!ok(I[k].real)) I[k] = P[k]; });
  if (!ok(I.unitNew)) I.unitNew = P.unitNew;
  if (!ok(I.fixed)) { const last12 = Array.from({ length: 12 }, (_, i) => shiftMonth(CUR_MONTH, i - 12)), pv = x => last12.reduce((a, ym) => a + Number((simHist(x, ym) || {}).pv || 0), 0), pp = pv(parent); I.fixed = pp > 0 ? P.fixed * pv(id) / pp : 0; I.fixedShare = true; }
  I.parentName = mediaName(parent);
  return I;
}
function simInputsRaw(id) {
  const B = (SIM_BASE.media || {})[simKey(id)] || {}, last12 = Array.from({ length: 12 }, (_, i) => shiftMonth(CUR_MONTH, i - 12));
  const num = (r, k) => r && r[k] != null ? Number(r[k]) : null;
  const sum = k => last12.reduce((a, ym) => a + (num(simHist(id, ym), k) || 0), 0);
  const tot = (n, d) => { const D = sum(d); return D > 0 ? sum(n) / D : 0; };
  const monthly = (n, d) => last12.map(ym => { const r = simHist(id, ym), a = num(r, n), b = num(r, d); return a != null && b > 0 ? a / b : null; }).filter(v => v != null && isFinite(v));
  const e = ent(id), dirS = e && e.block && B.seasonDir ? (B.seasonDir[e.name] || B.seasonDir[e.block]) : null;   /* ディレクトリはそのディレクトリのKWの季節（2026-11-05） */
  const season = (dirS && dirS.season) || B.season || Array(12).fill(1), sOf = ym => season[Number(ym.slice(5)) - 1] || 1;
  const des = [1, 2, 3].map(k => shiftMonth(CUR_MONTH, -k)).map(ym => { const v = num(simHist(id, ym), 'pv'); return v != null ? v / sOf(ym) : null; }).filter(v => v != null);
  const cvrs = monthly('keyEvents', 'sessions'), crs = monthly('contracts', 'kCalls'), cvr = tot('keyEvents', 'sessions'), cr = tot('contracts', 'kCalls');
  const CR = SIM_BASE.costRatio || { rewrite: 0.58, lite: 0.31 };
  const costArticle = last12.reduce((a, ym) => a + Number(((simHist(id, ym) || {}).costs || {}).cost_article || 0), 0), w = sum('posts') + sum('rewrites') * CR.rewrite + sum('lite') * CR.lite;
  /* 支出には BEST人件費を含める（フル管理者以外は SIM_STAFF の合計を足す。2026-11-06 ユーザー指定：人件費を含めないと意味がない） */
  const stf = ym => Number(((SIM_STAFF || {})[id] || {})[ym] || 0), costH = ym => { const v = num(simHist(id, ym), 'cost'); return v == null ? (stf(ym) ? stf(ym) : null) : v + stf(ym); };
  const costAll = last12.map(costH).filter(v => v != null), costMed = simPct(costAll, .5) || 0;
  const costMonths = last12.filter(ym => { const v = costH(ym); return v != null && v >= costMed * 0.5; });   /* まだ支出がそろっていない月（中央値の半分未満）は除く */
  const fixed = costMonths.length ? costMonths.reduce((a, ym) => { const r = simHist(id, ym) || {}; return a + costH(ym) - Number((r.costs || {}).cost_article || 0); }, 0) / costMonths.length : 0;
  const own = B.curve && Object.keys(B.curve).length >= 6, rwOwn = !!(B.rewrite && (B.rewrite['リライト'] || {}).n >= 5), rwSrc = rwOwn ? B.rewrite : (SIM_BASE.rewriteAll || {});
  return { B, season, sOf, seasonNote: dirS ? 'このディレクトリの代表KW ' + dirS.kws + '個の月ごとの検索Vol（Ahrefs）から' : (B.seasonNote || '') + (e && e.block ? '（メディア全体の値）' : ''), baseDes: des.length ? des.reduce((a, v) => a + v, 0) / des.length : 0,
    rUsers: tot('users', 'sessions'), rActive: tot('active', 'pv'), rClicks: tot('clicks', 'sessions'), ctr: tot('clicks', 'imp'),   /* サマリの全項目を出す（2026-11-05 ユーザー指定） */
    pos: (() => { const L3 = [1, 2, 3].map(k => simHist(id, shiftMonth(CUR_MONTH, -k))).filter(Boolean), w = L3.reduce((a, r) => a + Number(r.posW || 0), 0), im = L3.reduce((a, r) => a + Number(r.imp || 0), 0); return im > 0 ? w / im : null; })(),
    postsTotal: (() => { for (let k = 1; k <= 3; k++) { const r = simHist(id, shiftMonth(CUR_MONTH, -k)); if (r && r.postsTotal != null) return Number(r.postsTotal); } return null; })(),
    tweak: Math.round(Array.from({ length: 6 }, (_, i) => Number((simHist(id, shiftMonth(CUR_MONTH, -(i + 1))) || {}).tweak || 0)).reduce((a, v) => a + v, 0) / 6),
    rSess: tot('sessions', 'pv'), cvr: { real: cvr, ideal: simPct(cvrs, .75) ?? cvr, pess: simPct(cvrs, .25) ?? cvr }, rCall: tot('kCalls', 'keyEvents'),
    cr: { real: cr, ideal: simPct(crs, .75) ?? cr, pess: simPct(crs, .25) ?? cr }, revPerContract: tot('revPartner', 'contracts'), affPerPv: tot('revAffiliate', 'pv'),
    CR, unitNew: w > 0 ? costArticle / w : 0, fixed, curve: own ? B.curve : (SIM_BASE.allCurve || {}), curveOwn: own,
    rw: Math.max(0, (rwSrc['リライト'] || {}).p50 || 0), lite: Math.max(0, (rwSrc['簡易リライト'] || {}).p50 || 0), rwOwn, aio: Math.min(1, Math.max(0.5, (SIM_BASE.aioAll || {}).ratio || 1)), vol: B.vol || null };
}
/** 公開から age か月目の新規記事1本のPV（季節を除いた値）。データがない月は、それより前でいちばん近い月の値のまま */
function simCurveAt(curve, age, p) { if (age < 0) return 0; for (let a = age; a >= 0; a--) if (curve[a]) return curve[a][p] || 0; return 0; }
/** 次に書く記事の検索Volの見込み（まだ公開していない記事を検索Volの大きい順に書くとして）÷ 公開済みの記事の検索Vol（中央値）。0.5〜1.5 */
function simVolF(vol, from, n) {
  if (!vol || !(vol.doneMed > 0) || !vol.todo.length || !(n > 0)) return 1;
  const sl = vol.todo.slice(Math.min(from, vol.todo.length - 1), Math.min(from + n, vol.todo.length)); const med = simPct(sl.length ? sl : [vol.todo[vol.todo.length - 1]], .5);
  return Math.min(1.5, Math.max(0.5, med / vol.doneMed));
}
/** コンテンツ進行管理に入っている、まだ公開していない新規KWの数（新規・リライト(新規)・制作判断が空。中止は除く）。ディレクトリは名前が合う記事だけ。数えられないときは null（上限なし）（2026-11-05 ユーザー指定） */
function simRemainingNew(id) {
  if (!ITEMS) return null;
  const e = ent(id), media = simKey(id), sub = e && e.block ? [e.name, e.block] : null;
  const inScope = ITEMS.filter(x => x.media === media && (!sub || sub.includes(x.sub)));
  if (sub && !inScope.length) return null;
  return inScope.filter(x => !x.upload_date && x.status !== '中止' && ['新規', 'リライト(新規)', ''].includes(String(x.type || ''))).length;
}
function simRun(id, plan, sc, horizon) {
  const cap = simRemainingNew(id); let used = 0, newCum = 0;   /* 新規KWが尽きたら、それ以降の新規の本数はリライトとして数える（2026-11-05 ユーザー指定） */
  const stopYm = simStopOf(id), I = simInputs(id), P = { ideal: 'p75', real: 'p50', pess: 'p25' }[sc], aioF = t => sc === 'ideal' ? 1 : Math.pow(I.aio, (t + 1) / (sc === 'real' ? 24 : 12));
  let cum = 0; const cohorts = [];
  const ms12 = SIM_MONTHS(), avgP = k => Math.round(ms12.reduce((a, m) => a + Number((plan[m] || {})[k] || 0), 0) / 12);
  const after = plan.__after || { new: avgP('new'), rewrite: avgP('rewrite'), lite: avgP('lite') };   /* 13か月目からは、12か月の平均の本数が続くとする（損益分岐の計算用） */
  return SIM_MONTHS(horizon || 12).map((ym, t) => {
    const stopped = !!(stopYm && ym >= stopYm), p0 = stopped ? { new: 0, rewrite: 0, lite: 0 } : (plan[ym] || after), nNew = cap == null ? p0.new : Math.min(p0.new, Math.max(0, cap - used)), over = p0.new - nNew; used += nNew;
    const p = { new: nNew, rewrite: p0.rewrite + (plan.__noOverflow ? 0 : over), lite: p0.lite }, vf = simVolF(I.vol, cum, p.new); cum += p.new;
    cohorts.push({ t, n: p.new, vf, rw: p.rewrite, lt: p.lite });
    let des = I.baseDes; cohorts.forEach(c => { des += c.n * simCurveAt(I.curve, t - c.t, P) * c.vf; if (t > c.t) des += c.rw * I.rw + c.lt * I.lite; });
    const pv = des * I.sOf(ym) * aioF(t), sessions = pv * I.rSess, cv = sessions * I.cvr[sc], calls = cv * I.rCall, contracts = calls * I.cr[sc];
    const revenue = contracts * I.revPerContract + pv * I.affPerPv, cost = stopped ? 0 : I.fixed + I.unitNew * (p.new + p.rewrite * I.CR.rewrite + p.lite * I.CR.lite), n = p.new + p.rewrite + p.lite;
    newCum += p.new; const users = sessions * I.rUsers, active = pv * I.rActive, clicks = sessions * I.rClicks, imp = I.ctr > 0 ? clicks / I.ctr : null;
    return { ym, users, active, vpa: active > 0 ? pv / active : null, clicks, imp, pos: I.pos, posw: I.pos != null && imp != null ? I.pos * imp : null, postsTotal: I.postsTotal == null ? null : I.postsTotal + newCum, tweak: I.tweak, posts: p.new, rewrites: p.rewrite, lite: p.lite, over: plan.__noOverflow ? 0 : over, left: cap == null ? null : cap - used, pv, sessions, cv, calls, contracts, revenue, cost, profit: revenue - cost, unitCost: n > 0 ? cost / n : null, vf };
  });
}
/** 損益分岐（2026-11-05 ユーザー指定）：今の目標記事数で5年先まで計算し、単月で収益が支出を上回る最初の月と、今月からの収支の累計がプラスになる月 */
const SIM_BE_MONTHS = 60, SIM_BE_LONG = 120;   /* 損益分岐は10年先まで計算して「いつ届くか」を出す（2026-11-05 ユーザー指定） */
function simBreakeven(rows) {
  let cum = 0, mon = null, cumYm = null;
  rows.forEach(r => { const ok = r.revenue > 0; if (mon == null && ok && r.profit >= 0) mon = r.ym; cum += r.profit; if (cumYm == null && ok && cum >= 0) cumYm = r.ym; });   /* 収益がない月は数えない */
  return { mon, cum: cumYm };
}
const simBeNo = ym => (Number(ym.slice(0, 4)) - Number(CUR_MONTH.slice(0, 4))) * 12 + Number(ym.slice(5)) - Number(CUR_MONTH.slice(5)) + 1;
const simBeLabel = ym => ym ? mLabel(ym) + '（' + simBeNo(ym) + 'か月目）' : '10年以内には届かない';
/** 損益分岐の見せ方（2026-11-05 ユーザー指定）：3年以内＝そのまま、3年をこえる＝黄色の枠、5年をこえる＝赤の枠。どちらも届く月を出す */
const simBeHtml = ym => { if (!ym) return '<span class="be-pill red">10年以内に届かない</span>'; const n = simBeNo(ym), l = simBeLabel(ym);
  return n <= 36 ? '<span class="be-ok">' + l + '</span>' : '<span class="be-pill ' + (n <= 60 ? 'yellow' : 'red') + '">' + (n <= 60 ? '3年以内に届かない' : '5年以内に届かない') + '<small>→ ' + l + '</small></span>'; };
/** すでに達成しているか（実績。確定した月＝翌月5日をすぎた月だけ）（2026-11-06 ユーザー指定：達成済みは青い文字・青い枠で、いつ達成したかも出す）
    単月：確定した最新の月が黒字なら、その黒字が続いている最初の月。累計：実績の収支の合計がプラスなら、最後にプラスに転じた月 */
function simAchieved(id) {
  /* 人件費を含めた支出で判定した結果をサーバーから使う（人件費を見られない人の画面で「達成済み」と誤って出ていた。2026-11-06 ユーザー指摘） */
  if (SIM_ACH) return SIM_ACH[id] || { mon: null, cum: null };
  const rows = MONTHS.filter(m => m < CUR_MONTH && todayJst() >= shiftMonth(m, 1) + '-05').map(m => ({ m, v: monthVal(id, m) })).filter(x => x.v.revenue != null && x.v.cost != null);
  let mon = null; for (let i = rows.length - 1; i >= 0 && rows[i].v.profit >= 0; i--) mon = rows[i].m;
  let cum = 0, cumYm = null; rows.forEach(x => { cum += x.v.profit || 0; if (cum < 0) cumYm = null; else if (cumYm == null) cumYm = x.m; });
  return { mon, cum: rows.length && cum >= 0 ? cumYm : null };
}
const simBeShow = (simYm, achYm) => achYm ? '<span class="be-pill blue">達成済み<small>' + mLabel(achYm) + ' に達成</small></span>' : simBeHtml(simYm);
/** 想定収支の色：プラス＝青、マイナス＝赤（2026-11-06 ユーザー指定） */
const pmCls = v => v == null || !isFinite(v) ? '' : v >= 0 ? 'v-plus' : 'v-minus';
function simDefaultPlan(id, raw) {
  /* 目標がない月（2026-11-05 ユーザー指定）：目標が入っているメディアはその目標の平均の本数、目標がないメディアは直近6か月の実績の平均（簡易リライトは目標がないので実績） */
  const o = {}, ms = SIM_MONTHS(), hist6 = k => Math.round(Array.from({ length: 6 }, (_, i) => shiftMonth(CUR_MONTH, -(i + 1))).reduce((a, ym) => a + Number((simHist(id, ym) || {})[k] || 0), 0) / 6);
  const tAvg = k => { const v = ms.map(ym => targetOf(id, ym, k)).filter(x => x != null); return v.length ? Math.round(v.reduce((a, x) => a + x, 0) / v.length) : null; };
  const fillNew = tAvg('new') ?? hist6('posts'), fillRw = tAvg('rewrite') ?? hist6('rewrites'), lite = hist6('lite');
  ms.forEach(ym => { const tn = targetOf(id, ym, 'new'), tr = targetOf(id, ym, 'rewrite'); o[ym] = { new: tn != null ? tn : fillNew, rewrite: tr != null ? tr : fillRw, lite }; });
  /* ディレクトリごとに目標を立てるメディア（水まわり・害獣・屋根外壁・コンシェルジュなど）は、ディレクトリごとに：目標がある月はその目標、目標があるディレクトリの目標がない月はその目標の平均、
     目標がないディレクトリは進行管理の直近6か月の実績の平均。ディレクトリの決まらない記事の分（メディア全体の実績−ディレクトリの実績）も足す（2026-11-05 ユーザー指摘：洗面台だけ目標があると、ほかのディレクトリが0になっていた） */
  const tr0 = targetTree().find(r => r.id === id), leaves = tr0 && tr0.kids && tr0.kids.length ? tr0.kids : null;
  if (leaves && ITEMS) {
    const media = simKey(id), last6 = Array.from({ length: 6 }, (_, i) => shiftMonth(CUR_MONTH, -(i + 1)));
    const typeOf = t => t === '簡易リライト' ? 'lite' : t === 'リライト' || t === 'リライト(新規)' ? 'rewrite' : 'new';
    const leafHist = (sub, k) => ITEMS.filter(x => x.media === media && x.sub === sub && x.upload_date && last6.includes(String(x.upload_date).slice(0, 7)) && typeOf(String(x.type || '')) === k).length / 6;
    const subOf = leaf => leaf.includes('|') && !ent(leaf) ? leaf.slice(leaf.indexOf('|') + 1) : ((ent(leaf) || {}).name || leaf.slice(leaf.indexOf('|') + 1));
    const tot = { new: 0, rewrite: 0 }; ms.forEach(ym => { o[ym].new = 0; o[ym].rewrite = 0; });
    leaves.forEach(leaf => { const sub = subOf(leaf);
      ['new', 'rewrite'].forEach(k => { const tv = ms.map(ym => targetOf(leaf, ym, k)), set = tv.filter(v => v != null), fill = set.length ? set.reduce((a, v) => a + v, 0) / set.length : leafHist(sub, k);
        if (!set.length) tot[k] += fill; ms.forEach((ym, i) => { o[ym][k] += tv[i] != null ? tv[i] : fill; }); }); });
    /* ディレクトリの決まらない記事の分：メディア全体の直近6か月の実績 − ディレクトリの実績 */
    const leafAll = k => leaves.reduce((a, leaf) => a + leafHist(subOf(leaf), k), 0), rest = { new: Math.max(0, hist6('posts') - leafAll('new')), rewrite: Math.max(0, hist6('rewrites') - leafAll('rewrite')) };
    ms.forEach(ym => { o[ym].new = Math.round(o[ym].new + rest.new); o[ym].rewrite = Math.round(o[ym].rewrite + rest.rewrite); });
  }
  /* 本数のルール（2026-11-05 ユーザー指定）：カギお助け本舗はリライト月10本。ガラスお助け本舗はカギお助け本舗の新規KWが尽きる月までは0本、その翌月から新規月10本 */
  const key = simKey(id), e = ent(id);
  /* BEST365 は運用を止めるので 2027/04 以降は新規・リライト・簡易リライトとも0本（13か月目以降も0本）（2026-11-05 ユーザー指定） */
  if (key === 'BEST365') { SIM_MONTHS().forEach(ym => { if (ym >= '2027-04') o[ym] = { new: 0, rewrite: 0, lite: 0 }; }); Object.defineProperty(o, '__after', { value: { new: 0, rewrite: 0, lite: 0 }, enumerable: false }); Object.defineProperty(o, '__note', { value: '運用停止のため 2027/04 以降は0本', enumerable: false }); }
  if (!(e && e.block)) {
    if (key === 'カギお助け') { SIM_MONTHS().forEach(ym => { o[ym].rewrite = 10; }); Object.defineProperty(o, '__noOverflow', { value: true, enumerable: false }); }   /* リライトは月10本のまま：新規KWが尽きた分はリライトに足さない（2026-11-05 ユーザー指摘） */
    if (key === 'ガラスお助け') {
      const kagi = topIds().find(x => simKey(x) === 'カギお助け'), done = kagi ? (simRun(kagi, simDefaultPlan(kagi), 'ideal', SIM_BE_MONTHS).find(r => r.left === 0) || {}).ym : null;
      SIM_MONTHS().forEach(ym => { o[ym].new = done && ym > done ? 10 : 0; });
      Object.defineProperty(o, '__note', { value: done ? 'カギお助け本舗の新規KWが ' + mLabel(done) + ' に尽きるので、' + mLabel(shiftMonth(done, 1)) + ' から新規月10本' : 'カギお助け本舗の新規KWが5年以内に尽きないので新規0本', enumerable: false });
    }
  }
  /* 害虫害獣コンシェルジュの新規（2026-11-05 ユーザー指定）：2026/11〜12月は月10本、2027/01〜04月は月12本、2027/05以降は月14本。
     ディレクトリは、もとの計算でのディレクトリの割合（ディレクトリ÷メディア全体）で、この本数を分ける */
  if (key === '害虫害獣コンシェルジュ' && !raw) {
    const ms2 = SIM_MONTHS(), avgK = k => Math.round(ms2.reduce((a, ym) => a + (o[ym][k] || 0), 0) / ms2.length);
    if (!(e && (e.block || e.dirSub))) { ms2.forEach(ym => { o[ym].new = SIM_CONC_NEW(ym); }); Object.defineProperty(o, '__after', { value: { new: 14, rewrite: avgK('rewrite'), lite: avgK('lite') }, enumerable: false }); }
    else {
      /* 細かいディレクトリ（・）ごとに割合で分け、端数は大きい順に1本ずつ足して合計をメディアの本数にそろえる。まとめのディレクトリ（└）はその下の合計 */
      const top = topIds().find(x => simKey(x) === key), base = top ? simDefaultPlan(top, true) : null;
      const blocks = META.media.filter(b => b.media === key && b.block); let g = null; const leafs = [];
      blocks.forEach(b => { if (b.group) g = b.id; else leafs.push({ id: b.id, grp: g }); });
      const mine = leafs.filter(l => l.id === id || l.grp === id).map(l => l.id);
      const raws = Object.fromEntries(leafs.map(l => [l.id, simDefaultPlan(l.id, true)]));
      const split = (T, ym) => { const b = leafs.reduce((a2, l) => a2 + ((raws[l.id][ym] || {}).new || 0), 0); if (!(b > 0)) return {}; const x = leafs.map(l => ({ id: l.id, v: T * ((raws[l.id][ym] || {}).new || 0) / b }));
        const want = T;   /* 細かいディレクトリの合計＝メディアの本数（2026-11-05 ユーザー指定） */ x.forEach(y => { y.n = Math.floor(y.v); }); let left = want - x.reduce((a2, y) => a2 + y.n, 0);
        x.slice().sort((p2, q2) => (q2.v - q2.n) - (p2.v - p2.n)).forEach(y => { if (left > 0) { y.n++; left--; } }); return Object.fromEntries(x.map(y => [y.id, y.n])); };
      const sumMine = r => mine.reduce((a2, l) => a2 + (r[l] || 0), 0);
      if (base && mine.length) { ms2.forEach(ym => { o[ym].new = sumMine(split(SIM_CONC_NEW(ym), ym)); });
        Object.defineProperty(o, '__after', { value: { new: sumMine(split(14, ms2[ms2.length - 1])), rewrite: avgK('rewrite'), lite: avgK('lite') }, enumerable: false }); }
    }
    Object.defineProperty(o, '__note', { value: '新規は 2026/11〜12月 月10本、2027/01〜04月 月12本、2027/05以降 月14本（ディレクトリはその割合で分けた本数）', enumerable: false });
  }
  return o;
}
/** 表の列の幅を固定する（2026-11-05 ユーザー指摘：左右アンバランス。1列目・数字の列（同じ幅）・最後の列を固定し、見出しと中身のそろえ方も同じにする）
    first＝1列目の幅、n＝数字の列の数（w があればその幅、なければ130px）、tail＝最後の列の幅の並び。表は画面いっぱいに広げず、列の合計の幅にする（広げると数字が各列の右端に寄って、表全体が右寄せに見える。2026-11-05 ユーザー指摘） */
const fxCols = (first, n, tail, w) => '<colgroup><col style="width:' + first + 'px">' + Array.from({ length: n }, () => '<col style="width:' + (w || 130) + 'px">').join('') + (tail || []).map(x => '<col style="width:' + x + 'px">').join('') + '</colgroup>';
const SIM_CONC_NEW = ym => ym <= '2026-12' ? 10 : ym <= '2027-04' ? 12 : 14;
const SIM_ROWS = [['pv', 'PV', 'n'], ['sessions', 'セッション', 'n'], ['users', 'ユーザー', 'n'], ['vpa', 'アクティブユーザーあたりのビュー', 'd2'], ['cv', 'CV（キーイベント）', 'n'], ['cvr', 'CV率', 'pct'], ['imp', '表示回数', 'n'], ['clicks', 'クリック数', 'n'], ['pos', '平均掲載順位', 'd1'], ['postsTotal', '公開記事数（累計）', 'n'],
  ['posts', '新規記事（本）', 'n'], ['rewrites', 'リライト（本）', 'n'], ['over', '　うち新規KWが尽きてリライトに回した本数', 'n'], ['left', '残りの新規KW（月末）', 'n'], ['lite', '簡易リライト（本）', 'n'], ['tweak', '微調整', 'n'],
  ['calls', 'コール数', 'n1'], ['contracts', '成約数', 'n1'], ['revenue', '想定収益（税抜き）', 'y'], ['cost', '想定支出（税抜き）', 'y'], ['profit', '想定収支（税抜き）', 'y'], ['unitCost', '想定 1記事あたりの単価', 'y']];   /* サマリと同じ項目・順番（2026-11-05 ユーザー指定） */
const SIM_RATIO = ['vpa', 'cvr', 'pos', 'unitCost'], SIM_STOCK = ['postsTotal', 'left'];   /* 率は合計しない・累計は最後の月 */
const simFmt = (t, v) => v == null || !isFinite(v) ? '—' : t === 'y' ? yen0(v) : t === 'pct' ? (v * 100).toFixed(2) + '%' : t === 'd2' ? v.toFixed(2) : t === 'd1' ? v.toFixed(1) : t === 'n1' ? nf.format(Math.round(v * 10) / 10) : nf.format(Math.round(v));
/** 合計・まとめるときの率（PV÷アクティブ、CV÷セッション、順位は表示回数で重み付け、単価＝支出÷本数） */
function simRatios(o) { o.vpa = o.active > 0 ? o.pv / o.active : null; o.cvr = o.sessions > 0 ? o.cv / o.sessions : null; o.pos = o.imp > 0 && o.posw != null ? o.posw / o.imp : null; const n = (o.posts || 0) + (o.rewrites || 0) + (o.lite || 0); o.unitCost = n > 0 ? o.cost / n : null; return o; }
async function simAutoSave() {
  /* 予測の保存（答え合わせ用）：その月にまだ保存していないメディアだけ、記事目標どおり（画面で変えた値ではない）の予測を保存する。全メディアが見られる人のときだけ */
  if (SIM_SAVING || noMoney()) return; SIM_SAVING = true;
  try {
    const have = new Set((SIM_PRED || []).filter(r => r.snapshot_ym === CUR_MONTH).map(r => r.media)), rows = [];
    topIds().filter(id => (SIM_BASE.media || {})[simKey(id)] && !have.has(simKey(id))).forEach(id => {
      const plan = simDefaultPlan(id);
      SIM_SC.forEach(([sc]) => { const R = simRun(id, plan, sc); rows.push({ media: simKey(id), scenario: sc, from: R[0].ym, values: Object.fromEntries(['pv', 'sessions', 'cv', 'calls', 'contracts', 'revenue', 'cost', 'posts', 'rewrites', 'lite', 'users', 'active', 'clicks', 'imp', 'posw', 'postsTotal', 'tweak'].map(k => [k, R.map(r => isFinite(r[k]) ? Math.round(r[k] * 100) / 100 : null)])) }); });   /* 12か月分をまとめて送る（1行ずつだと大きすぎた） */
    });
    if (!rows.length) return;
    const r = await apiSend('POST', '/sim/predictions', { rows }).catch(() => null);
    if (r && r.saved) SIM_PRED = (await api('/sim/predictions').catch(() => ({ rows: [] }))).rows || [];
  } finally { SIM_SAVING = false; }
}
function viewSim() {
  return { html: '<div id="sim-body"><section class="panel"><p class="loading">読み込み中…（はじめは30秒ほどかかります）</p></section></div>', view: 'シミュレーション', after: async () => {
    const seq = renderSeq;
    await Promise.all([loadArticles().catch(() => {}), loadItems().catch(() => {})]);   /* 進行管理の記事（未公開の新規KWの数に使う） */
    if (!SIM_BASE) SIM_BASE = await api('/sim/base');
    if (!SIM_PRED) SIM_PRED = (await api('/sim/predictions').catch(() => ({ rows: [] }))).rows || [];
    if (!SIM_ACH) SIM_ACH = await api('/sim/achieved').catch(() => null);
    if (!SIM_STAFF) SIM_STAFF = await api('/sim/staff-costs').catch(() => ({}));
    if (!SIM_REFRATES) SIM_REFRATES = await api('/sim/ref-rates').catch(() => ({}));
    if (seq !== renderSeq || !$('sim-body')) return;
    const id = state.media, e0 = id === ALL ? null : ent(id);
    if (e0 && e0.dirSub) { $('sim-body').innerHTML = '<section class="panel">' + H('シミュレーション') + '<p class="empty">シミュレーションはメディア単位です（ディレクトリ単位は、メディア単位で精度を確かめてから作ります）。上でメディアを選んでください。</p></section>'; return; }
    const ids = id === ALL ? topIds().filter(x => (SIM_BASE.media || {})[simKey(x)]) : [id];
    if (!ids.length) { $('sim-body').innerHTML = '<section class="panel">' + H('シミュレーション') + '<p class="empty">このメディアは計算に使える記事のデータがまだありません。</p></section>'; return; }
    state.simPlan = state.simPlan || {}; state.simSc = state.simSc || 'real';
    const planOf = x => state.simPlan[x] || (state.simPlan[x] = simDefaultPlan(x));
    const runSum = (sc, h) => { const per = ids.map(x => simRun(x, planOf(x), sc, h)); return per[0].map((r, i) => { const o = { ym: r.ym }; SIM_ROWS.map(r => r[0]).concat(['active', 'posw']).forEach(k => { if (SIM_RATIO.includes(k)) return; if ((k === 'left' || k === 'postsTotal' || k === 'posw') && per.every(p => p[i][k] == null)) { o[k] = null; return; } o[k] = per.reduce((a, p) => a + (p[i][k] || 0), 0); }); return simRatios(o); }); };
    function draw() {
      charts.forEach(c => c.destroy()); charts.length = 0;
      const R = Object.fromEntries(SIM_SC.map(([sc]) => [sc, runSum(sc)])), ms = SIM_MONTHS(), tot = (sc, k) => R[sc].reduce((a, r) => a + (r[k] || 0), 0);
      const single = id !== ALL, I = single ? simInputs(ids[0]) : null;
      /* 合計の表はカードに置き換えた（2026-11-05） */
      const planTbl = single ? '<h3 class="am-h">目標記事数 <span class="note">入力欄＝記事目標設定に目標があるところ（変えるとすぐ計算し直します。保存はしません）。数字だけのところ＝目標がない月で、目標があるメディアはその目標の平均、目標がないメディアは直近6か月の実績の平均の本数。' + (planOf(ids[0]).__note ? '<b>' + esc(planOf(ids[0]).__note) + '（ルール）。</b>' : '') + ({ 'カギお助け': '<b>リライトは月10本（ルール）。</b>' }[simKey(ids[0])] || '') + (() => { const c = simRemainingNew(ids[0]); return c == null ? '' : 'コンテンツ進行管理の未公開の新規KWは <b>' + c + '本</b>。ここまでを新規で書き、超えた分はリライトとして計算します。'; })() + '</span> <button class="btn sm" type="button" id="sim-reset">初期値に戻す</button></h3><div class="table-wrap am-scroll ex-mtable"><table class="am-table"><thead><tr><th class="c-txt">種類</th>' + ms.map(m => '<th class="c-num">' + mLabel(m) + '</th>').join('') + '</tr></thead><tbody>'
        /* 目標がある月は入力欄、目標がない月は計算に使う本数だけを出す（新規KWが尽きた分はリライトに入る）（2026-11-05 ユーザー指定） */
        + (() => { const hasT = (m, k) => k !== 'lite' && targetOf(ids[0], m, k) != null, eff = Object.fromEntries(R.ideal.map(r => [r.ym, r])), key = { new: 'posts', rewrite: 'rewrites', lite: 'lite' };
          return [['new', '新規'], ['rewrite', 'リライト'], ['lite', '簡易リライト']].map(([k, l]) => '<tr><td class="c-txt">' + l + '</td>' + ms.map(m => hasT(m, k)
            ? '<td class="c-num"><input type="number" min="0" max="500" step="1" style="width:56px" data-sp="' + m + '|' + k + '" data-over="' + (k === 'rewrite' ? eff[m].over || 0 : 0) + '" value="' + (eff[m][key[k]] || 0) + '"></td>'   /* 入力欄にも計算に使う本数（新規KWが尽きた分はリライトに足した数）をそのまま出す（2026-11-05 ユーザー指定：補足は出さない） */
            : '<td class="c-num">' + simFmt('n', eff[m][key[k]]) + '</td>').join('') + '</tr>').join(''); })()
        + '</tbody></table></div>'
        : '<h3 class="am-h">メディアごと（今後12か月の合計）<span class="note">目標記事数を変えるときは、上でメディアを選んでください</span></h3><div class="table-wrap"><table class="am-table fx-table">' + fxCols(200, 6, [170, 170]) + '<thead><tr><th class="c-txt">メディア</th><th class="c-num">新規</th><th class="c-num">PV</th><th class="c-num">成約数</th><th class="c-num">想定収益</th><th class="c-num">想定支出</th><th class="c-num">想定収支</th><th class="c-ctr">単月で黒字</th><th class="c-ctr">累計で収益が上回る</th></tr></thead><tbody>'
        + ids.map(x => { const r = simRun(x, planOf(x), 'ideal'), t = k => r.reduce((a, o) => a + (o[k] || 0), 0), be = simBreakeven(simRun(x, planOf(x), 'ideal', SIM_BE_LONG)), ac = simAchieved(x); return '<tr><td class="c-txt">' + esc(mediaName(x)) + '</td><td class="c-num">' + simFmt('n', t('posts')) + '</td><td class="c-num">' + simFmt('n', t('pv')) + '</td><td class="c-num">' + simFmt('n1', t('contracts')) + '</td><td class="c-num">' + simFmt('y', t('revenue')) + '</td><td class="c-num">' + simFmt('y', t('cost')) + '</td><td class="c-num ' + pmCls(t('profit')) + '">' + simFmt('y', t('profit')) + '</td><td class="c-ctr">' + (simStopOf(x) ? simStopPill(simStopOf(x)) : simBeShow(be.mon, ac.mon)) + '</td><td class="c-ctr">' + (simStopOf(x) ? simStopPill(simStopOf(x)) : simBeShow(be.cum, ac.cum)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      state.simSc = 'ideal'; const S = R.ideal, seg = '';
      const monTbl = '<div class="table-wrap am-scroll ex-mtable"><table class="am-table"><thead><tr><th class="c-txt">項目</th>' + ms.map(m => '<th class="c-num">' + mLabel(m) + '</th>').join('') + '<th class="c-num">合計</th></tr></thead><tbody>'
        + SIM_ROWS.filter(r => !(noMoney() && r[2] === 'y') && r[0] !== 'over').map(([k, l, t]) =>   /* 「うち新規KWが尽きてリライトに回した本数」は出さない（2026-11-05 ユーザー指定） */ '<tr><td class="c-txt">' + l + '</td>' + S.map(r => '<td class="c-num' + (k === 'profit' ? ' ' + pmCls(r[k]) : '') + '">' + simFmt(t, r[k]) + '</td>').join('') + '<td class="c-num"><b>' + (SIM_STOCK.includes(k) ? simFmt(t, S[S.length - 1][k]) : SIM_RATIO.includes(k) ? simFmt(t, simRatios(Object.fromEntries(['pv', 'active', 'cv', 'sessions', 'imp', 'posw', 'posts', 'rewrites', 'lite', 'cost'].map(x => [x, S.reduce((a2, r) => a2 + (r[x] || 0), 0)])))[k]) : simFmt(t, tot(state.simSc, k))) + '</b></td></tr>').join('') + '</tbody></table></div>';
      const ages = [1, 3, 6, 12], cv = (a, p) => I ? simFmt('n', simCurveAt(I.curve, a, p)) : '';
      const asm = single ? '<h3 class="am-h">計算の前提（このメディア）</h3><div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">前提</th><th class="c-txt">値</th><th class="c-txt">元・使い方</th></tr></thead><tbody>'
        + '<tr><td class="c-txt">新規記事1本のPV（月）</td><td class="c-txt">' + ages.map(a => a + 'か月目：' + cv(a, 'p75')).join('<br>') + '</td><td class="c-txt"><span class="note">よく読まれた記事（上位25%）の型。' + (I.curveRef ? I.curveRef + 'の記事（参考）' : I.curveOwn ? 'このメディアの記事' : '記事が少ないので全メディアの記事') + 'の GA4 のページ別PV（' + esc(SIM_BASE.pageFrom) + '〜）。季節の影響は除いた値</span></td></tr>'
        + '<tr><td class="c-txt">季節の指数（1〜12月）</td><td class="c-txt">' + (I.B.season || I.season.some(v => v !== 1) ? I.season.map((v, i) => (i + 1) + '月 ' + v.toFixed(2)).join('・') : '— （どの月も1）') + '</td><td class="c-txt"><span class="note">' + esc(I.seasonNote || '') + '。1を超える月は平均より検索が多い月</span></td></tr>'
        + '<tr><td class="c-txt">次に書く記事の検索Vol</td><td class="c-txt">' + (I.vol ? '公開済みの中央値 ' + nf.format(Math.round(I.vol.doneMed || 0)) + '・未公開 ' + I.vol.todo.length + '本' : '—') + '</td><td class="c-txt"><span class="note">未公開の記事を検索Volの大きい順に書くとして、公開済みとの比（0.5〜1.5倍）を新規記事のPVにかける</span></td></tr>'
        + '<tr><td class="c-txt">リライト1本のPVの増え方（月）</td><td class="c-txt">リライト ' + simFmt('n', I.rw) + '・簡易リライト ' + simFmt('n', I.lite) + '</td><td class="c-txt"><span class="note">リライトの前3か月と後3か月の差の中央値（' + (I.rwOwn ? 'このメディア' : '実績が少ないので全メディア') + '）</span></td></tr>'
        + '<tr><td class="c-txt">AIO（AIによる概要）の影響</td><td class="c-txt">クリック率の前年比 ' + (SIM_BASE.aioAll ? (SIM_BASE.aioAll.ratio * 100).toFixed(0) + '%' : '—') + '</td><td class="c-txt"><span class="note">全メディアの Search Console（直近3か月と前の年）。シミュレーション結果は「これ以上は下がらない」として計算（参考の値）。順位の変化も含むので暫定</span></td></tr>'
        + '<tr><td class="c-txt">PV→成約・収益の比率</td><td class="c-txt">セッション/PV ' + (I.rSess * 100).toFixed(0) + '%・CV率 ' + (I.cvr.ideal * 100).toFixed(2) + '%<br>コール/CV ' + I.rCall.toFixed(2) + '・成約率 ' + (I.cr.ideal * 100).toFixed(1) + '%<br>成約1件の収益 ' + yen0(I.revPerContract) + '・PVあたりのアフィリエイト ' + yen0(I.affPerPv * 1000) + '／1,000PV</td><td class="c-txt"><span class="note">' + (I.refName ? '<b>' + (I.refPost ? 'CV率は自分の実績、CVのあと（コール・成約・成約1件の収益）は' + esc(I.refName) : esc(I.refName)) + 'の過去12か月の実績を参考</b>（2026-11-05 ユーザー指定）。' : '過去12か月の実績（GA4・kintone・もしも）。') + 'CV率・成約率は月ごとの値の上位25%</span></td></tr>'
        + '<tr><td class="c-txt">支出</td><td class="c-txt">記事以外の支出 ' + yen0(I.fixed) + '／月' + (I.fixedShare ? '（' + esc(I.parentName) + 'の支出をPVの割合で分けた値）' : '') + '<br>新規記事1本 ' + yen0(I.unitNew) + '・リライト＝新規の ' + Math.round(I.CR.rewrite * 100) + '%・簡易リライト＝' + Math.round(I.CR.lite * 100) + '%</td><td class="c-txt"><span class="note">過去12か月の支出。記事の費用（業務委託の記事制作費）を、新規＝1・リライト・簡易リライト＝契約の単価の比率で数えた本数で割った値（2026-11-05 ユーザー指定）</span></td></tr>'
        + '</tbody></table></div>' : '';
      /* 見せ方はシミュレーション比較と同じ：いちばん上に数字のカード、グラフ・表はそれぞれの枠（2026-11-05 ユーザー指定：枠を作ってもう少し工夫して） */
      const be = simBreakeven(runSum('ideal', SIM_BE_LONG)), nArt = tot('ideal', 'posts') + tot('ideal', 'rewrites') + tot('ideal', 'lite'), avg = v => simFmt('n', v / 12);
      const card = (l, v, note, col, small) => '<div class="kpi"><div class="lbl"><span>' + l + '</span></div><div class="val" style="font-size:' + (small ? 20 : 26) + 'px;' + (col || '') + '">' + v + '</div><div class="note">' + note + '</div></div>';
      const red = 'color:var(--bad)', green = 'color:var(--good, #1a7f4b)', blue = 'color:var(--plus, #1d63d6)', pf = tot('ideal', 'profit'), ach = simAchieved(id);
      const cards1 = [card('PV', simFmt('n', tot('ideal', 'pv')), '月平均 ' + avg(tot('ideal', 'pv'))), card('CV（キーイベント）', simFmt('n', tot('ideal', 'cv')), '月平均 ' + avg(tot('ideal', 'cv'))), card('成約数', simFmt('n1', tot('ideal', 'contracts')), '月平均 ' + simFmt('n1', tot('ideal', 'contracts') / 12)), card('記事制作数', simFmt('n', nArt), '新規 ' + simFmt('n', tot('ideal', 'posts')) + '・リライト ' + simFmt('n', tot('ideal', 'rewrites')) + '・簡易 ' + simFmt('n', tot('ideal', 'lite')))];
      /* 想定収支：収益・支出・1記事あたりの単価・収支の順。想定：単月で黒字になる月・累計で収益が上回る月（2026-11-05 ユーザー指定） */
      const cards2 = noMoney() ? [] : [card('想定収益（税抜き）', simFmt('y', tot('ideal', 'revenue')), '月平均 ' + simFmt('y', tot('ideal', 'revenue') / 12)), card('想定支出（税抜き）', simFmt('y', tot('ideal', 'cost')), '月平均 ' + simFmt('y', tot('ideal', 'cost') / 12)), card('想定 1記事あたりの単価', simFmt('y', nArt > 0 ? tot('ideal', 'cost') / nArt : null), '想定支出÷記事制作数'), card('想定収支（税抜き）', simFmt('y', pf), pf >= 0 ? '12か月でプラス' : '12か月ではマイナス', pf >= 0 ? blue : red)];
      const cards3 = noMoney() ? [] : [card('単月で黒字になる月', simStopOf(id) ? simStopPill(simStopOf(id)) : simBeShow(be.mon, ach.mon), 'その月の想定収益が想定支出以上になる最初の月', '', true), card('累計で収益が上回る月', simStopOf(id) ? simStopPill(simStopOf(id)) : simBeShow(be.cum, ach.cum), '今月からの想定収益の合計が想定支出の合計を上回る月', '', true)];
      const grid = n => '<section class="kpis wide" style="grid-template-columns:repeat(' + n + ', minmax(0,1fr))">';
      const sec = (title, inner, srcs) => '<section class="panel">' + H(title, srcs) + inner + '</section>';
      $('sim-body').innerHTML = '<section class="panel">' + H('シミュレーション <small>' + esc(mediaName(id)) + '・今後12か月（' + mLabel(ms[0]) + '〜' + mLabel(ms[11]) + '）・シミュレーション結果</small>', ['GA4', 'Ahrefs', '記事管理', 'kintone', '支出'])
        + '<p class="note" style="margin:0">今の目標記事数で計算した今後12か月の合計です。損益分岐は10年先まで計算（13か月目からは12か月の平均の本数が続くとする。3年をこえると黄色、5年をこえると赤の枠）。新規記事のPVは「公開から何か月目か」ごとの実績の型、既存の記事のPVは直近3か月（季節の影響を除く）のまま続くとして計算しています。</p></section>'
        + '<h3 class="am-h sum-h">シミュレーション12か月の合計</h3>' + grid(cards1.length) + cards1.join('') + '</section>'
        + (cards2.length ? '<h3 class="am-h sum-h">想定収支</h3>' + grid(cards2.length) + cards2.join('') + '</section>' : '')
        + (cards3.length ? '<h3 class="am-h sum-h">想定</h3>' + grid(2) + cards3.join('') + '</section>' : '')
        + sec('推移 <small>青＝実績、赤＝シミュレーション結果</small>', '<div class="row" style="gap:8px"><label class="field">グラフの項目<select id="sim-metric"></select></label></div><div class="chart-box tall"><canvas id="sim-chart"></canvas></div>')
        + (planTbl ? '<section class="panel">' + planTbl.replace('<h3 class="am-h">', '<h3 class="am-h" style="margin-top:0">') + '</section>' : '')
        + sec('月ごと <small>サマリと同じ項目</small>', seg + monTbl)
        + (asm ? '<section class="panel">' + asm.replace('<h3 class="am-h">', '<h3 class="am-h" style="margin-top:0">') + '</section>' : '');
      /* グラフ：項目をプルダウンで選ぶ。実績は青、シミュレーションは赤（2026-11-05 ユーザー指定） */
      const SIM_CHART = [['pv', 'PV', 'pv'], ['sessions', 'セッション', 'sessions'], ['cv', 'CV', 'cv'], ['calls', 'コール数', 'kCalls'], ['contracts', '成約数', 'contracts'], ['revenue', '想定収益(税抜き)', 'revenue'], ['cost', '想定支出(税抜き)', 'cost'], ['profit', '想定収支(税抜き)', 'profit'], ['articles', '記事制作数', 'posts']].filter(x => !(noMoney() && ['revenue', 'cost', 'profit'].includes(x[0])));
      const ck = SIM_CHART.some(x => x[0] === state.simMetric) ? state.simMetric : 'pv', cdef = SIM_CHART.find(x => x[0] === ck);
      const actOf = (x, ym) => { const r = simHist(x, ym); if (!r) return 0; const n = k => Number(r[k] || 0), rev = n('revPartner') + n('revAffiliate'); return ({ pv: n('pv'), sessions: n('sessions'), cv: n('keyEvents'), calls: n('kCalls'), contracts: n('contracts'), revenue: rev, cost: n('cost'), profit: rev - n('cost'), articles: n('posts') + n('rewrites') + n('lite') })[ck]; };
      const simOf = r => ck === 'articles' ? (r.posts || 0) + (r.rewrites || 0) + (r.lite || 0) : r[ck];
      const hist = Array.from({ length: 12 }, (_, i) => shiftMonth(CUR_MONTH, i - 12)), hv = hist.map(ym => ids.reduce((a, x) => a + actOf(x, ym), 0));
      const pad = Array(12).fill(null), BLUE = '#2f6fd1', RED = '#d63b3b';
      if ($('sim-metric')) { $('sim-metric').innerHTML = SIM_CHART.map(([k, l]) => '<option value="' + k + '"' + (k === ck ? ' selected' : '') + '>' + l + '</option>').join(''); $('sim-metric').onchange = ev => { state.simMetric = ev.target.value; draw(); }; }
      chart('sim-chart', { type: 'line', data: { labels: hist.concat(ms).map(mLabel), datasets: [{ label: cdef[1] + '（実績）', data: hv.concat(Array(12).fill(null)), borderColor: BLUE, backgroundColor: BLUE, tension: .2, pointRadius: 2, borderWidth: 2 }]
        .concat(SIM_SHOW.map(([sc, l]) => ({ label: cdef[1] + '（' + l + '）', data: pad.slice(0, 11).concat([hv[11]]).concat(R[sc].map(r => Math.round(simOf(r) || 0))), borderColor: RED, backgroundColor: RED, borderDash: [5, 4], tension: .2, pointRadius: 0, borderWidth: 2.5 }))) },
        options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--grid') } }, y: yAxis(cdef[2]) } }) });
      document.querySelectorAll('[data-simsc]').forEach(b => b.onclick = () => { state.simSc = b.dataset.simsc; draw(); });
      document.querySelectorAll('[data-sp]').forEach(inp => inp.onchange = () => { const [m, k] = inp.dataset.sp.split('|'); planOf(ids[0])[m][k] = Math.max(0, Math.min(500, Math.round(Number(inp.value) || 0)) - Number(inp.dataset.over || 0)); draw(); });   /* リライトの欄は振り替え分を足して見せているので、その分を引いて保存 */
      if ($('sim-reset')) $('sim-reset').onclick = () => { state.simPlan[ids[0]] = simDefaultPlan(ids[0]); draw(); };
    }
    draw();
    /* 答え合わせは「AIツール」→「AI MEDIAシミュレーション」へ移動（2026-11-05 ユーザー指定） */
    await simAutoSave();
  } };
}

/* ================= シミュレーション比較（2026-11-05 ユーザー指定：プランニング比と入れ替え。見せ方はサマリと同じ） =================
   その月に保存したシミュレーション結果（BigQuery sim_predictions の ideal。その月より前で一番新しい予測）と実績を比べる。
   今月は、昨日までの日数分に日割りしたシミュレーションと比べる。メディア単位（ディレクトリは予測を保存していない） */
const SC_TOP = [['pv', 'PV'], ['cv', 'CV（キーイベント）'], ['kCalls', 'コール数'], ['revenue', '収益合計(税抜き)'], ['articles', '記事制作数']];
const SC_FLOW = ['pv', 'sessions', 'cv', 'kCalls', 'contracts', 'revenue', 'cost', 'profit', 'posts', 'rewrites', 'lite', 'articles', 'users', 'active', 'clicks', 'imp', 'tweak'];
/** 保存した予測を、サマリの項目名の形にまとめる（frac：今月の日割りの割合） */
function scPred(keys, ym, frac) {
  const raw = {};
  keys.forEach(mk => { const rows = (SIM_PRED || []).filter(r => r.media === mk && r.scenario === 'ideal' && r.ym === ym && r.snapshot_ym <= ym); const snap = rows.map(r => r.snapshot_ym).sort().pop(); rows.filter(r => r.snapshot_ym === snap).forEach(r => { raw[r.metric] = (raw[r.metric] || 0) + Number(r.value); }); });
  if (!Object.keys(raw).length) return null;
  const p = { pv: raw.pv, sessions: raw.sessions, cv: raw.cv, kCalls: raw.calls, contracts: raw.contracts, revenue: raw.revenue, cost: raw.cost, posts: raw.posts, rewrites: raw.rewrites, lite: raw.lite, users: raw.users, active: raw.active, clicks: raw.clicks, imp: raw.imp, postsTotal: raw.postsTotal, tweak: raw.tweak };
  if (raw.posw != null && raw.imp > 0) p.pos = raw.posw / raw.imp;
  if (p.posts != null || p.rewrites != null || p.lite != null) p.articles = (p.posts || 0) + (p.rewrites || 0) + (p.lite || 0);
  if (p.revenue != null && p.cost != null) p.profit = p.revenue - p.cost;
  SC_FLOW.forEach(k => { if (p[k] != null) p[k] = p[k] * frac; });
  if (p.sessions > 0 && p.cv != null) p.cvr = p.cv / p.sessions;
  if (p.articles > 0 && p.cost != null) p.unitCost = p.cost / p.articles;
  if (p.active > 0 && p.pv != null) p.vpa = p.pv / p.active;
  if (p.imp > 0 && p.clicks != null) p.ctr = p.clicks / p.imp;
  return p;
}
function viewSimCompare() {
  return { html: '<div id="sc-body"><section class="panel"><p class="loading">読み込み中…</p></section></div>', view: 'シミュレーション比較', after: async () => {
    const seq = renderSeq;
    await loadArticles().catch(() => {});
    if (!SIM_PRED) SIM_PRED = (await api('/sim/predictions').catch(() => ({ rows: [] }))).rows || [];
    if (!SIM_ACH) SIM_ACH = await api('/sim/achieved').catch(() => null);
    if (!SIM_STAFF) SIM_STAFF = await api('/sim/staff-costs').catch(() => ({}));
    if (!SIM_REFRATES) SIM_REFRATES = await api('/sim/ref-rates').catch(() => ({}));
    if (seq !== renderSeq || !$('sc-body')) return;
    const id = state.media, e0 = id === ALL ? null : ent(id);
    if (e0 && (e0.block || e0.dirSub)) { $('sc-body').innerHTML = '<section class="panel">' + H('シミュレーション比較') + '<p class="empty">シミュレーション比較はメディア単位です（予測はメディアごとに保存しています）。上でメディアを選んでください。</p></section>'; return; }
    const ids = id === ALL ? topIds() : [id], keys = new Set(ids.map(simKey));
    const yms = [...new Set((SIM_PRED || []).filter(r => r.scenario === 'ideal' && keys.has(r.media) && r.ym <= CUR_MONTH && r.snapshot_ym <= r.ym).map(r => r.ym))].sort().reverse();
    if (!yms.length) { $('sc-body').innerHTML = '<section class="panel">' + H('シミュレーション比較') + '<p class="empty">まだ比べられる予測がありません（シミュレーションの画面を開いた月から、その月の予測を保存します）。</p></section>'; return; }
    const ym = state.scYm = yms.includes(state.scYm) ? state.scYm : yms[0], ly = shiftMonth(ym, -12);
    const isCur = ym === CUR_MONTH, dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate(), done = isCur ? Math.max(1, Number(todayJst().slice(8, 10)) - 1) : dim, frac = done / dim;
    const p = scPred(keys, ym, frac) || {}, a = Object.assign({}, monthVal(id, ym)), y = Object.assign({}, monthVal(id, ly));
    let dCur = null, curFrom = null, curTo = null;   /* 今月の日別（メディアごとの達成率でも使う） */
    /* 今月は、実績も前年も同じ日数（1日〜昨日）の日別データで比べる（2026-11-05 ユーザー指摘：前年比が月全体と比べていた） */
    if (isCur) {
      const dd = String(done).padStart(2, '0'), from = ym + '-01', to = ym + '-' + dd, lyDim = new Date(Date.UTC(Number(ly.slice(0, 4)), Number(ly.slice(5)), 0)).getUTCDate(), lyTo = ly + '-' + String(Math.min(done, lyDim)).padStart(2, '0');
      try { const [d1, d2] = await Promise.all([loadDaily(from, to), loadDaily(ly + '-01', lyTo)]); dCur = d1; curFrom = from; curTo = to; const ra = rangeVal(d1, id, from, to), ry = rangeVal(d2, id, ly + '-01', lyTo);
        Object.entries(ra).forEach(([k, v]) => { if (v != null && typeof v !== 'object') a[k] = v; }); Object.keys(y).forEach(k => { if (typeof y[k] !== 'object' && k !== 'postsTotal') y[k] = null; }); Object.entries(ry).forEach(([k, v]) => { if (v != null && typeof v !== 'object') y[k] = v; }); } catch (e) { /* 日別がなければ月の値のまま */ }
      if (seq !== renderSeq || !$('sc-body')) return;
    }
    [a, y].forEach(o => { o.articles = o.posts == null && o.rewrites == null && o.lite == null ? null : (o.posts || 0) + (o.rewrites || 0) + (o.lite || 0); });
    const ach = (k, lb) => { const t = p[k], v = a[k]; if (t == null || v == null || !(t > 0)) return null; return lb ? t / v : v / t; };
    const pct = r => r == null ? '—' : (r * 100).toFixed(1) + '%', col = r => r == null ? '' : r >= 1 ? 'color:var(--good, #1a7f4b)' : r >= 0.8 ? 'color:var(--warn)' : 'color:var(--bad)';   /* 緑＝100%以上、黄＝80%以上、赤＝80%未満（バーと同じ色。2026-11-05 ユーザー指定） */
    const SC_MONEY = ['revenue', 'cost', 'profit', 'unitCost'], simWord = k => SC_MONEY.includes(k) ? '想定' : 'シミュレーション';   /* 収益・支出系のシミュレーションの値は「想定」（2026-11-05 ユーザー指定） */
    const fv = (k, v) => v == null ? '—' : k === 'articles' ? nf.format(Math.round(v)) : fmt(k, v);
    const L12 = Array.from({ length: 12 }, (_, i) => shiftMonth(ym, i - 11));
    /* いちばん上：達成率（大きく） */
    const top = '<section class="kpis wide" style="grid-template-columns:repeat(5, minmax(0,1fr))">' + SC_TOP.filter(([k]) => !(noMoney() && k === 'revenue')).map(([k, l]) => { const r = ach(k); return '<div class="kpi"><div class="lbl"><span>' + l + 'の達成率</span></div><div class="val" style="font-size:32px;' + col(r) + '">' + pct(r) + '</div><div class="note">実績 ' + fv(k, a[k]) + '／' + simWord(k) + ' ' + fv(k, p[k]) + '</div></div>'; }).join('') + '</section>';
    /* サマリと同じカード：実績・シミュレーション比（達成率）・前年比・過去12か月の推移 */
    const cards = '<section class="kpis wide">' + KPI_KEYS.filter(k => !(noMoney() && MONEY_KEYS.includes(k))).map(k => { const lb = !!(M[k] && M[k].lowerBetter), r = ach(k, lb);   /* 順位・支出・単価は小さいほうがよい */
      return '<div class="kpi" data-src="' + M[k].src + '"><div class="lbl"><span title="' + M[k].l + '">' + M[k].l + '</span><span class="srcs">' + srcBadges(srcOf(k)) + '</span></div>'
        + '<div class="val">' + fmt(k, a[k]) + (M[k].unit && a[k] != null ? '<small>' + M[k].unit + '</small>' : '') + '</div>'
        + '<div class="note">' + simWord(k) + ' ' + (p[k] == null ? '—（予測していない項目）' : k === 'profit' ? '<b class="' + pmCls(p[k]) + '">' + fmt(k, p[k]) + '</b>' : fmt(k, p[k])) + '</div>'
        + '<div class="chips"><span class="chip ' + (r == null ? 'flat' : r >= 1 ? 'up' : 'down') + '"><span class="k">達成率</span>' + pct(r) + '</span>' + chip(k, a[k], y[k], '前年') + '</div>'
        + (a[k] == null ? '' : spark(L12.map(m => monthVal(id, m)[k]))) + '</div>'; }).join('') + '</section>';
    /* 記事進捗：実績／シミュレーション */
    const artRow = (l, k) => { const v = a[k] || 0, t = p[k], r = t > 0 ? v / t : null;
      return '<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px"><div class="row" style="justify-content:space-between"><span>' + l + '</span><span class="num">' + v + (t != null ? ' / ' + Math.round(t * 10) / 10 + '本（' + (r == null ? '—' : Math.round(r * 100) + '%') + '）' : '本') + '</span></div>'
        + (t > 0 ? '<div class="progress"><span class="' + (r >= 1 ? 'over' : 'under') + '" style="width:' + Math.min(r, 1) * 100 + '%"></span></div>' : '') + '</div>'; };
    const art = artRow('新規', 'posts') + artRow('リライト', 'rewrites') + artRow('簡易リライト', 'lite') + artRow('合計（新規＋リライト＋簡易リライト）', 'articles') + '<p class="note" style="margin:8px 0 0">実績／シミュレーション' + (isCur ? '（日割り）' : '') + 'の本数。緑は達成、黄は未達。</p>';
    const head = '<section class="panel">' + H('シミュレーション比較 <small>' + esc(mediaName(id)) + '・' + mLabel(ym) + (isCur ? '・1日〜' + done + '日（昨日まで）' : '') + '</small>', noMoney() ? ['GA4', 'SC', 'WordPress', 'kintone'] : ['GA4', 'SC', 'WordPress', 'kintone', 'ASP', '支出'])
      + '<div class="row" style="gap:8px"><label class="field">月<select id="sc-ym">' + yms.map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select></label><span class="note">シミュレーション＝その月より前に保存した予測（シミュレーション結果）。' + (isCur ? '今月は月の予測を昨日までの日数（' + done + '／' + dim + '日）で日割りし、前年も同じ日数（1日〜' + done + '日）と比べます。' : '') + '達成率＝実績÷シミュレーション（支出・1記事あたりの単価は少ないほうがよいのでシミュレーション÷実績）。</span></div></section>';
    /* メディア累計のとき：メディアごとの達成率（2026-11-05 ユーザー指定） */
    let perMedia = '';
    if (id === ALL) {
      /* 見やすく：各マスに達成率・進捗バー・実績／シミュレーション。最後に全体の行（2026-11-05 ユーザー指定：もう少し綺麗に） */
      const tops = SC_TOP.filter(([k]) => !(noMoney() && k === 'revenue'));
      const cell = (k, v, t) => { if (!(t > 0)) return '<td class="pm-cell"><span class="note">予測なし</span></td>';
        const r = v == null ? null : v / t, cls = r == null ? '' : r >= 1 ? 'good' : r >= 0.8 ? 'mid' : 'bad';
        return '<td class="pm-cell"><div class="pm-top"><b class="pm-pct ' + cls + '">' + pct(r) + '</b><span class="pm-sub">' + fv(k, v) + ' / ' + (SC_MONEY.includes(k) ? '想定 ' : '') + fv(k, t) + '</span></div>'
          + '<div class="progress pm-bar"><span class="' + cls + '" style="width:' + Math.min(r || 0, 1) * 100 + '%"></span></div></td>'; };
      const rows = ids.map(mid => { const pm = scPred(new Set([simKey(mid)]), ym, frac); if (!pm) return null;
        const am = Object.assign({}, monthVal(mid, ym)); if (dCur) { try { Object.entries(rangeVal(dCur, mid, curFrom, curTo)).forEach(([k, v]) => { if (v != null && typeof v !== 'object') am[k] = v; }); } catch (e) { /* 月の値のまま */ } }
        am.articles = am.posts == null && am.rewrites == null && am.lite == null ? null : (am.posts || 0) + (am.rewrites || 0) + (am.lite || 0);
        return '<tr><th class="pm-name">' + esc(mediaName(mid)) + '</th>' + tops.map(([k]) => cell(k, am[k], pm[k])).join('') + '</tr>'; }).filter(Boolean);
      if (rows.length) perMedia = '<section class="panel">' + H('メディアごとの達成率 <small>' + mLabel(ym) + (isCur ? '・1日〜' + done + '日（日割り）' : '') + '</small>')
        + '<div class="table-wrap"><table class="am-table pm-table"><colgroup><col style="width:180px">' + tops.map(() => '<col>').join('') + '</colgroup><thead><tr><th class="pm-name">メディア</th>' + tops.map(([, l]) => '<th>' + l + '</th>').join('') + '</tr></thead><tbody>' + rows.join('')
        + '<tr class="pm-total"><th class="pm-name">メディア累計</th>' + tops.map(([k]) => cell(k, a[k], p[k])).join('') + '</tr></tbody></table></div>'
        + '<p class="note">各マス：達成率（実績÷シミュレーション）、実績 / シミュレーション、進捗バー。緑＝100%以上、黄＝80%以上、赤＝80%未満。「予測なし」はシミュレーションが0の項目。</p></section>';
    }
    $('sc-body').innerHTML = head + top + perMedia
      + '<h3 class="am-h sum-h">' + mLabel(ym) + 'の実績とシミュレーション <span class="note">カードの小さなグラフは過去12か月（' + mLabel(L12[0]) + '〜' + mLabel(ym) + '）の実績の推移</span></h3>' + cards
      + '<section class="grid2"><div class="panel">' + H('記事進捗 <small>' + mLabel(ym) + '・実績／シミュレーション</small>', ['WordPress']) + art + '</div>'
      + (noMoney() ? '' : '<div class="panel">' + H('収益と支出の内訳 <small>' + mLabel(ym) + '・実績と想定</small>', ['kintone', 'ASP', '支出']) + moneyTable(a, p, y, '実績', '想定', mLabel(ly), '想定比', '前年比') + '</div>') + '</section>'
      + '<h3 class="am-h sum-h">実績とシミュレーションの推移 <span class="note">青＝実績、赤＝シミュレーション（保存した予測）</span></h3>'
      + '<section class="grid2 even">' + [['pv', 'PV'], ['cv', 'CV（キーイベント）'], ['kCalls', 'コール数']].concat(noMoney() ? [] : [['revenue', '収益合計(税抜き)']]).map(([k, l]) => '<div class="panel">' + H(l + ' <small>過去12か月と保存した予測</small>') + '<div class="chart-box sm"><canvas id="sc-c-' + k + '"></canvas></div></div>').join('') + '</section>';
    $('sc-ym').onchange = ev => { state.scYm = ev.target.value; render(); };
    /* 推移：過去12か月の実績と、保存した予測（今月以降12か月） */
    const futs = Array.from({ length: 12 }, (_, i) => shiftMonth(CUR_MONTH, i)), labels = L12.concat(futs.filter(m => m > ym)).map(mShort);
    const all = L12.concat(futs.filter(m => m > ym));
    [['pv'], ['cv'], ['kCalls'], ['revenue']].forEach(([k]) => { if (!$('sc-c-' + k)) return;
      const act = all.map(m => m <= CUR_MONTH ? (monthVal(id, m)[k] ?? null) : null), sim = all.map(m => { const q = scPred(keys, m, 1); return q && q[k] != null ? Math.round(q[k]) : null; });
      chart('sc-c-' + k, { type: 'line', data: { labels, datasets: [{ label: '実績', data: act, borderColor: '#2f6fd1', backgroundColor: '#2f6fd1', tension: .2, pointRadius: 2, borderWidth: 2 }, { label: 'シミュレーション', data: sim, borderColor: '#d63b3b', backgroundColor: '#d63b3b', borderDash: [5, 4], tension: .2, pointRadius: 2, borderWidth: 2 }] },
        options: baseOpts({ scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 12 }, grid: { color: css('--grid') } }, y: yAxis(k) } }) }); });
  } };
}

/* ================= AIツール：AI MEDIAシミュレーション（2026-11-05 ユーザー指定） =================
   ダッシュボード「AIツール」の中。シミュレーション全体の流れ、答え合わせ（どの要素がずれたか・どこを直すか）、どのAIが答えを出したかを見せる。
   答え合わせはシミュレーションの画面から移した。AI（Claude・Gemini・OpenAI）はまだつないでいないので、いまの答えはルール計算（費用0） */
const AI_VIEWS = [{ id: 'ai-sim', l: 'AI MEDIAシミュレーション' }, { id: 'ai-errcheck', l: 'AIエラーチェッカー' }];   /* AIエラーチェッカー（2026-11-13 ユーザー指定） */
/** 答え合わせで見る要素（つながりの順）。r＝実績÷予測の比べ方、min＝件数が少ないと判定しない */
const AI_CHAIN = [
  { k: 'articles', l: '記事数', val: o => o.articles, min: o => o.articles >= 1, fix: s => '記事数が予測より' + s + '。進行管理の遅れを確認し、予測を合わせるなら記事目標を見直す' },
  { k: 'pv', l: 'PV', val: o => o.pv, min: o => o.pv >= 100, fix: s => 'PVが予測より' + s + '。季節性・検索ボリューム・公開後の伸び方の前提を調整する' },
  { k: 'cvr', l: 'CV率', val: o => o.sessions > 0 && o.cv != null ? o.cv / o.sessions : null, min: o => o.cv >= 5, fix: s => 'CV率が予測より' + s + '。記事の導線（電話・申込ボタン）を確認、または予測に使うCV率を直近の実績に合わせる' },
  { k: 'callr', l: 'コール率', val: o => o.cv > 0 && o.kCalls != null ? o.kCalls / o.cv : null, min: o => o.kCalls >= 3, fix: s => 'CVからコールになる率が予測より' + s + '。kintoneの受付を確認、または借りている率（他メディアの率）を見直す' },
  { k: 'conr', l: '成約率', val: o => o.kCalls > 0 && o.contracts != null ? o.contracts / o.kCalls : null, min: o => o.contracts >= 2, fix: s => '成約率が予測より' + s + '。参考にしている成約率を見直す' },
  { k: 'unit', l: '1成約あたりの収益', val: o => o.contracts > 0 && o.revenue != null ? o.revenue / o.contracts : null, min: o => o.contracts >= 2, fix: s => '1成約あたりの収益が予測より' + s + '。単価の前提を見直す' }
];
const AI_TOL = 0.2;   /* ±20%をこえたら「ずれ」 */
const AI_MODELS = [
  ['Claude（Anthropic）', 'まとめ役：ずれの原因の説明と、計算ルールの調整案をつくる'],
  ['Gemini（Google）', '検索の動き・季節性・Ahrefsの数字のチェック'],
  ['OpenAI', '別の見方での検算（2つ目の意見）']
];
/** 答え合わせの日：対象月の翌月5日から（2026-11-05 ユーザー指定） */
/** 見出しの文字（ループ表示などの飾りを除く） */
const pageTitleText = () => { const t = $('page-title'); return t ? String((t.firstChild && t.firstChild.nodeType === 3 ? t.firstChild.textContent : t.textContent) || '').trim() : ''; };
const aiCheckable = ym => todayJst() >= shiftMonth(ym, 1) + '-05';
/** いまのループ：'inner'＝内ループ（AIの調整案をあなたが承認してから反映）、'outer'＝外ループ（完全自動化）。外ループにしたら 'outer' に変える（2026-11-05 ユーザー指定：内ループは黄色、外ループは緑） */
const AI_LOOP = 'inner';
let SIM_CHECKS = null, SIM_STORE = '', AI_CHECK_SYNCING = false;
const loadSimChecks = async () => { const r = await api('/sim/checks').catch(() => ({ checks: [] })); SIM_STORE = r.store || ''; return r.checks || []; };
/** 1か月分の答え合わせ（メディアごと）。画面と保存で同じ計算を使う */
function aiCheckData(ym) {
  const pc = r => r == null ? '—' : (r * 100).toFixed(0) + '%';
  return topIds().map(mid => {
    const p = scPred(new Set([simKey(mid)]), ym, 1); if (!p) return null;
    const a = Object.assign({}, monthVal(mid, ym)); a.articles = a.posts == null && a.rewrites == null && a.lite == null ? null : (a.posts || 0) + (a.rewrites || 0) + (a.lite || 0);
    const els = AI_CHAIN.map(c => { const pv = c.val(p), av = c.val(a); if (pv == null || !(pv > 0) || av == null) return { k: c.k, pred: pv, act: av, r: null, skip: true }; const r = av / pv; return { k: c.k, pred: pv, act: av, r, skip: !c.min(p) && !c.min(a), off: Math.abs(r - 1) > AI_TOL }; });
    const ce = els.find(e => e.r != null && !e.skip && e.off), cc = ce ? AI_CHAIN.find(c => c.k === ce.k) : null;
    const fix = cc ? cc.fix(ce.r < 1 ? '少ない（' + pc(ce.r) + '）' : '多い（' + pc(ce.r) + '）') : els.some(e => e.r != null && !e.skip) ? '大きなずれはありません（±20%以内）' : '件数が少なく、まだ判定できません';
    return { mid, media: simKey(mid), name: mediaName(mid), els, cause: ce ? ce.k : '', fix, revR: p.revenue > 0 && a.revenue != null ? a.revenue / p.revenue : null };
  }).filter(Boolean);
}
/** 5日をすぎた月の答え合わせを、まだ保存していなければ保存する（管理者の画面が裏で。5日以降のタスクの sim-checker がこれを読む） */
async function aiCheckSync() {
  if (AI_CHECK_SYNCING || !isAdmin() || (me && me._preview) || noMoney() || !MONTHLY) return; AI_CHECK_SYNCING = true;
  try {
    if (!SIM_PRED) SIM_PRED = (await api('/sim/predictions').catch(() => ({ rows: [] }))).rows || [];
    SIM_CHECKS = await loadSimChecks();
    const have = new Set(SIM_CHECKS.filter(c => (c.rows || []).length).map(c => c.ym));
    const yms = [...new Set((SIM_PRED || []).filter(r => r.scenario === 'ideal' && r.snapshot_ym <= r.ym).map(r => r.ym))].filter(ym => aiCheckable(ym) && !have.has(ym));
    for (const ym of yms) { const rows = aiCheckData(ym).map(r => { const o = Object.assign({}, r); delete o.mid; return o; }); if (rows.length) await apiSend('PUT', '/sim/checks/' + ym, { rows }).catch(() => null); }
    if (yms.length) SIM_CHECKS = await loadSimChecks();
  } catch (e) { console.warn('答え合わせの保存：' + e.message); } finally { AI_CHECK_SYNCING = false; }
}
/* ===== AIチーム・KPI・月ごとのトークンと費用（2026-11-06 ユーザー指定） =====
   ・いちばん上に、どのエージェント・サブエージェントが動いているか（編集部のキャラ：編集長＝指揮官、検証デスク、検索リサーチャー、校閲）
   ・KPI：費用（このループで使ったトークン・円）は前の月より減らす／精度＝「がんばれば届く、でも無謀ではない」
   ・精度の基準：実績÷予測が 85%〜110%＝ちょうどいい背伸び。85%未満＝無謀（高すぎ）、110%超＝甘い（低すぎ）。項目は 記事数・PV・収益。
     届いた割合（100%以上）は 3〜6割が理想（いつも届く＝甘い、ほとんど届かない＝無謀） */
const AI_BAND = [0.85, 1.10], AI_ACC_GOAL = 0.7, AI_REACH = [0.3, 0.6];
const AI_ACC_ITEMS = [['articles', '記事数'], ['pv', 'PV'], ['rev', '収益']];
/** その月の答え合わせの表から精度を出す（メディア×項目のうち、帯に入った割合） */
function aiAccuracy(check) {
  const rs = []; (check && check.rows || []).forEach(r => AI_ACC_ITEMS.forEach(([k, l]) => { const e = k === 'rev' ? { r: r.revR } : (r.els || []).find(x => x.k === k) || {}; if (e.r != null && Number.isFinite(e.r) && !e.skip) rs.push({ media: r.name || r.media, k: l, r: e.r }); }));
  if (!rs.length) return null;
  const inB = rs.filter(x => x.r >= AI_BAND[0] && x.r <= AI_BAND[1]).length, hi = rs.filter(x => x.r < AI_BAND[0]).length, lo = rs.filter(x => x.r > AI_BAND[1]).length;
  return { n: rs.length, acc: inB / rs.length, reach: rs.filter(x => x.r >= 1).length / rs.length, tooHigh: hi, tooLow: lo, list: rs };
}
const AI_ST = { working: ['作業中', 'ai-st-work'], done: ['完了', 'ok'], error: ['エラー', 'ng'], idle: ['待機中', 'off'], off: ['未接続', 'wait'] };
/** トークンの数（1.2万 など） */
const tokFmt = n => n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(1) + '億' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + '万' : nf.format(n);
/** ドル → 円（その月のレート）。円を先、ドルは括弧で */
const aiYen = (usd, ym, fx) => usd == null ? '—' : (fx[ym] ? '¥' + nf.format(Math.round(usd * fx[ym])) + ' ' : '') + '<span class="note">($' + usd.toFixed(usd < 1 ? 3 : 2) + ')</span>';
/** キャラの絵（オリジナルのキャラ。色と飾りで見分ける。2026-11-06 ユーザー指定：覚えやすく、Claude＝オレンジ・Gemini＝青・OpenAI＝緑。既存のゲームのキャラは使わない） */
function aiCreature(a, size) {
  /* キャラの絵（2026-11-06 ユーザー指定：頭がまっすぐ上にとがった丸いゼリー。先は曲げない・口は小さいにっこり・目は光の点なしの黒い点。
     指揮官は王冠（宝石3つ）・ヘッドセット・指揮棒。検証＝虫めがね、探索＝アンテナ、検閲＝泡とペン。既存のゲームのキャラに寄せない） */
  const c = a.color, g = 'g' + a.id + (size || 0), lead = a.kind === 'agent';
  const body = lead ? 'M0 -72 C8 -50 56 -30 56 12 C56 46 30 58 0 58 C-30 58 -56 46 -56 12 C-56 -30 -8 -50 0 -72 Z' : 'M0 -60 C7 -42 46 -24 46 10 C46 38 24 49 0 49 C-24 49 -46 38 -46 10 C-46 -24 -7 -42 0 -60 Z';
  const k = lead ? 1.2 : 1, ey = 8 * k, ex = 14 * k, bot = lead ? 58 : 49;
  const face = '<ellipse cx="' + (-24 * k) + '" cy="' + (-10 * k) + '" rx="' + (8 * k) + '" ry="' + (13 * k) + '" transform="rotate(-25 ' + (-24 * k) + ' ' + (-10 * k) + ')" fill="#fff" opacity=".45"/>'
    + '<circle cx="' + (-ex) + '" cy="' + ey + '" r="' + (lead ? 4 : 3.6) + '" fill="#2a211c"/><circle cx="' + ex + '" cy="' + ey + '" r="' + (lead ? 4 : 3.6) + '" fill="#2a211c"/>'
    + '<ellipse cx="' + (-26 * k) + '" cy="' + (20 * k) + '" rx="' + (7 * k) + '" ry="' + (4 * k) + '" fill="#ff7a8a" opacity=".45"/><ellipse cx="' + (26 * k) + '" cy="' + (20 * k) + '" rx="' + (7 * k) + '" ry="' + (4 * k) + '" fill="#ff7a8a" opacity=".45"/>'
    + '<path d="M' + (-6 * k) + ' ' + (18 * k) + ' Q0 ' + (24 * k) + ' ' + (6 * k) + ' ' + (18 * k) + '" stroke="#2a211c" stroke-width="2.4" fill="none" stroke-linecap="round"/>';
  const back = '';
  const front = lead
    ? '<path d="M-57 -2 C-57 -36 -32 -54 0 -55 C32 -54 57 -36 57 -2" stroke="#33302c" stroke-width="5" fill="none" stroke-linecap="round"/><rect x="-63" y="-10" width="12" height="22" rx="5" fill="#33302c"/><rect x="51" y="-10" width="12" height="22" rx="5" fill="#33302c"/>'
      + '<path d="M-58 12 Q-54 36 -30 38" stroke="#33302c" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="-28" cy="38" r="4.5" fill="#33302c"/>'
      + '<path d="M-26 -52 L-31 -84 L-14 -68 L0 -94 L14 -68 L31 -84 L26 -52 Z" fill="#f6c343" stroke="#b7860b" stroke-width="2" stroke-linejoin="round"/>'
      + '<circle cx="-14" cy="-60" r="3.8" fill="#e2453c"/><circle cx="0" cy="-62" r="3.8" fill="#2f7de1"/><circle cx="14" cy="-60" r="3.8" fill="#1fa463"/>'
      + '<path d="M50 40 L74 4" stroke="#5b4636" stroke-width="4" stroke-linecap="round"/><circle cx="75" cy="2" r="4.5" fill="#fff" stroke="#b7860b" stroke-width="2"/>'
    : a.deco === 'lens' ? '<g transform="translate(46 26) rotate(-25)"><circle r="12" fill="rgba(255,255,255,.55)" stroke="#5b4636" stroke-width="3.5"/><rect x="-2.5" y="11" width="5" height="15" rx="2.5" fill="#5b4636"/></g>'
    : a.deco === 'antenna' ? '<path d="M20 -30 Q30 -46 34 -62" stroke="#33415c" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="35" cy="-65" r="5.5" fill="#ffd34d" stroke="#33415c" stroke-width="2"/>'
    : a.deco === 'bubble' ? '<circle cx="-46" cy="-28" r="6" fill="none" stroke="' + c + '" stroke-width="2" opacity=".7"/><circle cx="-56" cy="-8" r="3.5" fill="none" stroke="' + c + '" stroke-width="1.8" opacity=".6"/><circle cx="42" cy="-40" r="4.5" fill="none" stroke="' + c + '" stroke-width="1.8" opacity=".6"/>'
      + '<path d="M36 44 L60 12" stroke="#33415c" stroke-width="5" stroke-linecap="round"/><path d="M36 44 L33 50 L39 47 Z" fill="#33415c"/>'
    : '';
  const inner = a.deco === 'bubble' ? '<circle cx="-8" cy="32" r="4" fill="#fff" opacity=".35"/><circle cx="14" cy="38" r="3" fill="#fff" opacity=".3"/>' : '';
  const px = size || (lead ? 112 : 88);
  return '<svg class="ai-mon" viewBox="-80 -100 160 165" width="' + px + '" height="' + Math.round(px * 165 / 160) + '" aria-hidden="true">'
    + '<defs><radialGradient id="' + g + '" cx="38%" cy="35%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".35" stop-color="' + c + '"/><stop offset="1" stop-color="' + c + '" stop-opacity="' + (a.deco === 'bubble' ? '.82' : '1') + '"/></radialGradient></defs>'
    + '<ellipse cx="0" cy="' + (bot + 3) + '" rx="' + (lead ? 46 : 38) + '" ry="5" fill="#000" opacity=".12"/>' + back
    + '<g class="ai-mon-body"><path d="' + body + '" fill="url(#' + g + ')" stroke="rgba(0,0,0,.18)" stroke-width="1.4"/>' + inner + face + '</g>' + front + '</svg>';
}
/** 表などで使う小さいキャラ */
const aiMini = a => a ? '<span class="ai-mini">' + aiCreature(a, 22) + esc(a.char) + '</span>' : '';
/** 今月（日本時間）の実行の記録 */
function aiMonthRuns(T) {
  const ym = fmtJst(new Date().toISOString()).slice(0, 7);
  const runs = (T.runs || []).filter(r => fmtJst(r.started_at).slice(0, 7) === ym);
  const cost = (T.cost || []).filter(c => c.run_id && runs.some(r => r.run_id === c.run_id));
  return { ym, runs, cost };
}
/** いちばん上：AIチーム（ステージにキャラ。動いているときは線にデータが流れる）（2026-11-06 ユーザー指定：視覚的にAIっぽく、わくわくする感じ） */
function aiTeamHtml(T, withMonth) {
  const run = (T.runs || [])[0], live = run && run.status === 'running' && Date.now() - new Date(run.started_at).getTime() < 3 * 3600 * 1000;
  const M = aiMonthRuns(T), tokOf = id => M.cost.filter(c => c.agent === id).reduce((s, c) => s + (c.tokens_in || 0) + (c.tokens_out || 0), 0);
  const maxTok = Math.max(1, ...T.agents.map(a => tokOf(a.id)));
  const PV = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };
  const unit = a => {
    const ra = live ? (run.agents || {})[a.id] || {} : {}, st = !a.connected ? 'off' : live ? ra.status || 'idle' : 'idle', S = AI_ST[st] || AI_ST.idle;
    const tok = tokOf(a.id), times = M.runs.filter(r => (r.agents || {})[a.id]).length, yen = M.cost.filter(c => c.agent === a.id).reduce((x, c) => x + (Number(c.usd) || 0) * ((T.fx || {})[String(c.at || '').slice(0, 7)] || 0), 0);   /* 費用（円・API換算）もトークンの横に（2026-11-06 ユーザー指定） */
    const say = st === 'working' ? (ra.purpose || (a.kind === 'agent' ? '全体を見ています…' : 'データを読んでいます…')) : st === 'done' ? 'できました！' : st === 'error' ? 'うまくいきませんでした…' : st === 'off' ? 'キーを入れると動けます' : a.kind === 'agent' ? '次の答え合わせを待っています' : '出番を待っています';
    return '<div class="ai-unit st-' + st + (a.kind === 'agent' ? ' lead' : '') + '" style="--c:' + a.color + '">'
      + '<div class="ai-say">' + esc(say) + '</div>' + aiCreature(a)
      + '<div class="ai-plate"><b>' + esc(a.char) + '</b>' + (a.role && !String(a.char).includes(a.role) ? '<span class="ai-role">' + esc(a.role) + '</span>' : '') + '</div>'
      + '<div class="ai-chips"><span class="ai-prov p-' + a.provider + '">' + PV[a.provider] + '</span><span class="ai-model">' + esc(a.model) + '</span><span class="pill ' + S[1] + '">' + S[0] + '</span></div>'
      + '<div class="ai-stat"><span>今月 ' + times + '回</span><span>' + tokFmt(tok) + ' トークン・¥' + nf.format(Math.round(yen)) + '</span></div><div class="ai-bar"><i style="width:' + Math.round(tok / maxTok * 100) + '%"></i></div>'
      + '<div class="ai-pos">' + esc(a.position) + '</div></div>';
  };
  const lead = T.agents.filter(a => a.kind === 'agent'), subs = T.agents.filter(a => a.kind !== 'agent'), n = subs.length;
  /* 指揮官 → サブエージェントの線（作業中の相手への線にデータが流れる） */
  const wires = '<svg class="ai-wires" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">' + subs.map((a, i) => { const x = (i + 0.5) * 300 / n, on = live && ((run.agents || {})[a.id] || {}).status === 'working';
    return '<path class="' + (on ? 'flow' : '') + '" d="M150 0 C150 22 ' + x + ' 16 ' + x + ' 40" stroke="' + a.color + '" />'; }).join('') + '</svg>';
  const runTxt = !run ? 'まだ実行していません。最初の出番は 12/05（2026/11分の答え合わせ）です' : live ? '答え合わせ中（' + esc(fmtJst(run.started_at)) + ' 開始・' + mLabel(run.ym) + '分）' : '最後の実行：' + esc(fmtJst(run.started_at)) + '（' + mLabel(run.ym) + '分・' + (run.status === 'done' ? '完了' : run.status === 'error' ? 'エラー' : esc(run.status || '')) + '）';
  /* 今月の実行（キャラごと：回数・内訳・最終実行・トークン）（2026-11-06 ユーザー指定：今日ではなく今月） */
  const rows = T.agents.map(a => { const rs = M.runs.filter(r => (r.agents || {})[a.id]), ok = rs.filter(r => r.agents[a.id].status === 'done').length, ng = rs.filter(r => r.agents[a.id].status === 'error').length, wk = rs.length - ok - ng;
    const last = rs[0], tok = tokOf(a.id);
    return '<tr><th class="pm-name">' + aiMini(a) + '</th><td class="c-ctr">' + rs.length + '</td><td class="c-ctr">' + (rs.length ? (ok ? '✅' + ok + ' ' : '') + (ng ? '❌' + ng + ' ' : '') + (wk ? '⏳' + wk : '') : '<span class="note">—</span>') + '</td><td class="c-ctr">' + (last ? esc(fmtJst(last.started_at).slice(5)) : '—') + '</td><td class="c-num">' + (tok ? tokFmt(tok) + '<div class="note">¥' + nf.format(Math.round(M.cost.filter(c => c.agent === a.id).reduce((x, c) => x + (Number(c.usd) || 0) * ((T.fx || {})[String(c.at || '').slice(0, 7)] || 0), 0))) + '</div>' : '—') + '</td></tr>'; }).join('');
  if (withMonth === 'only') return '<section class="panel">' + H('今月の実行 <small>' + M.ym + '・キャラごとに動いた回数と結果</small>', ['Supabase']) + '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:190px"><col style="width:90px"><col style="width:150px"><col style="width:130px"><col style="width:130px"></colgroup><thead><tr><th class="pm-name">キャラ</th><th class="c-ctr">回数</th><th class="c-ctr">内訳</th><th class="c-ctr">最終実行</th><th class="c-num">トークン・費用</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="note">✅成功・❌エラー・⏳実行中。答え合わせは毎月5日以降に1回なので、ふだんは月1回です。</p></section>';
  const month = '<h3 class="am-h">今月の実行 <span class="note">' + M.ym + '・答え合わせのタスクでキャラが動いた回数</span></h3><div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:190px"><col style="width:90px"><col style="width:150px"><col style="width:130px"><col style="width:130px"></colgroup><thead><tr><th class="pm-name">キャラ</th><th class="c-ctr">回数</th><th class="c-ctr">内訳</th><th class="c-ctr">最終実行</th><th class="c-num">トークン</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  return '<section class="panel ai-team-panel">' + H('AIチーム <small>' + runTxt + '</small>', ['Supabase'])
    + '<div class="ai-stage' + (live ? ' live' : '') + '"><div class="ai-stage-tag">' + (live ? '<i></i>LIVE 答え合わせ中' : 'STANDBY') + '</div>'
    + '<div class="ai-row lead-row">' + lead.map(unit).join('') + '</div>' + wires + '<div class="ai-row subs-row">' + subs.map(unit).join('') + '</div></div>'
    + (withMonth ? month : '') + '<p class="note">' + esc((lead[0] || {}).char || '指揮官') + '（指揮官）が、サブエージェントごとに必要なデータだけを切り出して渡します。作業中のキャラは跳ねて、指揮官からの線にデータが流れます。灰色は未接続です。</p></section>';
}
function fmtJst(iso) { if (!iso) return ''; const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString(); return d.slice(0, 10).replace(/-/g, '/') + ' ' + d.slice(11, 16); }
/** KPI と 月ごとの表（トークン・費用・精度・使ったモデル） */
function aiKpiHtml(T, checks, part) {
  const byM = {};   /* 対象月（答え合わせした月）ごと */
  (T.runs || []).forEach(r => { const o = byM[r.ym] = byM[r.ym] || { ym: r.ym, runs: [], cost: [] }; o.runs.push(r); });
  (T.cost || []).filter(c => c.run_id).forEach(c => { const r = (T.runs || []).find(x => x.run_id === c.run_id); const ym = r ? r.ym : String(c.run_id).slice(0, 7); const o = byM[ym] = byM[ym] || { ym, runs: [], cost: [] }; o.cost.push(c); });
  checks.filter(c => (c.rows || []).length).forEach(c => { byM[c.ym] = byM[c.ym] || { ym: c.ym, runs: [], cost: [] }; byM[c.ym].check = c; });
  const months = Object.values(byM).sort((a, b) => b.ym.localeCompare(a.ym));
  months.forEach(m => { const s = k => m.cost.reduce((x, c) => x + (Number(c[k]) || 0), 0); m.tin = s('tokens_in'); m.tout = s('tokens_out'); m.cr = s('cache_read'); m.cw = s('cache_write'); m.tok = m.tin + m.tout + m.cw; m.usd = m.cost.some(c => c.usd != null) ? s('usd') : null;
    m.yen = m.usd == null ? null : m.cost.reduce((x, c) => x + (Number(c.usd) || 0) * (T.fx[String(c.at || '').slice(0, 7)] || 0), 0); m.acc = aiAccuracy(m.check);
    m.models = {}; m.cost.forEach(c => { const a = T.agents.find(x => x.id === c.agent); const k = a ? a.char : c.agent; m.models[k] = m.models[k] || new Set(); m.models[k].add(c.model); }); });
  const withAcc = months.filter(m => m.acc), withCost = months.filter(m => m.cost.length);
  const cur = withAcc[0], prev = withAcc[1], cc = withCost[0], cp = withCost[1];
  const delta = (a, b, lowerBetter, pct) => a == null || b == null || !b ? '' : (() => { const d = pct ? a - b : (a - b) / b, good = lowerBetter ? d < 0 : d > 0; return '<span class="' + (d === 0 ? 'note' : good ? 'v-plus' : 'v-minus') + '">前の月より ' + (d > 0 ? '+' : '') + (d * 100).toFixed(0) + (pct ? 'pt' : '%') + '</span>'; })();
  const kpi = (lbl, val, sub, goal) => '<div class="kpi"><div class="lbl"><span>' + lbl + '</span></div><div class="val">' + val + '</div><div class="note">' + sub + '</div><div class="note">' + goal + '</div></div>';
  const accCls = a => a == null ? '' : a >= AI_ACC_GOAL ? 'v-plus' : 'v-minus';
  const cards = '<section class="kpis">'
    + kpi('精度（ちょうどいい背伸び）', cur ? '<span class="' + accCls(cur.acc.acc) + '">' + (cur.acc.acc * 100).toFixed(0) + '%</span>' : '—', cur ? mLabel(cur.ym) + '分・' + cur.acc.n + '項目 ' + delta(cur.acc.acc, prev && prev.acc.acc, false, true) : 'まだ答え合わせの月がありません', '目標 ' + Math.round(AI_ACC_GOAL * 100) + '%以上（実績÷予測が ' + Math.round(AI_BAND[0] * 100) + '〜' + Math.round(AI_BAND[1] * 100) + '%）')
    + kpi('届いた割合', cur ? (cur.acc.reach * 100).toFixed(0) + '%' : '—', cur ? '無謀（高すぎ）' + cur.acc.tooHigh + '・甘い（低すぎ）' + cur.acc.tooLow : '—', '理想 ' + Math.round(AI_REACH[0] * 100) + '〜' + Math.round(AI_REACH[1] * 100) + '%（半分くらい届く）')
    + kpi('トークン（このループだけ）', cc ? tokFmt(cc.tok) : '—', cc ? mLabel(cc.ym) + '分 ' + delta(cc.tok, cp && cp.tok, true) : 'まだ記録がありません', '前の月より減らす')
    + kpi('費用（このループだけ）', cc && cc.yen != null ? '¥' + nf.format(Math.round(cc.yen)) : '—', cc ? (cc.usd != null ? '($' + cc.usd.toFixed(2) + ') ' : '') + delta(cc.yen, cp && cp.yen, true) : '—', '前の月より減らす（Claude は定額のためAPI換算）')
    + '</section>';
  const rows = months.map(m => '<tr><th class="pm-name">' + mLabel(m.ym) + '</th><td class="c-ctr">' + (m.runs.length || '—') + '</td>'
    + '<td class="ai-models">' + (Object.keys(m.models).length ? Object.entries(m.models).map(([k, v]) => '<div><b>' + esc(k) + '</b>：' + esc([...v].join('・')) + '</div>').join('') : '<span class="note">—</span>') + '</td>'
    + '<td class="c-num">' + (m.cost.length ? tokFmt(m.tin) : '—') + '</td><td class="c-num">' + (m.cost.length ? tokFmt(m.tout) : '—') + '</td><td class="c-num">' + (m.cost.length ? tokFmt(m.cr) + ' / ' + tokFmt(m.cw) : '—') + '</td>'
    + '<td class="c-num">' + (m.yen != null ? '¥' + nf.format(Math.round(m.yen)) : '—') + (m.usd != null ? '<div class="note">($' + m.usd.toFixed(2) + ')</div>' : '') + '</td>'
    + '<td class="c-ctr">' + (m.acc ? '<span class="' + accCls(m.acc.acc) + '">' + (m.acc.acc * 100).toFixed(0) + '%</span>' : '—') + '</td><td class="c-ctr">' + (m.acc ? (m.acc.reach * 100).toFixed(0) + '%' : '—') + '</td></tr>');
  if (part === 'cards') return '<section class="panel">' + H('成績（KPI） <small>予測がちょうどいい目標になっているか・AIにいくらかかったか</small>') + cards.replace('<section class="kpis">', '<div class="kpis">').replace(/<\/section>$/, '</div>')
    + '<p class="note"><b>精度</b>＝実績÷予測が ' + Math.round(AI_BAND[0] * 100) + '〜' + Math.round(AI_BAND[1] * 100) + '%（がんばれば届く、でも無謀ではない）に入った割合。<b>トークン・費用</b>＝答え合わせでAIが使った量（少ないほど良い）。月ごとの細かい数字は「記録」のタブにあります。</p></section>';
  return (part === 'table' ? '' : cards) + '<section class="panel">' + H('月ごとのトークン・費用・精度・モデル <small>答え合わせした月ごと。このループ（run_id のついた実行）で使った分だけ</small>', ['Supabase'])
    + (rows.length ? '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:110px"><col style="width:70px"><col style="width:300px"><col style="width:100px"><col style="width:100px"><col style="width:140px"><col style="width:120px"><col style="width:90px"><col style="width:90px"></colgroup><thead><tr><th class="pm-name">月</th><th class="c-ctr">実行</th><th>使ったモデル</th><th class="c-num">入力</th><th class="c-num">出力</th><th class="c-num">キャッシュ 読み／作成</th><th class="c-num">費用</th><th class="c-ctr">精度</th><th class="c-ctr">届いた割合</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' : '<p class="empty">まだ記録がありません。最初の答え合わせ（12/05 に 2026/11 分）から入ります。</p>')
    + '<p class="note"><b>精度の考え方</b>：シミュレーションは「完全に当てる」ことではなく、<b>がんばれば届く、でも無謀ではない目標</b>であることを目指します。実績÷予測が ' + Math.round(AI_BAND[0] * 100) + '〜' + Math.round(AI_BAND[1] * 100) + '% なら「ちょうどいい背伸び」として精度に数え、' + Math.round(AI_BAND[0] * 100) + '%未満は目標が高すぎ（無謀）、' + Math.round(AI_BAND[1] * 100) + '%超は低すぎ（甘い）とします。項目は 記事数・PV・収益。届いた割合（100%以上）は半分くらい（' + Math.round(AI_REACH[0] * 100) + '〜' + Math.round(AI_REACH[1] * 100) + '%）が理想です。</p>'
    + '<p class="note">トークン・費用は、このループの実行（run_id）で使った分だけです（ほかの作業のClaude・ChatGPTの利用は入りません）。Claude はこのPCの定額で動かしているため、金額はAPIで使った場合の換算です。Gemini・OpenAI はこのループ専用のキーで、公開価格からの目安です。</p></section>';
}
/* ================= AIツール：AIエラーチェッカー（2026-11-13 ユーザー指定） =================
   週に1回（月曜12:00・タスクスケジューラー）、エラチェ・クロード指揮官（Claude Code）とエラチェ・コーデックス検証（CODEX）が、コードの変更・ログ・データの食い違いを点検。
   AI MEDIAシミュレーションと同じく Supabase＝AIの作業机（受付係 scripts/err_check_fs.js）。いまは内ループ：指摘に OK／却下（理由）をつけ、OKしたものをチャットで直す */
const ERR_LOOP = 'inner';   /* 'inner'＝内ループ（あなたがOKした指摘だけ直す）、'outer'＝外ループ（自動で直す）。scripts/err_check_fs.js の LOOP と同じに */
const ERR_ST = { open: ['判断待ちあり', 'ng'], ok: ['問題なし', 'ok'], running: ['点検中', 'ai-st-work'], incomplete: ['AIの報告を読めず', 'wait'] };
function viewErrCheck() {
  return { html: '<section class="panel" id="ec-team"><p class="loading">読み込み中…</p></section><div id="ec-kpi"></div><section class="panel" id="ec-list"></section><section class="panel" id="ec-detail" hidden></section><section class="panel" id="ec-access"></section>', view: 'AIエラーチェッカー', after: async () => {
    if ($('page-title') && !$('ai-loop')) $('page-title').insertAdjacentHTML('beforeend', '<span id="ai-loop" class="loop-badge ' + ERR_LOOP + '" title="' + (ERR_LOOP === 'outer' ? '指摘の修正まで自動' : 'AIの指摘は、あなたがOKしてから直す') + '">' + (ERR_LOOP === 'outer' ? '外ループ（完全自動化）' : '内ループ') + '</span>');
    const seq = renderSeq; let T;
    try { T = await api('/errcheck'); } catch (e) { $('ec-team').innerHTML = '<p class="err">読み込めませんでした：' + esc(e.message) + '</p>'; return; }
    if (seq !== renderSeq) return;
    if (!T.ready) { $('ec-team').innerHTML = H('AIエラーチェッカー', ['Supabase']) + '<p class="empty">Supabase に表がまだありません。管理 →「API・連携設定」の Supabase の枠に出ている SQL を、Supabase の SQL Editor で1回実行してください（何度実行しても大丈夫）。</p>'; ['ec-list', 'ec-access'].forEach(id => { $(id).innerHTML = ''; }); return; }
    const fx = T.fx || {}, yenOf = rows => rows.reduce((x, c) => x + (Number(c.usd) || 0) * (fx[String(c.at || '').slice(0, 7)] || 0), 0), tokOf = rows => rows.reduce((x, c) => x + (Number(c.tokens_in) || 0) + (Number(c.tokens_out) || 0) + (Number(c.cache_write) || 0), 0);
    const ym = fmtJst(new Date().toISOString()).slice(0, 7), mRuns = T.runs.filter(r => fmtJst(r.started_at).slice(0, 7) === ym), mCost = T.cost.filter(c => mRuns.some(r => r.run_id === c.run_id));
    const run = T.runs[0], live = run && run.status === 'running' && Date.now() - new Date(run.started_at).getTime() < 3 * 3600 * 1000;
    /* チーム（キャラ） */
    const unit = a => { const ra = live ? (run.agents || {})[a.id] || {} : {}, st = live ? ra.status || 'idle' : 'idle', S = AI_ST[st] || AI_ST.idle, c = mCost.filter(x => x.agent === a.id);
      const say = st === 'working' ? '点検しています…' : a.kind === 'agent' ? '次の点検は月曜12:00です' : 'クロード指揮官とは別に見ます';
      return '<div class="ai-unit st-' + st + (a.kind === 'agent' ? ' lead' : '') + '" style="--c:' + a.color + '"><div class="ai-say">' + esc(say) + '</div>' + aiCreature(a)
        + '<div class="ai-plate"><b>' + esc(a.char) + '</b></div><div class="ai-chips"><span class="ai-prov p-' + a.provider + '">' + (a.provider === 'openai' ? 'OpenAI（CODEX）' : 'Claude（Claude Code）') + '</span><span class="pill ' + S[1] + '">' + S[0] + '</span></div>'
        + '<div class="ai-stat"><span>今月 ' + mRuns.filter(r => (r.agents || {})[a.id]).length + '回</span><span>' + tokFmt(tokOf(c)) + ' トークン・¥' + nf.format(Math.round(yenOf(c))) + '</span></div><div class="ai-pos">' + esc(a.position) + '</div></div>'; };
    const lead = T.agents.filter(a => a.kind === 'agent'), subs = T.agents.filter(a => a.kind !== 'agent');
    $('ec-team').innerHTML = H('AIチーム <small>' + (run ? (live ? '点検中（' + esc(fmtJst(run.started_at)) + ' 開始）' : '最後の点検：' + esc(fmtJst(run.started_at))) : 'まだ点検していません') + '</small>', ['Supabase'])
      + '<div class="ai-stage' + (live ? ' live' : '') + '"><div class="ai-stage-tag">' + (live ? '<i></i>LIVE 点検中' : 'STANDBY') + '</div><div class="ai-row lead-row">' + lead.map(unit).join('') + '</div>'
      + '<svg class="ai-wires" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">' + subs.map((a, i) => '<path class="' + (live ? 'flow' : '') + '" d="M150 0 C150 22 ' + ((i + 0.5) * 300 / subs.length) + ' 16 ' + ((i + 0.5) * 300 / subs.length) + ' 40" stroke="' + a.color + '" />').join('') + '</svg>'
      + '<div class="ai-row subs-row">' + subs.map(unit).join('') + '</div></div>'
      + '<p class="note">毎週月曜12:00に、このPCのタスクスケジューラーから動きます。受付係が Supabase から点検の材料（コードの変更・ログ・データの食い違い）とこれまでに却下した指摘だけを2人に渡し、2人は別々に点検します。本番のデータはさわりません。</p>';
    /* KPI（今月の回数・指摘・トークン・費用） */
    const mChecks = T.checks.filter(c => fmtJst(c.at).slice(0, 7) === ym), kpi = (l, v, sub) => '<div class="kpi"><div class="lbl"><span>' + l + '</span></div><div class="val">' + v + '</div><div class="note">' + sub + '</div></div>';
    const openAll = T.checks.reduce((x, c) => x + (c.open || 0), 0), usd = mCost.some(c => c.usd != null) ? mCost.reduce((x, c) => x + (Number(c.usd) || 0), 0) : null;
    $('ec-kpi').innerHTML = '<section class="kpis">' + kpi('今月の点検', mChecks.length + '回', ym.replace('-', '年') + '月') + kpi('判断待ちの指摘', '<span class="' + (openAll ? 'v-minus' : 'v-plus') + '">' + openAll + '件</span>', 'OK／却下をつけてください')
      + kpi('トークン（今月）', tokFmt(tokOf(mCost)), 'Claude Code・CODEX の合計') + kpi('費用（今月）', '¥' + nf.format(Math.round(yenOf(mCost))), (usd != null ? '($' + usd.toFixed(2) + ') ' : '') + 'Claude は定額のためAPI換算・CODEX は ChatGPT の定額') + '</section>';
    /* 点検の一覧 */
    const costOfRun = id => T.cost.filter(c => c.run_id === 'err-' + id);
    $('ec-list').innerHTML = H('点検の記録 <small>新しい順・行を押すと中身</small>', ['Supabase']) + (T.checks.length ? '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:150px"><col style="width:130px"><col style="width:90px"><col style="width:80px"><col style="width:150px"><col style="width:110px"><col style="width:110px"></colgroup><thead><tr><th class="pm-name">点検した日時</th><th>状態</th><th>指摘</th><th>うち高</th><th>OK／却下／判断待ち</th><th>トークン</th><th>費用</th></tr></thead><tbody>'
      + T.checks.map(c => { const S = c.status === 'open' && !c.open ? ['判断済み', 'ok'] : ERR_ST[c.status] || ['—', 'off'],   /* 全部判断したら「判断済み」（2026-11-16 指摘 #7） */ cr = costOfRun(c.run_id); return '<tr class="ol-lkrow' + (state.errRun === c.run_id ? ' on' : '') + '" data-ecrun="' + esc(c.run_id) + '"><th class="pm-name">' + esc(fmtJst(c.at)) + '<div class="note">' + esc((c.summary || {}).kind || '週次の点検') + '</div></th><td class="c-ctr"><span class="pill ' + S[1] + '">' + S[0] + '</span></td><td class="c-ctr">' + (c.findings || 0) + '</td><td class="c-ctr">' + (c.high ? '<b class="v-minus">' + c.high + '</b>' : '0') + '</td><td class="c-ctr">' + c.ok + '／' + c.ng + '／<b>' + c.open + '</b></td><td class="c-num">' + tokFmt(tokOf(cr)) + '</td><td class="c-num">¥' + nf.format(Math.round(yenOf(cr))) + '</td></tr>'; }).join('')
      + '</tbody></table></div>' : '<p class="empty">まだ点検していません。</p>');
    document.querySelectorAll('[data-ecrun]').forEach(tr => tr.onclick = () => { state.errRun = tr.dataset.ecrun; document.querySelectorAll('[data-ecrun]').forEach(x => x.classList.toggle('on', x === tr)); errDetail(T); });
    /* だれが何を読んだか */
    const nm = id => { const a = T.agents.find(x => x.id === id); return a ? aiMini(a) : esc(id === 'receptionist' ? '受付係' : id || ''); };
    const lr = T.runs.find(r => T.access.some(a => a.run_id === r.run_id)), logs = lr ? T.access.filter(a => a.run_id === lr.run_id) : [];
    $('ec-access').innerHTML = H('Supabase：どのAIが何を読んだか' + (lr ? ' <small>' + esc(fmtJst(lr.started_at)) + ' の点検</small>' : ''), ['Supabase'])
      + (logs.length ? '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:120px"><col style="width:220px"><col style="width:120px"><col style="width:140px"><col style="width:60px"><col style="width:200px"><col style="width:240px"></colgroup><thead><tr><th class="pm-name">日時</th><th>読んだAI</th><th>渡した</th><th>表</th><th>件数</th><th>項目</th><th>目的</th></tr></thead><tbody>'
        + logs.slice().reverse().map(l => '<tr><th class="pm-name">' + esc(fmtJst(l.at).slice(5)) + '</th><td>' + nm(l.agent) + '</td><td>' + nm(l.by_agent) + '</td><td><code>' + esc(l.tbl) + '</code></td><td class="c-ctr">' + (l.rows == null ? '—' : l.rows) + '</td><td>' + esc(l.cols || '') + '</td><td>' + esc(l.purpose || '') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">まだ記録がありません。</p>')
      + '<h3 class="am-h">ポジションごとの読める範囲</h3><div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:240px"><col style="width:300px"><col style="width:200px"></colgroup><thead><tr><th class="pm-name">キャラ</th><th>読める</th><th>書ける</th></tr></thead><tbody>'
      + T.agents.map(a => '<tr><th class="pm-name">' + aiMini(a) + '</th><td>' + a.ceiling.read.map(t => '<code>' + t + '</code>').join(' ') + '</td><td>' + (a.ceiling.write.length ? a.ceiling.write.map(t => '<code>' + t + '</code>').join(' ') : '<span class="note">なし</span>') + '</td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note">AIは Supabase を直接さわらず、受付係（scripts/err_check_fs.js）を通してだけ読み書きします。指摘（err_findings）を書くのも受付係です。</p>';
    if (state.errRun || T.checks[0]) { state.errRun = state.errRun || T.checks[0].run_id; document.querySelectorAll('[data-ecrun]').forEach(x => x.classList.toggle('on', x.dataset.ecrun === state.errRun)); errDetail(T); }
  } };
}
/** 1回分の点検：指摘ごとに OK／却下（理由）。AIの報告と点検の材料も見られる */
async function errDetail(T) {
  const box = $('ec-detail'), run = state.errRun; if (!box || !run) return; box.hidden = false; box.innerHTML = '<p class="loading">読み込み中…</p>';
  let d; try { d = await api('/errcheck/' + encodeURIComponent(run)); } catch (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
  if (state.errRun !== run) return;
  const c = d.check, ag = id => T.agents.find(a => a.id === id), lv = { 高: 'ng', 中: 'wait', 低: 'off' };
  const reps = c.reports || {}, sum = c.summary || {};
  box.innerHTML = H(esc(fmtJst(c.at)) + ' の' + esc((c.summary || {}).kind || '週次の点検') + ' <small>指摘 ' + d.findings.length + '件</small>', ['Supabase'])
    + '<p class="note">構文エラー ' + (sum.syntaxErrors || 0) + '件・変更したファイル ' + (sum.diffFiles || 0) + '・Cloud Run のエラー ' + (sum.logErrors || 0) + '件（500番台 ' + (sum.server5xx || 0) + '）・定期実行の失敗 ' + (sum.jobFailures || 0) + '件・GAS のエラー ' + (sum.gasErrors || 0) + '件・データの食い違い ' + (sum.dataIssues || 0) + '件' + (c.note ? '<br><span class="v-minus">' + esc(c.note) + '</span>' : '') + '</p>'
    + (d.findings.length ? d.findings.map(f => { const a = ag(f.by_agent), dd = f.decision;
      return '<div class="fb-item ec-find"><div class="row" style="gap:8px; align-items:center; flex-wrap:wrap"><span class="pill ' + (lv[f.level] || 'off') + '">' + esc(f.level) + '</span>' + (a ? aiMini(a) : esc(f.by_agent)) + '<span class="note">' + esc(f.area || '') + '</span><code>' + esc(f.where_at || '') + '</code>'
        + (dd ? '<span class="pill ' + (dd.decision === 'ok' ? 'ok' : 'off') + '">' + (dd.decision === 'ok' ? 'OK（直す）' : '却下') + '</span><span class="note">' + esc(fmtJst(dd.at)) + (dd.reason ? '：' + esc(dd.reason) : '') + '</span>' : '') + '</div>'
        + '<div class="fb-text"><b>何が起きるか：</b>' + esc(f.summary) + '</div><div class="fb-text"><b>直し方の案：</b>' + esc(f.fix) + '</div>'
        + (!dd && T.canDecide ? '<div class="row" style="gap:6px; margin-top:6px; flex-wrap:wrap"><input data-ecr="' + f.id + '" placeholder="理由（却下のときは必須）" style="flex:1; min-width:16em"><button class="btn primary sm" type="button" data-ecok="' + f.id + '">OK（直す）</button><button class="btn sm" type="button" data-ecng="' + f.id + '">却下</button></div>' : '') + '</div>'; }).join('')
      : '<p class="empty">指摘はありませんでした。</p>')
    + '<details style="margin-top:10px"><summary>AIの報告（そのまま）</summary>' + T.agents.map(a => { const r = reps[a.id]; return '<h3 class="am-h">' + aiMini(a) + (r && r.note ? ' <span class="note">' + esc(r.note) + '</span>' : '') + '</h3><pre class="ec-pre">' + esc(r ? r.md : '（報告がありません）') + '</pre>'; }).join('') + '</details>'
    + '<p class="note">いまは内ループです：OKした指摘だけを、チャットで直します（直したら次の点検で消えたか確かめます）。却下した指摘と理由は、次の点検から2人に渡して同じ指摘をくり返させません。</p>';
  const act = async (id, decision) => { const reason = (document.querySelector('[data-ecr="' + id + '"]') || {}).value || ''; if (decision === 'ng' && !reason.trim()) return alert('却下の理由を入れてください');
    try { await apiSend('POST', '/errcheck/decision', { finding_id: id, decision, reason }); toast(decision === 'ok' ? 'OKにしました（チャットで直します）' : '却下にしました'); loadTaskCount && loadTaskCount(); render();   /* 一覧・件数・判断待ちを描き直す（2026-11-16 指摘 #7） */ } catch (e) { alert(e.message); } };
  box.querySelectorAll('[data-ecok]').forEach(b => b.onclick = () => act(Number(b.dataset.ecok), 'ok'));
  box.querySelectorAll('[data-ecng]').forEach(b => b.onclick = () => act(Number(b.dataset.ecng), 'ng'));
}
/** Supabase：だれが何を読んだか・読める範囲（指揮官が上限の中で調整） */
function aiAccessHtml(T) {
  const run = (T.runs || []).find(r => (T.access || []).some(a => a.run_id === r.run_id)), logs = run ? T.access.filter(a => a.run_id === run.run_id) : [];
  const nm = id => { const a = T.agents.find(x => x.id === id); return a ? aiMini(a) : esc(id || ''); };
  const scope = '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:170px"><col style="width:330px"><col style="width:330px"><col style="width:170px"></colgroup><thead><tr><th class="pm-name">キャラ</th><th>読める上限</th><th>いまの範囲（指揮官が調整）</th><th>書ける</th></tr></thead><tbody>'
    + T.agents.map(a => '<tr><th class="pm-name">' + nm(a.id) + '</th><td>' + a.ceiling.read.map(t => '<code>' + t + '</code>').join(' ') + '</td><td>' + (a.scope.read || []).map(t => '<code>' + t + '</code>').join(' ') + (a.updatedBy && a.updatedBy !== 'system' ? '<div class="note">' + esc(a.updatedBy === 'commander' ? 'シュミレ・クロード指揮官が調整' : '管理者が変更') + '</div>' : '') + '</td><td>' + ((a.scope.write || a.ceiling.write || []).length ? (a.ceiling.write || []).map(t => '<code>' + t + '</code>').join(' ') : '<span class="note">なし（指揮官に返すだけ）</span>') + '</td></tr>').join('') + '</tbody></table></div>';
  const log = logs.length ? '<div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:120px"><col style="width:170px"><col style="width:150px"><col style="width:170px"><col style="width:70px"><col style="width:70px"><col style="width:260px"><col style="width:260px"></colgroup><thead><tr><th class="pm-name">時刻</th><th>使ったAI</th><th>渡したAI</th><th>表</th><th class="c-ctr">読み書き</th><th class="c-num">行</th><th>項目</th><th>目的</th></tr></thead><tbody>'
    + logs.slice().reverse().map(l => '<tr><th class="pm-name">' + esc(fmtJst(l.at).slice(5)) + '</th><td>' + nm(l.agent) + '</td><td>' + (l.by_agent && l.by_agent !== l.agent ? nm(l.by_agent) : '<span class="note">自分で</span>') + '</td><td><code>' + esc(l.tbl) + '</code></td><td class="c-ctr">' + (l.op === 'write' ? '書く' : '読む') + '</td><td class="c-num">' + nf.format(l.rows || 0) + '</td><td class="ai-fix">' + esc(l.cols || '') + '</td><td class="ai-fix">' + esc(l.purpose || '') + '</td></tr>').join('') + '</tbody></table></div>'
    : '<p class="empty">まだ記録がありません（次の答え合わせから残ります）。</p>';
  return '<section class="panel">' + H('Supabase：どのAIが何を読んだ・使ったか' + (run ? ' <small>' + mLabel(run.ym) + '分の実行（' + esc(fmtJst(run.started_at)) + '）</small>' : ''), ['Supabase']) + log
    + '<h3 class="am-h">ポジションごとの読める範囲</h3>' + scope
    + '<p class="note">AIは Supabase を直接さわらず、受付係（scripts/sim_check_fs.js）を通してだけ読み書きします。サブエージェントには全部を見せず、シュミレ・クロード指揮官がそのポジションに必要なメディア・項目だけを切り出して渡します。上限の外は指揮官も渡せません。</p></section>';
}
/** 設定（フル管理者）：Gemini・OpenAI のキー（このループ専用）と、キャラごとのモデル */
/* AIの設定は 管理 →「API・連携設定」の「AI MEDIAシミュレーション」の枠に置く（2026-11-06 ユーザー指定） */
async function drawAiMediaSettings() {
  const box = $('api-aimedia'); if (!box) return;
  const head = '<div class="panel-head"><h2>AI MEDIAシミュレーション</h2>';
  let T; try { T = await api('/sim/ai-team'); } catch (e) { box.innerHTML = head + '</div><p class="err">' + esc(e.message) + '</p>'; return; }
  const on = T.agents.filter(a => a.connected).length;
  box.innerHTML = head + '<span class="pill ' + (on === T.agents.length ? 'ok' : 'wait') + '">接続 ' + on + '／' + T.agents.length + '</span></div>'
    + '<p class="note">AIツールの「AI MEDIAシミュレーション」の答え合わせで使うAIの設定です。Gemini（シュミレ・ジェミニ探索）・OpenAI（シュミレ・オープン検閲）のキーと、キャラごとのモデルを決めます。</p>'
    + (T.canEdit ? aiSettingsHtml(T) : '<p class="note">設定はフル管理者だけが変えられます。</p>');
  bindAiSettings(drawAiMediaSettings);
}
function aiSettingsHtml(T) {
  if (!T.canEdit || (me && me._preview)) return '';
  const keyRow = (p, l) => { const on = T.agents.some(a => a.provider === p && a.connected); return '<div class="row" style="gap:6px; align-items:center; flex-wrap:wrap; margin:4px 0"><b style="width:7em">' + l + '</b><span class="pill ' + (on ? 'ok' : 'off') + '">' + (on ? '接続済み' : '未接続') + '</span><input type="password" id="aimk-' + p + '" autocomplete="off" placeholder="' + (on ? '入れ直すときだけ' : 'このループ専用のAPIキー') + '" style="min-width:22em"><button class="btn sm primary" type="button" data-aikey="' + p + '">確かめて保存</button></div>'; };
  const chatRow = '<h3 class="am-h">Google Chat の通知 <span class="pill ' + (T.chat ? 'ok">接続済み' : 'off">未接続') + '</span></h3><div class="row" style="gap:6px; align-items:center; flex-wrap:wrap"><input type="password" id="aimk-chat" autocomplete="off" placeholder="' + (T.chat ? '変えるときだけ（空で保存すると止める）' : 'スペースの Webhook の URL') + '" style="min-width:30em"><button class="btn sm primary" type="button" id="aimk-chat-save">テストを送って保存</button>' + (T.chat ? '<button class="btn sm" type="button" id="aimk-chat-off">通知を止める</button>' : '') + '</div>'
    + '<p class="note">答え合わせのたびに、スペースへキャラごとのアイコンで「だれが・何をしたか」（始まり・データを渡した・各キャラの結果・完了／エラー、トークンと費用）を送ります。1回分は同じスレッドにまとまります。URL は Secret Manager に入れ、画面にもチャットにも出しません。</p>';
  return chatRow + '<h3 class="am-h">APIキー（このループ専用）</h3>' + keyRow('gemini', 'Gemini') + keyRow('openai', 'OpenAI')
    + '<p class="note">保存の前に、そのキーでモデルの一覧が読めるかを確かめます。キーは Secret Manager に入れ、画面にもチャットにも出しません。このループ専用のキー（専用のプロジェクト）にすると、ほかの利用と分けて費用を確かめられます。</p>'
    + '<h3 class="am-h">キャラごとのモデル</h3><div class="table-wrap"><table class="am-table fx-table"><colgroup><col style="width:180px"><col style="width:110px"><col style="width:280px"><col style="width:90px"></colgroup><thead><tr><th class="pm-name">キャラ</th><th>AI</th><th>モデル</th><th></th></tr></thead><tbody>'
    + T.agents.map(a => { const list = a.provider === 'claude' ? ['opus', 'sonnet', 'haiku'] : (T.models[a.provider] || []);
      return '<tr><th class="pm-name">' + aiMini(a) + '</th><td>' + esc({ claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' }[a.provider]) + '</td><td><input id="aim-' + a.id + '" list="aiml-' + a.id + '" value="' + esc(a.model) + '" style="width:100%"><datalist id="aiml-' + a.id + '">' + list.map(m => '<option value="' + esc(m) + '">').join('') + '</datalist></td><td><button class="btn sm" type="button" data-aimodel="' + a.id + '">保存</button></td></tr>'; }).join('')
    + '</tbody></table></div><p class="note">モデルを変えると、次の答え合わせから使います（AIツールの月ごとの表に、その月に使ったモデルが残ります）。Claude は opus／sonnet／haiku のほか、正式なモデル名も入れられます。</p>';
}
function bindAiSettings(redraw) {
  /* Google Chat の Webhook（2026-11-06 ユーザー指定） */
  const cs = $('aimk-chat-save'); if (cs) cs.onclick = async () => { const url = $('aimk-chat').value.trim(); if (!url) return alert('Webhook の URL を入れてください');
    cs.disabled = true; cs.textContent = '送っています…'; try { await apiSend('PUT', '/sim/ai-chat', { url }); toast('スペースにテストを送り、保存しました'); redraw(); } catch (e) { alert(e.message); cs.disabled = false; cs.textContent = 'テストを送って保存'; } };
  const co = $('aimk-chat-off'); if (co) co.onclick = async () => { if (!confirm('Google Chat への通知を止めますか？')) return; try { await apiSend('PUT', '/sim/ai-chat', { url: '' }); toast('止めました'); redraw(); } catch (e) { alert(e.message); } };
  /* 欄の ID は aimk-（上の「AI の API の費用」の aik- と重なって、空の欄を読んでいた。2026-11-06） */
  document.querySelectorAll('[data-aikey]').forEach(b => b.onclick = async () => { const p = b.dataset.aikey, inp = $('aimk-' + p), key = inp.value.trim(); if (!key) return alert('キーを入れてください');
    b.disabled = true; b.textContent = '確かめています…'; try { const r = await apiSend('PUT', '/sim/ai-keys/' + p, { key }); inp.value = ''; toast('保存しました（使えるモデル ' + r.models.length + '件）'); redraw(); } catch (e) { alert(e.message); b.disabled = false; b.textContent = '確かめて保存'; } });
  document.querySelectorAll('[data-aimodel]').forEach(b => b.onclick = async () => { const id = b.dataset.aimodel, model = $('aim-' + id).value.trim(); if (!model) return;
    try { await apiSend('PUT', '/sim/ai-agents/' + id, { model }); toast('保存しました（次の答え合わせから）'); redraw(); } catch (e) { alert(e.message); } });
}
function viewAiSim() {
  return { html: '<div id="ai-body"><section class="panel"><p class="loading">読み込み中…</p></section></div>', view: 'AI MEDIAシミュレーション', after: async () => {
    const seq = renderSeq;
    /* 見出しの右に、いまのループ（内ループ＝黄色、外ループ＝緑） */
    if ($('page-title') && !$('ai-loop')) $('page-title').insertAdjacentHTML('beforeend', '<span id="ai-loop" class="loop-badge ' + AI_LOOP + '" title="' + (AI_LOOP === 'outer' ? '答え合わせから計算ルールの反映まで自動' : 'AIの調整案は、あなたがOKしてから反映') + '">' + (AI_LOOP === 'outer' ? '外ループ（完全自動化）' : '内ループ') + '</span>');
    if (!SIM_PRED) SIM_PRED = (await api('/sim/predictions').catch(() => ({ rows: [] }))).rows || [];
    await aiCheckSync();
    if (!SIM_CHECKS) SIM_CHECKS = await loadSimChecks();
    const TEAM = await api('/sim/ai-team').catch(e => ({ error: e.message }));   /* AIチーム・トークン・費用・だれが何を読んだか（2026-11-06） */
    if (seq !== renderSeq || !$('ai-body')) return;
    const anyAi = SIM_CHECKS.some(c => c.ai);
    /* 1. 全体の流れ */
    const steps = [
      ['データを集める', 'GA4・Search Console・Ahrefs・WordPress・進行管理・kintone・ASP・支出 → BigQuery（原本）', true],
      ['シミュレーション', '記事の伸び方・季節性・検索ボリューム・CV率・コール率・成約率・単価から、月ごとの数字を計算', true],
      ['予測を保存', '毎月、その月に最初に開いたときに記事目標どおりの予測を BigQuery に保存', true],
      ['答え合わせ（毎月5日〜）', '前月の請求・コンテンツ管理表の更新が終わった5日以降に、前月の予測と実績を比べて、どの要素がずれたかを見つけて保存（この画面）', true],
      ['AIの見直し（毎月5日〜）', 'タスクスケジューラーで Claude（sim-checker）が動き、これまでの指摘（フィードバック）を読んで理解してから、ずれの原因と調整案を出す', true],
      ['承認して反映', AI_LOOP === 'outer' ? '調整案を自動で計算のルールに反映（外ループ）' : 'あなたがOKした調整案だけ、計算のルールに反映（内ループ）', AI_LOOP === 'outer']
    ];
    const flow = '<section class="panel">' + H('全体の流れ <small>緑＝自動で動いている、灰色＝人の判断・まだつないでいない</small>', ['BigQuery'])
      + '<div class="ai-flow">' + steps.map(([t, d, on], i) => '<div class="ai-step' + (on ? ' on' : '') + '"><div class="ai-no">' + (i + 1) + '</div><div class="ai-t">' + t + ' <span class="pill ' + (on ? 'ok' : 'off') + '">' + (on ? '稼働中' : i === 5 ? 'あなたが承認' : '未接続') + '</span></div><div class="ai-d">' + d + '</div></div>' + (i < steps.length - 1 ? '<div class="ai-arrow">→</div>' : '')).join('') + '</div>'
      + '<p class="note">いまは内ループです：AIの調整案に、あなたが答え合わせの表で OK／却下（と理由）をつけ、OKしたものだけをチャットで反映します。精度が安定したら外ループ（完全自動化）に切り替えます。Gemini・OpenAI はまだつないでいません。</p>'
      + '<p class="note">置き場所：原本＝BigQuery、AIの作業机＝' + (SIM_STORE === 'supabase' ? '<span class="pill ok">Supabase（接続済み）</span>' : '<span class="pill wait">Supabase 未接続（いまは Firestore で代用）</span>　管理 →「API・連携設定」の Supabase でつなぎます') + '</p></section>';
    /* 2. 答え合わせ（毎月5日に前月分。2026-11-05 ユーザー指定：5日なら前月の請求・コンテンツ管理表の更新が終わっている） */
    const keys = new Set(topIds().map(simKey));
    const predYms = [...new Set((SIM_PRED || []).filter(r => r.scenario === 'ideal' && keys.has(r.media) && r.snapshot_ym <= r.ym).map(r => r.ym))].sort();
    const yms = predYms.filter(aiCheckable).reverse(), nextYm = predYms.find(m => !aiCheckable(m));
    const nextTxt = nextYm ? '次の答え合わせは ' + shiftMonth(nextYm, 1).replace('-', '/') + '/05 に ' + mLabel(nextYm) + '分を行います。' : '';
    let check;
    if (!yms.length) check = '<section class="panel">' + H('答え合わせ <small>毎月5日に前月分</small>') + '<p class="empty">' + (predYms.length ? 'まだ答え合わせの日になっていません。' + nextTxt : 'まだ予測を保存していません（シミュレーションの画面を開いた月から保存します）。') + '</p>'
      + '<p class="note">5日には前月の請求・コンテンツ管理表の更新が終わっているので、その後に前月の予測と実績を比べます。</p></section>';
    else {
      const ym = state.aiYm = yms.includes(state.aiYm) ? state.aiYm : yms[0], saved = SIM_CHECKS.find(c => c.ym === ym) || {}, ai = saved.ai || null;
      const pc = r => r == null ? '—' : (r * 100).toFixed(0) + '%';
      const list = (saved.rows && saved.rows.length ? saved.rows : aiCheckData(ym)).filter(r => keys.has(r.media));   /* 保存した表（AIが読んだもの）を優先 */
      const rows = list.map(r => { const am = ai && ai.media ? ai.media[r.media] : null, cc = AI_CHAIN.find(c => c.k === r.cause);
        return '<tr><th class="pm-name">' + esc(r.name || r.media) + '</th>'
          + AI_CHAIN.map(c => { const e = (r.els || []).find(x => x.k === c.k) || {}; return '<td class="c-ctr"><span class="ai-r ' + (e.r == null ? '' : e.skip ? 'skip' : !e.off ? 'ok' : 'off') + (r.cause === c.k ? ' cause' : '') + '" title="' + (e.skip && e.r != null ? '件数が少ないので判定しない' : '') + '">' + pc(e.r) + '</span></td>'; }).join('')
          + '<td class="c-ctr">' + pc(r.revR) + '</td>'
          + '<td class="ai-fix">' + (am ? (am.cause ? '<b>' + esc(am.cause) + '</b>：' : '') + esc(am.fix || '') : (cc ? '<b>' + cc.l + '</b>：' : '') + esc(r.fix)) + '</td>'
          + '<td class="c-ctr"><span class="pill ' + (am ? 'ok' : 'off') + '">' + esc(am ? (ai.by || 'AI') : 'ルール計算') + '</span></td>'
          + '<td class="c-ctr">' + (() => { if (!am || !am.fix) return '<span class="note">—</span>'; const dd = (saved.decisions || []).find(x => x.media === r.media);   /* 内ループ：あなたの判断（新しいものが先頭） */
            return dd ? '<span class="pill ' + (dd.decision === 'ok' ? 'ok' : 'ng') + '" title="' + esc(dd.reason || '') + '">' + (dd.decision === 'ok' ? 'OK' : '却下') + '</span>' + (dd.reason ? '<div class="note">' + esc(dd.reason) + '</div>' : '')
              : '<button class="btn sm primary" type="button" data-dec="ok" data-media="' + esc(r.media) + '">OK</button> <button class="btn sm" type="button" data-dec="ng" data-media="' + esc(r.media) + '">却下</button>'; })() + '</td></tr>'; });
      check = '<section class="panel">' + H('答え合わせ <small>' + mLabel(ym) + '分（' + shiftMonth(ym, 1).replace('-', '/') + '/05 から）・実績÷予測</small>', ['BigQuery'])
        + '<div class="row" style="gap:8px"><label class="field">月<select id="ai-ym">' + yms.map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select></label>'
        + '<span class="note">' + (saved.at ? '表の保存：' + esc(saved.at.slice(0, 16).replace('T', ' ')) : '表はまだ保存していません') + (ai ? '／AIの見直し：' + esc(ai.by || '') + '（' + esc(String(ai.at || '').slice(0, 10)) + '）' : '／AIの見直しはまだです（5日以降にタスクスケジューラーで動きます）') + '</span></div>'
        + (ai && ai.summary ? '<div class="note" style="margin:8px 0; white-space:pre-wrap"><b>AIのまとめ：</b>' + esc(ai.summary) + '</div>' : '')
        + '<div class="table-wrap"><table class="am-table ai-table fx-table">' + '<colgroup><col style="width:180px">' + '<col style="width:84px">'.repeat(7) + '<col style="width:380px"><col style="width:150px"><col style="width:130px"></colgroup><thead><tr><th class="pm-name">メディア</th>' + AI_CHAIN.map(c => '<th class="c-ctr">' + c.l + '</th>').join('') + '<th class="c-ctr">収益（結果）</th><th>ずれの起点と直すところ</th><th class="c-ctr">答えを出したもの</th><th class="c-ctr">あなたの判断</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
        + '<p class="note">数字は「実績÷予測」（100%＝予測どおり）。左から順につながっていて（記事数→PV→CV率→コール率→成約率→1成約あたりの収益）、±20%をこえた最初の要素を「ずれの起点」（太枠）としています。灰色は件数が少なく判定しない要素。AIの見直しがある行は、AIの答え（直すところ）を出しています。' + nextTxt + '</p></section>';
    }
    /* 3. どのAIが答えを出すか */
    const models = '<section class="panel">' + H('AIの担当')
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th>AI</th><th>担当すること</th><th class="c-ctr">状態</th></tr></thead><tbody>'
      + '<tr><td>ルール計算（ダッシュボード）</td><td>答え合わせの表（実績÷予測・ずれの起点）</td><td class="c-ctr"><span class="pill ok">稼働中</span></td></tr>'
      + '<tr><td>Claude（sim-checker）</td><td>まとめ役：これまでの指摘を読んでから、ずれの原因の説明と計算ルールの調整案をつくる（毎月5日〜、タスクスケジューラー）</td><td class="c-ctr"><span class="pill ok">' + (anyAi ? '稼働中' : '準備済み') + '</span></td></tr>'
      + AI_MODELS.slice(1).map(([n, d]) => '<tr><td>' + n + '</td><td>' + d + '</td><td class="c-ctr"><span class="pill off">未接続</span></td></tr>').join('')
      + '</tbody></table></div><p class="note">Claude は、このPCの Claude Code で動かしています。</p></section>';
    /* 並び：AIチーム → KPI・月ごと → 流れ → 答え合わせ → Supabase の記録 → 設定（2026-11-06 ユーザー指定：動いているAIをいちばん上に） */
    const teamOk = TEAM && !TEAM.error && TEAM.agents;
    const teamNote = teamOk && !TEAM.teamReady ? '<p class="note" style="color:var(--bad)">Supabase に AIチームの表がまだありません。管理 →「API・連携設定」→ Supabase の SQL を実行すると、トークン・費用・だれが何を読んだかが残るようになります。</p>' : '';
    /* タブに分ける（2026-11-06 ユーザー指定：何を伝える画面かわかりにくい）。
       概要＝この画面でわかること・次の予定・AIチーム・成績（KPI）／答え合わせ＝あなたのOK待ち／記録＝今月の実行・月ごとのトークンと費用／しくみ＝流れ・だれが何を読んだか */
    const pend = SIM_CHECKS.reduce((n, c) => n + (c.ai && c.ai.media ? Object.entries(c.ai.media).filter(([m, v]) => v && v.fix && !(c.decisions || []).some(d => d.media === m)).length : 0), 0);
    const nextDay = nextYm ? shiftMonth(nextYm, 1).replace('-', '/') + '/05' : '';
    const intro = '<section class="panel ai-intro"><div class="ai-intro-main"><h2>この画面でわかること</h2>'
      + '<p>シミュレーションの予測（＝目標）を、毎月 AIチームが実績と答え合わせして、<b>「がんばれば届く、でも無謀ではない」目標</b>に近づける直し方を提案します。</p>'
      + '<ol class="ai-q"><li><b>AIチームはいま何をしている？</b><span>下のキャラ</span></li><li><b>予測はちょうどいい目標になっている？</b><span>成績（精度）</span></li><li><b>AIにいくらかかった？</b><span>成績（トークン・費用）</span></li><li><b>あなたが決めることは？</b><span>「答え合わせ」のタブ</span></li></ol></div>'
      + '<div class="ai-next"><div class="ai-next-item"><span class="note">次の答え合わせ</span><b>' + (nextDay ? nextDay + '〜' : '—') + '</b><span class="note">' + (nextYm ? mLabel(nextYm) + '分' : '') + '</span></div>'
      + '<div class="ai-next-item' + (pend ? ' warn' : '') + '"><span class="note">あなたのOK待ち</span><b>' + pend + '件</b><span class="note">' + (pend ? '「答え合わせ」で OK／却下' : 'いまはありません') + '</span></div></div></section>';
    const T_ = teamOk ? TEAM : null, settingsNote = T_ && T_.canEdit && !(me && me._preview) ? '<p class="note">Gemini・OpenAI のキー、キャラごとのモデル、Google Chat の通知は、管理 →「API・連携設定」→「AIツール」のタブで設定します。</p>' : '';
    const TABS = [['top', '概要'], ['check', '答え合わせ' + (pend ? ' <span class="ai-badge">' + pend + '</span>' : '')], ['log', '記録'], ['how', 'しくみ']];
    const panes = T_ ? {
      top: intro + aiTeamHtml(T_) + teamNote + aiKpiHtml(T_, SIM_CHECKS, 'cards'),
      check: '<p class="ai-lead">前の月の「予測」と「実績」を比べて、どこがずれたか・どう直すかを見ます。AIの調整案に <b>OK／却下</b> をつけるのは、ここです。</p>' + check,
      log: '<p class="ai-lead">AIチームが、いつ・どれだけ動いて、何トークン・いくら使ったか、どのモデルを使ったかの記録です。</p>' + aiTeamHtml(T_, 'only') + aiKpiHtml(T_, SIM_CHECKS, 'table'),
      how: '<p class="ai-lead">データがどう流れて、どのAIが何を読んでいるかのしくみです。ふだんは見なくて大丈夫です。</p>' + flow + aiAccessHtml(T_) + settingsNote
    } : null;
    const tab = state.aiTab = panes && panes[state.aiTab] ? state.aiTab : 'top';
    $('ai-body').innerHTML = panes ? '<div class="seg ai-tabs" role="tablist">' + TABS.map(([k, l]) => '<button type="button" data-aitab="' + k + '" aria-pressed="' + (k === tab) + '">' + l + '</button>').join('') + '</div>'
        + Object.entries(panes).map(([k, h]) => '<div class="ai-pane" data-aipane="' + k + '"' + (k === tab ? '' : ' hidden') + '>' + h + '</div>').join('')
      : flow + check + models + '<p class="err">AIチームの情報を読めませんでした：' + esc((TEAM && TEAM.error) || '') + '</p>';
    document.querySelectorAll('[data-aitab]').forEach(b => b.onclick = () => { state.aiTab = b.dataset.aitab; document.querySelectorAll('[data-aitab]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); document.querySelectorAll('[data-aipane]').forEach(x => { x.hidden = x.dataset.aipane !== state.aiTab; }); });
    if ($('ai-ym')) $('ai-ym').onchange = ev => { state.aiYm = ev.target.value; render(); };
    /* あなたの判断（OK／却下と理由）を Supabase に残す。OKした調整案は、チャットで計算ルールに反映する（内ループ） */
    document.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => {
      const ym = state.aiYm, c = SIM_CHECKS.find(x => x.ym === ym) || {}, am = c.ai && c.ai.media ? c.ai.media[b.dataset.media] : null, ok = b.dataset.dec === 'ok';
      const reason = prompt((ok ? 'OKの理由（任意）' : '却下の理由（AIが次から読むので、できるだけ書いてください）'), ''); if (reason === null) return;
      try { await apiSend('POST', '/sim/decisions', { ym, media: b.dataset.media, decision: b.dataset.dec, ai: c.ai ? c.ai.by : '', proposal: am ? am.fix : '', reason }); toast('残しました'); SIM_CHECKS = await loadSimChecks(); render(); } catch (e) { alert(e.message); }
    });
  } };
}
const RENDER = { 'ai-errcheck': viewErrCheck, 'ai-sim': viewAiSim, simcmp: viewSimCompare, sim: viewSim, summary: viewSummary, monthly: viewMonthly, daily: viewDaily, yoy: () => viewPeriodCompare('yoy'), mom: () => viewPeriodCompare('mom'), range: viewRange,
  'ex-list': () => viewExpenses('list'), 'ex-staff': () => viewExpenses('staff'), 'ex-site': () => viewExpenses('site'), 'ex-outsource': () => viewExpenses('outsource'), 'ex-press': () => viewExpenses('press'), 'ex-tool': () => viewExpenses('tool'), 'ex-ai': () => viewExpenses('ai'),
  area: viewArea, articles: viewArticles, artlist: viewArtList, 'am-list': viewAmList, 'am-status': viewProduction, 'am-progress': () => { const v = viewAmProgress(); return Object.assign({}, v, { html: v.html + '<section class="panel" id="press-body"><p class="loading">プレスリリースを読み込み中…</p></section>', after: async () => { await v.after(); await drawPressPanel(true); } }); }, 'am-press': () => ({ html: '<section class="panel" id="press-body"><p class="loading">読み込み中…</p></section>', view: 'プレスリリース進行管理', after: drawPressPanel }), 'am-monthly': viewAmMonthly, 'am-concept': viewAmConcept,   /* コンセプト（2026-11-13 ユーザー指定） */   /* コンテンツ進行管理の下の別の画面（2026-10-31 ユーザー指定） */ 'am-settings': viewAmSettings, outline: viewOutline, 'rw-active': viewRewardsAll, 'rw-mine': viewRewards, 'rw-me': viewRewardMe, 'rw-preview': viewRewardPreview, 'rw-batch': viewInvBatch, 'rw-finance': viewInvFinance, 'rw-check': viewRwCheck, 'rv-monthly': () => viewRevTotal('monthly'), 'rv-range': () => viewRevTotal('range'), 'rv-kintone': () => viewRev(state.rvKMode || 'monthly'), 'rv-moshimo': viewMoshimo, kw: viewKw, plan: viewPlan,
  users: viewUsers, roles: viewRoles, system: viewSystem,
  subs: () => ({ html: '<section class="panel" id="ex-subs"><p class="loading">読み込み中…</p></section><section class="panel" id="adm-imp-site"></section><section class="panel" id="adm-imp-free"></section><section class="panel" id="adm-imp-prt"></section><section class="panel" id="adm-imp-press"></section><section class="panel" id="adm-imp-tool"></section>', view: '支出管理', after: async () => {
    /* 支出管理（旧：定額のサービス。2026-11-05 ユーザー指定）：定額のサービスと、支出情報の各タブと同じ請求の入力。どちらで入れても同じ支出（expense_invoices）になる */
    await drawSubs(['cost_tool', 'cost_ai']);
    await drawExpImport('cost_site', [], { box: 'adm-imp-site', title: 'サイト制作・修正費の追加' });
    await drawExpImport('cost_press', ['Freeasy'], { box: 'adm-imp-free', vendorRe: /free?a+sy|フリージー/i, title: 'プレスリリース費：Freeasy の請求の入力' });
    await drawExpImport('cost_press', ['PR TIMES'], { box: 'adm-imp-prt', vendorRe: /PR\s*TIMES/i, title: 'プレスリリース費：PR TIMES の請求の入力' });
    await drawExpImport('cost_press', [], { box: 'adm-imp-press', notVendorRe: /free?a+sy|フリージー|PR\s*TIMES/i, title: 'そのほかのプレスリリース費' });
    await drawExpImport('cost_tool', [], { box: 'adm-imp-tool', title: 'ツール・AIの単発の請求の追加' });
  } }),   /* 定額のサービス（ツール・AI）の登録（2026-11-02 ユーザー指定） */
  expenses: viewExpenses,
  tasks: viewTasks, staff: viewStaff, resta: viewResta, unitassign: viewUnitAssign, aiaccess: () => ({ html: '<section class="panel" id="api-ai"><p class="loading">読み込み中…</p></section>', view: 'AIからのアクセス', after: drawAiAccess }), people: viewPeople, mygoals: viewMyGoals, 'wk-month': viewWork, 'wk-articles': viewWorkArticles, 'wk-metrics': viewWorkMetrics, logs: viewLogs, media: viewMediaAdmin, contracts: viewContracts, targets: viewTargets, api: viewApi, jobs: viewJobs };
REVENUE_VIEWS.forEach(v => { RENDER[v.id] = RENDER[v.id] || viewRevenue; });
const ANALYSIS = new Set(['summary', 'monthly', 'daily', 'yoy', 'mom', 'range', 'area', 'articles', 'artlist', 'kw', 'plan', 'sim', 'simcmp']);   /* sim：上のメディア・ディレクトリを選べる（2026-11-05 ユーザー指定） */
let renderSeq = 0;
async function render() {
  const adminIds = ADMIN_VIEWS.map(v => v.id), dashIds = dashViews().map(v => v.id);
  /* 構成シート（2026-11-12）：保存していない変更があるときは確かめる。ほかの画面に移ったら URL を戻す */
  if (OL_LAST_VIEW === 'outline' && state.view !== 'outline' && OL && OL.dirty) { if (OL.stop || OL.err) { if (!confirm('構成シートの変更を保存できていません。移動すると消えます。よろしいですか？')) { state.view = 'outline'; return; } } else olSave(); }   /* 自動保存（2026-11-12）：移るときは残りを保存 */
  if (state.view === 'outline' && (!state.outline || state.dash !== 'articles')) state.view = 'am-progress';
  if (state.view !== 'outline' && OUTLINE_PATH.test(location.pathname)) history.pushState(null, '', '/');
  OL_LAST_VIEW = state.view;
  if (state.view !== 'outline' && !dashIds.includes(state.view) && !(adminIds.includes(state.view) && canAdminView(state.view)) && !(state.view === 'mygoals' && MY_STAFF && !MY_STAFF.contractor)) state.view = dashIds[0];   // マイページは社員本人だけ
  if (CONTENT_NUM_VIEWS.includes(state.view)) state.mode = 'single';   // コンテンツ作成では各メディア比較を使わない（右上のメディアで切り替え）
  const isAnalysis = ANALYSIS.has(state.view) && !CONTENT_NUM_VIEWS.includes(state.view);
  const all = VIEWS.concat(ADMIN_VIEWS, REVENUE_VIEWS, ARTICLE_VIEWS, REWARD_VIEWS, WORK_VIEWS, EXPENSE_VIEWS, AI_VIEWS, [{ id: 'outline', l: '構成シート' }]);
  if ($('ai-loop')) $('ai-loop').remove();   /* AI MEDIAシミュレーションのループ表示はその画面だけ */
  $('page-title').textContent = state.view === 'mygoals' ? 'マイページ' : groupOf(state.view) ? ADMIN_VIEWS.find(v => v.id === groupOf(state.view)).l : all.find(v => v.id === state.view).l;   // まとめた管理メニューは親の名前
  if (state.view === 'sim' || state.view === 'simcmp') state.mode = 'single';   /* シミュレーションは各メディア比較なし */
  $('media-field').hidden = !isAnalysis || state.mode === 'compare';
  $('mode-seg').hidden = !isAnalysis || state.view === 'sim' || state.view === 'simcmp';
  // 管理メニューでは、契約管理・支出管理・BEST社員管理だけ右上のメディアを出す（メディア累計あり）。ほかの管理メニューでは出さない
  $('art-media-field').hidden = adminIds.includes(state.view) ? !ADMIN_MEDIA_VIEWS.includes(state.view) : !MEDIA_DASHES.includes(state.dash);
  if (ADMIN_MEDIA_VIEWS.includes(state.view)) renderArtMediaSelect();
  $('art-sub-field').hidden = true;   // ディレクトリは renderArtMediaSelect で表示
  if (MEDIA_DASHES.includes(state.dash) && !adminIds.includes(state.view)) renderArtMediaSelect();
  if (state.dash === 'rewards') { $('art-media-field').hidden = true; $('art-sub-field').hidden = true; }   // 報酬管理ではメディアを選ばない（2026-10-28 ユーザー指定）   // 1人分の報酬の画面はメディアを選ばない   // 管理の画面ではディレクトリを出さない（2026-10-28 ユーザー指定）
  if (CONTENT_NUM_VIEWS.includes(state.view)) { const am = artMedia(); if (am === ALL) state.media = ALL; else { const blk = state.artSub && META.media.find(m => m.media === am && m.block && (m.name === state.artSub || m.block === state.artSub)), e = blk || (state.artSub && dirEnt(am + '|' + state.artSub)) || topMedia().find(m => m.media === am); if (e) state.media = e.id; } }
  else if (state.media !== ALL && ent(state.media) && ent(state.media).dirSub) { const t = topMedia().find(m => m.media === ent(state.media).media); state.media = t ? t.id : ALL; }   /* ディレクトリ（META にないもの）は制作状況だけ。ほかの画面ではメディアに戻す */   // ディレクトリにブロック（数値の区分）があれば、記事進捗もそのディレクトリで
  document.querySelectorAll('#mode-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('media-select').value = state.media;
  renderNav();
  clearCharts();
  save();
  const seq = ++renderSeq;
  try {
    const v = RENDER[state.view]();
    $('content').innerHTML = fbBar() + adminTabsHtml(state.view) + v.html;
    document.querySelectorAll('[data-admintab]').forEach(b => b.onclick = () => { state.view = b.dataset.admintab; render(); });
    if (v.view) api('/meta', v.view).catch(() => {});   // アクセスログ用（meta はサーバー側でキャッシュ済み）
    await v.after();
  } catch (e) {
    console.error('表示できませんでした', state.view, e);   /* 原因を調べられるように詳しい場所を残す（2026-11-05） */
    if (seq === renderSeq) $('content').insertAdjacentHTML('beforeend', `<p class="err">表示できませんでした：${esc(e.message)}</p>`);
  }
}

/** 縦にスクロールする表（am-scroll）の高さを、画面の下端に収まるように合わせる。横スクロールのつまみが最初の画面から見えるように（2026-10-27 ユーザー指定） */
/** 全画面共通：横に長い表は、上にも横スクロールのバー（下のバーと一緒に動く。下へスクロールしても上の帯の下に止まる）（2026-10-31 ユーザー指定） */
function addTopScrolls() {
  const tb = document.querySelector('.topbar'), top = (tb ? Math.round(tb.getBoundingClientRect().height) : 0) + 'px';
  document.querySelectorAll('#content .table-wrap, #modal .table-wrap').forEach(w => {
    if (w.classList.contains('rwa-wrap')) return;   // 報酬管理一覧は専用のバーがある
    let bar = w.previousElementSibling && w.previousElementSibling.classList.contains('tw-topscroll') ? w.previousElementSibling : null;
    const wide = w.scrollWidth > w.clientWidth + 1;
    if (!bar) { if (!wide) return; bar = document.createElement('div'); bar.className = 'tw-topscroll'; bar.innerHTML = '<div></div>'; w.parentNode.insertBefore(bar, w);
      const sync = (from, to) => () => { if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft; };
      bar.addEventListener('scroll', sync(bar, w)); w.addEventListener('scroll', sync(w, bar)); }
    bar.firstChild.style.width = w.scrollWidth + 'px'; bar.hidden = !wide; if (!w.closest('#modal')) bar.style.top = top;
  });
}
function fitScrollTables() {
  addTopScrolls();
  document.querySelectorAll('#content .table-wrap.am-scroll').forEach(w => { const top = w.getBoundingClientRect().top + window.scrollY, h = top < innerHeight - 320 ? innerHeight - top - 16 : innerHeight - 80; w.style.maxHeight = Math.max(320, Math.round(h)) + 'px'; });
}
let fitTimer = null;
const fitSoon = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitScrollTables, 60); };
window.addEventListener('resize', fitSoon);
const watchContent = () => { const c = document.getElementById('content'); if (c) new MutationObserver(fitSoon).observe(c, { childList: true, subtree: true }); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchContent); else watchContent();

// ================= コピペチェック（2026-10-28 ユーザー指定） =================
// 記事URLの本文の文を Brave Search API で検索し、自社メディア以外のページで見つかった割合（一致率）を出す。
// 判定は CopyContentDetector と同じ「良好・要注意・コピーの疑い」（ccd の基準は非公開のため、CC_LEVELS は一般的な目安）
let COPY = {};
const CC_LEVELS = [[50, 'ng', 'コピーの疑い'], [30, 'warn', '要注意'], [0, 'ok', '良好']];
const ccLevel = pct => CC_LEVELS.find(x => pct >= x[0]);
const canEditArt = () => isAdmin() || ['admin', 'editor'].includes((me.perms || {}).articles);
async function loadCopy() {
  try { COPY = Object.fromEntries(((await api('/copycheck')).results || []).map(x => [String(x.url).trim(), x])); } catch (e) { COPY = {}; }
  // 「今月の上限」で止まった記事は、月が変わったら裏で順にチェックし直す（画面は止めない。10件まで）
  const cur = todayJst().slice(0, 7), redo = Object.values(COPY).filter(x => x.status === 'limit' && x.ym < cur).slice(0, 10);
  if (redo.length && canEditArt() && !me._preview) (async () => { for (const x of redo) { try { COPY[x.url] = await apiSend('POST', '/copycheck', { url: x.url }); refreshCopy(x.url); } catch (e) { break; } } })();
}
const refreshCopy = u => document.querySelectorAll('[data-copycell]').forEach(td => { const b = td.querySelector('[data-copyurl]'); if (b && b.dataset.copyurl === u) td.innerHTML = copyCell(u); });
function copyCell(url) {
  const u = String(url || '').trim(); if (!u) return '<span class="note">—</span>';
  const x = COPY[u], a = ' data-copyurl="' + esc(u) + '"';
  if (!x) return '<button type="button" class="btn sm"' + a + ' title="この記事のコピペチェックをする">チェック</button>';
  if (x.status === 'done') { const lv = ccLevel(x.pct); return '<button type="button" class="cc-badge cc-' + lv[1] + '"' + a + ' title="' + esc(lv[2] + '・一致率 ' + x.pct + '%（' + x.matched + '/' + x.checked + '文）。押すと詳しい結果') + '"><b>' + x.pct + '%</b><span>' + lv[2] + '</span></button>'; }
  const t = x.status === 'limit' ? '今月の上限' : x.status === 'nokey' ? '未設定' : 'エラー';
  return '<button type="button" class="cc-badge cc-off"' + a + ' title="' + esc(x.error || '') + '">' + t + '</button>';
}
/** チェックする（終わるまで「コピペツール使用中」で画面を止める） */
async function runCopy(url) {
  const u = String(url || '').trim(); if (!u) return;
  if (me._preview) return alert('UI確認中はチェックできません');
  const ov = document.createElement('div'); ov.className = 'cc-overlay'; ov.setAttribute('role', 'alertdialog'); ov.setAttribute('aria-live', 'assertive');
  ov.innerHTML = '<div class="cc-box"><div class="cc-spin" aria-hidden="true"></div><b>コピペツール使用中</b><p>' + (/docs.google.com/.test(u) ? '原稿' : '記事') + 'の文章をインターネット上の文章と照らし合わせています。<br>完了するまでこのままお待ちください（20〜40秒ほど）。</p></div>';
  document.body.appendChild(ov);
  try { COPY[u] = await apiSend('POST', '/copycheck', { url: u }); }
  catch (e) { alert('コピペチェックができませんでした：' + e.message); }
  finally { ov.remove(); }
  refreshCopy(u);
  const x = COPY[u]; if (x && x.status === 'done') showCopy(u); else if (x && x.error) alert(x.error);
}
function showCopy(u) {
  const x = COPY[u]; if (!x) return;
  if (x.status !== 'done') { if (confirm((x.error || 'まだチェックしていません') + '\n\nもう一度チェックしますか？')) runCopy(u); return; }
  const lv = ccLevel(x.pct);
  openModal('<h2>コピペ（簡易）の結果</h2><p class="ccd-note">⚠ この結果は参考程度です。原稿は必ず CCD でチェックし、「コピペ率（CCD）」に記録してください。</p><p class="note" style="word-break:break-all">' + esc(u) + '</p>'
    + '<div class="cc-head"><span class="cc-badge cc-' + lv[1] + ' lg"><b>' + x.pct + '%</b><span>' + lv[2] + '</span></span><div><div>一致率 <b>' + x.pct + '%</b>（調べた ' + x.checked + '文のうち、他サイトで見つかった文 ' + x.matched + '文）</div><div class="note">チェック日時 ' + esc(x.checkedAt ? new Date(x.checkedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '') + '・判定：良好＝30%未満／要注意＝30%以上／コピーの疑い＝50%以上</div></div></div>'
    + (x.matches && x.matches.length ? '<h3 class="am-h">一致したサイト</h3><div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">ページ</th><th class="c-num">一致した文</th></tr></thead><tbody>' + x.matches.map(m => '<tr><td class="c-txt" style="word-break:break-all"><a href="' + escUrl(m.url) + '" target="_blank" rel="noopener">' + esc(m.url) + '</a></td><td class="c-num">' + m.n + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="note">他サイトで同じ文は見つかりませんでした。</p>')
    + '<h3 class="am-h">調べた文</h3><ul class="cc-list">' + (x.samples || []).map(sm => '<li class="' + (sm.url ? 'hit' : '') + '">' + (sm.url ? '<b>一致</b> ' : '<span class="note">なし</span> ') + esc(sm.text) + '</li>').join('') + '</ul>'
    + '<p class="note">本文から特徴のある文を最大10か所選び、自社メディア（お助け本舗シリーズ・BEST365・害虫害獣コンシェルジュ）以外のページに同じ文があるかを調べています。ccd と同じ数字にはならないことがあります。</p>'
    + '<div class="row" style="justify-content:flex-end; gap:8px"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="cc-redo">もう一度チェック</button></div>');
  $('cc-redo').onclick = () => { closeModal(); runCopy(u); };
}
document.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('[data-copyurl]'); if (!b) return; const u = b.dataset.copyurl; if (COPY[u]) showCopy(u); else runCopy(u); });

/** 原稿（Google ドキュメント）の文字数（スペースを除く）を進行管理の文字数に入れる（2026-10-28 ユーザー指定） */
let MY_CHAR_CONTRACTS = null;   // 自分の契約のうち文字単価のもの（アラート用）
/* 文字数の自動入力（2026-11-13 ユーザー指定）：進行状況を「記事執筆完了」以降にするとサーバーが文字数を入れる。その結果を画面にも入れる */
function charsFromRes(r, res, tr, quiet) {
  if (!res || !res.chars) return;
  r.chars = Number(res.chars);
  const inp = tr && tr.querySelector('[data-k="chars"]'); if (inp) inp.value = r.chars;
  const gb = tr && tr.querySelector('[data-charsget]'); if (gb) gb.textContent = '再取得';
  if (!quiet) toast('文字数（スペースを除く）を ' + nf.format(r.chars) + '文字 にしました');
}
/** 文字数の「取得」ボタン：ライティングURL（Google ドキュメント）から今の文字数を読み直す */
const charsGetBtn = r => r && r.key && /^https:\/\/docs\.google\.com\/document\//.test(String(r.writing_url || '').trim()) ? '<button class="btn sm chars-get" type="button" data-charsget="' + esc(r.key) + '" title="ライティングURLのドキュメントから、今の文字数を数えて入れます">' + (r.chars ? '再取得' : '取得') + '</button>' : '';
document.addEventListener('click', async ev => {
  const b = ev.target.closest && ev.target.closest('[data-charsget]'); if (!b) return;
  const r = (ITEMS || []).find(x => x.key === b.dataset.charsget); if (!r || !r.writing_url) return;
  b.disabled = true; const t = b.textContent; b.textContent = '読込中…';
  try { await fillChars(r, b.closest('tr'), r.writing_url); } finally { b.disabled = false; b.textContent = r.chars ? '再取得' : t; }
});
async function fillChars(r, tr, url) {
  let n;
  try { n = (await apiSend('POST', '/doc-chars', { url: url.trim() })).chars; } catch (e) { alert('文字数を自動で入れられませんでした：' + e.message); return; }
  if (!r.key || !n) return;
  try {
    await apiSend('PATCH', '/article-items', { key: r.key, fields: { chars: String(n) } });
    r.chars = n; if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); }
    const inp = tr && tr.querySelector('[data-k="chars"]'); if (inp) inp.value = n;
    toast('文字数（スペースを除く）を ' + nf.format(n) + '文字 にしました');
  } catch (e) { alert('文字数を保存できませんでした：' + e.message); return; }
  // 文字単価の契約の人が、この記事の担当のときだけ確認を出す
  if (!MY_CHAR_CONTRACTS) { try { MY_CHAR_CONTRACTS = ((await api('/my-reward-contracts')).contracts || []).filter(c => c.pay && c.pay.type === '文字単価'); } catch (e) { MY_CHAR_CONTRACTS = []; } }
  const mine = MY_CHAR_CONTRACTS.some(c => ['writer', 'director', 'upload_owner', 'supervisor'].some(f => r[f] && (r[f] === c.name || personName(r[f], r.media) === c.name)));
  if (mine) alert('請求対象外の文字は含まれていませんか？\n・アフィリエイトリンク\n・内部リンク\n・HTMLコード\nご確認をお願いします');
}

// ================= 構成シート（2026-11-12 ユーザー指定） =================
// 進行管理の1記事に1つ。URL は /app/<メディア>/outline/<記事No>（メディアはサイトのアドレスから。2026-11-12 ユーザー指定：メディアごとに分けて outline を挟む）
// 色は「赤太字」「黄マーカー太字」の2つだけ（文字の一部にも、ブロック全体にも。2026-11-12 ユーザー指定）
const OL_MARKS = ['赤太字', '黄マーカー太字'];
const OL_TYPES = [['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['free', '自由記入'], ['reco', 'このような方にオススメ'], ['image', '画像イメージ'], ['cta', 'CTA'], ['appeal', '訴求ブロック'], ['content', '記事用コンテンツ']];   /* 記事用コンテンツ（2026-11-13 ユーザー指定） */
const OL_TL = Object.fromEntries(OL_TYPES);
const OUTLINE_PATH = /^\/app\/([^/]+)\/outline\/([^/]+)\/?$/;
const OL_SA = 'dashboard-app@bestmedia-510909.iam.gserviceaccount.com';
/** 記事の設計の項目（2026-11-12 ユーザー指定）。想定文字数・緊急性は進行管理の値（planned_chars・urgency）をそのまま使う */
const OL_META = [['reader_before', 'A.記事を読む前の読者の状態', 'ta', 'a'], ['reader_action', 'B.記事を読んだ後に読者にとって欲しい行動', 'ta', 'b'], ['reader_info', 'C.AからBの状態にするために必要な情報', 'ta', 'c'], ['google_kw', 'Google関連キーワード', 'ta'], ['questions', '関連する質問（1行に1つ）', 'ta'],
  /* ペルソナは項目ごと（2026-11-13 ユーザー指定） */
  ['persona_basic', 'ペルソナ', 'persona'], ['persona_thought', 'ペルソナ：考え', 'ta'], ['persona_worry', 'ペルソナ：悩み <span class="note">（C の「AからBの状態にするために必要な情報」と連動させる）</span>', 'ta']];   /* 「ペルソナ（そのほかのメモ）」は出さない（2026-11-13 ユーザー指定） */   /* 既存記事URLは進行管理の記事URLを自動で出す・A＝青・B＝黄・C＝赤の枠（2026-11-13 ユーザー指定） */
/** 構成の右側の項目（2026-11-12 ユーザー指定） */
const OL_NOTES = [['memo', 'メモ'], ['figure', '図解の指示'], ['link', '内部リンク']];
const olNewId = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(8, '0');
const olCan = () => canEditArticles() && !['out_writer', 'free_writer'].includes(me.roleEff);   /* 進行管理の値（想定文字数・緊急性）を直せる人 */
/* ===== ペルソナ（性別〜趣味）：選択欄をまとめて小さく（2026-11-13 ユーザー指定） ===== */
const P_GENDER = ['男性', '女性', '指定なし'];
const P_AGE = ['18～24', '25～34', '35～44', '45～54', '55～64', '65以上'];   /* Google の年齢の区分 */
const P_INCOME = ['100万円未満'].concat(Array.from({ length: 19 }, (_, i) => (i + 1) * 100 + '～' + (i + 2) * 100 + '万円'), ['2,000万円以上']);   /* 世帯年収（100万円ごと） */
const P_FAMILY = ['単身', '2世代', '3世代'];
const P_OWN = ['持ち家', '賃貸'], P_TYPE = ['戸建て', 'マンション', 'アパート'];
const P_ROOM = ['1R', '1K', '1DK', '1LDK'].concat(...[2, 3, 4, 5].map(n => [n + 'K', n + 'DK', n + 'LDK']));
const P_MOVE = ['通勤は電車・休日は車', '通勤・休日ともに電車', '通勤・休日ともに車'];
const P_AREA = ['都市部', '都市郊外', '農村・山間部'];   /* 居住地（2026-11-13 ユーザー指定） */
const P_STATION = ['駅徒歩5分以内', '駅徒歩5～10分', '駅徒歩10～15分', '駅徒歩15～20分', '駅徒歩20～25分', '駅徒歩25～30分', '駅徒歩30分以上'];   /* 5分ごと */
/** 家族の合計人数（単身＝1人。2世代＝大人＋子供。3世代＝大人＋子供＋祖父母） */
function olFamilyTotal(m) {
  const f = m.persona_family, n = k => Math.max(0, Math.round(Number(m[k]) || 0));
  if (f === '単身') return 1;
  if (f === '2世代') return n('persona_family_adult') + n('persona_family_child');
  if (f === '3世代') return n('persona_family_adult') + n('persona_family_child') + n('persona_family_elder');
  return null;
}
/** m・attr を渡すと、コンセプト（メディア・ディレクトリのペルソナ）でも使う（2026-11-13） */
function olPersonaHtml(dis, m0, attr) {
  const A = attr || 'olm', M = m0 || OL.meta;
  /* 見出し（持ち家/賃貸・建物・間取り・駅徒歩など）は選べない見本として出す（2026-11-13 ユーザー指摘：選択肢に入っていてわかりにくい） */
  if (M.persona_income && !P_INCOME.includes(M.persona_income)) delete M.persona_income;   /* 世帯年収は100万円ごとの選択肢だけ（「31～40％」などは消す。2026-11-13 ユーザー指定） */
  const m = M, sel = (k, list, ph) => { const v = m[k] || ''; return '<select data-' + A + '="' + k + '"' + dis + (v ? '' : ' class="ol-ph"') + '><option value="" disabled hidden' + (v ? '' : ' selected') + '>' + (ph || '未選択') + '</option>' + (v && !list.includes(v) ? '<option selected>' + esc(v) + '</option>' : '') + list.map(o => '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>'; };
  const num = (k, l) => '<label class="ol-pnum">' + l + '<input type="number" min="0" max="20" data-' + A + '="' + k + '" value="' + esc(m[k] || '') + '"' + dis + '>人</label>';
  const f = m.persona_family, tot = olFamilyTotal(m);
  const cell = (l, h, cls) => '<div class="ol-pc ' + (cls || '') + '"><span class="ol-pl">' + l + '</span>' + h + '</div>';
  /* 1行目：性別・年齢・世帯年収（小さく）／2行目：家族構成・居住地・居住環境／3行目：移動手段・趣味（2026-11-13 ユーザー指定） */
  return '<div class="ol-persona" id="' + (A === 'olm' ? 'ol-persona' : A + '-persona') + '">'
    + '<div class="ol-prow1">' + cell('性別', sel('persona_gender', P_GENDER), 'sm') + cell('年齢', sel('persona_age', P_AGE), 'sm') + cell('世帯年収', sel('persona_income', P_INCOME), 'sm') + '</div>'
    + '<div class="ol-prow2">'
    + cell('家族構成', '<div class="ol-pline">' + sel('persona_family', P_FAMILY) + (f === '2世代' || f === '3世代' ? num('persona_family_adult', '大人') + num('persona_family_child', '子供') + (f === '3世代' ? num('persona_family_elder', '祖父母') : '') : '') + (tot != null ? '<span class="ol-ptot">合計 <b>' + tot + '</b>人</span>' : '') + '</div>', 'fam')
    + cell('居住地', '<div class="ol-pline">' + sel('persona_area', P_AREA) + sel('persona_station', P_STATION, '駅徒歩') + '</div>', 'area')
    + cell('居住環境', '<div class="ol-pline">' + sel('persona_home_own', P_OWN, '持ち家/賃貸') + sel('persona_home_type', P_TYPE, '建物') + sel('persona_home_room', P_ROOM, '間取り') + '<input data-' + A + '="persona_home_note" value="' + esc(m.persona_home_note || m.persona_home || '') + '" placeholder="補足（庭付き・駐車場付きなど）"' + dis + '></div>', 'home')
    + '</div><div class="ol-prow3">' + cell('移動手段', sel('persona_move', P_MOVE), 'move') + cell('趣味', '<input data-' + A + '="persona_hobby" value="' + esc(m.persona_hobby || '') + '" placeholder="旅行・キャンプなど"' + dis + '>', 'hobby') + '</div>'
    + '</div>';
}
/** Googleドキュメントなどに出す1行のまとめ */
function olPersonaText() {
  const m = OL.meta, tot = olFamilyTotal(m);
  const fam = m.persona_family ? m.persona_family + (m.persona_family !== '単身' && tot != null ? '（大人' + (m.persona_family_adult || 0) + '・子供' + (m.persona_family_child || 0) + (m.persona_family === '3世代' ? '・祖父母' + (m.persona_family_elder || 0) : '') + '、合計' + tot + '人）' : '') : '';
  const home = [m.persona_home_own, m.persona_home_type, m.persona_home_room].filter(Boolean).join('・') + (m.persona_home_note || m.persona_home ? '（' + (m.persona_home_note || m.persona_home) + '）' : '');
  return [['性別', m.persona_gender], ['年齢', m.persona_age], ['世帯年収', m.persona_income], ['家族構成', fam], ['居住環境', home], ['居住地', [m.persona_area, m.persona_station].filter(Boolean).join('・')], ['移動手段', m.persona_move], ['趣味', m.persona_hobby]].filter(x => x[1]).map(x => x[0] + '：' + x[1]).join('\n');
}
/** ペルソナをコピーする（2026-11-13 ユーザー指定）：記事から＝同じメディアで、進行状況が「構成作成完了」〜「完了」の記事の構成シートのペルソナ。
 *  メディアから・ディレクトリから＝コンテンツ作成 →「コンセプト」で作ったメディア・ディレクトリのペルソナ（2026-11-13 ユーザー指定で使えるように） */
async function olPersonaCopy(tab) {
  const r = OL.r, from = STATUS_ORDER.indexOf('構成作成完了'), to = STATUS_ORDER.indexOf('完了');
  tab = typeof tab === 'string' ? tab : (OL.pcTab || 'media'); OL.pcTab = tab;
  const tb = (k, l) => '<button type="button" data-pctab="' + k + '" aria-pressed="' + (tab === k) + '">' + l + '</button>';
  openModal('<h2>ペルソナをコピー <small class="note">' + esc(mediaLabel(r.media)) + (r.sub ? '／' + esc(r.sub) : '') + '</small></h2>'
    + '<div class="seg ol-pc-tabs">' + tb('media', 'メディアから') + (artSubs(r.media) ? tb('sub', 'ディレクトリから') : '') + tb('article', '記事から') + '</div>'
    + '<p class="note">' + (tab === 'article' ? '同じメディアで、進行状況が「構成作成完了」〜「完了」の記事のうち、構成シートにペルソナが入っているものです。' : 'コンテンツ作成 →「コンセプト」で設定したペルソナです。') + '選ぶと、この記事のペルソナ（性別〜悩み）を置き換えます。</p>'
    + '<div id="ol-pc-list"><p class="loading">読み込み中…</p></div><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>');
  document.querySelectorAll('[data-pctab]').forEach(b => b.onclick = () => olPersonaCopy(b.dataset.pctab));
  const sum = pp => [pp.persona_gender, pp.persona_age, pp.persona_income, pp.persona_family ? pp.persona_family + (pp.persona_family_total ? '（' + pp.persona_family_total + '人）' : '') : '', [pp.persona_home_own, pp.persona_home_type, pp.persona_home_room].filter(Boolean).join('・')].filter(Boolean).join(' / ');
  let rows = [];
  try {
    if (tab === 'article') {
      const list = (await api('/outline/personas?media=' + encodeURIComponent(r.media))).list || [];
      const byKey = Object.fromEntries((ITEMS || []).map(x => [x.key, x]));
      rows = list.map(x => Object.assign({}, x, { item: byKey[x.key] })).filter(x => x.key !== OL.key && x.item && (i => i >= from && i <= to)(STATUS_ORDER.indexOf(x.item.status)))
        .sort((a, b) => String(b.item.no || '').localeCompare(String(a.item.no || ''), 'ja', { numeric: true }))
        .map(x => ({ cells: [x.item.no || '', x.item.kw || '', x.item.status || ''], persona: x.persona }));
    } else {
      const d = await api('/concept/personas?media=' + encodeURIComponent(r.media));
      rows = tab === 'media' ? (Object.keys(d.media || {}).length ? [{ cells: [mediaLabel(r.media)], persona: d.media }] : [])
        : (d.subs || []).slice().sort((a, b) => (b.sub === r.sub) - (a.sub === r.sub)).map(x => ({ cells: [x.sub + (x.sub === r.sub ? '（この記事）' : '')], persona: x.persona }));
    }
  } catch (e) { $('ol-pc-list').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
  if (!$('ol-pc-list') || OL.pcTab !== tab) return;
  const heads = tab === 'article' ? ['No.', '検索KW', '進行状況'] : [tab === 'media' ? 'メディア' : 'ディレクトリ'];
  $('ol-pc-list').innerHTML = rows.length ? '<div class="table-wrap"><table class="am-table"><thead><tr>' + heads.map(h => '<th class="c-txt">' + h + '</th>').join('') + '<th class="c-txt">ペルソナ</th><th></th></tr></thead><tbody>'
    + rows.map((x, i) => '<tr>' + x.cells.map(c => '<td class="c-txt">' + esc(c) + '</td>').join('') + '<td class="c-txt" style="white-space:normal;font-size:12px">' + esc(sum(x.persona)) + (x.persona.persona_worry ? '<div class="note">悩み：' + esc(String(x.persona.persona_worry).slice(0, 50)) + '</div>' : '') + '</td><td><button class="btn sm primary" type="button" data-pcpick="' + i + '">コピー</button></td></tr>').join('') + '</tbody></table></div>'
    : '<p class="empty">' + (tab === 'article' ? 'コピーできる記事がありません（構成作成完了〜完了の記事で、ペルソナが入っている構成シートがありません）' : 'まだペルソナがありません。コンテンツ作成 →「コンセプト」の「ペルソナ」で作れます。') + '</p>';
  document.querySelectorAll('[data-pcpick]').forEach(b => b.onclick = () => {
    const src = rows[Number(b.dataset.pcpick)].persona, has = Object.keys(OL.meta).some(k => /^persona/.test(k) && OL.meta[k]);
    if (has && !confirm('この記事のペルソナを置き換えます。よろしいですか？')) return;
    Object.keys(OL.meta).filter(k => /^persona/.test(k)).forEach(k => { delete OL.meta[k]; });
    Object.assign(OL.meta, src); closeModal(); olDirty(true); paintOutline(); toast('ペルソナをコピーしました');
  });
}
/** 構成の中身を画面の状態に入れる */
function olFrom(o) { OL.ol = o; OL.title = o ? o.title || '' : ''; OL.lead = o ? o.lead || '' : ''; OL.description = o ? o.description || '' : ''; OL.meta = o ? olClone(o.meta || {}) : {}; OL.blocks = o ? olClone(o.blocks || []) : []; OL.blocks.forEach(b => { if (!b.id) b.id = olNewId(); }); }
/** コメントのボタン（件数つき）。誰が書いたかも残す（2026-11-12 ユーザー指定） */
const olCBtn = t => { const n = OL.comments.filter(c => c.target === t).length; return '<button class="ol-cbtn' + (n ? ' has' : '') + '" type="button" data-olct="' + t + '" title="コメントを見る・書く">コメント' + (n ? ' ' + n : '') + '</button>'; };
const olThWrap = t => '<div class="ol-thwrap" data-olthwrap="' + t + '">' + (OL.openC.has(t) ? olThreadHtml(t) : '') + '</div>';
function olThreadHtml(t) {
  const L = OL.comments.filter(c => c.target === t);
  return '<div class="ol-thread">' + (L.length ? L.map(c => '<div class="ol-cm"><b>' + esc(c.name) + '</b><span class="ol-cw">' + esc(olWhen(c.at)) + '</span>' + (c.by === OL.myEmail || OL.canHand ? '<button class="linkbtn" type="button" data-olcdel="' + esc(c.id) + '">削除</button>' : '') + '<div class="ol-ct">' + esc(c.text).replace(/\n/g, '<br>') + '</div></div>').join('') : '<p class="note">まだコメントはありません</p>')
    + '<div class="ol-cnew"><textarea rows="2" data-olcin="' + t + '" placeholder="コメントを書く（Ctrl+Enterで送信）"></textarea><button class="btn sm primary" type="button" data-olcsend="' + t + '">送信</button><button class="btn sm" type="button" data-olccancel="' + t + '">キャンセル</button></div></div>';
}
function olRefreshC(t) {
  document.querySelectorAll('[data-olct="' + t + '"]').forEach(b => { b.outerHTML = olCBtn(t); });
  document.querySelectorAll('[data-olthwrap="' + t + '"]').forEach(w => { w.innerHTML = OL.openC.has(t) ? olThreadHtml(t) : ''; });
}
document.addEventListener('click', async ev => {
  if (!ev.target.closest || state.view !== 'outline' || !OL) return;
  const tb = ev.target.closest('[data-olct]');
  if (tb) { const t = tb.dataset.olct; if (OL.openC.has(t)) OL.openC.delete(t); else OL.openC.add(t); olRefreshC(t); const ta = document.querySelector('[data-olcin="' + t + '"]'); if (ta) ta.focus(); return; }
  const sb = ev.target.closest('[data-olcsend]');
  if (sb) { const t = sb.dataset.olcsend, ta = document.querySelector('[data-olcin="' + t + '"]'), text = ta ? ta.value.trim() : ''; if (!text) return toast('コメントを入力してください');
    sb.disabled = true; try { const res = await apiSend('POST', '/outline/comments', { key: OL.key, target: t, text }); OL.comments.push(res.comment); olRefreshC(t); toast('コメントしました'); } catch (e) { sb.disabled = false; alert('コメントできませんでした：' + e.message); } return; }
  const cc = ev.target.closest('[data-olccancel]');
  if (cc) { const t = cc.dataset.olccancel, ta = document.querySelector('[data-olcin="' + t + '"]'); if (ta && ta.value.trim() && !confirm('書きかけのコメントを消して閉じます。よろしいですか？')) return; OL.openC.delete(t); olRefreshC(t); return; }
  const db = ev.target.closest('[data-olcdel]');
  if (db) { const c = OL.comments.find(x => x.id === db.dataset.olcdel); if (!c || !confirm('このコメントを削除します。よろしいですか？')) return;
    try { await apiSend('DELETE', '/outline/comments', { key: OL.key, id: c.id }); OL.comments = OL.comments.filter(x => x !== c); olRefreshC(c.target); } catch (e) { alert('削除できませんでした：' + e.message); } }
});
document.addEventListener('keydown', ev => { const ta = ev.target.closest && ev.target.closest('[data-olcin]'); if (ta && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); const b = document.querySelector('[data-olcsend="' + ta.dataset.olcin + '"]'); if (b) b.click(); } });
const isOutlineUrl = v => { try { return OUTLINE_PATH.test(new URL(String(v || '').trim()).pathname); } catch (e) { return false; } };
/** 読み込んだマイブロックの番号（#7149）を、CTA・訴求ブロック・記事用コンテンツの名前に当てる（2026-11-13） */
function olMapCode(media, b) {
  const m = b && olBlk(b.type) && String(b.block || '').match(/^#(\d+)$/); if (!m) return b;
  for (const t of ['cta', 'appeal', 'content']) { const f = olBlocksOf(media, t).find(x => String(x.id) === m[1] || String(x.code || '').includes('id="' + m[1] + '"')); if (f) return Object.assign({}, b, { type: t, block: f.name }); }
  return Object.assign({}, b, { block: 'マイブロック ID ' + m[1] });
}
const olBlk = t => t === 'cta' || t === 'appeal' || t === 'content';
/** 記事用コンテンツの中の見出し（H2・H3など）を WordPress から読んで入れる（編集はできない。2026-11-13 ユーザー指定） */
async function olFillHeads(b) {
  if (!b || b.type !== 'content' || !b.block) return;
  const x = olBlocksOf(OL.media, 'content').find(y => y.name === b.block); if (!x) { b.heads = []; return; }
  try { b.heads = (await api('/outline/block-heads?media=' + encodeURIComponent(OL.media) + '&id=' + encodeURIComponent(x.id))).heads || []; } catch (e) { b.heads = []; toast('記事用コンテンツの見出しを読めませんでした：' + e.message); }
}
async function olFillAllHeads() { const cur = OL, list = OL.blocks.filter(b => b.type === 'content' && !b.heads); if (!list.length) return; for (const b of list) await olFillHeads(b); if (cur !== OL) return; olDirty(true); olRows(); olPrev(); }
/** メディア → URL の部分（例：害獣お助け → gaijyu.otasuke-honpo） */
const mediaSlug = m => { const u = SITE_URLS[m]; if (!u) return encodeURIComponent(m); return new URL(u).hostname.replace(/^www\./, '').replace(/\.(co\.jp|ne\.jp|or\.jp|com|net|jp)$/, ''); };
const mediaOfSlug = s => Object.keys(SITE_URLS).find(m => mediaSlug(m) === s) || decodeURIComponent(s);
/** 記事 → URL の最後（記事No。No がない記事は e-／r- の記号） */
/** URL に使う記事No：全角を半角にして、長音・ダッシュは「-」に（文字化けしないよう半角英数字だけ。2026-11-13 ユーザー指定） */
const olIdAscii = v => String(v == null ? '' : v).normalize('NFKC').trim().replace(/[ー－‐―−–—]/g, '-').replace(/\s+/g, '');
/** キーの短い印（URL 用。英数字だけ）（2026-11-16） */
const olKeyHash = k => { let h = 2166136261; for (const c of String(k)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };
/* 別ディレクトリの同じ記事No.で、ディレクトリ付きのキー（|sub…）になった記事は「k-<印>」（記事No.だけでは見分けられないため。2026-11-16 AIエラーチェッカー #1・#10）。
   記事No.が英数字にできない記事も、キーが「|row」でなければ「k-<印>」（前は r-メディア|no… になって開けなかった） */
const outlineIdOf = r => { const k = String(r.key || '');
  if (k.startsWith('entry:')) return /^[A-Za-z0-9._-]+$/.test(olIdAscii(r.no)) && !/\|sub/.test(k) ? olIdAscii(r.no) : 'e-' + k.slice(6);
  if (/\|sub/.test(k)) return 'k-' + olKeyHash(k);
  if (/^[A-Za-z0-9._-]+$/.test(olIdAscii(r.no))) return olIdAscii(r.no);
  return /\|row/.test(k) ? 'r-' + k.replace(/^.*\|row/, '') : 'k-' + olKeyHash(k); };
const outlinePath = r => '/app/' + mediaSlug(r.media) + '/outline/' + encodeURIComponent(outlineIdOf(r));
const outlineUrl = r => location.origin + outlinePath(r);
function findOutlineItem(media, id) {
  const L = ITEMS || [];
  if (/^e-/.test(id)) return L.find(x => x.key === 'entry:' + id.slice(2));
  if (/^r-/.test(id)) return L.find(x => x.key === media + '|row' + id.slice(2));
  if (/^k-/.test(id)) return L.find(x => x.media === media && x.key && olKeyHash(x.key) === id.slice(2));
  const want = olIdAscii(id);   /* 前の全角のURL（1ー62 など）も同じ記事を開く */
  const hit = L.filter(x => x.media === media && x.key && olIdAscii(x.no) === want);
  return hit.find(x => !/\|sub/.test(x.key)) || hit[0];   /* 記事No.だけのURLは、今の記事（ディレクトリ付きでないキー）を開く */
}
let OL = null, OL_LAST_VIEW = null;
function goOutline(path, push = true) {
  const m = String(path).match(OUTLINE_PATH); if (!m) return;
  state.outline = { slug: m[1], id: decodeURIComponent(m[2]) }; state.dash = 'articles'; state.view = 'outline';
  if (push && location.pathname !== path) history.pushState({ ol: 1 }, '', path);
  render();
}
window.addEventListener('popstate', () => { if (!me) return; const m = location.pathname.match(OUTLINE_PATH); if (m) goOutline(location.pathname, false); else if (state.view === 'outline') { state.view = 'am-progress'; render(); } });
document.addEventListener('click', ev => {
  const a = ev.target.closest && ev.target.closest('a[href]'); if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return;
  let u; try { u = new URL(a.href); } catch (e) { return; }
  if (u.origin === location.origin && OUTLINE_PATH.test(u.pathname) && me) { ev.preventDefault(); goOutline(u.pathname); }
});
window.addEventListener('beforeunload', ev => { if (OL && (OL.dirty || OL.saving) && state.view === 'outline') { ev.preventDefault(); ev.returnValue = ''; } });
/** 全角換算の文字数（半角の英数字・記号・半角カナは0.5。改行は数えない）（2026-11-13 ユーザー指定） */
function olZen(v) { let n = 0; for (const c of String(v || '').replace(/[\r\n]/g, '')) n += /[\x20-\x7e\uff61-\uff9f]/.test(c) ? 0.5 : 1; return n; }
const olZenTxt = v => { const n = olZen(v); return '全角 ' + (Number.isInteger(n) ? n : n.toFixed(1)) + '文字'; };
function olDescN() { [['title', OL.title], ['lead', OL.lead], ['description', OL.description]].forEach(([k, v]) => { const n = $('ol-n-' + k); if (n) n.textContent = '（' + olZenTxt(v) + '）'; }); }
/** タイトル・リード文・ディスクリプションの入力欄（構成シートと競合調査の両方に出す。2026-11-13 ユーザー指定） */
function olTldHtml() {
  const r = OL.r, disA = OL.canEdit ? '' : ' disabled';
  const lab = (t, h) => '<div class="ol-flab"><span class="ol-lab">' + h + ' <span class="note ol-zen" id="ol-n-' + t + '"></span></span>' + olCBtn('f:' + t) + '</div>';
  return '<div class="ol-tf">' + lab('title', 'タイトル') + '<input id="ol-title" value="' + esc(OL.title) + '" placeholder="' + esc(r.kw ? r.kw + 'の記事タイトル' : '記事タイトル') + '"' + disA + '><div class="ol-diff" id="ol-fdiff-title"></div>' + olThWrap('f:title') + '</div>'
    + '<div class="ol-tf">' + lab('lead', 'リード文') + '<textarea id="ol-lead" rows="3" placeholder="記事の冒頭の文章"' + disA + '>' + esc(OL.lead) + '</textarea><div class="ol-diff" id="ol-fdiff-lead"></div>' + olThWrap('f:lead') + '</div>'
    + '<div class="ol-tf">' + lab('description', 'ディスクリプション') + '<textarea id="ol-desc" rows="2" placeholder="検索結果に出る説明文（120文字前後）"' + disA + '>' + esc(OL.description) + '</textarea><div class="ol-diff" id="ol-fdiff-description"></div>' + olThWrap('f:description') + '</div>';
}
function olBindTld() {
  const t = $('ol-title'), l = $('ol-lead'), d = $('ol-desc'); if (!t) return;
  t.oninput = () => { OL.title = t.value; olDirty(true); olPrev(); olDescN(); olRefreshFieldDiff('title'); };
  l.oninput = () => { OL.lead = l.value; olDirty(true); olPrev(); olDescN(); olRefreshFieldDiff('lead'); };
  d.oninput = () => { OL.description = d.value; olDirty(true); olDescN(); olRefreshFieldDiff('description'); };
  olDescN(); ['title', 'lead', 'description'].forEach(olRefreshFieldDiff);
}
document.addEventListener('keydown', ev => { if (state.view === 'outline' && OL && OL.canEdit && (ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); olSave(); } });

/** 入力欄の中身を、決めた印（改行・赤太字・黄マーカー太字）だけに整える */
function olClean(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  const walk = n => { let out = ''; n.childNodes.forEach(c => {
    if (c.nodeType === 3) out += esc(c.textContent).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    else if (c.nodeType === 1) {
      const t = c.tagName;
      if (t === 'BR') { out += '<br>'; return; }
      const inner = walk(c), k = c.getAttribute('data-c');
      if ((t === 'DIV' || t === 'P') && out && !/<br>$/.test(out)) out += '<br>';
      out += t === 'SPAN' && OL_MARKS.includes(k) && inner ? '<span data-c="' + k + '">' + inner + '</span>' : inner;
    } });
    return out; };
  return walk(d).replace(/(<br>)+$/, '');
}
const olPlain = h => { const d = document.createElement('div'); d.innerHTML = String(h || '').replace(/<br>/g, '\n'); return d.textContent; };
const olClone = x => JSON.parse(JSON.stringify(x));
const olWhen = s => s ? new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const olBlocksOf = (media, t) => { const o = ART_OPTS[media + '#']; return o && o.blocks ? (o.blocks[t] || []) : []; };
const olCode = (media, t, name) => { const b = olBlocksOf(media, t).find(x => x.name === name); return b ? b.code : ''; };

function viewOutline() {
  return { html: '<section class="panel ol-page" id="ol-body"><p class="loading">構成シートを読み込み中…</p></section>', view: '構成シート', after: drawOutline };
}
/** ライティングURL（構成シートの上の欄） */
const olWurlHtml = r => r.writing_url ? '<a class="ol-upurl" href="' + escUrl(r.writing_url) + '" target="_blank" rel="noopener">原稿を開く</a>' : '<span class="note">—</span>';
/** 想定文字数の横：競合の平均・最大・最小の文字数（競合調査をしていなければ出さない。2026-11-13 ユーザー指定） */
const olCompCharsHtml = () => { const c = OL && OL.compStats; if (!c) return ''; const f = v => nf.format(v) + '文字'; return '<span class="ol-compchars" title="いちばん新しい競合調査（' + c.n + 'サイト）の本文の文字数">競合 平均 <b>' + f(c.avg) + '</b>　MAX <b>' + f(c.max) + '</b>　MIN <b>' + f(c.min) + '</b></span>'; };
/* 別のタブで一覧を直してから戻ったときは、ライティングURLと競合の文字数を取り直す（2026-11-13 ユーザー指定） */
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || state.view !== 'outline' || !OL || !OL.r) return;
  const cur = OL; let f; try { f = await api('/outline/fresh?key=' + encodeURIComponent(cur.key)); } catch (e) { return; }
  if (cur !== OL) return;
  cur.r.writing_url = f.writing_url; const it = (ITEMS || []).find(x => x.key === cur.key); if (it) it.writing_url = f.writing_url;
  cur.compStats = f.comp;
  const w = $('ol-wurl'); if (w) w.innerHTML = olWurlHtml(cur.r);
  const c = $('ol-compchars'); if (c) c.innerHTML = olCompCharsHtml();
});
async function drawOutline() {
  const seq = renderSeq;
  await loadItems();
  if (seq !== renderSeq) return;
  const o = state.outline || {}, media = mediaOfSlug(o.slug || ''), r = findOutlineItem(media, String(o.id || ''));
  const box = $('ol-body'); if (!box) return;
  const back = '<div class="ol-top"><button class="btn sm" type="button" id="ol-back">← コンテンツ進行管理</button></div>';
  const bindBack = () => { $('ol-back').onclick = () => { state.view = isWriterOnly() ? 'am-monthly' : 'am-progress'; render(); }; };
  if (!r) { box.innerHTML = back + '<p class="empty">記事が見つからないか、この記事を見る権限がありません（' + esc(mediaLabel(media)) + '　' + esc(o.id || '') + '）</p>'; bindBack(); return; }
  let d;
  try { [d] = await Promise.all([api('/outline?key=' + encodeURIComponent(r.key), '構成シート'), loadArtOptions(r.media).catch(() => null)]); }
  catch (e) { if (seq === renderSeq) { box.innerHTML = back + '<p class="err">構成を読み込めませんでした：' + esc(e.message) + '</p>'; bindBack(); } return; }
  if (seq !== renderSeq) return;
  if (OL) clearTimeout(OL.timer);
  OL = { r, key: r.key, media: r.media, canEdit: !!d.canEdit, canHand: !!d.canHand, canReopen: !!d.canReopen, viaWriter: !!d.viaWriter, canCompete: !!d.canCompete, history: d.history || [], dirty: false, creating: false,
    comments: d.comments || [], myEmail: d.me || me.email, openC: new Set(), compStats: d.fresh ? d.fresh.comp : null };
  if (d.fresh) r.writing_url = d.fresh.writing_url;   /* 一覧で消したライティングURLは出さない（2026-11-13 ユーザー指定） */
  olFrom(d.outline);
  if (!d.outline && state.outlineCreate === r.key && OL.canEdit) olStartBlank();
  state.outlineCreate = null;
  paintOutline();
}
/** 競合調査（2026-11-13 ユーザー指定）：検索KWを Brave で1回検索し、上位のコンテンツのページ（地図・SNS・通販・データベース系などは除く）を5件まで読んで、見出しと文字数を並べる */
const olWhenFull = s => s ? new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
async function olCompete(force) {
  const box = $('ol-comp'), cur = OL; if (!box) return;
  if (!OL.comp || force) { try { OL.comp = await api('/outline/competitors?key=' + encodeURIComponent(OL.key)); OL.compSel = 0; } catch (e) { box.innerHTML = '<p class="err">競合調査を読み込めませんでした：' + esc(e.message) + '</p>'; return; } }
  if (cur !== OL || !$('ol-comp')) return;
  const c = OL.comp, u = c.usage, full = u.queries >= u.limit, x = c.list[OL.compSel || 0];
  const usd = v => '$' + (Math.round(v * 1000) / 1000).toFixed(3);
  let h = '<div class="ol-comp-head"><h3 class="ol-h3">競合調査 <span class="note">検索KW：</span><b>' + esc(c.kw || '—') + '</b></h3><span class="ol-sp"></span>'
    + (c.canRun ? '<button class="btn primary" type="button" id="ol-comp-run"' + (full || !c.kw ? ' disabled' : '') + '>' + (x ? '取得し直す' : '競合を取得') + '（Brave 1回）</button>' : '') + '</div>'
    + '<p class="ol-comp-usage' + (full ? ' full' : '') + '">' + esc(mediaLabel(u.media)) + 'の今月（' + esc(u.ym.replace('-', '年')) + '月）：<b>' + u.queries + '</b> / ' + u.limit + '回・費用 ' + usd(u.costUsd) + '（1回 ' + usd(u.priceUsd) + '。支出のツール利用費に入ります。Brave の無料分は全体で月 約1,000回）・ドメインパワー（Ahrefs）' + nf.format(u.ahrefsUnits || 0) + 'ユニット'
    + (full ? '　<b>今月の上限に達したため、来月まで取得できません</b>' : '') + '</p>';
  if (!x) { box.innerHTML = h + '<p class="empty">まだ取得していません。' + (c.canRun ? '「競合を取得」を押すと、検索上位のコンテンツのページを5件まで読みます（地図・SNS・動画・通販・データベース系のサイトは除きます）。' : '') + '</p>'; olBindComp(); return; }
  h += '<div class="ol-comp-meta">取得：<b>' + esc(olWhenFull(x.at)) + '</b>（' + esc(x.name || '') + '）・検索 ' + x.queries + '回・費用 ' + usd(x.costUsd || 0) + (x.ahrefsUnits != null ? '・Ahrefs ' + nf.format(x.ahrefsUnits) + 'ユニット' : '')
    + (c.list.length > 1 ? '　<label>過去の取得 <select id="ol-comp-sel">' + c.list.map((y, i) => '<option value="' + i + '"' + (i === (OL.compSel || 0) ? ' selected' : '') + '>' + esc(olWhenFull(y.at)) + '</option>').join('') + '</select></label>' : '')
    + '<span class="ol-sp"></span>平均文字数 <b class="num">' + (x.avgChars != null ? nf.format(x.avgChars) : '—') + '</b>文字</div>';
  const drTag = v => '<span class="ol-dr" title="ドメインパワー（Ahrefs のドメインレーティング。0〜100）">ドメインパワー <b>' + (v == null ? '—' : v) + '</b></span>';
  const ed = OL.canEdit;
  h += x.sites.length ? '<div class="ol-comp-grid" style="grid-template-columns:repeat(' + x.sites.length + ', minmax(250px, 1fr))">' + x.sites.map((st, i) => '<div class="ol-comp-col">'
    + '<div class="ol-comp-rank">' + (i + 1) + '位 <span class="note">（検索' + st.rank + '位）</span>' + (st.own ? ' <span class="pill wait">自社</span>' : '') + '</div>'
    + '<div class="ol-comp-site"><b>' + esc(String(st.siteName || st.domain || '').split(/\s*[|｜]\s*/).pop()) + '</b>' + drTag(st.dr) + '</div>'   /* 順位のすぐ下にメディア名とドメインパワー（2026-11-13 ユーザー指定） */
    + '<div class="ol-comp-title">' + esc(st.title || '') + '</div><a class="ol-upurl" href="' + escUrl(st.url) + '" target="_blank" rel="noopener">' + esc(st.url) + '</a>'
    + '<div class="ol-comp-chars">文字数 <b class="num">' + nf.format(st.chars) + '</b></div>'
    /* 文字数の下に。足す＝青、置き換える＝オレンジ（2026-11-13 ユーザー指定） */
    + (ed ? '<div class="ol-comp-addall"><button class="btn sm ol-btn-blue" type="button" data-compall="' + i + '" data-mode="add">見出しをすべて構成に足す</button><button class="btn sm ol-btn-orange" type="button" data-compall="' + i + '" data-mode="replace">すべて置き換える</button></div>' : '<div></div>')
    + '<div class="ol-comp-heads">' + (st.heads || []).map((hd, j) => '<div class="ol-ch ol-ch-' + hd.lv + '">' + (ed ? '<button class="ol-chadd" type="button" data-comph="' + i + ':' + j + '" title="' + (hd.lv === 1 ? 'タイトルに入れる' : '構成の最後に H' + hd.lv + ' で足す') + '">＋</button>' : '') + '<span>H' + hd.lv + '</span>' + esc(hd.text) + '</div>').join('') + '</div></div>').join('') + '</div>'
    : '<p class="empty">コンテンツのページが見つかりませんでした</p>';
  if ((x.skipped || []).length) h += '<details class="ol-comp-skip"><summary>除いたページ（' + x.skipped.length + '件）</summary><ul>' + x.skipped.map(k => '<li><span class="ol-sk-site">' + esc(k.siteName || k.domain || '') + '</span>' + drTag(k.dr) + '<a href="' + escUrl(k.url) + '" target="_blank" rel="noopener">' + esc(k.url) + '</a><span class="ol-sk-why">' + esc(k.why) + '</span></li>').join('') + '</ul></details>';
  box.innerHTML = h; olBindComp();
}
/** 競合の見出しを構成に入れる（1つずつ・一括）（2026-11-13 ユーザー指定）。H1 はタイトルに、H2〜H4 は構成の最後に足す。入れたら自動で保存 */
function olAddHeads(heads, mode) {
  if (!OL.canEdit) return;
  if (!OL.ol && !OL.creating) { OL.creating = true; OL.blocks = []; }
  if (mode === 'replace') { if (!confirm('すでに入っているものがすべて削除されますがよろしいですか？')) return; OL.blocks = []; }   /* 文言（2026-11-13 ユーザー指定）。「OK」で反映 */
  let n = 0, t = '';
  heads.forEach(hd => { if (hd.lv === 1) { if (!OL.title.trim() || mode === 'replace' || heads.length === 1) t = hd.text; return; } OL.blocks.push({ id: olNewId(), type: 'h' + Math.min(4, hd.lv), html: esc(hd.text) }); n++; });
  if (t && (heads.length === 1 && OL.title.trim() && OL.title !== t) && !confirm('タイトルを「' + t + '」に変えますか？')) t = '';
  if (t) OL.title = t;
  olDirty(true);
  toast(heads.length === 1 ? (heads[0].lv === 1 ? (t ? 'タイトルに入れました' : 'タイトルは変えていません') : '構成の最後に H' + heads[0].lv + ' を足しました') : '見出し ' + n + '個を構成に' + (mode === 'replace' ? '入れ替えました' : '足しました') + (t ? '（H1 はタイトルに）' : ''));
}
function olBindComp() {
  const box = $('ol-comp'), x = OL.comp && OL.comp.list[OL.compSel || 0];
  if (box && x) box.querySelectorAll('[data-comph]').forEach(b => b.onclick = () => { const [i, j] = b.dataset.comph.split(':').map(Number); olAddHeads([x.sites[i].heads[j]], 'add'); b.classList.add('done'); });
  if (box && x) box.querySelectorAll('[data-compall]').forEach(b => b.onclick = () => olAddHeads(x.sites[Number(b.dataset.compall)].heads || [], b.dataset.mode));
  const sel = $('ol-comp-sel'); if (sel) sel.onchange = () => { OL.compSel = Number(sel.value); olCompete(); };
  const run = $('ol-comp-run'); if (run) run.onclick = async () => {
    if (OL.comp.list.length && !confirm('もう一度取得すると、Brave を1回使います（今月 ' + OL.comp.usage.queries + ' / ' + OL.comp.usage.limit + '回）。取得しますか？')) return;
    run.disabled = true; run.textContent = '取得中…（30秒ほど）';
    try { const res = await apiSend('POST', '/outline/competitors', { key: OL.key }); OL.comp.list.unshift(res.result); OL.comp.usage = res.usage; OL.compSel = 0; { const ch = (res.result.sites || []).map(x => Number(x.chars)).filter(n => n > 0); if (ch.length) OL.compStats = { avg: Math.round(ch.reduce((t, n) => t + n, 0) / ch.length), max: Math.max(...ch), min: Math.min(...ch), n: ch.length }; } toast('競合を取得しました（' + res.result.sites.length + '件）'); }
    catch (e) { alert('取得できませんでした：' + e.message); }
    olCompete();
  };
}
/** 新しく作るときのひな形（記事のCTA・訴求ブロックを入れておく） */
function olStartBlank() {
  const r = OL.r; OL.creating = true; OL.dirty = true; OL.title = '';
  OL.blocks = [{ type: 'free', html: '導入：' }, { type: 'h2', html: '' }, { type: 'h3', html: '' }, { type: 'h3', html: '' }];
  if (r.appeal_block) OL.blocks.push({ type: 'appeal', block: olMatchBlock('appeal', r.appeal_block, 'appeal_block') });
  OL.blocks.push({ type: 'h2', html: 'まとめ' });
  if (r.cta) OL.blocks.push({ type: 'cta', block: olMatchBlock('cta', r.cta, 'cta') });
  OL.blocks.forEach(b => { b.id = olNewId(); });
}
const olMatchBlock = (t, v, k) => { const L = olBlocksOf(OL.media, t); const b = L.find(x => x.name === v) || L.find(x => blockHit(x.name, OL.r, k)); return b ? b.name : v; };

function paintOutline() {
  const box = $('ol-body'); if (!box || !OL) return;
  const r = OL.r, ed = OL.canEdit;
  const info = (h, v) => '<div><div class="ol-lab">' + h + '</div><div class="ol-val">' + (v == null || String(v).trim() === '' ? '<span class="note">—</span>' : v) + '</div></div>';
  const codeOf = (t, k) => { const v = r[k]; if (!v) return ''; const n = olMatchBlock(t, v, k), c = olCode(r.media, t, n); return esc(v) + (c ? '<code class="ol-inline-code">' + esc(c) + '</code>' : ''); };
  /* 構成シートで選べる進行状況は「構成チェック中」まで。今それより先なら、その状況を出すだけで選べない（2026-11-13 ユーザー指定） */
  const olStMax = STATUS_ORDER.indexOf('構成チェック中'), olStOk = s => { const k = STATUS_ORDER.indexOf(s); return k >= 0 && k <= olStMax; };
  const stOpts = statusesFor(r).filter(s => olStOk(s) || s === r.status).map(s => '<option' + (s === r.status ? ' selected' : '') + (olStOk(s) ? '' : ' disabled') + '>' + esc(s) + '</option>').join('');
  const upd = OL.ol ? '最終更新：' + esc(OL.ol.updatedBy) + '　' + esc(olWhen(OL.ol.updatedAt)) : '';
  OL.tab = OL.tab || state.olTab || 'outline';
  if (!OL.canCompete && OL.tab === 'compete') OL.tab = 'outline';
  const tabs = '<div class="seg ol-tabs" role="tablist">' + [['outline', '構成シート']].concat(OL.canCompete ? [['compete', '競合調査']] : []).map(([k, l]) => '<button type="button" data-oltab="' + k + '" aria-pressed="' + (OL.tab === k) + '">' + l + '</button>').join('') + '</div>';   /* 一番上で切り替え（2026-11-13 ユーザー指定） */
  const head = '<div class="ol-top"><button class="btn sm" type="button" id="ol-back">← コンテンツ進行管理</button>' + tabs + '<span class="ol-upd">' + upd + '</span><span class="ol-sp"></span>'
    + '' + manualBtn('outline') + '<button class="btn sm" type="button" id="ol-copyurl" title="この構成シートのURL（チャットワークなどで渡す）">URLをコピー</button></div>'
    + '<div class="ol-card"><div class="ol-head"><h2 class="ol-h">No.' + esc(r.no || '—') + '　' + esc(r.kw || '') + ' <span class="ol-type ol-type-' + ({ '新規': 'new', 'リライト': 'rw', '簡易リライト': 'lite' }[r.type] || 'other') + '">' + esc(r.type || '新規') + '</span><span class="ol-pill">進行管理から自動</span>'
    + (r.url ? '<a class="ol-upurl" href="' + escUrl(r.url) + '" target="_blank" rel="noopener" title="アップロードURL">' + esc(r.url) + '</a>' : '<span class="note ol-upnone">アップロードURL：—</span>') + '</h2>'
    + '<label class="ol-st">進行状況 <select id="ol-status"' + (!canEditArticles() ? ' disabled' : r.status && STATUS_ORDER.indexOf(r.status) > olStMax ? ' disabled title="構成チェック中より先の進行状況は、進行管理で変えてください"' : '') + '>' + stOpts + '</select> <span class="ol-pill">進行管理と連動</span></label></div>'
    + '<div class="ol-info">' + info('関連KW', esc(String(r.related_kw || '').split('\n').filter(Boolean).join('、'))) + info('ターゲット', esc(r.target)) + info('クエリタイプ', esc(r.query_type)) + info('ポジション', esc(r.position))
    + info('カテゴリ', esc(r.wp_categories ? r.wp_categories.join('、') : r.genre)) + info('タグ', esc(parseTags(r.tags).join('、'))) + info('CTA', codeOf('cta', 'cta')) + info('訴求ブロック', codeOf('appeal', 'appeal_block'))
    + info('ディレクション担当', esc(r.director)) + info('執筆担当', esc(r.writer)) + info('ライティングURL', '<span id="ol-wurl">' + olWurlHtml(r) + '</span>') + info('予定文字数', r.planned_chars ? nf.format(r.planned_chars) + '文字' : '') + info('構成URL', [OL.ol || isOutlineUrl(r.outline_url) ? '<a class="ol-upurl" href="' + escUrl(outlineUrl(r)) + '" title="この構成シートのURL">' + esc(outlineUrl(r)) + '</a>' : '', r.outline_url && !isOutlineUrl(r.outline_url) ? '<a href="' + escUrl(r.outline_url) + '" target="_blank" rel="noopener">添付のファイルを開く</a>' : ''].filter(Boolean).join('<br>')) + '</div></div>';
  if (OL.tab === 'compete') { box.innerHTML = head + (OL.ol || OL.creating ? '<div class="ol-card ol-tldcard"><h3 class="ol-h3">タイトル・リード文・ディスクリプション <span class="note">構成シートと同じ内容です（ここで直しても自動で保存されます）</span></h3>' + olTldHtml() + '</div>' : '') + '<div class="ol-card" id="ol-comp"><p class="loading">競合調査を読み込み中…</p></div>'; olBindHead(); olBindTld(); olCompete(); return; }
  if (!OL.ol && !OL.creating) {
    box.innerHTML = head + '<div class="ol-card">' + (ed ? '<h3 class="ol-h3">構成を用意する</h3>' + olChooserHtml() : '<p class="empty">まだ構成シートがありません' + (r.outline_url && !isOutlineUrl(r.outline_url) ? '（構成URLに添付のファイルがあります）' : '') + '</p>') + '</div>';
    olBindHead(); if (ed) olBindChooser(r, null, true); return;
  }
  const w = OL.viaWriter ? 'ディレクターから編集を渡されているので、編集できます。直したところは「ライター修正」と表示され、履歴に残ります。'
    : OL.canHand ? '' : ed ? '' : OL.ol && OL.ol.locked ? '確定済みのため、見るだけです。' : OL.ol && OL.ol.writerCanEdit ? '見るだけです（編集を渡されているのは、この記事の執筆担当のライターです）。' : '見るだけです。編集はディレクターが「ライターにも編集を渡す」をオンにするとできます。';
  const lab = (t, h) => '<div class="ol-flab"><span class="ol-lab">' + h + '</span>' + olCBtn('f:' + t) + '</div>';
  const disA = ed ? '' : ' disabled', disP = olCan() ? '' : ' disabled title="進行管理で入力する項目です"';
  const mf = (k, h, input, cls) => '<div class="ol-mf' + (cls ? ' ' + cls : '') + '"><div class="ol-flab"><span class="ol-lab">' + h + '</span></div><div class="ol-mfin">' + input + '</div><div class="ol-mfc">' + olCBtn('f:' + k) + '</div>' + olThWrap('f:' + k) + '</div>';
  const reason = k => '<input data-olm="' + k + '" value="' + esc(OL.meta[k] || '') + '" placeholder="理由"' + disA + '>';
  const isRw = /リライト/.test(r.type || '');
  const metaIn = ([k, h, kind, abc, old]) => kind === 'persona' ? mf(k, h + (ed ? '<button class="btn sm ol-pcopy" type="button" id="ol-pcopy">ペルソナをコピー</button>' : ''), olPersonaHtml(disA), 'ol-mf-persona') : old && !OL.meta[k] ? '' : mf(k, h, kind === 'in' ? '<input data-olm="' + k + '" value="' + esc(OL.meta[k] || '') + '"' + disA + '>' : '<textarea rows="2" data-olm="' + k + '"' + disA + '>' + esc(OL.meta[k] || '') + '</textarea>', abc ? 'ol-abc-' + abc : '');
  const design = '<div class="ol-card"><h3 class="ol-h3">記事の設計</h3><div class="ol-meta">'
    + mf('planned_chars', '想定文字数 <span class="ol-pill">進行管理と連動</span>', '<div class="ol-plrow"><input type="number" min="0" step="100" id="ol-planned" class="ol-short" value="' + esc(r.planned_chars == null ? '' : r.planned_chars) + '"' + disP + '><span id="ol-compchars">' + olCompCharsHtml() + '</span></div>')
    + mf('image_need', 'オリジナル画像作成の必要性', '<div class="ol-pair"><select data-olm="image_need"' + disA + '><option value="">未選択</option>' + ['必要', '不要'].map(o => '<option' + ((OL.meta.image_need || '') === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>' + reason('image_need_reason') + '</div>')
    + mf('existing_url', '既存記事URL <span class="ol-pill">進行管理から自動</span>', isRw ? (r.url ? '<a class="ol-upurl" href="' + escUrl(r.url) + '" target="_blank" rel="noopener">' + esc(r.url) + '</a>' : '<span class="note">進行管理に記事URLがありません</span>') : '<span class="note">新規記事のため、ありません</span>')
    + mf('urgency', '緊急性 <span class="ol-pill">進行管理と連動</span>', '<div class="ol-pair"><select id="ol-urgency"' + disP + '><option value="">未選択</option>' + URGENCY_OPTIONS.map(o => '<option' + (r.urgency === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>' + reason('urgency_reason') + '</div>')
    + OL_META.map(metaIn).join('') + '</div></div>';
  const marks = '<div class="ol-tb"><span>選んだ文字に色：</span>' + OL_MARKS.map(k => '<button class="btn sm" type="button" data-olmark="' + k + '"><span data-c="' + k + '">' + k + '</span></button>').join('') + '<button class="btn sm" type="button" data-olmark="">色を外す</button><span class="note">（内容の欄で文字をなぞってから押す）</span></div>';
  box.innerHTML = head + design + (isRw ? '<div class="ol-split"><div class="ol-split-main">' : '') + '<div class="ol-card">'
    /* 確定の帯は半分の幅にして、右にライティング用のドキュメント作成（2026-11-13 ユーザー指定） */
    + '<div class="ol-cfrow"><div class="ol-cfcol">' + olConfirmBar() + '</div><button class="btn primary ol-gdocbtn" type="button" id="ol-gdoc" title="あなたの Google ドライブに原稿用のドキュメントを作り、ライティングURLに入れます">ライティング用のGoogleドキュメントを作成</button></div>'
    + (OL.canHand ? '<label class="ol-hand"><input type="checkbox" id="ol-hand"' + (OL.ol && OL.ol.writerCanEdit ? ' checked' : '') + (OL.ol ? '' : ' disabled title="先に保存してください"') + '> この記事はライター（執筆担当' + (r.writer ? '：' + esc(r.writer) : '') + '）にも編集を渡す</label>' : '')
    + (w ? '<p class="ol-note' + (ed ? ' ok' : '') + '">' + w + '</p>' : '')
    + olTldHtml()
    + (ed ? marks : '')
    + (OL.ol && OL.ol.baseline ? '<label class="ol-showdiff"><input type="checkbox" id="ol-showdiff"' + (OL.showDiff !== false ? ' checked' : '') + '> 変更を色で表示（' + (OL.ol.confirmedAt ? '確定したとき' : '構成を作ったとき') + 'と比べる：<ins>追加</ins>・<del>削除</del>）</label>' : '')
    + '<div class="ol-scroll"><div class="ol-rowhead"><span>種類</span><span>内容</span><span>ブロック全体の色</span><span>目安字数</span><span class="ol-nh">' + OL_NOTES.map(x => '<span>' + x[1] + '</span>').join('') + '</span><span></span></div><div id="ol-rows"></div></div>'
    + (ed ? '<div class="ol-adds">' + OL_TYPES.map(([t, l]) => '<button class="btn sm" type="button" data-oladd="' + t + '">＋ ' + l + '</button>').join('') + '</div>' : '')
    + '<div class="ol-bar">' + (ed ? '<span id="ol-dirty" class="ol-dirty"></span>' : '') + '<span class="ol-sp"></span>'
    + (ed ? '<button class="btn" type="button" id="ol-reimport" title="構成をスプレッドシート・ドキュメントの内容で置き換えます">スプレッドシート・ドキュメントから読み込み直す</button>' : '') + '</div>'
    + '<p class="note" id="ol-sum"></p></div>'
    + (isRw ? '</div><aside class="ol-card ol-ex" id="ol-ex"></aside></div>' : '')
    + '<div class="ol-card"><div class="ol-lab">構成イメージ</div><div id="ol-prev" class="ol-prev"></div></div>'
    + '<div class="ol-card"><div class="ol-lab">変更の履歴</div><div id="ol-hist"></div></div>';
  olBindHead(); olRows(); olPrev(); olHist(); olDirty(); olDescN(); ['title', 'lead', 'description'].forEach(olRefreshFieldDiff);
  document.querySelectorAll('[data-olconfirm]').forEach(bt => bt.onclick = () => olConfirm(bt.dataset.olconfirm === 'reopen'));
  const sd = $('ol-showdiff'); if (sd) sd.onchange = () => { OL.showDiff = sd.checked; olRows(); ['title', 'lead', 'description'].forEach(olRefreshFieldDiff); };
  const ri = $('ol-reimport'); if (ri) ri.onclick = () => { openModal('<h2>スプレッドシート・ドキュメントから読み込み直す <small class="note">' + esc(r.kw || '') + '</small></h2><p class="note">読み込むと、今の構成を置き換えます（前の内容は「変更の履歴」から戻せます）。変更の色分けは、読み込んだ内容が基準になります。</p>' + olChooserHtml() + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" type="button" data-close>閉じる</button></div>'); document.querySelectorAll('#modal [data-olc]').forEach(x => { if (x.dataset.olc !== 'import') x.hidden = true; }); olBindChooser(r, null, true); document.querySelector('#modal [data-olc="import"]').click(); }; if (isRw) olExisting();
  /* 想定文字数・緊急性：進行管理にすぐ保存 */
  const prog = async (k, el, v) => { try { await apiSend('PATCH', '/article-items', { key: r.key, fields: { [k]: v } }); r[k] = v === '' ? null : (k === 'planned_chars' ? Number(v) : v); if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } toast('進行管理にも保存しました'); } catch (e) { el.value = r[k] == null ? '' : r[k]; alert('保存できませんでした：' + e.message); } };
  if ($('ol-planned')) $('ol-planned').onchange = ev => prog('planned_chars', ev.target, ev.target.value.trim());
  if ($('ol-urgency')) $('ol-urgency').onchange = ev => prog('urgency', ev.target, ev.target.value);
  if (!ed) return;
  olBindTld();
  if ($('ol-pcopy')) $('ol-pcopy').onclick = () => olPersonaCopy();
  const bindMeta = () => document.querySelectorAll('[data-olm]').forEach(el => { el.oninput = el.onchange = ev => { const k = el.dataset.olm, v = el.value; if (el.tagName === 'SELECT') el.classList.toggle('ol-ph', !v); if (v.trim()) OL.meta[k] = v; else delete OL.meta[k];
    /* 家族構成：人数の欄の出し入れと合計 */
    if (/^persona_family/.test(k)) { const t = olFamilyTotal(OL.meta); if (t != null) OL.meta.persona_family_total = String(t); else delete OL.meta.persona_family_total; if (ev.type === 'change' || k !== 'persona_family') { const box = $('ol-persona'); if (box) { const f = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.olm : ''; box.outerHTML = olPersonaHtml(disA); bindMeta(); const back = f && document.querySelector('[data-olm="' + f + '"]'); if (back && ev.type === 'input') { back.focus(); try { back.setSelectionRange(back.value.length, back.value.length); } catch (e) { /* 数字の欄 */ } } } } }
    olDirty(true); }; });
  bindMeta();
  document.querySelectorAll('[data-oladd]').forEach(b => b.onclick = () => { const t = b.dataset.oladd; setTimeout(olFillAllHeads, 0); OL.blocks.push(olBlk(t) ? { id: olNewId(), type: t, block: (olBlocksOf(OL.media, t)[0] || {}).name || '' } : { id: olNewId(), type: t, html: '' }); olDirty(true); olRows(); olPrev(); const eds = document.querySelectorAll('#ol-rows .ol-ed'); if (!olBlk(t) && eds.length) eds[eds.length - 1].focus(); });
  document.querySelectorAll('[data-olmark]').forEach(b => { b.onmousedown = ev => ev.preventDefault(); b.onclick = () => olMark(b.dataset.olmark); });
  const hd = $('ol-hand'); if (hd) hd.onchange = async () => {
    try { const res = await apiSend('PUT', '/outline', { key: OL.key, writerCanEdit: hd.checked, version: OL.ol.version }); OL.ol = res.outline; toast(hd.checked ? 'ライターに編集を渡しました' : 'ライターへの受け渡しを取り消しました'); olReloadHist(); }
    catch (e) { hd.checked = !hd.checked; alert('変えられませんでした：' + e.message); }
  };
}
/** リライトする既存記事の構成（H2〜H4・ブロック）を WordPress から読んで右に出す（2026-11-13 ユーザー指定） */
async function olExisting(force) {
  const box = $('ol-ex'); if (!box || !OL) return;
  const r = OL.r, cur = OL;
  const draw = () => {
    const x = OL.ex;
    if (!x) { box.innerHTML = '<p class="loading">既存記事の構成を読み込み中…</p>'; return; }
    if (x.error) { box.innerHTML = '<h3 class="ol-h3">既存記事の構成</h3><p class="err">' + esc(x.error) + '</p><button class="btn sm" type="button" id="ol-ex-re">もう一度読む</button>'; $('ol-ex-re').onclick = () => olExisting(true); return; }
    const lv = { h2: 0, h3: 1, h4: 2 };
    box.innerHTML = (OL.canEdit ? '<button class="btn ol-ex-copy" type="button" id="ol-ex-copy">既存記事の構成をコピー</button>' : '')
      + '<h3 class="ol-h3">既存記事の構成 <span class="note">（WordPress' + (x.fromEditor ? '・編集画面のブロックから判定' : '・公開ページの本文からブロックを判定') + '）</span></h3>'
      + '<div class="ol-ex-title">' + esc(x.title) + '</div>' + (x.link ? '<a class="ol-upurl" href="' + escUrl(x.link) + '" target="_blank" rel="noopener">' + esc(x.link) + '</a>' : '')
      + (x.items.length ? '<ol class="ol-ex-list">' + x.items.map(it => it.type[0] === 'h' ? '<li class="ol-ex-h" style="padding-left:' + (lv[it.type] * 14) + 'px"><span class="ol-ex-t">' + it.type.toUpperCase() + '</span>' + esc(it.text) + '</li>'
        : '<li class="ol-ex-b"><span class="ol-ex-t blk">' + ({ cta: 'CTA', appeal: '訴求', content: 'ブロック' }[it.type] || 'ブロック') + '</span>' + esc(it.name) + '</li>').join('') + '</ol>' : '<p class="note">見出し・ブロックが見つかりませんでした</p>');
    const cp = $('ol-ex-copy'); if (cp) cp.onclick = () => {
      const has = OL.blocks.some(b => olBlk(b.type) || olPlain(b.html).replace(/^(導入：|まとめ)$/, '').trim());
      if (has && !confirm('今の構成を、既存記事の構成で置き換えます。よろしいですか？（前の内容は「変更の履歴」から戻せます）')) return;
      OL.blocks = x.items.map(it => it.type[0] === 'h' ? { id: olNewId(), type: it.type, html: esc(it.text) } : it.type === 'cta' || it.type === 'appeal' || (it.type === 'content' && olBlocksOf(OL.media, 'content').some(y => y.name === it.name)) ? { id: olNewId(), type: it.type, block: it.name } : { id: olNewId(), type: 'free', html: esc('【ブロック：' + it.name + '】') });
      if (!OL.title.trim() && x.title) OL.title = x.title;
      OL.creating = OL.creating || !OL.ol; olDirty(true); paintOutline(); olFillAllHeads(); OL.copiedMsg = true; toast('既存記事から構成をコピーしました');   /* 表示の文言（2026-11-13 ユーザー指定） */
    };
  };
  if (OL.ex && !force) return draw();
  OL.ex = null; draw();
  try { OL.ex = await api('/outline/existing?media=' + encodeURIComponent(r.media) + '&id=' + encodeURIComponent(r.wp_id || '') + '&url=' + encodeURIComponent(r.url || '')); }
  catch (e) { OL.ex = { error: '既存記事の構成を読めませんでした：' + e.message }; }
  if (cur === OL) draw();
}
/** この内容で確定する／追加修正（2026-11-13 ユーザー指定） */
function olConfirmBar() {
  const o = OL.ol; if (!o || !(o.blocks || []).length) return '';
  const who = (at, by) => esc(olWhenFull(at)) + (by ? '（' + esc(by) + '）' : '');
  if (o.locked) return '<div class="ol-confirm locked"><span class="ol-cf-lab">確定済み</span>' + who(o.confirmedAt, o.confirmedBy) + '<span class="note">　' + (OL.canReopen ? '直すときは「追加修正」を押してください' : '直す必要があるときは、ディレクション担当に連絡してください') + '</span><span class="ol-sp"></span>' + (OL.canReopen ? '<button class="btn" type="button" data-olconfirm="reopen">追加修正</button>' : '') + '</div>';
  if (o.confirmedAt) return '<div class="ol-confirm reopen"><span class="ol-cf-lab">追加修正中</span>確定：' + who(o.confirmedAt, o.confirmedBy) + '<span class="note">　確定したときとの違いを色で表示しています' + (OL.canHand ? '' : '。直し終わったら、ディレクション担当に確定してもらってください') + '</span><span class="ol-sp"></span>' + (OL.canHand ? '<button class="btn primary" type="button" data-olconfirm="confirm">この内容で確定する</button>' : '') + '</div>';
  return OL.canHand ? '<div class="ol-confirm"><span class="note">構成が決まったら確定してください。確定すると変更の色分けが消え、直すときは「追加修正」から直します（変更の履歴は残ります）。</span><span class="ol-sp"></span><button class="btn primary" type="button" data-olconfirm="confirm">この内容で確定する</button></div>' : '';
}
async function olConfirm(reopen) {
  if (!reopen && !confirm('この内容で確定します。変更の色分けは消え、確定後に直すときは「追加修正」を押します。よろしいですか？')) return;
  try {
    if (!reopen && (OL.dirty || OL.saving)) { await olSave(); if (OL.dirty) throw new Error('保存できていない変更があります'); }
    await apiSend('POST', '/outline/confirm', { key: OL.key, reopen });
    toast(reopen ? '追加修正を始めました（確定したときとの違いが色で出ます）' : 'この内容で確定しました');
    render();
  } catch (e) { alert((reopen ? '追加修正にできませんでした：' : '確定できませんでした：') + e.message); }
}
function olBindHead() {
  const r = OL.r;
  document.querySelectorAll('[data-oltab]').forEach(b => b.onclick = () => { OL.tab = state.olTab = b.dataset.oltab; paintOutline(); });
  $('ol-back').onclick = () => { state.view = isWriterOnly() ? 'am-monthly' : 'am-progress'; render(); };
  $('ol-copyurl').onclick = () => olCopyText(outlineUrl(r), 'URLをコピーしました');
  const st = $('ol-status'); if (st) st.onchange = async () => {
    const v = st.value, miss = missingFor(r, v);
    if (miss.length) { st.value = r.status || ''; return showInputError('「' + v + '」にできません', miss.map(x => x + (/^ガイドライン確認/.test(x) ? 'が終わっていません（「ガイドライン確認」ボタンから）' : 'が入力されていません'))); }
    try { await apiSend('PATCH', '/article-items', { key: r.key, fields: { status: v } }); r.status = v; if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } toast('進行状況を「' + v + '」にしました（進行管理にも反映）'); }
    catch (e) { st.value = r.status || ''; alert('保存できませんでした：' + e.message); }
  };
}
/* ===== 変更の色分け：構成を作ったとき（読み込み直したときはそのとき）の内容と比べ、追加＝青、削除＝赤の取り消し線（2026-11-13 ユーザー指定） ===== */
const olTxt = b => olBlk(b.type) ? String(b.block || '') : (b.type === 'image' ? (b.img ? '［画像あり］' : '［画像なし］') : '') + olPlain(b.html || '').replace(/\s+/g, ' ').trim();
function olDiffText(a, b) {
  a = [...String(a || '')]; b = [...String(b || '')];
  if (a.length * b.length > 400000) return '<del>' + esc(a.join('')) + '</del><ins>' + esc(b.join('')) + '</ins>';
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = '', cur = '', mode = '';
  const flush = () => { if (!cur) return; out += mode === 'd' ? '<del>' + esc(cur) + '</del>' : mode === 'i' ? '<ins>' + esc(cur) + '</ins>' : esc(cur); cur = ''; };
  const put = (md, ch) => { if (md !== mode) { flush(); mode = md; } cur += ch; };
  while (i < n && j < m) { if (a[i] === b[j]) { put('', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) put('d', a[i++]); else put('i', b[j++]); }
  while (i < n) put('d', a[i++]); while (j < m) put('i', b[j++]); flush();
  return out;
}
/** 今のブロックと基準のブロックの対応（id → 同じ種類・同じ文字）。基準にだけあるもの＝削除 */
function olBaseMap() {
  const base = OL.showDiff !== false && OL.ol && OL.ol.baseline && OL.ol.baseline.blocks; if (!base) return null;
  const used = new Set(), match = {};
  OL.blocks.forEach(b => { const j = base.findIndex((x, k) => !used.has(k) && x.id && x.id === b.id); if (j >= 0) { used.add(j); match[b.id] = base[j]; } });
  OL.blocks.forEach(b => { if (match[b.id]) return; const j = base.findIndex((x, k) => !used.has(k) && x.type === b.type && olTxt(x) === olTxt(b)); if (j >= 0) { used.add(j); match[b.id] = base[j]; } });
  /* id のない基準（前に作った構成など）：前後の対応の間にある、同じ種類のブロックを「修正」とみなす */
  OL.blocks.forEach((b, i) => {
    if (match[b.id]) return;
    let lo = -1, hi = base.length;
    for (let q = i - 1; q >= 0; q--) { const x = match[OL.blocks[q].id]; if (x) { lo = base.indexOf(x); break; } }
    for (let q = i + 1; q < OL.blocks.length; q++) { const x = match[OL.blocks[q].id]; if (x) { hi = base.indexOf(x); break; } }
    const j = base.findIndex((x, k) => k > lo && k < hi && !used.has(k) && !x.id && x.type === b.type);
    if (j >= 0) { used.add(j); match[b.id] = base[j]; }
  });
  const del = [];
  base.forEach((x, k) => { if (used.has(k)) return; let pos = -1; for (let q = k - 1; q >= 0; q--) { if (!used.has(q)) continue; const ci = OL.blocks.findIndex(b => match[b.id] === base[q]); if (ci >= 0) { pos = ci; break; } } del.push({ x, pos }); });
  return { match, del };
}
function olRowDiff(b, M) {
  if (!M) return '';
  const x = M.match[b.id]; if (!x) return '<span class="ol-diff-lab add">追加</span>';
  const ta = olTxt(x), tb = olTxt(b), tc = x.type !== b.type;
  if (ta === tb && !tc) return '';
  return '<span class="ol-diff-lab mod">修正</span>' + (tc ? '<del>' + OL_TL[x.type] + '</del>→<ins>' + OL_TL[b.type] + '</ins> ' : '') + (ta !== tb ? olDiffText(ta, tb) : '');
}
function olFieldDiff(k) {
  const bl = OL.showDiff !== false && OL.ol && OL.ol.baseline; if (!bl) return '';
  const a = String(bl[k] || ''), b = String(OL[k] || ''); if (a === b) return '';
  return '<span class="ol-diff-lab mod">' + (a ? '修正' : '追加') + '</span>' + olDiffText(a, b);
}
function olRefreshFieldDiff(k) { const d = $('ol-fdiff-' + k); if (d) { const h = olFieldDiff(k); d.innerHTML = h; d.hidden = !h; } }
/* ===== 内部リンク：同じメディアの記事をプルダウンで選ぶ。ピラーページ＝青・ロングテール＝黄・キラーページ＝赤（2026-11-13 ユーザー指定） ===== */
const olPosCls = pos => /ピラー/.test(pos || '') ? 'pillar' : /ロングテール/.test(pos || '') ? 'long' : /キラー/.test(pos || '') ? 'killer' : 'other';
const olPosShort = pos => /ピラー/.test(pos || '') ? 'ピラー' : /ロングテール/.test(pos || '') ? 'ロングテール' : /キラー/.test(pos || '') ? 'キラー' : '';
const olNoKey = v => String(v || '').normalize('NFKC').replace(/[ー－‐−]/g, '-').replace(/^No\.?/i, '').trim();
function olLinkItems() { return (ITEMS || []).filter(x => x.media === OL.media && x.key !== OL.key && x.no && x.kw).sort((a, b) => String(a.no).localeCompare(String(b.no), 'ja', { numeric: true })); }
/** 内部リンクの1行（「No.1ー50 ネズミ の 巣」など）から記事を探す */
function olLinkItem(line) { const no = olNoKey(String(line || '').trim().split(/\s+/)[0]); return no ? olLinkItems().find(x => olNoKey(x.no) === no) : null; }
/** 公開中か（記事URLがあり、アップロード日が今日まで） */
const olPublished = x => !!x.url && (!x.upload_date || String(x.upload_date).slice(0, 10) <= todayJst());
/** 内部リンクを選ぶ画面：公開中／公開前、ポジション、ディレクトリで絞り込み、見出しを押して並べ替え（2026-11-13 ユーザー指定） */
function olLinkPicker(bi) {
  const st = OL.lkState = OL.lkState || { sub: state.artSub || '', pub: '', pos: '', q: '', sort: 'no', dir: 1 };
  const all = olLinkItems(), subs = [...new Set(all.map(x => x.sub).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const posOrder = { pillar: 0, long: 1, killer: 2, other: 3 };
  openModal('<h2>内部リンクを選ぶ <small class="note">' + esc(mediaLabel(OL.media)) + '</small></h2>'
    + '<div class="row ol-lkf" style="gap:8px;flex-wrap:wrap;align-items:flex-end">'
    + (subs.length ? '<label class="field">ディレクトリ<select id="lk-sub"><option value="">すべて</option>' + subs.map(x => '<option' + (x === st.sub ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>' : '')
    + '<label class="field">公開<select id="lk-pub"><option value="">すべて</option><option value="1"' + (st.pub === '1' ? ' selected' : '') + '>公開中</option><option value="0"' + (st.pub === '0' ? ' selected' : '') + '>公開前</option></select></label>'
    + '<label class="field">ポジション<select id="lk-pos"><option value="">すべて</option>' + [['pillar', 'ピラーページ'], ['long', 'ロングテールページ'], ['killer', 'キラーページ'], ['other', 'そのほか']].map(([c, l]) => '<option value="' + c + '"' + (st.pos === c ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
    + '<label class="field" style="flex:1">探す<input id="lk-q" value="' + esc(st.q) + '" placeholder="No.・検索KW"></label></div>'
    + '<div id="lk-list" class="ol-lklist"></div>'
    + '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>');
  const draw = () => {
    const b = OL.blocks[bi], have = String(b.link || '').split('\n').map(x => x.trim()).filter(Boolean);
    let L = all.filter(x => (!st.sub || x.sub === st.sub) && (!st.pub || (st.pub === '1') === olPublished(x)) && (!st.pos || olPosCls(x.position) === st.pos) && (!st.q || (String(x.no) + ' ' + x.kw).normalize('NFKC').toLowerCase().includes(st.q.normalize('NFKC').toLowerCase())));
    const key = { no: x => String(x.no), kw: x => String(x.kw), pos: x => posOrder[olPosCls(x.position)], pub: x => olPublished(x) ? 0 : 1, sub: x => String(x.sub || '') }[st.sort];
    L = L.slice().sort((x, y) => { const a1 = key(x), b1 = key(y); return (typeof a1 === 'number' ? a1 - b1 : String(a1).localeCompare(String(b1), 'ja', { numeric: true })) * st.dir || String(x.no).localeCompare(String(y.no), 'ja', { numeric: true }); });
    const th = (k, l) => '<th class="c-txt" data-lksort="' + k + '" style="cursor:pointer">' + l + (st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    $('lk-list').innerHTML = '<p class="note">' + L.length + '件。見出しを押すと並べ替え、行を押すと内部リンクに入ります（もう一度押すと外します）。</p><div class="table-wrap"><table class="am-table"><thead><tr>' + th('no', 'No.') + th('kw', '検索KW') + th('pos', 'ポジション') + th('pub', '公開') + (subs.length ? th('sub', 'ディレクトリ') : '') + '</tr></thead><tbody>'
      + L.map(x => { const ln = 'No.' + x.no + ' ' + x.kw, on = have.includes(ln); return '<tr class="ol-lkrow' + (on ? ' on' : '') + '" data-lkkey="' + esc(x.key) + '"><td class="c-txt">' + (on ? '✓ ' : '') + 'No.' + esc(x.no) + '</td><td class="c-txt">' + esc(x.kw) + '</td><td class="c-txt"><span class="ol-lk ol-lk-' + olPosCls(x.position) + '" style="display:inline-block">' + esc(olPosShort(x.position) || 'なし') + '</span></td><td class="c-txt">' + (olPublished(x) ? '<span class="pill ok">公開中</span>' : '<span class="pill off">公開前</span>') + '</td>' + (subs.length ? '<td class="c-txt">' + esc(x.sub || '') + '</td>' : '') + '</tr>'; }).join('')
      + '</tbody></table></div>';
    document.querySelectorAll('[data-lksort]').forEach(h => h.onclick = () => { const k = h.dataset.lksort; if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = 1; } draw(); });
    document.querySelectorAll('[data-lkkey]').forEach(tr => tr.onclick = () => {
      const it = all.find(x => x.key === tr.dataset.lkkey); if (!it) return;
      const ln = 'No.' + it.no + ' ' + it.kw, cur = String(b.link || '').split('\n').map(x => x.trim()).filter(Boolean), j = cur.indexOf(ln);
      if (j >= 0) cur.splice(j, 1); else cur.push(ln);
      if (cur.length) b.link = cur.join('\n'); else delete b.link;
      olDirty(true); olRows(); draw();
    });
  };
  const bind = (id, k) => { const el = $(id); if (el) el.oninput = el.onchange = () => { st[k] = el.value; draw(); }; };
  bind('lk-sub', 'sub'); bind('lk-pub', 'pub'); bind('lk-pos', 'pos'); bind('lk-q', 'q');
  draw();
}
/* ===== CTA・訴求ブロック・記事用コンテンツを選ぶ画面：ディレクトリで絞り込み、見出しを押して並べ替え（内部リンクと同じ形。2026-11-13 ユーザー指定） ===== */
const olNormName = v => String(v || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
/** メディアのディレクトリ（進行管理の記事のディレクトリ＋決まっているディレクトリ） */
const olDirsOf = media => [...new Set((artSubs(media) || []).concat((ITEMS || []).filter(x => x.media === media && x.sub).map(x => x.sub)))].filter(Boolean);
/** ブロックの名前に含まれるディレクトリ（いちばん長く合うもの）。なければ「共通・そのほか」 */
function olBlockDir(name, dirs) {
  const n = olNormName(name); let best = '', bl = 0;
  /* 「ネズミ駆除」のディレクトリは「ネズミ」でも当てる（末尾の駆除・修理・工事・対策を除いた名前でも探す） */
  dirs.forEach(d => { const k = olNormName(d), core = k.replace(/(駆除|修理|工事|対策|交換)$/, ''); [k, core.length >= 2 ? core : ''].forEach(w => { if (w && n.includes(w) && w.length > bl) { best = d; bl = w.length; } }); });
  return best || '共通・そのほか';
}
function olBlockPicker(bi) {
  const b0 = OL.blocks[bi]; if (!b0) return;
  const t = b0.type, dirs = olDirsOf(OL.media), all = olBlocksOf(OL.media, t).map((x, j) => ({ name: x.name, id: x.id, code: x.code || '', dir: olBlockDir(x.name, dirs), j }));
  const used = [...new Set(all.map(x => x.dir))].sort((a, b) => (a === '共通・そのほか') - (b === '共通・そのほか') || a.localeCompare(b, 'ja'));
  const mine = OL.r && OL.r.sub && used.includes(OL.r.sub) ? OL.r.sub : '';
  const st = OL.bkState = OL.bkState && OL.bkState.t === t ? OL.bkState : { t, sub: mine, q: '', sort: 'dir', dir: 1 };
  openModal('<h2>' + OL_TL[t] + 'を選ぶ <small class="note">' + esc(mediaLabel(OL.media)) + '</small></h2>'
    + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">'
    + '<label class="field">ディレクトリ<select id="bk-sub"><option value="">すべて</option>' + used.map(x => '<option' + (x === st.sub ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>'
    + '<label class="field" style="flex:1">探す<input id="bk-q" value="' + esc(st.q) + '" placeholder="ブロックの名前"></label></div>'
    + '<div id="bk-list" class="ol-lklist"></div>'
    + '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" type="button" data-close>閉じる</button></div>');
  const draw = () => {
    const b = OL.blocks[bi], q = olNormName(st.q);
    let L = all.filter(x => (!st.sub || x.dir === st.sub) && (!q || olNormName(x.name).includes(q)));
    const key = { name: x => x.name, dir: x => (x.dir === '共通・そのほか' ? '￿' : '') + x.dir, id: x => Number(x.id) || 0 }[st.sort];
    L = L.slice().sort((x, y) => { const a1 = key(x), b1 = key(y); return (typeof a1 === 'number' ? a1 - b1 : String(a1).localeCompare(String(b1), 'ja', { numeric: true })) * st.dir || x.j - y.j; });
    const th = (k, l) => '<th class="c-txt" data-bksort="' + k + '" style="cursor:pointer">' + l + (st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    $('bk-list').innerHTML = '<p class="note">' + L.length + '件。見出しを押すと並べ替え、行を押すとこのブロックに決まります。</p><div class="table-wrap"><table class="am-table"><thead><tr>' + th('name', '名前') + th('dir', 'ディレクトリ') + th('id', '番号') + '</tr></thead><tbody>'
      + (L.length ? L.map(x => { const on = x.name === b.block; return '<tr class="ol-lkrow' + (on ? ' on' : '') + '" data-bkj="' + x.j + '"><td class="c-txt">' + (on ? '✓ ' : '') + esc(x.name) + '</td><td class="c-txt">' + esc(x.dir) + '</td><td class="c-txt note">' + (x.id ? '#' + esc(x.id) : '') + '</td></tr>'; }).join('') : '<tr><td class="c-txt note" colspan="3">当てはまるブロックがありません</td></tr>')
      + '</tbody></table></div>';
    document.querySelectorAll('[data-bksort]').forEach(h => h.onclick = () => { const k = h.dataset.bksort; if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = 1; } draw(); });
    document.querySelectorAll('[data-bkj]').forEach(tr => tr.onclick = () => {
      const it = all.find(x => x.j === +tr.dataset.bkj); if (!it) return;
      if (it.name !== b.block) { b.block = it.name; delete b.heads; olDirty(true); }
      closeModal(); olRows(); olPrev(); olFillAllHeads();
    });
  };
  const bind = (id, k) => { const el = $(id); if (el) el.oninput = el.onchange = () => { st[k] = el.value; draw(); }; };
  bind('bk-sub', 'sub'); bind('bk-q', 'q');
  draw();
}
function olLinkCell(b, i, ed) {
  const lines = String(b.link || '').split('\n').map(x => x.trim()).filter(Boolean);
  const chips = lines.map((ln, j) => { const it = olLinkItem(ln), c = olPosCls(it && it.position); return '<span class="ol-lk ol-lk-' + c + '" title="' + esc((it ? (it.position || '') + (it.url ? '　' + it.url : '　（未公開）') : 'この記事は見つかりません')) + '">' + esc(ln) + (ed ? '<button type="button" data-ollinkdel="' + i + ':' + j + '" aria-label="外す">×</button>' : '') + '</span>'; }).join('');
  const opts = ed ? '<button class="btn sm ol-lkbtn" type="button" data-ollinkpick="' + i + '">＋ 内部リンクを選ぶ</button>' : '';
  return '<div class="ol-links">' + chips + opts + (lines.length || ed ? '' : '<span class="note">—</span>') + '</div>';
}
/* ===== 画像イメージ：画面で縮めて（長い辺1600px・JPEG）保存し、番号で読み出す（2026-11-13 ユーザー指定） ===== */
const OL_IMG_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
function olImgLoad(id) {
  OL.imgs = OL.imgs || {}; OL.imgP = OL.imgP || {};
  if (OL.imgs[id]) return Promise.resolve(OL.imgs[id]);
  if (!OL.imgP[id]) { const cur = OL; OL.imgP[id] = api('/outline/image?key=' + encodeURIComponent(OL.key) + '&id=' + id).then(d => { cur.imgs[id] = d.data; if (cur === OL) document.querySelectorAll('img[data-olimg="' + id + '"]').forEach(im => { im.src = d.data; }); return d.data; }).catch(e => { delete cur.imgP[id]; throw e; }); }
  return OL.imgP[id];
}
function olImgSrc(id) { if (OL.imgs && OL.imgs[id]) return OL.imgs[id]; olImgLoad(id).catch(() => {}); return OL_IMG_BLANK; }
async function olShrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image(); await new Promise((ok, ng) => { im.onload = ok; im.onerror = () => ng(new Error('画像を読めませんでした')); im.src = url; });
    for (const [mx, q] of [[1600, 0.85], [1200, 0.75], [900, 0.7]]) {
      const k = Math.min(1, mx / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
      const d = c.toDataURL('image/jpeg', q); if (d.length <= 950000) return d;
    }
    throw new Error('画像が大きすぎます');
  } finally { URL.revokeObjectURL(url); }
}
async function olImgUpload(i, file) {
  if (!OL || !OL.canEdit || !OL.blocks[i]) return;
  if (!/^image\//.test(file.type || '')) return toast('画像のファイルを選んでください');
  const cur = OL, bid = OL.blocks[i].id; toast('画像を入れています…');
  try {
    const data = await olShrink(file), res = await apiSend('POST', '/outline/image', { key: cur.key, data });
    if (cur !== OL) return; const b = OL.blocks.find(x => x.id === bid); if (!b) return;
    OL.imgs = OL.imgs || {}; OL.imgs[res.id] = data; b.img = res.id;
    olDirty(true); olRows(); olPrev(); toast('画像を入れました');
  } catch (e) { alert('画像を入れられませんでした：' + e.message); }
}
function olRows() {
  const box = $('ol-rows'); if (!box) return;
  const ed = OL.canEdit, dis = ed ? '' : ' disabled';
  const M = olBaseMap(), delAt = i => !M ? '' : M.del.filter(d => d.pos === i).map(d => '<div class="ol-row-del"><span class="ol-diff-lab del">削除</span>' + OL_TL[d.x.type] + '：<del>' + esc(olTxt(d.x) || '（空）') + '</del></div>').join('');
  box.innerHTML = delAt(-1) + (OL.blocks.length ? OL.blocks.map((b, i) => {
    const types = OL_TYPES.map(([t, l]) => '<option value="' + t + '"' + (t === b.type ? ' selected' : '') + '>' + l + '</option>').join('');
    let body;
    if (olBlk(b.type)) {
      const L = olBlocksOf(OL.media, b.type).map(x => x.name), code = olCode(OL.media, b.type, b.block);
      const opts = (b.block && !L.includes(b.block) ? '<option selected value="' + esc(b.block) + '">' + esc(b.block) + '（設定にない名前）</option>' : '') + (L.length ? '' : '<option value="">（マイブロックがありません）</option>') + L.map(n => '<option' + (n === b.block ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
      const nf0 = b.block && !L.includes(b.block) ? '<span class="note">（設定にない名前）</span>' : '';
      body = (ed ? '<button class="btn sm ol-blkbtn" type="button" data-olblkpick="' + i + '" title="ディレクトリで絞り込んで選ぶ">' + esc(b.block || (L.length ? '選ぶ' : '（マイブロックがありません）')) + ' ▾</button>' + nf0 : '<b>' + esc(b.block || '—') + '</b>' + nf0) + (code ? '<pre class="ol-code">' + esc(code) + '</pre>' : '')
        + (b.type === 'content' ? '<div class="ol-heads">' + (b.heads == null ? '<span class="note">見出しを読み込み中…</span>' : b.heads.length ? b.heads.map(h => '<div class="ol-hd ol-hd-' + h.type + '"><span>' + h.type.toUpperCase() + '</span>' + esc(h.text) + '</div>').join('') : '<span class="note">見出しはありません</span>') + '</div>' : '');
    } else if (b.type === 'image') {
      /* 画像イメージ：貼り付け（Ctrl+V）・ドラッグ・ファイルを選ぶ（2026-11-13 ユーザー指定） */
      body = '<div class="ol-img">' + (b.img ? '<img class="ol-imgv" data-olimg="' + b.img + '" src="' + olImgSrc(b.img) + '" alt="画像イメージ">' : '')
        + (ed ? '<div class="ol-imgdrop" tabindex="0" data-olpaste="' + i + '"><span>' + (b.img ? '画像を替えるときは、' : '') + 'ここを押して <b>Ctrl+V</b> で貼り付け、または画像をここにドラッグ</span><label class="btn sm">ファイルを選ぶ<input type="file" accept="image/*" data-olfile="' + i + '" hidden></label>' + (b.img ? '<button class="btn sm" type="button" data-olimgdel="' + i + '">画像を外す</button>' : '') + '</div>' : (b.img ? '' : '<span class="note">画像はまだありません</span>')) + '</div>'
        + '<div class="ol-ed ol-t-free ol-t-imgcap" contenteditable="' + ed + '" data-i="' + i + '" data-ph="画像の説明（任意）">' + (b.html || '') + '</div>';
    } else body = '<div class="ol-ed ol-t-' + b.type + (b.type === 'reco' ? ' ol-t-free' : '') + '" contenteditable="' + ed + '" data-i="' + i + '"' + (b.box ? ' data-box="' + b.box + '"' : '') + ' data-ph="' + (b.type === 'free' ? '自由記入（Shift+Enterで改行）' : b.type === 'reco' ? 'このような方にオススメ（1行に1つ。Shift+Enterで改行）' : OL_TL[b.type] + 'の見出し') + '">' + (b.html || '') + '</div>';
    const boxSel = '<select data-olk="box" data-i="' + i + '"' + (olBlk(b.type) || b.type === 'image' || !ed ? ' disabled' : '') + '><option value="">なし</option>' + OL_MARKS.map(k => '<option' + (k === b.box ? ' selected' : '') + '>' + k + '</option>').join('') + '</select>';
    const wr = b.byWriter ? '<span class="ol-wr" title="' + esc((b.by || '') + '　' + olWhen(b.at)) + '">ライター修正</span>' : '';
    const dh = olRowDiff(b, M), chg = !M ? '' : !M.match[b.id] ? ' ol-chg-add' : dh ? ' ol-chg-mod' : '';
    return '<div class="ol-row ol-lv-' + b.type + chg + '" title="' + esc(b.by ? '最後に直した人：' + b.by + '　' + olWhen(b.at) : '') + '"><select data-olk="type" data-i="' + i + '"' + dis + '>' + types + '</select><div class="ol-cell">' + body + wr + '<div class="ol-diff"' + (dh ? '' : ' hidden') + '>' + dh + '</div></div>' + boxSel
      + '<input type="number" min="0" step="50" data-olk="chars" data-i="' + i + '" value="' + (b.chars || '') + '"' + (olBlk(b.type) || b.type === 'image' || !ed ? ' disabled' : '') + ' placeholder="字数">'
      + '<div class="ol-notes">' + OL_NOTES.map(([k, h]) => k === 'link' ? olLinkCell(b, i, ed) : '<textarea rows="2" data-olk="' + k + '" data-i="' + i + '" placeholder="' + h + '"' + dis + '>' + esc(b[k] || '') + '</textarea>').join('') + '</div>'
      + '<div class="ol-ops">' + olCBtn('b:' + b.id) + (ed ? '<select class="ol-ins" data-olins="' + i + '" title="この行の下に足す"><option value="" selected>＋下に</option>' + OL_TYPES.map(([t, l]) => '<option value="' + t + '">' + l + '</option>').join('') + '</select>' : '') + (ed ? '<button class="btn sm" type="button" data-olmv="-1" data-i="' + i + '" title="上へ" aria-label="上へ">↑</button><button class="btn sm" type="button" data-olmv="1" data-i="' + i + '" title="下へ" aria-label="下へ">↓</button><button class="btn sm" type="button" data-oldel="' + i + '" title="削除" aria-label="削除">×</button>' : '') + '</div>' + olThWrap('b:' + b.id) + '</div>' + delAt(i);
  }).join('') : '<p class="empty">ブロックがありません' + (ed ? '（下の「＋」で足してください）' : '') + '</p>');
  if (!ed) return;
  box.oninput = ev => { const el = ev.target; if (el.tagName === 'TEXTAREA' && OL_NOTES.some(x => x[0] === el.dataset.olk)) { const b = OL.blocks[+el.dataset.i], v = el.value; if (v.trim()) b[el.dataset.olk] = v; else delete b[el.dataset.olk]; olDirty(true); return; } if (!el.classList.contains('ol-ed')) return; const b0 = OL.blocks[+el.dataset.i]; b0.html = olClean(el.innerHTML); olDirty(true); olPrev();
    const M = olBaseMap(), row = el.closest('.ol-row'), dv = row && row.querySelector('.ol-diff'); if (dv && M) { const h = olRowDiff(b0, M); dv.innerHTML = h; dv.hidden = !h; row.classList.toggle('ol-chg-mod', !!h && !!M.match[b0.id]); } };
  box.onchange = ev => { const el = ev.target, k = el.dataset.olk;
    if (el.dataset.ollink != null) { const it = (ITEMS || []).find(x => x.key === el.value); if (!it) return; const b = OL.blocks[+el.dataset.ollink], ln = 'No.' + it.no + ' ' + it.kw; const cur = String(b.link || '').split('\n').map(x => x.trim()).filter(Boolean); if (!cur.includes(ln)) cur.push(ln); b.link = cur.join('\n'); olDirty(true); olRows(); return; }
    /* 構成の途中に行を足す（この行の下に。2026-11-13 ユーザー指定） */
    if (el.dataset.olins != null) { const t = el.value, at = +el.dataset.olins + 1; if (!t) return; OL.blocks.splice(at, 0, olBlk(t) ? { id: olNewId(), type: t, block: (olBlocksOf(OL.media, t)[0] || {}).name || '' } : { id: olNewId(), type: t, html: '' }); olDirty(true); olRows(); olPrev(); olFillAllHeads(); const e2 = document.querySelectorAll('#ol-rows .ol-row')[at]; const ed2 = e2 && e2.querySelector('.ol-ed'); if (ed2) ed2.focus(); return; }
    if (el.dataset.olfile != null) { const f = el.files && el.files[0]; el.value = ''; if (f) olImgUpload(+el.dataset.olfile, f); return; }
    if (!k || OL_NOTES.some(x => x[0] === k)) return; const b = OL.blocks[+el.dataset.i];
    if (k === 'type') { const nt = el.value; if (nt !== b.type && (olBlk(nt) || olBlk(b.type))) { const keep = { id: b.id }; OL_NOTES.forEach(([n]) => { if (b[n]) keep[n] = b[n]; }); OL.blocks[+el.dataset.i] = Object.assign(keep, olBlk(nt) ? { type: nt, block: (olBlocksOf(OL.media, nt)[0] || {}).name || '' } : { type: nt, html: '' }); } else b.type = nt; if (nt !== 'image') delete OL.blocks[+el.dataset.i].img; }
    else if (k === 'chars') b.chars = el.value ? Math.max(0, Math.round(Number(el.value) || 0)) : undefined;
    else if (k === 'box') { if (el.value) b.box = el.value; else delete b.box; }
    else { b[k] = el.value; if (k === 'block') delete b.heads; }
    olDirty(true); olRows(); olPrev(); olFillAllHeads(); };
  box.onclick = ev => { const bt = ev.target.closest('button'); if (!bt || bt.dataset.olct || bt.dataset.olcsend || bt.dataset.olcdel) return; const i = +bt.dataset.i;
    if (bt.dataset.olmv) { const j = i + Number(bt.dataset.olmv); if (j < 0 || j >= OL.blocks.length) return; [OL.blocks[i], OL.blocks[j]] = [OL.blocks[j], OL.blocks[i]]; }
    else if (bt.dataset.ollinkpick != null) { olLinkPicker(+bt.dataset.ollinkpick); return; }
    else if (bt.dataset.olblkpick != null) { olBlockPicker(+bt.dataset.olblkpick); return; }
    else if (bt.dataset.ollinkdel) { const [a, j] = bt.dataset.ollinkdel.split(':').map(Number), b = OL.blocks[a], cur = String(b.link || '').split('\n').map(x => x.trim()).filter(Boolean); cur.splice(j, 1); if (cur.length) b.link = cur.join('\n'); else delete b.link; }
    else if (bt.dataset.olimgdel != null) { if (!confirm('この画像を外します。よろしいですか？')) return; delete OL.blocks[+bt.dataset.olimgdel].img; }
    else if (bt.dataset.oldel != null) { const b = OL.blocks[+bt.dataset.oldel]; if ((b.html || b.block) && !confirm('「' + (olPlain(b.html) || b.block).slice(0, 20) + '」の行を削除します。よろしいですか？')) return; OL.blocks.splice(+bt.dataset.oldel, 1); }
    else return;
    olDirty(true); olRows(); olPrev(); };
  box.onkeydown = ev => { const el = ev.target; if (!el.classList || !el.classList.contains('ol-ed')) return; if (ev.key === 'Enter' && (el.classList.contains('ol-t-free') ? false : true)) ev.preventDefault(); };
  box.ondragover = ev => { const z = ev.target.closest && ev.target.closest('[data-olpaste]'); if (!z) return; ev.preventDefault(); z.classList.add('over'); };
  box.ondragleave = ev => { const z = ev.target.closest && ev.target.closest('[data-olpaste]'); if (z) z.classList.remove('over'); };
  box.ondrop = ev => { const z = ev.target.closest && ev.target.closest('[data-olpaste]'); if (!z) return; ev.preventDefault(); z.classList.remove('over'); const f = [...(ev.dataTransfer.files || [])].find(x => /^image\//.test(x.type)); if (f) olImgUpload(+z.dataset.olpaste, f); else toast('画像のファイルを入れてください'); };
  box.onpaste = ev => { const z = ev.target.closest && ev.target.closest('[data-olpaste]');
    if (z) { ev.preventDefault(); const it = [...((ev.clipboardData || {}).items || [])].find(x => x.kind === 'file' && /^image\//.test(x.type)); const f = it && it.getAsFile(); if (f) olImgUpload(+z.dataset.olpaste, f); else toast('貼り付けられる画像がありません（画像をコピーしてから Ctrl+V）'); return; }
    const el = ev.target.closest && ev.target.closest('.ol-ed'); if (!el) return; ev.preventDefault(); const t = (ev.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, el.classList.contains('ol-t-free') ? t : t.replace(/\s*\n\s*/g, ' ')); };
}
/** なぞった文字に色（印）を付ける・外す */
function olMark(k) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return toast('先に、内容の欄で色を付けたい文字をなぞってください');
  const rg = sel.getRangeAt(0), node = rg.commonAncestorContainer, ed = (node.nodeType === 1 ? node : node.parentNode).closest('.ol-ed');
  if (!ed) return toast('内容の欄の文字をなぞってください（ブロック全体は「ブロック全体の色」で選びます）');
  const frag = rg.extractContents(), tmp = document.createElement('div'); tmp.appendChild(frag);
  tmp.querySelectorAll('span[data-c]').forEach(s => s.replaceWith(...s.childNodes));
  let ins; if (k) { ins = document.createElement('span'); ins.setAttribute('data-c', k); ins.innerHTML = tmp.innerHTML; } else { ins = document.createDocumentFragment(); [...tmp.childNodes].forEach(c => ins.appendChild(c)); }
  rg.insertNode(ins);
  // なぞった範囲が色の中だけのときは、外側の色を分ける
  if (!k) { const p = (rg.startContainer.nodeType === 1 ? rg.startContainer : rg.startContainer.parentNode).closest('span[data-c]'); if (p && ed.contains(p)) p.replaceWith(...p.childNodes); }
  const i = +ed.dataset.i; OL.blocks[i].html = olClean(ed.innerHTML); ed.innerHTML = OL.blocks[i].html; sel.removeAllRanges();
  olDirty(true); olPrev();
}
/** 直したら自動で保存する（入力が止まって1.5秒後。2026-11-12 ユーザー指定） */
function olDirty(v) {
  if (v != null) OL.dirty = v;
  if (v === true) { OL.editSeq = (OL.editSeq || 0) + 1; OL.err = ''; clearTimeout(OL.timer); if (OL.canEdit && !OL.stop) OL.timer = setTimeout(() => olSave(), 1500); }
  olStatus();
  const sum = $('ol-sum'); if (sum) { const tot = OL.blocks.reduce((a, b) => a + (olBlk(b.type) ? 0 : (b.chars || 0)), 0); sum.textContent = '目安字数の合計 ' + nf.format(tot) + '文字' + (OL.r.planned_chars ? '／予定文字数 ' + nf.format(OL.r.planned_chars) + '文字（進行管理）' : ''); }
}
function olStatus() {
  const d = $('ol-dirty'); if (!d || !OL) return;
  const bad = !!(OL.stop || OL.err);
  d.style.color = bad ? 'var(--bad)' : OL.dirty || OL.saving ? '' : 'var(--muted)';
  d.textContent = OL.stop ? OL.stop : OL.err ? OL.err + '（次に入力したときにもう一度保存します）' : OL.saving ? '保存中…' : OL.dirty ? (OL.creating && !OL.ol && !OL.editSeq ? 'まだ保存されていません（入力すると自動で保存されます）' : '入力中…（自動で保存します）') : OL.savedAt ? '自動で保存しました（' + OL.savedAt + '）' : OL.ol ? '保存済み' : '';
}
async function olSave() {
  if (!OL || !OL.canEdit || OL.stop) return;
  clearTimeout(OL.timer);
  if (OL.saving) { OL.again = true; return; }
  if (!OL.dirty) return;
  const cur = OL, seq = OL.editSeq, first = !OL.ol;
  OL.saving = true; olStatus();
  try {
    const body = { key: OL.key, title: OL.title, lead: OL.lead, description: OL.description, meta: olClone(OL.meta), blocks: olClone(OL.blocks), version: OL.ol ? OL.ol.version : null };
    if (first && OL.r.outline_url && !isOutlineUrl(OL.r.outline_url)) body.sourceUrl = OL.r.outline_url;   // 添付していたファイルは「読み込み元」として残す
    const res = await apiSend('PUT', '/outline', body);
    if (cur !== OL) return;   // 保存中にほかの構成へ移った
    if (!res.unchanged) { OL.ol = res.outline; }
    if (first && !res.unchanged) { OL.creating = false; await olLinkUrl(OL.r); toast(OL.copiedMsg ? '既存記事から構成をコピーしました' : '構成シートを作りました'); const hd = $('ol-hand'); if (hd) { hd.disabled = false; hd.title = ''; }
      const cf = document.querySelector('.ol-cfcol'); if (cf) { cf.innerHTML = olConfirmBar(); cf.querySelectorAll('[data-olconfirm]').forEach(bt => bt.onclick = () => olConfirm(bt.dataset.olconfirm === 'reopen')); } }   /* 初めて保存したら「この内容で確定する」を出す */
    if (OL.editSeq === seq) OL.dirty = false;
    OL.savedAt = new Date().toTimeString().slice(0, 5);
    const up = document.querySelector('.ol-upd'); if (up && OL.ol) up.textContent = '最終更新：' + OL.ol.updatedBy + '　' + olWhen(OL.ol.updatedAt);
    if (!res.unchanged) olReloadHist();
  } catch (e) {
    if (cur !== OL) return;
    if (/先に保存/.test(e.message)) { OL.stop = '保存できません：' + e.message; alert(OL.stop); } else OL.err = '保存できませんでした：' + e.message;
  } finally {
    if (cur === OL) { OL.saving = false; olStatus(); if (OL.again || (OL.dirty && !OL.stop && !OL.err && OL.editSeq !== seq)) { OL.again = false; OL.timer = setTimeout(() => olSave(), 800); } }
  }
}
/** 進行管理の構成URLに、この構成シートのURLを入れる */
async function olLinkUrl(r) {
  if (isOutlineUrl(r.outline_url)) return;
  try { const u = outlineUrl(r); await apiSend('PATCH', '/article-items', { key: r.key, fields: { outline_url: u } }); r.outline_url = u; if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } }
  catch (e) { toast('構成URLを自動で入れられませんでした：' + e.message); }
}
async function olReloadHist() { try { const d = await api('/outline?key=' + encodeURIComponent(OL.key)); OL.history = d.history || []; olHist(); } catch (e) { /* 履歴は出せなくても続ける */ } }
function olHist() {
  const box = $('ol-hist'); if (!box) return;
  box.innerHTML = OL.history.length ? '<ul class="ol-hist">' + OL.history.map(h => '<li><span class="ol-hw">' + esc(olWhen(h.at)) + '</span><b>' + esc(h.name) + '</b><span class="ol-ha">' + esc(h.action) + '</span><span class="ol-hs">' + esc((h.summary || []).join('・')) + '</span>'
    + (OL.canHand && h.canRevert ? '<button class="btn sm" type="button" data-olrev="' + esc(h.id) + '" title="この変更の前の内容に戻す">この前に戻す</button>' : '') + '</li>').join('') + '</ul>' : '<p class="note">まだ履歴はありません</p>';
  box.querySelectorAll('[data-olrev]').forEach(b => b.onclick = async () => {
    if (OL.dirty && !confirm('保存していない変更は消えます。よろしいですか？')) return;
    if (!confirm('この変更の前の内容に戻します（戻したことも履歴に残ります）。よろしいですか？')) return;
    try { const res = await apiSend('POST', '/outline/revert', { key: OL.key, id: b.dataset.olrev }); clearTimeout(OL.timer); olFrom(res.outline); OL.dirty = false; OL.err = ''; paintOutline(); olReloadHist(); toast('元に戻しました'); }
    catch (e) { alert('戻せませんでした：' + e.message); }
  });
}
const olBoxStyle = { '赤太字': 'color:var(--bad);font-weight:700', '黄マーカー太字': 'font-weight:700;background:linear-gradient(transparent 45%,rgba(255,214,0,.5) 45%)' };
function olPrev() {
  const box = $('ol-prev'); if (!box) return;
  box.innerHTML = '<div class="ol-pt">' + (esc(OL.title) || '<span class="note">（タイトル未入力）</span>') + '</div>' + (OL.lead ? '<p class="ol-plead">' + esc(OL.lead).replace(/\n/g, '<br>') + '</p>' : '') + OL.blocks.map(b => {
    const st = b.box ? ' style="' + olBoxStyle[b.box] + '"' : '';
    if (olBlk(b.type)) return '<div class="ol-pblk ol-pblk-' + b.type + '">' + OL_TL[b.type] + '：' + esc(b.block || '（未選択）') + '<code>' + esc(olCode(OL.media, b.type, b.block)) + '</code>' + (b.heads || []).map(h => '<div class="ol-hd ol-hd-' + h.type + '"><span>' + h.type.toUpperCase() + '</span>' + esc(h.text) + '</div>').join('') + '</div>';
    if (b.type === 'free') return '<p class="ol-pf"' + st + '>' + (b.html || '') + '</p>';
    if (b.type === 'reco') return '<div class="ol-preco"' + st + '><div class="ol-preco-h">このような方にオススメ</div>' + (b.html || '<span class="note">（未入力）</span>') + '</div>';
    if (b.type === 'image') return '<figure class="ol-pimg">' + (b.img ? '<img data-olimg="' + b.img + '" src="' + olImgSrc(b.img) + '" alt="">' : '<div class="note">（画像イメージ：画像なし）</div>') + (b.html ? '<figcaption>' + b.html + '</figcaption>' : '') + '</figure>';
    return '<' + b.type + ' class="ol-p' + b.type + '"' + st + '>' + (b.html || '<span class="note">（未入力）</span>') + '</' + b.type + '>';
  }).join('');
}
async function olCopyText(text, done) { try { await navigator.clipboard.writeText(text); } catch (e) { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); } toast(done); }
async function olCopyRich(html, text, done) {
  try { if (navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return toast(done); } } catch (e) { /* 下の方法で */ }
  const d = document.createElement('div'); d.contentEditable = 'true'; d.style.cssText = 'position:absolute;left:-9999px'; d.innerHTML = html; document.body.appendChild(d);
  const rg = document.createRange(); rg.selectNodeContents(d); const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg); document.execCommand('copy'); s.removeAllRanges(); d.remove(); toast(done);
}
/** Googleドキュメント用：タイトル＝見出し1、H2〜H4＝見出し2〜4、色もそのまま（2026-11-12 ユーザー指定） */
function olDocHtml() {
  const GD = { '赤太字': 'color:#c0392b;font-weight:bold', '黄マーカー太字': 'background-color:#fff1a8;font-weight:bold' };
  const inl = h => String(h || '').replace(/<span data-c="([^"]+)">/g, (m, k) => '<span style="' + (GD[k] || '') + '">');
  const br = t => esc(t || '').replace(/\n/g, '<br>'), r = OL.r;
  let h = '<h1>' + esc(OL.title) + '</h1>';
  const why = (v, k) => [v, OL.meta[k] ? '（理由：' + OL.meta[k] + '）' : ''].filter(Boolean).join(' ');
  const rows = [['想定文字数', r.planned_chars ? r.planned_chars + '文字' : ''], ['オリジナル画像作成の必要性', why(OL.meta.image_need, 'image_need_reason')], ['既存記事URL', /リライト/.test(r.type || '') ? r.url : ''], ['緊急性', why(r.urgency, 'urgency_reason')]].concat(OL_META.map(([k, l, kind]) => [l.replace(/<[^>]+>/g, '').trim(), kind === 'persona' ? olPersonaText() : OL.meta[k]])).filter(x => x[1]);
  if (rows.length) h += '<table border="1" style="border-collapse:collapse">' + rows.map(x => '<tr><td style="background:#eef2f0;padding:4px 8px"><b>' + esc(x[0]) + '</b></td><td style="padding:4px 8px">' + br(x[1]) + '</td></tr>').join('') + '</table>';
  if (OL.description) h += '<p><b>ディスクリプション：</b>' + br(OL.description) + '</p>';
  if (OL.lead) h += '<p><b>リード文：</b><br>' + br(OL.lead) + '</p>';
  OL.blocks.forEach(b => {
    const st = b.box ? ' style="' + GD[b.box] + '"' : '';
    if (olBlk(b.type)) { h += '<p style="color:#5d6b65">【' + OL_TL[b.type] + '：' + esc(b.block) + '】</p>'; (b.heads || []).forEach(x => { h += '<p style="color:#8a9690">（' + x.type.toUpperCase() + '）' + esc(x.text) + '</p>'; }); }
    else if (b.type === 'free') h += '<p' + st + '>' + inl(b.html) + '</p>';
    else if (b.type === 'reco') h += '<p style="color:#2e7d5b"><b>【このような方にオススメ】</b></p><p' + st + '>' + inl(b.html) + '</p>';
    else if (b.type === 'image') h += '<p style="color:#5d6b65"><b>【画像イメージ】</b>' + (b.html ? inl(b.html) : '') + '</p>' + (b.img && OL.imgs && OL.imgs[b.img] ? '<p><img src="' + OL.imgs[b.img] + '" width="480"></p>' : '');
    else h += '<' + b.type + st + '>' + inl(b.html) + '</' + b.type + '>';
    if (!olBlk(b.type) && b.chars) h += '<p style="color:#8a9690;font-size:9pt">（目安 ' + b.chars + '文字）</p>';
    OL_NOTES.forEach(([k, l]) => { if (b[k]) h += '<p style="color:#5d6b65;font-size:9pt">' + l + '：' + br(b[k]) + '</p>'; });
  });
  return h;
}
const olText = () => OL.title + '\n\n' + (OL.lead ? OL.lead + '\n\n' : '') + OL.blocks.map(b => olBlk(b.type) ? '【' + OL_TL[b.type] + '：' + b.block + '】' : b.type === 'reco' || b.type === 'image' ? '【' + OL_TL[b.type] + '】' + olPlain(b.html) : (b.type === 'free' ? '' : '■'.repeat({ h2: 1, h3: 2, h4: 3 }[b.type]) + ' ') + olPlain(b.html)).join('\n');
/** WordPress用（ブロックエディタのコード）：CTA・訴求ブロックはマイブロックの呼び出し。色は AFFINGER のクラス（赤太字＝hutoaka、黄マーカー太字＝ymarker＋huto） */
function olWpCode() {
  const WPC = { '赤太字': 'hutoaka', '黄マーカー太字': 'huto ymarker' };
  const inl = h => String(h || '').replace(/<span data-c="([^"]+)">/g, (m, k) => '<span class="' + (WPC[k] || '') + '">');
  const wrap = (h, b) => b.box ? '<span class="' + WPC[b.box] + '">' + inl(h) + '</span>' : inl(h);
  return (OL.lead ? '<!-- wp:paragraph -->\n<p>' + esc(OL.lead).replace(/\n/g, '<br>') + '</p>\n<!-- /wp:paragraph -->\n\n' : '') + OL.blocks.map(b => {
    if (olBlk(b.type)) { const c = olCode(OL.media, b.type, b.block); return c ? '<!-- wp:shortcode -->\n' + c + '\n<!-- /wp:shortcode -->' : '<!-- ' + OL_TL[b.type] + '：' + b.block + '（コードが見つかりません） -->'; }
    if (b.type === 'free') return '<!-- wp:paragraph -->\n<p>' + wrap(b.html, b) + '</p>\n<!-- /wp:paragraph -->';
    if (b.type === 'reco') return '<!-- wp:paragraph -->\n<p><span class="huto">このような方にオススメ</span><br>' + wrap(b.html, b) + '</p>\n<!-- /wp:paragraph -->';
    if (b.type === 'image') return '<!-- 画像イメージ' + (b.html ? '：' + olPlain(b.html).replace(/--/g, '') : '') + ' -->';
    const lv = b.type.slice(1); return '<!-- wp:heading {"level":' + lv + '} -->\n<h' + lv + ' class="wp-block-heading">' + wrap(b.html, b) + '</h' + lv + '>\n<!-- /wp:heading -->';
  }).join('\n\n');
}
document.addEventListener('click', ev => {
  if (!ev.target.closest || state.view !== 'outline' || !OL) return;
  if (ev.target.closest('#ol-gdoc')) olCreateDoc();
});
/* Googleドキュメントを作る（2026-11-13 ユーザー指定）：押した人の Google アカウントのマイドライブに新しく作り、ライティングURLに入れる。
   Google ドライブは、このアプリが作ったファイルだけ扱える許可（drive.file）を、押した人に Google の画面で一度もらう。
   作ったドキュメントは dashboard-app@ に閲覧者で共有する（文字数の自動入力・確認のため）。WordPress用にコピーはいったんなし（2026-11-13 ユーザー指定） */
let GDOC_TOKEN = null;
async function gdocToken() {
  if (GDOC_TOKEN && GDOC_TOKEN.until > Date.now()) return GDOC_TOKEN.t;
  const u = fbAuth.currentUser, p = new firebase.auth.GoogleAuthProvider();
  p.addScope('https://www.googleapis.com/auth/drive.file'); p.setCustomParameters({ login_hint: u.email || '' });
  const hasG = (u.providerData || []).some(x => x && x.providerId === 'google.com');
  const res = hasG ? await u.reauthenticateWithPopup(p) : await u.linkWithPopup(p);
  const t = res && res.credential && res.credential.accessToken;
  if (!t) throw new Error('Google の許可を受け取れませんでした');
  GDOC_TOKEN = { t, until: Date.now() + 50 * 60 * 1000 };
  return t;
}
async function olCreateDoc() {
  const r = OL.r, cur = OL, btn = $('ol-gdoc');
  if (r.writing_url && !confirm('ライティングURLにはもう原稿が入っています。新しいGoogleドキュメントを作って、ライティングURLを置き換えますか？')) return;
  const label = btn ? btn.textContent : '';
  const busy = on => { if (btn) { btn.disabled = on; btn.textContent = on ? '作成中…' : label; } };
  busy(true);
  try {
    let tok;
    try { tok = await gdocToken(); }
    catch (e) { throw new Error(/popup-closed|cancelled-popup/.test(e.code || '') ? 'Google の画面が閉じられました' : /user-mismatch/.test(e.code || '') ? 'ダッシュボードにログインしているのと同じ Google アカウントを選んでください' : /credential-already-in-use|provider-already-linked/.test(e.code || '') ? 'この Google アカウントはほかのユーザーで使われています' : (e.message || 'Google の許可をもらえませんでした')); }
    await Promise.all(OL.blocks.filter(b => b.type === 'image' && b.img).map(b => olImgLoad(b.img).catch(() => null)));   /* 画像イメージもドキュメントに入れる */
    const name = (OL.title || r.kw || '原稿') + (r.no ? '（No.' + r.no + '）' : '');
    const html = '<html><head><meta charset="utf-8"></head><body>' + olDocHtml() + '</body></html>', bd = 'bm' + Date.now();
    const body = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, mimeType: 'application/vnd.google-apps.document' }) + '\r\n--' + bd + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + bd + '--';
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'multipart/related; boundary=' + bd }, body });
    if (res.status === 401) { GDOC_TOKEN = null; throw new Error('Google の許可の期限が切れました。もう一度押してください'); }
    if (!res.ok) throw new Error('Googleドキュメントを作れませんでした（' + res.status + '）');
    const f = await res.json(), url = 'https://docs.google.com/document/d/' + f.id + '/edit';
    // 文字数を読めるよう、ダッシュボードのアカウントに閲覧者で共有（通知メールは送らない）
    await fetch('https://www.googleapis.com/drive/v3/files/' + f.id + '/permissions?sendNotificationEmail=false', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: OL_SA }) }).catch(() => null);
    window.open(url, '_blank', 'noopener');
    try { await apiSend('PATCH', '/article-items', { key: r.key, fields: { writing_url: url } }); r.writing_url = url; if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } }
    catch (e) { alert('Googleドキュメントは作りましたが、ライティングURLに入れられませんでした：' + e.message + '\n' + url); return; }
    toast('Googleドキュメントを作り、ライティングURLに入れました');
    if (cur === OL) paintOutline();
  } catch (e) { alert(e.message); }
  finally { busy(false); }
}

// ---------- 構成を用意する（3つの方法。2026-11-12 ユーザー指定） ----------
function olChooserHtml() {
  return '<div class="ol-choose">'
    + '<button type="button" class="ol-opt" data-olc="create"><b>本アプリで構成を作る</b><span>構成シートが開きます。見出し・自由記入・CTA・訴求ブロックを入力できます</span></button>'
    + '<button type="button" class="ol-opt" data-olc="import"><b>スプレッドシート・ドキュメントから読み込む</b><span>タイトル・見出し（H2〜H4）・本文を構成シートに取り込みます</span></button>'
    + '<button type="button" class="ol-opt" data-olc="attach"><b>スプレッドシート・ドキュメントのURLを添付する</b><span>今までどおり、構成URLにファイルのURLを入れます</span></button></div>'
    + '<div class="ol-urlbox" id="olc-box" hidden><label class="ol-lab" id="olc-lab" for="olc-in"></label><div class="row"><input id="olc-in" type="url" placeholder="https://docs.google.com/…" style="flex:1"><button class="btn primary" type="button" id="olc-go"></button></div>'
    + '<p class="note" id="olc-note"></p><p class="err" id="olc-err" hidden></p></div>';
}
/** fromTable：進行管理の表の「構成」ボタンから（btn はそのボタン）。onPage：構成シートの画面から */
function olBindChooser(r, btn, onPage) {
  let mode = '';
  document.querySelectorAll('[data-olc]').forEach(b => b.onclick = () => {
    mode = b.dataset.olc; document.querySelectorAll('[data-olc]').forEach(x => x.classList.toggle('on', x === b));
    if (mode === 'create') { closeModal(); if (onPage) { olStartBlank(); paintOutline(); } else { state.outlineCreate = r.key; goOutline(outlinePath(r)); } return; }
    $('olc-box').hidden = false; $('olc-err').hidden = true;
    $('olc-lab').textContent = mode === 'import' ? '読み込むスプレッドシート・ドキュメントのURL' : '添付するスプレッドシート・ドキュメントのURL';
    $('olc-go').textContent = mode === 'import' ? '読み込む' : '添付する';
    $('olc-note').textContent = mode === 'import' ? 'ファイル（またはフォルダ）を ' + OL_SA + ' に「閲覧者」で共有してください。ドキュメントは見出しのスタイル（見出し2〜4）、スプレッドシートは「H2」「H3」などの列を見出しとして読みます。スプレッドシートはURLのタブを読みます。' : '';
    if (!$('olc-in').value && r.outline_url && !isOutlineUrl(r.outline_url) && mode === 'import') $('olc-in').value = r.outline_url;
    $('olc-in').focus();
  });
  const fail = m => { $('olc-err').textContent = m; $('olc-err').hidden = false; $('olc-go').disabled = false; };
  $('olc-go').onclick = async () => {
    const url = $('olc-in').value.trim();
    if (!DOC_URL.test(url)) return fail('GoogleスプレッドシートかGoogleドキュメントのURL（https://docs.google.com/…）を入力してください');
    $('olc-go').disabled = true; $('olc-err').hidden = true;
    if (mode === 'attach') {
      if (btn) { const el = btn.closest('td').querySelector('[data-k="outline_url"]'); if (el) { el.value = url; el.dispatchEvent(new Event('change')); } closeModal(); return; }
      try { await apiSend('PATCH', '/article-items', { key: r.key, fields: { outline_url: url } }); r.outline_url = url; if (r.source !== 'dashboard') { r.edited = true; r.editedBy = me.email; r.editedAt = new Date().toISOString(); } toast('構成URLを添付しました'); paintOutline(); }
      catch (e) { fail('添付できませんでした：' + e.message); }
      return;
    }
    $('olc-go').textContent = '読み込み中…';
    try {
      const d = await apiSend('POST', '/outline/import', { key: r.key, url });
      await loadArtOptions(r.media).catch(() => null); d.blocks = (d.blocks || []).map(b => olMapCode(r.media, b));
      const cur = await api('/outline?key=' + encodeURIComponent(r.key));
      if (cur.outline && !confirm('この記事にはもう構成シートがあります。読み込んだ内容で置き換えますか？（前の内容は履歴から戻せます）')) { $('olc-go').disabled = false; $('olc-go').textContent = '読み込む'; return; }
      await apiSend('PUT', '/outline', { key: r.key, title: d.title, lead: d.lead || '', description: d.description || '', meta: d.meta || {}, blocks: d.blocks, sourceUrl: url, action: '読み込み', version: cur.outline ? cur.outline.version : null });
      await olLinkUrl(r);
      closeModal(); toast('読み込みました（見出しなど ' + d.blocks.length + '個' + (d.meta && Object.keys(d.meta).length ? '・記事の設計 ' + Object.keys(d.meta).length + '項目' : '') + '）');
      if (onPage) { render(); } else goOutline(outlinePath(r));
    } catch (e) { $('olc-go').textContent = '読み込む'; fail('読み込めませんでした：' + e.message); }
  };
  $('olc-in').onkeydown = ev => { if (ev.key === 'Enter') $('olc-go').click(); };
}
/** 進行管理の「構成」ボタン */
function openOutlineChooser(r, btn) {
  if (!r.key) return showInputError('まだ保存されていない行です', ['先に No.・検索KWなどを入れて保存してください。']);
  if (isOutlineUrl(r.outline_url)) return goOutline(new URL(r.outline_url).pathname);
  openModal('<h2>構成を用意する <small class="note">' + esc(r.kw || '') + '</small></h2>' + olChooserHtml() + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" type="button" data-close>閉じる</button></div>');
  olBindChooser(r, btn, false);
}

// ================= 機能改善依頼・タスク通知（2026-10-29 ユーザー指定） =================
const FB_STATUS = { open: ['未対応', 'wait'], done: ['対応済み', 'ok'], declined: ['対応不可', 'ng'] };
/** いま開いている画面の場所（タブ・画面・表示・メディア） */
function fbContext(btn) {
  const sel = id => { const s = $(id); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text.replace(/^[\s　└・]+/, '') : ''; };
  const h2 = btn && btn.closest('.panel') && btn.closest('.panel').querySelector('h2');
  const panel = h2 ? (h2.childNodes[0] ? h2.childNodes[0].textContent : h2.textContent).trim() : '';
  const media = !$('art-media-field').hidden ? sel('art-media-select') : !$('media-field').hidden ? sel('media-select') : '';
  return { dash: sel('dash-select'), view: pageTitleText(), viewId: state.view, panel, media, sub: !$('art-sub-field').hidden ? sel('art-sub-select') : '' };
}
const fbWhere = c => [c.dash, c.view, c.panel].filter(Boolean).map(esc).join(' ＞ ') + (c.media ? '<span class="note">（' + esc(c.media + (c.sub && c.sub !== 'すべて' ? '／' + c.sub : '')) + '）</span>' : '');
const fbItem = x => '<div class="fb-item"><div class="row" style="justify-content:space-between; gap:6px; flex-wrap:wrap"><span class="note">' + dt(x.createdAt) + '・' + fbWhere(x.ctx) + '</span><span class="pill ' + FB_STATUS[x.status][1] + '">' + FB_STATUS[x.status][0] + '</span></div><div class="fb-text">' + esc(x.text) + '</div>'
  + (x.reply ? '<div class="fb-reply"><b>' + (x.status === 'declined' ? '対応できない理由' : '対応の内容') + '：</b>' + esc(x.reply) + '</div>' : '') + '</div>';
async function openFeedback(btn) {
  const c = fbContext(btn);
  openModal('<h2>機能改善の依頼</h2><p class="note">場所（自動で入ります）</p><p class="fb-where">' + fbWhere(c) + '</p>'
    + '<label class="field" style="display:flex">改善してほしい内容<textarea id="fb-text" rows="6" placeholder="例：この表に「前年比」の列がほしい／○○の数字が進行管理と合わない など"></textarea></label>'
    + '<p class="err" id="fb-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px"><button class="btn" type="button" data-close>閉じる</button><button class="btn primary" type="button" id="fb-send">送信する</button></div>'
    + '<h3 class="am-h" style="margin-top:14px">これまでの依頼</h3><div id="fb-mine"><p class="loading">読み込み中…</p></div>');
  api('/feedback/mine').then(r => { const el = $('fb-mine'); if (el) el.innerHTML = r.list.length ? r.list.map(fbItem).join('') : '<p class="empty">まだありません。</p>'; }).catch(() => {});
  $('fb-send').onclick = async () => {
    const text = $('fb-text').value.trim(); if (!text) { $('fb-err').textContent = '改善してほしい内容を入力してください'; $('fb-err').hidden = false; return; }
    $('fb-send').disabled = true;
    try { await apiSend('POST', '/feedback', { text, ctx: c }); closeModal(); toast('改善依頼を送りました。対応したらお知らせします'); }
    catch (e) { $('fb-err').textContent = e.message; $('fb-err').hidden = false; $('fb-send').disabled = false; }
  };
}
document.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('[data-fb]'); if (b) { ev.preventDefault(); ev.stopPropagation(); openFeedback(b); } }, true);
/** 依頼した人：対応済み・対応不可になった依頼があればお知らせ */
async function checkFeedbackNews() {
  if (!canFeedback() || PREVIEW_UID) return;
  let r; try { r = await api('/feedback/mine'); } catch (e) { return; }
  const news = r.list.filter(x => x.status !== 'open' && !x.seen); if (!news.length) return;
  const bar = document.createElement('div'); bar.className = 'fb-news';
  bar.innerHTML = '<b>改善依頼の結果が届いています（' + news.length + '件）</b> <button class="btn sm" type="button">見る</button>';
  const main = $('content'); main.parentElement.insertBefore(bar, main);   /* 画面を描き直しても消えないように、本文の外に置く */
  bar.querySelector('button').onclick = () => { openModal('<h2>改善依頼の結果</h2>' + news.map(fbItem).join('') + '<div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" data-close>閉じる</button></div>'); apiSend('POST', '/feedback/seen', {}).catch(() => {}); bar.remove(); };
}
/** 未対応の請求（自分が請求担当の請求確認中・経理部から差し戻し）：どの画面でもいちばん上に赤い帯（2026-10-29 ユーザー指定） */
var INV_PENDING = [];
async function loadInvPending() {
  if (PREVIEW_UID || !me || isOutUser() || me.roleEff === 'finance') return;
  let list = []; try { list = (await api('/invoices-pending')).list || []; } catch (e) { return; }
  const changed = list.length !== INV_PENDING.length; INV_PENDING = list;
  let bar = $('inv-pending-bar');
  if (!list.length) { if (bar) bar.remove(); if (changed) renderNav(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'inv-pending-bar'; bar.className = 'inv-pending-bar'; const main = $('content'); main.parentElement.insertBefore(bar, main); }
  const yms = [...new Set(list.map(v => v.ym))].sort(), ret = list.filter(v => v.status === 'finance_returned').length;
  bar.innerHTML = '<b>要対応：請求の確認が ' + list.length + '件あります</b><span>' + yms.map(ymJp).join('・') + '分' + (ret ? '（うち経理部から差し戻し ' + ret + '件）' : '') + '：' + esc(list.slice(0, 4).map(v => v.name).join('、') + (list.length > 4 ? ' ほか' : '')) + '</span><button class="btn sm" type="button" id="inv-pending-go">確認する</button>';
  $('inv-pending-go').onclick = () => { state.dash = 'rewards'; state.view = isAdmin() ? 'rw-active' : 'rw-mine'; state.rwFilter = Object.assign(state.rwFilter || {}, { ym: yms[0] }); render(); };
  if (changed) renderNav();
}
/** 管理者：タスクの件数（メニューの赤い数字） */
var TASK_COUNT = 0;   /* renderNav より先に読まれてもよいように var */
async function loadTaskCount() {
  if (!realAdmin() || PREVIEW_UID) return;
  try { const n = (await api('/admin/tasks')).count || 0; if (n !== TASK_COUNT) { TASK_COUNT = n; renderNav(); } } catch (e) { /* 管理者でなければ何もしない */ }
}
/** 全体管理 →「タスク通知」：改善依頼・承認待ちをまとめて */
function viewTasks() {
  return { html: '<section class="panel" id="tk-body"><p class="loading">読み込み中…</p></section><section class="panel" id="tk-hist"></section>', view: 'タスク通知', after: async () => {
    const t = await api('/admin/tasks'); TASK_COUNT = t.count || 0; renderNav();
    const sec = (title, n, body) => '<h3 class="am-h">' + title + ' <span class="pill ' + (n ? 'ng' : 'off') + '">' + n + '件</span></h3>' + (n ? body : '<p class="empty">ありません。</p>');
    $('tk-body').innerHTML = H('タスク通知 <small>対応が必要なもの</small>', [])
      + sec('機能改善の依頼', t.feedback.length, t.feedback.map((x, i) => '<div class="fb-item"><div class="row" style="justify-content:space-between; gap:6px; flex-wrap:wrap"><span><b>' + esc(x.by.name || x.by.email) + '</b> <span class="note">' + esc(roleLabel(x.by.role) || '') + '・' + dt(x.createdAt) + '</span></span></div>'
        + '<p class="fb-where">' + fbWhere(x.ctx) + '</p><div class="fb-text">' + esc(x.text) + '</div>'
        + '<div class="row" style="gap:6px; margin-top:6px; flex-wrap:wrap"><input data-fbr="' + i + '" placeholder="対応の内容（任意）／対応不可の理由（必須）" style="flex:1; min-width:16em"><button class="btn primary sm" type="button" data-fbdone="' + i + '">対応済みにする</button><button class="btn sm" type="button" data-fbno="' + i + '">対応不可</button></div></div>').join(''))
      + sec('記事目標・稼働工数の承認待ち', t.work.length, '<div class="row" style="gap:6px; flex-wrap:wrap">' + t.work.map((p2, i) => '<button class="btn sm primary" type="button" data-tkw="' + i + '">' + (p2.kind === 'res' ? '稼働工数の修正：' : '記事目標：') + esc(p2.name) + '（' + halfLabel(p2.start) + '）</button>').join('') + '</div>')
      + sec('AIエラーチェッカーの判断待ち', (t.errcheck || []).length, (t.errcheck || []).map(r => '<div class="row" style="gap:8px; align-items:center; margin:4px 0"><b>' + esc(fmtJst(r.at)) + ' の点検</b>' + (r.status === 'incomplete' ? '<span class="pill wait">AIの報告を読めませんでした</span>' : '<span class="pill ' + (r.high ? 'ng' : 'wait') + '">判断待ち ' + r.open + '件' + (r.high ? '（高 ' + r.high + '）' : '') + '</span>') + '<button class="btn sm primary" type="button" data-tkerr="' + esc(r.run_id) + '">開いて判断する</button></div>').join(''))
      + sec('ユーザーの承認待ち', t.users.length, '<p>' + t.users.map(u => esc(u.name || u.email)).join('、') + '</p><button class="btn sm" type="button" id="tk-users">ユーザー管理を開く</button>');
    const act = async (i, status) => {
      const x = t.feedback[i], reply = document.querySelector('[data-fbr="' + i + '"]').value.trim();
      if (status === 'declined' && !reply) { alert('対応不可の理由を入力してください'); return; }
      if (!confirm((status === 'done' ? '対応済み' : '対応不可') + 'にして、' + (x.by.name || x.by.email) + ' さんにお知らせします。よろしいですか？')) return;
      try { await apiSend('PATCH', '/admin/feedback/' + x.id, { status, reply }); toast('記録して、お知らせしました'); render(); } catch (e) { alert(e.message); }
    };
    document.querySelectorAll('[data-fbdone]').forEach(b => b.onclick = () => act(Number(b.dataset.fbdone), 'done'));
    document.querySelectorAll('[data-fbno]').forEach(b => b.onclick = () => act(Number(b.dataset.fbno), 'declined'));
    document.querySelectorAll('[data-tkw]').forEach(b => b.onclick = () => { const p2 = t.work[Number(b.dataset.tkw)]; (p2.kind === 'res' ? resApproveModal : workApproveModal)(p2.id, p2.start); });
    if ($('tk-users')) $('tk-users').onclick = () => { state.view = 'users'; render(); };
    document.querySelectorAll('[data-tkerr]').forEach(b => b.onclick = () => { state.errRun = b.dataset.tkerr; state.dash = 'ai'; state.view = 'ai-errcheck'; render(); });
    // 対応した改善依頼の記録
    try { const all = (await api('/admin/feedback')).list.filter(x => x.status !== 'open'); $('tk-hist').innerHTML = H('対応した改善依頼 <small>新しい順</small>', []) + (all.length ? all.map(fbItem).join('') : '<p class="empty">まだありません。</p>'); } catch (e) { $('tk-hist').remove(); }
  } };
}

// ================= 請求書（2026-10-29 ユーザー指定） =================
// 請求者：その月の3日〜翌月2日に請求（翌月3・4日は理由が必須、5日以降は不可）。1か月に1回。金額は報酬の計算、足せるのは「その他の項目」だけ
// 請求したあとに完了した記事は、翌月分の請求に回す（前の月の請求に入っていない、前の月の記事）
const INV_STATUS = { checking: ['請求確認中', 'wait'], returned: ['差し戻し', 'ng'], finance: ['経理部確認中', 'wait'], finance_returned: ['経理部確認中', 'wait'], done: ['請求完了', 'ok'] };
const INV_TO = 'BEST株式会社 御中', INV_TO_ADDR = '〒220-0004 神奈川県横浜市西区北幸2-15-10 横浜ウエストサイドビル8F';
const INVOICE_START = '2026-11';   /* このWEBアプリでの請求は 2026年11月分から（2026-10-29 ユーザー指定） */
const invWindow = (ym, today) => { const nx = shiftMonth(ym, 1); return ym < INVOICE_START ? 'closed' : today < ym + '-03' ? 'before' : today <= nx + '-02' ? 'open' : today <= nx + '-04' ? 'late' : 'closed'; };
const invDue = ym => { const d = new Date(shiftMonth(ym, 1) + '-25T00:00:00Z'), w = d.getUTCDay(); if (w === 6) d.setUTCDate(d.getUTCDate() + 2); else if (w === 0) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const invTotals = (items, entity) => { const lines = items.map(x => Object.assign({}, x, { amount: Math.round((Number(x.qty) || 0) * (Number(x.unit) || 0)) })), sub = lines.reduce((a, x) => a + x.amount, 0), tax = Math.floor(sub * 0.1), wh = entity === '個人' ? (sub <= 1000000 ? Math.floor(sub * 0.1021) : 102100 + Math.floor((sub - 1000000) * 0.2042)) : 0; return { lines, subtotal: sub, tax, withholding: wh, total: sub + tax - wh }; };
const ymJp = ym => ym.slice(0, 4) + '年' + Number(ym.slice(5)) + '月';
const dateJpS = d => d ? d.slice(0, 4) + '年' + Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日' : '—';
/** その月の請求に入る記事：その月に完了した記事＋前の月の請求に入らなかった前の月の記事（前の月を請求しているときだけ） */
function invDone(c, ym, invs) {
  const today = todayJst(), prev = invs.find(v => v.contractId === c.id && v.ym === shiftMonth(ym, -1)), used = new Set(prev ? prev.articles || [] : []);
  return ITEMS.filter(r => r.upload_date && r.upload_date <= today && (r.upload_date.startsWith(ym) || (prev && r.upload_date.startsWith(prev.ym) && !used.has(String(r.key)))));
}
/** 請求書の明細（自動の行）：メディアごとに分けて「「メディア名」新規記事」の形（稼働表の時間はまとめて1行） */
function invItemsByMedia(c, ym, done) {
  const x = rewardCalc(c, ym, done), gk = r => r.media + '\u0001' + (r.sub || ''), groups = [...new Set(x.mine.map(gk))].sort((a, b) => topMedia().findIndex(m => m.media === a.split('\u0001')[0]) - topMedia().findIndex(m => m.media === b.split('\u0001')[0]) || a.localeCompare(b, 'ja'));
  const out = [];
  groups.forEach(g => { const [m, sub] = g.split('\u0001'), xm = rewardCalc(c, ym, done.filter(r => gk(r) === g)); invAutoItems(c, Object.assign({}, xm, { dirHours: 0, _noPress: true })).forEach(i => out.push(Object.assign(i, { media: m, sub, label: '「' + mediaLabel(m) + (sub ? '（' + sub + '）' : '') + '」' + i.label }))); });
  if (x.pressImg) out.push({ kind: 'auto', label: 'プレスリリース（画像作成）', qty: x.pressImg, unit: Number((x.pay || {}).image), unitLabel: '枚' });
  if (x.pressUp) out.push({ kind: 'auto', label: 'プレスリリース（アップロード）', qty: x.pressUp, unit: Number((x.pay || {}).upload), unitLabel: '本' });
  if (x.pressRate != null && (x.press || []).length) out.push(x.pressMode === 'char' ? { kind: 'auto', label: 'プレスリリース（文字数）', qty: x.pressChars, unit: x.pressRate, unitLabel: '文字' } : { kind: 'auto', label: 'プレスリリース', qty: x.press.length, unit: x.pressRate, unitLabel: '本' });   /* メディアごとに分けず1行 */
  if (x.tsRate != null && x.dirHours) out.push({ kind: 'auto', label: 'ディレクション業務（時間）', qty: Math.round(x.dirHours * 100) / 100, unit: x.tsRate, unitLabel: '時間' });
  return { x, items: out };
}
/** 報酬の計算から、請求書の明細（自動の行）を作る */
function invAutoItems(c, x) {
  const p = x.pay || {}, out = [], add = (label, qty, unit, unitLabel) => { if (qty > 0 && unit != null && isFinite(unit)) out.push({ kind: 'auto', label, qty, unit: Number(unit), unitLabel }); };
  const ty = t => x.main.filter(r => payType(r) === t).length;
  if (p.type === '記事単価') {
    const aNew = p.articleNew ?? p.article;
    add('新規記事', ty('新規'), aNew, '本'); add('リライト(新規)記事', ty('リライト(新規)'), aNew, '本'); add('リライト記事', ty('リライト'), p.articleRewrite, '本'); add('簡易リライト記事', ty('簡易リライト'), p.articleLite, '本');
  }
  if (p.type === '文字単価') { add('記事作成（文字数）', x.chars - (x.olOverChars || 0), p.char, '文字'); add('画像作成', x.images, p.image, '枚'); }
  if (p.upload != null) add('アップロード', x.up, p.upload, '本');
  if (p.superviseOn) add('記事監修', x.sup, p.supervise, '本');
  if (x.outlineRate != null) { add('記事作成・構成案作成込み（文字数）', x.olOverChars || 0, x.outlineRate, '文字'); add('構成案作成（文字数）', x.outlineChars - (x.olOverChars || 0), x.outlineRate, '文字'); }
  if (x.dirSupRate != null) add('ディレクション（監修ありの記事）', x.dirSup.length, x.dirSupRate, '本');
  if (x.dirNoSupRate != null) add('ディレクション（監修なしの記事）', x.dirNoSup.length, x.dirNoSupRate, '本');
  if (!x._noPress) { add('プレスリリース（画像作成）', x.pressImg || 0, (x.pay || {}).image, '枚'); add('プレスリリース（アップロード）', x.pressUp || 0, (x.pay || {}).upload, '本'); }
  if (x.pressRate != null && !x._noPress) { if (x.pressMode === 'char') add('プレスリリース（文字数）', x.pressChars, x.pressRate, '文字'); else add('プレスリリース', (x.press || []).length, x.pressRate, '本'); }
  if (x.tsRate != null && x.dirHours) add('ディレクション業務（時間）', Math.round(x.dirHours * 100) / 100, x.tsRate, '時間');
  return out;
}
/** その月の請求の状態（対象月のプルダウン用）：対象外 → 請求受付前 → 請求受付中 → 受付猶予（理由が必要） → 担当の確認中 → 経理部へ送付待ち → 経理部確認中 → 請求完了 */
function invMonthState(ym, invs) {
  const today = todayJst(), w = invWindow(ym, today);
  if (ym < INVOICE_START) return 'WEBアプリでの請求対象外';
  if (w === 'before') return ym > CUR_MONTH ? '請求受付前' : '作業中・請求受付は' + Number(ym.slice(5)) + '/3から';
  const n = st => invs.filter(v => st.includes(v.status)).length, wait = n(['checking', 'returned', 'finance_returned']);
  if (w === 'open') return '請求受付中' + (invs.length ? '・請求' + invs.length + '件' + (wait ? '（確認待ち' + wait + '）' : '') : '');
  if (w === 'late') return '受付猶予（理由が必要）' + (invs.length ? '・請求' + invs.length + '件' : '');
  if (!invs.length) return '請求なし';
  if (wait) return '担当の確認中（' + wait + '件）';
  if (invs.some(v => v.status === 'finance' && !v.sentAt)) return '経理部へ送付待ち';
  if (invs.some(v => v.status === 'finance')) return '経理部確認中';
  return '請求完了';
}
/** 過去の請求（2026年10月分まで。契約管理シートの各月の「(名前)」）の確認者：契約の名前で照合（2026-10-30 ユーザー指定） */
let PAST_BY = null;
const nmKey = s => String(s || '').split(/\r?\n/)[0].replace(/[（(].*?[）)]/g, '').replace(/[\s　]/g, '');   /* 改行のあとの読み仮名などは使わない */
let PAST_BY_EXP = false;
async function loadPastBy() { if (PAST_BY && PAST_BY_EXP !== expFull()) PAST_BY = null; if (PAST_BY) return PAST_BY; PAST_BY_EXP = expFull(); try { PAST_BY = (await api('/invoices-past')).rows || []; } catch (e) { PAST_BY = []; } try { const acc = (await api('/sheet-accepts')).accepts || []; SHEET_ACCEPT = new Set(acc.map(a => a.cid + '_' + a.ym)); SHEET_WAIVE = new Map(acc.filter(a => a.waive).map(a => [a.cid + '_' + a.ym, a.note || ''])); } catch (e) { SHEET_ACCEPT = new Set(); SHEET_WAIVE = new Map(); } await loadStaffNames(); return PAST_BY; }
/** 「差異ありでOK」にした人・月（その月はスプレッドシートの金額を使う）（2026-10-31 ユーザー指定） */
let SHEET_ACCEPT = new Set();
/** 特例で請求なし（契約解除など。その月の支払いは0円＝支出にも入れない）（2026-11-05 ユーザー指定）。sheet_accepts の waive */
let SHEET_WAIVE = new Map();
const sheetWaived = (c, m) => SHEET_WAIVE.has(c.id + '_' + m);
const sheetAccepted = (c, m) => SHEET_ACCEPT.has(c.id + '_' + m);
/** シートの小計。シートに記録がない月でも「差異ありでOK」なら 0円（まとめて別の月に請求した月など。2026-10-31 ユーザー指定） */
const pastSubAcc = (c, m) => { if (sheetWaived(c, m)) return 0; const v = pastSub(c, m); return v != null ? v : SHEET_ACCEPT.has(c.id + '_' + m) ? 0 : null; };
/** 名字だけの名前をフルネームに（BEST社員管理の名前で、名字が1人だけ一致したとき） */
const fullStaffName = s => { const k = String(s || '').replace(/[\s　]/g, ''); if (!k) return ''; const hit = (STAFF_NAMES || []).filter(x => String(x.name || '').replace(/[\s　]/g, '').startsWith(k)); return hit.length === 1 ? hit[0].name : s; };
/** 過去の月（このWEBアプリでの請求の前）の請求状況：確認した人がいれば「請求完了」＋確認した人（2026-10-30 ユーザー指定） */
/* 過去の月（WEBアプリでの請求より前）は、金額がある月はすべて請求完了（確認者の記録がなくても。2026-10-31 ユーザー指定） */
const pastCell = (c, ym, amt) => { if (sheetWaived(c, ym)) return '<span class="pill off" title="' + esc(SHEET_WAIVE.get(c.id + '_' + ym) || '') + '">特例：請求なし</span>'; const by = pastBy(c, ym); return by ? '<span class="pill ok">請求完了</span><br><span class="note">' + by.split('・').map(n => esc(fullStaffName(n))).join('・') + '</span>' : (amt > 0 || pastSubAcc(c, ym) > 0) ? '<span class="pill ok">請求完了</span>' : '<span class="note">—</span>'; };
/* 同じ人の契約がメディアごとに2つ以上あるとき（徳良・工藤・羽柴）は、シートの行のメディアがその契約の担当メディアのものだけ（両方の契約に同じ請求が入って二重になっていた。2026-10-31） */
const pastHits = (c, ym) => { const ks = [nmKey(c.name), nmKey(c.company)].filter(Boolean), ms = c._multi ? (c.medias || []).concat(...(c.pastPays || []).map(p => p.medias || [])) : null; return (PAST_BY || []).filter(r => r.ym === ym && ks.includes(nmKey(r.name)) && (!ms || ms.some(m => String(r.media || '').startsWith(m))) && (c.category === 'site' || !/サイト(制作|改修|修正)費/.test(r.text || ''))); };   /* 会社名が同じでも、サイト制作・改修費の請求（businessbay）は記事・ディレクションの照合に使わない（2026-10-31） */
const pastBy = (c, ym) => [...new Set(pastHits(c, ym).map(r => r.by).filter(Boolean))].join('・');
/** シートの請求の文章から内訳（項目ごとの金額）を読む（小計・消費税・源泉・請求金額は除く） */
const SHEET_CAT = [['press', /プレス/], ['upload', /アップ/], ['image', /画像/], ['supervise', /監修/], ['writing', /執筆|記事作成|ライティング|新規|リライト|記事単価|文字/], ['direction', /ディレクション|構成|時間|稼働|管理/]];   /* アップロード・画像・監修を先に判定（「アップロード（新規）」が記事執筆に入っていた。2026-11-02） */
function sheetBreakdown(text) {
  const out = { press: 0, writing: 0, image: 0, upload: 0, supervise: 0, direction: 0, other: 0 }, others = []; let otherDir = 0;
  String(text || '').split(/\r?\n/).forEach(l => { const mm = l.match(/^\s*(.+?)\s*[：:]?\s*[￥¥]\s*([\d,]+)/); if (!mm || /小計|消費税|源泉|請求金額|合計/.test(mm[1])) return;
    const v = Number(mm[2].replace(/,/g, '')) || 0, k = (SHEET_CAT.find(([, re]) => re.test(mm[1])) || ['other'])[0]; out[k] += v; if (k === 'other' && v) { others.push(mm[1]); if (/ディレクター/.test(mm[1])) otherDir += v; } });
  // 内訳が税込みで書かれている（内訳の合計＝小計×1.1）ときは、税抜きに直す（加賀・谷本 2026/07：小計10,000・記事監修11,000）（2026-10-31）
  const keys = ['press', 'writing', 'image', 'upload', 'supervise', 'direction', 'other'], sum = keys.reduce((a, k) => a + out[k], 0);
  const st = (String(text || '').match(/小計\s*[￥¥]\s*([\d,]+)/) || [])[1], sub = st ? Number(st.replace(/,/g, '')) : 0;
  let taxIn = false;
  if (sub > 0 && sum > 0 && Math.abs(sum - sub * 1.1) <= 2) { taxIn = true; keys.forEach(k => { out[k] = Math.round(out[k] / 1.1); }); const d = sub - keys.reduce((a, k) => a + out[k], 0); const big = keys.slice().sort((a, b) => out[b] - out[a])[0]; out[big] += d; }   // 端数は大きい項目で合わせる
  return Object.assign(out, { others, taxIn, otherDir: taxIn ? Math.round(otherDir / 1.1) : otherDir });
}
/** 稼働表で時間単価を計算している人（種石さん）は、シートの「ディレクター」の行をディレクション（稼働表の時間）として比べる。ほかの人はこれまでどおりシートの金額をそのまま使う（2026-10-31） */
/* シートの「ディレクター」の行をディレクションとして比べるのは、稼働表のディレクター業務の時間で計算する人（ディレクション費の条件に「時間」がある人＝種石さん）だけ。時間単価のオプション（hourOn）だけの人（丸子・江連）はシートの金額をそのまま使う（2026-11-02） */
const tsDirRate = c => (((c.pay || {}).direction) || []).some(x => /時間/.test(x.cond || ''));
function sheetBreakdownFor(c, text) { const b = sheetBreakdown(text); if (tsDirRate(c) && b.otherDir) { b.direction += b.otherDir; b.other -= b.otherDir; b.others = b.others.filter(n => !/ディレクター/.test(n)); } return b; }
/** ダッシュボード（進行管理）の内訳 */
function dashBreakdown(c, x) {
  const p = x.pay || c.pay || {}, ty = t => x.main.filter(r => payType(r) === t).length, aNew = p.articleNew ?? p.article;
  const writing = p.type === '文字単価' ? (p.char != null ? p.char * (x.chars - (x.olOverChars || 0)) + (x.outlineRate || 0) * (x.olOverChars || 0) : 0) : p.type === '記事単価' ? (Number(aNew) || 0) * (ty('新規') + ty('リライト(新規)')) + (Number(p.articleRewrite) || 0) * ty('リライト') + (Number(p.articleLite) || 0) * ty('簡易リライト') : 0;
  const image = p.type === '文字単価' && p.image != null ? p.image * x.images : 0, upload = p.upload != null ? p.upload * x.up : 0, supervise = p.superviseOn && p.supervise != null ? p.supervise * x.sup : 0;
  const press = x.pressAmt || 0, pImg = (x.pressImg || 0) * (Number(p.image) || 0), pUp = (x.pressUp || 0) * (Number(p.upload) || 0);
  const direction = Math.max(0, (x.est || 0) - writing - image - upload - supervise - press - pImg - pUp);
  /* 文字単価の人のプレスリリースは、シートでは記事執筆・画像・アップロードに入っているので、そちらに足して比べる（2026-11-02） */
  if (x.pressMode === 'char') return { press: 0, writing: writing + press, image: image + pImg, upload: upload + pUp, supervise, direction, other: 0, p };
  return { press, writing, image: image + pImg, upload: upload + pUp, supervise, direction, other: 0, p };
}
/** シートとの差の理由と、どこを直せば一致するか（2026-10-30 ユーザー指定） */
function sheetDiffModal(c, m, x) {
  const hits = pastHits(c, m), sb = sheetBreakdownFor(c, hits.map(h => h.text).join('\n')), db = dashBreakdown(c, x), p = db.p, sheetSub = pastSub(c, m) || 0;
  const L = { press: 'プレスリリース（本数×単価）', writing: p.type === '文字単価' ? '記事執筆（文字数×単価）' : '記事（本数×単価）', image: '画像作成', upload: 'アップロード', supervise: '記事監修', direction: 'ディレクション・構成・時間', other: 'その他（読み取れない項目）' };
  const fix = (k, d) => {
    if (k === 'writing' && p.type === '文字単価') return '進行管理で、' + mLabel(m) + 'にアップロード日がある「執筆担当＝' + esc(c.name) + '」の記事の<b>文字数</b>を確認（差は約 ' + nf.format(Math.round(Math.abs(d) / (p.char || 1))) + ' 文字分。単価 ' + p.char + '円）。' + (x.n ? '' : '進行管理にこの月の担当記事がありません。<b>アップロード日</b>と<b>執筆担当</b>を確認。');
    if (k === 'writing') return '進行管理で、' + mLabel(m) + 'にアップロード日がある担当記事の<b>本数</b>と<b>制作判断</b>（新規・リライト・簡易リライト）を確認。' + (x.n ? '' : 'この月の担当記事が進行管理にありません（アップロード日・担当者名を確認）。');
    if (k === 'image') return '進行管理の<b>画像枚数</b>（画像担当／執筆担当＝' + esc(c.name) + '）を確認（差は約 ' + nf.format(Math.round(Math.abs(d) / (p.image || 1))) + ' 枚分）。';
    if (k === 'upload') return '進行管理の<b>アップロード担当</b>と<b>アップロード日</b>を確認' + (p.uploadNewOnly ? '（アップロード費は新規記事だけ）' : '') + '。';
    if (k === 'supervise') return '進行管理の<b>監修担当</b>を確認。';
    if (k === 'press') return 'コンテンツ進行管理の<b>プレスリリース</b>で、' + mLabel(m) + 'に公開したリリースの<b>担当</b>と<b>リリース日</b>を確認。契約管理の<b>プレスリリース単価</b>も確認。';
    if (k === 'direction') return 'ディレクション担当の記事・稼働表の時間を確認。契約内容に計算できない条件があるときは、契約管理のディレクション費の条件を確認。';
    return 'シートの内訳（' + esc(sb.others.join('・')) + '）が読めません。シートの書き方を確認。';
  };
  const keys = ['writing', 'image', 'upload', 'supervise', 'direction', 'press', 'other'].filter(k => db[k] || sb[k]);
  /* 契約に単価がない画像制作・アップロード（時間単価など）と、進行管理にない項目は、シートの金額を使う（2026-10-31 ユーザー指定） */
  if (!(p.type === '文字単価' && p.image != null)) db.image = sb.image; if (p.upload == null) db.upload = sb.upload; db.other = sb.other;   /* その他（進行管理にない項目）はシートの金額（2026-10-31 ユーザー指定） */
  const accOk = sheetAccepted(c, m);   /* 「差異ありでOK」の月は、スプレッドシートを正として差は0（2026-10-31 ユーザー指定） */
  const rows = keys.map(k => { const d = accOk ? 0 : (db[k] || 0) - (sb[k] || 0); return '<tr' + (Math.abs(d) > 1 ? ' class="rdf-ng"' : '') + '><td class="c-txt">' + L[k] + '</td><td class="c-num">' + yen0(db[k] || 0) + '</td><td class="c-num">' + yen0(sb[k] || 0) + '</td><td class="c-num">' + (Math.abs(d) > 1 ? (d > 0 ? '+' : '−') + yen0(Math.abs(d)) : accOk && Math.abs((db[k] || 0) - (sb[k] || 0)) > 1 ? '0（シートを正）' : '一致') + '</td><td class="c-txt">' + (Math.abs(d) > 1 ? fix(k, d) : '') + '</td></tr>'; }).join('');
  const prev = shiftMonth(m, -1), next = shiftMonth(m, 1), near = [prev, next].map(mm => ({ mm, e: rewardCalc(c, mm, ITEMS.filter(r => paidIn(r, mm))).est || 0 })).filter(o => o.e && Math.abs(o.e - sheetSub) <= 1);
  const arts = x.main.concat(x.upList || [], x.supList || []).filter((r, i, a) => a.indexOf(r) === i);
  wideModal('<h2>' + esc(c.name) + ' ' + mLabel(m) + '：スプレッドシートとの差</h2>'
    + '<div class="kpis rwp-kpis"><div class="kpi"><span>進行管理（ダッシュボード）＋その他</span><b>' + yen0((x.est || 0) + db.other) + '</b></div><div class="kpi"><span>スプレッドシートの小計</span><b>' + yen0(sheetSub) + '</b></div><div class="kpi"><span>差</span><b>' + (accOk ? '¥0' : ((x.est || 0) + db.other - sheetSub > 0 ? '+' : '−') + yen0(Math.abs((x.est || 0) + db.other - sheetSub))) + '</b>' + (accOk ? '<small class="note">差異ありでOK：スプレッドシートを正（進行管理は直していません）</small>' : '') + '</div></div>'
    + (near.length ? '<p class="err">⚠ シートの金額は、進行管理の ' + near.map(o => mLabel(o.mm)).join('・') + ' の分と同じです。請求の月とアップロード日の月がずれている可能性があります（進行管理の<b>アップロード日</b>を確認）。</p>' : '')
    + '<h3 class="am-h">項目ごとの差と直すところ</h3><div class="table-wrap"><table class="am-table rdf-table"><thead><tr><th class="c-txt">項目</th><th class="c-num">進行管理</th><th class="c-num">シート</th><th class="c-num">差</th><th class="c-txt">一致させるには</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="c-txt"><span class="note">シートの内訳を読めませんでした</span></td></tr>') + '</tbody></table></div>'
    + '<h3 class="am-h">進行管理で数えている記事（' + mLabel(m) + '・' + arts.length + '本）</h3>' + (arts.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-ctr">アップロード日</th><th class="c-txt">メディア</th><th class="c-txt">No.・検索KW</th><th class="c-num">文字数</th><th class="c-num">画像</th><th class="c-txt">制作判断</th></tr></thead><tbody>'
      + arts.map(r => '<tr><td class="c-ctr">' + esc(String(r.upload_date || '').slice(5).replace('-', '/')) + (r.bill_ym ? '<br><span class="note">' + esc(mLabel(r.bill_ym)) + 'に請求</span>' : '') + '</td><td class="c-txt">' + esc(mediaLabel(r.media)) + (r.sub ? '（' + esc(r.sub) + '）' : '') + '</td><td class="c-txt">' + esc((r.no ? 'No.' + r.no + ' ' : '') + (r.kw || r.keyword || '')) + '</td><td class="c-num">' + (Number(r.chars) ? nf.format(r.chars) : '<span class="err">空</span>') + '</td><td class="c-num">' + (r.image_count || 0) + '</td><td class="c-txt">' + esc(payType(r)) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">この月にアップロード日がある担当記事は、進行管理にありません。</p>')
    + '<h3 class="am-h">スプレッドシートの記録</h3>' + hits.map(h => '<pre class="rdf-text">' + esc(h.text || '') + '</pre>').join('')
    + '<div class="row" style="justify-content:flex-end; gap:6px">' + (isAdmin() ? (sheetAccepted(c, m) ? '<span class="note" style="margin-right:auto">この月は「差異ありでOK」：スプレッドシートの金額を使っています。</span><button class="btn" type="button" id="rdf-acc" data-on="0">「差異ありでOK」を取り消す</button>' : '<button class="btn" type="button" id="rdf-acc" data-on="1" title="進行管理は直さず、この月はスプレッドシートの金額を使います">差異ありでOK（スプレッドシートから引用）</button>') : '') + (isAdmin() && !sheetAccepted(c, m) ? '<button class="btn rdf-fix" type="button" id="rdf-fix">スプシにあわせて進行管理を修正</button>' : '') + '<button class="btn" type="button" data-close>閉じる</button></div>');
  if ($('rdf-fix')) $('rdf-fix').onclick = async () => {
    const plan = sheetFixFor(c, m);
    if (!plan.length) { alert('進行管理の数字（文字数・画像枚数・アップロード）では合わせられる差がありません。記事の本数・ディレクション費などの差は「差異ありでOK」にしてください。'); return; }
    if (!confirm('進行管理を次のように直します。よろしいですか？（直す前の値は記録に残ります）\n\n' + plan.map(f => '・' + (f.r.no ? 'No.' + f.r.no + ' ' : '') + (f.r.kw || '') + '：' + fixFieldLabel(f.field) + ' ' + (f.field === 'upload_owner' ? f.from + ' → （外す）' : nf.format(f.from) + ' → ' + nf.format(f.to))).join('\n'))) return;
    $('rdf-fix').disabled = true; const r = await applySheetFix(plan); closeModal(); alert(r.ok + '件を直しました。' + (r.fails.length ? '\n直せなかったもの：\n' + r.fails.join('\n') : '')); render();
  };
  if ($('rdf-acc')) $('rdf-acc').onclick = async () => { const on = $('rdf-acc').dataset.on === '1'; try { await apiSend('PUT', '/sheet-accepts', { cid: c.id, ym: m, on }); if (on) SHEET_ACCEPT.add(c.id + '_' + m); else SHEET_ACCEPT.delete(c.id + '_' + m); closeModal(); toast(on ? '差異ありでOKにしました' : '取り消しました'); render(); } catch (e) { alert(e.message); } };
}
/** 進行管理にない項目（BOX背景変更など）と、契約に単価がない画像制作は、シートの金額をそのまま使う（2026-10-31 ユーザー指定） */
const sheetExtra = (c, m) => { if (m >= INVOICE_START) return 0; const hs = pastHits(c, m); if (!hs.length) return 0; const sb = sheetBreakdownFor(c, hs.map(h => h.text).join('\n')), past = (c.pastPays || []).find(x => x.from <= m && m <= x.to), p = (past && past.pay) || c.pay || {}; return sb.other + (p.type === '文字単価' && p.image != null ? 0 : sb.image) + (p.upload != null ? 0 : sb.upload); };   /* 契約にアップロード単価がない（時間単価など）ときのアップロードもシートの金額（2026-10-31 ユーザー指定） */
/** スプレッドシートのその月の請求の小計（税抜き）。記録がなければ null（2026-10-30） */
/** シートの小計。内訳（項目 ￥金額）があって小計と合わないときは内訳の合計を使う（小計の書き間違い：江連さん 2025/11 の「¥17,025」＝内訳は170,295。2026-10-31） */
const pastSub = (c, ym) => { const hs = pastHits(c, ym).filter(r => r.subtotal != null && r.subtotal !== ''); if (!hs.length) return null; return hs.reduce((a, r) => { const b = sheetBreakdown(r.text), sum = ['press', 'writing', 'image', 'upload', 'supervise', 'direction', 'other'].reduce((x, k) => x + (b[k] || 0), 0), st = Number(r.subtotal) || 0; return a + (sum > 0 && Math.abs(sum - st) > 1 ? sum : st); }, 0); };
/** 請求を確認した人（請求担当が「完了」か「差し戻し」をした人と日付）（2026-10-30 ユーザー指定） */
const invChecker = v => v && v.checkedBy ? '<br>' + esc(fullStaffName(v.checkedBy)) + (v.checkedAt ? ' ' + dt(v.checkedAt).replace(/s.*$/, '') : '') : '';
/** 備考：請求に入る記事（メディア・種類ごとに No.と KW）。Wordeal の請求書を参考に（2026-10-29） */
function invRemarks(c, x) {
  const is = (v, m) => !!v && (v === c.name || personName(v, m) === c.name), rows = x.main.concat(x.upList || [], x.supList || []).filter((r, i, a) => a.indexOf(r) === i);
  const g = {}; rows.forEach(r => { const k = mediaLabel(r.media) + '\u0001' + payType(r); (g[k] = g[k] || []).push(r); });
  return Object.keys(g).sort().map(k => { const [m, t] = k.split('\u0001'); return '【' + m + '】※' + t + g[k].length + '記事\n' + g[k].sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0)).map(r => (r.no ? r.no + ' ' : '') + String(r.kw || r.title || '').replace(/\s*\n\s*/g, ' ')).join('\n'); }).join('\n\n');
}
/** 請求書の本体（画面の確認・印刷・PDF で共通） */
/** BEST の登録番号（全員の請求書に共通。経理部確認で設定。2026-10-30 ユーザー指定） */
let BEST_INV_NO = '';
async function loadBestNo() { try { const r = await api('/invoice-best-no'); BEST_INV_NO = r.no || ''; return r; } catch (e) { return { no: BEST_INV_NO, canEdit: false }; } }
function invoiceDocHtml(v) {
  const t = invTotals(v.items || [], v.entity), who = v.entity === '企業' && v.company ? v.company + (v.name ? '<br>' + esc(v.name) : '') : esc(v.name);
  return '<div class="inv-doc"><h1>請求書</h1><div class="inv-top"><div><p class="inv-to">' + INV_TO + '</p><p class="note">' + INV_TO_ADDR + '</p><p class="inv-bestno">登録番号：' + esc(BEST_INV_NO) + '</p><p>件名：' + ymJp(v.ym) + '分 業務委託費' + (v.subject ? '（' + esc(v.subject) + '）' : '') + '</p><p class="inv-sum">ご請求金額 <b>' + yen0(t.total) + '</b>（税込み）</p></div>'
    + '<div class="inv-from"><p>請求日：' + dateJpS(v.issueDate || todayJst()) + '</p>' + (v.invoiceNumber ? '<p>請求書番号：' + esc(v.invoiceNumber) + '</p>' : '') + '<p><b>' + (v.entity === '企業' && v.company ? esc(v.company) + '<br>' + esc(v.name) : esc(v.name)) + '</b></p>' + (v.address ? '<p class="inv-addr">' + esc(v.address) + '</p>' : '') + (v.invoiceNo ? '<p>登録番号：' + esc(v.invoiceNo) + '</p>' : '') + '</div></div>'
    + '<table class="inv-table"><thead><tr><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead><tbody>'
    + t.lines.map(x => '<tr><td>' + esc(x.label) + (x.kind === 'other' ? ' <span class="note">（その他）</span>' : '') + '</td><td class="num">' + nf.format(x.qty) + (x.unitLabel ? esc(x.unitLabel) : '') + '</td><td class="num">' + yen0(x.unit) + '</td><td class="num">' + yen0(x.amount) + '</td></tr>').join('')
    + '</tbody><tfoot><tr><td colspan="3">小計（税抜き）</td><td class="num">' + yen0(t.subtotal) + '</td></tr><tr><td colspan="3">消費税（10%）</td><td class="num">' + yen0(t.tax) + '</td></tr>'
    + (v.entity === '個人' ? '<tr><td colspan="3">源泉所得税（' + (t.subtotal > 1000000 ? '100万円まで10.21%・超える分20.42%' : '10.21%') + '）</td><td class="num">−' + yen0(t.withholding) + '</td></tr>' : '')
    + '<tr class="inv-total"><td colspan="3">ご請求金額</td><td class="num">' + yen0(t.total) + '</td></tr></tfoot></table>'
    + (v.remarks ? '<div class="inv-remarks"><b>備考</b><br>' + esc(v.remarks).replace(/\n/g, '<br>') + '</div>' : '') + '<div class="inv-bank"><b>お振込先</b><br>' + esc((v.bank || {}).bankName || '') + '　' + esc((v.bank || {}).branch || '') + '<br>' + esc((v.bank || {}).type || '普通') + '　' + esc((v.bank || {}).number || '') + '<br>口座名義：' + esc((v.bank || {}).holder || '') + '<br>お支払期日：' + dateJpS(v.dueDate || invDue(v.ym)) + '</div></div>';
}
/** サーバーで作った PDF をダウンロード（経理部へ送るものと同じ） */
async function invPdf(v) {
  try {
    const tok = await fbAuth.currentUser.getIdToken(), headers = { Authorization: 'Bearer ' + tok }; if (PREVIEW_UID) headers['X-Preview-UID'] = PREVIEW_UID;
    const r = await fetch('/api/invoices/' + encodeURIComponent(v.id) + '/pdf', { headers }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '通信エラー（' + r.status + '）');
    const url = URL.createObjectURL(await r.blob()), a = document.createElement('a'); a.href = url; a.download = '請求書_' + ymJp(v.ym) + '分_' + (v.company || v.name || '') + '.pdf'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { alert('PDF をダウンロードできませんでした：' + e.message); }
}
/** 管理者（日比野さん）：その月の請求の取りまとめ → 「請求完了（経理部へ送る）」 */
/** 請求の取りまとめ：今の状況の図（フェーズごとに誰がいるか。いちばん左は完了記事がない人）（2026-10-30 ユーザー指定） */
const INV_FLOW = [['none', '完了記事なし', 'ibf-none'], ['todo', '未請求', 'ibf-bad'], ['checking', '請求確認中', 'ibf-warn'], ['returned', '差し戻し', 'ibf-bad'], ['wait', '経理部へ送付待ち', 'ibf-info'], ['finance', '経理部確認中', 'ibf-info'], ['finance_returned', '経理部から差し戻し', 'ibf-bad'], ['done', '請求完了', 'ibf-ok']];
async function drawInvFlow(ym, list) {
  await loadItems();
  const cs = (await loadContracts()).contracts.filter(c => c.active && c.category !== 'site');
  await loadTimesheets(cs, ym);
  const done = ITEMS.filter(r => paidIn(r, ym));
  const cols = {}; INV_FLOW.forEach(([k]) => { cols[k] = []; });
  const seen = new Set();
  list.forEach(v => { seen.add(v.contractId); const k = v.status === 'finance' ? (v.sentAt ? 'finance' : 'wait') : v.status; (cols[k] || cols.checking).push({ name: v.name, sub: yen0(v.total) }); });
  const past = ym < INVOICE_START; if (past) await loadPastBy();   /* WEBアプリでの請求より前の月は契約管理シートで請求済み＝請求完了（2026-11-05 ユーザー指定） */
  cs.filter(c => !seen.has(c.id)).forEach(c => {
    const r = invItemsByMedia(c, ym, done), t = r.items.length ? invTotals(r.items, c.entity) : null;
    if (past) { if (sheetWaived(c, ym)) { cols.none.push({ name: c.name, sub: '特例：請求なし' }); return; } const sh = pastSubAcc(c, ym), amt = sh != null ? sh : (t ? t.subtotal : 0); if (amt > 0) cols.done.push({ name: c.name, sub: '報酬額 ' + yen0(amt) + (sh != null ? '（シート）' : '') }); else cols.none.push({ name: c.name, sub: '' }); return; }
    if (t && t.subtotal > 0) cols.todo.push({ name: c.name, sub: '報酬額 ' + yen0(t.subtotal) }); else cols.none.push({ name: c.name, sub: '' });
  });
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
  $('ib-flow').innerHTML = '<div class="ibf">' + INV_FLOW.map(([k, l, cls], i) => '<div class="ibf-col' + (k === 'none' ? ' ibf-first' : '') + '"><div class="ibf-h">' + l + ' <span class="note">' + cols[k].length + '人</span></div>'
    + (cols[k].length ? cols[k].sort(byName).map(x => '<span class="ibf-chip ' + cls + '">' + esc(x.name) + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</span>').join('') : '<span class="note">—</span>') + '</div>' + (i < INV_FLOW.length - 1 ? '<div class="ibf-ar" aria-hidden="true">' + (i === 0 ? '' : '→') + '</div>' : '')).join('') + '</div>'
    + '<p class="note">完了記事なし＝この月に完了した担当記事がない契約中の人。未請求＝担当記事があるのに請求していない人（報酬額・税抜き）。ほかは請求の状態ごと（金額は税込み）。' + (ym < INVOICE_START ? mLabel(INVOICE_START) + 'より前の月は契約管理シートで請求済みなので、報酬がある人は請求完了（金額は税抜き。シートの小計、なければ進行管理からの計算）。' : '') + '</p>';
}
/** 報酬額の確認（2026-10-30 ユーザー指定）：報酬額が少なく出る原因の一覧
 *  ② 文字単価の人の担当記事で、進行管理の文字数が空（0）の記事
 *  ③ 進行管理の担当者名が、契約管理・BEST社員管理のどの名前とも合わない（担当者の紐づけもない）記事 */
function viewRwCheck() {
  return { html: '<section class="panel" id="rc-body"><p class="loading">読み込み中…</p></section>', view: '報酬額の確認', after: async () => {
    await loadItems(); await loadPersonNames(); await loadPastBy();
    const cs = (await loadContracts()).contracts.filter(c => c.category !== 'site'), months = RW_MONTHS(), from = months[months.length - 1], today = todayJst();
    const done = ITEMS.filter(r => r.upload_date && r.upload_date.slice(0, 7) >= from && r.upload_date <= today && !OWN_BILLING_MEDIA.includes(r.media) && r.status !== 'BEST365から移管' && !subOwner(r));   // カギ・ガラスは幸谷さんがまとめて請求するので対象外
    const isMe = (c, v, media) => !!v && (v === c.name || personName(v, media) === c.name);
    const payAt = (c, ym) => { const past = (c.pastPays || []).find(x => x.from <= ym && ym <= x.to); return (past && past.pay) || c.pay || {}; };
    const art = r => '<span class="note">' + esc(String(r.upload_date).slice(0, 10).replace(/-/g, '/')) + '</span> ' + esc(mediaLabel(r.media)) + (r.sub ? '（' + esc(r.sub) + '）' : '') + ' ' + esc(r.no ? 'No.' + r.no + ' ' : '') + esc(r.keyword || r.title || '');
    // ②
    const noChars = [];
    cs.forEach(c => { const k = RW_ROLE_KEY[c.category] || 'writer';
      const rs = done.filter(r => payAt(c, r.upload_date.slice(0, 7)).type === '文字単価' && isMe(c, r[k], r.media) && !(Number(r.chars) > 0));
      if (rs.length) noChars.push({ c, rs: rs.sort((a, b) => String(b.upload_date).localeCompare(a.upload_date)) }); });
    noChars.sort((a, b) => b.rs.length - a.rs.length || String(a.c.name).localeCompare(b.c.name, 'ja'));
    // ③
    const COLS = [['director', 'ディレクション'], ['writer', '執筆'], ['upload_owner', 'アップロード'], ['supervisor', '監修']];
    const known = v => { const n = normName(v), pn = normName(personName(v, '')); return [...KNOWN_PEOPLE].some(x => normName(x) === n || normName(x) === pn) || cs.some(c => normName(c.name) === n); };
    const bad = {};
    done.forEach(r => COLS.forEach(([k, l]) => { const v = String(r[k] || '').trim(); if (!v || /^(不要|なし|無し|ー|ｰ|-|－|―|×|不明)$/.test(v) || cs.some(c => isMe(c, v, r.media)) || known(personName(v, r.media)) || known(v)) return;
      const key = v + '\u0001' + r.media; const o = bad[key] = bad[key] || { v, media: r.media, cols: new Set(), rs: [] }; o.cols.add(l); if (!o.rs.includes(r)) o.rs.push(r); }));
    const badList = Object.values(bad).sort((a, b) => b.rs.length - a.rs.length || a.v.localeCompare(b.v, 'ja'));
    const listOf = rs => '<details><summary>' + rs.length + '件の記事</summary><div class="rc-arts">' + rs.slice(0, 200).map(r => '<div>' + art(r) + '</div>').join('') + '</div></details>';
    const fixPlan = sheetFixPlan(cs);
    $('rc-body').innerHTML = H('報酬額の確認 <small>' + mLabel(from) + '〜' + mLabel(months[0]) + 'に完了した記事（アップロード日が今日まで）</small>', ['記事管理', '契約管理'])
      + '<p class="note">カギお助け本舗・ガラスお助け本舗（幸谷さんがまとめて請求）と、水まわりお助け本舗の過去制作（井上さん（ハドリー）の担当として計算）は、この一覧には入れていません。報酬額が少なく出る原因を一覧にしています。直すときは コンテンツ作成 →「進行管理」で、文字数や担当者を入れ直してください（ここは見るだけです）。</p>'
      + '<h3 class="am-h">② 文字数が空の記事（文字単価の人の担当記事） <span class="note">' + noChars.reduce((a, x) => a + x.rs.length, 0) + '件・' + noChars.length + '人</span></h3>'
      + (noChars.length ? '<div class="table-wrap"><table class="am-table rc-table"><thead><tr><th class="c-txt">担当者</th><th class="c-txt">契約内容</th><th class="c-num">件数</th><th class="c-txt">記事（アップロード日・メディア・No.・検索KW）</th></tr></thead><tbody>'
        + noChars.map(({ c, rs }) => '<tr><td class="c-txt"><b>' + esc(c.name) + '</b>' + (c.status && c.status !== '契約中' ? '<br><span class="note">' + esc(c.status) + '</span>' : '') + '</td><td class="c-txt"><span class="note">' + esc(payLabel(c)) + '</span></td><td class="c-num">' + rs.length + '</td><td class="c-txt">' + listOf(rs) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="empty">文字数が空の記事はありません。</p>')
      + '<h3 class="am-h" style="margin-top:16px">③ 担当者名が契約と合っていない記事 <span class="note">' + badList.reduce((a, x) => a + x.rs.length, 0) + '件・' + badList.length + '通りの名前</span></h3>'
      + '<p class="note">進行管理の担当者名が、契約管理・BEST社員管理のどの名前とも合わず、担当者の紐づけもない名前です。この記事は、どの人の報酬額にも入りません。名前を直すか、管理 →「担当者の紐づけ」で人に紐づけてください。</p>'
      + (badList.length ? '<div class="table-wrap"><table class="am-table rc-table"><thead><tr><th class="c-txt">進行管理の名前</th><th class="c-txt">メディア</th><th class="c-txt">入っている欄</th><th class="c-num">件数</th><th class="c-txt">記事（アップロード日・メディア・No.・検索KW）</th></tr></thead><tbody>'
        + badList.map(o => '<tr><td class="c-txt"><b>' + esc(o.v) + '</b></td><td class="c-txt">' + esc(mediaLabel(o.media)) + '</td><td class="c-txt">' + [...o.cols].join('・') + '</td><td class="c-num">' + o.rs.length + '</td><td class="c-txt">' + listOf(o.rs.sort((a, b) => String(b.upload_date).localeCompare(a.upload_date))) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="empty">契約と合っていない担当者名はありません。</p>')
      + '<h3 class="am-h" style="margin-top:16px">④ シートの支払額に合わせて、進行管理の文字数・画像枚数を直す <span class="note">' + fixPlan.length + '件</span></h3>'
      + '<p class="note">10月分までの各月で、スプレッドシートの「ライティング（記事執筆）」「画像制作」の金額と、進行管理から計算した金額が違うとき、その月のいちばん新しい担当記事の数字を直して合わせます（文字単価の人だけ。記事の本数の差は直せません）。直すのは進行管理（ダッシュボード）だけで、スプレッドシートには書き込みません。直す前の値は記録に残します。</p>'
      + (fixPlan.length ? '<div class="table-wrap am-scroll"><table class="am-table rc-table"><thead><tr><th class="c-txt">担当者</th><th class="c-ctr">月</th><th class="c-txt">項目</th><th class="c-txt">記事</th><th class="c-num">今</th><th class="c-num">直したあと</th><th class="c-txt">理由</th></tr></thead><tbody>'
        + fixPlan.map(f => '<tr><td class="c-txt">' + esc(f.who) + '</td><td class="c-ctr">' + mLabel(f.ym) + '</td><td class="c-txt">' + fixFieldLabel(f.field) + '</td><td class="c-txt">' + esc(mediaLabel(f.r.media) + ' ' + (f.r.no ? 'No.' + f.r.no + ' ' : '') + (f.r.kw || '')) + '<br><span class="note">' + esc(String(f.r.upload_date || '').replace(/-/g, '/')) + '</span></td><td class="c-num">' + (f.field === 'upload_owner' ? esc(f.from) : nf.format(f.from)) + '</td><td class="c-num"><b>' + (f.field === 'upload_owner' ? '（外す）' : nf.format(f.to)) + '</b></td><td class="c-txt"><span class="note">' + esc(f.why) + '</span></td></tr>').join('')
        + '</tbody></table></div><div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn primary" type="button" id="rc-fix">この内容で進行管理を直す（' + fixPlan.length + '件）</button></div>'
        : '<p class="empty">直すところはありません。</p>');
    if ($('rc-fix')) $('rc-fix').onclick = async () => {
      if (!confirm(fixPlan.length + '件の文字数・画像枚数を、シートの支払額に合わせて直します。よろしいですか？（直す前の値は記録に残ります）')) return;
      $('rc-fix').disabled = true; let ok = 0; const fails = [];
      for (const f of fixPlan) { try { await apiSend('PATCH', '/article-items', { key: f.r.key, fields: { [f.field]: f.to } }); ok++; } catch (e) { fails.push(f.who + ' ' + f.ym + '：' + e.message); } }
      try { await apiSend('POST', '/sheet-fix-log', { changes: fixPlan.map(f => ({ key: f.r.key, field: f.field, from: f.from, to: f.to, who: f.who, ym: f.ym, why: f.why })) }); } catch (e) { fails.push('記録：' + e.message); }
      ITEMS = null; alert(ok + '件を直しました。' + (fails.length ? '\n直せなかったもの：\n' + fails.slice(0, 10).join('\n') : '')); render();
    };
  } };
}
/** シートの支払額に合わせるための直し方（文字単価の人：記事執筆＝文字数、画像制作＝画像枚数。その月のいちばん新しい担当記事で合わせる） */
/** 1人・1か月分：シートの金額に合わせる直し方（文字数・画像枚数・アップロードが多いときはアップロード担当を外す）（2026-10-31 ユーザー指定） */
function sheetFixFor(c, m, done) {
  const out = [], hs = pastHits(c, m); if (!hs.length || m >= INVOICE_START) return out;
  const past = (c.pastPays || []).find(x => x.from <= m && m <= x.to), p = (past && past.pay) || c.pay || {};
  const x = rewardCalc(c, m, done || ITEMS.filter(r => paidIn(r, m))), sb = sheetBreakdown(hs.map(h => h.text).join('\n'));
  const latest = list => list.slice().sort((a, b) => String(b.upload_date).localeCompare(String(a.upload_date)));
  const fix = (field, rate, sheetAmt, cur, list, label) => {
    if (!(rate > 0) || !list.length) return;
    const target = Math.round(sheetAmt / rate), delta = target - cur; if (!delta) return;
    let left = delta;
    for (const r of latest(list)) { if (!left) break; const now = Number(r[field]) || 0, to = Math.max(0, now + left); if (to === now) continue; out.push({ who: c.name, ym: m, field, r, from: now, to, why: label + '：シート ' + yen0(sheetAmt) + '＝' + nf.format(target) + (field === 'chars' ? '文字' : '枚') + '、進行管理 ' + nf.format(cur) }); left -= (to - now); }
  };
  if (p.type === '文字単価') { fix('chars', Number(p.char), sb.writing - (x.pressMode === 'char' ? (x.pressAmt || 0) : 0), x.chars, x.main, '記事執筆'); if (p.image != null) fix('image_count', Number(p.image), sb.image - (x.pressImg || 0) * Number(p.image), x.images, x.imgList || [], '画像制作'); }
  // アップロード：進行管理のほうが多いときは、新しい記事からアップロード担当を外す（少ないときは記事がないので直せない）
  if (Number(p.upload) > 0 && x.upList) { const target = Math.round((sb.upload || 0) / Number(p.upload)), extra = x.upList.length - target;
    if (extra > 0) latest(x.upList).slice(0, extra).forEach(r => out.push({ who: c.name, ym: m, field: 'upload_owner', r, from: r.upload_owner || c.name, to: '', why: 'アップロード：シート ' + yen0(sb.upload || 0) + '＝' + target + '本、進行管理 ' + x.upList.length + '本' })); }
  return out;
}
/** 直し方を進行管理に書く（直す前の値は sheet_fix_logs に） */
async function applySheetFix(plan) {
  let ok = 0; const fails = [];
  for (const f of plan) { try { await apiSend('PATCH', '/article-items', { key: f.r.key, fields: { [f.field]: f.to } }); ok++; } catch (e) { fails.push(f.who + ' ' + f.ym + '：' + e.message); } }
  try { await apiSend('POST', '/sheet-fix-log', { changes: plan.map(f => ({ key: f.r.key, field: f.field, from: f.from, to: f.to, who: f.who, ym: f.ym, why: f.why })) }); } catch (e) { fails.push('記録：' + e.message); }
  ITEMS = null; return { ok, fails };
}
const fixFieldLabel = f => ({ chars: '文字数', image_count: '画像枚数', upload_owner: 'アップロード担当' })[f] || f;
function sheetFixPlan(cs) {
  const out = [], today = todayJst();
  RW_MONTHS().concat(Array.from({ length: 24 }, (_, i) => shiftMonth(CUR_MONTH, -12 - i))).filter(m => m < INVOICE_START).forEach(m => {
    const done = ITEMS.filter(r => paidIn(r, m));
    cs.forEach(c => {
      const hs = pastHits(c, m); if (!hs.length) return;
      const past = (c.pastPays || []).find(x => x.from <= m && m <= x.to), p = (past && past.pay) || c.pay || {};
      sheetFixFor(c, m, done).forEach(f => out.push(f)); return;
      const x = rewardCalc(c, m, done), sb = sheetBreakdown(hs.map(h => h.text).join('\n'));
      const fix = (field, rate, sheetAmt, cur, list, label) => {
        if (!(rate > 0) || !list.length) return;
        const target = Math.round(sheetAmt / rate), delta = target - cur; if (!delta) return;
        let left = delta; const arts = list.slice().sort((a, b) => String(b.upload_date).localeCompare(String(a.upload_date)));
        for (const r of arts) { if (!left) break; const now = Number(r[field]) || 0, to = Math.max(0, now + left); if (to === now) continue; out.push({ who: c.name, ym: m, field, r, from: now, to, why: label + '：シート ' + yen0(sheetAmt) + '＝' + nf.format(target) + (field === 'chars' ? '文字' : '枚') + '、進行管理 ' + nf.format(cur) }); left -= (to - now); }
      };
      fix('chars', Number(p.char), sb.writing - (x.pressMode === 'char' ? (x.pressAmt || 0) : 0), x.chars, x.main, '記事執筆');
      if (p.image != null) fix('image_count', Number(p.image), sb.image - (x.pressImg || 0) * Number(p.image), x.images, x.imgList || [], '画像制作');
    });
  });
  return out;
}
function viewInvBatch() {
  const ym = state.invYm = state.invYm || shiftMonth(CUR_MONTH, -1);
  return { html: '<section class="panel" id="ib-body"><p class="loading">読み込み中…</p></section>', view: '請求の取りまとめ', after: async () => {
    const d = await api('/invoices-batch/' + ym), list = d.invoices.sort((a, b) => String(a.name).localeCompare(b.name, 'ja'));
    const wait = list.filter(v => ['checking', 'returned', 'finance_returned'].includes(v.status)), unsent = list.filter(v => v.status === 'finance' && !v.sentAt), sum = list.reduce((a, v) => a + (v.total || 0), 0);
    $('ib-body').innerHTML = H('請求の取りまとめ <small>' + ymJp(ym) + '分</small>', ['契約管理'])
      + '<div class="row" style="gap:8px; margin-bottom:8px; flex-wrap:wrap"><label class="field">対象月<select id="ib-ym">' + RW_MONTHS().map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select></label>'
      + '<span class="note">請求 ' + list.length + '件・合計 <b>' + yen0(sum) + '</b>（税込み）' + (d.batch.sentAt ? '・経理部へ送付 ' + dt(d.batch.sentAt) : '') + (d.batch.doneAt ? '・請求完了 ' + dt(d.batch.doneAt) : '') + '</span></div>'
      + '<div id="ib-flow"><p class="loading">今の状況を集計しています…</p></div>'
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">請求者</th><th class="c-ctr">状態</th><th class="c-num">請求金額</th><th class="c-ctr">請求日</th><th class="c-ctr">経理部へ送付</th><th class="c-txt">操作</th></tr></thead><tbody>'
      + list.map((v, i) => { const st = INV_STATUS[v.status] || [v.status, 'off']; return '<tr><td class="c-txt"><b>' + esc(v.name) + '</b>' + (v.company ? '<br><span class="note">' + esc(v.company) + '</span>' : '') + '</td><td class="c-ctr"><span class="pill ' + st[1] + '">' + (v.status === 'finance_returned' ? '経理部から差し戻し' : st[0]) + '</span></td><td class="c-num">' + yen0(v.total) + '</td><td class="c-ctr">' + esc(String(v.issueDate || '').slice(5).replace('-', '/')) + '</td><td class="c-ctr">' + (v.sentAt ? dt(v.sentAt) : '—') + '</td><td class="c-txt"><button class="btn sm" type="button" data-ibv="' + i + '">請求書</button></td></tr>'; }).join('')
      + (list.length ? '' : '<tr><td colspan="6" class="c-txt"><span class="note">まだ請求はありません</span></td></tr>') + '</tbody></table></div>'
      + (d.unrequested.length ? '<p class="note">まだ請求していない契約中の人（' + d.unrequested.length + '人）：' + d.unrequested.map(c => esc(c.name) + (c.email ? '' : '（メール未登録）')).join('、') + '</p>' : '')
      + '<p class="err" id="ib-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px">'
      + (wait.length ? '<span class="note" style="margin-right:auto">確認待ちが ' + wait.length + '件あります（請求担当の確認が終わると押せます）</span>' : '')
      + '<button class="btn primary" type="button" id="ib-send"' + (wait.length || !unsent.length ? ' disabled' : '') + '>' + (d.batch.sentAt ? '修正分を経理部へ送る（' + unsent.length + '件）' : '請求完了（経理部へ送る・' + unsent.length + '件）') + '</button></div>'
      + '<div style="margin-top:10px">' + finFlowHtml(ym).replace('<details class="iff-wrap" open>', '<details class="iff-wrap">') + '</div>'   /* デモの番号が分かるように流れの図（たたんだ状態） */
      + '<div class="ibd"><div class="ibd-h">デモを送る <span class="note">件名に【デモ】が付きます。何も保存せず、状態も変わりません。番号は流れの図のステップです</span></div><table class="am-table ibd-table"><thead><tr><th class="c-txt">流れ</th><th class="c-txt">送るメール</th><th class="c-txt">宛先</th><th></th></tr></thead><tbody>'
      + [['ib-demo', '①〜⑤', '各ステップのお知らせの見本（請求が届いた・確認完了・差し戻し・要対応・未請求・修正の指摘・請求完了）＋ ③ 経理部へのメール（全員分の PDF 添付）', '日比野さん'], ['ib-demo-fin', '③', '経理部へ送るメール（全員分の PDF 添付）', 'corporate_finance@best-24.jp（CC 日比野さん）'], ['ib-demo-done', '⑥', '報酬確認完了のメール（全員分の PDF 添付）', '日比野さん'], ['ib-demo-ricoh', '⑥', '報酬確認完了のメール（PDF は1件だけ）', 'リコー（CC corporate_finance@・日比野さん）＝本番と同じ宛先']].map(([id, st, what, to]) => '<tr><td class="c-txt"><span class="ibd-step">' + st + '</span></td><td class="c-txt">' + what + '</td><td class="c-txt">' + to + '</td><td class="c-ctr"><button class="btn sm" type="button" id="' + id + '">デモを送る</button></td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note">「請求完了」を押すと、finance@best-24.jp へ（CC marketing@best-24.jp）請求者の一覧と金額を本文に書き、全員分の請求書 PDF を添付して送ります（1通10件まで。多いときは分けて送ります）。経理部が確認して修正がなければ「請求完了」になり、marketing@ にお知らせが届きます。あわせて「【BEST MEDIA】◯年◯月分 報酬確認完了」のメール（全員分の請求書 PDF を添付）を best_428375157506@mj.na.smart-integration.ricoh.com へ（CC corporate_finance@best-24.jp・日比野さん）送ります。</p>';
    $('ib-ym').onchange = ev => { state.invYm = ev.target.value; render(); };
    drawInvFlow(ym, list).catch(e => { if ($('ib-flow')) $('ib-flow').innerHTML = '<p class="err">状況の図を作れませんでした：' + esc(e.message) + '</p>'; });
    document.querySelectorAll('[data-ibv]').forEach(b => b.onclick = () => invViewModal(list[Number(b.dataset.ibv)]));
    // デモ（2026-10-29 ユーザー指定）：契約中の全員（メール・アカウントがない人も）を、この月の担当記事から計算して、日比野さん宛てに【デモ】で送る。保存しない
    const demo = async fin => {
      const btn = $(fin === 'ricoh' ? 'ib-demo-ricoh' : fin === 'done' ? 'ib-demo-done' : fin ? 'ib-demo-fin' : 'ib-demo'), label = btn.textContent;
      if (fin === 'ricoh' ? !confirm(ymJp(ym) + '分の「報酬確認完了」のメールのデモを、本番と同じ宛先に送ります。\nTo：best_428375157506@mj.na.smart-integration.ricoh.com\nCC：corporate_finance@best-24.jp・日比野さん\n・件名に【デモ】、請求書 PDF は1件だけ添付します（保存はしません）\nよろしいですか？') : fin === 'done' ? !confirm(ymJp(ym) + '分の「報酬確認完了」のメールのデモを、日比野さん宛てに送ります（件名に【デモ】、全員分の請求書 PDF を添付。保存はしません）。よろしいですか？') : !confirm(ymJp(ym) + '分のデモを送ります。\n・契約中の全員（メール・アカウントがない人も）の請求書を、この月の担当記事から作ります\n' + (fin ? '・経理部へのメール（PDF 添付）を、corporate_finance@best-24.jp に送ります（CC 日比野さん、件名に【デモ】）\n' : '・経理部へのメール（PDF 添付）と、各お知らせの見本を、日比野さん宛てにだけ送ります（件名に【デモ】）\n') + '・何も保存しません\nよろしいですか？')) return;
      btn.disabled = true; btn.textContent = '作っています…';
      try {
        await loadItems();
        const cs = (await loadContracts()).contracts.filter(c => c.active && c.category !== 'site');
        await loadTimesheets(cs, ym);
        const done = ITEMS.filter(r => paidIn(r, ym));
        const invoices = cs.map(c => { const r = invItemsByMedia(c, ym, done); return { contractId: c.id, items: r.items, remarks: invRemarks(c, r.x) }; }).filter(x => x.items.length);
        const r = await apiSend('POST', '/invoices-demo', { ym, invoices, to: fin === 'ricoh' ? 'done_ricoh' : fin === 'done' ? 'done' : fin ? 'finance' : 'me' });
        alert('デモを送りました。\n対象：' + r.people + '人（うちメール未登録 ' + r.noEmail + '人）・合計 ' + yen0(r.total) + '\nメール：' + r.mails + '通（' + (fin === 'ricoh' ? '報酬確認完了・リコー宛て・CC corporate_finance@ と日比野さん。添付1件' : fin === 'done' ? '報酬確認完了・日比野さん宛て' : fin ? 'corporate_finance@best-24.jp 宛て・CC 日比野さん' : '日比野さん宛て') + '）');
      } catch (e) { alert('デモを送れませんでした：' + e.message); }
      btn.disabled = false; btn.textContent = label;
    };
    $('ib-demo').onclick = () => demo(false);
    $('ib-demo-fin').onclick = () => demo(true);
    $('ib-demo-done').onclick = () => demo('done');
    $('ib-demo-ricoh').onclick = () => demo('ricoh');
    $('ib-send').onclick = async () => {
      if (!confirm(unsent.length + '件の請求書を finance@best-24.jp へ送ります（CC marketing@best-24.jp）。よろしいですか？')) return;
      $('ib-send').disabled = true;
      try { const r = await apiSend('POST', '/invoices-batch/' + ym + '/send', {}); toast(r.sent + '件を経理部へ送りました（メール ' + r.mails + '通）'); render(); } catch (e) { $('ib-err').textContent = e.message; $('ib-err').hidden = false; $('ib-send').disabled = false; }
    };
  } };
}
/** 経理部：送られてきた請求の確認。修正があれば人ごとに指摘、なければ「全員分の確認が完了」 */
/** 経理部確認：請求から完了・リコーへの取り込みまでの流れの図（2026-10-30 ユーザー指定） */
function finFlowHtml(ym) {
  const nx = ymJp(shiftMonth(ym, 1)).replace(/^\d+年/, '');
  const steps = [
    ['1', '請求者（業務委託）', '請求する', ymJp(ym).replace(/^\d+年/, '') + '3日〜' + nx + '2日に、ダッシュボードから請求書を作って送る', '', [['請求したとき', 'メインの請求担当（CC サブ。未設定なら marketing@）', '◯◯さんから◯月分の請求が届きました'], ['翌月3日 0:00・未請求のとき', '請求者（一覧は marketing@）', '◯月分の請求がまだ届いていません']]],
    ['2', '請求担当（BEST社員）', '内容を確認', '「完了」か「差し戻し」。差し戻すと請求者が直して出し直す', '', [['完了', '請求者', '◯月分の請求：確認が完了しました'], ['差し戻し', '請求者', '◯月分の請求：差し戻しがあります'], ['全員の確認が終わったとき', '日比野さん', '【BEST MEDIA】◯月分の請求：請求担当の確認がすべて完了しました'], ['平日2日放置・毎朝9時', 'メインの請求担当（CC サブ・marketing@）', '【要対応】◯◯さんの請求が確認されていません']]],
    ['3', 'BEST MEDIA 管理者', '経理部へ送る', '全員の確認が終わったら「請求完了」を押す', '', [['請求完了', 'finance@best-24.jp（CC marketing@）', '【BEST MEDIA】◯月分 業務委託の請求（全員分の PDF 添付）']]],
    ['4', '経理部', '内容を確認', 'この画面で請求書を確認。直してほしいときは「請求書・指摘」から修正を指摘', 'iff-me', [['修正を指摘', 'メインの請求担当（CC サブ）', '経理部から◯◯さんの請求に修正の指摘があります']]],
    ['5', '経理部', '確認が完了', '修正がなければ「全員分の確認が完了（修正なし）」を押す', 'iff-me', [['確認が完了', 'marketing@best-24.jp', '【BEST MEDIA】◯月分の請求が完了しました']]],
    ['6', '自動でメール', 'リコーへ取り込み', '⑤を押すと同時に送られ、リコーに取り込まれる', 'iff-end', [['⑤と同時', 'best_428375157506@mj.na.smart-integration.ricoh.com（CC corporate_finance@・日比野さん）', '【BEST MEDIA】◯月分 報酬確認完了（全員分の PDF 添付）']]],
  ];
  return '<details class="iff-wrap" open><summary>請求から完了・リコーへの取り込みまでの流れ</summary><div class="iff">'
    + steps.map(([n, who, what, note, cls, mails], i) => (i ? '<div class="iff-ar" aria-hidden="true">→</div>' : '') + '<div class="iff-step ' + cls + '"><div class="iff-n">' + n + '</div><div class="iff-who">' + who + '</div><div class="iff-what">' + what + '</div><div class="iff-note">' + note + '</div>'
      + (mails || []).map(([when, to, subj]) => '<div class="iff-mail"><div class="iff-mail-h">✉ ' + when + '</div><div><span class="iff-k">宛先</span>' + to + '</div><div><span class="iff-k">件名</span>' + subj + '</div></div>').join('') + '</div>').join('')
    + '</div><p class="note iff-back">↩ 経理部が修正を指摘したとき：④ → 請求担当にメール → 請求担当が請求者に差し戻し → 請求者が出し直し → ② 確認 → ③ 管理者が「修正分を経理部へ送る」→ ④ もう一度確認。経理部の作業は ④⑤（緑の枠）です。✉ はその時に自動で送られるメール（送信元はすべて BEST MEDIA &lt;marketing@best-24.jp&gt;）です。</p></details>';
}
function viewInvFinance() {
  const ym = state.invYm = state.invYm || shiftMonth(CUR_MONTH, -1);
  return { html: '<section class="panel" id="if-body"><p class="loading">読み込み中…</p></section>', view: '経理部確認', after: async () => {
    const bn = await loadBestNo();
    const d = await api('/invoices-batch/' + ym), list = d.invoices.filter(v => v.sentAt || ['finance_returned', 'done'].includes(v.status)).sort((a, b) => String(a.name).localeCompare(b.name, 'ja'));
    const sum = list.reduce((a, v) => a + (v.total || 0), 0), pending = list.filter(v => v.status === 'finance_returned'), canDone = list.length && !pending.length && list.some(v => v.status === 'finance');
    $('if-body').innerHTML = H('経理部確認 <small>' + ymJp(ym) + '分</small>', [])
      + finFlowHtml(ym)
      + '<div class="row" style="gap:8px; margin-bottom:8px; flex-wrap:wrap"><label class="field">対象月<select id="if-ym">' + RW_MONTHS().map(m => '<option value="' + m + '"' + (m === ym ? ' selected' : '') + '>' + mLabel(m) + '</option>').join('') + '</select></label><span class="note">' + list.length + '件・合計 <b>' + yen0(sum) + '</b>（税込み）' + (d.batch.doneAt ? '・請求完了 ' + dt(d.batch.doneAt) : '') + '</span></div>'
      /* 合計のサマリ（2026-10-30 ユーザー指定） */
      + '<div class="kpis rwp-kpis">' + [['請求の件数', list.length + '件'], ['小計（税抜き）', yen0(list.reduce((a, v) => a + (v.subtotal || 0), 0))], ['消費税', yen0(list.reduce((a, v) => a + (v.tax || 0), 0))], ['源泉所得税', '−' + yen0(list.reduce((a, v) => a + (v.withholding || 0), 0))], ['請求金額（税込み）', yen0(sum)]].map(([l, v]) => '<div class="kpi"><span>' + mLabel(ym) + 'の' + l + '</span><b>' + v + '</b></div>').join('') + '</div>'
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">請求者</th><th class="c-ctr">状態</th><th class="c-num">小計（税抜き）</th><th class="c-num">消費税</th><th class="c-num">源泉所得税</th><th class="c-num">請求金額</th><th class="c-ctr">支払期日</th><th class="c-txt">操作</th></tr></thead><tbody>'
      + list.map((v, i) => '<tr><td class="c-txt"><b>' + esc(v.name) + '</b>' + (v.company ? '<br><span class="note">' + esc(v.company) + '</span>' : '') + '</td><td class="c-ctr"><span class="pill ' + (v.status === 'done' ? 'ok' : v.status === 'finance_returned' ? 'ng' : 'wait') + '">' + (v.status === 'done' ? '請求完了' : v.status === 'finance_returned' ? '修正の指摘中' : '確認中') + '</span></td><td class="c-num">' + yen0(v.subtotal) + '</td><td class="c-num">' + yen0(v.tax) + '</td><td class="c-num">' + (v.withholding ? '−' + yen0(v.withholding) : '—') + '</td><td class="c-num"><b>' + yen0(v.total) + '</b></td><td class="c-ctr">' + esc(String(v.dueDate || '').slice(5).replace('-', '/')) + '</td><td class="c-txt"><button class="btn sm" type="button" data-ifv="' + i + '">請求書・指摘</button></td></tr>').join('')
      + (list.length ? '' : '<tr><td colspan="8" class="c-txt"><span class="note">まだ送られてきた請求はありません</span></td></tr>') + '</tbody></table></div>'
      + '<p class="err" id="if-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px">' + (pending.length ? '<span class="note" style="margin-right:auto">修正の指摘中が ' + pending.length + '件あります（直したものが届くと押せます）</span>' : '') + '<button class="btn primary" type="button" id="if-done"' + (canDone ? '' : ' disabled') + '>全員分の確認が完了（修正なし）</button></div>'
      + '<p class="note">修正が必要な請求は「請求書・指摘」から、直してほしいところを書いて送ってください。その人の請求担当（BEST社員）に届き、請求担当が請求者に差し戻します。</p>';
    $('if-ym').onchange = ev => { state.invYm = ev.target.value; render(); };
    /* 対象月の下に BEST の登録番号（変えられるのは管理者と経理部だけ。2026-10-30 ユーザー指定） */
    $('if-ym').closest('.row').insertAdjacentHTML('afterend', '<div class="row" style="gap:8px; margin-bottom:10px; align-items:flex-end; flex-wrap:wrap"><label class="field">BEST の登録番号（インボイス番号）<input id="if-bestno" value="' + esc(bn.no || '') + '" placeholder="T1234567890123" maxlength="14" style="width:180px"' + (bn.canEdit ? '' : ' disabled') + '></label>'
      + (bn.canEdit ? '<button class="btn sm" type="button" id="if-bestno-save">保存</button><span class="note" id="if-bestno-msg">変えると全員の請求書（画面・PDF）の登録番号が変わります</span>' : '<span class="note">変えられるのは管理者と経理部だけです</span>') + '</div>');
    if ($('if-bestno-save')) $('if-bestno-save').onclick = async () => {
      const no = $('if-bestno').value.trim(); if (!confirm('BEST の登録番号を「' + (no || '（空欄）') + '」にします。全員の請求書の登録番号が変わります。よろしいですか？')) return;
      try { const r = await apiSend('PUT', '/invoice-best-no', { no }); BEST_INV_NO = r.no; $('if-bestno').value = r.no; $('if-bestno-msg').textContent = '保存しました'; } catch (e) { $('if-bestno-msg').textContent = '保存できませんでした：' + e.message; }
    };
    document.querySelectorAll('[data-ifv]').forEach(b => b.onclick = () => { const v = list[Number(b.dataset.ifv)], can = v.status === 'finance';
      invViewModal(v, can ? '<h3 class="am-h">修正の指摘</h3><textarea id="if-note" rows="2" style="width:100%" placeholder="直してほしいところ"></textarea><p class="err" id="if-err2" hidden></p><div class="row" style="justify-content:flex-end; margin-top:6px"><button class="btn" type="button" id="if-ret">修正を指摘する（請求担当へ）</button></div>' : '');
      if (can) $('if-ret').onclick = async () => { const note = $('if-note').value.trim(); if (!note) { $('if-err2').textContent = '直してほしいところを入力してください'; $('if-err2').hidden = false; return; } if (!confirm(v.name + ' さんの請求に修正を指摘します。請求担当にメールでお知らせします。よろしいですか？')) return; try { await apiSend('POST', '/invoices/' + encodeURIComponent(v.id) + '/finance-return', { note }); closeModal(); toast('指摘しました'); render(); } catch (e) { $('if-err2').textContent = e.message; $('if-err2').hidden = false; } }; });
    $('if-done').onclick = async () => { if (!confirm(ymJp(ym) + '分の全員分の確認を完了にします（修正なし）。marketing@ にお知らせし、全員分の請求書 PDF を添付した「報酬確認完了」のメールを送ります。よろしいですか？')) return; try { const r = await apiSend('POST', '/invoices-batch/' + ym + '/finance-done', {}); toast(r.done + '件を請求完了にしました'); render(); } catch (e) { $('if-err').textContent = e.message; $('if-err').hidden = false; } };
  } };
}
/** 印刷・PDF（ブラウザの印刷で「PDFに保存」） */
function printInvoice(v) {
  const w = window.open('', '_blank'); if (!w) { alert('ポップアップがブロックされました。許可してからもう一度押してください'); return; }
  w.document.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>請求書_' + esc(v.name) + '_' + v.ym + '</title><style>' + INV_CSS + '@page{size:A4;margin:16mm}body{margin:0;font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",sans-serif;color:#111}.note{color:#666;font-size:11px}</style></head><body>' + invoiceDocHtml(v) + '<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>');
  w.document.close();
}
const INV_CSS = '.inv-doc{max-width:760px;margin:0 auto;font-size:13px;line-height:1.6}.inv-doc h1{text-align:center;letter-spacing:.5em;font-size:22px;margin:0 0 16px}.inv-top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.inv-to{font-size:16px;border-bottom:1px solid currentColor;padding-bottom:2px}.inv-sum{font-size:15px}.inv-sum b{font-size:20px}.inv-from{text-align:right}.inv-from p,.inv-top p{margin:2px 0}.inv-addr{white-space:pre-wrap}.inv-table{width:100%;border-collapse:collapse;margin:14px 0}.inv-table th,.inv-table td{border:1px solid #999;padding:5px 8px}.inv-table th{background:rgba(0,0,0,.06)}.inv-table .num{text-align:right;white-space:nowrap}.inv-table tfoot td{text-align:right}.inv-total td{font-weight:700;font-size:15px}.inv-bank{border:1px solid #999;padding:8px 10px;display:inline-block;min-width:280px}.inv-bestno{border:1px solid #999;padding:2px 8px;display:inline-block;min-width:240px;font-size:12px}';

/** 業務委託の本人：「報酬」の上に、請求できる月の請求 */
async function drawInvoicePanel(box, cs, preview) {
  let r;
  try { r = preview ? { today: todayJst(), invoices: [].concat(...await Promise.all([shiftMonth(CUR_MONTH, -2), shiftMonth(CUR_MONTH, -1), CUR_MONTH].map(m => api('/invoices?ym=' + m).then(x => x.invoices || []).catch(() => [])))).filter(v => cs.some(c => c.id === v.contractId)) } : await api('/invoices/mine'); }   /* 操作画面確認：BEST社員が見られる請求から */
  catch (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
  const today = r.today || todayJst(), invs = r.invoices || [];
  const months = [shiftMonth(CUR_MONTH, -1), CUR_MONTH];
  const rows = [];
  cs.forEach(c => months.forEach(ym => { const v = invs.find(x => x.contractId === c.id && x.ym === ym), w = invWindow(ym, today); if (v || w === 'open' || w === 'late') rows.push({ c, ym, v, w }); }));
  box.innerHTML = H('請求 <small>' + (rows.length ? '請求できる月と、請求の状態' : '') + '</small>', ['契約管理'])
    + (rows.length ? '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">月</th>' + (cs.length > 1 ? '<th class="c-txt">契約</th>' : '') + '<th class="c-txt">請求の期間</th><th class="c-ctr">状態</th><th class="c-num">請求金額</th><th class="c-txt">操作</th></tr></thead><tbody>'
      + rows.map((x, i) => { const st = x.v ? INV_STATUS[x.v.status] || [x.v.status, 'off'] : null;
        return '<tr><td class="c-txt"><b>' + ymJp(x.ym) + '分</b></td>' + (cs.length > 1 ? '<td class="c-txt">' + esc(x.c.position || '') + '</td>' : '') + '<td class="c-txt">' + Number(x.ym.slice(5)) + '/3〜' + Number(shiftMonth(x.ym, 1).slice(5)) + '/2' + (x.w === 'late' && !x.v ? ' <span class="pill ng">期日を過ぎています（' + Number(shiftMonth(x.ym, 1).slice(5)) + '/4まで）</span>' : '') + '</td>'
          + '<td class="c-ctr">' + (st ? '<span class="pill ' + st[1] + '">' + st[0] + '</span>' : '<span class="note">未請求</span>') + '</td><td class="c-num">' + (x.v ? yen0(x.v.total) : '—') + '</td>'
          + '<td class="c-txt">' + (!x.v ? '<button class="btn primary sm" type="button" data-invnew="' + i + '">請求書を作成</button>' : x.v.status === 'returned' ? '<button class="btn primary sm" type="button" data-invnew="' + i + '">直して出し直す</button> ' : '') + (x.v ? '<button class="btn sm" type="button" data-invview="' + i + '">請求書を見る・PDF</button>' : '') + '</td></tr>'
          + (x.v && x.v.status === 'returned' ? '<tr><td colspan="6" class="c-txt"><span class="err">差し戻し（' + esc(x.v.returnedBy || '') + '）：' + esc(x.v.returnNote || '') + '</span></td></tr>' : ''); }).join('') + '</tbody></table></div>'
      : '<p class="empty">今月、請求できる記事はありません。このWEBアプリでの請求は' + ymJp(INVOICE_START) + '分（' + Number(INVOICE_START.slice(5)) + '/3〜' + Number(shiftMonth(INVOICE_START, 1).slice(5)) + '/2）からが対象です。</p>')
    + '<p class="note">請求は1か月に1回です。その月の3日〜翌月2日に請求してください（翌月3日・4日は理由を入れれば受け付け、5日以降は受け付けません）。請求したあとに完了した記事は、翌月分の請求に入ります。</p>';
  box.querySelectorAll('[data-invview]').forEach(b => b.onclick = () => { const x = rows[Number(b.dataset.invview)]; invViewModal(x.v); });
  box.querySelectorAll('[data-invnew]').forEach(b => b.onclick = async () => { const x = rows[Number(b.dataset.invnew)]; await loadTimesheets([x.c], x.ym); invFormModal(x.c, x.ym, invs, x.v, x.w, preview); });
}
function invViewModal(v, actions) {
  wideModal('<h2>' + ymJp(v.ym) + '分の請求書 <span class="pill ' + (INV_STATUS[v.status] || ['', 'off'])[1] + '">' + (INV_STATUS[v.status] || [v.status])[0] + '</span></h2>' + invoiceDocHtml(v)
    + (v.lateReason ? '<p class="note">期日を過ぎた理由：' + esc(v.lateReason) + '</p>' : '')
    + ((v.history || []).length ? '<h3 class="am-h">記録</h3><ul class="inv-hist">' + v.history.map(h => '<li>' + dt(h.at) + '　' + esc(h.by || '') + '：' + esc(h.action || '') + (h.note ? '「' + esc(h.note) + '」' : '') + '</li>').join('') + '</ul>' : '')
    + (v.financeNote && v.status === 'finance_returned' ? '<p class="err">経理部からの指摘：' + esc(v.financeNote) + '</p>' : '')
    + (actions || '') + '<div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px">' + (v.id && !(isOutUser() && String(v.ym || '') < INVOICE_START) ? '<button class="btn" type="button" id="inv-pdf">PDF をダウンロード</button>' : '') + (isOutUser() && String(v.ym || '') < INVOICE_START ? '' : '<button class="btn" type="button" id="inv-print">印刷</button>') + '<button class="btn" type="button" data-close>閉じる</button></div>');
  if ($('inv-print')) $('inv-print').onclick = () => printInvoice(v);   /* 業務委託の人は 2026年11月分から（2026-10-31 ユーザー指定） */
  if ($('inv-pdf')) $('inv-pdf').onclick = () => invPdf(v);
}
const JP_PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
/** 入力の1行（項目名の右に必須の「*」） */
const afRow = (label, req, input, key) => '<div class="af-row" data-af="' + key + '"><div class="af-lbl">' + label + (req ? '<span class="af-req">*</span>' : '<span class="note">（任意）</span>') + '</div><div class="af-in">' + input + '</div></div>';
/** 請求書を作る（金額は自動。その他の項目・住所・振込先・遅れた理由を入れて、確認してから請求） */
function invFormModal(c, ym, invs, cur, win, preview) {
  const { x, items: auto } = invItemsByMedia(c, ym, invDone(c, ym, invs));
  const last = invs.filter(v => v.contractId === c.id && v.bank).sort((a, b) => String(b.ym).localeCompare(a.ym))[0];
  const st = { others: ((cur && cur.items) || []).filter(i => i.kind === 'other').map(i => ({ label: i.label, qty: i.qty, unit: i.unit })), bank: Object.assign({ type: '普通' }, (cur && cur.bank) || {}), addr: Object.assign({}, (cur && cur.addr) || {}), lateReason: (cur && cur.lateReason) || '' };
  const addrText = () => { const a = st.addr, z = String(a.zip || '').replace(/[^\d]/g, ''); return (z ? '〒' + z.slice(0, 3) + '-' + z.slice(3) + '\n' : '') + (a.pref || '') + (a.city || '') + (a.street || '') + (a.building ? '\n' + a.building : ''); };
  const items = () => auto.concat(st.others.filter(o => o.label && Number(o.qty) > 0).map(o => ({ kind: 'other', label: o.label, qty: Number(o.qty), unit: Number(o.unit) || 0 })));
  const remarks = invRemarks(c, x);
  const draft = () => ({ ym, name: c.name, entity: c.entity, company: c.company, invoiceNo: c.invoice, address: addrText(), bank: st.bank, items: items(), issueDate: todayJst(), dueDate: invDue(ym), remarks });
  const read = () => { const q = s => document.querySelector(s); st.addr.zip = (q('#iv-a-zip1').value + q('#iv-a-zip2').value).replace(/[^\d]/g, ''); ['pref', 'city', 'street', 'building'].forEach(k => { st.addr[k] = q('#iv-a-' + k).value.trim(); }); ['bankName', 'branch', 'type', 'number', 'holder'].forEach(k => { st.bank[k] = q('#iv-b-' + k).value.trim(); }); if (q('#iv-late')) st.lateReason = q('#iv-late').value.trim(); st.others = [...document.querySelectorAll('[data-oth]')].map(tr => ({ label: tr.querySelector('[data-f="label"]').value.trim(), qty: tr.querySelector('[data-f="qty"]').value, unit: tr.querySelector('[data-f="unit"]').value })); };
  const draw = () => {
    const t = invTotals(items(), c.entity), late = win === 'late' && !(cur && cur.status === 'returned');
    wideModal((preview ? '<p class="fb-news">確認用の画面です（' + esc(c.name) + ' さんに見えている形）。入力しても請求はできません。</p>' : '') + '<h2>' + ymJp(ym) + '分の請求書を作成 <small class="note">' + esc(c.name) + '</small></h2>'
      + '<h3 class="am-h">請求の内容 <span class="note">報酬管理の計算から自動で入ります（直せません）。足りない記事は、進行管理を直してもらってから請求してください</span></h3>'
      + '<div class="table-wrap"><table class="am-table"><thead><tr><th class="c-txt">内容</th><th class="c-num">数量</th><th class="c-num">単価</th><th class="c-num">金額</th><th></th></tr></thead><tbody>'
      + auto.map(i => '<tr><td class="c-txt">' + esc(i.label) + '</td><td class="c-num">' + nf.format(i.qty) + esc(i.unitLabel || '') + '</td><td class="c-num">' + yen0(i.unit) + '</td><td class="c-num">' + yen0(Math.round(i.qty * i.unit)) + '</td><td></td></tr>').join('')
      + st.others.map((o, k) => '<tr data-oth="' + k + '"><td class="c-txt"><input data-f="label" value="' + esc(o.label) + '" placeholder="内容（例：イレギュラー対応）" style="width:100%"></td><td class="c-num"><input data-f="qty" type="number" min="0" step="0.25" value="' + esc(String(o.qty ?? '')) + '" style="width:6em"></td><td class="c-num"><input data-f="unit" type="number" min="0" value="' + esc(String(o.unit ?? '')) + '" style="width:8em"></td><td class="c-num">' + yen0(Math.round((Number(o.qty) || 0) * (Number(o.unit) || 0))) + '</td><td><button class="linkbtn" type="button" data-othdel="' + k + '">×</button></td></tr>').join('')
      + (auto.length + st.others.length ? '' : '<tr><td colspan="5" class="c-txt"><span class="note">' + mLabel(ym) + 'に完了した担当記事がありません</span></td></tr>')
      + '</tbody><tfoot><tr><td class="c-txt" colspan="3">小計（税抜き）／消費税10%' + (c.entity === '個人' ? '／源泉所得税' : '') + '</td><td class="c-num">' + yen0(t.subtotal) + '／' + yen0(t.tax) + (c.entity === '個人' ? '／−' + yen0(t.withholding) : '') + '</td><td></td></tr><tr><td class="c-txt" colspan="3"><b>ご請求金額</b></td><td class="c-num"><b>' + yen0(t.total) + '</b></td><td></td></tr></tfoot></table></div>'
      + '<button class="btn sm" type="button" id="iv-oth-add">＋ その他の項目を追加</button>' + (c.entity ? '' : ' <span class="err">契約管理で「個人／企業」が入っていません。BEST に連絡してください</span>')
      + '<h3 class="am-h">請求者の住所 <span class="note">請求書に載ります。<span class="af-req">*</span> は必須</span></h3><div class="af">'
      + afRow('郵便番号', true, '<input id="iv-a-zip1" class="af-zip1" inputmode="numeric" maxlength="3" placeholder="例) 220" value="' + esc(String(st.addr.zip || '').replace(/[^\d]/g, '').slice(0, 3)) + '"><span class="af-dash">−</span><input id="iv-a-zip2" class="af-zip2" inputmode="numeric" maxlength="4" placeholder="例) 0004" value="' + esc(String(st.addr.zip || '').replace(/[^\d]/g, '').slice(3, 7)) + '"><span class="note" id="iv-zip-msg"></span>', 'zip')
      + afRow('都道府県', true, '<select id="iv-a-pref" class="af-pref"><option value="">都道府県</option>' + JP_PREFS.map(p => '<option' + (p === st.addr.pref ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>', 'pref')
      + afRow('市区町村', true, '<input id="iv-a-city" placeholder="例）横浜市西区北幸" value="' + esc(st.addr.city || '') + '">', 'city')
      + afRow('丁目・番地', true, '<input id="iv-a-street" placeholder="例）2-15-10" value="' + esc(st.addr.street || '') + '">', 'street')
      + afRow('建物名・部屋番号', false, '<input id="iv-a-building" placeholder="例）○○マンション101号" value="' + esc(st.addr.building || '') + '">', 'building') + '</div>'
      + '<h3 class="am-h">お振込先 ' + (last ? '<button class="btn sm" type="button" id="iv-copy">' + ymJp(last.ym) + '分からコピー</button>' : '') + '</h3><div class="af">'
      + afRow('銀行名', true, '<input id="iv-b-bankName" placeholder="例）〇〇銀行" value="' + esc(st.bank.bankName || '') + '">', 'bankName')
      + afRow('支店名', true, '<input id="iv-b-branch" placeholder="例）本店" value="' + esc(st.bank.branch || '') + '">', 'branch')
      + afRow('種別', true, '<select id="iv-b-type" class="af-pref"><option' + (st.bank.type !== '当座' ? ' selected' : '') + '>普通</option><option' + (st.bank.type === '当座' ? ' selected' : '') + '>当座</option></select>', 'type')
      + afRow('口座番号', true, '<input id="iv-b-number" class="af-num" inputmode="numeric" maxlength="8" placeholder="例）1234567" value="' + esc(st.bank.number || '') + '">', 'number')
      + afRow('口座名義（カナ）', true, '<input id="iv-b-holder" placeholder="例）ベスト タロウ" value="' + esc(st.bank.holder || '') + '">', 'holder') + '</div>'
      + (late ? '<h3 class="am-h" style="color:var(--bad)">期日（' + Number(shiftMonth(ym, 1).slice(5)) + '/2）を過ぎた理由（必須）</h3><textarea id="iv-late" rows="2" style="width:100%">' + esc(st.lateReason) + '</textarea>' : '')
      + '<p class="err" id="iv-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px"><button class="btn" type="button" data-close>やめる</button><button class="btn primary" type="button" id="iv-next">確認へ</button></div>');
    document.querySelectorAll('[data-oth] input').forEach(el => el.onchange = () => { read(); draw(); });
    document.querySelectorAll('[data-othdel]').forEach(b => b.onclick = () => { read(); st.others.splice(Number(b.dataset.othdel), 1); draw(); });
    $('iv-oth-add').onclick = () => { if (!confirm('事前にBESTとすり合わせはできていますか？\n（その他の項目は、BEST とすり合わせ済みのものだけ追加してください）')) return; read(); st.others.push({ label: '', qty: 1, unit: '' }); draw(); };
    if ($('iv-copy')) $('iv-copy').onclick = () => { read(); st.bank = Object.assign({}, last.bank); if (!st.addr.zip && last.addr) st.addr = Object.assign({}, last.addr); draw(); };
    // 郵便番号から都道府県・市区町村
    const zipLook = async () => { const z = ($('iv-a-zip1').value + $('iv-a-zip2').value).replace(/[^\d]/g, ''); if (z.length !== 7) return; const msg = $('iv-zip-msg'); msg.textContent = '住所を調べています…';
      try { const r = await api('/zip/' + z); $('iv-a-pref').value = r.pref; $('iv-a-city').value = r.city; msg.textContent = '自動で入れました'; $('iv-a-street').focus(); } catch (e) { msg.textContent = e.message; } };
    $('iv-a-zip1').oninput = ev => { if (ev.target.value.replace(/[^\d]/g, '').length === 3) $('iv-a-zip2').focus(); zipLook(); };
    $('iv-a-zip2').oninput = zipLook;
    $('iv-next').onclick = () => {
      read(); const err = m => { $('iv-err').textContent = m; $('iv-err').hidden = false; };
      if (!items().length) return err('請求する項目がありません');
      if (st.others.some(o => !o.label || !(Number(o.qty) > 0) || !(Number(o.unit) >= 0))) return err('その他の項目の内容・数量・単価を入れてください（使わない行は×で消してください）');
      { const miss = ['zip', 'pref', 'city', 'street'].filter(k => !st.addr[k] || (k === 'zip' && st.addr.zip.replace(/[^\d]/g, '').length !== 7)); document.querySelectorAll('[data-af]').forEach(el => el.classList.toggle('af-bad', miss.includes(el.dataset.af))); if (miss.length) return err('住所の ' + miss.map(k => ({ zip: '郵便番号（7けた）', pref: '都道府県', city: '市区町村', street: '番地' })[k]).join('・') + ' を入力してください'); }   /* 郵便番号・都道府県・市区町村・番地は必須（2026-10-29 ユーザー指定） */
      { const miss = ['bankName', 'branch', 'number', 'holder'].filter(k => !st.bank[k]); document.querySelectorAll('[data-af]').forEach(el => { if (['bankName', 'branch', 'number', 'holder'].includes(el.dataset.af)) el.classList.toggle('af-bad', miss.includes(el.dataset.af)); }); if (miss.length) return err('お振込先の ' + miss.map(k => ({ bankName: '銀行名', branch: '支店名', number: '口座番号', holder: '口座名義' })[k]).join('・') + ' を入力してください'); }   /* 振込先も必須（2026-10-29 ユーザー指定） */
      if (late && !st.lateReason) return err('期日を過ぎた理由を入力してください');
      wideModal('<h2>内容にお間違いはないですか？</h2>' + invoiceDocHtml(draft()) + (late ? '<p class="note">期日を過ぎた理由：' + esc(st.lateReason) + '</p>' : '')
        + '<p class="err" id="iv-err2" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px"><button class="btn" type="button" id="iv-back">戻って直す</button><button class="btn primary" type="button" id="iv-send">請求する</button></div>');
      $('iv-back').onclick = draw;
      if (preview) { $('iv-send').disabled = true; $('iv-send').textContent = '請求する（確認用のため押せません）'; return; }
      $('iv-send').onclick = async () => {
        $('iv-send').disabled = true;
        const keys = [...new Set(x.mine.map(r => String(r.key)).filter(k => k && k !== 'undefined'))];
        try { await apiSend('POST', '/invoices', { contractId: c.id, ym, items: items(), articles: keys, bank: st.bank, addr: st.addr, lateReason: st.lateReason, remarks }); closeModal(); toast('請求しました。請求担当の確認をお待ちください'); render(); }
        catch (e) { $('iv-err2').textContent = e.message; $('iv-err2').hidden = false; $('iv-send').disabled = false; }
      };
    };
  };
  draw();
}
/** BEST社員：担当者一覧・契約者一覧の請求の確認（完了／差し戻し） */
function invCheckModal(v, onDone) {
  const can = ['checking', 'finance_returned'].includes(v.status);
  invViewModal(v, can ? '<h3 class="am-h">確認</h3><textarea id="ic-note" rows="2" style="width:100%" placeholder="差し戻すときは、直してほしいところを書いてください"></textarea><p class="err" id="ic-err" hidden></p><div class="row" style="justify-content:flex-end; gap:6px; margin-top:6px">' + (v.status === 'checking' ? '<button class="btn primary" type="button" id="ic-ok">完了（経理部へ）</button>' : '') + '<button class="btn" type="button" id="ic-ret">差し戻し</button></div>' : '');
  if (!can) return;
  const go = async action => { const note = $('ic-note').value.trim(); if (action === 'return' && !note) { $('ic-err').textContent = '差し戻しの理由を入力してください'; $('ic-err').hidden = false; return; }
    if (!confirm(action === 'approve' ? 'この請求を「完了」にして経理部の確認に進めます。よろしいですか？' : 'この請求を差し戻します。請求者にメールでお知らせします。よろしいですか？')) return;
    try { await apiSend('POST', '/invoices/' + encodeURIComponent(v.id) + '/' + action, { note }); closeModal(); toast(action === 'approve' ? '完了にしました' : '差し戻しました'); loadInvPending(); onDone(); } catch (e) { $('ic-err').textContent = e.message; $('ic-err').hidden = false; } };
  if ($('ic-ok')) $('ic-ok').onclick = () => go('approve');
  $('ic-ret').onclick = () => go('return');
}

// ================= ブックマーク（2026-10-28 ユーザー指定） =================
// 今の画面（ダッシュボード・メニュー）と、メディア・ディレクトリ・プルダウンなどの表示設定（state）を、ユーザーごとに5つまで保存する
let BOOKMARKS = [];
const BM_MAX = 5;
async function loadBookmarks() { try { BOOKMARKS = (await api('/bookmarks')).bookmarks || []; } catch (e) { BOOKMARKS = []; } drawBookmarks(); }
function drawBookmarks() {
  const box = $('bm-list'); if (!box) return;
  box.hidden = !BOOKMARKS.length;
  box.innerHTML = '<span class="bm-h">ブックマーク</span>' + BOOKMARKS.map((b, i) => '<div class="bm-item"><button type="button" class="bm-go" data-bm="' + i + '" title="' + esc(b.name) + '">' + esc(b.name) + '</button><button type="button" class="bm-del" data-bmdel="' + i + '" aria-label="' + esc(b.name) + ' を削除">×</button></div>').join('');
  box.querySelectorAll('[data-bm]').forEach(x => x.onclick = () => openBookmark(BOOKMARKS[x.dataset.bm]));
  box.querySelectorAll('[data-bmdel]').forEach(x => x.onclick = async () => {
    const b = BOOKMARKS[x.dataset.bmdel]; if (!b || !confirm('「' + b.name + '」のブックマークを削除しますか？')) return;
    try { BOOKMARKS = (await apiSend('PUT', '/bookmarks', { bookmarks: BOOKMARKS.filter(y => y !== b) })).bookmarks; drawBookmarks(); toast('削除しました'); } catch (e) { alert(e.message); }
  });
}
function openBookmark(b) {
  if (!b) return;
  Object.assign(state, JSON.parse(JSON.stringify(b.state || {})));
  if (!allowedDashes().includes(state.dash)) state.dash = allowedDashes()[0] || 'articles';
  $('dash-select').value = state.dash;
  renderNav(); render();
}
async function addBookmark() {
  if (BOOKMARKS.length >= BM_MAX) return alert('ブックマークは' + BM_MAX + 'つまでです。左上の一覧の「×」で不要なものを消してから追加してください。');
  const sub = state.dash === 'articles' && state.artSub ? '／' + state.artSub : '';
  const media = MEDIA_DASHES.includes(state.dash) || CONTENT_NUM_VIEWS.includes(state.view) ? (state.dash === 'rewards' ? '' : '・' + mediaLabel(state.dash === 'articles' ? artMedia() : state.dash === 'revenue' ? revMedia() : state.media) + sub) : ANALYSIS.has(state.view) ? '・' + mediaName(state.media) : '';
  const name = prompt('ブックマークの名前（30文字まで）', (pageTitleText() + media).slice(0, 30));
  if (name == null) return;
  const snap = JSON.parse(JSON.stringify(state));
  try { BOOKMARKS = (await apiSend('PUT', '/bookmarks', { bookmarks: BOOKMARKS.concat([{ name: name.trim() || pageTitleText(), state: snap }]) })).bookmarks; drawBookmarks(); toast('ブックマークしました'); } catch (e) { alert(e.message); }
}

// ================= 起動とログイン =================
async function startApp() {
  $('login').hidden = true; $('waiting').hidden = true; $('app').hidden = false;
  $('user-name').textContent = me.name; $('avatar').textContent = (me.name || '?').slice(0, 1);
  $('content').innerHTML = '<p class="loading">データを読み込んでいます…</p>';
  checkAutomation();
  REAL_ME = me;
  loadBestNo();   /* BEST の登録番号（請求書に載せる） */
  applyMoneyFilter();   /* REsta社員は収益と支出の指標を出さない */
  setupMyContract();   // 自分の契約がある人に「契約内容」ボタン（2026-10-14 ユーザー指定）
  setupMyGoals();   // 社員に「マイページ」ボタン（2026-10-27 ユーザー指定）
  loadBookmarks(); $('bm-add').onclick = addBookmark;
  loadTaskCount(); setInterval(loadTaskCount, 5 * 60 * 1000); checkFeedbackNews();
  loadInvPending(); setInterval(loadInvPending, 5 * 60 * 1000);   // 未対応の請求（2026-10-29）   // タスク通知・改善依頼の結果（2026-10-29）
  const [meta, monthly] = await Promise.all([api('/meta'), me.perms.media !== 'none' ? api('/monthly') : Promise.resolve({})]);
  META = meta; MONTHLY = monthly;
  const ms = new Set(); Object.values(MONTHLY).forEach(o => Object.keys(o).forEach(m => ms.add(m)));
  MONTHS = [...ms].sort();
  $('status-text').textContent = '最終収集 ' + (META.lastRun ? META.lastRun.slice(5).replace('-', '/') : '—') + (META.errors24h ? '（エラーあり）' : ' 正常');
  $('status-dot').style.background = META.errors24h ? 'var(--bad)' : 'var(--good)';
  renderMediaSelect();
  setTimeout(() => expSyncComputed(), 4000);
  setTimeout(() => aiCheckSync(), 9000);   /* 5日をすぎた前月の答え合わせを裏で保存（管理者だけ）（2026-11-05） */   /* 支出の計算値を裏で更新（管理者だけ・12時間ごと）（2026-11-05） */
  api('/system').then(d => { SYSTEM = d; $('app-ver').textContent = 'Ver ' + d.map.version; $('app-ver').title = '更新日 ' + d.map.updated.replace(/-/g, '/') + '（管理 →「システム構造」で更新履歴）'; }).catch(() => {});
  // UI確認（管理者だけ）：役割の一覧
  if (realAdmin()) {
    Promise.all([api('/admin/roles'), api('/admin/users').catch(() => [])]).then(([d, us]) => {
      ROLE_DEF = d;
      /* 利用中でない人（追加済みでまだログインしていない人・承認待ちなど）も出す（2026-10-28 ユーザー指定） */
      PREVIEW_USERS = (us || []).filter(u => (u.uid || u.invite) && u.uid !== REAL_ME.uid).map(u => Object.assign(u, { pv: u.uid || 'invite:' + encodeURIComponent(u.email), on: u.status === 'active' })).sort((a, b) => (b.on - a.on) || String(a.name).localeCompare(String(b.name), 'ja'));
      $('ui-preview-select').innerHTML = '<option value="">通常の画面（管理者）</option><optgroup label="役割ごと">' + d.roles.filter(r => r[0] !== 'admin').map(r => '<option value="' + r[0] + '">' + esc(r[1]) + '</option>').join('') + '</optgroup>'
        + (PREVIEW_USERS.length ? '<optgroup label="人ごと">' + PREVIEW_USERS.map(u => '<option value="u:' + esc(u.pv) + '">' + esc(u.name || u.email) + (u.roleEff ? '（' + esc(roleLabel(u.roleEff)) + '）' : '') + (u.on ? '(利用中)' : '(権限付与なし)') + '</option>').join('') + '</optgroup>' : '');
    }).catch(() => {});
    $('ui-preview-select').onchange = ev => setPreview(ev.target.value);
  }
  /* 構成シートのURL（/app/メディア/outline/記事No）で開いたときは、その構成シートを出す（2026-11-12 ユーザー指定） */
  const olm = location.pathname.match(OUTLINE_PATH);
  if (olm) { state.outline = { slug: olm[1], id: decodeURIComponent(olm[2]) }; state.dash = 'articles'; state.view = 'outline'; }
  render();
}
function showWaiting(u) {
  $('app').hidden = true; $('login').hidden = true; $('waiting').hidden = false;
  $('waiting-email').textContent = u.email;
  if (u.status === 'unregistered') { $('waiting-title').textContent = 'このアカウントは登録されていません'; $('waiting-text').textContent = 'このダッシュボードは、管理者がユーザー管理で追加した人だけが使えます。利用したい場合は、このメールアドレスで追加するよう管理者に依頼してください。'; }
  else if (u.status === 'invited') { $('waiting-title').textContent = 'メールアドレスの確認をお願いします'; $('waiting-text').textContent = 'メールアドレスの確認が済むと使えるようになります。届いたメールのリンクを開いてから、もう一度ログインしてください。'; }
  else if (u.status === 'disabled') { $('waiting-title').textContent = 'このアカウントは停止されています'; $('waiting-text').textContent = '利用を再開したい場合は、管理者に連絡してください。'; }
  else if (u.status === 'active') { $('waiting-title').textContent = '権限がありません'; $('waiting-text').textContent = 'ダッシュボードの権限が付与されていません。管理者に連絡してください。'; }
}
/** メールアドレスがまだ確認されていない（メール＋パスワードで登録した直後など） */
function showUnverified(user) {
  $('app').hidden = true; $('login').hidden = true; $('waiting').hidden = false;
  $('waiting-title').textContent = 'メールアドレスの確認をお願いします';
  $('waiting-text').textContent = '登録したメールアドレスに確認メールを送りました。メールのリンクを開いてから「再読み込み」を押してください。届いていない場合は、下のボタンで送り直せます。';
  $('waiting-email').innerHTML = esc(user.email || '') + ' <button class="linkbtn" type="button" id="resend-verify">確認メールを送り直す</button>';
  $('resend-verify').onclick = async () => { try { await user.sendEmailVerification(); $('resend-verify').textContent = '送りました'; } catch (e) { $('resend-verify').textContent = '送れませんでした（時間をおいてください）'; } };
}
function showLogin() { $('app').hidden = true; $('waiting').hidden = true; $('login').hidden = false; }

let signupMode = false;
const loginErr = msg => { $('login-err').textContent = msg; $('login-err').hidden = !msg; };
const AUTH_ERR = {
  'auth/invalid-credential': 'メールアドレスかパスワードが違います', 'auth/wrong-password': 'メールアドレスかパスワードが違います', 'auth/user-not-found': 'このメールアドレスは登録されていません',
  'auth/email-already-in-use': 'このメールアドレスは登録済みです。ログインしてください', 'auth/weak-password': 'パスワードは8文字以上にしてください',
  'auth/invalid-email': 'メールアドレスの形式が正しくありません', 'auth/too-many-requests': '試行回数が多すぎます。しばらくしてから試してください', 'auth/popup-closed-by-user': '',
};
const authMsg = e => AUTH_ERR[e.code] !== undefined ? AUTH_ERR[e.code] : (e.message || 'ログインできませんでした');

async function boot() {
  const cfg = await fetch('/api/config').then(r => r.json());
  firebase.initializeApp(cfg.firebase);
  fbAuth = firebase.auth();
  fbAuth.onAuthStateChanged(async user => {
    if (!user) return showLogin();
    try {
      me = await api('/me');
      if (me.emailVerified === false) showUnverified(user);
      else if (me.status === 'active' && hasAnyPerm(me)) await startApp();
      else showWaiting(me);
    } catch (e) { showLogin(); loginErr(e.message); }
  });
  $('login-form').onsubmit = async ev => {
    ev.preventDefault(); loginErr('');
    const email = $('login-email').value.trim(), pass = $('login-pass').value;
    if (!email || pass.length < 8) return loginErr('メールアドレスと8文字以上のパスワードを入力してください');
    try {
      if (signupMode) {
        const cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
        cred.user.sendEmailVerification().catch(() => {});
      } else await fbAuth.signInWithEmailAndPassword(email, pass);
    } catch (e) { loginErr(authMsg(e)); }
  };
  $('login-google').onclick = async () => { loginErr(''); try { await fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch (e) { loginErr(authMsg(e)); } };
  $('login-toggle').onclick = () => {
    signupMode = !signupMode;
    $('login-submit').textContent = signupMode ? '登録を申請する' : 'ログイン';
    $('login-toggle').textContent = signupMode ? 'ログインに戻る' : '新規登録はこちら';
    $('login-lead').textContent = signupMode ? 'メールアドレスとパスワード（8文字以上）を入力してください。管理者が承認すると使えるようになります。' : '登録済みのアカウントでログインしてください。新規登録した場合は、管理者の承認後に利用できます。';
    $('login-pass').autocomplete = signupMode ? 'new-password' : 'current-password';
  };
  $('login-reset').onclick = async () => {
    const email = $('login-email').value.trim();
    if (!email) return loginErr('メールアドレスを入力してから押してください');
    try { await fbAuth.sendPasswordResetEmail(email); loginErr(''); $('login-lead').textContent = email + ' にパスワード再設定のメールを送りました。'; } catch (e) { loginErr(authMsg(e)); }
  };
  const logout = () => fetch('/auth/logout', { method: 'POST' }).catch(() => {}).then(() => fbAuth.signOut()).then(() => location.reload());   // ログインの通行証も消す（2026-10-28）
  $('logout').onclick = logout; $('waiting-logout').onclick = logout;
  $('waiting-reload').onclick = () => location.reload();

  document.querySelector('.nav').addEventListener('click', ev => { const b = ev.target.closest('button[data-view]'); if (b) { state.view = b.dataset.view; render(); } });
  $('media-select').onchange = ev => { state.media = ev.target.value; render(); };
  $('art-sub-select').onchange = ev => { state.artSub = ev.target.value; render(); };
  $('art-media-select').onchange = ev => { if (ADMIN_MEDIA_VIEWS.includes(state.view)) { state.adminMedia = ev.target.value; render(); return; } state.artSub = ''; if (ev.target.value === ALL) { state.media = ALL; state.artMedia = ALL; render(); return; } state.artMedia = ev.target.value; const e = topMedia().find(m => m.media === state.artMedia); if (e) state.media = e.id; render(); };
  $('dash-select').onchange = ev => { state.dash = ev.target.value; state.view = dashViews()[0].id; render(); };
  document.querySelectorAll('#mode-seg button').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; render(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (META) render(); });
}
boot().catch(e => { document.body.insertAdjacentHTML('beforeend', `<p class="err" style="padding:16px">起動できませんでした：${esc(e.message)}</p>`); });
})();
