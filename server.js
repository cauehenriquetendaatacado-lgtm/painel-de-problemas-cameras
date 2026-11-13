const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error('Defina as variáveis ADMIN_USER e ADMIN_PASSWORD.');
  process.exit(1);
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /render\.com/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false,
});

const STATUS = ['aberta', 'em_andamento', 'resolvida'];
const CATEGORIAS = ['Segurança', 'Manutenção', 'Limpeza', 'Barulho', 'Outros'];
const PRIORIDADES = ['baixa', 'media', 'alta'];

async function init() {
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
}

/* ---------- auth do admin (token assinado, 12h) ---------- */
const sign = (p) => crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('hex');
function criarToken() {
  const exp = Date.now() + 12 * 3600 * 1000;
  return `${exp}.${sign(String(exp))}`;
}
function tokenValido(t = '') {
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = sign(exp);
  return sig.length === esperado.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
}
function exigirAdmin(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokenValido(t)) return res.status(401).json({ erro: 'Não autorizado' });
  next();
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

/* ---------- público: registrar ocorrência ---------- */
app.post('/api/ocorrencias', async (req, res) => {
  if (limitar('post:' + req.ip, 10, 10 * 60 * 1000))
    return res.status(429).json({ erro: 'Muitos envios. Tente novamente em alguns minutos.' });

  const b = req.body || {};
  const nome = String(b.nome || '').trim().slice(0, 100);
  const contato = String(b.contato || '').trim().slice(0, 100);
  const local = String(b.local || '').trim().slice(0, 150);
  const descricao = String(b.descricao || '').trim().slice(0, 2000);
  const categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : null;
  const prioridade = PRIORIDADES.includes(b.prioridade) ? b.prioridade : 'media';

  if (!nome || !local || !descricao || !categoria)
    return res.status(400).json({ erro: 'Preencha nome, categoria, local e descrição.' });

  const { rows } = await db.query(
    `INSERT INTO ocorrencias (nome, contato, categoria, local, descricao, prioridade)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [nome, contato, categoria, local, descricao, prioridade]
  );
  res.status(201).json({ protocolo: rows[0].id });
});

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
  res.json({ token: criarToken() });
});

app.get('/api/admin/ocorrencias', exigirAdmin, async (_, res) => {
  const { rows } = await db.query('SELECT * FROM ocorrencias ORDER BY criada_em DESC LIMIT 1000');
  res.json(rows);
});

app.patch('/api/admin/ocorrencias/:id', exigirAdmin, async (req, res) => {
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
});

app.delete('/api/admin/ocorrencias/:id', exigirAdmin, async (req, res) => {
  await db.query('DELETE FROM ocorrencias WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno.' });
});

init().then(() => app.listen(PORT, () => console.log('Rodando na porta ' + PORT)))
  .catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
