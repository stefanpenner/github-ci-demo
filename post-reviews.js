const crypto = require('crypto');
const fs = require('fs');
const { execSync } = require('child_process');

const REPO = 'stefanpenner/github-ci-demo';
const PR_NUMBER = 1;

async function getInstallationToken(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: pem, padding: crypto.constants.RSA_PKCS1_V1_5 }).toString('base64url');
  const jwt = `${header}.${payload}.${signature}`;
  const installResp = await fetch(`https://api.github.com/repos/${REPO}/installation`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  const installation = await installResp.json();
  const tokenResp = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  return (await tokenResp.json()).token;
}

async function ghApi(method, path, token, body) {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) console.error(`  ❌ ${method} ${path}:`, data.message, JSON.stringify(data.errors || ''));
  return { ok: resp.ok, data };
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log('Posting review examples...\n');

  // ── 1. REQUEST_CHANGES — bot blocks the PR until issues are fixed ──
  console.log('1. REQUEST_CHANGES review (Security Bot)...');
  const { ok: ok1 } = await ghApi('POST', `/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, token, {
    commit_id: sha,
    event: 'REQUEST_CHANGES',
    body: [
      '## 🔒 Security Review — Changes Requested\n',
      'Found **1 critical issue** that must be fixed before this PR can be merged.\n',
      'This review will block merging until the issue is resolved and a new review is submitted.',
    ].join('\n'),
    comments: [
      {
        path: 'src/auth.ts',
        line: 5,
        body: [
          '### 🔴 Critical: Token validation is a no-op\n',
          'This function accepts any non-empty string as a valid token.',
          'An attacker can pass `Authorization: Bearer x` and bypass auth entirely.\n',
          '**Required fix:**\n',
          '```suggestion',
          '  return verifyJWT(token, { issuer: "auth.example.com", algorithms: ["RS256"] });',
          '```\n',
          '> This review was posted by **Security Bot**. If you believe this is a false positive,',
          '> comment `/security dismiss` with a justification.',
        ].join('\n'),
      },
    ],
  });
  console.log(ok1 ? '  ✅ Created' : '  ❌ Failed');

  // ── 2. COMMENT — informational, doesn't block ──
  console.log('2. COMMENT review (Docs Bot)...');
  const { ok: ok2 } = await ghApi('POST', `/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, token, {
    commit_id: sha,
    event: 'COMMENT',
    body: [
      '## 📝 Documentation Review\n',
      'No blocking issues. A few suggestions for improvement.',
    ].join('\n'),
    comments: [
      {
        path: 'src/auth.ts',
        line: 4,
        body: [
          'Consider documenting the expected token format:\n',
          '```suggestion',
          '  // TODO: check expiry, signature, issuer (expects RS256 JWT from auth.example.com)',
          '```',
        ].join('\n'),
      },
    ],
  });
  console.log(ok2 ? '  ✅ Created' : '  ❌ Failed');

  // ── 3. PR comment explaining the review system ──
  console.log('3. PR comment: review summary...');
  const { ok: ok3 } = await ghApi('POST', `/repos/${REPO}/issues/${PR_NUMBER}/comments`, token, {
    body: [
      '## 🔍 Automated Review Summary\n',
      '| Bot | Verdict | Details |',
      '|-----|---------|---------|',
      '| 🔒 Security Bot | ❌ Changes Requested | 1 critical finding — token validation bypass |',
      '| 📝 Docs Bot | 💬 Comment | 1 suggestion — add token format docs |',
      '| 🧪 Test Bot | ✅ Approved | Coverage threshold met |',
      '',
      '### Review policy for this repo\n',
      '| Requirement | Status |',
      '|-------------|--------|',
      '| 2 human approvals | ❌ 0/2 |',
      '| CODEOWNERS (`src/auth/` → @security-team) | ❌ Pending |',
      '| Security Bot approval | ❌ Changes requested |',
      '| CI checks passing | ❌ 2 failing |',
      '| No unresolved threads | ❌ 3 unresolved |',
      '',
      '<details>',
      '<summary><strong>CODEOWNERS for this PR</strong></summary>\n',
      '```',
      'src/auth.ts → @acme/security-team (required)',
      'src/api.ts  → @acme/backend-team (required)',
      '```',
      '</details>\n',
      '---',
      '*🤖 Posted by Review Orchestrator*',
    ].join('\n'),
  });
  console.log(ok3 ? '  ✅ Created' : '  ❌ Failed');

  // ── 4. Check run: review gate ──
  console.log('4. Check run: review gate...');
  const { ok: ok4 } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
    name: 'Review Gate',
    head_sha: sha,
    status: 'completed',
    conclusion: 'action_required',
    output: {
      title: 'Awaiting required approvals',
      summary: [
        '## Review Gate\n',
        'This check tracks all required approvals and blocks merging until they\'re met.\n',
        '| Requirement | Status | Who |',
        '|-------------|--------|-----|',
        '| Human approval (1 of 2) | ⏳ Pending | Anyone with write access |',
        '| Human approval (2 of 2) | ⏳ Pending | Anyone with write access |',
        '| CODEOWNERS: `src/auth/` | ⏳ Pending | @acme/security-team |',
        '| CODEOWNERS: `src/api/` | ⏳ Pending | @acme/backend-team |',
        '| Security Bot | ❌ Changes Requested | Automated |',
        '| Docs Bot | ✅ No objections | Automated |',
        '\n> This check will automatically update when reviews are submitted.',
      ].join('\n'),
    },
    actions: [
      { label: 'Request reviews', description: 'Ping required reviewers', identifier: 'request_reviews' },
      { label: 'Bypass', description: 'Admin override', identifier: 'admin_bypass' },
    ],
  });
  console.log(ok4 ? '  ✅ Created' : '  ❌ Failed');

  console.log(`\nDone! https://github.com/${REPO}/pull/${PR_NUMBER}`);
}

main().catch(console.error);
