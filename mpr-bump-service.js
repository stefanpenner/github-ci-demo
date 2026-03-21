// MPR Bump Service
//
// In production this runs as a webhook handler. When triggered:
//   1. Finds the MPR group from the label
//   2. Determines which PRs need dependency bumps
//   3. Checks out each branch, updates package.json, commits, pushes
//   4. Posts updated check runs showing the new state
//
// For this demo we simulate the full flow against PR #2.

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

// ── Step 1: Discover the group ──

async function discoverGroup(token, label) {
  console.log(`\n📍 Step 1: Discovering PRs with label "${label}"...\n`);

  // Search for all open PRs with the label
  const { data } = await ghApi('GET',
    `/repos/${REPO}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`,
    token
  );

  const prs = [];
  for (const issue of data) {
    if (!issue.pull_request) continue;
    const { data: pr } = await ghApi('GET', `/repos/${REPO}/pulls/${issue.number}`, token);
    prs.push(pr);
    console.log(`  Found PR #${pr.number}: ${pr.title} (${pr.head.ref})`);
  }

  return prs;
}

// ── Step 2: Determine what needs bumping ──

function analyzeDeps(prs) {
  console.log(`\n📍 Step 2: Analyzing dependency graph...\n`);

  // In production: read each PR's package.json from the GitHub API
  // For demo: use hardcoded knowledge
  const graph = [
    {
      pr: 1,
      publishes: { '@acme/auth': '2.4.1-pr.1.0' },
      deps: {},
      status: 'published',
    },
    {
      pr: 2,
      publishes: { '@acme/api-client': '3.1.0-pr.2.0' },
      deps: { '@acme/auth': { current: '2.3.0', available: '2.4.1-pr.1.0', source: 1 } },
      status: 'needs-bump',
    },
    {
      pr: 3,
      publishes: { 'auth-service': 'deploy' },
      deps: {
        '@acme/auth': { current: '2.3.0', available: '2.4.1-pr.1.0', source: 1 },
        '@acme/api-client': { current: '3.0.2', available: null, source: 2 },
      },
      status: 'blocked',
    },
  ];

  for (const node of graph) {
    const outdated = Object.entries(node.deps).filter(([, d]) => d.available && d.current !== d.available);
    if (outdated.length > 0) {
      console.log(`  PR #${node.pr}: needs bump`);
      for (const [pkg, d] of outdated) {
        console.log(`    ${pkg}: ${d.current} → ${d.available} (from PR #${d.source})`);
      }
    } else if (Object.values(node.deps).some(d => !d.available)) {
      console.log(`  PR #${node.pr}: blocked (upstream not yet published)`);
    } else {
      console.log(`  PR #${node.pr}: up to date`);
    }
  }

  return graph;
}

// ── Step 3: Bump deps (checkout, edit, commit, push) ──

async function bumpDeps(pr, deps, token) {
  const prNumber = pr.number;
  const branch = pr.head.ref;

  console.log(`\n📍 Step 3: Bumping deps on PR #${prNumber} (${branch})...\n`);

  // In production with a GitHub App, you'd either:
  //   a) Use the Git Trees/Commits API to create commits via API (no checkout needed)
  //   b) Clone the repo, checkout the branch, edit, push with the installation token
  //
  // Option (a) is better for CI services — no filesystem needed:
  //
  //   1. GET /repos/{owner}/{repo}/contents/package.json?ref={branch}
  //   2. Modify the content
  //   3. PUT /repos/{owner}/{repo}/contents/package.json (with the new content + sha)
  //
  // Let's do option (a) — pure API, no git clone:

  console.log(`  Reading package.json from branch ${branch}...`);
  const { ok: readOk, data: fileData } = await ghApi(
    'GET',
    `/repos/${REPO}/contents/package.json?ref=${branch}`,
    token
  );

  if (!readOk) {
    console.log(`  No package.json on branch ${branch}, creating one...`);
  }

  // Build the updated package.json
  let pkg;
  if (readOk && fileData.content) {
    pkg = JSON.parse(Buffer.from(fileData.content, 'base64').toString());
  } else {
    pkg = { name: '@acme/api-client', version: '3.1.0', dependencies: { '@acme/auth': '^2.3.0' } };
  }

  console.log(`  Current deps:`, JSON.stringify(pkg.dependencies));

  // Apply bumps
  const bumps = [];
  for (const [pkgName, depInfo] of Object.entries(deps)) {
    if (depInfo.available && pkg.dependencies?.[pkgName]) {
      const oldVer = pkg.dependencies[pkgName];
      pkg.dependencies[pkgName] = depInfo.available;
      bumps.push({ pkg: pkgName, from: oldVer, to: depInfo.available });
      console.log(`  Bumped ${pkgName}: ${oldVer} → ${depInfo.available}`);
    }
  }

  if (bumps.length === 0) {
    console.log(`  Nothing to bump.`);
    return null;
  }

  // Commit via the Contents API
  const newContent = Buffer.from(JSON.stringify(pkg, null, 2) + '\n').toString('base64');
  const commitMessage = `chore(mpr): bump ${bumps.map(b => b.pkg).join(', ')}\n\n` +
    bumps.map(b => `${b.pkg}: ${b.from} → ${b.to}`).join('\n') +
    `\n\nAutomated by MPR coordination service (mpr:auth-v2)`;

  console.log(`  Committing to ${branch}...`);
  const { ok: writeOk, data: commitData } = await ghApi(
    'PUT',
    `/repos/${REPO}/contents/package.json`,
    token,
    {
      message: commitMessage,
      content: newContent,
      sha: fileData?.sha,
      branch,
    }
  );

  if (writeOk) {
    const newSha = commitData.commit.sha;
    console.log(`  ✅ Committed: ${newSha.slice(0, 8)}`);
    return { newSha, bumps };
  } else {
    console.log(`  ❌ Failed to commit`);
    return null;
  }
}

