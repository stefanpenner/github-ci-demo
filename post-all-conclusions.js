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

  const checks = [
    {
      name: 'Example: success',
      conclusion: 'success',
      title: 'All tests passed',
      summary: '## ✅ Success\n\nEverything passed. This check does not block merging.',
    },
    {
      name: 'Example: failure',
      conclusion: 'failure',
      title: '3 tests failed',
      summary: '## ❌ Failure\n\nSomething is broken. If this is a required check, it **blocks merging**.',
    },
    {
      name: 'Example: action_required',
      conclusion: 'action_required',
      title: 'Dependency bump pending',
      summary: '## ⚠️ Action Required\n\nA human needs to do something before this can proceed. Not broken, but can\'t merge yet.',
    },
    {
      name: 'Example: neutral',
      conclusion: 'neutral',
      title: '2 warnings, 0 errors',
      summary: '## ◻️ Neutral\n\nInformational only. Does **not** block merging even if required. Good for lint warnings, advisory notices.',
    },
    {
      name: 'Example: cancelled',
      conclusion: 'cancelled',
      title: 'Cancelled by user',
      summary: '## ⊘ Cancelled\n\nThe job was cancelled before it finished. Manually triggered or superseded by a newer push.',
    },
    {
      name: 'Example: timed_out',
      conclusion: 'timed_out',
      title: 'Exceeded 10m timeout',
      summary: '## ⏱ Timed Out\n\nThe job did not complete within the allowed time. Treated as a failure for branch protection.',
    },
    {
      name: 'Example: skipped',
      conclusion: 'skipped',
      title: 'No matching files changed',
      summary: '## ⏭ Skipped\n\nThis check determined it didn\'t need to run. For example, a docs-only change skipping the test suite.',
    },
  ];

  for (const check of checks) {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: check.name,
        head_sha: sha,
        status: 'completed',
        conclusion: check.conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: check.title,
          summary: check.summary,
        },
      }),
    });
    const data = await resp.json();
    if (resp.ok) {
      console.log(`✅ ${check.conclusion.padEnd(16)} → ${check.name}`);
    } else {
      console.error(`❌ ${check.conclusion.padEnd(16)} → ${data.message}`);
    }
  }

  console.log(`\nDone! https://github.com/${REPO}/pull/1`);
}

main().catch(console.error);
