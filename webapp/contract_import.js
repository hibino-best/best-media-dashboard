/**
 * 契約管理シートの取り込みと、契約書類（PDF）の保管（2026-10-14 ユーザー指定）
 *
 * - GAS の importContractSheet が BigQuery contract_sheet_raw に入れた行を、契約（Firestore contracts）と請求（BigQuery contractor_invoices）に変換する
 *   同じ人（氏名が同じ）の行は1つの契約にまとめる。契約内容の文章から単価を読み取り、文章はメモに残す
 * - 請求（2024/08以降）は1回だけ取り込む。支出の金額は SEO数値管理シートのまま使い、請求は照合と人ごとの内訳の表示にだけ使う（2026-10-14 ユーザー指定）
 * - 契約書類は Cloud Storage の専用バケット（公開不可）に保存。見られるのは書面と同じ人だけ（管理者・BEST役員・BEST正社員・本人）
 */
const { GoogleAuth } = require('google-auth-library');

const BUCKET = 'bestmedia-510909-contract-docs';
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });

// シートの書き方 → ダッシュボードのディレクトリ（2026-10-14 時点のシートの表記）
const DIR_MAP = {
  'BEST365': { '水回り': ['水回り'], '水回り②': ['水回り'], '電気設備': ['電気設備'], '外壁/屋根': ['外壁屋根'], '外壁屋根': ['外壁屋根'], 'カギ': ['カギ'] },
  '水まわりお助け': { 'トイレ': ['トイレ'], 'キッチン': ['キッチン'], '洗面台': ['洗面台'], 'お風呂': ['お風呂'] },
  '屋根外壁お助け': { '屋根': ['屋根'], '外壁': ['外壁'] },
  '害虫害獣コンシェルジュ': { 'ハチ': ['ハチ'], 'ゴキブリ': ['ゴキブリ'], 'シロアリ': ['シロアリ'], 'コウモリ': ['コウモリ'], 'ネズミ': ['ネズミ'], '害虫': ['ゴキブリ', 'シロアリ', 'ハチ', 'その他害虫'], '害獣': ['コウモリ', 'ネズミ', 'その他害獣'] },
};
// シートのポジション → 契約ポジション（いちばん最後の「→」のあとを今のポジションとして読む）
function mapPosition(raw) {
  const s = String(raw || '').split('→').pop().replace(/\s/g, '').replace(/^.*?より/, '');   // 「2025年8月より〜」の日付は除く
  if (!s) return { position: 'ライター', guess: true };
  if (/^ディレクター候補/.test(s)) return { position: 'アシスタント兼ライター', guess: true };
  if (/^アシスタントディレクター/.test(s)) return { position: 'アシスタントディレクター' };
  if (/^アシスタント兼ライター/.test(s)) return { position: 'アシスタント兼ライター', supervise: /監修/.test(s) };
  if (/^ディレクター/.test(s)) return { position: 'ディレクター' };
  if (/^PM/i.test(s)) return { position: 'PM' };
  if (/^監修/.test(s)) return { position: '監修者' };
  if (/ライター/.test(s)) return { position: 'ライター' };
  return { position: 'ライター', guess: true };
}
/** 「3万5千円」「35,000円」「3.5円」→ 数字 */
function yen(s) {
  const t = String(s).replace(/[,，\s]/g, '');
  const m = t.match(/^(?:(\d+(?:\.\d+)?)万)?(?:(\d+)千)?(\d+(?:\.\d+)?)?/);
  if (!m) return null;
  const v = (m[1] ? Number(m[1]) * 10000 : 0) + (m[2] ? Number(m[2]) * 1000 : 0) + (m[3] ? Number(m[3]) : 0);
  return v || null;
}
/** リライト・簡易リライトの単価（「記事書き換えレベルのリライトは1記事あたり2万円」「H2見出しの追加などのリライトは1記事あたり1万円」など）。最後（いちばん新しい）の値 */
function parseRewriteLite(text) {
  const t = String(text || '').normalize('NFKC');
  const last = re => { let v = null; for (const m of t.matchAll(re)) { const y = yen(m[1]); if (y != null) v = y; } return v; };
  return {
    rewrite: last(/(?:書き換え|書換)[^\n]*?リライト[^\n]*?1記事(?:あたり)?\s*([\d.,万千]+)\s*円/g) ?? last(/(?<!簡易)リライト(?:記事)?\s*1記事(?:あたり)?\s*([\d.,万千]+)\s*円/g),
    lite: last(/(?:H2|見出し|簡易)[^\n]*?リライト[^\n]*?1記事(?:あたり)?\s*([\d.,万千]+)\s*円/g) ?? last(/簡易リライト(?:記事)?[^\d\n]{0,8}([\d.,万千]+)\s*円/g),
  };
}
/** 契約内容の文章から単価を読む。同じ項目が何度も出てくるときは、最後（いちばん新しい）の値 */
function parseTerms(text) {
  const t = String(text || '').normalize('NFKC');
  const last = re => { let v = null; for (const m of t.matchAll(re)) { const y = yen(m[1]); if (y != null) v = y; } return v; };
  const pay = {
    char: last(/文字単価[^\d]{0,12}?([\d.,]+)\s*円/g),
    image: last(/画像(?:制作|作成)[^\d]{0,6}?1?件?[^\d]{0,3}([\d.,万千]+)\s*円/g),
    upload: last(/アップロード[^\d]{0,8}?1(?:記事|件)[^\d]{0,3}([\d.,万千]+)\s*円/g),
    supervise: last(/監修(?:費|料)?[^\d]{0,6}?([\d.,万千]+)\s*円/g),
    hour: last(/時間単価[^\d]{0,6}?([\d.,万千]+)\s*円/g),
    // 新規記事の単価を優先。アップロード・リライトの単価は除く
    article: last(/新規記事1記事(?:あたり)?\s*([\d.,万千]+)\s*円/g) ?? last(/(?<!アップロード|記事|件)1記事(?:あたり)?\s*([\d.,万千]+)\s*円/g),
  };
  const rl = parseRewriteLite(t);
  const o = { type: pay.char != null ? '文字単価' : '記事単価' };
  if (o.type === '文字単価') { o.char = pay.char; o.image = pay.image; o.upload = pay.upload; } else { o.articleNew = pay.article; o.articleRewrite = rl.rewrite; o.articleLite = rl.lite; o.upload = pay.upload; }
  if (pay.supervise != null) { o.superviseOn = true; o.supervise = pay.supervise; }
  if (pay.hour != null) { o.hourOn = true; o.hour = pay.hour; }
  const found = Object.values(pay).some(v => v != null);
  return { pay: o, found };
}
/** 請求の文章：小計・消費税・源泉徴収・請求金額（合計）と内訳 */
function parseInvoice(text) {
  const t = String(text || '').normalize('NFKC');
  const amt = re => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const lines = [];
  t.split('\n').forEach(l => { const m = l.match(/^\s*([^¥\d(（][^¥]*?)\s*¥\s*([\d,]+)/); if (m && !/小計|消費税|源泉|請求金額|合計/.test(m[1])) lines.push({ label: m[1].trim(), amount: Number(m[2].replace(/,/g, '')) }); });
  return {
    by: (t.match(/^\(([^)]+)\)/) || [])[1] || '',
    subtotal: amt(/小計\s*¥\s*([\d,]+)/), tax: amt(/消費税\s*¥\s*([\d,]+)/), withholding: amt(/源泉徴収\s*¥\s*([\d,]+)/),
    billed: amt(/(?:請求金額|合計)\s*¥\s*([\d,]+)/), lines,
  };
}

