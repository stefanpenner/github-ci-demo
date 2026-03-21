import { handleLogin, handleProtected } from './api';

const PORT = 3000;

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === '/api/login' && req.method === 'POST') {
      return handleLogin(req);
    }
    if (url.pathname === '/api/protected') {
      return handleProtected(req);
    }
    if (url.pathname === '/healthz') {
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Auth service listening on :${PORT}`);
