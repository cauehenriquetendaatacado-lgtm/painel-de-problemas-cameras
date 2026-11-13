'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INTERVAL = +process.env.CHECK_INTERVAL_MS || 30000;
const TIMEOUT = +process.env.TIMEOUT_MS || 8000;
const REPORT_WARN = +process.env.REPORT_WARN || 5;
const REPORT_DOWN = +process.env.REPORT_DOWN || 15;
const HIST = 60;
const WINDOW = 15 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; AnaliseDeServico/1.0)';

// status: página oficial opcional (Statuspage.io = "sp", Slack = "slack")
const SERVICES = [
  { id: 'outlook', name: 'Microsoft Outlook', cat: 'Microsoft', url: 'https://outlook.office.com/' },
  { id: 'teams', name: 'Microsoft Teams', cat: 'Microsoft', url: 'https://teams.microsoft.com/' },
  { id: 'm365', name: 'Microsoft 365', cat: 'Microsoft', url: 'https://www.office.com/' },
  { id: 'entra', name: 'Login Microsoft', cat: 'Microsoft', url: 'https://login.microsoftonline.com/' },
  { id: 'onedrive', name: 'OneDrive', cat: 'Microsoft', url: 'https://onedrive.live.com/' },
  { id: 'azure', name: 'Azure Portal', cat: 'Microsoft', url: 'https://portal.azure.com/' },
  { id: 'gmail', name: 'Gmail', cat: 'Google', url: 'https://mail.google.com/' },
  { id: 'gworkspace', name: 'Google Workspace', cat: 'Google', url: 'https://workspace.google.com/' },
  { id: 'meet', name: 'Google Meet', cat: 'Google', url: 'https://meet.google.com/' },
  { id: 'gdrive', name: 'Google Drive', cat: 'Google', url: 'https://drive.google.com/' },
  { id: 'zoom', name: 'Zoom', cat: 'Colaboração', url: 'https://zoom.us/', status: { type: 'sp', url: 'https://status.zoom.us/api/v2/status.json' } },
  { id: 'slack', name: 'Slack', cat: 'Colaboração', url: 'https://slack.com/', status: { type: 'slack', url: 'https://slack-status.com/api/v2.0.0/current' } },
  { id: 'notion', name: 'Notion', cat: 'Colaboração', url: 'https://www.notion.so/', status: { type: 'sp', url: 'https://status.notion.so/api/v2/status.json' } },
  { id: 'jira', name: 'Atlassian (Jira/Confluence)', cat: 'Colaboração', url: 'https://www.atlassian.com/', status: { type: 'sp', url: 'https://status.atlassian.com/api/v2/status.json' } },
  { id: 'linkedin', name: 'LinkedIn', cat: 'Colaboração', url: 'https://www.linkedin.com/' },
  { id: 'dropbox', name: 'Dropbox', cat: 'Colaboração', url: 'https://www.dropbox.com/' },
  { id: 'salesforce', name: 'Salesforce', cat: 'Negócios', url: 'https://www.salesforce.com/' },
  { id: 'sap', name: 'SAP', cat: 'Negócios', url: 'https://www.sap.com/' },
  { id: 'zendesk', name: 'Zendesk', cat: 'Negócios', url: 'https://www.zendesk.com/' },
  { id: 'github', name: 'GitHub', cat: 'Infraestrutura', url: 'https://github.com/', status: { type: 'sp', url: 'https://www.githubstatus.com/api/v2/status.json' } },
  { id: 'aws', name: 'AWS', cat: 'Infraestrutura', url: 'https://aws.amazon.com/' },
  { id: 'cloudflare', name: 'Cloudflare', cat: 'Infraestrutura', url: 'https://www.cloudflare.com/', status: { type: 'sp', url: 'https://www.cloudflarestatus.com/api/v2/status.json' } },
  { id: 'whatsapp', name: 'WhatsApp Web', cat: 'Brasil', url: 'https://web.whatsapp.com/' },
  { id: 'pix', name: 'PIX (Banco Central)', cat: 'Brasil', url: 'https://www.bcb.gov.br/estabilidadefinanceira/pix' },
  { id: 'nubank', name: 'Nubank', cat: 'Brasil', url: 'https://nubank.com.br/' },
  { id: 'govbr', name: 'Gov.br', cat: 'Brasil', url: 'https://www.gov.br/' },
];

const state = {};
SERVICES.forEach(s => {
  state[s.id] = { hist: [], base: null, fails: 0, official: null, reports: [], level: -1, latency: null, code: null, reason: 'Verificando…', checkedAt: null };
});
const alerts = [];
const clients = new Set();
const reportLimit = new Map();

async function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept: '*/*' }, ...opts });
    const ms = Date.now() - start;
    return { res, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url) {
  try {
    const { res, ms } = await timedFetch(url);
    try { await res.body?.cancel(); } catch {}
    // 4xx (bloqueio de bot, login) significa que o servidor respondeu; só 5xx conta como falha
    return { ok: res.status < 500, code: res.status, ms };
  } catch (e) {
    return { ok: false, code: null, err: e.name === 'AbortError' ? 'timeout' : 'erro de conexão' };
  }
}

