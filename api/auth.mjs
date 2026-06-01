// POST /api/auth        — log in (sets the vmauth cookie)
// DELETE /api/auth      — log out (clears the cookie)
// GET  /api/auth/logout — log out via link/redirect

export default function handler(req, res) {
  if (req.method === 'POST') {
    return login(req, res);
  }
  if (req.method === 'DELETE' || (req.method === 'GET' && req.url.includes('logout'))) {
    return logout(res);
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function login(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let password;
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { password = JSON.parse(body).password; } catch { /* ignore */ }
  } else {
    // form-encoded
    password = new URLSearchParams(body).get('password');
  }

  if (!password || password !== process.env.SITE_PASSWORD) {
    res.status(401).json({ error: 'Wrong password' });
    return;
  }

  const token = process.env.AUTH_TOKEN;
  // 7-day HttpOnly cookie — safe from JS reading it.
  res.setHeader('Set-Cookie',
    `vmauth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
  res.status(200).json({ ok: true });
}

function logout(res) {
  res.setHeader('Set-Cookie',
    'vmauth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.writeHead(302, { Location: '/login' });
  res.end();
}
