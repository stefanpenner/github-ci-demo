# GitHub CI Integration — Complete Reference

## Overview

You can replace GitHub Actions (GHA) entirely — or supplement it — while keeping full integration with GitHub's PR and commit UI. GitHub exposes several APIs that any external CI system can call: Check Runs, Commit Statuses, PR Comments, PR Reviews, and Deployments. The pattern is always the same: receive a webhook, run your pipeline, then call these APIs to report results back to GitHub.

This repo demonstrates every one of those integration surfaces with working Node.js scripts that authenticate as a GitHub App and post real data to a live repository.

---

## GitHub APIs for CI Integration

### 1. Check Runs API

The Check Runs API is the richest way to report CI results. It powers the "Checks" tab on PRs and commits, supports inline annotations on diffs, markdown summaries, action buttons, and links to external dashboards.

**Auth requirement:** GitHub App installation token (not a PAT — the Check Runs API is only available to GitHub Apps).

**Fields:**
- `name` — the check name shown in the PR status area
- `head_sha` — the commit to attach the check to
- `status` — `queued`, `in_progress`, or `completed`
- `conclusion` — one of 7 values (see below), only set when `status` is `completed`
- `output.title` — short title shown next to the check name
- `output.summary` — markdown rendered in the check detail view
- `output.text` — additional markdown shown below the summary
- `output.annotations` — inline annotations on the diff (see deep dive below)
- `output.images` — images with `alt`, `image_url`, and `caption`
- `actions` — up to 3 buttons that fire webhooks (see deep dive below)
- `details_url` — link to an external dashboard (the "Details" link in the PR)
- `started_at` / `completed_at` — timestamps for duration display

**All 7 conclusions:**

| Conclusion | Effect | Use Case |
|---|---|---|
| `success` | Green check. Does not block merge. | Tests passed, lint clean. |
| `failure` | Red X. Blocks merge if required. | Tests failed, security vulnerability found. |
| `action_required` | Orange warning. Blocks merge. | Dependency bump needed, manual approval required. |
| `neutral` | Grey dash. Does **not** block merge even if required. | Lint warnings, informational notices. |
| `cancelled` | Grey circle. | Job cancelled by user or superseded by newer push. |
| `timed_out` | Red clock. Treated as failure for branch protection. | Job exceeded time limit. |
| `skipped` | Grey skip icon. | Check determined it didn't need to run (e.g., docs-only change). |

**Code example — authenticate as a GitHub App and create a check run:**

```js
const crypto = require('crypto');
const fs = require('fs');

const REPO = 'stefanpenner/github-ci-demo';

async function getInstallationToken(appId, pem) {
  // Step 1: Create a JWT signed with the app's private key
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60),
    iss: appId,
  })).toString('base64url');

  const signature = crypto.sign('sha256',
    Buffer.from(`${header}.${payload}`),
    { key: pem, padding: crypto.constants.RSA_PKCS1_V1_5 }
  ).toString('base64url');

  const jwt = `${header}.${payload}.${signature}`;

  // Step 2: Find the installation for our repo
  const installResp = await fetch(`https://api.github.com/repos/${REPO}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
    },
  });
  const installation = await installResp.json();

  // Step 3: Get an installation access token
  const tokenResp = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  const tokenData = await tokenResp.json();
  return tokenData.token;
}

// Create a check run
async function createCheckRun(token, checkRun) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(checkRun),
  });
  return await resp.json();
}

// Usage:
const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
const token = await getInstallationToken(creds.app_id, creds.pem);

