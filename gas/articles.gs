/**
 * 記事管理シートの取り込み（各メディアの記事管理スプレッドシート → BigQuery article_items）
 *
 * - 取り込むシートは「記事管理シート」タブで管理（メディア／スプレッドシートURL／タブのgid／有効）
 * - 見出し名で列を判定する（見出し行は自動で探す。シートごとに列の並びが違っても取り込める）
 * - 「ディレクトリ」（設定タブE列）があるシートは、記事にディレクトリを付け、KW未選定の行も取り込む
 * - 「チェックシート」の列は取り込まない
 * - 「5/27」のように年がない日付は、WordPressの公開日・更新日から年を補う。分からなければ今日以前で一番近い年
 * - 元のスプレッドシートは読み取るだけ（書き込まない）
 */

const ARTICLE_CONFIG_SHEET = '記事管理シート';
const ARTICLE_HEADER_ROW = 2;
// 見出し名 → BigQuery の列名（見出しの改行・空白は除いて照合）
const ARTICLE_COLUMNS = [
  ['記事No.', 'no'], ['検索KW', 'kw'], ['検索Vol(平均)', 'vol_avg', 'num'], ['検索Vol(MAX)', 'vol_max', 'num'], ['検索Vol(MIN)', 'vol_min', 'num'],
  ['関連KW', 'related_kw'], ['ターゲット層', 'target'], ['クエリタイプ', 'query_type'], ['ポジション', 'position'], ['緊急性', 'urgency'], ['ディレクション担当', 'director'], ['SEO難易度', 'seo_difficulty'],
  ['制作順', 'plan_order'], ['記事進行状況', 'status'], ['新規/リライト', 'type'], ['新規or既存記事差し替え', 'type'], ['記事URL', 'url'], ['記事ID', 'post_id'],
  ['ジャンル', 'genre'], ['CTA', 'cta'], ['訴求ブロック', 'appeal_block'], ['平均価格表記の有無', 'price_note'], ['相場への言及', 'market_note'],
  ['タグ', 'tags'], ['想定文字数', 'planned_chars', 'num'], ['依頼日', 'request_date', 'date'], ['記事構成シート', 'outline_url'], ['アップロード日', 'upload_date', 'date'],
  ['執筆担当', 'writer'], ['進行状況@執筆', 'writing_status'], ['文字数', 'chars', 'num'], ['コピペ率', 'copy_rate'], ['ライティングURL', 'writing_url'],
  ['画像制作担当', 'image_owner'], ['進行状況@画像', 'image_status'], ['画像制作枚数サムネイル含む', 'image_count', 'num'], ['アップロード担当', 'upload_owner'], ['進行状況@アップロード', 'upload_status'],
  // 監修（監修者ありのメディア）
  ['専門レベル', 'expertise'], ['監修', 'supervision'], ['監修有無', 'supervision'], ['監修担当', 'supervisor'], ['監修者', 'supervisor'],
  // 別の書き方の見出し（シロアリお助け本舗など）
  ['ステータス', 'status'], ['アップロードURL', 'url'], ['記事公開日', 'upload_date', 'date'], ['カテゴリ', 'genre'], ['構成URL', 'outline_url'], ['実文字数', 'chars', 'num'], ['画像制作枚数', 'image_count', 'num'], ['画像枚数', 'image_count', 'num'],
  // 「制作管理」書式（水まわりお助け本舗の過去分／BEST365）
  ['原稿no.', 'no'], ['KW', 'kw'], ['検索vol', 'vol_avg', 'num'], ['公開URL', 'url'], ['公開日', 'upload_date', 'date'], ['原稿URL', 'writing_url'],
  // 害獣お助け本舗の書き方
  ['記事テーマ', 'theme'], ['ディレクトリNo.', 'dir_no'], ['検索VOL', 'vol_avg', 'num'], ['設計シート', 'outline_url'], ['画像作成枚数サムネイル含む', 'image_count', 'num'],
  ['構成担当者', 'director'], ['執筆担当者', 'writer'], ['監修アリorナシ', 'supervision'],
];
// 「制作管理」書式のチェック欄 → 進行状況を決める
const STATUS_FLAG_COLS = [['構成OK', 'c'], ['執筆提出', 'ws'], ['執筆OK', 'w'], ['監修依頼', 'sr'], ['監修完了', 'sd'], ['公開完了', 'done']];

