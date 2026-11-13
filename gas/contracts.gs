/**
 * 契約管理シート（ディレクター/ライター/監修者契約管理シート「SEO担当者一覧」）の取り込み（2026-10-14 ユーザー指定・1回だけ手動で実行）
 *
 * - 各行（B〜R列。S〜AL列は使わない）と、2024/08以降の月ごとの請求の文章を BigQuery contract_sheet_raw に入れる（毎回入れ替え）
 * - G列・H列の契約書類（Google ドライブの PDF）を、公開できない専用の保管場所（Cloud Storage）にコピーする
 *   ダッシュボードでは、管理者・BEST役員・BEST正社員・本人だけが見られる
 * - 取り込んだあと、ダッシュボードの 契約管理 →「シートから取り込み」で契約・請求に変換する
 * - スプレッドシートには書き込まない
 */
const CONTRACT_SHEET_ID = '1uwPHJtqh69G6U2_hx83PXucKMhSq9YhARSIuXYBaLfk';
const CONTRACT_SHEET_TAB = 'SEO担当者一覧';
const CONTRACT_BUCKET = 'bestmedia-510909-contract-docs';
const CONTRACT_FROM_YM = '2024/08';

function importContractSheet() {
  throw new Error('契約管理シートからの取り込みは終了しました（2026-10-26 ユーザー指定）。契約は、ダッシュボードの契約管理で追加・編集してください。');
}
function importContractSheetOld_() {
  // タブは名前ではなく、URL の gid=0 のタブで探す（2026-10-14：名前で探したら別のタブを読んでしまったため）
  const ss = SpreadsheetApp.openById(CONTRACT_SHEET_ID);
  const sh = ss.getSheets().find(s => s.getSheetId() === 0) || ss.getSheetByName(CONTRACT_SHEET_TAB);
  if (!sh) throw new Error('タブ「' + CONTRACT_SHEET_TAB + '」が見つかりません');
  console.log('読むタブ：' + sh.getName() + '（gid=' + sh.getSheetId() + '）');
  const v = sh.getDataRange().getDisplayValues();
  // 見出しの行（「名前」がある行）と、見出しの文字で列を探す（列の位置が変わっても読めるように）
  const hi = v.findIndex(r => r.some(c => String(c).trim() === '名前'));
  if (hi < 0) throw new Error('見出し「名前」が見つかりません');
  const hdr = v[hi].map(h => String(h).replace(/\s/g, ''));
  const col = name => hdr.indexOf(name);
  const C = { name: col('名前'), media: col('メディア名'), dir: col('ディレクトリ'), route: col('採用経路'), entity: col('契約形態'), docDir: col('ディレクター契約書類'), docWriter: col('ライター契約書類'),
    terms: col('契約内容'), position: col('ポジション'), email: col('メールアドレス'), writer: col('ライター'), note: col('補足'), memo: col('メモ') };
  Object.entries(C).forEach(([k, i]) => { if (i < 0) throw new Error('見出しが見つかりません：' + k); });
  C.startMonth = C.docWriter + 1;   // 「ライター契約書類」の右（見出しなし）＝契約月
  C.flag = C.memo + 1;              // 「メモ」の右（見出しなし）＝TRUE／FALSE
  const monthCols = hdr.map((h, i) => /^\d{4}\/\d{2}$/.test(h) && h >= CONTRACT_FROM_YM ? i : -1).filter(i => i >= 0);
  const out = [], copied = [], failed = [];
  v.slice(hi + 1).forEach((r, k) => {
    const name = String(r[C.name] || '').trim();
    if (!name) return;
    const g = key => r[C[key]];
    if (!/お助け本舗|BEST365|コンシェルジュ/.test(String(g('media')))) return;   // メディア名がない行（メモ・表の外の文字など）は読まない
    const o = {
      row: hi + k + 2, name, media: g('media'), dir: g('dir'), route: g('route'), entity: g('entity'), startMonth: g('startMonth'), terms: g('terms'), position: g('position'), email: g('email'),
      writer: g('writer'), note: g('note'), memo: g('memo'), flag: g('flag'), files: [], months: [],
    };
    [[C.docDir, 'ディレクター契約書類'], [C.docWriter, 'ライター契約書類']].forEach(([c, label]) => {
      const ids = String(r[c] || '').match(/[-\w]{25,}/g) || [];
      ids.forEach(id => {
        try { o.files.push(Object.assign({ label }, copyContractFile_(id))); copied.push(id); }
        catch (e) { failed.push(name + '：' + label + '（' + e.message + '）'); }
      });
    });
    monthCols.forEach(i => { const t = String(r[i] || '').trim(); if (t) o.months.push({ ym: String(hdr[i]).trim().replace('/', '-'), text: t }); });
    out.push(o);
  });
  const supCount = readSupervisors_(ss, out, copied, failed);   // 「BEST監修者」タブ（2026-10-14 ユーザー指定）
  bqQuery_('CREATE TABLE IF NOT EXISTS `' + BQ_PROJECT + '.' + BQ_DATASET + '.contract_sheet_raw` (imported_at TIMESTAMP, row_no INT64, data STRING)');
  const now = new Date().toISOString();
  bqLoad_('contract_sheet_raw', out.map(o => ({ imported_at: now, row_no: o.row, data: JSON.stringify(o) })), 'WRITE_TRUNCATE');
  const msg = '契約管理シートを取り込み：' + out.length + '行（うち監修者 ' + supCount + '行）、契約書類 ' + copied.length + '件をコピー' + (failed.length ? '／コピーできなかった書類：' + failed.join('、') : '');
  console.log(msg);
  return msg;
}