await createCheckRun(token, {
  name: 'Security Scan',
  head_sha: sha,
  status: 'completed',
  conclusion: 'failure',
  output: {
    title: '2 vulnerabilities found',
    summary: '## Security Scan Results\n\n| Severity | Count |\n|----------|-------|\n| High | 1 |\n| Medium | 1 |',
    annotations: [
      {
        path: 'src/auth.ts',
        start_line: 8,
        end_line: 9,
        annotation_level: 'failure',
        title: 'HIGH: Weak password hashing',
        message: 'Using base64 encoding is not a secure hashing method.\nUse bcrypt or argon2 instead.',
      },
    ],
  },
});
```

### 2. Commit Statuses API

The older, simpler way to report status on a commit. Shows up in the same status area as check runs but with fewer features — no annotations, no markdown output, no action buttons.

**Fields:**
- `state` — `error`, `failure`, `pending`, or `success`
- `target_url` — link shown when clicking "Details"
- `description` — short text (max 140 chars)
- `context` — unique identifier for this status (e.g., `ci/deploy-preview`)

**Code example:**

```js
await fetch(`https://api.github.com/repos/${REPO}/statuses/${sha}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    state: 'success',
    target_url: 'http://localhost:3457/pipeline',
    description: 'All systems operational',
    context: 'ci/deploy-preview',
  }),
});
```

### 3. PR Comments API

Rich markdown comments on the PR conversation tab. This is what bots like Codecov, Dependabot, and Vercel use for their summaries.

**Features:** tables, collapsible `<details>` sections, diff code blocks, images, links, and any GitHub-flavored markdown.

**Note:** PR comments go through the **Issues** API endpoint (`/repos/{owner}/{repo}/issues/{pr_number}/comments`), not the pulls endpoint.

**Code example:**

```js
await fetch(`https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    body: [
      '## CI Pipeline Summary\n',
      '| Check | Status | Duration |',
      '|-------|--------|----------|',
      '| Unit Tests | Pass | 2m 45s |',
      '| Security Scan | Fail | 1m 23s |',
      '',
      '<details>',
      '<summary><strong>Security Scan Details</strong> (click to expand)</summary>',
      '',
      '### HIGH: Weak password hashing',
      '**File:** `src/auth.ts:9`',
      '',
      '```diff',
      '- return Buffer.from(password).toString(\'base64\');',
      '+ return await hash(password, 12);',
      '```',
      '',
      '</details>',
      '',
      '---',
      '*Posted by CI Pipeline*',
    ].join('\n'),
  }),
});
```

### 4. PR Reviews API

Inline comments on specific lines of the diff, exactly like a human code reviewer. Shows up in the "Files changed" tab. This is what automated code review bots use.

**Features:**
- Comments pinned to specific lines in the diff
- Suggestion blocks (` ```suggestion `)
- Multi-line comments (using `start_line` and `line`)
- Review events: `COMMENT`, `APPROVE`, `REQUEST_CHANGES`

**Important:** Comments must reference lines that are within the diff hunk — you cannot comment on unchanged lines.

**Code example:**

```js
await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    commit_id: sha,
    event: 'COMMENT',
    body: '**CI Bot Review** — Found issues that should be addressed.',
    comments: [
      {
        path: 'src/auth.ts',
        line: 10,
        body: [
          '**Security: Weak password hashing**\n',
          '`base64` is encoding, not hashing. Replace with:\n',
          '```typescript',
          'import { hash } from \'bcrypt\';',
          'return await hash(password, 12);',
          '```',
        ].join('\n'),
      },
      {
        path: 'src/auth.ts',
        line: 4,
        body: 'TODO detected — should this be a tracked issue?',
      },
    ],
  }),
});
```

### Code Review & Approvals

GitHub's review system can be fully automated via the API. Your CI bot can act as a reviewer — approving, requesting changes, or commenting.

**Review events:**

| Event | Effect | Blocks merge? |
|-------|--------|---------------|
| `APPROVE` | Bot approves the PR | Unblocks (counts toward required approvals) |
| `REQUEST_CHANGES` | Bot blocks the PR | **Yes** — until same bot submits a new review |
| `COMMENT` | Informational, no opinion | No |

**CODEOWNERS** — auto-assign reviewers by file path:

```
# .github/CODEOWNERS
*                  @acme/platform-team
src/auth/          @acme/security-team
src/api/           @acme/backend-team @jane
packages/ui/       @acme/frontend-team
.github/workflows/ @acme/devops
*.sql              @acme/dba-team
```

When branch protection requires CODEOWNERS approval, the matched team **must** approve before merge.

**Automated review pattern** — bot blocks on failure, auto-approves on fix:

```js
// Security scan found issues → block the PR
await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commit_id: sha,
    event: 'REQUEST_CHANGES',
    body: '## 🔒 Security Review — Changes Requested\n\nFound 1 critical issue.',
    comments: [{
      path: 'src/auth.ts',
      line: 5,
      body: '```suggestion\n  return verifyJWT(token, { issuer: "auth.example.com" });\n```',
    }],
  }),
});

