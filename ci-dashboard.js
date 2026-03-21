// A minimal CI dashboard that shows pipeline flow with rich UI.
// In production, this would be your hosted CI web app.

const http = require('http');
const PORT = 3457;

const PIPELINE = {
  name: 'main pipeline',
  sha: '08c08a1',
  repo: 'stefanpenner/github-ci-demo',
  trigger: 'push to main',
  started: '2026-03-20T10:00:00Z',
  stages: [
    {
      name: 'Setup',
      status: 'success',
      duration: '4s',
      jobs: [
        { name: 'Checkout', status: 'success', duration: '1s', log: 'Cloned repo at 08c08a1' },
        { name: 'Install deps', status: 'success', duration: '3s', log: 'npm ci — 142 packages in 2.8s' },
      ],
    },
    {
      name: 'Quality',
      status: 'failure',
      duration: '1m 23s',
      parallel: true,
      jobs: [
        { name: 'ESLint', status: 'neutral', duration: '12s', log: '0 errors, 2 warnings' },
        { name: 'TypeScript', status: 'success', duration: '8s', log: 'tsc --noEmit — 0 errors' },
        { name: 'Security Scan', status: 'failure', duration: '1m 23s', log: '2 vulnerabilities found\n\nHIGH: Weak password hashing (src/auth.ts:8)\nMEDIUM: No token expiry check (src/auth.ts:2)' },
      ],
    },
    {
      name: 'Test',
      status: 'success',
      duration: '2m 45s',
      parallel: true,
      jobs: [
        { name: 'Unit Tests', status: 'success', duration: '1.2s', log: '47 passed, 0 failed' },
        { name: 'Integration', status: 'success', duration: '45s', log: '17 passed, 0 failed' },
        { name: 'E2E (Chrome)', status: 'success', duration: '2m 45s', log: '8 passed, 0 failed' },
      ],
    },
    {
      name: 'Deploy',
      status: 'blocked',
      duration: '-',
      jobs: [
        { name: 'Deploy Preview', status: 'blocked', duration: '-', log: 'Blocked: upstream failure in Quality stage' },
      ],
    },
  ],
};

function statusIcon(status) {
  return {
    success: '✅', failure: '❌', neutral: '⚠️',
    running: '🔄', blocked: '⛔', skipped: '⏭️',
  }[status] || '⬜';
}

function statusColor(status) {
  return {
    success: '#2da44e', failure: '#cf222e', neutral: '#bf8700',
    running: '#0969da', blocked: '#656d76', skipped: '#656d76',
  }[status] || '#656d76';
}

