const crypto = require('crypto');
const fs = require('fs');

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
  if (method === 'DELETE' && resp.status === 204) return { ok: true, data: null };
  const data = resp.headers.get('content-type')?.includes('json') ? await resp.json() : null;
  return { ok: resp.ok, data };
}

async function paginate(path, token) {
  let results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const { ok, data } = await ghApi('GET', `${path}${sep}per_page=100&page=${page}`, token);
    if (!ok || !data || (Array.isArray(data) && data.length === 0)) break;
    results = results.concat(Array.isArray(data) ? data : [data]);
    if (Array.isArray(data) && data.length < 100) break;
    page++;
  }
  return results;
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const token = await getInstallationToken(creds.app_id, creds.pem);

  // ── 1. Delete all bot comments on all 3 PRs ──
  console.log('Deleting bot comments...');
  for (const pr of [1, 2, 3]) {
    const comments = await paginate(`/repos/${REPO}/issues/${pr}/comments`, token);
    const botComments = comments.filter(c => c.user?.type === 'Bot' || c.performed_via_github_app);
    for (const c of botComments) {
      const { ok } = await ghApi('DELETE', `/repos/${REPO}/issues/comments/${c.id}`, token);
      console.log(ok ? `  PR #${pr}: deleted comment ${c.id}` : `  PR #${pr}: failed to delete ${c.id}`);
    }
    if (botComments.length === 0) console.log(`  PR #${pr}: no bot comments`);
  }

  // ── 2. Dismiss all bot reviews on all 3 PRs ──
  console.log('\nDismissing bot reviews...');
  for (const pr of [1, 2, 3]) {
    const reviews = await paginate(`/repos/${REPO}/pulls/${pr}/reviews`, token);
    const botReviews = reviews.filter(r =>
      (r.user?.type === 'Bot' || r.performed_via_github_app) &&
      (r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED' || r.state === 'COMMENTED')
    );
    for (const r of botReviews) {
      const { ok } = await ghApi('PUT', `/repos/${REPO}/pulls/${pr}/reviews/${r.id}/dismissals`, token, {
        message: 'Cleaned up — replaced by MPR coordination check runs',
      });
      console.log(ok ? `  PR #${pr}: dismissed review ${r.id} (${r.state})` : `  PR #${pr}: failed to dismiss ${r.id}`);
    }
    if (botReviews.length === 0) console.log(`  PR #${pr}: no bot reviews`);
  }

  // ── 3. Deactivate all deployments ──
  console.log('\nDeactivating deployments...');
  const deployments = await paginate(`/repos/${REPO}/deployments`, token);
  for (const d of deployments) {
    // Must set to inactive before we can delete
    await ghApi('POST', `/repos/${REPO}/deployments/${d.id}/statuses`, token, {
      state: 'inactive',
    });
    const { ok } = await ghApi('DELETE', `/repos/${REPO}/deployments/${d.id}`, token);
    console.log(ok ? `  Deleted deployment: ${d.environment}` : `  Deactivated: ${d.environment}`);
  }

  // ── 4. Mark old check runs as stale (can't delete, but can update non-MPR ones to neutral) ──
  console.log('\nUpdating old check runs on PR #1...');
  const pr1Sha = 'be302e6e5bca38569e7a6919fc695ee180a8e718';
  const { data: checkData } = await ghApi('GET', `/repos/${REPO}/commits/${pr1Sha}/check-runs?per_page=100`, token);
  const checkRuns = checkData?.check_runs || [];
  for (const cr of checkRuns) {
    if (cr.name.startsWith('MPR:')) continue; // keep the coordination check
    // Update old checks to neutral/skipped so they don't clutter
    const { ok } = await ghApi('PATCH', `/repos/${REPO}/check-runs/${cr.id}`, token, {
      conclusion: 'skipped',
      output: {
        title: '(superseded by MPR coordination)',
        summary: 'This check was part of an earlier demo and has been superseded.',
      },
    });
    console.log(ok ? `  Skipped: ${cr.name}` : `  Failed to update: ${cr.name}`);
  }

  // Also clean PR #2 and #3 old check runs if any
  for (const { num, sha } of [
    { num: 2, sha: '2c339026efd451d2c9dbf9ddc21dccebfef1a53d' },
    { num: 3, sha: '0af2f5aaa0d5087e5893fb35885549ff8f1a6f80' },
  ]) {
    const { data: cd } = await ghApi('GET', `/repos/${REPO}/commits/${sha}/check-runs?per_page=100`, token);
    const runs = cd?.check_runs || [];
    const oldRuns = runs.filter(r => !r.name.startsWith('MPR:'));
    for (const cr of oldRuns) {
      const { ok } = await ghApi('PATCH', `/repos/${REPO}/check-runs/${cr.id}`, token, {
        conclusion: 'skipped',
        output: {
          title: '(superseded by MPR coordination)',
          summary: 'This check was part of an earlier demo and has been superseded.',
        },
      });
      console.log(ok ? `  PR #${num}: skipped ${cr.name}` : `  PR #${num}: failed ${cr.name}`);
    }
    if (oldRuns.length === 0) console.log(`  PR #${num}: no old check runs`);
  }

  // ── 5. Remove branch protection requiring old check names ──
  console.log('\nUpdating branch protection...');
  const { ok: bpOk } = await ghApi('PUT', `/repos/${REPO}/branches/main/protection`, token, {
    required_status_checks: {
      strict: true,
      contexts: ['MPR: mpr:auth-v2'],
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
  });
  console.log(bpOk ? '  Updated: now requires MPR check only' : '  Failed to update branch protection');

  console.log('\nDone!');
}

main().catch(console.error);