// Next push fixes the issue → bot auto-approves
await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commit_id: newSha,
    event: 'APPROVE',
    body: '## 🔒 Security Review — Approved\n\nAll issues resolved.',
  }),
});
```

**Other review APIs:**

| API | What it does |
|-----|-------------|
| `POST pulls/{pr}/requested_reviewers` | Request review from specific people/teams |
| `DELETE pulls/{pr}/requested_reviewers` | Remove review request |
| `PUT pulls/{pr}/reviews/{id}/dismissals` | Dismiss someone's review |

**Review Gate check run** — combine with a check run to show all approval requirements in one place:

```js
await createCheckRun(token, {
  name: 'Review Gate',
  head_sha: sha,
  status: 'completed',
  conclusion: 'action_required',
  output: {
    title: 'Awaiting required approvals',
    summary: [
      '| Requirement | Status | Who |',
      '|-------------|--------|-----|',
      '| Human approval (1 of 2) | ⏳ Pending | Anyone with write access |',
      '| CODEOWNERS: src/auth/ | ⏳ Pending | @acme/security-team |',
      '| Security Bot | ❌ Changes Requested | Automated |',
    ].join('\n'),
  },
  actions: [
    { label: 'Request reviews', description: 'Ping reviewers', identifier: 'request_reviews' },
  ],
});
```

**Branch protection enforcement:**

```
Branch: main
  ✅ Require pull request reviews
     - Required approvals: 2
     - Dismiss stale reviews on new pushes
     - Require review from CODEOWNERS
     - Require approval from someone other than author
  ✅ Require status checks (CI, Security Scan, Review Gate)
```

### 5. Deployments API

Creates deployment records that show up in the PR sidebar with "View deployment" buttons, and in the repository's Environments page.

**History:** Introduced January 2014, enhanced October 2018 with `environment_url` and `transient_environment` fields.

**Fields:**
- `ref` — the SHA or branch to deploy
- `environment` — name shown in the PR sidebar (e.g., "preview", "staging", "production")
- `transient_environment` — if true, auto-deactivated when a new deployment to the same environment is created (good for PR previews)
- `production_environment` — marks this as a production deployment
- `required_contexts` — list of status contexts that must pass before deploying (set to `[]` to skip)

**Status lifecycle:** `pending` -> `in_progress` -> `success` | `failure` | `error` | `inactive`

**Multiple deployments per PR:** You can create several deployment environments for a single PR — preview app, storybook, API docs, staging, performance tests. Each shows up as a separate entry in the PR sidebar with its own "View deployment" link.

**Using deployments for npm package publishes:** You can also (ab)use the Deployments API to record npm package publishes. Each published package gets its own deployment entry with the environment name set to something like `npm: @acme/auth@2.4.1-pr.1.0` and the `environment_url` pointing to the npm registry page. This shows up in the PR sidebar as a clickable link to each published package.

**Code example:**

```js
// Create a deployment
const { data: deployment } = await ghApi('POST', `/repos/${REPO}/deployments`, token, {
  ref: sha,
  environment: 'Preview',
  description: 'Ephemeral preview for this PR',
  auto_merge: false,
  required_contexts: [],
  transient_environment: true,
  production_environment: false,
});

