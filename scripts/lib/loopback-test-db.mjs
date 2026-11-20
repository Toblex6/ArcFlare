// Never include a connection string (even on failure) in test output.
export function assertLoopbackTestDb(value = process.env.DATABASE_URL) {
  // Validate the literal authority before URL parsing can normalize it. No
  // sockets, multi-host URLs, or query overrides of host/port are allowed.
  const match = typeof value === 'string' && /^postgres(?:ql)?:\/\/[^/?#\s\\]+\/[^?#\s\\]+(?:\?[^#\s\\]*)?$/.test(value);
  if (match && !/[\r\n\t]/.test(value)) {
    const authority = value.split('/')[2];
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) {
      try {
        const url = new URL(value);
        const allowed = new Set(['schema', 'sslmode', 'connection_limit', 'connect_timeout', 'pool_timeout']);
        if ([...url.searchParams.keys()].every((key) => allowed.has(key))) return value;
      } catch { /* fail closed */ }
    }
  }
  throw new Error('Refusing to run: DATABASE_URL must explicitly target a loopback PostgreSQL test database (localhost, 127.0.0.1 or [::1]), without routing overrides.');
}