/** 設定タブがなければ作る（ハチお助け本舗は入力済み） */
// 設定タブに無ければ追加する記事管理シート（メディア名, URL, gid）
// [メディア, URL, gid（またはタブ名）, ディレクトリ]。ディレクトリが「A|B」なら、BEST365 の水回り記事一覧にあるKW（または公開URLが best365）の記事は B、それ以外は A
const WATER_BOOK = 'https://docs.google.com/spreadsheets/d/1ULeG5dyhShoHxxcjyWcT63oYMgucfjr80Vs7Ys_FbjQ/edit';
const BEST365_BOOK = 'https://docs.google.com/spreadsheets/d/11pOfHw9Pm0hVk8zF1-wzMV5eJ80AXG2GSy2qhJ_1l2w/edit';
const ROOF_BOOK = 'https://docs.google.com/spreadsheets/d/19xA9glzh1acxKnHxUiNiDHJDIgezg0mxKYvMY0JmFgM/edit';
// 設定タブから消す行（メディア, タブ）
const ARTICLE_SHEET_REMOVED = [['害獣お助け', 'ネズミKW'], ['害獣お助け', 'コウモリKW'], ['害獣お助け', 'ハトKW'], ['害獣お助け', 'アニマルKW'], ['害獣お助け', 'その他KW']];
// ディレクトリNo. → ディレクトリ名（「記事テーマ」が空の行に使う。害獣お助け本舗の集計表の「優先度」と同じ）
const DIR_NO_NAMES = { '害獣お助け': { '0': '害獣駆除', '1': 'ネズミ駆除', '2': 'コウモリ駆除', '3': 'アライグマ駆除', '4': 'イタチ駆除', '5': 'ハクビシン駆除', '6': 'タヌキ駆除', '7': 'アナグマ駆除', '8': 'テン駆除', '9': 'モグラ駆除', '10': 'その他害獣駆除' } };
const ARTICLE_SHEET_DEFAULTS = [
  ['シロアリお助け', 'https://docs.google.com/spreadsheets/d/1jZOd7B7ZS7t68oWC_I5bdqf_qiB8Cm6-kqAL-52s_eI/edit', '345505845', ''],
  ['水まわりお助け', WATER_BOOK, '1955818254', 'トイレ'],
  ['水まわりお助け', WATER_BOOK, '1159021763', '洗面台'],
  ['水まわりお助け', WATER_BOOK, '678236873', '過去制作|BEST365移管'],
  ['BEST365', BEST365_BOOK, '465764703', '水回り'],
  ['BEST365', BEST365_BOOK, '661855293', '水回り'],
  ['BEST365', BEST365_BOOK, 'カギ記事一覧', 'カギ'],
  ['BEST365', BEST365_BOOK, '外壁屋根一覧', '外壁屋根'],
  ['BEST365', BEST365_BOOK, '電気設備記事一覧', '電気設備'],
  ['屋根外壁お助け', ROOF_BOOK, '1867814088', '屋根'],
  ['屋根外壁お助け', ROOF_BOOK, '221807103', '外壁'],
  ['カギお助け', 'https://docs.google.com/spreadsheets/d/1Q3fueiWD05S4-dRIZ2Uc33Iq0xaaV1G_T8OgehdZGtM/edit', '1994085661', ''],
  // ガラスお助け：上から 進行中 → 過去記事 → 過去記事②（この順で読む。先のタブに同じ記事URLがある行は除く）
  ['害獣お助け', 'https://docs.google.com/spreadsheets/d/1BXE24_Kr4EHCYwDdvsZqvzqq39oGZUDWzEsk5xjMpNg/edit', '1194177753', '@記事テーマ'],
  // 害虫害獣コンシェルジュ（シロアリ・ゴキブリ・その他害虫はディレクトリだけで、シートはなし）
  ['害虫害獣コンシェルジュ', 'https://docs.google.com/spreadsheets/d/1cre5xLa2xGX3PnRu9ieBUrOnLMiFis4fpVt2zDNblw8/edit', '1803633935', 'ハチ'],
  ['害虫害獣コンシェルジュ', 'https://docs.google.com/spreadsheets/d/1cre5xLa2xGX3PnRu9ieBUrOnLMiFis4fpVt2zDNblw8/edit', '80312503', 'コウモリ'],
  ['害虫害獣コンシェルジュ', 'https://docs.google.com/spreadsheets/d/1cre5xLa2xGX3PnRu9ieBUrOnLMiFis4fpVt2zDNblw8/edit', '1577473749', 'ネズミ'],
  ['害虫害獣コンシェルジュ', 'https://docs.google.com/spreadsheets/d/1cre5xLa2xGX3PnRu9ieBUrOnLMiFis4fpVt2zDNblw8/edit', '1599177575', 'その他害獣'],   // ディレクトリは「記事テーマ」列
  ['ガラスお助け', 'https://docs.google.com/spreadsheets/d/1BcF6t3og0rwUTTPcDy5G78epJ2D9xq8ILPAMpkqMuTg/edit', '445752481', '進行中'],
  ['ガラスお助け', 'https://docs.google.com/spreadsheets/d/1d7OditURXAJYmthbwTL-nMFrt1Rzl6u8xdcCtGweA8M/edit', '978316474', '過去記事'],
  ['ガラスお助け', 'https://docs.google.com/spreadsheets/d/1d7OditURXAJYmthbwTL-nMFrt1Rzl6u8xdcCtGweA8M/edit', '1788480883', '過去記事②'],
];
// 複数のタブを読むとき、先に読んだタブに同じ記事URLがある行を除くメディア（2026-10-10 ユーザー指定）
const NO_EMPTY_SLOT_MEDIA = ['害虫害獣コンシェルジュ'];
const URL_DEDUP_MEDIA = ['ガラスお助け'];
const urlKey_ = u => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
function ensureArticleConfig_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ARTICLE_CONFIG_SHEET);
  if (sh) {
    if (String(sh.getRange(1, 5).getValue()).trim() !== 'ディレクトリ') sh.getRange(1, 5).setValue('ディレクトリ').setFontWeight('bold');
    // 外した行を消す（下から）
    for (let r = sh.getLastRow(); r >= 2; r--) {
      const m = String(sh.getRange(r, 2).getValue()).trim(), t = String(sh.getRange(r, 4).getValue()).trim();
      if (ARTICLE_SHEET_REMOVED.some(x => x[0] === m && x[1] === t)) sh.deleteRow(r);
    }
    // ディレクトリの指定が変わった行は書き換える
    ARTICLE_SHEET_DEFAULTS.forEach(d => {
      for (let r = 2; r <= sh.getLastRow(); r++) {
        if (String(sh.getRange(r, 2).getValue()).trim() === d[0] && String(sh.getRange(r, 4).getValue()).trim() === d[2] && String(sh.getRange(r, 5).getValue()).trim() !== d[3]) sh.getRange(r, 5).setValue(d[3]);
      }
    });
    // 同じメディア・同じタブ（gid）の行がなければ追加
    const have = sh.getLastRow() < 2 ? [] : sh.getRange(2, 2, sh.getLastRow() - 1, 3).getValues().map(r => String(r[0]).trim() + '#' + String(r[2]).trim());
    ARTICLE_SHEET_DEFAULTS.filter(d => have.indexOf(d[0] + '#' + d[2]) < 0).forEach(d => {
      const row = sh.getLastRow() + 1;
      sh.getRange(row, 4).setNumberFormat('@');
      sh.getRange(row, 1, 1, 5).setValues([[true, d[0], d[1], d[2], d[3]]]);
      sh.getRange(row, 1).insertCheckboxes().setValue(true);
    });
    return sh;
  }
  sh = ss.insertSheet(ARTICLE_CONFIG_SHEET);
  sh.getRange(1, 1, 1, 4).setValues([['有効', 'メディア（タブ名）', 'スプレッドシートURL', 'タブのgid']]).setFontWeight('bold');
  sh.getRange(2, 1, 1, 4).setValues([[true, 'ハチお助け', 'https://docs.google.com/spreadsheets/d/1Wg88VAn1yTRpkq1X79oJpJf5oxgJa3uoZde-TCebKGU/edit', '645897263']]);
  sh.getRange(2, 1, 1, 1).insertCheckboxes();
  sh.getRange(2, 4, 1, 1).setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 4);
  return sh;
}