function renderPipeline(pipeline) {
  const stagesHtml = pipeline.stages.map((stage, i) => {
    const jobsHtml = stage.jobs.map(job => `
      <div class="job" data-status="${job.status}">
        <div class="job-header">
          <span class="status-icon">${statusIcon(job.status)}</span>
          <span class="job-name">${job.name}</span>
          <span class="job-duration">${job.duration}</span>
        </div>
        <pre class="job-log">${job.log}</pre>
      </div>
    `).join('');

    const connector = i < pipeline.stages.length - 1
      ? `<div class="connector"><div class="connector-line" style="border-color: ${statusColor(stage.status)}"></div><div class="connector-arrow" style="border-left-color: ${statusColor(pipeline.stages[i + 1].status)}"></div></div>`
      : '';

    return `
      <div class="stage-wrapper">
        <div class="stage" data-status="${stage.status}">
          <div class="stage-header">
            <span class="status-icon">${statusIcon(stage.status)}</span>
            <span class="stage-name">${stage.name}</span>
            ${stage.parallel ? '<span class="parallel-badge">parallel</span>' : ''}
            <span class="stage-duration">${stage.duration}</span>
          </div>
          <div class="jobs ${stage.parallel ? 'parallel' : 'sequential'}">${jobsHtml}</div>
        </div>
        ${connector}
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>CI Pipeline — ${pipeline.repo}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      padding: 32px; min-height: 100vh;
    }
    .header {
      margin-bottom: 32px; padding-bottom: 16px;
      border-bottom: 1px solid #30363d;
    }
    .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .header .meta { color: #8b949e; font-size: 13px; display: flex; gap: 16px; flex-wrap: wrap; }
    .header .meta code {
      background: #161b22; padding: 2px 6px; border-radius: 4px;
      font-family: 'SF Mono', monospace; font-size: 12px; color: #79c0ff;
    }
    .pipeline { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding: 16px 0; }
    .stage-wrapper { display: flex; align-items: flex-start; }
    .connector { display: flex; align-items: center; padding-top: 20px; width: 48px; }
    .connector-line {
      flex: 1; height: 0; border-top: 2px dashed #30363d;
    }
    .connector-arrow {
      width: 0; height: 0;
      border-top: 6px solid transparent; border-bottom: 6px solid transparent;
      border-left: 8px solid #30363d;
    }
    .stage {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      min-width: 220px; max-width: 280px; overflow: hidden;
    }
    .stage[data-status="failure"] { border-color: #cf222e55; }
    .stage[data-status="success"] { border-color: #2da44e55; }
    .stage-header {
      padding: 12px 16px; display: flex; align-items: center; gap: 8px;
      border-bottom: 1px solid #30363d; background: #0d1117;
    }
    .stage-name { font-weight: 600; font-size: 14px; flex: 1; }
    .stage-duration { font-size: 12px; color: #8b949e; font-family: 'SF Mono', monospace; }
    .parallel-badge {
      font-size: 10px; background: #1f6feb33; color: #58a6ff;
      padding: 2px 6px; border-radius: 10px; font-weight: 500;
    }
    .jobs { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .jobs.parallel .job { border-left: 2px solid #1f6feb55; }
    .job {
      background: #0d1117; border-radius: 8px; padding: 10px 12px;
      border: 1px solid #21262d; cursor: pointer; transition: border-color 0.15s;
    }
    .job:hover { border-color: #58a6ff; }
    .job[data-status="failure"] { background: #cf222e11; }
    .job-header { display: flex; align-items: center; gap: 6px; }
    .job-name { font-size: 13px; flex: 1; }
    .job-duration { font-size: 11px; color: #8b949e; font-family: 'SF Mono', monospace; }
    .status-icon { font-size: 14px; }
    .job-log {
      display: none; margin-top: 8px; padding: 8px;
      background: #010409; border-radius: 6px; font-size: 11px;
      font-family: 'SF Mono', monospace; color: #8b949e;
      white-space: pre-wrap; line-height: 1.5;
      border: 1px solid #21262d;
    }
    .job.expanded .job-log { display: block; }

    .timeline {
      margin-top: 32px; padding-top: 16px; border-top: 1px solid #30363d;
    }
    .timeline h2 { font-size: 14px; margin-bottom: 12px; color: #8b949e; }
    .timeline-bar {
      display: flex; height: 32px; border-radius: 6px; overflow: hidden;
      background: #161b22; border: 1px solid #30363d;
    }
    .timeline-segment {
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 500; color: #fff;
      transition: opacity 0.15s; cursor: pointer; position: relative;
    }
    .timeline-segment:hover { opacity: 0.8; }
    .timeline-segment span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${statusIcon(pipeline.stages.some(s => s.status === 'failure') ? 'failure' : 'success')} ${pipeline.name}</h1>
    <div class="meta">
      <span>Repo: <code>${pipeline.repo}</code></span>
      <span>Commit: <code>${pipeline.sha}</code></span>
      <span>Trigger: ${pipeline.trigger}</span>
      <span>Started: ${new Date(pipeline.started).toLocaleString()}</span>
    </div>
  </div>

  <div class="pipeline">${stagesHtml}</div>

  <div class="timeline">
    <h2>Timeline</h2>
    <div class="timeline-bar">
      <div class="timeline-segment" style="width: 3%; background: ${statusColor('success')}"><span>Setup</span></div>
      <div class="timeline-segment" style="width: 25%; background: ${statusColor('failure')}"><span>Quality</span></div>
      <div class="timeline-segment" style="width: 55%; background: ${statusColor('success')}"><span>Test</span></div>
      <div class="timeline-segment" style="width: 17%; background: ${statusColor('blocked')}"><span>Deploy</span></div>
    </div>
  </div>

  <script>
    document.querySelectorAll('.job').forEach(job => {
      job.addEventListener('click', () => job.classList.toggle('expanded'));
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/pipeline')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPipeline(PIPELINE));
  } else if (req.url === '/api/pipeline') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(PIPELINE));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`CI Dashboard running at http://localhost:${PORT}`);
});
