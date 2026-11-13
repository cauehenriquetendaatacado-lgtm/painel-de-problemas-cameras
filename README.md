# Análise de Serviço

Monitor em tempo real (HTTP probe + páginas oficiais de status + relatos dos usuários).

## Rodar local
    node server.js   # http://localhost:3000

## Deploy no Render
1. Suba esta pasta para um repositório no GitHub.
2. No Render: New > Blueprint (usa o render.yaml) ou New > Web Service (Build: `npm install`, Start: `node server.js`).

Variáveis opcionais: CHECK_INTERVAL_MS (30000), TIMEOUT_MS (8000), REPORT_WARN (5), REPORT_DOWN (15).
