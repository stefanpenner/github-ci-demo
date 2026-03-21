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

  const packages = [
    { name: '@acme/auth',         version: '2.4.1-pr.1.0', npm: 'https://www.npmjs.com/package/@acme/auth' },
    { name: '@acme/api-client',   version: '3.1.0-pr.1.0', npm: 'https://www.npmjs.com/package/@acme/api-client' },
    { name: '@acme/shared-types', version: '1.8.0-pr.1.0', npm: 'https://www.npmjs.com/package/@acme/shared-types' },
    { name: '@acme/config',       version: '1.2.0-pr.1.0', npm: 'https://www.npmjs.com/package/@acme/config' },
    { name: '@acme/eslint-plugin',version: '0.9.0-pr.1.0', npm: 'https://www.npmjs.com/package/@acme/eslint-plugin' },
  ];

  console.log('Creating npm publish deployments...\n');

  for (const pkg of packages) {
    const { ok, data: deployment } = await ghApi('POST', `/repos/${REPO}/deployments`, token, {
      ref: sha,
      environment: `npm: ${pkg.name}@${pkg.version}`,
      description: `Published ${pkg.name}@${pkg.version} to npm`,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
    });

    if (ok) {
      const { ok: ok2 } = await ghApi('POST', `/repos/${REPO}/deployments/${deployment.id}/statuses`, token, {
        state: 'success',
        environment_url: pkg.npm,
        description: `${pkg.name}@${pkg.version} published`,
        auto_inactive: false,
      });
      console.log(ok2
        ? `  ✅ ${pkg.name}@${pkg.version}`
        : `  ❌ ${pkg.name} status failed`);
    }
  }

  console.log(`\nDone! https://github.com/${REPO}/pull/1`);
}

main().catch(console.error);