// Set deployment status to success with a URL
await ghApi('POST', `/repos/${REPO}/deployments/${deployment.id}/statuses`, token, {
  state: 'success',
  environment_url: 'https://pr-1.preview.example.com',
  log_url: 'http://localhost:3457/pipeline?env=preview',
  description: 'Preview is live',
  auto_inactive: false,
});
```

### 6. SARIF Uploads

SARIF (Static Analysis Results Interchange Format) uploads put security findings into the **Security** tab of the repository. Unlike check run annotations which are ephemeral (attached to a single check run), SARIF findings are persistent — they are tracked across commits and deduplicated automatically.

**How it differs from check run annotations:**
- Check run annotations are tied to a specific check run on a specific commit. When you push a new commit, the old annotations disappear and new ones must be created.
- SARIF findings are tracked in the Security tab, show up in the "Code scanning alerts" section, and persist until the code is fixed. GitHub tracks whether a finding is new, existing, or fixed across commits.

SARIF uploads use `POST /repos/{owner}/{repo}/code-scanning/sarifs` with a gzip+base64-encoded SARIF file.

---

## GitHub App Setup

### Manifest Flow for Creating Apps

The fastest way to create a GitHub App is the manifest flow — you POST a JSON manifest to GitHub and it creates the app with the right permissions automatically. No manual form filling.

```js
const manifest = JSON.stringify({
  name: `ci-demo-${Date.now() % 100000}`,
  url: 'https://github.com/stefanpenner/github-ci-demo',
  hook_attributes: { url: 'https://example.com/webhook', active: false },
  redirect_url: 'http://localhost:3456/callback',
  public: false,
  default_permissions: {
    checks: 'write',
    contents: 'read',
    metadata: 'read',
  },
  default_events: ['check_run', 'check_suite'],
});
```

The `setup-app.js` script in this repo automates the full flow:
1. Starts a local HTTP server
2. Serves a form that auto-submits the manifest to `https://github.com/settings/apps/new`
3. GitHub redirects back with a `code` parameter
4. Exchanges the code at `https://api.github.com/app-manifests/{code}/conversions` for full app credentials
5. Saves app ID, slug, PEM key, webhook secret, client ID/secret to `.app-credentials.json`

### Required Permissions for Each API

| API | Permission | Level |
|-----|-----------|-------|
| Check Runs | `checks` | `write` |
| Commit Statuses | `statuses` | `write` |
| PR Comments | `issues` | `write` |
| PR Reviews | `pull_requests` | `write` |
| Deployments | `deployments` | `write` |
| SARIF Uploads | `security_events` | `write` |
| Read repo contents | `contents` | `read` |

### JWT Authentication -> Installation Token Flow

GitHub Apps use a two-step auth process:

1. **Create a JWT** — sign a payload with the app's private key (RS256). The JWT contains the app ID as the issuer (`iss`) and is valid for up to 10 minutes.
2. **Find the installation** — call `GET /repos/{owner}/{repo}/installation` with the JWT to find the installation ID for your repo.
3. **Get an installation token** — call `POST /app/installations/{id}/access_tokens` with the JWT to get a short-lived token scoped to that installation.

