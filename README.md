# Painel de ocorrências

- `/`       → formulário público para registrar ocorrências
- `/admin`  → painel do administrador (senha)

Cada página tem um botão **Instalar atalho** (PWA) que cria o ícone na área de trabalho.

## Deploy no Render
1. Suba esta pasta para um repositório no GitHub.
2. No Render: **New → Blueprint** e selecione o repositório (usa o `render.yaml`).
3. Quando pedir, defina **ADMIN_USER** (usuário) e **ADMIN_PASSWORD** (senha) do admin.
4. Pronto: o banco Postgres é criado e ligado sozinho.

## Rodar local
    export DATABASE_URL=postgres://usuario:senha@localhost:5432/ocorrencias
    export ADMIN_USER=admin
    export ADMIN_PASSWORD=minha-senha
    npm install && npm start