/**
 * 「BEST監修者」タブ（gid=2066067849）：見出しは「監修担当者名」がある行。監修者として取り込む（2026-10-14 ユーザー指定）
 * 列：企業名・監修担当者名・採用経路・契約書（リンク）・契約月（「令和7年4月7日」など）・契約内容・メディア名・ディレクトリ・メールアドレス・月ごとの請求
 */
const SUPERVISOR_GID = 2066067849;
function readSupervisors_(ss, out, copied, failed) {
  const sh = ss.getSheets().find(s => s.getSheetId() === SUPERVISOR_GID);
  if (!sh) throw new Error('「BEST監修者」のタブ（gid=' + SUPERVISOR_GID + '）が見つかりません');
  console.log('読むタブ：' + sh.getName() + '（gid=' + sh.getSheetId() + '）');
  const range = sh.getDataRange(), v = range.getDisplayValues(), rich = range.getRichTextValues();
  const hi = v.findIndex(r => r.some(c => String(c).replace(/\s/g, '') === '監修担当者名'));
  if (hi < 0) throw new Error('「BEST監修者」タブに見出し「監修担当者名」が見つかりません');
  const hdr = v[hi].map(h => String(h).replace(/\s/g, '')), col = name => hdr.indexOf(name);
  const C = { company: col('企業名'), name: col('監修担当者名'), route: col('採用経路'), doc: col('契約書'), startMonth: col('契約月'), terms: col('契約内容'), media: col('メディア名'), dir: col('ディレクトリ'), email: col('メールアドレス'), progress: col('進捗') };
  ['name', 'media', 'terms'].forEach(k => { if (C[k] < 0) throw new Error('「BEST監修者」タブの見出しが見つかりません：' + k); });
  const monthCols = hdr.map((h, i) => /^\d{4}\/\d{2}$/.test(h) && h >= CONTRACT_FROM_YM ? i : -1).filter(i => i >= 0);
  let n = 0;
  v.slice(hi + 1).forEach((r, k) => {
    const g = key => C[key] >= 0 ? String(r[C[key]] || '').trim() : '';
    const name = g('name') || g('company');
    if (!name || !/お助け本舗|BEST365|コンシェルジュ/.test(g('media'))) return;
    const o = { kind: 'supervisor', row: 10000 + hi + k + 2, name, company: g('company'), entity: g('company') ? '企業' : '個人', media: g('media'), dir: g('dir'), route: g('route'),
      startMonth: g('startMonth'), terms: g('terms'), position: '監修者', email: g('email'), writer: '', note: g('progress') ? '進捗：' + g('progress') : '', memo: '', flag: '', files: [], months: [] };
    // 契約書：セルのリンク（文字の一部にリンクがあるときも）か、セルに書かれたURL
    if (C.doc >= 0) {
      const rt = rich[hi + 1 + k][C.doc], urls = [];
      if (rt) { if (rt.getLinkUrl()) urls.push(rt.getLinkUrl()); rt.getRuns().forEach(x => { if (x.getLinkUrl()) urls.push(x.getLinkUrl()); }); }
      urls.push(r[C.doc]);
      const ids = [...new Set(urls.join(' ').match(/[-\w]{25,}/g) || [])];
      ids.forEach(id => {
        try { o.files.push(Object.assign({ label: '監修契約書' }, copyContractFile_(id))); copied.push(id); }
        catch (e) { failed.push(name + '：監修契約書（' + e.message + '）'); }
      });
    }
    monthCols.forEach(i => { const t = String(r[i] || '').trim(); if (t) o.months.push({ ym: String(hdr[i]).trim().replace('/', '-'), text: t }); });
    out.push(o); n++;
  });
  return n;
}