/** 手動で実行する（毎日の自動収集には入れていない）。全メディアを取り込み直す */
function importArticleSheets() {
  checkProject_();
  const sh = ensureArticleConfig_();
  const conf = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(r => r[0] === true && r[1] && r[2])
    .map(r => ({ media: String(r[1]).trim(), id: String(r[2]).match(/\/d\/([\w-]+)/)[1], gid: String(r[3]).trim(), sub: String(r[4] || '').trim() }));
  ensureArticleTable_();
  ensureSheetInfoTable_();
  const now = new Date().toISOString();
  const rows = [];
  const log = [];
  const seenUrl = {};
  const infos = [];   // シートの見出し・プルダウンの選択肢（ダッシュボード側の設定に使う）   // メディア → それまでのタブにあった記事URL
  conf.forEach(c => {
    try {
      const book = SpreadsheetApp.openById(c.id);
      const sheet = !c.gid ? book.getSheets()[0] : /^\d+$/.test(c.gid) ? book.getSheets().find(s => String(s.getSheetId()) === c.gid) : book.getSheetByName(c.gid);
      if (!sheet) throw new Error('タブ「' + c.gid + '」が見つかりません');
      // 記事No.だけの空き枠の行を残すか（害虫害獣コンシェルジュは残さない：2026-10-10 ユーザー指定）
      const opt = { keepEmptyKw: !!c.sub && NO_EMPTY_SLOT_MEDIA.indexOf(c.media) < 0 };
      const items = readArticleSheet_(sheet, opt);
      infos.push({ media: c.media, sub: c.sub, tab: sheet.getName(), tabs: JSON.stringify(book.getSheets().map(s => s.getName())), header: JSON.stringify(opt.head || []), lists: JSON.stringify(opt.lists || {}), top: JSON.stringify(opt.top || []), imported_at: now });
      fillYears_(items);
      // ディレクトリ：「A|B」は公開URLが best365 のドメインなら B、それ以外は A
      const subCol = c.sub.charAt(0) === '@' ? c.sub.slice(1) : '';
      const subs = subCol ? [] : c.sub.split('|').map(x => x.trim()).filter(Boolean);
      if (subCol) items.forEach(it => { it.sub = String(it.theme || '').trim() || (DIR_NO_NAMES[c.media] || {})[String(it.dir_no || '').trim()] || ''; });
      // ディレクトリが決まらない行（シート最下部の数式が切れている行）は取り込まない（2026-10-10 ユーザー指定）
      if (subCol) { const keep = items.filter(it => it.sub); items.length = 0; keep.forEach(it => items.push(it)); }
      else items.forEach(it => { it.sub = subs.length > 1 ? (/best365/i.test(String(it.url || '')) ? subs[1] : subs[0]) : (subs[0] || ''); if (subs.length > 1) it._alt = subs[1]; });
      let skipped = 0;
      if (URL_DEDUP_MEDIA.indexOf(c.media) >= 0) {
        const seen = seenUrl[c.media] = seenUrl[c.media] || {};
        const keep = items.filter(it => { const k = urlKey_(it.url); if (k && seen[k]) { skipped++; return false; } return true; });
        keep.forEach(it => { const k = urlKey_(it.url); if (k) seen[k] = true; });
        items.length = 0; keep.forEach(it => items.push(it));
      }
      items.forEach(it => rows.push(Object.assign({ media: c.media, imported_at: now }, it)));
      log.push(c.media + (c.sub && !subCol ? '（' + c.sub + '）' : '') + ' ' + items.length + '件' + (skipped ? '（前のタブと記事URLが同じ ' + skipped + '件を除外）' : ''));
    } catch (e) {
      log.push(c.media + ' エラー：' + e.message);
    }
  });
  // 「過去制作|BEST365移管」のような行：BEST365 の水回り記事一覧にあるKWの記事は B（BEST365移管）
  const nk = k => String(k || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const best365Water = new Set(rows.filter(r => r.media === 'BEST365' && r.sub === '水回り' && r.kw).map(r => nk(r.kw)));
  let moved = 0;
  rows.forEach(r => { if (r._alt) { if (r.kw && best365Water.has(nk(r.kw)) && r.sub !== r._alt) { r.sub = r._alt; moved++; } delete r._alt; } });
  if (moved) log.push('BEST365移管と判定 ' + moved + '件');
  bqLoad_('article_items', rows, 'WRITE_TRUNCATE');
  try { bqLoad_('article_sheet_info', infos, 'WRITE_TRUNCATE'); } catch (e) { console.warn('article_sheet_info: ' + e.message); }
  console.log('記事管理シートを取り込みました：' + log.join('／'));
  return rows.length;
}

/** 数式のエラー表示（#N/A・#REF! など） */
const isErr_ = x => /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/.test(String(x || '').trim());

function readArticleSheet_(sheet, opts) {
  opts = opts || {};
  const lastCol = Math.min(sheet.getLastColumn(), 90);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), lastCol).getValues();
  const display = sheet.getRange(1, 1, sheet.getLastRow(), lastCol).getDisplayValues();
  // 見出し行：最初の6行のうち「検索KW」「KW」「記事No.」「原稿no.」がある行（なければ2行目）
  const norm = h => String(h).replace(/\s/g, '');
  const isHead = row => row.some(x => ['検索KW', 'KW', '記事No.', '原稿no.'].indexOf(norm(x)) >= 0);
  let hr = values.slice(0, 6).findIndex(isHead);
  if (hr < 0) hr = values.slice(0, 30).findIndex(isHead);   // 集計表の下に記事一覧がある書式（害獣お助け本舗）
  if (hr < 0) hr = ARTICLE_HEADER_ROW - 1;
  const head = values[hr].map(norm);
  opts.head = head;
  opts.top = display.slice(0, 25).map(r => r.map(x => String(x).slice(0, 40)));   // 書式の確認用（先頭25行）
  // プルダウンの選択肢（見出しの次の行）
  try {
    // 先頭12行のどこかにあるプルダウン（列ごと。見出しがなければ列番号）
    const nr = Math.min(12, values.length), dvs = sheet.getRange(1, 1, nr, lastCol).getDataValidations(), lists = {};
    dvs.forEach(row => row.forEach((dv, i) => { const k = head[i] || ('列' + (i + 1)); if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && !lists[k]) lists[k] = dv.getCriteriaValues()[0]; }));
    opts.lists = lists;
  } catch (e) { opts.lists = {}; }
  const flagCol = {};
  head.forEach((h, i) => { const f = STATUS_FLAG_COLS.find(x => x[0] === h); if (f && !(f[1] in flagCol)) flagCol[f[1]] = i; });
  // 「進行状況」は3回出てくるので、直前の担当列で区別する
  const keyOf = {};
  head.forEach((h, i) => {
    let name = h;
    if (h === '進行状況') {
      const before = head.slice(0, i).reverse().find(x => /担当$/.test(x)) || '';
      name = '進行状況@' + (before.indexOf('執筆') === 0 ? '執筆' : before.indexOf('画像') === 0 ? '画像' : before.indexOf('アップロード') === 0 ? 'アップロード' : '');
    }
    // 見出しが一致する列。なければ「見出し＋補足」（例：ステータス（プルダウン））の先頭一致
    const def = ARTICLE_COLUMNS.find(c => c[0].replace(/\s/g, '') === name)
      || ARTICLE_COLUMNS.find(c => c[0].length >= 4 && c[0].indexOf('@') < 0 && name.indexOf(c[0].replace(/\s/g, '')) === 0);
    if (def && !(def[1] in keyOf)) keyOf[def[1]] = { i, kind: def[2] || 'str' };
  });
  // 構成URLの列がないシート（ガラスお助けなど）は「依頼シートURL」を構成URLにする（2026-10-10 ユーザー指定）
  if (!keyOf.outline_url) { const j = head.indexOf('依頼シートURL'); if (j >= 0) keyOf.outline_url = { i: j, kind: 'str' }; }
  // 構成URLの列がリンクでなくタブ名のとき（害獣お助け本舗の「設計シート」）：セルのリンク、なければ同じブックのタブへのリンク
  let docLink = null;
  if (keyOf.outline_url) {
    const bookUrl = 'https://docs.google.com/spreadsheets/d/' + sheet.getParent().getId() + '/edit';
    const tabKey = t => String(t || '').normalize('NFKC').replace(/[ー－‐−–—]/g, '-').replace(/\s+/g, '');
    const gidOf = {}; sheet.getParent().getSheets().forEach(s => { gidOf[tabKey(s.getName())] = s.getSheetId(); });
    let rich = [];
    try { rich = sheet.getRange(1, keyOf.outline_url.i + 1, values.length, 1).getRichTextValues(); } catch (e) { rich = []; }
    docLink = (r, txt) => {
      if (/^(なし|無し|ナシ|-|－)$/.test(txt)) return '';   // 設計シートなし
      if (!txt || /^https?:\/\//.test(txt)) return txt;
      const link = rich[r] && rich[r][0] ? rich[r][0].getLinkUrl() : null;
      if (link) return /^#gid=/.test(link) ? bookUrl + link : link;
      const gid = gidOf[tabKey(txt)];
      return gid != null ? bookUrl + '#gid=' + gid : txt;
    };
  }
  const out = [];
  const kwOf = r => keyOf.kw ? String(values[r][keyOf.kw.i]).trim() : '';
  // KWがまだ選ばれていない行も残す（ディレクトリのシートだけ）。ただし最後にKWがある行まで
  // KWだけの行（記事No.・進行状況・記事URL・構成/ライティングURLがない）は記事ではない（害虫害獣コンシェルジュのハチ：表の下のKW候補）
  const cellOf = (r, k) => keyOf[k] && !isErr_(display[r][keyOf[k].i]) ? String(values[r][keyOf[k].i]).trim() : '';
  const kwOnly = r => !!kwOf(r) && !['no', 'status', 'url', 'outline_url', 'writing_url'].some(k => cellOf(r, k));
  let lastKw = -1; for (let r = hr + 1; r < values.length; r++) if (kwOf(r) && !kwOnly(r)) lastKw = r;
  for (let r = hr + 1; r < values.length; r++) {
    const v = values[r], d = display[r];
    const get = k => keyOf[k] && !isErr_(d[keyOf[k].i]) ? v[keyOf[k].i] : '';
    const hasKw = !!String(get('kw')).trim(), hasUrl = !!String(get('url')).trim();
    if (!hasKw && !hasUrl && !(opts.keepEmptyKw && r <= lastKw && String(get('no')).trim())) continue;
    if (kwOnly(r)) continue;
    const it = { row_no: r + 1 };
    Object.keys(keyOf).forEach(k => {
      const { i, kind } = keyOf[k], err = isErr_(d[i]), raw = err ? '' : v[i], txt = err ? '' : String(d[i] || '').trim();
      if (kind === 'num') { const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, '')); it[k] = txt === '' || isNaN(n) ? null : n; }
      else if (kind === 'date') { it[k] = null; it[k + '_text'] = txt; if (raw instanceof Date) it[k] = Utilities.formatDate(raw, TZ, 'yyyy-MM-dd'); }
      else it[k] = txt;
    });
    if (docLink && it.outline_url) it.outline_url = docLink(r, it.outline_url);
    if (it.supervision) it.supervision = /アリ|あり|有/.test(it.supervision) ? 'あり' : /ナシ|なし|無/.test(it.supervision) ? 'なし' : it.supervision;
    // 進行状況の列がなく、チェック欄（構成OK〜公開完了）がある書式
    if (!keyOf.status && Object.keys(flagCol).length) {
      const on = k => k in flagCol && (v[flagCol[k]] === true || String(v[flagCol[k]]).toUpperCase() === 'TRUE');
      it.status = on('done') ? '完了' : on('sd') || on('sr') ? '記事監修者確認' : on('w') ? '記事執筆完了' : on('ws') ? '記事執筆中' : on('c') ? '構成作成完了' : it.outline_url ? '構成作成中' : '未着手';
    }
    if (!keyOf.status && !Object.keys(flagCol).length && (keyOf.writing_status || keyOf.upload_status)) {
      const ws = String(it.writing_status || ''), us = String(it.upload_status || '');
      // 記事IDだけでは完了にしない（2026-10-10 ユーザー指定：アップロードの進行状況が「完了」の記事だけ完了）
      it.status = us === '完了' ? '完了'
        : ws === '完了' || ws === 'チェック完了' ? '記事執筆完了'
        : /ライティング中|チェック待ち|チェック中|修正中/.test(ws) ? '記事執筆中'
        : it.outline_url ? '構成作成完了' : '未着手';
    }
    out.push(it);
  }
  return out;
}

