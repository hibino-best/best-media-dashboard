---
name: system-map-updates
description: "Every dashboard update must also update webapp/system-map.json (version, updated date, changelog, and any changed jobs/flows/stores)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a24bb8aa-2fcd-4241-b397-5ab9b4310f17
  modified: 2026-10-10T12:17:28.273Z
---

Each time the BEST media web app is updated, also update `webapp/system-map.json`. That file feeds the 「システム構造」 page and the 「Ver」 badge at the top right.
- Set `version` to "1.<asset ?v number>". For example, index.html ?v=86 means version 1.86.
- Set `updated` to the date.
- Prepend a `changelog` entry written in plain Japanese.
- Edit `schedule`, `flows`, `stores` or `lanes` when a job, data source, table or schedule changes.

**Why:** On 2026-10-10 the user asked that the システム構造 page be refreshed with every web-app update, with the version visible, so non-technical staff can see what runs when and how things connect.

**How to apply:** Do this before each deploy, together with [[deploy-checks]]. The server loads the JSON at startup, so it needs no code change. Admin memos per schedule item live in Firestore settings/system_notes. Do not overwrite them.
