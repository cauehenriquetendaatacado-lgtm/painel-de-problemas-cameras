const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'Caue';
// Padrão do aplicativo. Se existir ADMIN_USER / ADMIN_PASSWORD no Render, eles têm prioridade.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Caue299792458@#$';
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');


/* usuários definidos no Render: USER_LOGIN + USER_PASSWORD (+ USER_NAME opcional)
   e/ou USUARIOS="ana:senha1;joao:senha2" */
function usuariosDoRender() {
  const lista = [];
  if (process.env.USER_LOGIN && process.env.USER_PASSWORD)
    lista.push([process.env.USER_LOGIN, process.env.USER_PASSWORD, process.env.USER_NAME]);
  String(process.env.USUARIOS || '').split(';').forEach((par) => {
    const i = par.indexOf(':');
    if (i > 0) lista.push([par.slice(0, i), par.slice(i + 1)]);
  });
  return lista
    .map(([u, p, n]) => [String(u).trim().toLowerCase(), String(p), n])
    .filter(([u, p]) => /^[a-z0-9._-]{3,30}$/.test(u) && p.length >= 4 && u !== ADMIN_USER.toLowerCase());
}

// mostra nos logs qual banco está sendo lido (nunca a senha)
try {
  const u = new URL(process.env.DATABASE_URL);
  console.log(`Banco: usuário=${decodeURIComponent(u.username)} host=${u.hostname} porta=${u.port || '5432'} ` +
    `tamanho_da_senha=${decodeURIComponent(u.password).length}`);
} catch (_) {
  console.error('DATABASE_URL está vazia ou mal formada (confira aspas, espaços e colchetes).');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL ligado para bancos na nuvem (Supabase, Render...); desligado só em localhost
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') || process.env.DATABASE_SSL === 'false'
    ? false : { rejectUnauthorized: false },
});