/**
 * 契約書類だけを取り込む（2026-10-26 ユーザー指定・手動で実行）
 * - ディレクション担当：「SEO担当者一覧」（gid=0）の G列、ライティング担当：gid=232800646 の K列 にあるファイル
 *   （URLの文字・セルのリンク・ファイルのチップのどれでも読む）
 * - ダッシュボードの契約（Firestore contracts）のうち、契約中・解除予定の人だけに付ける（休職・契約解除は付けない）
 *   名前（かっこの中の名前も）かメールアドレスで照合する
 * - ファイルは公開できない専用の保管場所（Cloud Storage）にコピー。すでに付いているファイルは付け直さない
 * - スプレッドシートには書き込まない
 */
const CONTRACT_DOC_SOURCES = [
  { gid: 0, col: 'G', label: 'ディレクター契約書' },
  { gid: 232800646, col: 'K', label: 'ライター契約書' },
  { gid: 2066067849, col: 'E', label: '監修契約書' },   // 監修者（2026-10-26 ユーザー指定）
];
const FS_DOCS = 'https://firestore.googleapis.com/v1/projects/' + BQ_PROJECT + '/databases/(default)/documents';
// シートからの取り込みは、監修者の分まで取り込んだら終わり。以降は契約管理の画面で PDF をアップロードする（2026-10-26 ユーザー指定）
const CONTRACT_SHEET_CLOSED_KEY = 'contractSheetClosed';

