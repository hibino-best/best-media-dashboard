---
name: feedback-confirm-schedule-method
description: 定期実行を設定する前に、クラウドのルーティン／アプリのScheduled／タスクスケジューラー＋claude -p のどれにするか必ず確認する
metadata:
  node_type: memory
  type: feedback
  originSessionId: d0dc2eca-4ed3-4b34-aa04-00c679608e96
  modified: 2026-10-10T12:06:55.538Z
---

ルーティンや定期実行を設定するときは、作成前に必ず方式（クラウドのルーティン／Claude アプリの Scheduled タスク／タスクスケジューラー＋`claude -p`）をユーザーに確認する。違いとおすすめを添えて選んでもらう。

**Why:** 2026-10-10 にユーザーが「どのチャットでも必ず確認して」と依頼した。最初の毎朝リサーチは確認せずにアプリの Scheduled で作り、あとでクラウドに作り直す手間がかかった（[[daily-emergency-research-routine]]）。
**How to apply:** 全チャット共通にするため `~/.claude/CLAUDE.md` にも同じ指示を書いてある。
