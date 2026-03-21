// Simulates what GHA problem matchers + workflow commands do behind the scenes.
// We parse tool output and convert it to Check Run annotations.

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

async function createCheckRun(token, sha, checkRun) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ head_sha: sha, ...checkRun }),
  });
  const data = await resp.json();
  if (resp.ok) console.log(`✅ ${checkRun.name}`);
  else console.error(`❌ ${checkRun.name}:`, data.message);
}

// ── Simulate tool outputs ──────────────────────────────

// Simulated ESLint JSON output (what `eslint --format json` produces)
const eslintOutput = [
  {
    filePath: 'src/auth.ts',
    messages: [
      { ruleId: 'no-unsafe-return', severity: 2, message: 'Unsafe return of an `any` typed value.', line: 4, column: 3, endLine: 4, endColumn: 24 },
      { ruleId: 'security/detect-buffer-noassert', severity: 2, message: 'Found Buffer with noAssert flag. This could lead to memory corruption.', line: 9, column: 10, endLine: 9, endColumn: 52 },
      { ruleId: 'no-magic-numbers', severity: 1, message: 'No magic number: 36.', line: 14, column: 34, endLine: 14, endColumn: 36 },
    ],
  },
  {
    filePath: 'src/api.ts',
    messages: [
      { ruleId: 'no-unused-vars', severity: 1, message: "'password' is defined but never used.", line: 6, column: 18, endLine: 6, endColumn: 26 },
      { ruleId: '@typescript-eslint/no-unsafe-assignment', severity: 2, message: 'Unsafe assignment of an `any` typed value.', line: 5, column: 9, endLine: 5, endColumn: 30 },
    ],
  },
];

// Simulated TypeScript compiler output (what `tsc --pretty false` produces)
const tscOutput = `src/auth.ts(9,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'BufferEncoding'.
src/api.ts(5,18): error TS7006: Parameter 'req' implicitly has an 'any' type.
src/api.ts(14,18): error TS7006: Parameter 'req' implicitly has an 'any' type.`;

// Simulated Jest output (what `jest --json` produces)
const jestOutput = {
  numPassedTests: 44,
  numFailedTests: 3,
  testResults: [
    {
      testFilePath: 'src/auth.test.ts',
      testResults: [
        { status: 'failed', fullName: 'validateToken should reject expired tokens', failureMessages: ['Expected: false\nReceived: true\n\n  at Object.<anonymous> (src/auth.test.ts:23:5)'] },
        { status: 'failed', fullName: 'hashPassword should use bcrypt', failureMessages: ['Expected string matching /^\\$2[aby]\\$/\nReceived: "cGFzc3dvcmQ="\n\n  at Object.<anonymous> (src/auth.test.ts:31:5)'] },
      ],
    },
    {
      testFilePath: 'src/api.test.ts',
      testResults: [
        { status: 'failed', fullName: 'handleLogin should validate credentials', failureMessages: ['Expected: 401\nReceived: 200\n\n  at Object.<anonymous> (src/api.test.ts:15:5)'] },
      ],
    },
  ],
};

// Simulated GHA workflow commands (what ::error, ::warning, ::notice do)
const workflowCommands = [
  '::error file=src/auth.ts,line=9,col=10,endColumn=52,title=Buffer vulnerability::Found use of Buffer.from() without input validation. This is flagged by OWASP A03:2021.',
  '::warning file=src/auth.ts,line=14,title=Insecure randomness::Math.random() is not cryptographically secure. Use crypto.randomUUID() instead.',
  '::notice file=src/auth.ts,line=1,title=Missing JSDoc::Public exported function missing documentation.',
];

// ── Parse and convert ──────────────────────────────────

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

