/**
 * BigQuery への日次データ蓄積（フェーズ1）
 *
 * 対象：「自動集計設定」タブで GA4 / Search Console が入っている行すべて（「有効」のチェックに関係なく保存する）
 * テーブル（データセット best_media、日付で分割）：
 *   ga4_daily        … 日×メディア×チャネル（channel='(all)' が合計行）
 *   ga4_region_daily … 日×メディア×都道府県
 *   sc_daily         … 日×メディア（×ディレクトリ）（Search Console）
 *   job_log          … 収集の実行記録
 *
 * 使い方：
 *   1. BQ_PROJECT にプロジェクトIDを入れる
 *   2. setupBigQuery を1回実行（データセットとテーブルを作成）
 *   3. startBackfill を1回実行（過去分の取り込み。数回に分けて自動で続きを実行）
 *   4. createDailyTrigger を1回実行（毎日3時台に直近分を収集）
 */

const BQ_PROJECT = 'bestmedia-510909';   // Google Cloud プロジェクト「BESTmedia」
const BQ_DATASET = 'best_media';
const BQ_LOCATION = 'asia-northeast1';
const BACKFILL_GA4_FROM = '2024-01';   // GA4 の取り込み開始月
const SC_KEEP_MONTHS = 16;             // Search Console は16か月より前が消えるので、その範囲を取り込む

const BQ_TABLES = {
  // ページ別の月次（KW追従で記事ごとの PV・CV を出す）
  ga4_page_monthly: [['month', 'DATE'], ['media', 'STRING'], ['page_path', 'STRING'], ['pageviews', 'INTEGER'], ['sessions', 'INTEGER'], ['key_events', 'FLOAT'], ['collected_at', 'TIMESTAMP']],
  ga4_daily: [
    ['date', 'DATE'], ['media', 'STRING'], ['block', 'STRING'], ['channel', 'STRING'],
    ['pageviews', 'INTEGER'], ['sessions', 'INTEGER'], ['total_users', 'INTEGER'], ['active_users', 'INTEGER'],
    ['new_users', 'INTEGER'], ['engagement_sec', 'FLOAT'], ['key_events', 'INTEGER'], ['collected_at', 'TIMESTAMP'],
  ],
  // ユーザー数は日別を足すと重複するので、月単位の値を別に持つ（month = その月の1日）
  ga4_monthly: [
    ['month', 'DATE'], ['media', 'STRING'], ['block', 'STRING'], ['channel', 'STRING'],
    ['pageviews', 'INTEGER'], ['sessions', 'INTEGER'], ['total_users', 'INTEGER'], ['active_users', 'INTEGER'],
    ['new_users', 'INTEGER'], ['engagement_sec', 'FLOAT'], ['key_events', 'INTEGER'], ['collected_at', 'TIMESTAMP'],
  ],
  ga4_region_daily: [
    ['date', 'DATE'], ['media', 'STRING'], ['block', 'STRING'], ['region', 'STRING'],
    ['pageviews', 'INTEGER'], ['sessions', 'INTEGER'], ['key_events', 'INTEGER'], ['collected_at', 'TIMESTAMP'],
  ],
  sc_daily: [
    ['date', 'DATE'], ['media', 'STRING'], ['block', 'STRING'], ['impressions', 'INTEGER'], ['clicks', 'INTEGER'],
    ['ctr', 'FLOAT'], ['position', 'FLOAT'], ['collected_at', 'TIMESTAMP'],
  ],
  // スプレッドシートに手入力・数式で入っている月次の値（WordPress・kintone・アフィリエイト・支出）
  sheet_monthly: [
    ['month', 'DATE'], ['media', 'STRING'], ['block', 'STRING'], ['item', 'STRING'], ['value', 'FLOAT'], ['collected_at', 'TIMESTAMP'],
  ],
  job_log: [
    ['run_at', 'TIMESTAMP'], ['job', 'STRING'], ['media', 'STRING'], ['date_from', 'DATE'], ['date_to', 'DATE'],
    ['status', 'STRING'], ['message', 'STRING'],
  ],
};

