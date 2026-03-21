// This is a GitHub Action written in plain Node.js.
// No build step needed — the runner executes this directly.
//
// The @actions/core and @actions/github packages are just thin wrappers
// around env vars and stdout. You don't strictly need them — I'll show both ways.

// ─── RAW approach (no dependencies) ────────────────────

// Reading inputs: the runner sets INPUT_<NAME> env vars (uppercased, hyphens → underscores)
const packagesDir = process.env['INPUT_PACKAGES-DIR'] || 'packages';
const failOnMissingTests = process.env['INPUT_FAIL-ON-MISSING-TESTS'] === 'true';

// Reading the event payload: full webhook JSON
const fs = require('fs');
const eventPath = process.env.GITHUB_EVENT_PATH;
const event = eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf-8')) : {};

// Reading context
const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/');
const sha = process.env.GITHUB_SHA || 'unknown';

// ─── Your actual CI logic ──────────────────────────────

async function main() {
  console.log(`Checking packages in ${packagesDir}/`);
  console.log(`Event: ${process.env.GITHUB_EVENT_NAME}`);
  console.log(`SHA: ${sha}`);
  console.log(`PR: #${event.pull_request?.number || 'N/A'}`);

  // Simulate detecting changed packages
  // In reality: git diff --name-only origin/main...HEAD | parse package dirs
  const changedPackages = [
    { name: '@acme/auth', dir: 'packages/auth', hasTests: true, testsPassed: false },
    { name: '@acme/api-client', dir: 'packages/api-client', hasTests: true, testsPassed: true },
    { name: '@acme/shared-types', dir: 'packages/shared-types', hasTests: false, testsPassed: null },
  ];

  // ─── Communicating back to the runner ─────────────────

  // 1. Logging with levels — runner parses these prefixes
  console.log('This is a normal log line');
  // These are equivalent to core.info(), core.warning(), etc:
  process.stdout.write('::debug::This only shows if ACTIONS_STEP_DEBUG=true\n');
  process.stdout.write('::notice::Found 3 changed packages\n');

  // 2. Annotations — these become inline annotations on the PR
  //    Same as ::error/::warning/::notice but with file/line info
  for (const pkg of changedPackages) {
    if (!pkg.hasTests) {
      process.stdout.write(
        `::error file=${pkg.dir}/package.json,line=1,title=Missing tests::` +
        `Package ${pkg.name} has no test suite. Add tests before merging.\n`
      );
    }
    if (pkg.hasTests && !pkg.testsPassed) {
      process.stdout.write(
        `::error file=${pkg.dir}/src/index.ts,line=1,title=Tests failed::` +
        `${pkg.name}: 3 tests failed\n`
      );
    }
    if (pkg.testsPassed) {
      process.stdout.write(
        `::notice file=${pkg.dir}/package.json,line=1,title=Tests passed::` +
        `${pkg.name}: all tests passed\n`
      );
    }
  }

  // 3. Setting outputs — downstream jobs/steps can read these
  //    Writes to the file at $GITHUB_OUTPUT
  const outputFile = process.env.GITHUB_OUTPUT;
  const changed = changedPackages.map(p => p.name);
  const matrix = { include: changedPackages.map(p => ({ package: p.name, dir: p.dir })) };

  if (outputFile) {
    // Multi-line outputs use a delimiter
    fs.appendFileSync(outputFile, `changed=${JSON.stringify(changed)}\n`);
    fs.appendFileSync(outputFile, `matrix=${JSON.stringify(matrix)}\n`);
  }

  // 4. Job summary — renders markdown in the Actions UI
  //    Writes to the file at $GITHUB_STEP_SUMMARY
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const summary = [
      '## Package Check Results\n',
      '| Package | Tests | Status |',
      '|---------|-------|--------|',
      ...changedPackages.map(p => {
        const status = !p.hasTests ? '❌ No tests' : p.testsPassed ? '✅ Passed' : '❌ Failed';
        return `| \`${p.name}\` | ${p.hasTests ? 'Yes' : 'No'} | ${status} |`;
      }),
      '',
      `\n### Next Steps\n`,
      ...changedPackages.filter(p => !p.hasTests).map(p => `- Add tests for \`${p.name}\``),
      ...changedPackages.filter(p => p.hasTests && !p.testsPassed).map(p => `- Fix failing tests in \`${p.name}\``),
    ].join('\n');
    fs.appendFileSync(summaryFile, summary);
  }

  // 5. Grouping log output — collapsible sections in the log viewer
  process.stdout.write('::group::Detailed package analysis\n');
  for (const pkg of changedPackages) {
    console.log(`\n📦 ${pkg.name} (${pkg.dir})`);
    console.log(`   Tests: ${pkg.hasTests ? 'yes' : 'no'}`);
    console.log(`   Passed: ${pkg.testsPassed}`);
  }
  process.stdout.write('::endgroup::\n');

  // 6. Environment variables for subsequent steps
  const envFile = process.env.GITHUB_ENV;
  if (envFile) {
    fs.appendFileSync(envFile, `CHANGED_COUNT=${changedPackages.length}\n`);
    fs.appendFileSync(envFile, `HAS_FAILURES=${changedPackages.some(p => !p.testsPassed)}\n`);
  }

  // 7. Adding to PATH for subsequent steps
  const pathFile = process.env.GITHUB_PATH;
  if (pathFile) {
    fs.appendFileSync(pathFile, `/usr/local/custom-tools/bin\n`);
  }

  // 8. Masking secrets — prevents them from appearing in logs
  const tempToken = 'super-secret-value-12345';
  process.stdout.write(`::add-mask::${tempToken}\n`);
  console.log(`Using token: ${tempToken}`);  // will print "Using token: ***"

  // 9. Fail the action — set exit code
  const hasFailures = changedPackages.some(p => !p.testsPassed || (!p.hasTests && failOnMissingTests));
  if (hasFailures) {
    // core.setFailed() is just this:
    process.stdout.write('::error::Package checks failed — see annotations above\n');
    process.exitCode = 1;
  }

  // ─── BONUS: Direct API calls (no SDK needed) ─────────
  // You have a GITHUB_TOKEN — you can call any GitHub API directly
  if (token && event.pull_request) {
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${event.pull_request.number}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: `## 📦 Changed Packages\n\n${changedPackages.map(p => `- \`${p.name}\` ${p.testsPassed ? '✅' : '❌'}`).join('\n')}`,
      }),
    });
  }
}

main().catch(err => {
  process.stdout.write(`::error::${err.message}\n`);
  process.exitCode = 1;
});
