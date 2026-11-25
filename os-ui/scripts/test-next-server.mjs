/* test-only shim for next/server */
export const NextResponse = {
  json(obj, init) {
    // `headers` + `cookies.set` mirror the parts of NextResponse a route uses to set or expire a
    // cookie (e.g. /api/auth/me signing out a deactivated user), so a test can read them back.
    const headers = new Headers((init && init.headers) || undefined);
    return {
      status: (init && init.status) || 200,
      headers,
      cookies: {
        set(name, value, opts) {
          headers.append('set-cookie', `${name}=${value}; Max-Age=${opts && opts.maxAge !== undefined ? opts.maxAge : ''}`);
        },
      },
      async json() { return obj; },
    };
  },
};
