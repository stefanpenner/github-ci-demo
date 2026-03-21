// Multi-PR Coordination Service
//
// Scenario: 3 PRs are part of the "auth-v2" effort, labeled mpr:auth-v2
//
//   PR #1: @acme/auth          — core auth library changes (PUBLISHED)
//   PR #2: @acme/api-client    — depends on @acme/auth (NEEDS BUMP)
//   PR #3: auth-service deploy — depends on @acme/auth + @acme/api-client (NEEDS BOTH)
//
// The coordination service:
//   1. Watches for label events + package publish events
//   2. Builds a dependency graph across the PR group
//   3. Posts UI on each PR showing group status + what's blocking
//   4. Posts REQUEST_CHANGES reviews when deps need bumping
//   5. Auto-approves when deps are up to date
//   6. Uses a check run to gate merging on correct merge order

const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';

// ── Simulated state of the multi-PR group ──
const GROUP = {
  label: 'mpr:auth-v2',
  prs: [
    {
      number: 1,
      sha: 'be302e6e5bca38569e7a6919fc695ee180a8e718',
      title: 'Fix auth token validation',
      branch: 'fix/auth-improvements',
      author: 'stefanpenner',
      publishes: ['@acme/auth@2.4.1'],
      depends: [],
      published: { '@acme/auth': '2.4.1-pr.1.0' },
      depsUpToDate: true,
      ciPassing: true,
      approved: false,
      mergeOrder: 1,
      status: 'ready',  // ready | blocked | needs-bump | in-progress
    },
    {
      number: 2,
      sha: '2c339026efd451d2c9dbf9ddc21dccebfef1a53d',
      title: 'Update api-client with credential validation',
      branch: 'fix/api-client-update',
      author: 'stefanpenner',
      publishes: ['@acme/api-client@3.1.0'],
      depends: ['@acme/auth@^2.4.0'],
      published: null,
      currentDeps: { '@acme/auth': '2.3.0' },  // outdated!
      depsUpToDate: false,
      ciPassing: true,
      approved: false,
      mergeOrder: 2,
      status: 'needs-bump',
    },
    {
      number: 3,
      sha: '0af2f5aaa0d5087e5893fb35885549ff8f1a6f80',
      title: 'Deploy auth service with new endpoints',
      branch: 'fix/service-deploy',
      author: 'stefanpenner',
      publishes: ['auth-service (deploy)'],
      depends: ['@acme/auth@^2.4.0', '@acme/api-client@^3.1.0'],
      published: null,
      currentDeps: { '@acme/auth': '2.3.0', '@acme/api-client': '3.0.2' },
      depsUpToDate: false,
      ciPassing: false,
      approved: false,
      mergeOrder: 3,
      status: 'blocked',
    },
  ],
};

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

// ── Status icons and helpers ──

function prStatusIcon(pr) {
  return { 'ready': '✅', 'needs-bump': '🔄', 'blocked': '⛔', 'in-progress': '🔄', 'merged': '🟣' }[pr.status];
}

function depStatusIcon(current, needed) {
  if (!current) return '✅';
  return current === needed ? '✅' : '❌';
}

// ── Build the coordination comment (posted on EVERY PR in the group) ──

