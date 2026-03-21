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

  // ── Simulated publish results from CI ──
  const packages = [
    { name: '@acme/auth', version: '2.4.1-pr.1.0', size: '14.2 kB', changed: true, registry: 'https://npm.pkg.github.com' },
    { name: '@acme/api-client', version: '3.1.0-pr.1.0', size: '28.7 kB', changed: true, registry: 'https://npm.pkg.github.com' },
    { name: '@acme/shared-types', version: '1.8.0-pr.1.0', size: '4.1 kB', changed: true, registry: 'https://npm.pkg.github.com' },
    { name: '@acme/config', version: '1.2.0-pr.1.0', size: '2.3 kB', changed: false, registry: 'https://npm.pkg.github.com' },
    { name: '@acme/eslint-plugin', version: '0.9.0-pr.1.0', size: '8.9 kB', changed: false, registry: 'https://npm.pkg.github.com' },
  ];

  const service = {
    name: 'auth-service',
    image: 'ghcr.io/acme/auth-service:pr-1',
    url: 'https://pr-1.auth.preview.acme.dev',
    healthCheck: 'https://pr-1.auth.preview.acme.dev/healthz',
  };

  console.log('Posting artifact results...\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. CHECK RUN — package publish summary with full details
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('1. Check run: package publish summary...');
  const changedPkgs = packages.filter(p => p.changed);
  const unchangedPkgs = packages.filter(p => !p.changed);

  const { ok: ok1 } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
    name: 'Publish: npm packages',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://ci.example.com/artifacts/pr-1',
    output: {
      title: `${packages.length} packages published`,
      summary: [
        `## 📦 Published Packages\n`,
        `**${changedPkgs.length} changed** · ${unchangedPkgs.length} unchanged · all published as pre-release\n`,
        `| Package | Version | Size | Status |`,
        `|---------|---------|------|--------|`,
        ...packages.map(p =>
          `| \`${p.name}\` | \`${p.version}\` | ${p.size} | ${p.changed ? '🔄 Changed' : '◻️ Unchanged'} |`
        ),
        `\n### Install from this PR\n`,
        '```bash',
        ...changedPkgs.map(p => `npm install ${p.name}@${p.version}`),
        '```',
        `\n<details>`,
        `<summary><strong>Size comparison vs main</strong></summary>\n`,
        `| Package | main | This PR | Delta |`,
        `|---------|------|---------|-------|`,
        `| \`@acme/auth\` | 13.8 kB | 14.2 kB | +0.4 kB ⚠️ |`,
        `| \`@acme/api-client\` | 29.1 kB | 28.7 kB | -0.4 kB ✅ |`,
        `| \`@acme/shared-types\` | 4.1 kB | 4.1 kB | ±0 |`,
        `\n</details>`,
      ].join('\n'),
    },
  });
  console.log(ok1 ? '  ✅ Created' : '  ❌ Failed');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. CHECK RUN — Docker image / service build
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('2. Check run: service build...');
  const { ok: ok2 } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
    name: 'Build: auth-service',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://ci.example.com/builds/pr-1/auth-service',
    output: {
      title: 'Image built and pushed',
      summary: [
        `## 🐳 Service Build\n`,
        `| | |`,
        `|---|---|`,
        `| **Image** | \`${service.image}\` |`,
        `| **Size** | 142 MB |`,
        `| **Layers** | 12 (8 cached) |`,
        `| **Build time** | 34s |`,
        `\n### Pull this image\n`,
        '```bash',
        `docker pull ${service.image}`,
        '```',
        `\n<details>`,
        `<summary><strong>Layer breakdown</strong></summary>\n`,
        '```',
        'CACHED  base         node:20-alpine     45 MB',
        'CACHED  deps         npm ci             62 MB',
        'BUILT   compile      tsc                28 MB',
        'BUILT   runtime      copy dist          4 MB',
        'BUILT   config       copy config        0.1 MB',
        'BUILT   healthcheck  curl install       3 MB',
        '```',
        `</details>`,
      ].join('\n'),
    },
  });
  console.log(ok2 ? '  ✅ Created' : '  ❌ Failed');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. DEPLOYMENT — the service preview (with "View deployment" button)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('3. Deployment: service preview...');
  const { ok: ok3a, data: deployment } = await ghApi('POST', `/repos/${REPO}/deployments`, token, {
    ref: sha,
    environment: 'auth-service preview',
    description: `Auth service preview for PR #${PR_NUMBER}`,
    auto_merge: false,
    required_contexts: [],
    transient_environment: true,
  });
  if (ok3a) {
    const { ok: ok3b } = await ghApi('POST', `/repos/${REPO}/deployments/${deployment.id}/statuses`, token, {
      state: 'success',
      environment_url: service.url,
      log_url: 'https://ci.example.com/deploys/pr-1/auth-service',
      description: 'Service is live and healthy',
      auto_inactive: false,
    });
    console.log(ok3b ? '  ✅ Created' : '  ❌ Failed');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. PR COMMENT — the unified summary that ties it all together
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('4. PR comment: unified artifact summary...');
  const { ok: ok4 } = await ghApi('POST', `/repos/${REPO}/issues/${PR_NUMBER}/comments`, token, {
    body: [
      `## 📦 Artifacts published from this PR\n`,
      `### npm packages (pre-release)\n`,
      `| Package | Version | Size | Changed |`,
      `|---------|---------|------|---------|`,
      ...packages.map(p =>
        `| [\`${p.name}\`](${p.registry}/${p.name.replace('@', '').replace('/', '%2F')}) | \`${p.version}\` | ${p.size} | ${p.changed ? '✅ Yes' : '—'} |`
      ),
      `\n<details>`,
      `<summary>📋 <strong>Install all changed packages</strong></summary>\n`,
      '```bash',
      changedPkgs.map(p => `npm install ${p.name}@${p.version}`).join(' \\\n  '),
      '```',
      `</details>\n`,
      `---\n`,
      `### 🐳 Service\n`,
      `| | |`,
      `|---|---|`,
      `| **auth-service** | [\`${service.image}\`](https://github.com/acme/auth-service/pkgs/container/auth-service) |`,
      `| **Preview URL** | [${service.url}](${service.url}) |`,
      `| **Health check** | [${service.healthCheck}](${service.healthCheck}) ✅ |`,
      `\n---\n`,
      `### Quick test\n`,
      '```bash',
      `# Test the preview service`,
      `curl ${service.url}/api/health`,
      ``,
      `# Use the pre-release packages in another project`,
      `npm install ${changedPkgs[0].name}@${changedPkgs[0].version}`,
      '```',
      `\n---`,
      `*🤖 Published by CI Pipeline · [View build dashboard](https://ci.example.com/artifacts/pr-1)*`,
    ].join('\n'),
  });
  console.log(ok4 ? '  ✅ Created' : '  ❌ Failed');

  console.log(`\nDone! https://github.com/${REPO}/pull/${PR_NUMBER}`);
}

main().catch(console.error);
