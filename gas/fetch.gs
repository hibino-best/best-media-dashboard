/**
 * GA4 / Search Console からの取得
 * 返す値のキーは、シートの行を表すキー（sheet.gs の findRows_ と同じ）
 */

// GA4 のチャネル名 → シートB列の表記
const CHANNEL_MAP = {
  'Organic Search': 'Organic Search',
  'Direct': 'Direct',
  'Organic Social': 'Social',
  'Referral': 'Referral',
  'Paid Search': 'Paid Search',
  'AI Assistant': 'AI Assistant',
  'Unassigned': 'Unassingned',          // シート側の綴りに合わせる
};
const CHANNELS = ['Organic Search', 'Direct', 'Social', 'Referral', 'Paid Search', 'AI Assistant', 'Unassingned'];

/**
 * ディレクトリ別の絞り込み。探索レポートの設定に合わせる：
 *  - ページ ロケーション が paths のどれかを「含む」（末尾の / は外す：'/cockroach/' → '/cockroach'）
 *  - セッションの参照元 が '(not set)' を「含まない」
 * paths が空（サイト全体）なら絞らない。
 */
function pathFilter_(paths) {
  if (!paths || !paths.length) return undefined;
  const pages = paths.map(p => ({
    filter: { fieldName: 'pageLocation', stringFilter: { matchType: 'CONTAINS', value: p.replace(/\/+$/, '') } },
  }));
  const notSet = { notExpression: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value: '(not set)' } } } };
  return { andGroup: { expressions: [pages.length === 1 ? pages[0] : { orGroup: { expressions: pages } }, notSet] } };
}

function fetchGA4_(propertyId, s, e, paths) {
  const prop = 'properties/' + propertyId;
  const dateRanges = [{ startDate: s, endDate: e }];
  const dimensionFilter = pathFilter_(paths);
  // チャネル列：サイト全体は「デフォルト チャネル グループ」、ディレクトリ別は探索レポートと同じ「メインのチャネル グループ」
  const channelDim = paths && paths.length ? 'sessionPrimaryChannelGroup' : 'sessionDefaultChannelGroup';
  const out = {};

  const totals = AnalyticsData.Properties.runReport({
    dateRanges,
    dimensionFilter,
    metrics: [
      { name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' },
      { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'userEngagementDuration' },
      { name: 'keyEvents' },
    ],
  }, prop);
  // 該当ページへのアクセスが0件の月は rows が返らないので全部0にする
  const t = totals.rows && totals.rows.length
    ? totals.rows[0].metricValues.map(v => Number(v.value))
    : [0, 0, 0, 0, 0, 0, 0];
  const [pv, sessions, totalUsers, activeUsers, newUsers, engagement, keyEvents] = t;
  out['PAGEVIEW'] = pv;
  out['SESSION'] = sessions;
  out['UNIQUEUSER'] = totalUsers;
  out['アクティブユーザー'] = activeUsers;
  out['新規ユーザー'] = newUsers;
  out['アクティブユーザーあたりのビュー'] = activeUsers ? Math.round(pv / activeUsers * 100) / 100 : 0;
  // 探索レポートの「セッションあたりの平均エンゲージメント時間」に合わせる（秒）
  // GA4の画面は秒を切り捨てて表示しているので floor
  out['平均エンゲージメント時間'] = sessions ? Math.floor(engagement / sessions) : 0;
  out.KEY_EVENTS = keyEvents;          // CALL = KEY_EVENTS − シートのFORM（sheet.gs で確定）

  CHANNELS.forEach(c => { out['PV:' + c] = 0; out['SES:' + c] = 0; });
  const ch = AnalyticsData.Properties.runReport({
    dateRanges,
    dimensionFilter,
    dimensions: [{ name: channelDim }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
  }, prop);
  (ch.rows || []).forEach(row => {
    const label = CHANNEL_MAP[row.dimensionValues[0].value];
    if (!label) return;
    out['PV:' + label] = Number(row.metricValues[0].value);
    out['SES:' + label] = Number(row.metricValues[1].value);
  });
  return out;
}

function fetchSC_(siteUrl, pageFilter, s, e) {
  const body = { startDate: s, endDate: e };
  if (pageFilter) {
    body.dimensionFilterGroups = [{ filters: [{ dimension: 'page', operator: 'contains', expression: pageFilter }] }];
  }
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) {
    let msg = res.getContentText();
    try { msg = JSON.parse(msg).error.message; } catch (ignore) {}
    throw new Error('Search Console API（' + res.getResponseCode() + '）：' + msg);
  }
  const r = (JSON.parse(res.getContentText()).rows || [{}])[0];
  return {
    'searchconsole合計表示回数': r.impressions || 0,
    '合計クリック数': r.clicks || 0,
    '平均CTR': Math.round((r.ctr || 0) * 1000) / 1000,       // 0.009 形式
    '平均掲載順位': Math.round((r.position || 0) * 10) / 10, // 5.7 形式
  };
}
