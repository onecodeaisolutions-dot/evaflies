// Autenticação simples por "código de acesso", para separar dados por vendedor.
// Usuários são definidos via a variável de ambiente EVA_USERS (JSON), ex:
//   [{"key":"rian-9f3a","name":"Rian","email":"rian@x.com","admin":true},
//    {"key":"vend1-7c2b","name":"Vendedor 1"},
//    {"key":"vend2-4d8e","name":"Vendedor 2"}]
// Se EVA_USERS estiver vazio/ausente, a auth fica DESLIGADA e tudo funciona
// abertamente (compatível com a versão atual da extensão).

let users = [];
try {
  const parsed = JSON.parse(process.env.EVA_USERS || '[]');
  users = Array.isArray(parsed) ? parsed : [];
} catch {
  console.warn('⚠️  EVA_USERS não é um JSON válido — autenticação desligada.');
  users = [];
}

export const authEnabled = users.length > 0;

// Id estável do dono (não usamos a key, que pode ser rotacionada).
const ownerIdOf = (u) => u.email || u.name || u.key;

export function resolveKey(key) {
  if (!key) return null;
  const u = users.find((x) => x.key === key);
  if (!u) return null;
  return {
    name: u.name || u.email || 'Usuário',
    email: u.email || null,
    admin: Boolean(u.admin),
    id: ownerIdOf(u),
  };
}

function keyFromReq(req) {
  return (
    req.get('x-eva-key') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    req.query.key ||
    ''
  ).trim();
}

// Middleware: popula req.user. Se a auth estiver ligada e a chave for inválida,
// responde 401. Com a auth desligada, segue aberto (req.user = null).
export function requireUser(req, res, next) {
  if (!authEnabled) {
    req.user = null;
    return next();
  }
  const rawKey = keyFromReq(req);
  const user = resolveKey(rawKey);
  if (!user) {
    console.warn(
      `AUTH 401 ${req.method} ${req.path} | x-eva-key:${req.get('x-eva-key') ? 'sim' : 'não'}` +
      ` | authorization:${req.get('authorization') ? 'sim' : 'não'} | prefixo:"${rawKey.slice(0, 6)}"`
    );
    return res.status(401).json({ error: 'Código de acesso inválido ou ausente.' });
  }
  req.user = user;
  next();
}

// Id do dono para filtrar reuniões: null = ver tudo (auth off ou admin).
export function ownerFilter(req) {
  if (!req.user || req.user.admin) return null;
  return req.user.id;
}
