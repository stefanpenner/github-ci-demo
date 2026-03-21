// Multi-PR Coordination — check runs only, no comments
const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';

const GROUP = {
  label: 'mpr:auth-v2',
  prs: [
    {
      number: 1,
      sha: 'be302e6e5bca38569e7a6919fc695ee180a8e718',
      title: 'Fix auth token validation',
      publishes: ['@acme/auth@2.4.1'],
      depends: [],
      published: { '@acme/auth': '2.4.1-pr.1.0' },
      currentDeps: {},
      depsUpToDate: true,
      ciPassing: true,
      mergeOrder: 1,
      status: 'ready',
    },
    {
      number: 2,
      sha: '2c339026efd451d2c9dbf9ddc21dccebfef1a53d',
      title: 'Update api-client with credential validation',
      publishes: ['@acme/api-client@3.1.0'],
      depends: ['@acme/auth@^2.4.0'],
      published: null,
      currentDeps: { '@acme/auth': '2.3.0' },
      depsUpToDate: false,
      ciPassing: true,
      mergeOrder: 2,
      status: 'needs-bump',
    },
    {
      number: 3,
      sha: '0af2f5aaa0d5087e5893fb35885549ff8f1a6f80',
      title: 'Deploy auth service with new endpoints',
      publishes: ['auth-service (deploy)'],
      depends: ['@acme/auth@^2.4.0', '@acme/api-client@^3.1.0'],
      published: null,
      currentDeps: { '@acme/auth': '2.3.0', '@acme/api-client': '3.0.2' },
      depsUpToDate: false,
      ciPassing: false,
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

function statusIcon(s) {
  return { ready: '✅', 'needs-bump': '🔄', blocked: '⛔', merged: '🟣' }[s] || '⬜';
}

function buildCheckRun(group, pr) {
  const prsBefore = group.prs.filter(p => p.mergeOrder < pr.mergeOrder);

  // Conclusion
  let conclusion;
  if (pr.status === 'ready' && pr.mergeOrder === 1) conclusion = 'success';
  else if (pr.status === 'ready') conclusion = 'action_required';
  else conclusion = 'failure';

  // Title — the one-liner visible in the merge box
  let title;
  if (pr.status === 'ready' && pr.mergeOrder === 1) {
    title = `✅ Ready — merge first (1 of ${group.prs.length})`;
  } else if (pr.status === 'ready') {
    const waiting = group.prs.find(p => p.mergeOrder === pr.mergeOrder - 1);
    title = `⏳ Deps OK — merge after PR #${waiting.number}`;
  } else if (pr.status === 'needs-bump') {
    const outdated = Object.keys(pr.currentDeps).filter(pkg =>
      group.prs.some(p => p.published?.[pkg])
    );
    title = `🔄 Bump needed: ${outdated.join(', ')}`;
  } else {
    title = `⛔ Blocked — waiting on upstream PRs`;
  }

  // Summary — the full detail view
  const sections = [];

  // ── Group overview table ──
  sections.push(
    `## 🔗 \`${group.label}\` — ${group.prs.length} PRs\n`,
    '| | PR | Publishes | Deps | CI | Merge |',
    '|---|---|-----------|------|----|-------|',
    ...group.prs.map(p => {
      const current = p.number === pr.number ? ' ← this' : '';
      const deps = p.depends.length === 0 ? '—' : p.depsUpToDate ? '✅' : '❌';
      const ci = p.ciPassing ? '✅' : '❌';
      return `| ${statusIcon(p.status)} | [#${p.number}](https://github.com/${REPO}/pull/${p.number})${current} | \`${p.publishes[0]}\` | ${deps} | ${ci} | ${p.mergeOrder} |`;
    }),
    '',
  );

  // ── Dependency graph ──
  sections.push(
    '<details>',
    '<summary><strong>Dependency graph</strong></summary>\n',
    '```',
    '  @acme/auth (PR #1) ✅ published',
    '    │',
    '    ├──▶ @acme/api-client (PR #2) 🔄 needs bump',
    '    │       │',
    '    │       ├──▶ auth-service (PR #3) ⛔ blocked',
    '    │       │',
    '    └───────┘',
    '```',
    '</details>\n',
  );

  // ── This PR's status ──
  if (pr.status === 'needs-bump') {
    sections.push('### Action required\n');
    sections.push('These dependencies have new versions from the group:\n');
    sections.push('| Package | Current | Available | From |');
    sections.push('|---------|---------|-----------|------|');
    for (const [pkg, ver] of Object.entries(pr.currentDeps)) {
      const source = group.prs.find(p => p.published?.[pkg]);
      if (source) {
        sections.push(`| \`${pkg}\` | \`${ver}\` | \`${source.published[pkg]}\` | PR #${source.number} |`);
      }
    }
    sections.push('');
    sections.push('```bash');
    sections.push(`mpr bump --label ${group.label}`);
    sections.push('```');
  } else if (pr.status === 'blocked') {
    sections.push('### Blocked\n');
    const missing = pr.depends.filter(dep => {
      const pkg = dep.split('@')[0] + '@' + dep.split('@')[1];
      return !group.prs.some(p => p.published?.[pkg.replace(/@\^.*/, '')]);
    });
    sections.push('Waiting for upstream PRs to publish:\n');
    for (const p of prsBefore) {
      if (!p.published || Object.keys(p.published).length === 0) {
        sections.push(`- ⏳ PR #${p.number} — \`${p.publishes[0]}\` not yet published`);
      } else {
        sections.push(`- ✅ PR #${p.number} — \`${Object.keys(p.published)[0]}\` published`);
      }
    }
    sections.push('');
    sections.push('Once all upstream packages are published, this PR will move to **needs-bump**.');
  } else if (pr.status === 'ready') {
    sections.push('### Merge order\n');
    for (const p of group.prs.sort((a, b) => a.mergeOrder - b.mergeOrder)) {
      const icon = p.status === 'ready' ? '✅' : '⏳';
      const here = p.number === pr.number ? ' **← merge this**' : '';
      sections.push(`${icon} ${p.mergeOrder}. PR #${p.number} — ${p.title}${here}`);
    }
  }

  // ── Published versions ──
  const allPublished = group.prs.flatMap(p =>
    Object.entries(p.published || {}).map(([pkg, ver]) => ({ pkg, ver, pr: p.number }))
  );
  if (allPublished.length > 0) {
    sections.push('');
    sections.push('<details>');
    sections.push('<summary><strong>Published pre-release versions</strong></summary>\n');
    sections.push('| Package | Version | PR |');
    sections.push('|---------|---------|-----|');
    for (const { pkg, ver, pr: prNum } of allPublished) {
      sections.push(`| \`${pkg}\` | \`${ver}\` | #${prNum} |`);
    }
    sections.push('');
    sections.push('```bash');
    for (const { pkg, ver } of allPublished) {
      sections.push(`npm install ${pkg}@${ver}`);
    }
    sections.push('```');
    sections.push('</details>');
  }

  // ── Actions ──
  const actions = [];
  if (pr.status === 'needs-bump') {
    actions.push({ label: 'Auto-bump', description: 'Bump deps and push', identifier: 'mpr_bump' });
  }
  if (pr.status === 'ready' && pr.mergeOrder === 1) {
    actions.push({ label: 'Merge chain', description: 'Merge all in order', identifier: 'mpr_merge' });
  }
  actions.push({ label: 'Refresh', description: 'Re-check group state', identifier: 'mpr_refresh' });

  return {
    name: `MPR: ${group.label}`,
    head_sha: pr.sha,
    status: 'completed',
    conclusion,
    details_url: `https://ci.example.com/mpr/${group.label}`,
    output: {
      title,
      summary: sections.join('\n'),
    },
    actions,
  };
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log(`Posting MPR check runs for group: ${GROUP.label}\n`);

  for (const pr of GROUP.prs) {
    const checkRun = buildCheckRun(GROUP, pr);
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
    if (resp.ok) {
      console.log(`✅ PR #${pr.number}: ${checkRun.output.title}`);
    } else {
      console.error(`❌ PR #${pr.number}: ${data.message}`);
    }
  }

  console.log(`\nDone! Check each PR's merge box and click "Details" on the MPR check.`);
}

main().catch(console.error);