function jestToAnnotations(output) {
  const annotations = [];
  for (const suite of output.testResults) {
    for (const test of suite.testResults) {
      if (test.status !== 'failed') continue;
      // Extract line number from stack trace
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

async function main() {
  const creds = JSON.parse(fs.readFileSync('.app-credentials.json', 'utf-8'));
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const token = await getInstallationToken(creds.app_id, creds.pem);

  console.log('Posting tool output as annotations...\n');

  // ESLint
  const eslintAnnotations = eslintToAnnotations(eslintOutput);
  const eslintErrors = eslintAnnotations.filter(a => a.annotation_level === 'failure').length;
  const eslintWarnings = eslintAnnotations.filter(a => a.annotation_level === 'warning').length;
  await createCheckRun(token, sha, {
    name: 'ESLint (parsed from --format json)',
    status: 'completed',
    conclusion: eslintErrors > 0 ? 'failure' : 'neutral',
    output: {
      title: `${eslintErrors} errors, ${eslintWarnings} warnings`,
      summary: [
        '## ESLint Results\n',
        `Parsed from \`eslint --format json\` output.\n`,
        `| Severity | Count |`,
        `|----------|-------|`,
        `| Errors | ${eslintErrors} |`,
        `| Warnings | ${eslintWarnings} |`,
      ].join('\n'),
      annotations: eslintAnnotations,
    },
  });

  // TypeScript
  const tscAnnotations = tscToAnnotations(tscOutput);
  await createCheckRun(token, sha, {
    name: 'TypeScript (parsed from tsc output)',
    status: 'completed',
    conclusion: tscAnnotations.length > 0 ? 'failure' : 'success',
    output: {
      title: `${tscAnnotations.length} type errors`,
      summary: [
        '## TypeScript Compiler\n',
        `Parsed from \`tsc --pretty false\` output using regex:\n`,
        '```',
        '^(.+)\\((\\d+),(\\d+)\\): (error|warning) (TS\\d+): (.+)$',
        '```\n',
        `Found **${tscAnnotations.length} errors**.`,
      ].join('\n'),
      annotations: tscAnnotations,
    },
  });

  // Jest
  const jestAnnotations = jestToAnnotations(jestOutput);
  await createCheckRun(token, sha, {
    name: 'Jest (parsed from --json)',
    status: 'completed',
    conclusion: jestOutput.numFailedTests > 0 ? 'failure' : 'success',
    output: {
      title: `${jestOutput.numPassedTests} passed, ${jestOutput.numFailedTests} failed`,
      summary: [
        '## Test Results\n',
        `Parsed from \`jest --json\` output.\n`,
        `| | Count |`,
        `|---|---|`,
        `| ✅ Passed | ${jestOutput.numPassedTests} |`,
        `| ❌ Failed | ${jestOutput.numFailedTests} |`,
      ].join('\n'),
      annotations: jestAnnotations,
    },
  });

  // Workflow commands
  const cmdAnnotations = workflowCommandsToAnnotations(workflowCommands);
  await createCheckRun(token, sha, {
    name: 'Custom checks (::error/::warning/::notice)',
    status: 'completed',
    conclusion: cmdAnnotations.some(a => a.annotation_level === 'failure') ? 'failure' : 'neutral',
    output: {
      title: `${cmdAnnotations.length} annotations from workflow commands`,
      summary: [
        '## Workflow Command Annotations\n',
        'These simulate what GHA does when your script outputs `::error`, `::warning`, or `::notice`.\n',
        'In GHA, the runner parses these from stdout. In your own CI, you\'d parse them yourself:',
        '',
        '```',
        '::error file=src/auth.ts,line=9,title=Buffer vulnerability::Found use of Buffer.from()...',
        '::warning file=src/auth.ts,line=14,title=Insecure randomness::Math.random() is not...',
        '::notice file=src/auth.ts,line=1,title=Missing JSDoc::Public exported function...',
        '```',
      ].join('\n'),
      annotations: cmdAnnotations,
    },
  });

  console.log(`\nDone! https://github.com/${REPO}/pull/1`);
}

main().catch(console.error);