// ===== 初回セットアップ =====
function setupBigQuery() {
  checkProject_();
  try {
    BigQuery.Datasets.get(BQ_PROJECT, BQ_DATASET);
  } catch (e) {
    BigQuery.Datasets.insert({ datasetReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET }, location: BQ_LOCATION }, BQ_PROJECT);
  }
  Object.keys(BQ_TABLES).forEach(name => {
    try {
      BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, name);
    } catch (e) {
      const partitionField = name === 'job_log' ? 'run_at' : (name === 'ga4_monthly' || name === 'sheet_monthly' || name === 'ga4_page_monthly') ? 'month' : 'date';
      BigQuery.Tables.insert({
        tableReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: name },
        schema: { fields: BQ_TABLES[name].map(([n, t]) => ({ name: n, type: t })) },
        timePartitioning: { type: 'DAY', field: partitionField },
        clustering: name === 'job_log' ? undefined : { fields: ['media'] },
      }, BQ_PROJECT, BQ_DATASET);
    }
  });
  console.log('BigQuery の準備ができました：' + BQ_PROJECT + '.' + BQ_DATASET);
}
/** テーブルが増えたときのために、収集の前に毎回確認する（既にあれば何もしない） */
function ensureTables_() {
  Object.keys(BQ_TABLES).forEach(name => {
    try { BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, name); } catch (e) { setupBigQuery(); }
  });
}

// ===== 毎日の収集（トリガーから） =====
// GA4 は直近3日、Search Console は直近5日を毎回取り直す（遅れて確定するデータを拾うため）
function dailyCollect() {
  checkProject_();
  const today = new Date();
  const ga4From = ymd_(addDays_(today, -3)), sc4From = ymd_(addDays_(today, -5)), to = ymd_(addDays_(today, -1));
  const errors = [];
  ensureTables_();
  // 月単位：今月（昨日まで）と、月初5日間は前月も取り直す
  const months = [Utilities.formatDate(addDays_(today, -1), TZ, 'yyyy-MM')];
  if (today.getDate() <= 5) months.push(shiftYm_(Utilities.formatDate(today, TZ, 'yyyy-MM'), -1));
  bqSites_().forEach(site => {
    if (site.ga4) runStep_('日次GA4', site, ga4From, to, () => collectGA4Range_(site, ga4From, to), errors);
    if (site.ga4) months.forEach(ym => runStep_('月次GA4', site, ym + '-01', ymRange_(ym)[1], () => collectGA4Month_(site, ym), errors));
    if (scProp_(site)) runStep_('日次SC', site, sc4From, to, () => collectSCRange_(site, sc4From, to), errors);
    if (site.ga4 && !site.block) months.forEach(ym => runStep_('月次GA4ページ', site, ym + '-01', ymRange_(ym)[1], () => collectGA4PagesMonth_(site, ym), errors));
  });
  runStep_('シート取込', { tab: '（全タブ）' }, null, null, () => importSheetMonthly(), errors);
  runStep_('収益テーブル取込', { tab: '収益テーブル' }, null, null, () => importRevenueTables(), errors);
  flushJobLog_();
  if (errors.length) throw new Error('日次収集で失敗したものがあります\n' + errors.join('\n'));
}

