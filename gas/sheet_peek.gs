/**
 * スプレッドシートの中身を確認するための関数（読み取りだけ。書き込みはしない）
 * 2026-10-28：種石さんの日ごとの稼働の入力画面を作るため、見本のシート（イメージ・項目）を読む
 * 実行すると、各タブの見出しと先頭の行がログ（Cloud Logging）に出る
 */
function peekTaneishiSheet() {
  peekSheet_('1vTw3tM5mLOdWj3T3srNK7y6haT-cWAWxE27L1CKt-uA');
}

function peekSheet_(id) {
  const ss = SpreadsheetApp.openById(id);
  console.log('PEEK ' + JSON.stringify({ title: ss.getName(), tabs: ss.getSheets().map(s => ({ name: s.getName(), gid: s.getSheetId(), rows: s.getLastRow(), cols: s.getLastColumn() })) }));
  ss.getSheets().forEach(sh => {
    const r = Math.min(sh.getLastRow(), 45), c = Math.min(sh.getLastColumn(), 30);
    if (r < 1 || c < 1) return;
    const v = sh.getRange(1, 1, r, c).getDisplayValues().map(row => row.map(x => String(x).slice(0, 40)));
    let dv = [];
    try { dv = sh.getRange(1, 1, Math.min(r, 12), c).getDataValidations().map((row, i) => row.map((d, j) => d && d.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? (i + 1) + ':' + (j + 1) + '=' + d.getCriteriaValues()[0].join('|') : '').filter(Boolean)).flat(); } catch (e) { /* なし */ }
    console.log('PEEK ' + JSON.stringify({ tab: sh.getName(), gid: sh.getSheetId(), values: v, lists: dv }));
  });
}

/** 種石さんの「管理シート(Dir)」の日ごとの稼働（A〜T列）を全部ログに出す（読み取りだけ）。2026-10-28：ダッシュボードの稼働表に 2026/09 までを入れるため */
function peekTaneishiDir() {
  const sh = SpreadsheetApp.openById('1vTw3tM5mLOdWj3T3srNK7y6haT-cWAWxE27L1CKt-uA').getSheets().find(s => s.getSheetId() === 1131307849);
  const last = sh.getLastRow(), v = sh.getRange(8, 1, last - 7, 20).getDisplayValues();
  const rows = v.filter(r => /^\d{4}\/\d{2}\/\d{2}$/.test(String(r[0]).trim()) && String(r[0]) <= '2026/09/30');
  for (let i = 0; i < rows.length; i += 60) console.log('DIR ' + JSON.stringify({ part: i / 60, rows: rows.slice(i, i + 60) }));
  console.log('DIR ' + JSON.stringify({ done: true, count: rows.length }));
}

/** 上の peekTaneishiDir でログに入りきらなかった 2026/03/28〜2026/05/26 を、10行ずつ出す（読み取りだけ） */
function peekTaneishiDir2() {
  const sh = SpreadsheetApp.openById('1vTw3tM5mLOdWj3T3srNK7y6haT-cWAWxE27L1CKt-uA').getSheets().find(s => s.getSheetId() === 1131307849);
  const v = sh.getRange(8, 1, sh.getLastRow() - 7, 20).getDisplayValues();
  const rows = v.filter(r => /^\d{4}\/\d{2}\/\d{2}$/.test(String(r[0]).trim()) && String(r[0]) >= '2026/03/28' && String(r[0]) <= '2026/05/26');
  for (let i = 0; i < rows.length; i += 10) console.log('DIR2 ' + JSON.stringify({ part: i / 10, rows: rows.slice(i, i + 10) }));
  console.log('DIR2 ' + JSON.stringify({ done: true, count: rows.length }));
}

/**
 * 契約管理シートの M列（ディレクション・ライティング）・K列（監修）にある各担当者のシートを開き、
 * タブの一覧と「請求」を含むタブ・「管理シート」の先頭を読む（読み取りだけ。書き込みはしない）
 * 2026-10-28：ダッシュボードで請求書（ご請求タブと同じ形）を作るための確認
 */
