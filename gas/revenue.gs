/**
 * 収益の計算に使う条件表（「DBツール 条件参照テーブル用2」）を BigQuery に取り込む
 *
 * - 収益テーブル  … KT商材×外注先×都道府県（×回線名）ごとの収益方式・買取単価・売上割合・適用期間
 * - 収益テーブル2 … 上と同じ＋「報酬条件金額（税抜）」の未満／以上で方式が変わるもの
 * - 作業員名変更  … kintone の作業員名 → 外注先名称
 * - 回線別媒体区分（別ブック）… 回線名 → 回線種別・回線分類
 * 毎日の dailyCollect から呼ぶ（手動で importRevenueTables を実行してもよい）。スプレッドシートには書き込まない
 */
const REVENUE_BOOK_ID = '1fdJzGbTMw6bglf8nWaYnrru8LL_oBQ6YecSqnVyN3KU';
const LINE_BOOK_ID = '1-C9cYk7h2uP78Y1fylKXfMZDosdBBSfLUlHgfBWEBn0';   // DBツール 条件参照テーブル用1（回線別媒体区分）

function importRevenueTables() {
  checkProject_();
  ensureRevenueTables_();
  const book = SpreadsheetApp.openById(REVENUE_BOOK_ID);
  const rules = [];
  [['収益テーブル', 'table1'], ['収益テーブル2', 'table2']].forEach(([name, source]) => {
    const sh = book.getSheetByName(name);
    if (!sh) throw new Error('「' + name + '」のタブが見つかりません');
    const v = sh.getRange(1, 1, sh.getLastRow(), Math.min(sh.getLastColumn(), 12)).getValues();
    const head = v[0].map(h => String(h).replace(/\s/g, ''));
    const col = label => head.indexOf(label);
    const c = { item: col('KT商材'), company: col('外注先名称'), pref: col('都道府県'), method: col('収益方式'), line: col('回線名'), price: col('買取単価'),
      ratePhone: col('売上割合電話帳'), rateWeb: col('売上割合WEB'), start: col('適用開始日時'), end: col('適用終了日時'), condAmount: col('報酬条件金額（税抜）'), cond: col('報酬テーブル条件') };
    ['item', 'company', 'pref', 'method', 'start'].forEach(k => { if (c[k] < 0) throw new Error('「' + name + '」に必要な列がありません：' + k); });
    for (let r = 1; r < v.length; r++) {
      const row = v[r], g = k => c[k] < 0 ? '' : row[c[k]];
      if (!String(g('item')).trim() || !String(g('company')).trim()) continue;
      rules.push({
        source, item: String(g('item')).trim(), company: String(g('company')).trim(), pref: String(g('pref')).trim(), method: String(g('method')).trim(), line_name: String(g('line')).trim(),
        unit_price: revNum_(g('price')), rate_phone: revRate_(g('ratePhone')), rate_web: revRate_(g('rateWeb')),
        start_date: revDate_(g('start')), end_date: revDate_(g('end')), cond_amount: revNum_(g('condAmount')), cond: String(g('cond')).trim() || null,
      });
    }
  });
  const aliasSheet = book.getSheetByName('作業員名変更');
  const aliases = [];
  if (aliasSheet && aliasSheet.getLastRow() > 1) aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues()
    .forEach(r => { if (String(r[0]).trim() && String(r[1]).trim()) aliases.push({ kt_name: String(r[0]).trim(), db_name: String(r[1]).trim() }); });
  // 回線名 → 回線種別・回線分類（「DBツール 条件参照テーブル用1」の「回線別媒体区分」）
  const lineSheet = SpreadsheetApp.openById(LINE_BOOK_ID).getSheetByName('回線別媒体区分');
  const lines = [];
  if (lineSheet && lineSheet.getLastRow() > 1) {
    const lv = lineSheet.getRange(1, 1, lineSheet.getLastRow(), Math.min(lineSheet.getLastColumn(), 10)).getValues();
    const lh = lv[0].map(h => String(h).replace(/\s/g, ''));
    const ci = { name: lh.indexOf('回線名'), type: lh.indexOf('回線種別'), cls: lh.indexOf('回線分類') };
    if (ci.name < 0 || ci.cls < 0) throw new Error('「回線別媒体区分」に回線名・回線分類の列がありません');
    lv.slice(1).forEach(r => { const n = String(r[ci.name]).trim(); if (n) lines.push({ line_name: n, line_type: ci.type < 0 ? null : String(r[ci.type]).trim(), line_class: String(r[ci.cls]).trim() || null }); });
  }
  bqLoad_('revenue_rules', rules, 'WRITE_TRUNCATE');
  bqLoad_('worker_alias', aliases, 'WRITE_TRUNCATE');
  bqLoad_('line_master', lines, 'WRITE_TRUNCATE');
  console.log('収益テーブルを取り込みました：条件 ' + rules.length + '行／作業員名 ' + aliases.length + '行／回線 ' + lines.length + '行');
  return rules.length;
}

function ensureRevenueTables_() {
  const defs = {
    revenue_rules: [['source', 'STRING'], ['item', 'STRING'], ['company', 'STRING'], ['pref', 'STRING'], ['method', 'STRING'], ['line_name', 'STRING'], ['unit_price', 'FLOAT'],
      ['rate_phone', 'FLOAT'], ['rate_web', 'FLOAT'], ['start_date', 'DATE'], ['end_date', 'DATE'], ['cond_amount', 'FLOAT'], ['cond', 'STRING']],
    worker_alias: [['kt_name', 'STRING'], ['db_name', 'STRING']],
    line_master: [['line_name', 'STRING'], ['line_type', 'STRING'], ['line_class', 'STRING']],
  };
  Object.keys(defs).forEach(t => {
    try { BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, t); }
    catch (e) {
      BigQuery.Tables.insert({ tableReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: t }, schema: { fields: defs[t].map(([name, type]) => ({ name, type })) } }, BQ_PROJECT, BQ_DATASET);
    }
  });
}
function revNum_(v) { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/[¥￥,円\s]/g, '')); return isNaN(n) ? null : n; }
function revRate_(v) { if (v === '' || v == null) return null; const pct = /%/.test(String(v)); const n = revNum_(String(v).replace('%', '')); if (n == null) return null; return pct || n > 1 ? n / 100 : n; }
function revDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
}
