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

async function createDeployment(token, sha, env) {
  // Create the deployment
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
      production_environment: env.production || false,
    }),
  });
  const deployment = await resp.json();
  if (!resp.ok) {
    console.error(`  ❌ ${env.name}:`, deployment.message);
    return;
  }

  // Set the status
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
    console.log(`  ✅ ${env.name} (${env.state}) → ${env.url}`);
  } else {
    const err = await statusResp.json();
    console.error(`  ❌ ${env.name} status:`, err.message);
  }
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log('Creating multiple deployments for PR #1...\n');

  const environments = [
    {
      name: 'Preview',
      description: 'Ephemeral preview for this PR',
      state: 'success',
      url: 'https://pr-1.preview.example.com',
      logUrl: 'http://localhost:3457/pipeline?env=preview',
      statusDescription: 'Preview is live',
      transient: true,
    },
    {
      name: 'Storybook',
      description: 'Component preview',
      state: 'success',
      url: 'https://pr-1.storybook.example.com',
      logUrl: 'http://localhost:3457/pipeline?env=storybook',
      statusDescription: 'Storybook deployed',
      transient: true,
    },
    {
      name: 'API Docs',
      description: 'Generated API documentation',
      state: 'success',
      url: 'https://pr-1.docs.example.com',
      logUrl: 'http://localhost:3457/pipeline?env=docs',
      statusDescription: 'API docs generated',
      transient: true,
    },
    {
      name: 'Staging',
      description: 'Shared staging environment',
      state: 'in_progress',
      url: 'https://staging.example.com',
      logUrl: 'http://localhost:3457/pipeline?env=staging',
      statusDescription: 'Deploying to staging...',
    },
    {
      name: 'Performance',
      description: 'Load test environment',
      state: 'success',
      url: 'https://pr-1.perf.example.com/report',
      logUrl: 'http://localhost:3457/pipeline?env=perf',
      statusDescription: 'Perf tests passed — p99 latency: 42ms',
      transient: true,
    },
  ];

  for (const env of environments) {
    await createDeployment(token, sha, env);
  }

  console.log(`\nDone! View: https://github.com/${REPO}/pull/1`);
}

main().catch(console.error);
