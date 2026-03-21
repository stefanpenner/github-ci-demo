const crypto = require('crypto');
const fs = require('fs');
const { execSync } = require('child_process');

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

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Dependency Bump',
      head_sha: sha,
      status: 'completed',
      conclusion: 'action_required',
      output: {
        title: 'Dependency bump pending',
        summary: [
          '## Dependency Bump Required\n',
          'This PR publishes new versions of packages that are consumed by other packages in the monorepo.',
          'Those consumers need to be updated before this can merge.\n',
          '| Published Package | New Version | Consumers Needing Update |',
          '|-------------------|-------------|--------------------------|',
          '| `@acme/auth` | `2.4.1` | `@acme/api-client`, `auth-service` |',
          '| `@acme/shared-types` | `1.8.0` | `@acme/auth`, `@acme/api-client`, `@acme/config` |',
          '\n### What to do\n',
          'Run the following to update all consumers:\n',
          '```bash',
          'npx acme-bump --apply',
          '```\n',
          'Or wait for the automated bump PR to be created.',
        ].join('\n'),
      },
      actions: [
        { label: 'Auto-bump', description: 'Create a bump commit', identifier: 'auto_bump' },
        { label: 'Skip', description: 'Mark as not needed', identifier: 'skip_bump' },
      ],
    }),
  });

  const data = await resp.json();
  if (resp.ok) {
    console.log(`✅ Created: ${data.html_url}`);
  } else {
    console.error('❌', data.message);
  }
}

main().catch(console.error);