```js
async function getInstallationToken(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60),
    iss: appId,
  })).toString('base64url');

  const signature = crypto.sign('sha256',
    Buffer.from(`${header}.${payload}`),
    { key: pem, padding: crypto.constants.RSA_PKCS1_V1_5 }
  ).toString('base64url');

  const jwt = `${header}.${payload}.${signature}`;

  // Find the installation for our repo
  const installResp = await fetch(`https://api.github.com/repos/${REPO}/installation`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  const installation = await installResp.json();

  // Get an installation access token
  const tokenResp = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
    }
  );
  const tokenData = await tokenResp.json();
  return tokenData.token;
}
```

---

## Check Run Features Deep Dive

### Annotations

Annotations appear inline on the PR diff view — they look like lint errors pinned to specific lines of code. They also appear in the check run detail view as a list.

**Annotation levels:**
- `failure` — red, blocks merge if the check is required
- `warning` — yellow, informational
- `notice` — blue, informational

**Fields:**
- `path` — file path relative to the repo root
- `start_line` / `end_line` — line range to annotate
- `start_column` / `end_column` — optional column range for single-line annotations
- `title` — short heading shown on the annotation
- `message` — detailed message, supports multi-line text

**Important:** Annotations only show inline on the PR diff view, not on bare commit pages. On bare commits, they appear in the check run detail view but not inline in the code.

```js
annotations: [
  {
    path: 'src/auth.ts',
    start_line: 8,
    end_line: 9,
    annotation_level: 'failure',
    title: 'HIGH: Weak password hashing',
    message: 'Using base64 encoding is not a secure hashing method.\nUse bcrypt or argon2 instead.',
  },
  {
    path: 'src/auth.ts',
    start_line: 2,
    end_line: 4,
    annotation_level: 'warning',
    title: 'MEDIUM: No token expiry check',
    message: 'validateToken() only checks that the token is non-empty.',
  },
]
```

### Action Buttons

Check runs can include up to 3 action buttons. When clicked, they fire a `check_run.requested_action` webhook to your app with the `identifier` you specified.

**Constraints:** Max 3 buttons, 20-character label limit.

**Use cases:** Re-run a check, auto-fix issues, skip/dismiss a warning, trigger a dependency bump.

```js
actions: [
  { label: 'Re-run', description: 'Re-run coverage checks', identifier: 'rerun_coverage' },
  { label: 'View full report', description: 'Open detailed report', identifier: 'view_report' },
  { label: 'Auto-bump', description: 'Create a bump commit', identifier: 'auto_bump' },
]
```

### Rich Output

The `output` object supports full GitHub-flavored markdown in `summary` and `text` fields. You can include:
- Tables
- Code blocks with syntax highlighting
- Collapsible `<details>` sections
- Images via the `images` array: `{ alt: 'Coverage trend', image_url: 'https://...', caption: 'Last 30 days' }`
- Links

The `details_url` field adds a "Details" link next to the check name in the PR, pointing to your external CI dashboard.

```js
{
  name: 'Coverage Report',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  details_url: 'http://localhost:3457/pipeline',
  output: {
    title: '87.3% coverage (+1.2%)',
    summary: '## Coverage Report\n\n| Metric | Value | Delta |\n|--------|-------|-------|\n| Statements | 87.3% | +1.2% |',
  },
}
```

---

## Problem Matchers & Workflow Commands

### GHA Workflow Commands

In GitHub Actions, the runner parses special strings from stdout to create annotations and control behavior:

```
::error file=src/auth.ts,line=9,col=10,title=Buffer vulnerability::Found use of Buffer.from()...
::warning file=src/auth.ts,line=14,title=Insecure randomness::Math.random() is not secure.
::notice file=src/auth.ts,line=1,title=Missing JSDoc::Public exported function missing docs.
```

The runner also supports:
- `::debug::` — only shown if `ACTIONS_STEP_DEBUG=true`
- `::group::` / `::endgroup::` — collapsible log sections
- `::add-mask::` — prevents a value from appearing in logs

### Problem Matchers

Problem matchers are JSON files that define regex patterns to parse tool output (eslint, tsc, jest, etc.) into annotations. The runner watches stdout, matches lines against the regex, and creates annotations automatically.

### Replacing With Direct API Calls in Custom CI

In your own CI, you skip the runner entirely and parse tool output yourself, then post annotations via the Check Runs API. This is more reliable than problem matchers because you control the parsing logic directly.

The `post-matcher-style.js` script demonstrates this for four tools:

**ESLint** — parse `eslint --format json` output:

```js
function eslintToAnnotations(results) {
  const annotations = [];
  for (const file of results) {
    for (const msg of file.messages) {
      annotations.push({
        path: file.filePath,
        start_line: msg.line,
        end_line: msg.endLine || msg.line,
        start_column: msg.column,
        end_column: msg.endColumn || msg.column,
        annotation_level: msg.severity === 2 ? 'failure' : 'warning',
        title: msg.ruleId,
        message: msg.message,
      });
    }
  }
  return annotations;
}
```

**TypeScript** — parse `tsc --pretty false` output with regex:

```js
function tscToAnnotations(output) {
  const pattern = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm;
  const annotations = [];
  let match;
  while ((match = pattern.exec(output))) {
    annotations.push({
      path: match[1],
      start_line: parseInt(match[2]),
      end_line: parseInt(match[2]),
      start_column: parseInt(match[3]),
      annotation_level: match[4] === 'error' ? 'failure' : 'warning',
      title: match[5],
      message: match[6],
    });
  }
  return annotations;
}
```

**Jest** — parse `jest --json` output:

```js
function jestToAnnotations(output) {
  const annotations = [];
  for (const suite of output.testResults) {
    for (const test of suite.testResults) {
      if (test.status !== 'failed') continue;
      const lineMatch = test.failureMessages[0]?.match(/:(\d+):\d+\)/);
      const line = lineMatch ? parseInt(lineMatch[1]) : 1;
      annotations.push({
        path: suite.testFilePath,
        start_line: line,
        end_line: line,
        annotation_level: 'failure',
        title: `FAIL: ${test.fullName}`,
        message: test.failureMessages.join('\n'),
      });
    }
  }
  return annotations;
}
```

**Workflow commands** — parse `::error`/`::warning`/`::notice` strings:

```js
function workflowCommandsToAnnotations(commands) {
  const pattern = /^::(error|warning|notice)\s+(.+?)::(.+)$/;
  return commands.map(cmd => {
    const match = cmd.match(pattern);
    if (!match) return null;
    const level = match[1] === 'error' ? 'failure' : match[1] === 'warning' ? 'warning' : 'notice';
    const params = {};
    match[2].split(',').forEach(p => {
      const [k, v] = p.split('=');
      params[k] = v;
    });
    return {
      path: params.file,
      start_line: parseInt(params.line || '1'),
      end_line: parseInt(params.endLine || params.line || '1'),
      annotation_level: level,
      title: params.title || '',
      message: match[3],
    };
  }).filter(Boolean);
}
```

---

## Replacing GHA While Keeping GitHub Integration

### The Pattern

```
GitHub webhook (push/PR) → Your CI system → Run pipeline → Call GitHub APIs to report results
```

Your CI system receives webhooks, runs the build/test/deploy pipeline, then reports back using:
- **Check Runs API** — for test results, lint results, security scans (with inline annotations)
- **Deployments API** — for preview URLs, staging deploys, published packages
- **PR Comments** — for rich summaries with tables and collapsible sections
- **PR Reviews** — for inline code review comments on specific diff lines
- **Commit Statuses** — for simple pass/fail indicators

### Options for the CI System

Any of these can use the same integration pattern (webhooks in, status API out):
- **Buildkite** — hosted agents, YAML pipelines
- **CircleCI** — cloud or self-hosted
- **Jenkins** — self-hosted, plugin ecosystem
- **Dagger** — containerized pipelines defined in code
- **Drone** — container-native CI
- **Tekton** — Kubernetes-native pipelines
- **Concourse** — resource-based pipeline model

---

## GHA Power Features (if keeping GHA)

### Dynamic Workflows

**Dynamic matrix generation from code** — a job can output a JSON matrix that downstream jobs consume:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.check.outputs.matrix }}
      changed: ${{ steps.check.outputs.changed }}
    steps:
      - uses: actions/checkout@v4
      - id: check
        uses: ./.github/actions/check-packages
        with:
          packages-dir: packages
          fail-on-missing-tests: 'false'

  test:
    needs: check
    if: needs.check.outputs.matrix != ''
    strategy:
      matrix: ${{ fromJson(needs.check.outputs.matrix) }}
      fail-fast: false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "Testing ${{ matrix.package }} in ${{ matrix.dir }}"
          cd ${{ matrix.dir }}
          npm test
```