/** 監修者だけ（前回は時間切れで監修者のタブまで読めなかったため。読むだけ。2026-10-29） */
function peekSupInvoiceSheets() { peekInvoiceSheets([[2066067849, 11, '監修']]); }
function peekInvoiceSheets(only) {
  const book = SpreadsheetApp.openById('1uwPHJtqh69G6U2_hx83PXucKMhSq9YhARSIuXYBaLfk');
  const targets = Array.isArray(only) ? only : [[0, 13, 'ディレクション'], [232800646, 13, 'ライティング'], [2066067849, 11, '監修']];
  const started = Date.now();
  targets.forEach(([gid, col, kind]) => {
    const sh = book.getSheets().find(s => s.getSheetId() === gid); if (!sh) { console.log('INV ' + JSON.stringify({ kind, error: 'タブがありません' })); return; }
    const last = sh.getLastRow(), head = sh.getRange(1, 1, Math.min(last, 5), sh.getLastColumn()).getDisplayValues();
    const rng = sh.getRange(1, 1, last, Math.max(col, 3)), disp = rng.getDisplayValues(), rich = rng.getRichTextValues();
    console.log('INV ' + JSON.stringify({ kind, tab: sh.getName(), head: head.map(r => r.slice(0, 16).map(x => String(x).slice(0, 20))) }));
    for (let r = 0; r < last; r++) {
      if (Date.now() - started > 320000) { console.log('INV ' + JSON.stringify({ kind, stop: '時間切れ', row: r + 1 })); return; }
      const cell = rich[r][col - 1]; let url = cell && cell.getLinkUrl(); if (!url && cell) (cell.getRuns() || []).forEach(x => { if (!url && x.getLinkUrl()) url = x.getLinkUrl(); });
      if (!url) { const m = String(disp[r][col - 1]).match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+/); if (m) url = m[0]; }
      const id = url && (url.match(/\/d\/([\w-]+)/) || [])[1]; if (!id) continue;
      const name = disp[r].slice(0, 4).filter(Boolean).join(' / ').slice(0, 40);
      try {
        const ss = SpreadsheetApp.openById(id), tabs = ss.getSheets().map(s => s.getName());
        const out = { kind, row: r + 1, name, title: ss.getName(), tabs, inv: [] };
        ss.getSheets().filter(s => /請求/.test(s.getName())).slice(0, 2).forEach(s => {
          const v = s.getRange(1, 1, Math.min(s.getLastRow(), 46), Math.min(s.getLastColumn(), 9)).getDisplayValues();
          // 住所・口座など個人情報の行は伏せる
          out.inv.push({ tab: s.getName(), values: v.map(row => row.map(x => /住所|〒|口座|振込先|銀行|支店|番号：?\s*\d{5,}/.test(String(x)) ? '（伏せ字）' : String(x).slice(0, 40))) });
        });
        const ms = ss.getSheets().find(s => /管理/.test(s.getName()));
        if (ms) out.manage = { tab: ms.getName(), head: ms.getRange(1, 1, Math.min(ms.getLastRow(), 8), Math.min(ms.getLastColumn(), 30)).getDisplayValues().map(row => row.map(x => String(x).slice(0, 24))) };
        console.log('INV ' + JSON.stringify(out));
      } catch (e) { console.log('INV ' + JSON.stringify({ kind, row: r + 1, name, error: String(e.message).slice(0, 120) })); }
    }
  });
  console.log('INV ' + JSON.stringify({ done: true }));
}

