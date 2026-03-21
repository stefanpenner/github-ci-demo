// Demonstrates ALL the different ways a CI system can post UI onto a GitHub PR.
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
  if (!resp.ok) console.error(`  ❌ ${method} ${path}:`, data.message);
  return { ok: resp.ok, data };
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. CHECK RUN — with action buttons + images
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('1. Check Run with actions + images...');
  const { ok: ok1 } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
    name: 'Coverage Report',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    details_url: 'http://localhost:3457/pipeline',
    output: {
      title: '87.3% coverage (+1.2%)',
      summary: [
        '## Coverage Report\n',
        '| Metric | Value | Delta |',
        '|--------|-------|-------|',
        '| Statements | 87.3% | +1.2% |',
        '| Branches | 72.1% | -0.5% |',
        '| Functions | 91.0% | +3.0% |',
        '\n> Branch coverage decreased — consider adding tests for the new validation path.',
      ].join('\n'),
      // images: [{ alt: 'Coverage trend', image_url: 'https://...', caption: 'Last 30 days' }],
    },
    actions: [
      { label: 'Re-run', description: 'Re-run coverage checks', identifier: 'rerun_coverage' },
      { label: 'View full report', description: 'Open detailed report', identifier: 'view_report' },
    ],
  });
  console.log(ok1 ? '  ✅ Created' : '  ❌ Failed');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. PR COMMENT — rich markdown, tables, collapsible sections
  //    (This is what most bots use: Codecov, Dependabot, etc.)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('2. PR comment (bot-style summary)...');
  const { ok: ok2 } = await ghApi('POST', `/repos/${REPO}/issues/${PR_NUMBER}/comments`, token, {
    body: [
      '## 🔍 CI Pipeline Summary\n',
      '| Check | Status | Duration | Details |',
      '|-------|--------|----------|---------|',
      '| Setup | ✅ Pass | 4s | — |',
      '| ESLint | ⚠️ Warn | 12s | 2 warnings |',
      '| TypeScript | ✅ Pass | 8s | 0 errors |',
      '| Security Scan | ❌ Fail | 1m 23s | 2 vulnerabilities |',
      '| Unit Tests | ✅ Pass | 2m 45s | 47 passed |',
      '| Deploy Preview | ⛔ Blocked | — | Upstream failure |',
      '',
      '<details>',
      '<summary><strong>Security Scan Details</strong> (click to expand)</summary>',
      '',
      '### 🔴 HIGH: Weak password hashing',
      '**File:** `src/auth.ts:9`',
      '',
      '```typescript',
      '// WARNING: using a weak hashing approach',
      'return Buffer.from(password).toString(\'base64\');',
      '```',
      '',
      'Base64 is not a hash function — it\'s trivially reversible. Use `bcrypt` or `argon2`.',
      '',
      '### 🟡 MEDIUM: No token expiry check',
      '**File:** `src/auth.ts:3`',
      '',
      '`validateToken()` only checks for non-empty string. Missing: signature, expiry, issuer validation.',
      '',
      '</details>',
      '',
      '<details>',
      '<summary><strong>Coverage Diff</strong></summary>',
      '',
      '```diff',
      '  Statements: 87.3% (+1.2%)',
      '- Branches:   72.1% (-0.5%)',
      '+ Functions:  91.0% (+3.0%)',
      '  Lines:      88.4% (+1.1%)',
      '```',
      '',
      '</details>',
      '',
      '---',
      '*🤖 Posted by CI Pipeline • [View full dashboard](http://localhost:3457)*',
    ].join('\n'),
  });
  console.log(ok2 ? '  ✅ Created' : '  ❌ Failed');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. PR REVIEW with inline comments on specific lines
  //    (This is what code review bots use — appears in the
  //     "Files changed" tab like a human reviewer's comments)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('3. PR review with inline comments...');
  const { ok: ok3 } = await ghApi('POST', `/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, token, {
    commit_id: sha,
    event: 'COMMENT',
    body: '**CI Bot Review** — Found issues that should be addressed.',
    comments: [
      {
        path: 'src/auth.ts',
        line: 10,
        body: [
          '🔴 **Security: Weak password hashing**\n',
          '`base64` is encoding, not hashing. It\'s trivially reversible:\n',
          '```js',
          'Buffer.from(encoded, \'base64\').toString() // recovers plaintext',
          '```\n',
          'Replace with:',
          '```typescript',
          'import { hash } from \'bcrypt\';',
          'return await hash(password, 12);',
          '```\n',
          '> **Severity:** HIGH — blocks merge',
        ].join('\n'),
      },
      {
        path: 'src/auth.ts',
        line: 4,
        body: [
          '🟡 **TODO detected** — should this be a tracked issue?\n',
          'This TODO was just added but there\'s no linked issue.',
          'Consider creating a ticket so it doesn\'t get lost.',
        ].join('\n'),
      },
    ],
  });
  console.log(ok3 ? '  ✅ Created' : '  ❌ Failed');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. DEPLOYMENT STATUS — shows deploy preview in PR sidebar
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('4. Deployment status (PR sidebar)...');
  // Create a deployment first
  const { ok: ok4a, data: deployment } = await ghApi('POST', `/repos/${REPO}/deployments`, token, {
    ref: sha,
    environment: 'preview',
    description: 'Deploy preview for PR #1',
    auto_merge: false,
    required_contexts: [], // skip status checks for the deployment itself
  });
  if (ok4a) {
    // Set it as active with a URL
    const { ok: ok4b } = await ghApi('POST', `/repos/${REPO}/deployments/${deployment.id}/statuses`, token, {
      state: 'success',
      environment_url: 'http://localhost:3457',
      log_url: 'http://localhost:3457/pipeline',
      description: 'Preview deployed successfully',
    });
    console.log(ok4b ? '  ✅ Created' : '  ❌ Failed');
  } else {
    console.log('  ❌ Failed to create deployment');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. COMMIT STATUS — the classic simple status
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('5. Commit status (simple)...');
  const { ok: ok5 } = await ghApi('POST', `/repos/${REPO}/statuses/${sha}`, token, {
    state: 'success',
    target_url: 'http://localhost:3457/pipeline',
    description: 'All systems operational',
    context: 'ci/deploy-preview',
  });
  console.log(ok5 ? '  ✅ Created' : '  ❌ Failed');

  console.log(`\n🎉 Done! View the PR: https://github.com/${REPO}/pull/${PR_NUMBER}`);
  console.log('Check these tabs:');
  console.log('  • Conversation — bot comment + deployment badge');
  console.log('  • Files changed — inline review comments + annotations');
  console.log('  • Checks — check run with action buttons');
}

main().catch(console.error);