**Conditional jobs via outputs** — use `if:` conditions based on upstream job outputs.

**Triggering other workflows** — use `workflow_dispatch` or the repository dispatch API.

**Limitation:** You cannot dynamically add steps or jobs at runtime within a single workflow run.

### JavaScript/TypeScript Actions

A GitHub Action is just a Node.js script that the runner executes. The runner communicates via environment variables and file paths.

**How they work:** The runner sets env vars, the script reads them, runs logic, and writes results to stdout and special files.

**Communication channels:**

| Channel | Direction | Mechanism |
|---------|-----------|-----------|
| `INPUT_*` env vars | Runner -> Action | Inputs defined in `action.yml` become `INPUT_PACKAGES-DIR`, etc. |
| `GITHUB_OUTPUT` file | Action -> Runner | Write `key=value` lines to pass outputs to downstream steps/jobs |
| `GITHUB_STEP_SUMMARY` file | Action -> Runner | Write markdown to render in the Actions UI summary |
| `GITHUB_ENV` file | Action -> Runner | Write `KEY=VALUE` to set env vars for subsequent steps |
| `GITHUB_PATH` file | Action -> Runner | Write paths to add to `$PATH` for subsequent steps |
| Stdout `::` commands | Action -> Runner | `::error`, `::warning`, `::notice`, `::group`, `::add-mask`, etc. |