/** 監修者の請求管理シート（K列はスマートチップのため、Sheets API の chipRuns からリンクを読む。読むだけ。2026-10-29） */
function peekSupInvoiceSheets2() {
  const BOOK = '1uwPHJtqh69G6U2_hx83PXucKMhSq9YhARSIuXYBaLfk';
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + BOOK + '?includeGridData=true&ranges=' + encodeURIComponent("'BEST監修者'!A1:L40") + '&fields=' + encodeURIComponent('sheets.data.rowData.values(formattedValue,hyperlink,chipRuns,textFormatRuns)');
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.log('INV2 ' + JSON.stringify({ error: res.getResponseCode() + ' ' + res.getContentText().slice(0, 200) })); return; }
  const rows = ((((JSON.parse(res.getContentText()).sheets || [])[0] || {}).data || [])[0] || {}).rowData || [];
  rows.forEach((r, i) => {
    const v = r.values || [], k = v[10] || {}, name = [1, 2].map(c => (v[c] || {}).formattedValue || '').filter(Boolean).join(' / ');
    let link = k.hyperlink || '';
    (k.chipRuns || []).forEach(x => { const u = x.chip && x.chip.richLinkProperties && x.chip.richLinkProperties.uri; if (!link && u) link = u; });
    (k.textFormatRuns || []).forEach(x => { const u = x.format && x.format.link && x.format.link.uri; if (!link && u) link = u; });
    const id = (String(link).match(/\/d\/([\w-]+)/) || [])[1];
    if (!name) return;
    if (!id) { console.log('INV2 ' + JSON.stringify({ row: i + 1, name, k: k.formattedValue || '', error: 'リンクなし' })); return; }
    try {
      const ss = SpreadsheetApp.openById(id), out = { kind: '監修', row: i + 1, name, title: ss.getName(), tabs: ss.getSheets().map(s => s.getName()), inv: [] };
      ss.getSheets().filter(s => /請求/.test(s.getName())).slice(0, 2).forEach(s => {
        const vals = s.getRange(1, 1, Math.min(s.getLastRow(), 46), Math.min(s.getLastColumn(), 9)).getDisplayValues();
        out.inv.push({ tab: s.getName(), values: vals.map(row => row.map(x => /住所|〒|口座|振込先|銀行|支店|番号：?\s*\d{5,}/.test(String(x)) ? '（伏せ字）' : String(x).slice(0, 40))) });
      });
      const ms = ss.getSheets().find(s => /管理/.test(s.getName()));
      if (ms) out.manage = { tab: ms.getName(), head: ms.getRange(1, 1, Math.min(ms.getLastRow(), 8), Math.min(ms.getLastColumn(), 20)).getDisplayValues().map(row => row.map(x => String(x).slice(0, 24))) };
      console.log('INV2 ' + JSON.stringify(out));
    } catch (e) { console.log('INV2 ' + JSON.stringify({ row: i + 1, name, error: String(e.message).slice(0, 120) })); }
  });
  console.log('INV2 ' + JSON.stringify({ done: true }));
}

/**
 * 契約管理シートのライターのタブ（gid=232800646）の月ごとの請求の欄を BigQuery writer_invoices_raw に入れる（2026-10-30 ユーザー指定・手動で1回）
 * 報酬管理一覧の過去の月の請求状況・確認者（「(名前)」）に使う。スプレッドシートには書き込まない
 */
function importWriterInvoices() {
  const ss = SpreadsheetApp.openById('1uwPHJtqh69G6U2_hx83PXucKMhSq9YhARSIuXYBaLfk');
  const sh = ss.getSheets().find(s => s.getSheetId() === 232800646);
  if (!sh) throw new Error('ライターのタブ（gid=232800646）が見つかりません');
  const v = sh.getDataRange().getDisplayValues();
  const isYm = c => /^\d{4}\/\d{1,2}$/.test(String(c).replace(/\s/g, ''));
  const hi = v.slice(0, 40).findIndex(r => r.filter(isYm).length >= 3);
  if (hi < 0) throw new Error('月（2025/01 など）の見出しの行が見つかりません');
  const hdr = v[hi].map(h => String(h).replace(/\s/g, ''));
  console.log('読むタブ：' + sh.getName() + '／見出しの行：' + (hi + 1) + '／見出し：' + JSON.stringify(hdr.slice(0, 30)));
  const find = re => hdr.findIndex(h => re.test(h));
  const cName = find(/^(名前|氏名|ライター名|ライター|担当者名|担当者)$/), cMedia = find(/メディア/), cCompany = find(/企業名|会社名/);
  if (cName < 0) throw new Error('名前の列が見つかりません。見出し：' + JSON.stringify(hdr));
  const monthCols = hdr.map((h, i) => isYm(h) ? i : -1).filter(i => i >= 0);
  const now = new Date().toISOString(), rows = [];
  v.slice(hi + 1).forEach((r, k) => {
    const name = String(r[cName] || '').trim(); if (!name) return;
    monthCols.forEach(i => { const t = String(r[i] || '').trim(); if (!t) return;
      const [y, m] = hdr[i].split('/'); rows.push({ imported_at: now, row_no: hi + k + 2, name, company: cCompany >= 0 ? String(r[cCompany] || '').trim() : '', media: cMedia >= 0 ? String(r[cMedia] || '').trim() : '', ym: y + '-' + ('0' + m).slice(-2), text: t }); });
  });
  bqQuery_('CREATE TABLE IF NOT EXISTS `' + BQ_PROJECT + '.' + BQ_DATASET + '.writer_invoices_raw` (imported_at TIMESTAMP, row_no INT64, name STRING, company STRING, media STRING, ym STRING, text STRING)');
  bqLoad_('writer_invoices_raw', rows, 'WRITE_TRUNCATE');
  const msg = 'ライターのタブを取り込み：' + rows.length + '件（' + new Set(rows.map(x => x.name)).size + '人）';
  console.log(msg); return msg;
}