const STATUS = ['aberta', 'em_andamento', 'resolvida'];
const CATEGORIAS = ['Segurança', 'Manutenção', 'Limpeza', 'Barulho', 'Outros'];
const PRIORIDADES = ['baixa', 'media', 'alta'];

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ocorrencias (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      contato TEXT,
      categoria TEXT NOT NULL,
      local TEXT NOT NULL,
      descricao TEXT NOT NULL,
      prioridade TEXT NOT NULL DEFAULT 'media',
      status TEXT NOT NULL DEFAULT 'aberta',
      nota_admin TEXT,
      criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizada_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query('ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS usuario_id INTEGER');
  await db.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'aprovado'");

  // Supabase: impede que as tabelas fiquem legíveis pela API pública (chave anon).
  // O servidor usa o usuário postgres, que ignora essa trava, então nada muda para ele.
  for (const t of ['usuarios', 'ocorrencias']) {
    try { await db.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`); } catch (_) {}
  }

  // cria/atualiza os usuários do Render (trocar a senha lá troca aqui no próximo deploy)
  for (const [usuario, senha, nome] of usuariosDoRender()) {
    const hash = await hashSenha(senha);
    const { rows } = await db.query('SELECT id FROM usuarios WHERE usuario = $1', [usuario]);
    if (rows.length) await db.query("UPDATE usuarios SET senha_hash = $1, status = 'aprovado' WHERE id = $2", [hash, rows[0].id]);
    else await db.query('INSERT INTO usuarios (usuario, nome, senha_hash) VALUES ($1,$2,$3)',
      [usuario, (nome || usuario.charAt(0).toUpperCase() + usuario.slice(1)).slice(0, 100), hash]);
    console.log('Usuário do Render pronto:', usuario);
  }
}

/* ---------- tokens assinados (papel + id + validade) ---------- */
const sign = (p) => crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('hex');
function criarToken(papel, uid, horas) {
  const corpo = `${papel}.${uid}.${Date.now() + horas * 3600 * 1000}`;
  return `${corpo}.${sign(corpo)}`;
}
function lerToken(t = '') {
  const p = String(t).split('.');
  if (p.length !== 4) return null;
  const [papel, uid, exp, sig] = p;
  if (!(Number(exp) > Date.now())) return null;
  const esperado = sign(`${papel}.${uid}.${exp}`);
  if (sig.length !== esperado.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  return { papel, uid: Number(uid) };
}
const tokenDe = (req) => (req.headers.authorization || '').replace('Bearer ', '');
function exigirAdmin(req, res, next) {
  const t = lerToken(tokenDe(req));
  if (!t || t.papel !== 'admin') return res.status(401).json({ erro: 'Não autorizado' });
  next();
}
async function exigirUsuario(req, res, next) {
  try {
    const t = lerToken(tokenDe(req));
    if (!t || t.papel !== 'user') return res.status(401).json({ erro: 'Faça login para continuar.' });
    const { rows } = await db.query('SELECT status FROM usuarios WHERE id = $1', [t.uid]);
    if (!rows.length || rows[0].status !== 'aprovado')
      return res.status(401).json({ erro: 'Faça login para continuar.' });
    req.uid = t.uid;
    next();
  } catch (e) { next(e); }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------- senhas dos usuários (scrypt + salt) ---------- */
async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(senha, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
async function confereSenha(senha, guardado) {
  const [salt, h] = String(guardado).split(':');
  const calc = await scrypt(senha, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

/* limite simples de tentativas de login e de envios */
const hits = new Map();
function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = (hits.get(chave) || []).filter((t) => agora - t < janelaMs);
  lista.push(agora);
  hits.set(chave, lista);
  return lista.length > max;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.send('ok'));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ---------- usuários: cadastro, login e ocorrências ---------- */
app.post('/api/cadastro', wrap(async (req, res) => {
  if (limitar('cad:' + req.ip, 10, 60 * 60 * 1000))
    return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' });
  const b = req.body || {};
  const nome = String(b.nome || '').trim().slice(0, 100);
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const senha = String(b.senha || '');
  if (nome.length < 2) return res.status(400).json({ erro: 'Informe seu nome.' });
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario))
    return res.status(400).json({ erro: 'Usuário: 3 a 30 caracteres (letras, números, ponto, hífen ou _).' });
  if (senha.length < 6 || senha.length > 100)
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (usuario === ADMIN_USER.toLowerCase())
    return res.status(409).json({ erro: 'Esse usuário já existe. Escolha outro.' });
  try {
    await db.query(
      "INSERT INTO usuarios (usuario, nome, senha_hash, status) VALUES ($1,$2,$3,'pendente') RETURNING id",
      [usuario, nome, await hashSenha(senha)]);
    res.status(201).json({ pendente: true, usuario });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Esse usuário já existe. Escolha outro.' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  if (limitar('login-u:' + req.ip, 10, 15 * 60 * 1000))
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const usuario = String((req.body || {}).usuario || '').trim().toLowerCase();
  const senha = String((req.body || {}).senha || '');
  const { rows } = await db.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
  const u = rows[0];
  if (!u || !(await confereSenha(senha, u.senha_hash)))
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  if (u.status === 'pendente')
    return res.status(403).json({ erro: 'Sua conta está aguardando a aprovação do Caue. Tente de novo mais tarde.' });
  if (u.status !== 'aprovado')
    return res.status(403).json({ erro: 'Seu cadastro não foi aprovado pelo Caue.' });
  res.json({ token: criarToken('user', u.id, 24 * 30), nome: u.nome, usuario: u.usuario });
}));

app.get('/api/eu', exigirUsuario, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT nome, usuario FROM usuarios WHERE id = $1', [req.uid]);
  if (!rows.length) return res.status(401).json({ erro: 'Faça login para continuar.' });
  res.json(rows[0]);
}));

app.post('/api/ocorrencias', exigirUsuario, wrap(async (req, res) => {
  if (limitar('post:' + req.uid, 10, 10 * 60 * 1000))
    return res.status(429).json({ erro: 'Muitos envios. Tente novamente em alguns minutos.' });
  const { rows: us } = await db.query('SELECT nome FROM usuarios WHERE id = $1', [req.uid]);
  if (!us.length) return res.status(401).json({ erro: 'Faça login para continuar.' });

  const b = req.body || {};
  const contato = String(b.contato || '').trim().slice(0, 100);
  const local = String(b.local || '').trim().slice(0, 150);
  const descricao = String(b.descricao || '').trim().slice(0, 2000);
  const categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : null;
  const prioridade = PRIORIDADES.includes(b.prioridade) ? b.prioridade : 'media';
  if (!local || !descricao || !categoria)
    return res.status(400).json({ erro: 'Preencha categoria, local e descrição.' });

  const { rows } = await db.query(
    `INSERT INTO ocorrencias (nome, contato, categoria, local, descricao, prioridade, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [us[0].nome, contato, categoria, local, descricao, prioridade, req.uid]);
  res.status(201).json({ protocolo: rows[0].id, enviadaPara: ADMIN_USER });
}));