function buildGroupComment(group, currentPrNumber) {
  const currentPr = group.prs.find(p => p.number === currentPrNumber);
  const otherPrs = group.prs.filter(p => p.number !== currentPrNumber);

  const prTable = group.prs.map(pr => {
    const isCurrent = pr.number === currentPrNumber;
    const name = isCurrent ? `**#${pr.number}** (this PR)` : `#${pr.number}`;
    const ci = pr.ciPassing ? '✅' : '❌';
    const deps = pr.depsUpToDate ? '✅' : '❌';
    const review = pr.approved ? '✅' : '⏳';
    const merge = `\`${pr.mergeOrder}\``;
    return `| ${prStatusIcon(pr)} | ${name} | ${pr.publishes.join(', ')} | ${ci} | ${deps} | ${review} | ${merge} |`;
  }).join('\n');

  // Dependency graph as text
  const depGraph = [
    '```',
    '  ┌─────────────────┐',
    '  │  @acme/auth      │ ← PR #1 (published ✅)',
    '  └────────┬────────┘',
    '           │',
    '     ┌─────┴──────┐',
    '     ▼             │',
    '┌──────────────┐   │',
    '│ @acme/api-   │   │',
    '│ client       │   │ ← PR #2 (needs bump 🔄)',
    '└──────┬───────┘   │',
    '       │           │',
    '       ▼           ▼',
    '  ┌─────────────────┐',
    '  │  auth-service    │ ← PR #3 (blocked ⛔)',
    '  └─────────────────┘',
    '```',
  ];

  // What this specific PR needs to do
  let actionItems = [];
  if (!currentPr.depsUpToDate) {
    const outdated = Object.entries(currentPr.currentDeps || {}).map(([pkg, ver]) => {
      const source = group.prs.find(p => p.published?.[pkg]);
      const latest = source?.published?.[pkg];
      return latest ? `- \`${pkg}\`: \`${ver}\` → \`${latest}\` (from PR #${source.number})` : null;
    }).filter(Boolean);
    if (outdated.length) {
      actionItems.push('### ⚡ Action needed on this PR\n');
      actionItems.push('Update these dependencies:\n');
      actionItems.push(...outdated);
      actionItems.push('');
      actionItems.push('```bash');
      actionItems.push('# Auto-bump all dependencies from the MPR group');
      actionItems.push(`mpr bump --label ${group.label}`);
      actionItems.push('```');
    }
  }

  // Merge order section
  const mergeOrder = group.prs
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
    .map((pr, i) => {
      const isCurrent = pr.number === currentPrNumber;
      const prefix = pr.status === 'ready' ? '✅' : pr.status === 'merged' ? '🟣' : '⏳';
      const highlight = isCurrent ? ' ← **you are here**' : '';
      return `${prefix} **${i + 1}.** PR #${pr.number} — ${pr.title}${highlight}`;
    });

  return [
    `## 🔗 Multi-PR Group: \`${group.label}\`\n`,
    `This PR is part of a coordinated group of **${group.prs.length} PRs** that must be merged in order.\n`,
    `| Status | PR | Publishes | CI | Deps | Review | Merge Order |`,
    `|--------|-----|-----------|-----|------|--------|-------------|`,
    prTable,
    '',
    '<details>',
    '<summary><strong>📊 Dependency Graph</strong></summary>\n',
    ...depGraph,
    '',
    '</details>',
    '',
    ...actionItems,
    '',
    '### 🚦 Merge Order\n',
    ...mergeOrder,
    '',
    '<details>',
    '<summary><strong>📦 Published Versions</strong></summary>\n',
    '| Package | Version | Source PR | Status |',
    '|---------|---------|----------|--------|',
    ...group.prs.flatMap(pr =>
      Object.entries(pr.published || {}).map(([pkg, ver]) =>
        `| \`${pkg}\` | \`${ver}\` | #${pr.number} | ✅ Published |`
      )
    ),
    ...group.prs.filter(p => !p.published && p.publishes.length).flatMap(pr =>
      pr.publishes.map(pub =>
        `| \`${pub}\` | — | #${pr.number} | ⏳ Pending |`
      )
    ),
    '',
    '</details>',
    '',
    '---',
    `*🤖 [MPR Coordination Service](https://ci.example.com/mpr/${group.label}) · Updates on every push · [View dashboard](https://ci.example.com/mpr/${group.label})*`,
  ].join('\n');
}

// ── Build check run for each PR ──

function buildCheckRun(group, pr) {
  const allReady = group.prs.every(p => p.depsUpToDate && p.ciPassing);
  const canMerge = pr.depsUpToDate && pr.ciPassing &&
    group.prs.filter(p => p.mergeOrder < pr.mergeOrder).every(p => p.status === 'merged' || p.status === 'ready');

  let conclusion, title;
  if (pr.status === 'ready') {
    if (pr.mergeOrder === 1) {
      conclusion = 'success';
      title = `Ready to merge (order: ${pr.mergeOrder} of ${group.prs.length})`;
    } else {
      conclusion = 'action_required';
      title = `Deps OK — waiting for PR #${group.prs.find(p => p.mergeOrder === pr.mergeOrder - 1).number} to merge first`;
    }
  } else if (pr.status === 'needs-bump') {
    conclusion = 'failure';
    title = 'Dependencies need bumping from upstream PRs';
  } else {
    conclusion = 'failure';
    title = 'Blocked — upstream PRs need to publish first';
  }

  const blockers = [];
  if (!pr.depsUpToDate) blockers.push('❌ Dependencies are outdated');
  if (!pr.ciPassing) blockers.push('❌ CI is failing');
  const prsBefore = group.prs.filter(p => p.mergeOrder < pr.mergeOrder);
  for (const before of prsBefore) {
    if (before.status !== 'ready' && before.status !== 'merged') {
      blockers.push(`❌ PR #${before.number} must be ready first (currently: ${before.status})`);
    }
  }

  const readyChecks = [];
  if (pr.depsUpToDate) readyChecks.push('✅ Dependencies up to date');
  if (pr.ciPassing) readyChecks.push('✅ CI passing');
  for (const before of prsBefore) {
    if (before.status === 'ready' || before.status === 'merged') {
      readyChecks.push(`✅ PR #${before.number} is ${before.status}`);
    }
  }

  return {
    name: `MPR: ${group.label}`,
    head_sha: pr.sha,
    status: 'completed',
    conclusion,
    details_url: `https://ci.example.com/mpr/${group.label}`,
    output: {
      title,
      summary: [
        `## Multi-PR Coordination: \`${group.label}\`\n`,
        `**This PR:** #${pr.number} — merge order **${pr.mergeOrder}** of ${group.prs.length}\n`,
        ...(readyChecks.length ? ['### Ready\n', ...readyChecks, ''] : []),
        ...(blockers.length ? ['### Blocking\n', ...blockers, ''] : []),
        '',
        `### Group Status\n`,
        `| PR | Status | Merge Order |`,
        `|----|--------|-------------|`,
        ...group.prs.map(p =>
          `| #${p.number}${p.number === pr.number ? ' (this)' : ''} | ${prStatusIcon(p)} ${p.status} | ${p.mergeOrder} |`
        ),
      ].join('\n'),
    },
    actions: pr.status === 'needs-bump'
      ? [
          { label: 'Auto-bump deps', description: 'Bump and push a commit', identifier: `mpr_bump_${pr.number}` },
          { label: 'View group', description: 'Open MPR dashboard', identifier: `mpr_view` },
        ]
      : pr.status === 'ready' && pr.mergeOrder === 1
      ? [
          { label: 'Merge chain', description: 'Merge all ready PRs', identifier: `mpr_merge` },
          { label: 'View group', description: 'Open MPR dashboard', identifier: `mpr_view` },
        ]
      : [
          { label: 'View group', description: 'Open MPR dashboard', identifier: `mpr_view` },
        ],
  };
}

