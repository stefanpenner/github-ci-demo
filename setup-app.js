// This script:
// 1. Starts a local server
// 2. Opens your browser to register a GitHub App via the manifest flow
// 3. Exchanges the code for app credentials (private key, app ID, etc.)
// 4. Saves them to .app-credentials.json

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const PORT = 3456;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;

const manifest = JSON.stringify({
  name: `ci-demo-${Date.now() % 100000}`,
  url: 'https://github.com/stefanpenner/github-ci-demo',
  hook_attributes: { url: 'https://example.com/webhook', active: false },
  redirect_url: CALLBACK_URL,
  public: false,
  default_permissions: {
    checks: 'write',
    contents: 'read',
    metadata: 'read',
  },
  default_events: ['check_run', 'check_suite'],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    // Serve a form that auto-submits to GitHub's app manifest registration
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body>
        <form id="f" method="post" action="https://github.com/settings/apps/new">
          <input type="hidden" name="manifest" value='${manifest}' />
        </form>
        <script>document.getElementById('f').submit();</script>
      </body></html>
    `);
  } else if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code parameter');
      return;
    }

    // Exchange code for app credentials
    try {
      const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
        },
      });
      const data = await resp.json();

      const credentials = {
        app_id: data.id,
        app_slug: data.slug,
        pem: data.pem,
        webhook_secret: data.webhook_secret,
        client_id: data.client_id,
        client_secret: data.client_secret,
      };

      fs.writeFileSync('.app-credentials.json', JSON.stringify(credentials, null, 2));

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body>
          <h1>Done! GitHub App created.</h1>
          <p>App ID: <strong>${data.id}</strong></p>
          <p>App slug: <strong>${data.slug}</strong></p>
          <p>Credentials saved to <code>.app-credentials.json</code></p>
          <p>You can close this tab and go back to the terminal.</p>
        </body></html>
      `);

      console.log(`\n✅ App created! ID: ${data.id}, slug: ${data.slug}`);
      console.log('Credentials saved to .app-credentials.json');
      setTimeout(() => process.exit(0), 1000);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
      console.error(err);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\nOpening browser to register the GitHub App...`);
  console.log(`If it doesn't open, visit: http://localhost:${PORT}\n`);
  execSync(`open http://localhost:${PORT}`);
});