module.exports = function contractImport({ db, query, T, admin, MEDIA_ORDER, onChanged }) {
  const mediaKey = name => { const n = String(name || '').replace(/水回り/g, '水まわり').trim(); return (MEDIA_ORDER.find(([k, label]) => label === n || k === n) || [])[0] || null; };

  async function gcs(method, url, data, headers) {
    const client = await auth.getClient();
    return client.request({ method, url, data, headers, responseType: method === 'GET' ? 'arraybuffer' : 'json' });
  }
  async function getObject(object) {
    const r = await gcs('GET', 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + encodeURIComponent(object) + '?alt=media');
    return { body: Buffer.from(r.data), type: r.headers['content-type'] || 'application/pdf' };
  }
  async function putObject(object, buf, type) {
    await gcs('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=media&name=' + encodeURIComponent(object), buf, { 'Content-Type': type || 'application/pdf' });
  }

  /** シートの行 → 契約・請求 */
  async function run(user) {
    let raw = [];
    try { raw = await query(`SELECT data FROM ${T('contract_sheet_raw')} ORDER BY row_no`); } catch (e) { throw new Error('まだシートを取り込んでいません（Apps Script の importContractSheet を先に実行してください）'); }
    const rows = raw.map(r => JSON.parse(r.data));
    if (!rows.length) throw new Error('シートの行がありません');
    // 安全確認：メディア名が読めない行が多いときは、シートの読み方がおかしいので止める（2026-10-14 に別のタブを読んだことがあるため）
    const bad = rows.filter(r => !mediaKey(r.media));
    if (bad.length > rows.length / 3) throw new Error('シートの行の多く（' + bad.length + '/' + rows.length + '行）でメディア名が読めませんでした。取り込みを止めました（GAS の importContractSheet を確認してください）');
    // すでにいる人（名前かメールアドレスが同じ）は取り込まない。前回の取り込み分も消さない（2026-10-14 ユーザー指定）
    const removed = 0;
    const allDocs = (await db.collection('contracts').get()).docs.map(d => d.data());
    const existingEmails = new Set(allDocs.map(d => String(d.email || '').toLowerCase()).filter(Boolean));
    const nameKey = n => String(n || '').normalize('NFKC').split('\n')[0].replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '');
    const existing = new Set(allDocs.map(d => nameKey(d.name)));
    const byName = new Map();
    rows.forEach(r => { const k = (r.kind === 'supervisor' ? 'sup:' : '') + String(r.name).replace(/\s/g, ''); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); });
    const created = [], skipped = [], review = [], invoices = [];
    for (const [k, list] of byName) {
      const first = list[0];
      const medias = [...new Set(list.map(r => mediaKey(r.media)).filter(Boolean))];
      const subs = {}, memo = [];
      list.forEach(r => {
        const m = mediaKey(r.media), d = String(r.dir || '').trim();
        if (!m) { review.push(first.name + '：メディア「' + r.media + '」が分からない'); return; }
        const mapped = (DIR_MAP[m] || {})[d];
        if (mapped) subs[m] = [...new Set((subs[m] || []).concat(mapped))];
        else if (d && d !== '未定') memo.push(r.media + '：' + d);
      });
      const pos = mapPosition(list.map(r => r.position).filter(Boolean).pop());
      if (pos.guess) review.push(first.name + '：ポジション「' + (first.position || '空欄') + '」→「' + pos.position + '」にしました');
      const termsText = list.map(r => String(r.terms || '').trim()).filter(Boolean);
      const pt = parseTerms(termsText[termsText.length - 1] || '');
      if (pos.supervise && !pt.pay.superviseOn) pt.pay.superviseOn = true;
      if (first.kind === 'supervisor') {   // 監修者は記事監修の単価（オプション）として持つ
        const v = pt.pay.supervise ?? pt.pay.articleNew ?? null;
        pt.pay = { type: '記事単価', superviseOn: true, supervise: v };
        if (v == null) review.push(first.name + '：監修の単価を読み取れませんでした（メモに残しています）');
      }
      if (!pt.found) review.push(first.name + '：契約内容から単価を読み取れませんでした（メモに残しています）');
      const ws = String(list.map(r => r.writer).join(' '));
      const writerSources = (/ライター兼任/.test(ws) ? ['自らライティング'] : []).concat(['自社ライター', 'BEST契約ライター'].filter(x => ws.includes(x)));   // シートの「ライター兼任」＝自らライティング
      const ymOf = t => { const x = String(t || '').normalize('NFKC'); let m = x.match(/(\d{4})\s*[\/年-]\s*(\d{1,2})/); if (m) return m[1] + '-' + m[2].padStart(2, '0'); m = x.match(/令和\s*(\d{1,2}|元)\s*年\s*(\d{1,2})/); if (m) return (2018 + (m[1] === '元' ? 1 : Number(m[1]))) + '-' + m[2].padStart(2, '0'); return null; };
      const sm = list.map(r => ymOf(r.startMonth)).filter(Boolean).sort()[0] || null;
      const email = (list.map(r => String(r.email || '').trim().toLowerCase()).find(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) || '';
      const files = list.flatMap(r => (r.files || []).map(f => ({ label: f.label + '（' + r.media + '）', object: f.object, name: f.fileName || f.label, type: f.contentType || 'application/pdf', from: 'シート' })));
      const ended = list.every(r => String(r.flag).toUpperCase() === 'FALSE');
      list.forEach(r => (r.months || []).forEach(m => { const inv = parseInvoice(m.text); invoices.push({ name: first.name, media: mediaKey(r.media) || '', month: m.ym + '-01', subtotal: inv.subtotal, tax: inv.tax, withholding: inv.withholding, billed: inv.billed, by: inv.by, lines: JSON.stringify(inv.lines), text: m.text.slice(0, 2000) }); }));
      if (existing.has(nameKey(first.name)) || (email && existingEmails.has(email))) { skipped.push(first.name); continue; }
      const doc = {
        name: first.name, email, entity: ['企業', '個人'].includes(String(first.entity).trim()) ? String(first.entity).trim() : '個人', company: first.company || (String(first.entity).trim() === '企業' ? first.name : ''),
        position: pos.position, title: '', startMonth: sm || '2024-08', medias, subs,
        route: ['クラウドワークス', 'ランサーズ', '紹介', '自社募集'].includes(first.route) ? first.route : first.route ? (/紹介|後輩/.test(first.route) ? '紹介' : 'その他') : 'その他',
        routeNote: first.route && !['クラウドワークス', 'ランサーズ', '紹介', '自社募集'].includes(first.route) ? String(first.route).slice(0, 100) : '',
        pay: pt.pay, writerSources, invoice: '', files,
        memo: ['【シートの契約内容】', ...termsText, memo.length ? '【担当（シートの表記）】' + memo.join('、') : '', list.map(r => r.note).filter(Boolean).join('\n'), list.map(r => r.memo).filter(Boolean).join('\n')].filter(Boolean).join('\n').slice(0, 2000),
        status: ended ? '契約解除' : '契約中', version: 1, source: '契約管理シート',
        createdBy: user.email, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (ended) review.push(first.name + '：シートの R列が FALSE のため「契約解除」にしました');
      if (!sm) review.push(first.name + '：契約月が読めないため 2024/08 にしました');
      await db.collection('contracts').add(doc);
      created.push(first.name);
    }
    // 請求（1回だけ。入れ直すときは入れ替え）
    await query(`CREATE TABLE IF NOT EXISTS ${T('contractor_invoices')} (month DATE, media STRING, name STRING, subtotal INT64, tax INT64, withholding INT64, billed INT64, \`by\` STRING, lines STRING, text STRING, imported_at TIMESTAMP)`);
    await query(`DELETE FROM ${T('contractor_invoices')} WHERE TRUE`);
    for (let i = 0; i < invoices.length; i += 500) {
      await query(`INSERT INTO ${T('contractor_invoices')} (month, media, name, subtotal, tax, withholding, billed, \`by\`, lines, text, imported_at)
        SELECT DATE(r.month), r.media, r.name, r.subtotal, r.tax, r.withholding, r.billed, r.by, r.lines, r.text, CURRENT_TIMESTAMP() FROM UNNEST(@rows) r`,
        { rows: invoices.slice(i, i + 500) }, { rows: [{ month: 'STRING', media: 'STRING', name: 'STRING', subtotal: 'INT64', tax: 'INT64', withholding: 'INT64', billed: 'INT64', by: 'STRING', lines: 'STRING', text: 'STRING' }] });
    }
    if (onChanged) onChanged();
    await db.collection('access_logs').add({ uid: user.uid, email: user.email, name: user.name, view: '契約管理シートを取り込み：契約 ' + created.length + '件・請求 ' + invoices.length + '件', at: admin.firestore.FieldValue.serverTimestamp() });
    return { created, skipped, review, removed, invoices: invoices.length, noAmount: invoices.filter(x => x.subtotal == null).length };
  }

  return { run, getObject, putObject, parseTerms, parseInvoice, mapPosition };
};
module.exports.parseTerms = parseTerms;
module.exports.parseInvoice = parseInvoice;
module.exports.mapPosition = mapPosition;
module.exports.parseRewriteLite = parseRewriteLite;
