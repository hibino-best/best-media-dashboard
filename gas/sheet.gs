/**
 * 各サイトタブの読み書き
 * 行番号は固定せず、A列(GA4/searchconsole)とB列の項目名から探す
 */

const GA4_KEYS = [
  'PAGEVIEW', 'SESSION', 'UNIQUEUSER', 'アクティブユーザー', '新規ユーザー',
  'アクティブユーザーあたりのビュー', '平均エンゲージメント時間', 'CALL', 'FORM',
];
const SC_KEYS = ['searchconsole合計表示回数', '合計クリック数', '平均CTR', '平均掲載順位'];

// A列がこれ以外の文字で、B列が空の行は「ブロックの見出し」（例：害虫、ゴキブリ）
const CATEGORY_A = ['GA4', 'searchconsole', 'Ubersuggest', 'WordPress', 'kintone', '支出', '担当者'];

function getTab_(name) {
  const sh = SpreadsheetApp.getActive().getSheets().find(s => s.getName().trim() === name);
  if (!sh) throw new Error('タブ「' + name + '」が見つかりません');
  return sh;
}

function isBlockHeader_(r) {
  const a = String(r[0]).trim();
  return a !== '' && String(r[1]).trim() === '' && CATEGORY_A.indexOf(a) < 0;
}

/**
 * 行キー → 行番号。チャネル行は直前の見出しで 'PV:Direct' / 'SES:Direct' のように区別。
 * site.block があれば、A列がその見出しの行から次の見出しまでの範囲だけを見る。
 */
function findRows_(sheet, site) {
  const data = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  let start = HEADER_ROW;                        // 0始まりの添字（= HEADER_ROW+1 行目から）
  if (site.block) {
    start = data.findIndex(r => isBlockHeader_(r) && String(r[0]).trim() === site.block);
    if (start < 0) throw new Error('A列に見出し「' + site.block + '」が見つかりません');
    start += 1;
  }
  let end = data.findIndex((r, i) => i >= start && isBlockHeader_(r));
  if (end < 0) end = Math.min(data.length, start + 60);

  const rows = {};
  let section = '';
  for (let i = start; i < end; i++) {
    const b = String(data[i][1]).trim();
    if (b === 'PAGEVIEW') section = 'PV';
    else if (b === 'SESSION') section = 'SES';
    else if (CHANNELS.indexOf(b) < 0) section = '';
    const key = section && CHANNELS.indexOf(b) >= 0 ? section + ':' + b : b;
    if (!(key in rows)) rows[key] = i + 1;
  }
  let required = [];
  if (site.ga4) required = required.concat(GA4_KEYS, CHANNELS.map(c => 'PV:' + c), CHANNELS.map(c => 'SES:' + c));
  if (site.sc) required = required.concat(SC_KEYS);
  const missing = required.filter(k => !(k in rows));
  if (missing.length) throw new Error('B列に項目が見つかりません：' + missing.join(', '));
  return rows;
}

function findColumn_(sheet, year, month) {
  const header = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = header.findIndex(v => v instanceof Date && v.getFullYear() === year && v.getMonth() === month - 1);
  if (idx < 0) throw new Error(HEADER_ROW + '行目に ' + year + '/' + month + ' の列がありません');
  return idx + 1;
}

/** KEY_EVENTS を「キーイベント合計 − シートのFORM」にして CALL の値にする */
function resolveCall_(sheet, rows, col, values) {
  if (!('KEY_EVENTS' in values)) return values;
  const form = sheet.getRange(rows['FORM'], col).getValue();
  if (typeof form !== 'number') {
    throw new Error('FORMが数値ではありません：「' + form + '」。IMPORTRANGE の読み込みを確認してください');
  }
  const out = Object.assign({}, values);
  out['CALL'] = Math.max(values.KEY_EVENTS - form, 0);
  delete out.KEY_EVENTS;
  return out;
}

function writeValues_(sheet, rows, col, values) {
  Object.keys(values).forEach(k => sheet.getRange(rows[k], col).setValue(values[k]));
}