function importContractDocs() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(CONTRACT_SHEET_CLOSED_KEY)) throw new Error('契約管理シートからの取り込みは終了しました。契約書類は、ダッシュボードの契約管理（契約を追加・編集）から PDF をアップロードしてください。');
  const ss = SpreadsheetApp.openById(CONTRACT_SHEET_ID);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const contracts = fsContracts_().filter(c => c.status === '契約解除' ? (c.endDate && c.endDate >= today) : !(c.status === '休職' || (c.leaveStart && !c.leaveEnd && c.leaveStart <= today)));
  console.log('対象の契約（契約中・解除予定）：' + contracts.length + '件');
  const byEmail = {}, byName = {};
  contracts.forEach(c => { if (c.email) byEmail[c.email] = c; nameKeys_(c.name).forEach(k => { byName[k] = c; }); });
  const add = {}, found = {}, noMatch = [], failed = [];
  CONTRACT_DOC_SOURCES.forEach(src => {
    const sh = ss.getSheets().find(s => s.getSheetId() === src.gid);
    if (!sh) throw new Error('タブ（gid=' + src.gid + '）が見つかりません');
    const v = sh.getDataRange().getDisplayValues();
    const NAME_RE = /^(名前|氏名|契約者名|ライター名|担当者名|監修担当者名)/;
    const hi = v.slice(0, 15).findIndex(r => r.some(c => NAME_RE.test(String(c).replace(/\s/g, ''))));
    if (hi < 0) throw new Error('「' + sh.getName() + '」で名前の見出しが見つかりません。見出し：' + v.slice(0, 3).map(r => r.join('|')).join(' / '));
    const hdr = v[hi].map(h => String(h).replace(/\s/g, ''));
    const nameCol = hdr.findIndex(h => NAME_RE.test(h)), mailCol = hdr.findIndex(h => /メール/.test(h)), coCol = hdr.indexOf('企業名');
    const colIdx = src.col.charCodeAt(0) - 65;
    console.log('読むタブ：' + sh.getName() + '（名前＝' + hdr[nameCol] + '列、契約書類＝' + src.col + '列「' + (hdr[colIdx] || '') + '」）');
    const links = columnLinks_(sh.getName(), src.col, v.length);
    for (let r = hi + 1; r < v.length; r++) {
      const company = coCol >= 0 ? String(v[r][coCol] || '').trim() : '';
      const name = String(v[r][nameCol] || '').trim() || company;
      if (!name) continue;
      const urls = (links[r] || []).concat([String(v[r][colIdx] || '')]).join(' ');
      const ids = [...new Set((urls.match(/\/d\/([-\w]{25,})|[?&]id=([-\w]{25,})/g) || []).map(m => m.replace(/^\/d\/|^[?&]id=/, '')))];
      if (!ids.length) continue;
      const email = mailCol >= 0 ? String(v[r][mailCol] || '').trim().toLowerCase() : '';
      const c = (email && byEmail[email]) || nameKeys_(name).concat(nameKeys_(company)).map(k => byName[k]).find(Boolean);
      if (!c) { noMatch.push(name.split('\n')[0]); continue; }
      found[c.id] = true;
      ids.forEach(id => {
        if (c.objects.some(o => o.indexOf('sheet/' + id) === 0) || (add[c.id] || []).some(f => f.object.indexOf('sheet/' + id) === 0)) return;
        try { (add[c.id] = add[c.id] || []).push(Object.assign({ label: src.label }, copyContractFile_(id))); }
        catch (e) { failed.push(c.name + '：' + src.label + '（' + e.message + '）'); }
      });
    }
  });
  const ids = Object.keys(add);
  ids.forEach(id => fsAppendFiles_(id, add[id]));
  const none = contracts.filter(c => !found[c.id] && !c.objects.length).map(c => c.name);
  const msg = '契約書類を取り込み：' + ids.length + '人に ' + ids.reduce((s, id) => s + add[id].length, 0) + '件を追加'
    + (failed.length ? '／コピーできなかった書類：' + failed.join('、') : '')
    + (none.length ? '／シートに契約書類が見つからなかった人：' + none.join('、') : '')
    + (noMatch.length ? '／ダッシュボードの契約中・解除予定の人と照合できなかったシートの名前：' + [...new Set(noMatch)].join('、') : '');
  console.log(msg);
  props.setProperty(CONTRACT_SHEET_CLOSED_KEY, new Date().toISOString());   // これで終わり。次からは実行できない
  console.log('契約管理シートからの取り込みを終了しました（以降は実行できません）');
  return msg;
}

/** 名前の照合用：かっこの外と中の名前を、空白なしで（「小鳥遊 まゆか(吉村 麻由佳)」→ 小鳥遊まゆか・吉村麻由佳） */
function nameKeys_(name) {
  const s = String(name || '').normalize('NFKC').split('\n')[0];
  const inner = (s.match(/[(（]([^)）]*)[)）]/g) || []).map(x => x.replace(/^[(（]|[)）]$/g, ''));
  return [s.replace(/[(（][^)）]*[)）]/g, '')].concat(inner).map(x => x.replace(/\s/g, '')).filter(x => x.length >= 2);
}