// ===== スプレッドシートの月次値（WordPress・kintone・アフィリエイト・支出）を取り込む =====
// A列（区分）とB列（項目名）で行を探す。（税抜き）（税込み）などの括弧書きは無視して照合する
const SHEET_ITEMS = {
  'WordPress|合計公開記事数': 'posts_total', 'WordPress|新規公開記事数': 'posts_new', 'WordPress|リライト記事数': 'rewrites', 'WordPress|プレスリリース記事数': 'press_posts',
  'kintone|コール数': 'k_calls', 'kintone|訪問確定数': 'k_visits', 'kintone|成約数': 'k_contracts',
  'kintone|加盟店': 'rev_partner', 'kintone|アフィリエイト': 'rev_affiliate',
  '支出|サイト制作・改修費': 'cost_site', '支出|ディレクション費': 'cost_direction', '支出|記事制作費': 'cost_article', '支出|プレスリリース費': 'cost_press', '支出|その他': 'cost_other',
};
function importSheetMonthly() {
  checkProject_();
  ensureTables_();
  const now = new Date().toISOString();
  const rows = [];
  // サイト全体の行と、ディレクトリ別の行（設定タブの「ブロック」）を対象にする。有効のチェックは問わない
  getSites_(true).forEach(site => {
    let sheet;
    try { sheet = getTab_(site.tab); } catch (e) { console.warn(e.message); return; }
    const data = sheet.getDataRange().getValues();
    const header = data[HEADER_ROW - 1];
    // 範囲：サイト全体は3行目から最初のブロック見出しまで、ブロックはその見出しの次の行から次の見出しまで
    let start = HEADER_ROW;
    if (site.block) {
      start = data.findIndex(r => isBlockHeader_(r) && String(r[0]).trim() === site.block);
      if (start < 0) return;
      start += 1;
    }
    let end = data.findIndex((r, i) => i >= start && isBlockHeader_(r));
    if (end < 0) end = Math.min(data.length, start + 80);
    for (let i = start; i < end; i++) {
      const a = String(data[i][0]).trim(), b = String(data[i][1]).trim().replace(/[（(].*?[）)]\s*$/, '').trim();
      const item = SHEET_ITEMS[a + '|' + b];
      if (!item) continue;
      header.forEach((h, j) => {
        if (!(h instanceof Date)) return;
        const v = data[i][j];
        if (typeof v !== 'number' || isNaN(v)) return;
        rows.push({ month: Utilities.formatDate(new Date(h.getFullYear(), h.getMonth(), 1), TZ, 'yyyy-MM-dd'), media: site.tab, block: site.block || '', item, value: v, collected_at: now });
      });
    }
  });
  // 毎回まるごと入れ替える（行数が少ないため）
  bqLoad_('sheet_monthly', rows, 'WRITE_TRUNCATE');
  console.log('シートの月次値を取り込みました：' + rows.length + '件');
  return rows.length;
}

function createDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyCollect').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyCollect').timeBased().everyDays(1).atHour(3).inTimezone(TZ).create();
}

// ===== 過去分の取り込み（6分の実行時間制限があるので、続きは自動で再実行） =====
function startBackfill() {
  checkProject_();
  const queue = [];
  const lastMonth = shiftYm_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM'), -1);
  const scFrom = shiftYm_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM'), -SC_KEEP_MONTHS);
  bqSites_().forEach(site => {
    if (site.ga4) for (let m = BACKFILL_GA4_FROM; m <= lastMonth; m = shiftYm_(m, 1)) queue.push(['ga4', site.configRow, m]);
    if (scProp_(site)) for (let m = scFrom; m <= lastMonth; m = shiftYm_(m, 1)) queue.push(['sc', site.configRow, m]);
  });
  // 今月分（昨日まで）も入れる
  const thisMonth = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  bqSites_().forEach(site => {
    if (site.ga4) queue.push(['ga4', site.configRow, thisMonth]);
    if (scProp_(site)) queue.push(['sc', site.configRow, thisMonth]);
  });
  saveQueue_(queue);
  console.log('取り込み対象：' + queue.length + '件（メディア×月）');
  backfillStep();
}

