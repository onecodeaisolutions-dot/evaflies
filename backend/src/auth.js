// Autenticação simples por "código de acesso", para separar dados por vendedor.
// Usuários são definidos via a variável de ambiente EVA_USERS (JSON), ex:
//   [{"key":"rian-9f3a","name":"Rian","email":"rian@x.com","admin":true},
//    {"key":"sup-1a2b","name":"Coordenadora","supervisor":true},
//    {"key":"vend1-7c2b","name":"Vendedor 1"},
//    {"key":"vend2-4d8e","name":"Vendedor 2"}]
// Papéis: admin vê TUDO; supervisor vê as reuniões de quem NÃO é admin
// (vendedores + as próprias — as dos admins ficam privadas); os demais veem só
// as suas. Se EVA_USERS estiver vazio/ausente, a auth fica DESLIGADA e tudo
// funciona abertamente (compatível com a versão atual da extensão).

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
    supervisor: Boolean(u.supervisor) && !u.admin, // admin já vê tudo
    id: ownerIdOf(u),
  };
}

// Donos que um supervisor pode ver: todos os usuários que NÃO são admin.
// (Inclui o próprio supervisor. As reuniões dos admins ficam privadas.)
function supervisedIds() {
  return users.filter((u) => !u.admin).map(ownerIdOf);
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

// Filtro de dono para reuniões: null = ver tudo (auth off ou admin);
// array = qualquer um destes donos (supervisor); string = só o próprio.
export function ownerFilter(req) {
  if (!req.user || req.user.admin) return null;
  if (req.user.supervisor) return supervisedIds();
  return req.user.id;
}

// Filtro para a LISTAGEM: vendedor vê só as suas; admin pode filtrar por
// ?owner (ou ver todas); supervisor idem, mas restrito a quem ele supervisiona.
export function listOwnerFilter(req) {
  if (!req.user) return null; // auth desligada
  const requested = (req.query.owner || '').trim() || null;
  if (req.user.admin) return requested;
  if (req.user.supervisor) {
    const allowed = supervisedIds();
    return requested && allowed.includes(requested) ? requested : allowed;
  }
  return req.user.id; // vendedor: forçado às suas
}

// Lista de usuários (sem as chaves) para montar o menu de vendedores.
// Admin vê todos; supervisor só vê quem supervisiona (não lista os admins).
export function listUsers(forUser = null) {
  const visible = forUser && forUser.supervisor ? users.filter((u) => !u.admin) : users;
  return visible.map((u) => ({
    id: ownerIdOf(u),
    name: u.name || u.email || 'Usuário',
    admin: Boolean(u.admin),
    supervisor: Boolean(u.supervisor) && !u.admin,
  }));
}