// ── Step 4: Update check runs to reflect new state ──

async function postUpdatedChecks(token, group) {
  console.log(`\n📍 Step 4: Posting updated check runs...\n`);

  for (const node of group) {
    const outdated = Object.entries(node.deps).filter(([, d]) => d.available && d.current !== d.available);
    const blocked = Object.values(node.deps).some(d => !d.available);
    const isReady = outdated.length === 0 && !blocked;

    // Get the latest SHA for this PR
    const { data: pr } = await ghApi('GET', `/repos/${REPO}/pulls/${node.pr}`, token);
    const sha = pr.head.sha;

    let conclusion, title;
    if (isReady && node.pr === 1) {
      conclusion = 'success';
      title = '✅ Ready — merge first (1 of 3)';
    } else if (isReady) {
      conclusion = 'action_required';
      title = `⏳ Deps OK — waiting for merge order`;
    } else if (outdated.length > 0) {
      conclusion = 'failure';
      title = `🔄 Bump needed: ${outdated.map(([p]) => p).join(', ')}`;
    } else {
      conclusion = 'failure';
      title = '⛔ Blocked — waiting on upstream PRs';
    }

    const sections = [
      `## 🔗 \`mpr:auth-v2\` — 3 PRs\n`,
      '| | PR | Status | Deps | Merge |',
      '|---|---|--------|------|-------|',
    ];

    for (const n of group) {
      const nOutdated = Object.entries(n.deps).filter(([, d]) => d.available && d.current !== d.available);
      const nBlocked = Object.values(n.deps).some(d => !d.available);
      const nReady = nOutdated.length === 0 && !nBlocked;
      const icon = nReady ? '✅' : nOutdated.length > 0 ? '🔄' : '⛔';
      const status = nReady ? 'ready' : nOutdated.length > 0 ? 'needs-bump' : 'blocked';
      const current = n.pr === node.pr ? ' ← this' : '';
      const deps = Object.keys(n.deps).length === 0 ? '—' : nReady ? '✅' : '❌';
      sections.push(`| ${icon} | #${n.pr}${current} | ${status} | ${deps} | ${n.pr} |`);
    }

    if (outdated.length > 0) {
      sections.push('\n### Action required\n');
      sections.push('| Package | Current | Available | From |');
      sections.push('|---------|---------|-----------|------|');
      for (const [pkg, d] of outdated) {
        sections.push(`| \`${pkg}\` | \`${d.current}\` | \`${d.available}\` | PR #${d.source} |`);
      }
    } else if (isReady && node.status === 'just-bumped') {
      sections.push('\n### ✅ Dependencies bumped\n');
      sections.push('All dependencies are now up to date. This PR is ready for the next step in the merge chain.');
    } else if (blocked) {
      sections.push('\n### Blocked\n');
      sections.push('Waiting for upstream PRs to publish new versions.');
    }

    const actions = [];
    if (outdated.length > 0) {
      actions.push({ label: 'Auto-bump', description: 'Bump deps and push', identifier: 'mpr_bump' });
    }
    if (isReady && node.pr === 1) {
      actions.push({ label: 'Merge chain', description: 'Merge all in order', identifier: 'mpr_merge' });
    }
    actions.push({ label: 'Refresh', description: 'Re-check group state', identifier: 'mpr_refresh' });

    const { ok } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, {
      name: 'MPR: mpr:auth-v2',
      head_sha: sha,
      status: 'completed',
      conclusion,
      details_url: 'https://ci.example.com/mpr/auth-v2',
      output: { title, summary: sections.join('\n') },
      actions,
    });
    console.log(ok ? `  ✅ PR #${node.pr}: ${title}` : `  ❌ PR #${node.pr}: failed`);
  }
}

// ── Main: orchestrate the full bump flow ──

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log('═══════════════════════════════════════════════');
  console.log('  MPR Bump Service — mpr:auth-v2');
  console.log('═══════════════════════════════════════════════');

  // Step 1: Find the group
  const prs = await discoverGroup(token, 'mpr:auth-v2');

  // Step 2: Analyze deps
  const graph = analyzeDeps(prs);

  // Step 3: Bump PR #2 (the one that's ready to bump)
  const pr2 = prs.find(p => p.number === 2);
  const pr2Node = graph.find(n => n.pr === 2);
  const bumpResult = await bumpDeps(pr2, pr2Node.deps, token);

  // Step 4: Update the graph to reflect the bump
  if (bumpResult) {
    // PR #2 deps are now up to date
    pr2Node.deps['@acme/auth'].current = pr2Node.deps['@acme/auth'].available;
    pr2Node.status = 'just-bumped';
  }

  // Step 5: Post updated checks on all PRs
  await postUpdatedChecks(token, graph);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  Done! PR #2 has been bumped.');
  console.log('  Next: PR #2 CI runs → publishes @acme/api-client');
  console.log('        → service bumps PR #3 → merge chain complete');
  console.log('═══════════════════════════════════════════════\n');

  for (const pr of prs) {
    console.log(`  PR #${pr.number}: https://github.com/${REPO}/pull/${pr.number}`);
  }
}

main().catch(console.error);