/**
 * プレスリリースのシート（1INIPILlxqCqPMbnTpc4AVUoV-RLl7EyNlQOCxgq01EA）の全タブを、そのまま BigQuery press_sheet_raw に入れる（2026-10-31 ユーザー指定・手動）
 * 中身の形を確かめてから、進行管理の「プレスリリース」に取り込む。スプレッドシートには書き込まない
 */
function importPressSheetRaw() {
  const ss = SpreadsheetApp.openById('1INIPILlxqCqPMbnTpc4AVUoV-RLl7EyNlQOCxgq01EA');
  const now = new Date().toISOString(), rows = [];
  ss.getSheets().forEach(sh => {
    const v = sh.getDataRange().getDisplayValues();
    console.log('タブ：' + sh.getName() + '（gid=' + sh.getSheetId() + '）' + v.length + '行×' + (v[0] || []).length + '列');
    v.forEach((r, i) => { if (r.some(c => String(c).trim())) rows.push({ imported_at: now, tab: sh.getName(), gid: sh.getSheetId(), row_no: i + 1, cells: JSON.stringify(r.map(c => String(c).slice(0, 500))) }); });
  });
  bqQuery_('CREATE TABLE IF NOT EXISTS `' + BQ_PROJECT + '.' + BQ_DATASET + '.press_sheet_raw` (imported_at TIMESTAMP, tab STRING, gid INT64, row_no INT64, cells STRING)');
  bqLoad_('press_sheet_raw', rows, 'WRITE_TRUNCATE');
  const msg = 'プレスリリースのシートを読み込み：' + rows.length + '行'; console.log(msg); return msg;
}

/**
 * 請求の照合用：渡されたスプレッドシートの全タブを読むだけ（書き込まない）→ BigQuery check_sheet_raw（2026-11-02）
 * 庭野さん・種石さん・幸谷さんの請求管理シート
 */
function importCheckSheets() {
  const ids = ['1GSrzs68WQMhJFm-mWVdyKuV5QZHf6NLQA2XU0yv5dso', '1jZOd7B7ZS7t68oWC_I5bdqf_qiB8Cm6-kqAL-52s_eI', '1cRN8YwVT5jF0NW37YtT0e5jw9HjLTuhlfYJnQ9mAf_0', '1Q3fueiWD05S4-dRIZ2Uc33Iq0xaaV1G_T8OgehdZGtM', '1BcF6t3og0rwUTTPcDy5G78epJ2D9xq8ILPAMpkqMuTg'];
  const now = new Date().toISOString(), rows = [];
  ids.forEach(id => {
    let ss; try { ss = SpreadsheetApp.openById(id); } catch (e) { console.log('開けない：' + id + ' ' + e.message); return; }
    ss.getSheets().forEach(sh => {
      const v = sh.getDataRange().getDisplayValues();
      console.log(ss.getName() + ' / ' + sh.getName() + '（gid=' + sh.getSheetId() + '）' + v.length + '行');
      v.slice(0, 600).forEach((r, i) => { if (r.some(c => String(c).trim())) rows.push({ imported_at: now, sheet_id: id, sheet_name: ss.getName(), tab: sh.getName(), gid: sh.getSheetId(), row_no: i + 1, cells: JSON.stringify(r.slice(0, 40).map(c => String(c).slice(0, 300))) }); });
    });
  });
  bqQuery_('CREATE TABLE IF NOT EXISTS `' + BQ_PROJECT + '.' + BQ_DATASET + '.check_sheet_raw` (imported_at TIMESTAMP, sheet_id STRING, sheet_name STRING, tab STRING, gid INT64, row_no INT64, cells STRING)');
  bqLoad_('check_sheet_raw', rows, 'WRITE_TRUNCATE');
  const msg = '照合用のシートを読み込み：' + rows.length + '行'; console.log(msg); return msg;
}

