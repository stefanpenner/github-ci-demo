const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';

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
    console.error(`Failed:`, data);
    return;
  }
  console.log(`✅ Created: "${checkRun.name}" → ${data.html_url}`);
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = require('child_process').execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log(`Posting check runs on PR commit ${sha.slice(0, 8)}...\n`);

  await createCheckRun(token, {
    name: 'Security Scan',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    output: {
      title: '2 vulnerabilities found',
      summary: '## Security Scan\n\nFound **2 issues** in `src/auth.ts`.',
      annotations: [
        {
          path: 'src/auth.ts',
          start_line: 9,
          end_line: 10,
          annotation_level: 'failure',
          title: 'HIGH: Weak password hashing',
          message: 'Using base64 encoding is not a secure hashing method. Use bcrypt or argon2 instead.',
        },
        {
          path: 'src/auth.ts',
          start_line: 3,
          end_line: 5,
          annotation_level: 'warning',
          title: 'MEDIUM: No token expiry check',
          message: 'validateToken() only checks that the token is non-empty. It should verify:\n- Token signature\n- Expiry timestamp\n- Issuer claim',
        },
      ],
    },
  });

  await createCheckRun(token, {
    name: 'ESLint',
    head_sha: sha,
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: '0 errors, 1 warning',
      summary: '1 warning found.',
      annotations: [
        {
          path: 'src/auth.ts',
          start_line: 4,
          end_line: 4,
          annotation_level: 'warning',
          title: 'TODO comment detected',
          message: 'TODO comments should be tracked as issues, not left in code.',
        },
      ],
    },
  });

  console.log(`\nView the PR: https://github.com/${REPO}/pull/1`);
  console.log(`Check the "Files changed" tab to see inline annotations.`);
}

main().catch(console.error);
