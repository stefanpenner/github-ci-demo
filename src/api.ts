import { validateToken, createSession } from './auth';

export async function handleLogin(req: Request): Promise<Response> {
  const body = await req.json();
  const { username, password } = body;

  // Validate credentials against auth service
  const isValid = await verifyCredentials(username, password);
  if (!isValid) {
    return new Response('Invalid credentials', { status: 401 });
  }
  const session = createSession(username);

  return new Response(JSON.stringify(session), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleProtected(req: Request): Promise<Response> {
  const token = req.headers.get('Authorization');

  if (!validateToken(token ?? '')) {
    return new Response('Unauthorized', { status: 401 });
  }

  return new Response(JSON.stringify({ data: 'secret stuff' }), {
    status: 200,
  });
}
