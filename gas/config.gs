/**
 * 設定まわり
 * サイトごとの設定はスクリプトではなく、スプレッドシートの「自動集計設定」タブで管理する。
 */

const CONFIG_SHEET = '自動集計設定';
const LOG_SHEET = '自動集計ログ';
const HEADER_ROW = 2;          // 各タブで月の日付が入っている行
const TZ = 'Asia/Tokyo';

// 検証（verify）で突き合わせる月。シートに手入力済みの月を指定する
const VERIFY_MONTH = { year: 2026, month: 9 };

// 手動で取り直すときの対象（manualRun / manualRefreshSC で使う）
const MANUAL_MONTH = { year: 2026, month: 10 };

// 設定タブの列
const COL = { ENABLED: 1, TAB: 2, GA4: 3, SC: 4, SC_FILTER: 5, LAST_RUN: 6, RESULT: 7, BLOCK: 8, PATHS: 9 };
const CONFIG_HEADERS = ['有効', 'タブ名', 'GA4プロパティID', 'Search Consoleプロパティ', 'SCページ絞り込み', '最終実行', '結果',
  'ブロック（タブ内の見出し）', 'GA4ページロケーション（カンマ区切り・含む）'];

// 害虫害獣コンシェルジュのディレクトリ別ブロック（見出し名 → ページパス）
const CONCIERGE_TAB = '害虫害獣コンシェルジュ';
const CONCIERGE_BLOCKS = [
  ['害虫', '/cockroach/,/termite/,/wasp/,/other-insects/'],
  ['ゴキブリ', '/cockroach/'],
  ['シロアリ', '/termite/'],
  ['ハチ', '/wasp/'],
  ['その他害虫', '/other-insects/'],
  ['害獣', '/bat/,/rat/,/other-animals/'],
  ['コウモリ', '/bat/'],
  ['ネズミ', '/rat/'],
  ['その他害獣', '/other-animals/'],
];

/** 初回だけ実行：「自動集計設定」タブを作り、全サイトの行を用意する */
function setupConfigSheet() {
  const ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName(CONFIG_SHEET)) throw new Error('「' + CONFIG_SHEET + '」タブは既にあります');
  const sh = ss.insertSheet(CONFIG_SHEET);
  const rows = [
    [true,  '害獣お助け',             '469786980', 'https://gaijyu.otasuke-honpo.com/', ''],
    [false, '生活お助け',             '', 'https://otasuke-honpo.com/', ''],
    [false, 'ハチお助け',             '', 'https://hachi.otasuke-honpo.com/', ''],
    [false, '水まわりお助け',         '', '', ''],
    [false, 'カギお助け',             '', '', ''],
    [false, 'ガラスお助け',           '', '', ''],
    [false, '屋根外壁お助け',         '', '', ''],
    [false, 'シロアリお助け',         '', '', ''],
    [false, 'BEST365',                '', 'https://best365.best24.co.jp/', ''],
    [false, '害虫害獣コンシェルジュ', '', '', ''],
  ].map(r => r.concat(['', '']));
  sh.getRange(1, 1, 1, CONFIG_HEADERS.length).setValues([CONFIG_HEADERS]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, CONFIG_HEADERS.length).setValues(rows);
  sh.getRange(2, COL.ENABLED, rows.length, 1).insertCheckboxes();
  sh.getRange(2, COL.GA4, rows.length, 1).setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, CONFIG_HEADERS.length);
}

/**
 * 1回だけ実行：設定タブに「害虫害獣コンシェルジュ」のディレクトリ別の行（9行）を追加する。
 * GA4プロパティIDは既存の「害虫害獣コンシェルジュ」行から引き継ぐ。追加した行は「有効」オフで入る。
 */
function addConciergeDirectoryRows() {
  if (!ensureConciergeDirectoryRows_()) throw new Error('ディレクトリ別の行は既にあります');
}

/** ディレクトリ別の行がなければ追加する（verify からも呼ぶ）。追加したら true */
function ensureConciergeDirectoryRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  if (!sh) throw new Error('「' + CONFIG_SHEET + '」タブがありません。setupConfigSheet を実行してください');
  sh.getRange(1, 1, 1, CONFIG_HEADERS.length).setValues([CONFIG_HEADERS]).setFontWeight('bold');
  const sites = getSites_(true);
  if (sites.some(s => s.tab === CONCIERGE_TAB && s.block)) return false;
  const base = sites.find(s => s.tab === CONCIERGE_TAB && !s.block);
  if (!base || !base.ga4) throw new Error('「' + CONCIERGE_TAB + '」行のGA4プロパティIDを先に入力してください');
  const rows = CONCIERGE_BLOCKS.map(([block, paths]) => [false, CONCIERGE_TAB, base.ga4, '', '', '', '', block, paths]);
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, CONFIG_HEADERS.length).setValues(rows);
  sh.getRange(start, COL.ENABLED, rows.length, 1).insertCheckboxes();
  sh.getRange(start, COL.GA4, rows.length, 1).setNumberFormat('@');
  sh.autoResizeColumns(COL.BLOCK, 2);
  return true;
}

/** 設定タブの内容を読む。includeDisabled=false なら「有効」にチェックがある行だけ */
function getSites_(includeDisabled) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  if (!sh) throw new Error('「' + CONFIG_SHEET + '」タブがありません。setupConfigSheet を実行してください');
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, CONFIG_HEADERS.length).getValues()
    .map((r, i) => {
      const tab = String(r[COL.TAB - 1]).trim();
      const block = String(r[COL.BLOCK - 1] || '').trim();
      return {
        configRow: i + 2,
        enabled: r[COL.ENABLED - 1] === true,
        tab,
        block,
        name: block ? tab + '／' + block : tab,   // ログ表示用
        ga4: String(r[COL.GA4 - 1]).trim(),
        sc: String(r[COL.SC - 1]).trim(),
        scFilter: String(r[COL.SC_FILTER - 1]).trim(),
        paths: String(r[COL.PATHS - 1] || '').split(',').map(p => p.trim()).filter(p => p),
      };
    })
    .filter(s => s.tab && (includeDisabled || s.enabled));
}

function setStatus_(site, result) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  sh.getRange(site.configRow, COL.LAST_RUN, 1, 2)
    .setValues([[Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'), result]]);
}

function log_(rows) {
  if (!rows.length) return;
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['日時', '処理', 'タブ', '対象月', '内容']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm');
  // 「2026年9月」なども日付に自動変換されるので、文字列として書き込む
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setNumberFormat('@')
    .setValues(rows.map(r => [now].concat(r)));
}