async function officialStatus(cfg) {
  try {
    const { res } = await timedFetch(cfg.url);
    const d = await res.json();
    if (cfg.type === 'sp') {
      const i = d.status && d.status.indicator;
      if (i === 'none') return { level: 0 };
      if (i === 'minor') return { level: 1, text: d.status.description };
      if (i === 'major' || i === 'critical') return { level: 2, text: d.status.description };
    }
    if (cfg.type === 'slack') return d.status === 'ok' ? { level: 0 } : { level: 1, text: 'incidente ativo' };
  } catch {}
  return null;
}

function evaluate(svc) {
  const st = state[svc.id];
  const now = Date.now();
  st.reports = st.reports.filter(t => now - t < WINDOW);
  let level = 0;
  const why = [];
  const up = (l, t) => { level = Math.max(level, l); why.push(t); };

  if (st.fails >= 2) up(2, 'sem resposta do servidor');
  else if (st.fails === 1) up(1, 'falha na última verificação');
  else if (st.base && st.latency && st.latency > Math.max(st.base * 3, st.base + 1500)) up(1, 'resposta muito lenta');

  if (st.official && st.official.level > 0) up(st.official.level, 'página oficial: ' + (st.official.text || 'incidente'));
  if (st.reports.length >= REPORT_DOWN) up(2, st.reports.length + ' relatos de usuários');
  else if (st.reports.length >= REPORT_WARN) up(1, st.reports.length + ' relatos de usuários');

  return { level, reason: why.length ? why.join(' · ') : 'Tudo funcionando normalmente' };
}

function apply(svc) {
  const st = state[svc.id];
  const prev = st.level;
  const r = evaluate(svc);
  st.level = r.level;
  st.reason = r.reason;
  if (r.level !== prev && !(prev === -1 && r.level === 0)) {
    const a = { t: Date.now(), id: svc.id, name: svc.name, level: r.level, text: r.level === 0 ? 'voltou ao normal' : r.reason };
    alerts.unshift(a);
    alerts.length = Math.min(alerts.length, 50);
    broadcast('alert', a);
  }
  broadcast('update', pub(svc));
}

async function check(svc) {
  const st = state[svc.id];
  const p = await probe(svc.url);
  if (p.ok) { st.fails = 0; st.latency = p.ms; st.code = p.code; }
  else { st.fails++; st.latency = null; st.code = p.code; }
  st.hist.push(p.ok ? p.ms : null);
  if (st.hist.length > HIST) st.hist.shift();
  if (svc.status) st.official = await officialStatus(svc.status);
  st.checkedAt = Date.now();
  const slowBefore = st.base && p.ok && p.ms > Math.max(st.base * 3, st.base + 1500);
  apply(svc);
  if (p.ok && !slowBefore) st.base = st.base == null ? p.ms : 0.9 * st.base + 0.1 * p.ms;
}

function pub(svc) {
  const st = state[svc.id];
  const now = Date.now();
  return {
    id: svc.id, name: svc.name, cat: svc.cat, level: st.level, reason: st.reason,
    latency: st.latency, code: st.code, base: st.base ? Math.round(st.base) : null,
    threshold: st.base ? Math.round(Math.max(st.base * 3, st.base + 1500)) : null,
    reports: st.reports.filter(t => now - t < WINDOW).length,
    hist: st.hist, checkedAt: st.checkedAt,
  };
}

function broadcast(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

let running = false;
async function runAll() {
  if (running) return;
  running = true;
  await Promise.allSettled(SERVICES.map(check));
  running = false;
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: snapshot\ndata: ${JSON.stringify({ services: SERVICES.map(pub), alerts, interval: INTERVAL })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ services: SERVICES.map(pub), alerts }));
  }
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }

  if (url === '/api/report' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      let id;
      try { id = JSON.parse(body).id; } catch {}
      const svc = SERVICES.find(s => s.id === id);
      res.setHeader('content-type', 'application/json');
      if (!svc) { res.writeHead(400); return res.end('{"error":"serviço inválido"}'); }
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const key = ip + '|' + id;
      const last = reportLimit.get(key);
      if (last && Date.now() - last < 10 * 60 * 1000) { res.writeHead(429); return res.end('{"error":"já relatado"}'); }
      reportLimit.set(key, Date.now());
      state[id].reports.push(Date.now());
      apply(svc);
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    return;
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(indexHtml);
  }
  res.writeHead(404);
  res.end('não encontrado');
});

setInterval(() => broadcast('ping', Date.now()), 25000);
setInterval(() => { const n = Date.now(); for (const [k, t] of reportLimit) if (n - t > 600000) reportLimit.delete(k); }, 60000);

server.listen(PORT, () => {
  console.log('Análise de Serviço na porta ' + PORT);
  runAll();
  setInterval(runAll, INTERVAL);
});
