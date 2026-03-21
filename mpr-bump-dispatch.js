// MPR Bump Service — dispatches a GHA workflow to do the actual npm install
//
// Flow:
//   1. Discover PRs in the mpr: group
//   2. Analyze dependency graph
//   3. For each PR that needs bumping:
//      - Dispatch the mpr-bump.yml workflow with the bump details
//      - Post an "in_progress" check run so the user sees it immediately
//   4. The workflow handles: npm install → lockfile update → commit → push → check run update

const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';
const [OWNER, REPO_NAME] = REPO.split('/');

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
  if (resp.status === 204) return { ok: true, data: null };
  const data = await resp.json();
  if (!resp.ok) console.error(`  ❌ ${method} ${path}:`, data.message);
  return { ok: resp.ok, data };
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const token = await getInstallationToken(creds.app_id, creds.pem);

  const label = 'mpr:auth-v2';

  // Simulated graph (in production: derived from reading each PR's package.json)
  const bumpPlan = [
    {
      prNumber: 2,
      bumps: [{ pkg: '@acme/auth', version: '2.4.1-pr.1.0' }],
    },
    // PR #3 is blocked — @acme/api-client isn't published yet
    // It will be bumped in the next cycle after PR #2 publishes
  ];

  for (const { prNumber, bumps } of bumpPlan) {
    // 1. Post an in-progress check run immediately (user sees it right away)
    const { data: pr } = await ghApi('GET', `/repos/${REPO}/pulls/${prNumber}`, token);

    console.log(`PR #${prNumber}: posting in-progress check run...`);
    await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
      name: `MPR: ${label}`,
      head_sha: pr.head.sha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: {
        title: '🔄 Bumping dependencies...',
        summary: [
          `## 🔗 \`${label}\`\n`,
          `Bumping dependencies on PR #${prNumber}:\n`,
          '| Package | New Version |',
          '|---------|-------------|',
          ...bumps.map(b => `| \`${b.pkg}\` | \`${b.version}\` |`),
          '\n⏳ Running `npm install` to update lockfile...',
        ].join('\n'),
      },
    });

    // 2. Dispatch the workflow
    console.log(`PR #${prNumber}: dispatching mpr-bump workflow...`);
    const { ok } = await ghApi('POST',
      `/repos/${REPO}/actions/workflows/mpr-bump.yml/dispatches`,
      token,
      {
        ref: 'main', // workflow must exist on this ref
        inputs: {
          'pr-number': String(prNumber),
          'bumps': JSON.stringify(bumps),
          'mpr-label': label,
        },
      }
    );

    if (ok) {
      console.log(`  ✅ Workflow dispatched for PR #${prNumber}`);
      console.log(`     Bumping: ${bumps.map(b => `${b.pkg}@${b.version}`).join(', ')}`);
    } else {
      console.log(`  ❌ Failed to dispatch workflow`);
    }
  }

  console.log('\nThe workflow will:');
  console.log('  1. Checkout the PR branch');
  console.log('  2. Run npm install <pkg>@<version> for each bump');
  console.log('  3. Commit package.json + lockfile');
  console.log('  4. Push to the PR branch');
  console.log('  5. Post an updated check run');
}

main().catch(console.error);
