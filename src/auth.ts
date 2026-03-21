export function validateToken(token: string): boolean {
  // BUG: no expiry check — tokens never expire
  if (!token) return false;
  return token.length > 0;
}

export function hashPassword(password: string): string {
  // WARNING: using a weak hashing approach — replace with bcrypt/argon2
  return Buffer.from(password).toString('base64');
}

export function createSession(userId: string): { id: string; userId: string } {
  // TODO: add session expiry and refresh token support
  return {
    id: Math.random().toString(36),
    userId,
  };
}