/**
 * 報酬の照合用（2026-11-05 ユーザー指定・手動で実行）：契約管理シートのディレクション（gid=0）・ライター（gid=232800646）・監修（gid=2066067849）のタブの
 * 月ごとの請求の欄（直近3か月）を BigQuery invoice_check_raw に入れる（毎回入れ替え）。契約・請求の登録（contracts・contractor_invoices）は変えない。スプレッドシートには書き込まない
 */
function importInvoiceCheck() {
  const ss = SpreadsheetApp.openById('1uwPHJtqh69G6U2_hx83PXucKMhSq9YhARSIuXYBaLfk');
  const now = new Date(), yms = [0, 1, 2].map(i => Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - i, 1), 'Asia/Tokyo', 'yyyy-MM'));
  const isYm = c => /^\d{4}\/\d{1,2}$/.test(String(c).replace(/\s/g, ''));
  const rows = [], at = now.toISOString(), log = [];
  [[0, 'ディレクション'], [232800646, 'ライター'], [2066067849, '監修']].forEach(([gid, kind]) => {
    const sh = ss.getSheets().find(s => s.getSheetId() === gid); if (!sh) { log.push(kind + '：タブなし'); return; }
    const v = sh.getDataRange().getDisplayValues();
    const hi = v.slice(0, 40).findIndex(r => r.filter(isYm).length >= 3); if (hi < 0) { log.push(kind + '：月の見出しなし'); return; }
    const hdr = v[hi].map(h => String(h).replace(/\s/g, ''));
    const find = re => hdr.findIndex(h => re.test(h));
    const cName = find(/^(名前|氏名|ライター名|ライター|監修者名|監修者|担当者名|担当者)$/), cMedia = find(/メディア/), cCompany = find(/企業名|会社名/);
    if (cName < 0) { log.push(kind + '：名前の列なし ' + JSON.stringify(hdr.slice(0, 20))); return; }
    const cols = hdr.map((h, i) => { if (!isYm(h)) return null; const [y, m] = h.split('/'); const ym = y + '-' + ('0' + m).slice(-2); return yms.includes(ym) ? [i, ym] : null; }).filter(Boolean);
    let n = 0;
    v.slice(hi + 1).forEach((r, k) => { const name = String(r[cName] || '').trim(); if (!name) return;
      cols.forEach(([i, ym]) => { const t = String(r[i] || '').trim(); if (!t) return; n++;
        rows.push({ imported_at: at, kind, row_no: hi + k + 2, name, company: cCompany >= 0 ? String(r[cCompany] || '').trim() : '', media: cMedia >= 0 ? String(r[cMedia] || '').trim() : '', ym, text: t }); }); });
    log.push(kind + '（' + sh.getName() + '）：' + n + '件');
  });
  bqQuery_('CREATE TABLE IF NOT EXISTS `' + BQ_PROJECT + '.' + BQ_DATASET + '.invoice_check_raw` (imported_at TIMESTAMP, kind STRING, row_no INT64, name STRING, company STRING, media STRING, ym STRING, text STRING)');
  bqLoad_('invoice_check_raw', rows, 'WRITE_TRUNCATE');
  const msg = '照合用に取り込み（' + yms.join('・') + '）：' + log.join('／');
  console.log(msg); return msg;
}
