// This script authenticates as a GitHub App and posts check runs
// to demonstrate the different features of the Check Runs API.

const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';

async function getInstallationToken(appId, pem) {
  // Step 1: Create a JWT signed with the app's private key
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60),
    iss: appId,
  })).toString('base64url');

  const signature = crypto.sign('sha256',
    Buffer.from(`${header}.${payload}`),
    { key: pem, padding: crypto.constants.RSA_PKCS1_V1_5 }
  ).toString('base64url');

  const jwt = `${header}.${payload}.${signature}`;

  // Step 2: Find the installation for our repo
  const installResp = await fetch(`https://api.github.com/repos/${REPO}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!installResp.ok) {
    // App might not be installed on the repo yet
    console.error('App not installed on repo. Install it first:');
    const data = await installResp.json();
    console.error(data);

    // Try to install it
    const installationsResp = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    });
    const installations = await installationsResp.json();
    if (installations.length === 0) {
      const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
      console.error(`\nPlease install the app on the repo first:`);
      console.error(`https://github.com/settings/apps/${creds.app_slug}/installations`);
      process.exit(1);
    }
  }

  const installation = await installResp.json();

  // Step 3: Get an installation access token
  const tokenResp = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  const tokenData = await tokenResp.json();
  return tokenData.token;
}

async function createCheckRun(token, checkRun) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(checkRun),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`Failed to create check run "${checkRun.name}":`, data);
    return null;
  }
  console.log(`✅ Created: "${checkRun.name}" → ${data.html_url}`);
  return data;
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = require('child_process').execSync('git rev-parse HEAD').toString().trim();

  console.log(`Authenticating as GitHub App (ID: ${creds.app_id})...`);
  const token = await getInstallationToken(creds.app_id, creds.pem);
  console.log(`Got installation token. Posting check runs on ${sha.slice(0, 8)}...\n`);

  // ── 1. Security Scan — FAILURE with inline annotations ──
  await createCheckRun(token, {
    name: 'Security Scan',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-03-20T10:00:00Z',
    completed_at: '2026-03-20T10:01:23Z',
    output: {
      title: '2 vulnerabilities found',
      summary: [
        '## Security Scan Results\n',
        '| Severity | Count |',
        '|----------|-------|',
        '| 🔴 High | 1 |',
        '| 🟡 Medium | 1 |',
        '\nFound **2 issues** that must be resolved before merging.',
      ].join('\n'),
      text: [
        '### Details\n',
        '#### HIGH: Weak password hashing',
        '`src/auth.ts:8` — Using base64 encoding instead of a proper hashing algorithm.',
        'This is trivially reversible and equivalent to storing passwords in plaintext.\n',
        '#### MEDIUM: Missing token expiry validation',
        '`src/auth.ts:3` — `validateToken()` only checks for non-empty string.',
        'No expiry, signature, or issuer validation.',
      ].join('\n'),
      annotations: [
        {
          path: 'src/auth.ts',
          start_line: 8,
          end_line: 9,
          annotation_level: 'failure',
          title: 'HIGH: Weak password hashing',
          message: 'Using base64 encoding is not a secure hashing method.\nUse bcrypt or argon2 instead.\n\nBase64 is trivially reversible — this is equivalent to storing passwords in plaintext.',
        },
        {
          path: 'src/auth.ts',
          start_line: 2,
          end_line: 4,
          annotation_level: 'warning',
          title: 'MEDIUM: No token expiry check',
          message: 'validateToken() only checks that the token is non-empty. It should verify:\n- Token signature\n- Expiry timestamp\n- Issuer claim',
        },
      ],
    },
  });

  // ── 2. Unit Tests — SUCCESS with rich summary ──
  await createCheckRun(token, {
    name: 'Unit Tests',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-03-20T10:00:00Z',
    completed_at: '2026-03-20T10:02:45Z',
    output: {
      title: '47 passed, 0 failed',
      summary: [
        '## Test Results\n',
        '✅ **All 47 tests passed** in 2m 45s\n',
        '| Suite | Tests | Pass | Fail | Time |',
        '|-------|-------|------|------|------|',
        '| auth | 12 | 12 | 0 | 0.8s |',
        '| api | 18 | 18 | 0 | 1.2s |',
        '| integration | 17 | 17 | 0 | 45s |',
        '\n### Coverage\n',
        '```',
        'Statements: 87.3% (+1.2%)',
        'Branches:   72.1% (-0.5%)',
        'Functions:  91.0% (+3.0%)',
        'Lines:      88.4% (+1.1%)',
        '```',
      ].join('\n'),
    },
  });

  // ── 3. ESLint — NEUTRAL with warnings ──
  await createCheckRun(token, {
    name: 'ESLint',
    head_sha: sha,
    status: 'completed',
    conclusion: 'neutral',
    started_at: '2026-03-20T10:00:00Z',
    completed_at: '2026-03-20T10:00:12Z',
    output: {
      title: '0 errors, 2 warnings',
      summary: '## Lint Results\n\nNo blocking errors. 2 warnings found.',
      annotations: [
        {
          path: 'src/api.ts',
          start_line: 6,
          end_line: 6,
          annotation_level: 'warning',
          title: 'no-unused-vars',
          message: "'password' is extracted but never used for authentication. Did you forget to validate it?",
        },
        {
          path: 'src/api.ts',
          start_line: 1,
          end_line: 1,
          annotation_level: 'notice',
          title: 'unused-import',
          message: "'createSession' is imported but could be re-exported from a barrel file instead.",
        },
      ],
    },
  });

  // ── 4. Deploy Preview — IN PROGRESS ──
  await createCheckRun(token, {
    name: 'Deploy Preview',
    head_sha: sha,
    status: 'in_progress',
    started_at: '2026-03-20T10:03:00Z',
    output: {
      title: 'Deploying to preview environment...',
      summary: [
        '## Deploy Preview\n',
        '⏳ Building and deploying to `preview-abc123.example.com`\n',
        '- [x] Install dependencies',
        '- [x] Build',
        '- [ ] Deploy',
        '- [ ] Health check',
      ].join('\n'),
    },
  });

  console.log(`\nDone! View the checks at:`);
  console.log(`https://github.com/${REPO}/commit/${sha}`);
}

main().catch(console.error);