/** 年がない日付に年を補う。アップロード日はWordPressの公開日・更新日、依頼日はアップロード日を基準にする */
function fillYears_(items) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const md = t => { const m = String(t || '').match(/^(\d{1,2})\/(\d{1,2})$/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const full = t => { const m = String(t || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/); return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null; };
  const ymd = (y, m, d) => y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
  const latestPast = (m, d) => { const y = Number(today.slice(0, 4)); return ymd(y, m, d) <= today ? ymd(y, m, d) : ymd(y - 1, m, d); };
  // WordPress の公開日・更新日（記事IDごと）
  const wp = {};
  const bySite = {};
  items.forEach(it => {
    const id = String(it.post_id || '').trim(), u = String(it.url || '');
    const origin = (u.match(/^https?:\/\/[^\/]+/) || [])[0];
    if (/^\d+$/.test(id) && origin) (bySite[origin] = bySite[origin] || []).push(id);
  });
  Object.keys(bySite).forEach(origin => {
    const ids = bySite[origin];
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const res = UrlFetchApp.fetch(origin + '/wp-json/wp/v2/posts?per_page=100&_fields=id,date,modified&include=' + ids.slice(i, i + 100).join(','), { muteHttpExceptions: true });
        if (res.getResponseCode() === 200) JSON.parse(res.getContentText()).forEach(p => { wp[origin + '#' + p.id] = { date: p.date.slice(0, 10), modified: p.modified.slice(0, 10) }; });
      } catch (e) { console.warn('WordPress ' + origin + ': ' + e.message); }
    }
  });
  items.forEach(it => {
    const origin = (String(it.url || '').match(/^https?:\/\/[^\/]+/) || [])[0];
    const w = wp[origin + '#' + String(it.post_id || '').trim()];
    it.wp_published = w ? w.date : null;
    it.wp_modified = w ? w.modified : null;
    // アップロード日
    if (!it.upload_date) {
      it.upload_date = full(it.upload_date_text);
      const p = md(it.upload_date_text);
      if (!it.upload_date && p) {
        const ref = w ? (/新規/.test(it.type) ? w.date : w.modified) : null;
        if (ref) {
          const cands = [-1, 0, 1].map(k => ymd(Number(ref.slice(0, 4)) + k, p[0], p[1])).filter(x => x <= today);
          cands.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(ref)) - Math.abs(Date.parse(b) - Date.parse(ref)));
          it.upload_date = cands[0] || latestPast(p[0], p[1]);
        } else it.upload_date = latestPast(p[0], p[1]);
      }
    }
    // 依頼日
    if (!it.request_date) {
      it.request_date = full(it.request_date_text);
      const p = md(it.request_date_text);
      if (!it.request_date && p) {
        if (it.upload_date) {
          const y = Number(it.upload_date.slice(0, 4));
          it.request_date = ymd(y, p[0], p[1]) <= it.upload_date ? ymd(y, p[0], p[1]) : ymd(y - 1, p[0], p[1]);
        } else it.request_date = latestPast(p[0], p[1]);
      }
    }
  });
}