**`@actions/core` is just thin wrappers** — `core.getInput('name')` is just `process.env['INPUT_NAME']`, `core.setOutput()` is just writing to `$GITHUB_OUTPUT`, `core.setFailed()` is `process.exitCode = 1` plus `::error::`.

**Direct API calls with GITHUB_TOKEN** — you do not need the `@actions/github` SDK. You can call any GitHub API directly using `fetch`:

```js
const token = process.env.GITHUB_TOKEN;
await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    body: '## Changed Packages\n\n- `@acme/auth` - `@acme/api-client`',
  }),
});
```

**action.yml** — tells the runner what to execute:

```yaml
name: 'Check Packages'
description: 'Detect changed packages and post annotations'
inputs:
  packages-dir:
    description: 'Directory containing packages'
    default: 'packages'
  fail-on-missing-tests:
    description: 'Fail if a changed package has no tests'
    default: 'true'
outputs:
  changed:
    description: 'JSON array of changed package names'
  matrix:
    description: 'Matrix JSON for downstream jobs'
runs:
  using: node20
  main: index.js
```

### Other Key Features

- **OIDC federation** — exchange a GitHub-signed JWT for cloud provider credentials (AWS, GCP, Azure) without storing secrets. The JWT contains the repo, branch, and workflow identity.
- **Environments with deployment gates** — require reviewers to approve before deploying, add wait timers, or define custom protection rules via external APIs.
- **Merge queue** — CI runs on a temporary branch that rebases your PR onto the latest base branch, ensuring that what you test is what actually merges.
- **Concurrency groups** — cancel in-progress runs when a newer commit is pushed to the same PR: `concurrency: { group: "ci-${{ github.ref }}", cancel-in-progress: true }`.
- **Artifacts** — upload files from one job and download them in another. Good for build outputs, test reports, coverage data.
- **Reusable workflows** — `uses: org/repo/.github/workflows/shared.yml@main` with `secrets: inherit` to share CI definitions across repos.
- **github-script** — inline JavaScript in YAML steps using `actions/github-script@v7`. Gets an authenticated Octokit client for free.
- **Repository rulesets** — org-wide enforcement of required checks, branch protection, and merge requirements. Can be pushed from a central repo.
- **Custom deployment protection rules** — external services that GitHub calls before allowing a deployment to proceed. Your service returns approve/reject.