/** 列の各セルのリンク（URL・セルのリンク・ファイルのチップ）を Sheets API で読む。戻り値は行番号（0始まり）→ URL の配列 */
function columnLinks_(title, col, rows) {
  const range = "'" + title.replace(/'/g, "''") + "'!" + col + '1:' + col + Math.max(rows, 1);
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + CONTRACT_SHEET_ID + '?includeGridData=true&ranges=' + encodeURIComponent(range)
    + '&fields=' + encodeURIComponent('sheets.data.rowData.values(hyperlink,chipRuns.chip.richLinkProperties.uri,textFormatRuns.format.link.uri)');
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('シートのリンクを読めませんでした（' + res.getResponseCode() + '）：' + res.getContentText().slice(0, 200));
  const data = ((JSON.parse(res.getContentText()).sheets || [])[0] || {}).data || [];
  return ((data[0] || {}).rowData || []).map(rd => {
    const c = ((rd || {}).values || [])[0] || {}, out = [];
    if (c.hyperlink) out.push(c.hyperlink);
    (c.chipRuns || []).forEach(x => { const u = x.chip && x.chip.richLinkProperties && x.chip.richLinkProperties.uri; if (u) out.push(u); });
    (c.textFormatRuns || []).forEach(x => { const u = x.format && x.format.link && x.format.link.uri; if (u) out.push(u); });
    return out;
  });
}

/** Firestore の契約（照合に使う項目だけ） */
function fsContracts_() {
  const res = UrlFetchApp.fetch(FS_DOCS + ':runQuery', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'contracts' }], select: { fields: ['name', 'email', 'status', 'endDate', 'leaveStart', 'leaveEnd', 'files'].map(f => ({ fieldPath: f })) } } }) });
  if (res.getResponseCode() >= 300) throw new Error('ダッシュボードの契約を読めませんでした（' + res.getResponseCode() + '）：' + res.getContentText().slice(0, 200));
  const s = x => x ? (x.stringValue || '') : '';
  return JSON.parse(res.getContentText()).filter(x => x.document).map(x => {
    const f = x.document.fields || {};
    const files = ((f.files && f.files.arrayValue && f.files.arrayValue.values) || []).map(y => s(((y.mapValue || {}).fields || {}).object));
    return { id: x.document.name.split('/').pop(), name: s(f.name), email: s(f.email).toLowerCase(), status: s(f.status) || '契約中', endDate: s(f.endDate), leaveStart: s(f.leaveStart), leaveEnd: s(f.leaveEnd), objects: files };
  });
}

/** 契約の files に書類を足す（すでにあるものは足さない） */
function fsAppendFiles_(id, files) {
  const at = new Date().toISOString(), str = v => ({ stringValue: String(v || '') });
  const res = UrlFetchApp.fetch(FS_DOCS + ':commit', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ writes: [{ transform: { document: 'projects/' + BQ_PROJECT + '/databases/(default)/documents/contracts/' + id, fieldTransforms: [{ fieldPath: 'files', appendMissingElements: { values: files.map(f => ({ mapValue: { fields: {
      label: str(f.label), name: str(f.fileName), object: str(f.object), type: str(f.contentType), from: str('契約管理シート'), at: str(at) } } })) } }] } }] }) });
  if (res.getResponseCode() >= 300) throw new Error('契約に書類を付けられませんでした（' + res.getResponseCode() + '）：' + res.getContentText().slice(0, 200));
}

/** ドライブのファイルを専用の保管場所にコピー（同じファイルは上書き）。Googleドキュメントなどは PDF に変換 */
function copyContractFile_(id) {
  const f = DriveApp.getFileById(id);
  const mime = f.getMimeType();
  let blob;
  if (/^application\/vnd\.google-apps\./.test(mime)) blob = f.getAs('application/pdf');
  else if (/pdf|^image\//.test(mime)) blob = f.getBlob();
  else { try { blob = f.getAs('application/pdf'); } catch (e) { blob = f.getBlob(); } }   // Word などは、できれば PDF に変換（画面で表示できるように）
  const object = 'sheet/' + id + (/pdf/.test(blob.getContentType()) ? '.pdf' : '');
  const res = UrlFetchApp.fetch('https://storage.googleapis.com/upload/storage/v1/b/' + CONTRACT_BUCKET + '/o?uploadType=media&name=' + encodeURIComponent(object), {
    method: 'post', contentType: blob.getContentType(), payload: blob.getBytes(), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  });
  if (res.getResponseCode() >= 300) throw new Error('保管場所への保存に失敗（' + res.getResponseCode() + '）');
  return { object, fileName: f.getName(), contentType: blob.getContentType() };
}
