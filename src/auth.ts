export function validateToken(token: string): boolean {
  // BUG: no expiry check
  if (!token) return false;
  // TODO: check expiry, signature, issuer
  return token.length > 0;
}

export function hashPassword(password: string): string {
  // WARNING: using a weak hashing approach
  return Buffer.from(password).toString('base64');
}

export function createSession(userId: string): { id: string; userId: string } {
  return {
    id: Math.random().toString(36),
    userId,
  };
}
