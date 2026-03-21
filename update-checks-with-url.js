// Updates existing check runs to include details_url pointing to our dashboard
const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';
const DASHBOARD_URL = 'http://localhost:3457/pipeline';

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
  const sha = require('child_process').execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  // List existing check runs
  const resp = await fetch(`https://api.github.com/repos/${REPO}/commits/${sha}/check-runs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  const { check_runs } = await resp.json();

  for (const run of check_runs) {
    const updateResp = await fetch(`https://api.github.com/repos/${REPO}/check-runs/${run.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ details_url: `${DASHBOARD_URL}?check=${run.name}` }),
    });
    if (updateResp.ok) {
      console.log(`✅ Updated "${run.name}" with details_url`);
    } else {
      console.error(`❌ Failed to update "${run.name}":`, await updateResp.json());
    }
  }

  console.log(`\nNow when you click "Details" on any check in GitHub, it links to the dashboard.`);
}

main().catch(console.error);
