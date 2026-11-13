/**
 * BESTメディア 月次自動集計（GA4 / Search Console）
 *
 * 毎月2日13時台：「自動集計設定」で有効な行すべてに前月の GA4 + Search Console を入力
 * 「ブロック」列がある行は、そのタブ内の見出し（例：ゴキブリ）以下の行に、GA4ページパスで絞った値を入れる
 * 毎月4日13時台：Search Console だけ確定値で上書き
 * 1サイトでエラーが出ても他サイトは続行し、最後にまとめてエラー通知（GASの失敗メール）を出す。
 */

// ===== トリガーから呼ばれる =====
function monthlyRun() {
  const [y, m] = prevMonth_();
  runAll_(y, m, 'all');
}

function monthlyRefreshSC() {
  const [y, m] = prevMonth_();
  runAll_(y, m, 'sc');
}

// ===== 手動実行用（config.gs の MANUAL_MONTH を書き換えてから実行） =====
function manualRun() {
  runAll_(MANUAL_MONTH.year, MANUAL_MONTH.month, 'all');
}

function manualRefreshSC() {
  runAll_(MANUAL_MONTH.year, MANUAL_MONTH.month, 'sc');
}

/**
 * 検証：VERIFY_MONTH の API 値と、シートに手入力済みの値を比べて差分を「自動集計ログ」に出す。
 * 書き込みはしない。「有効」のチェックに関係なく、GA4/SC が設定済みの全タブが対象。
 * 新しいサイトを追加したら、これで差分がないことを確認してから「有効」にチェックを入れる。
 */
function verify() {
  const { year, month } = VERIFY_MONTH;
  const [s, e] = monthRange_(year, month);
  const label = year + '年' + month + '月';  // '2026/9' だと日付に変換されるため
  const logs = [];
  if (ensureConciergeDirectoryRows_()) logs.push(['設定', CONCIERGE_TAB, '', 'ディレクトリ別の行を設定タブに追加しました']);
  getSites_(true).filter(site => site.ga4 || site.sc).forEach(site => {
    try {
      const sheet = getTab_(site.tab);
      const rows = findRows_(sheet, site);
      const col = findColumn_(sheet, year, month);
      const values = resolveCall_(sheet, rows, col, collectValues_(site, s, e, 'all'));
      let diffs = 0;
      Object.keys(values).forEach(k => {
        const current = sheet.getRange(rows[k], col).getValue();
        if (typeof current !== 'number' || Math.abs(current - values[k]) > 0.011) {
          diffs++;
          logs.push(['検証', site.name, label, k + '：シート=' + current + ' / API=' + values[k]]);
        }
      });
      logs.push(['検証', site.name, label, diffs ? '差分 ' + diffs + ' 件' : '差分なし']);
    } catch (err) {
      logs.push(['検証', site.name, label, 'エラー：' + err.message]);
    }
  });
  log_(logs);
}

/** 2日・4日のトリガーを作成（再実行しても重複しない） */
function createTriggers() {
  const handlers = ['monthlyRun', 'monthlyRefreshSC'];
  ScriptApp.getProjectTriggers()
    .filter(t => handlers.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monthlyRun').timeBased().onMonthDay(2).atHour(13).inTimezone(TZ).create();
  ScriptApp.newTrigger('monthlyRefreshSC').timeBased().onMonthDay(4).atHour(13).inTimezone(TZ).create();
}

// ---------------------------------------------------------------

function prevMonth_() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [d.getFullYear(), d.getMonth() + 1];
}

function monthRange_(year, month) {
  const fmt = d => Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return [fmt(new Date(year, month - 1, 1)), fmt(new Date(year, month, 0))];
}

/** mode: 'all' = GA4 + SC / 'sc' = SC のみ。未設定の項目は取りに行かない */
function collectValues_(site, s, e, mode) {
  const values = {};
  if (mode === 'all' && site.ga4) Object.assign(values, fetchGA4_(site.ga4, s, e, site.paths));
  if (site.sc) Object.assign(values, fetchSC_(site.sc, site.scFilter, s, e));
  return values;
}

function runAll_(year, month, mode) {
  const [s, e] = monthRange_(year, month);
  const label = year + '年' + month + '月';  // '2026/9' だと日付に変換されるため
  const action = mode === 'sc' ? 'SC取り直し' : '月次入力';
  const errors = [];
  const logs = [];
  getSites_(false).forEach(site => {
    try {
      const sheet = getTab_(site.tab);
      const rows = findRows_(sheet, site);
      const col = findColumn_(sheet, year, month);
      const values = resolveCall_(sheet, rows, col, collectValues_(site, s, e, mode));
      const n = Object.keys(values).length;
      if (!n) {
        setStatus_(site, '対象なし（' + (mode === 'sc' ? 'SC' : 'GA4/SC') + '未設定）');
        return;
      }
      writeValues_(sheet, rows, col, values);
      setStatus_(site, 'OK ' + label + ' ' + action + '（' + n + '項目）');
      logs.push([action, site.name, label, 'OK（' + n + '項目）']);
    } catch (err) {
      errors.push(site.name + '：' + err.message);
      setStatus_(site, 'エラー：' + err.message);
      logs.push([action, site.name, label, 'エラー：' + err.message]);
    }
  });
  log_(logs);
  if (errors.length) throw new Error(action + ' ' + label + ' で失敗したタブがあります\n' + errors.join('\n'));
}