function ensureArticleTable_() {
  const fields = [['media', 'STRING'], ['sub', 'STRING'], ['row_no', 'INTEGER'], ['imported_at', 'TIMESTAMP'], ['wp_published', 'DATE'], ['wp_modified', 'DATE'],
    ['request_date_text', 'STRING'], ['upload_date_text', 'STRING']]
    .concat(ARTICLE_COLUMNS.map(c => [c[1], c[2] === 'num' ? 'FLOAT' : c[2] === 'date' ? 'DATE' : 'STRING']))
    .filter((f, i, a) => a.findIndex(x => x[0] === f[0]) === i);
  try {
    const t = BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, 'article_items');
    // 列が増えたときは表に追加する
    const have = t.schema.fields.map(f => f.name);
    const add = fields.filter(f => have.indexOf(f[0]) < 0 && have.indexOf(f[0] + '_s') < 0);
    if (add.length) BigQuery.Tables.patch({ schema: { fields: t.schema.fields.concat(add.map(([name, type]) => ({ name, type }))) } }, BQ_PROJECT, BQ_DATASET, 'article_items');
  } catch (e) {
    if (!/Not found/i.test(e.message)) throw e;
    BigQuery.Tables.insert({
      tableReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: 'article_items' },
      schema: { fields: fields.map(([name, type]) => ({ name, type })) },
      clustering: { fields: ['media'] },
    }, BQ_PROJECT, BQ_DATASET);
  }
}

/** 記事管理シートの情報（見出し・プルダウンの選択肢）を入れる表 */
function ensureSheetInfoTable_() {
  try {
    const t = BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, 'article_sheet_info');
    if (!t.schema.fields.some(f => f.name === 'top')) BigQuery.Tables.patch({ schema: { fields: t.schema.fields.concat([{ name: 'top', type: 'STRING' }]) } }, BQ_PROJECT, BQ_DATASET, 'article_sheet_info');
  }
  catch (e) {
    if (!/Not found/i.test(e.message)) throw e;
    BigQuery.Tables.insert({ tableReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: 'article_sheet_info' },
      schema: { fields: ['media', 'sub', 'tab', 'tabs', 'header', 'lists', 'top'].map(name => ({ name, type: 'STRING' })).concat([{ name: 'imported_at', type: 'TIMESTAMP' }]) } }, BQ_PROJECT, BQ_DATASET);
  }
}
