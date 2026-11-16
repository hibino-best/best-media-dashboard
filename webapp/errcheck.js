/**
 * AIエラーチェッカー（2026-11-13 ユーザー指定）：AIツールの中。AI MEDIAシミュレーションと同じ作り（Supabase＝AIの作業机）
 * ・週次のタスク（scripts/err_check.ps1 → 受付係 scripts/err_check_fs.js）が Supabase に点検の材料・報告・指摘・実行・費用を入れる
 * ・画面はここから読むだけ。あなたの判断（OK／却下と理由）だけをここで書く（err_decisions）。いまは内ループ：OKした指摘をチャットで直す
 * ・見られるのは AIツールの権限（ai_tools）があり、AIエラーチェッカーの権限（ai_errcheck）がある人。判断はフル管理者
 */
const TEAM = require('./ai_errcheck_team.json').agents;
module.exports = function errcheck({ supa, isFullAdmin, capOk, usdJpy }) {
  const ok = u => capOk(u, 'ai_tools', () => false) && capOk(u, 'ai_errcheck', () => false);
  const ready = async () => { if (!(supa && await supa.ready())) return false; try { await supa.rest('GET', 'err_checks?select=run_id&limit=1'); return true; } catch (e) { return false; } };
  /** 判断がまだの指摘の数（タスク通知に出す） */
  async function pending() {
    if (!(await ready())) return { count: 0, runs: [] };
    const [checks, finds, decs] = await Promise.all([supa.rest('GET', 'err_checks?select=run_id,at,status&order=at.desc&limit=20'), supa.rest('GET', 'err_findings?select=id,run_id,level&order=id.desc&limit=2000'), supa.rest('GET', 'err_decisions?select=finding_id&limit=5000')]);
    const done = new Set(decs.map(d => d.finding_id));
    /* 報告を読めなかった回（incomplete）は、同じ種類（週次／デプロイ前／データ修正前）のあとの点検が終わったら数えない（2026-11-16 AIエラーチェッカーの指摘 #4・#12） */
    const kindOf = id => (String(id).match(/^(pre|data)_/) || [])[1] || 'weekly';
    const superseded = c => checks.some(x => kindOf(x.run_id) === kindOf(c.run_id) && x.at > c.at && x.status !== 'incomplete' && x.status !== 'running');
    const runs = checks.map(c => { const f = finds.filter(x => x.run_id === c.run_id && !done.has(x.id)); return { run_id: c.run_id, at: c.at, status: c.status, open: f.length, high: f.filter(x => x.level === '高').length }; }).filter(r => r.open || (r.status === 'incomplete' && !superseded(r)));
    return { count: runs.reduce((s, r) => s + (r.open || 1), 0), runs };
  }
  function routes(api) {
    /* チーム・実行・費用・だれが何を読んだか・点検の一覧 */
    api.get('/errcheck', async (req, res, next) => {
      try {
        if (!ok(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        res.set('Cache-Control', 'no-store');
        if (!(await ready())) return res.json({ ready: false, agents: TEAM, runs: [], cost: [], access: [], checks: [], fx: {} });
        const [runs, cost, access, checks, finds, decs] = await Promise.all([
          supa.rest('GET', 'ai_runs?select=*&run_id=like.err-*&order=started_at.desc&limit=60'),
          supa.rest('GET', 'ai_cost_log?select=*&run_id=like.err-*&order=at.desc&limit=2000'),
          supa.rest('GET', 'ai_access_log?select=*&run_id=like.err-*&order=at.desc&limit=300'),
          supa.rest('GET', 'err_checks?select=run_id,at,ended_at,loop,status,summary,note&order=at.desc&limit=30'),
          supa.rest('GET', 'err_findings?select=id,run_id,level&order=id.desc&limit=3000'),
          supa.rest('GET', 'err_decisions?select=finding_id,decision&limit=5000')]);
        const dmap = new Map(decs.map(d => [d.finding_id, d.decision]));
        checks.forEach(c => { const f = finds.filter(x => x.run_id === c.run_id); c.findings = f.length; c.high = f.filter(x => x.level === '高').length; c.ok = f.filter(x => dmap.get(x.id) === 'ok').length; c.ng = f.filter(x => dmap.get(x.id) === 'ng').length; c.open = f.length - c.ok - c.ng; });
        const fx = {}; for (const m of [...new Set(cost.map(r => String(r.at || '').slice(0, 7)).filter(Boolean))]) { try { fx[m] = (await usdJpy(m)).rate; } catch (e) { /* なし */ } }
        res.json({ ready: true, agents: TEAM.map(a => Object.assign({ connected: true, scope: a.ceiling }, a)), runs, cost, access, checks, fx, canDecide: isFullAdmin(req.user) });
      } catch (e) { next(e); }
    });
    /* 1回分の点検：報告・指摘・判断・材料 */
    api.get('/errcheck/:run', async (req, res, next) => {
      try {
        if (!ok(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        const run = String(req.params.run || ''); if (!/^((pre|data)_)?\d{8}_\d{4}$/.test(run)) return res.status(400).json({ error: '指定が正しくありません' });
        const [c] = await supa.rest('GET', 'err_checks?select=*&run_id=eq.' + run); if (!c) return res.status(404).json({ error: '見つかりません' });
        const finds = await supa.rest('GET', 'err_findings?select=*&run_id=eq.' + run + '&order=id.asc');
        const decs = finds.length ? await supa.rest('GET', 'err_decisions?select=*&finding_id=in.(' + finds.map(f => f.id).join(',') + ')&order=at.desc') : [];
        finds.forEach(f => { const d = decs.find(x => x.finding_id === f.id); if (d) f.decision = { decision: d.decision, reason: d.reason || '', by: d.decided_by || '', at: d.at }; });
        res.set('Cache-Control', 'no-store'); res.json({ check: c, findings: finds });
      } catch (e) { next(e); }
    });
    /* あなたの判断（内ループ）：OK＝直す／却下＝直さない（理由は必須。次から同じ指摘をさせない） */
    api.post('/errcheck/decision', async (req, res, next) => {
      try {
        if (!ok(req.user) || !isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが判断できます' });
        const b = req.body || {}, id = Number(b.finding_id), decision = b.decision, reason = String(b.reason || '').trim().slice(0, 2000);
        if (!id || !['ok', 'ng'].includes(decision)) return res.status(400).json({ error: '指定が正しくありません' });
        if (decision === 'ng' && !reason) return res.status(400).json({ error: '却下の理由を入れてください' });
        const [f] = await supa.rest('GET', 'err_findings?select=id,run_id&id=eq.' + id); if (!f) return res.status(404).json({ error: '指摘が見つかりません' });
        /* 1つの指摘に判断は1件（判断し直したら上書き。2026-11-16 AIエラーチェッカーの指摘 #6） */
        const row = { finding_id: id, run_id: f.run_id, decision, reason, decided_by: req.user.email || '', at: new Date().toISOString() };
        const old = await supa.rest('GET', 'err_decisions?select=id&finding_id=eq.' + id + '&order=at.desc');
        if (old.length) { await supa.rest('PATCH', 'err_decisions?id=eq.' + old[0].id, row, 'return=minimal'); if (old.length > 1) await supa.rest('DELETE', 'err_decisions?id=in.(' + old.slice(1).map(x => x.id).join(',') + ')', null, 'return=minimal'); }
        else await supa.rest('POST', 'err_decisions', [row], 'return=minimal');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes, pending };
};
