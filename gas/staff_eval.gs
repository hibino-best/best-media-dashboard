/**
 * BEST社員管理の評価項目（MKTスキル指標・行動評価）の元シートを確認する（2026-10-27・読むだけ。シートには書き込まない）
 * シート：1ZcZC-3nhglFJORJRLL7ZGgxfqtbvvM4k60aDnnzJj5k（gid=286330727）
 * C列＝項目、E列＝PM、F列＝ディレクター、G列＝アシスタントディレクター、H列＝アシスタント（契約社員はアシスタント候補）
 */
const EVAL_SHEET_ID = '1ZcZC-3nhglFJORJRLL7ZGgxfqtbvvM4k60aDnnzJj5k';
const EVAL_SHEET_GID = 286330727;

function checkEvalSheet() {
  const ss = SpreadsheetApp.openById(EVAL_SHEET_ID);
  console.log('タブ一覧：' + ss.getSheets().map(s => s.getName() + '（gid=' + s.getSheetId() + '）').join('、'));
  const sh = ss.getSheets().find(s => s.getSheetId() === EVAL_SHEET_GID);
  if (!sh) throw new Error('タブ（gid=' + EVAL_SHEET_GID + '）が見つかりません');
  const v = sh.getRange(1, 1, Math.min(sh.getLastRow(), 200), Math.min(sh.getLastColumn(), 10)).getDisplayValues();
  console.log('読むタブ：' + sh.getName() + '（' + sh.getLastRow() + '行×' + sh.getLastColumn() + '列）');
  // ログは1件あたりの長さに上限があるので、20行ずつ出す
  for (let i = 0; i < v.length; i += 20) {
    console.log(JSON.stringify(v.slice(i, i + 20).map((r, k) => [i + k + 1].concat(r.map(c => String(c).slice(0, 120))))));
  }
}