function backfillStep() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'backfillStep').forEach(t => ScriptApp.deleteTrigger(t));
  const started = Date.now();
  ensureTables_();
  const queue = loadQueue_();
  // 日別の取り込みが終わったら、月単位（ga4m）の取り込みを1回だけ自動で追加する
  const props = PropertiesService.getScriptProperties();
  if (!queue.length && !props.getProperty('BQ_MONTHLY_QUEUED')) {
    const lastMonth = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
    bqSites_().filter(s => s.ga4).forEach(site => {
      for (let m = BACKFILL_GA4_FROM; m <= lastMonth; m = shiftYm_(m, 1)) queue.push(['ga4m', site.configRow, m]);
    });
    props.setProperty('BQ_MONTHLY_QUEUED', '1');
    console.log('月単位の取り込みを追加しました：' + queue.length + '件');
  }
  const sites = Object.fromEntries(bqSites_().map(s => [s.configRow, s]));
  const errors = [];
  const yesterday = ymd_(addDays_(new Date(), -1));
  while (queue.length && Date.now() - started < 4.5 * 60 * 1000) {
    const [kind, row, ym] = queue.shift();
    const site = sites[row];
    if (!site) continue;
    const [s, eFull] = ymRange_(ym);
    const e = eFull > yesterday ? yesterday : eFull;
    if (s > e) continue;
    if (kind === 'ga4') runStep_('過去分GA4', site, s, e, () => collectGA4Range_(site, s, e), errors);
    else if (kind === 'ga4m') runStep_('過去分GA4月次', site, s, e, () => collectGA4Month_(site, ym), errors);
    else runStep_('過去分SC', site, s, e, () => collectSCRange_(site, s, e), errors);
  }
  saveQueue_(queue);
  flushJobLog_();
  if (queue.length || !props.getProperty('BQ_MONTHLY_QUEUED')) {
    ScriptApp.newTrigger('backfillStep').timeBased().after(60 * 1000).create();
    console.log('残り ' + queue.length + ' 件。1分後に続きを実行します');
  } else {
    console.log('過去分の取り込みが完了しました');
  }
  if (errors.length) console.warn(errors.join('\n'));
}

/** 取り込みの残り件数を確認する */
function backfillStatus() {
  console.log('残り ' + loadQueue_().length + ' 件');
}

// ===== 収集処理 =====
function collectGA4Range_(site, s, e) {
  const prop = 'properties/' + site.ga4;
  const dimensionFilter = pathFilter_(site.paths);
  const channelDim = site.paths && site.paths.length ? 'sessionPrimaryChannelGroup' : 'sessionDefaultChannelGroup';
  const metrics = ['screenPageViews', 'sessions', 'totalUsers', 'activeUsers', 'newUsers', 'userEngagementDuration', 'keyEvents'].map(name => ({ name }));
  const now = new Date().toISOString();
  const toRow = (date, channel, v) => ({
    date: isoDate_(date), media: site.tab, block: site.block || '', channel,
    pageviews: +v[0].value, sessions: +v[1].value, total_users: +v[2].value, active_users: +v[3].value,
    new_users: +v[4].value, engagement_sec: +v[5].value, key_events: +v[6].value, collected_at: now,
  });
  const rows = [];
  // 日別の合計（ユーザー数はチャネル別を足すと重複するので、合計行を別に持つ）
  runAllPages_(prop, { dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: 'date' }], metrics, dimensionFilter })
    .forEach(r => rows.push(toRow(r.dimensionValues[0].value, '(all)', r.metricValues)));
  runAllPages_(prop, { dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: 'date' }, { name: channelDim }], metrics, dimensionFilter })
    .forEach(r => rows.push(toRow(r.dimensionValues[0].value, r.dimensionValues[1].value, r.metricValues)));
  replaceRows_('ga4_daily', site, s, e, rows);

  const regions = runAllPages_(prop, {
    dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: 'date' }, { name: 'region' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'keyEvents' }], dimensionFilter,
  }).map(r => ({
    date: isoDate_(r.dimensionValues[0].value), media: site.tab, block: site.block || '', region: r.dimensionValues[1].value,
    pageviews: +r.metricValues[0].value, sessions: +r.metricValues[1].value, key_events: +r.metricValues[2].value, collected_at: now,
  }));
  replaceRows_('ga4_region_daily', site, s, e, regions);
  return rows.length + regions.length;
}