app.get('/api/minhas', exigirUsuario, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, categoria, local, status, criada_em FROM ocorrencias
     WHERE usuario_id = $1 ORDER BY criada_em DESC LIMIT 50`, [req.uid]);
  res.json(rows);
}));

/* ---------- admin ---------- */
app.post('/api/admin/login', (req, res) => {
  if (limitar('login:' + req.ip, 8, 15 * 60 * 1000))
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const usuario = String((req.body || {}).usuario || '');
  const senha = String((req.body || {}).senha || '');
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  const okUser = crypto.timingSafeEqual(h(usuario), h(ADMIN_USER));
  const okSenha = crypto.timingSafeEqual(h(senha), h(ADMIN_PASSWORD));
  if (!(okUser && okSenha)) return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  res.json({ token: criarToken('admin', 0, 12) });
});

app.get('/api/admin/ocorrencias', exigirAdmin, wrap(async (_, res) => {
  const { rows } = await db.query(`SELECT o.*, u.usuario FROM ocorrencias o
    LEFT JOIN usuarios u ON u.id = o.usuario_id ORDER BY o.criada_em DESC LIMIT 1000`);
  res.json(rows);
}));

app.patch('/api/admin/ocorrencias/:id', exigirAdmin, wrap(async (req, res) => {
  const { status, nota_admin } = req.body || {};
  if (status && !STATUS.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  const { rows } = await db.query(
    `UPDATE ocorrencias SET
       status = COALESCE($1, status),
       nota_admin = COALESCE($2, nota_admin),
       atualizada_em = now()
     WHERE id = $3 RETURNING *`,
    [status || null, nota_admin == null ? null : String(nota_admin).slice(0, 1000), Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ erro: 'Não encontrada.' });
  res.json(rows[0]);
}));

app.get('/api/admin/usuarios', exigirAdmin, wrap(async (_, res) => {
  const { rows } = await db.query(
    `SELECT id, nome, usuario, status, criado_em FROM usuarios
     ORDER BY (status = 'pendente') DESC, criado_em DESC LIMIT 500`);
  res.json(rows);
}));

app.patch('/api/admin/usuarios/:id', exigirAdmin, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['aprovado', 'recusado'].includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  const { rows } = await db.query(
    'UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, usuario, status, criado_em',
    [status, Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ erro: 'Não encontrada.' });
  res.json(rows[0]);
}));

app.delete('/api/admin/usuarios/:id', exigirAdmin, wrap(async (req, res) => {
  await db.query('DELETE FROM usuarios WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
}));

app.delete('/api/admin/ocorrencias/:id', exigirAdmin, wrap(async (req, res) => {
  await db.query('DELETE FROM ocorrencias WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno.' });
});

init().then(() => app.listen(PORT, () => console.log('Rodando na porta ' + PORT)))
  .catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
