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

async function createCheckRun(token, sha, checkRun) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ head_sha: sha, ...checkRun }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`Failed to create check run "${checkRun.name}":`, data);
    return null;
  }
  console.log(`✅ Check Run: "${checkRun.name}" → ${data.html_url}`);
  return data;
}

async function createDeployment(token, sha, env) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/deployments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: sha,
      environment: env.name,
      description: env.description,
      auto_merge: false,
      required_contexts: [],
      transient_environment: env.transient || false,
      production_environment: false,
    }),
  });
  const deployment = await resp.json();
  if (!resp.ok) {
    console.error(`  ❌ Deployment ${env.name}:`, deployment.message || JSON.stringify(deployment));
    return;
  }

  const statusResp = await fetch(
    `https://api.github.com/repos/${REPO}/deployments/${deployment.id}/statuses`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: env.state,
        environment_url: env.url,
        log_url: env.logUrl,
        description: env.statusDescription,
        auto_inactive: false,
      }),
    }
  );
  if (statusResp.ok) {
    console.log(`✅ Deployment: "${env.name}" (${env.state}) → ${env.url}`);
  } else {
    const err = await statusResp.json();
    console.error(`  ❌ Deployment status ${env.name}:`, err.message);
  }
}

async function createPRComment(token, body) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('Failed to create PR comment:', data);
    return null;
  }
  console.log(`✅ PR Comment posted → ${data.html_url}`);
  return data;
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);
  console.log(`Authenticated. Posting extra examples on ${sha.slice(0, 8)}...\n`);

  // ── 1. SARIF-style CodeQL Analysis check run ──
  await createCheckRun(token, sha, {
    name: 'CodeQL Analysis',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-03-20T11:00:00Z',
    completed_at: '2026-03-20T11:04:32Z',
    output: {
      title: '0 new issues — 3 fixed',
      summary: [
        '## CodeQL Security Analysis\n',
        '| Category | New | Fixed | Existing |',
        '|----------|-----|-------|----------|',
        '| SQL Injection | 0 | 1 | 0 |',
        '| XSS | 0 | 1 | 0 |',
        '| Path Traversal | 0 | 0 | 0 |',
        '| Insecure Randomness | 0 | 1 | 0 |',
        '| **Total** | **0** | **3** | **0** |',
        '\n✅ No new security issues introduced. 3 previously-flagged issues were **auto-resolved** by changes in this PR.',
        '\n<details><summary>Analysis details</summary>\n',
        '- Languages analyzed: JavaScript, TypeScript',
        '- Queries: `security-extended`, `security-and-quality`',
        '- Duration: 4m 32s',
        '- Database size: 12.4 MB',
        '\n</details>',
      ].join('\n'),
      annotations: [
        {
          path: 'src/api.ts',
          start_line: 3,
          end_line: 3,
          annotation_level: 'notice',
          title: 'Fixed: SQL Injection (CWE-089)',
          message: 'Previously flagged SQL injection vector was resolved. The parameterized query introduced in this PR mitigates the risk.',
        },
        {
          path: 'src/auth.ts',
          start_line: 5,
          end_line: 5,
          annotation_level: 'notice',
          title: 'Fixed: Insecure Randomness (CWE-330)',
          message: 'Math.random() was replaced with crypto.randomBytes() for token generation. This resolves the insecure randomness finding.',
        },
        {
          path: 'src/api.ts',
          start_line: 8,
          end_line: 8,
          annotation_level: 'notice',
          title: 'Fixed: Cross-Site Scripting (CWE-079)',
          message: 'User input is now properly escaped before rendering. The reflected XSS vector has been eliminated.',
        },
      ],
    },
  });

  // ── 2. Merge Readiness check run ──
  await createCheckRun(token, sha, {
    name: 'Merge Readiness',
    status: 'completed',
    conclusion: 'action_required',
    started_at: '2026-03-20T11:00:00Z',
    completed_at: '2026-03-20T11:00:05Z',
    output: {
      title: 'Not ready — 2 requirements unmet',
      summary: [
        '## Merge Readiness Report\n',
        '| Requirement | Status |',
        '|-------------|--------|',
        '| CI passing | ✅ Pass |',
        '| Tests passing | ✅ Pass |',
        '| Minimum 1 approval required | ❌ **Needs action** |',
        '| No unresolved conversations | ❌ **Needs action** |',
        '| No merge conflicts | ✅ Pass |',
        '\n> **2 of 5** requirements are not met. Please request a review and resolve all conversations before merging.',
      ].join('\n'),
    },
    actions: [
      {
        label: 'Request Review',
        description: 'Request a review from a code owner',
        identifier: 'request_review',
      },
      {
        label: 'Dismiss',
        description: 'Dismiss this check and allow merge',
        identifier: 'dismiss_merge_check',
      },
    ],
  });

  // ── 3. Performance Benchmarks check run ──
  await createCheckRun(token, sha, {
    name: 'Performance Benchmarks',
    status: 'completed',
    conclusion: 'neutral',
    started_at: '2026-03-20T11:00:00Z',
    completed_at: '2026-03-20T11:03:15Z',
    output: {
      title: '1 regression, 2 improvements, 3 unchanged',
      summary: [
        '## Performance Benchmark Results\n',
        '| Operation | ops/sec | Δ vs main | Status |',
        '|-----------|---------|-----------|--------|',
        '| `JSON.parse (small)` | 524,300 | +2.1% | ✅ |',
        '| `JSON.parse (large)` | 12,450 | -0.3% | ➖ |',
        '| `hashPassword` | 1,842 | +15.4% | 🚀 |',
        '| `validateToken` | 98,200 | -12.7% | ⚠️ **Regressed** |',
        '| `serializeResponse` | 287,600 | +0.1% | ➖ |',
        '| `routeLookup` | 1,203,000 | +8.3% | 🚀 |',
        '\n### Summary',
        '- 🚀 **2 improvements** (hashPassword +15.4%, routeLookup +8.3%)',
        '- ⚠️ **1 regression** (validateToken -12.7%)',
        '- ➖ **3 unchanged** (within ±1% threshold)',
        '\n> The `validateToken` regression may be acceptable if the added security checks justify the overhead. Review the annotation for details.',
      ].join('\n'),
      annotations: [
        {
          path: 'src/auth.ts',
          start_line: 2,
          end_line: 4,
          annotation_level: 'warning',
          title: 'Performance Regression: validateToken (-12.7%)',
          message: 'validateToken throughput dropped from 112,400 ops/sec to 98,200 ops/sec (-12.7%).\n\nThis is likely caused by the added JWT signature verification and expiry checks.\nConsider caching decoded tokens to amortize the cost.',
        },
      ],
    },
  });

  // ── 4. License Compliance check run ──
  await createCheckRun(token, sha, {
    name: 'License Compliance',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-03-20T11:00:00Z',
    completed_at: '2026-03-20T11:00:48Z',
    output: {
      title: 'All licenses compliant — 1 advisory',
      summary: [
        '## License Compliance Report\n',
        '| Package | Version | License | Status |',
        '|---------|---------|---------|--------|',
        '| express | 4.18.2 | MIT | ✅ Approved |',
        '| lodash | 4.17.21 | MIT | ✅ Approved |',
        '| jsonwebtoken | 9.0.2 | MIT | ✅ Approved |',
        '| bcrypt | 5.1.1 | MIT | ✅ Approved |',
        '| pg | 8.11.3 | MIT | ✅ Approved |',
        '| sharp | 0.33.2 | Apache-2.0 | ✅ Approved |',
        '| readline-sync | 1.4.10 | **GPL-3.0** | ⚠️ Advisory |',
        '\n**6 of 7** dependencies use permissive licenses (MIT, Apache-2.0).',
        '\n> ⚠️ `readline-sync` uses **GPL-3.0** (copyleft). This is used only in the dev CLI tool and is not bundled into the production artifact. No action required, but flagged for awareness.',
      ].join('\n'),
      annotations: [
        {
          path: 'package.json',
          start_line: 1,
          end_line: 1,
          annotation_level: 'notice',
          title: 'Copyleft License: readline-sync (GPL-3.0)',
          message: 'The dependency "readline-sync@1.4.10" uses the GPL-3.0 license.\n\nGPL-3.0 is a copyleft license that requires derivative works to also be licensed under GPL-3.0. Verify this dependency is not bundled into production builds. Currently it appears in devDependencies only — no action required.',
        },
      ],
    },
  });

  // ── 5. Bundle Size Report deployment ──
  await createDeployment(token, sha, {
    name: 'Bundle Size Report',
    description: 'Bundle size analysis for this PR',
    state: 'success',
    url: 'https://bundle-analysis.example.com/stefanpenner/github-ci-demo/pr/1',
    logUrl: `https://github.com/${REPO}/actions/runs/123456`,
    statusDescription: 'Bundle size: 142.3 KB (+1.2 KB / +0.8%)',
    transient: true,
  });

  // ── 6. API diff PR comment ──
  await createPRComment(token, [
    '## 📡 API Changes Detected\n',
    'Comparing `feature/auth-improvements` → `main`\n',
    '### Breaking Changes (1)\n',
    '| Method | Path | Change |',
    '|--------|------|--------|',
    '| `POST` | `/api/auth/login` | Response body changed |',
    '',
    '```diff',
    ' POST /api/auth/login',
    ' Response 200:',
    ' {',
    '   "token": "string",',
    '-  "expires": "number"',
    '+  "expires_at": "string (ISO 8601)",',
    '+  "refresh_token": "string"',
    ' }',
    '```\n',
    '### New Endpoints (1)\n',
    '| Method | Path | Description |',
    '|--------|------|-------------|',
    '| `POST` | `/api/auth/refresh` | Refresh an expired token |',
    '',
    '```diff',
    '+ POST /api/auth/refresh',
    '+ Request:',
    '+   { "refresh_token": "string" }',
    '+ Response 200:',
    '+   { "token": "string", "expires_at": "string" }',
    '```\n',
    '### Removed Endpoints (0)\n',
    'None.\n',
    '### Summary\n',
    '| | Count |',
    '|---|---|',
    '| Breaking changes | 1 |',
    '| New endpoints | 1 |',
    '| Removed endpoints | 0 |',
    '| Modified (non-breaking) | 0 |',
    '',
    '> ⚠️ **1 breaking change** detected. Clients using `expires` (number) must migrate to `expires_at` (ISO 8601 string). See the [migration guide](https://example.com/migration).',
    '',
    '---',
    '_Generated by swagger-diff-bot_',
  ].join('\n'));

  // ── 7. Canary deployment ──
  await createDeployment(token, sha, {
    name: 'Canary (5% traffic)',
    description: 'Canary deployment routing 5% of production traffic for validation',
    state: 'in_progress',
    url: 'https://canary.example.com/stefanpenner/github-ci-demo',
    logUrl: `https://github.com/${REPO}/actions/runs/123457`,
    statusDescription: 'Canary validating — 5% traffic, 0 errors so far (2m elapsed)',
    transient: true,
  });

  console.log('\nAll extra examples posted!');
}

main().catch(console.error);