/** 月単位の値（合計行＋チャネル別）。今月は昨日までの値 */
function collectGA4Month_(site, ym) {
  const [s, eFull] = ymRange_(ym), yesterday = ymd_(addDays_(new Date(), -1));
  const e = eFull > yesterday ? yesterday : eFull;
  if (s > e) return 0;
  const prop = 'properties/' + site.ga4;
  const dimensionFilter = pathFilter_(site.paths);
  const channelDim = site.paths && site.paths.length ? 'sessionPrimaryChannelGroup' : 'sessionDefaultChannelGroup';
  const metrics = ['screenPageViews', 'sessions', 'totalUsers', 'activeUsers', 'newUsers', 'userEngagementDuration', 'keyEvents'].map(name => ({ name }));
  const now = new Date().toISOString();
  const toRow = (channel, v) => ({
    month: s, media: site.tab, block: site.block || '', channel,
    pageviews: +v[0].value, sessions: +v[1].value, total_users: +v[2].value, active_users: +v[3].value,
    new_users: +v[4].value, engagement_sec: +v[5].value, key_events: +v[6].value, collected_at: now,
  });
  const rows = [];
  runAllPages_(prop, { dateRanges: [{ startDate: s, endDate: e }], metrics, dimensionFilter })
    .forEach(r => rows.push(toRow('(all)', r.metricValues)));
  runAllPages_(prop, { dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: channelDim }], metrics, dimensionFilter })
    .forEach(r => rows.push(toRow(r.dimensionValues[0].value, r.metricValues)));
  replaceRows_('ga4_monthly', site, s, s, rows, 'month');
  return rows.length;
}

/** GA4 のページ別の月次（サイト全体の行だけ。ディレクトリの行は同じサイトなので取らない） */
function collectGA4PagesMonth_(site, ym) {
  const [s, eFull] = ymRange_(ym), yesterday = ymd_(addDays_(new Date(), -1));
  const e = eFull > yesterday ? yesterday : eFull;
  if (s > e) return 0;
  const now = new Date().toISOString();
  const rows = runAllPages_('properties/' + site.ga4, { dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: 'pagePath' }], metrics: ['screenPageViews', 'sessions', 'keyEvents'].map(name => ({ name })) })
    .map(r => ({ month: s, media: site.tab, page_path: r.dimensionValues[0].value, pageviews: +r.metricValues[0].value, sessions: +r.metricValues[1].value, key_events: +r.metricValues[2].value, collected_at: now }))
    .filter(r => r.pageviews > 0 || r.sessions > 0);
  replaceRows_('ga4_page_monthly', site, s, s, rows, 'month');
  return rows.length;
}
/** 手動：GA4 のページ別の月次を過去12か月分まとめて取る（初回だけ実行） */
function backfillGA4Pages() {
  checkProject_();
  ensureTables_();
  const errors = [], today = new Date(), log = [];
  const cur = Utilities.formatDate(addDays_(today, -1), TZ, 'yyyy-MM');
  // 取り込み済みの月はとばす（6分の実行時間制限で止まっても、もう一度実行すれば続きから）
  const done = {};
  (bqQuery_("SELECT media, FORMAT_DATE('%Y-%m', month) ym FROM `" + BQ_PROJECT + '.' + BQ_DATASET + ".ga4_page_monthly` GROUP BY 1, 2").rows || []).forEach(r => { done[r.f[0].v + '|' + r.f[1].v] = true; });
  const started = Date.now();
  let rest = 0;
  bqSites_().filter(site => site.ga4 && !site.block).forEach(site => {
    let n = 0;
    for (let i = 12; i >= 0; i--) {
      const ym = shiftYm_(cur, -i);
      if (done[site.tab + '|' + ym] && ym !== cur) continue;
      if (Date.now() - started > 4.5 * 60 * 1000) { rest++; continue; }   // 時間切れの前に止める
      runStep_('月次GA4ページ', site, ym + '-01', ymRange_(ym)[1], () => { n += collectGA4PagesMonth_(site, ym); }, errors);
    }
    log.push(site.tab + ' ' + n + '行');
  });
  flushJobLog_();
  console.log('GA4ページ別（過去12か月）：' + log.join('／') + (rest ? '／時間切れのため残り ' + rest + 'か月分。もう一度実行してください' : '／すべて完了'));
  if (errors.length) throw new Error('失敗したものがあります\n' + errors.join('\n'));
}

