/**
 * AIチームの Google Chat 通知（2026-11-06 ユーザー指定：スペースに、それぞれのキャラが何をしたかを通知。キャラごとにアイコンを変える）
 * ・送り先はスペースの Webhook（Secret Manager「ai_loop_keys」の chat.url。画面の API・連携設定 → AIツール の欄から入れる）
 * ・1通ごとにカードの見出しをキャラにする（名前・役割・AIとモデル・アイコン）。Webhook の名前（送り主）は Webhook を作ったときのまま
 * ・1回の答え合わせ（run_id）の通知は同じスレッドにまとめる
 * サーバー（sim.js のテスト送信）と答え合わせのタスク（scripts/sim_check_fs.js）で共通
 */
const TEAMDEF = require('./ai_team.json');
const PV = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };
const isWebhook = u => /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/?#]+\/messages\?[^\s]*key=[^\s&]+[^\s]*token=/.test(String(u || ''));
/** カードを作る。agent＝キャラ（ai_team.json の agents の1つ。model を上書きしたもの可）、text＝本文（<b> などの簡単な書式可）、opt.link＝ボタン */
function card(agent, text, opt) {
  opt = opt || {};
  const widgets = [{ textParagraph: { text: String(text || '').slice(0, 3500) } }];
  if (opt.link) widgets.push({ buttonList: { buttons: [{ text: opt.linkText || 'AIツールを開く', onClick: { openLink: { url: opt.link } } }] } });
  return { cardsV2: [{ cardId: 'ai-' + agent.id, card: {
    header: { title: agent.char + (agent.role && !String(agent.char).includes(agent.role) ? '（' + agent.role + '）' : ''), subtitle: (PV[agent.provider] || '') + '・' + (agent.model || ''), imageUrl: TEAMDEF.iconBase + agent.id + '.png', imageType: 'CIRCLE', imageAltText: agent.char },
    sections: [{ widgets }] } }] };
}
/** 送る。thread を渡すと、その名前のスレッドにまとめる */
async function post(url, agent, text, opt) {
  opt = opt || {};
  if (!isWebhook(url)) throw new Error('Webhook の URL の形が違います');
  const u = url + (opt.thread ? '&threadKey=' + encodeURIComponent(opt.thread) + '&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : '');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(card(agent, text, opt)), signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('Google Chat に送れませんでした（' + r.status + '：' + t.slice(0, 160) + '）'); }
  return true;
}
module.exports = { card, post, isWebhook, TEAMDEF };
