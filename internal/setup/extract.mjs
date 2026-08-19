// Prototype: extract Slack xoxc token + xoxd cookie via a headed browser.
// Prints a single JSON line to stdout on success: {"ok":true,"token":"xoxc-...","cookie":"xoxd-...","domain":"host"}
// or {"ok":false,"error":"..."} on failure. All human-facing chatter goes to stderr.
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';

const profileDir = path.join(os.homedir(), '.cache', 'worktree', 'browser-profile');
const log = (...a) => console.error(...a);

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  const first = ctx.pages()[0] || (await ctx.newPage());
  await first.goto('https://slack.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});

  log('A browser window is open. Log into your Slack workspace if prompted.');
  log('(Logging in may open a workspace picker and then the app in a new tab —');
  log(' that is expected; just finish launching your workspace.)');
  log('Waiting for a session token to appear (up to 5 minutes)...');

  // The login flow spawns new pages (SSO, workspace picker, then the real
  // client), so the token won't appear on the original page. Poll EVERY page
  // in the context — including ones opened after launch — and take the token
  // from whichever page has it. Reading token from localStorage AND the "d"
  // cookie from the context is what we need.
  const readToken = (p) =>
    p
      .evaluate(() => {
        try {
          const c = JSON.parse(localStorage.localConfig_v2 || '{}');
          for (const t of Object.values(c.teams || {})) {
            if (typeof t?.token === 'string' && t.token.startsWith('xoxc-')) return t.token;
          }
        } catch {}
        return null;
      })
      .catch(() => null);

  const deadline = Date.now() + 5 * 60 * 1000;
  let token = null;
  while (Date.now() < deadline && !token) {
    for (const p of ctx.pages()) {
      // Only bother with pages that are on a slack.com host.
      let host = '';
      try {
        host = new URL(p.url()).host;
      } catch {}
      if (!host.endsWith('slack.com')) continue;
      token = await readToken(p);
      if (token) break;
    }
    if (token) break;
    await first.waitForTimeout(1500).catch(() => {});
  }

  if (!token) {
    console.log(JSON.stringify({ ok: false, error: 'timed out waiting for login/token' }));
    await ctx.close();
    process.exit(0);
  }

  // The "d" cookie is context-wide; check both the canonical hosts.
  const cookies = await ctx.cookies(['https://app.slack.com', 'https://slack.com']);
  const d = cookies.find((c) => c.name === 'd');
  if (!d) {
    console.log(JSON.stringify({ ok: false, error: 'token found but d cookie missing' }));
    await ctx.close();
    process.exit(0);
  }

  console.log(JSON.stringify({ ok: true, token, cookie: d.value }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
} finally {
  await ctx.close();
}