/** Search Console のプロパティ。ディレクトリの行に入っていなければ、同じタブ（サイト）の行のものを使う */
function scProp_(site) {
  if (site.sc) return site.sc;
  if (!site.block || !site.paths || !site.paths.length) return '';
  const parent = getSites_(true).find(x => x.tab === site.tab && !x.block);
  return parent ? parent.sc : '';
}
function scQuery_(prop, s, e, pageContains) {
  const body = { startDate: s, endDate: e, dimensions: ['date'], rowLimit: 25000 };
  if (pageContains) body.dimensionFilterGroups = [{ filters: [{ dimension: 'page', operator: 'contains', expression: pageContains }] }];
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(prop) + '/searchAnalytics/query',
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    let msg = res.getContentText();
    try { msg = JSON.parse(msg).error.message; } catch (ignore) {}
    throw new Error('Search Console API（' + res.getResponseCode() + '）：' + msg);
  }
  return JSON.parse(res.getContentText()).rows || [];
}
/** サイト全体は1回、ディレクトリはページパスごとに取り、日ごとに足す（掲載順位は表示回数で重みづけ） */
function collectSCRange_(site, s, e) {
  const prop = scProp_(site);
  if (!prop) return 0;
  const filters = site.block ? site.paths.map(p => p.replace(/\/+$/, '') + '/') : [site.scFilter || ''];
  const byDate = {};
  filters.forEach(f => scQuery_(prop, s, e, f).forEach(r => {
    const d = byDate[r.keys[0]] = byDate[r.keys[0]] || { imp: 0, clicks: 0, posW: 0 };
    d.imp += r.impressions; d.clicks += r.clicks; d.posW += r.position * r.impressions;
  }));
  const now = new Date().toISOString();
  const rows = Object.entries(byDate).map(([date, d]) => ({
    date, media: site.tab, block: site.block || '', impressions: d.imp, clicks: d.clicks,
    ctr: d.imp ? d.clicks / d.imp : 0, position: d.imp ? d.posW / d.imp : 0, collected_at: now,
  }));
  replaceRows_('sc_daily', site, s, e, rows);
  return rows.length;
}

/** ディレクトリ別の Search Console の過去分（16か月）だけを取り込む。1回だけ手動で実行 */
function backfillSCBlocks() {
  checkProject_();
  const queue = loadQueue_();
  const thisMonth = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const scFrom = shiftYm_(thisMonth, -SC_KEEP_MONTHS);
  let n = 0;
  bqSites_().filter(site => site.block && scProp_(site)).forEach(site => {
    for (let m = scFrom; m <= thisMonth; m = shiftYm_(m, 1)) { queue.push(['sc', site.configRow, m]); n++; }
  });
  saveQueue_(queue);
  console.log('ディレクトリ別 Search Console の取り込み：' + n + '件（ディレクトリ×月）を追加しました');
  backfillStep();
}

/** GA4 のレポートを全ページ取得（1回あたり最大10万行） */
function runAllPages_(prop, req) {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = AnalyticsData.Properties.runReport(Object.assign({}, req, { limit: 100000, offset }), prop);
    const rows = res.rows || [];
    out.push.apply(out, rows);
    offset += rows.length;
    if (!rows.length || offset >= (res.rowCount || 0)) break;
  }
  return out;
}

