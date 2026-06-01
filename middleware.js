// Vercel Edge Middleware — runs before every request.
// Redirects unauthenticated visitors to /login.
// Bypasses: /login, /api/auth (the login endpoint itself).

export default function middleware(request) {
  const { pathname } = new URL(request.url);

  // Never gate the login page or the auth endpoint.
  if (pathname === '/login' || pathname === '/login.html' ||
      pathname.startsWith('/api/auth')) {
    return;
  }

  const expected = process.env.AUTH_TOKEN;
  if (!expected) return; // no token configured — open (dev mode safety)

  // Read the cookie named "vmauth".
  const cookieHeader = request.headers.get('cookie') || '';
  const token = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('vmauth='))
    ?.slice('vmauth='.length);

  if (token === expected) return; // authenticated — let through

  // Not authenticated — redirect to login, remembering where they wanted to go.
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return Response.redirect(loginUrl, 302);
}

export const config = {
  matcher: ['/((?!_vercel|favicon\\.ico).*)']
};