---

## Files in This Demo

| File | Purpose |
|------|---------|
| `setup-app.js` | Creates a GitHub App via the manifest flow. Opens browser, exchanges code for credentials, saves to `.app-credentials.json`. |
| `post-checks.js` | Posts 4 check runs to a commit: Security Scan (failure + annotations), Unit Tests (success + summary table), ESLint (neutral + warnings), Deploy Preview (in_progress). |
| `post-all-conclusions.js` | Creates 7 check runs demonstrating every possible `conclusion` value: success, failure, action_required, neutral, cancelled, timed_out, skipped. |
| `post-pr-checks.js` | Posts check runs with annotations targeted at PR diff lines — demonstrates how annotations appear inline in the "Files changed" tab. |
| `post-all-ui.js` | Demonstrates all 5 GitHub PR integration surfaces in one script: check run with action buttons, PR comment with tables/collapsible sections, PR review with inline comments, deployment status, and commit status. |
| `post-multi-deploy.js` | Creates 5 deployment environments for a single PR: Preview, Storybook, API Docs, Staging (in_progress), and Performance — showing how multiple deployments appear in the PR sidebar. |
| `post-artifacts.js` | Posts artifact/publish results: check runs for npm package publishes and Docker image builds, a deployment for the service preview, and a PR comment tying it all together. |
| `post-dependency-check.js` | Creates an `action_required` check run with action buttons (Auto-bump, Skip) for dependency management in a monorepo. |
| `post-npm-deployments.js` | Uses the Deployments API to record npm package publishes — each package gets its own deployment entry linking to the npm registry page. |
| `post-matcher-style.js` | Parses simulated tool output (ESLint JSON, tsc, Jest JSON, GHA workflow commands) and converts them to Check Run annotations — replacing GHA problem matchers with direct API calls. |
| `update-checks-with-url.js` | Updates existing check runs to add `details_url` pointing to the CI dashboard. |
| `ci-dashboard.js` | A standalone HTTP server that renders a CI pipeline dashboard (HTML/CSS/JS). Shows stages, jobs, status indicators, expandable logs, and a timeline bar. Used as the `details_url` target. |
| `.github/actions/check-packages/index.js` | A GitHub Action written in plain Node.js (no build step, no SDK). Demonstrates all runner communication channels: `INPUT_*` env vars, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `GITHUB_ENV`, `GITHUB_PATH`, `::error`/`::warning`/`::notice` commands, `::group`/`::endgroup`, `::add-mask`, and direct API calls with `GITHUB_TOKEN`. |
| `.github/actions/check-packages/action.yml` | Action metadata — declares inputs, outputs, and `runs: using: node20`. |
| `.github/workflows/ci.yml` | Workflow that uses the custom action to detect changed packages, then runs a dynamic matrix of test jobs — one per changed package. |
| `src/auth.ts` | Intentionally vulnerable sample code (base64 "hashing", no token validation) used as the target for security scan annotations and review comments. |
| `src/api.ts` | Sample API handlers that use the vulnerable auth module — target for lint and type-check annotations. |
| `post-reviews.js` | Posts automated code review examples: `REQUEST_CHANGES` (Security Bot blocks PR), `COMMENT` (Docs Bot suggests), a review summary PR comment, and a Review Gate check run tracking all approval requirements. |
| `post-extra-examples.js` | Posts additional examples: CodeQL/SARIF-style findings, merge readiness gate, performance benchmarks, license compliance, bundle size deployment, API diff comment, and canary deployment. |
| `.app-credentials.json` | Stored GitHub App credentials (app_id, pem, webhook_secret, etc.) — created by `setup-app.js`, consumed by all `post-*.js` scripts. |