// ===== BigQuery 書き込み =====
/** 同じメディア・期間の行を消してから入れ直す（何度実行しても重複しない） */
function replaceRows_(table, site, s, e, rows, dateField) {
  const hasBlock = BQ_TABLES[table].some(f => f[0] === 'block');
  const params = [
    { name: 'media', parameterType: { type: 'STRING' }, parameterValue: { value: site.tab } },
    { name: 's', parameterType: { type: 'DATE' }, parameterValue: { value: s } },
    { name: 'e', parameterType: { type: 'DATE' }, parameterValue: { value: e } },
  ];
  let where = 'media = @media AND ' + (dateField || 'date') + ' BETWEEN @s AND @e';
  if (hasBlock) {
    where += ' AND block = @block';
    params.push({ name: 'block', parameterType: { type: 'STRING' }, parameterValue: { value: site.block || '' } });
  }
  bqQuery_('DELETE FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + table + '` WHERE ' + where, params);
  bqLoad_(table, rows);
}

function bqLoad_(table, rows, writeDisposition) {
  if (!rows.length) return;
  const blob = Utilities.newBlob(rows.map(r => JSON.stringify(r)).join('\n'), 'application/octet-stream');
  const job = BigQuery.Jobs.insert({
    configuration: { load: {
      destinationTable: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: table },
      sourceFormat: 'NEWLINE_DELIMITED_JSON', writeDisposition: writeDisposition || 'WRITE_APPEND',
    } },
  }, BQ_PROJECT, blob);
  waitJob_(job.jobReference);
}

function bqQuery_(sql, params) {
  const res = BigQuery.Jobs.query({
    query: sql, useLegacySql: false, location: BQ_LOCATION,
    parameterMode: params && params.length ? 'NAMED' : undefined, queryParameters: params,
  }, BQ_PROJECT);
  if (!res.jobComplete) waitJob_(res.jobReference);
  return res;
}

function waitJob_(ref) {
  for (let i = 0; i < 60; i++) {
    const j = BigQuery.Jobs.get(BQ_PROJECT, ref.jobId, { location: ref.location || BQ_LOCATION });
    if (j.status.state === 'DONE') {
      if (j.status.errorResult) throw new Error('BigQuery：' + j.status.errorResult.message);
      return j;
    }
    Utilities.sleep(1000);
  }
  throw new Error('BigQuery のジョブが60秒以内に終わりませんでした：' + ref.jobId);
}

// ===== 実行記録（読み込みジョブの回数を抑えるため、まとめて最後に書く） =====
let JOB_LOG_BUFFER = [];
function runStep_(job, site, s, e, fn, errors) {
  const name = site.block ? site.tab + '／' + site.block : site.tab;
  const push = (status, message) => JOB_LOG_BUFFER.push({ run_at: new Date().toISOString(), job, media: name, date_from: s, date_to: e, status, message: String(message).slice(0, 1000) });
  try {
    push('OK', fn() + '行');
  } catch (err) {
    errors.push(job + ' ' + name + ' ' + s + '〜' + e + '：' + err.message);
    push('ERROR', err.message);
  }
}
function flushJobLog_() {
  try { bqLoad_('job_log', JOB_LOG_BUFFER); } catch (e) { console.warn('job_log の書き込みに失敗：' + e.message); }
  JOB_LOG_BUFFER = [];
}

// ===== 補助 =====
function checkProject_() {
  if (!BQ_PROJECT) throw new Error('bigquery.gs の BQ_PROJECT にプロジェクトIDを入れてください');
}
function bqSites_() { return getSites_(true).filter(s => s.ga4 || s.sc); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function addDays_(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function isoDate_(yyyymmdd) { return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8); }
function shiftYm_(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return Utilities.formatDate(d, TZ, 'yyyy-MM'); }
function ymRange_(ym) { const [y, m] = ym.split('-').map(Number); return [ymd_(new Date(y, m - 1, 1)), ymd_(new Date(y, m, 0))]; }
// スクリプトプロパティは1件9KBまでなので、分割して保存する
function saveQueue_(q) {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.indexOf('BQ_QUEUE_') === 0).forEach(k => props.deleteProperty(k));
  const text = q.map(x => x.join('|')).join(',');
  for (let i = 0, n = 0; i < text.length; i += 8000, n++) props.setProperty('BQ_QUEUE_' + n, text.slice(i, i + 8000));
}
function loadQueue_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const text = Object.keys(all).filter(k => k.indexOf('BQ_QUEUE_') === 0)
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))).map(k => all[k]).join('');
  return text ? text.split(',').map(x => { const [kind, row, ym] = x.split('|'); return [kind, Number(row), ym]; }) : [];
}