// ── Build review for PRs that need bumping ──

function buildReview(group, pr) {
  if (pr.depsUpToDate) {
    return {
      event: 'APPROVE',
      body: [
        `## 🔗 MPR: \`${group.label}\` — Dependencies OK\n`,
        `All dependencies from the MPR group are up to date. This approval will be revoked if dependencies change.`,
      ].join('\n'),
      comments: [],
    };
  }

  const outdated = Object.entries(pr.currentDeps || {});
  return {
    event: 'REQUEST_CHANGES',
    body: [
      `## 🔗 MPR: \`${group.label}\` — Dependency Bump Required\n`,
      `This PR depends on packages published by other PRs in the group.`,
      `Those packages have new pre-release versions available that this PR needs to adopt.\n`,
      '| Package | Current | Available | Source |',
      '|---------|---------|-----------|--------|',
      ...outdated.map(([pkg, ver]) => {
        const source = group.prs.find(p => p.published?.[pkg]);
        const latest = source?.published?.[pkg] || 'not yet published';
        return `| \`${pkg}\` | \`${ver}\` | \`${latest}\` | PR #${source?.number || '?'} |`;
      }),
      '\nRun `mpr bump --label ' + group.label + '` to update automatically.',
    ].join('\n'),
  };
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log(`Posting MPR coordination UI for group: ${GROUP.label}\n`);

  for (const pr of GROUP.prs) {
    console.log(`── PR #${pr.number} (${pr.status}) ──`);

    // 1. Check run — gates merging
    const checkRun = buildCheckRun(GROUP, pr);
    const { ok: ok1 } = await ghApi('POST', `/repos/${REPO}/check-runs`, token, checkRun);
    console.log(ok1 ? `  ✅ Check run: ${checkRun.output.title}` : '  ❌ Check run failed');

    // 2. PR comment — group overview
    const comment = buildGroupComment(GROUP, pr.number);
    const { ok: ok2 } = await ghApi('POST', `/repos/${REPO}/issues/${pr.number}/comments`, token, { body: comment });
    console.log(ok2 ? '  ✅ Group overview comment' : '  ❌ Comment failed');

    // 3. Review — approve or request changes based on dep status
    const review = buildReview(GROUP, pr);
    // Only post review comments if there are any
    const reviewPayload = {
      commit_id: pr.sha,
      event: review.event,
      body: review.body,
    };
    const { ok: ok3 } = await ghApi('POST', `/repos/${REPO}/pulls/${pr.number}/reviews`, token, reviewPayload);
    console.log(ok3
      ? `  ✅ Review: ${review.event}`
      : '  ❌ Review failed');

    // 4. Deployment — link to coordination dashboard
    const { ok: ok4a, data: deployment } = await ghApi('POST', `/repos/${REPO}/deployments`, token, {
      ref: pr.sha,
      environment: `mpr: ${GROUP.label}`,
      description: `Multi-PR coordination dashboard`,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
    });
    if (ok4a) {
      const { ok: ok4b } = await ghApi('POST', `/repos/${REPO}/deployments/${deployment.id}/statuses`, token, {
        state: pr.status === 'ready' ? 'success' : 'pending',
        environment_url: `https://ci.example.com/mpr/${GROUP.label}`,
        description: `Group status: ${GROUP.prs.filter(p => p.status === 'ready').length}/${GROUP.prs.length} ready`,
        auto_inactive: false,
      });
      console.log(ok4b ? '  ✅ Deployment: dashboard link' : '  ❌ Deployment status failed');
    }

    console.log('');
  }

  console.log('Done! View the PRs:');
  for (const pr of GROUP.prs) {
    console.log(`  PR #${pr.number}: https://github.com/${REPO}/pull/${pr.number}`);
  }
}

main().catch(console.error);
