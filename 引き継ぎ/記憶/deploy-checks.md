---
name: deploy-checks
description: "Before every dashboard deploy, syntax-check both app.js and server.js and bump ?v= in index.html"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a24bb8aa-2fcd-4241-b397-5ab9b4310f17
  modified: 2026-10-10T03:26:21.199Z
---

Before deploying the BEST media dashboard (Cloud Run), always run `node --check` on BOTH webapp/public/app.js and webapp/server.js, and bump `?v=N` in public/index.html on every client change (including hotfixes).

**Why:** On 2026-10-10 a patch chain stopped at the server check, the broken app.js (a `//` comment swallowing the rest of a one-line arrow function) went live, and the web app showed a blank page. The fix redeploy without a version bump kept serving the cached broken file.

**How to apply:** Check each file separately (not in one `&&` chain that can skip the second). Never put `//` comments inside one-line code inserted by patch scripts; use `/* */`. After a deploy, open the live URL in the browser pane and confirm the login screen appears with no console errors.
