# Painel de ocorrências

- `/`       → usuários pedem cadastro, o Caue aprova, e então entram com usuário e senha para enviar ocorrências
- `/admin`  → painel do administrador **Caue** (usuário `Caue` + senha definida no Render)

Ao enviar, aparece o pop-up **“Enviada para o Caue”** e a ocorrência cai no painel do admin
(que atualiza sozinho a cada 30 s). Cada usuário vê o status das próprias ocorrências.

Cada página tem um botão **Instalar atalho** (PWA) que cria o ícone na tela/área de trabalho.

## Deploy no Render
1. Suba esta pasta para um repositório no GitHub.
2. No Render: **New → Blueprint** e selecione o repositório (usa o `render.yaml`).
3. Quando pedir, defina **ADMIN_PASSWORD** (a senha do Caue). O usuário já é `Caue`.
4. Pronto: o banco Postgres é criado e ligado sozinho.

Para trocar a senha depois: Render → serviço → **Environment** → `ADMIN_PASSWORD`.

## Cadastro com aprovação do Caue
Qualquer pessoa pode pedir cadastro na página inicial, mas **só entra depois que o Caue aprovar**
em `/admin` → aba **Contas** (Aprovar, Recusar, Bloquear ou Excluir). Se o Caue bloquear
uma conta, ela perde o acesso na hora.

## Usuários criados direto pelo Render (opcional, já entram aprovados)
- `USER_LOGIN` e `USER_PASSWORD` → um usuário (opcional: `USER_NAME`)
- `USUARIOS` → vários, assim: `ana:senha1;joao:senha2`

Trocou a senha no Render? Ela passa a valer no próximo deploy/reinício.

## Rodar local
    export DATABASE_URL=postgres://usuario:senha@localhost:5432/ocorrencias
    export ADMIN_PASSWORD=minha-senha
    npm install && npm start
