# Webflow — Backend (login, banco de dados e planos)

Este é o servidor de verdade por trás do Webflow: cada cliente (restaurante,
clínica, comércio) tem sua própria conta, senha protegida, plano contratado
e dados isolados dos outros clientes.

## O que tem aqui

- `server.js` — o servidor.
- `db.js` — banco de dados SQLite (um arquivo só, `webflow.db`, criado sozinho).
- `routes/auth.js` — cadastro, login, "quem sou eu" e troca de plano.
- `routes/dados.js` — guarda os dados do painel de gestão de cada cliente.
- `middleware/auth.js` — confere se a pessoa está logada antes de liberar acesso.
- `public/login.html` — tela de login/cadastro pronta, com a identidade visual do Webflow.

## 1. Rodando no seu computador (pra testar)

Pré-requisito: [Node.js](https://nodejs.org) instalado (versão 18 ou mais nova).

```bash
cd webflow-backend
npm install
cp .env.example .env
```

Abra o arquivo `.env` e troque `JWT_SECRET` por um valor aleatório longo
(qualquer texto grande e difícil de adivinhar já serve pra testar).

```bash
npm start
```

O servidor sobe em `http://localhost:3000`. Pra testar rapidamente pelo terminal:

```bash
# Criar uma conta
curl -X POST http://localhost:3000/api/auth/registrar \
  -H "Content-Type: application/json" \
  -d '{"nome":"Maria","email":"maria@teste.com","senha":"123456","negocio_nome":"Restaurante da Maria","plano":"pro"}'

# Fazer login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"maria@teste.com","senha":"123456"}'
```

Ou simplesmente abra `public/login.html` no navegador (com o servidor rodando)
e use a tela de login/cadastro normalmente.

## 2. Colocando no ar (hospedagem)

Esse tipo de servidor precisa ficar ligado o tempo todo, então ele não pode
morar dentro do Claude — precisa de um serviço de hospedagem próprio. As
opções mais simples pra começar (têm plano gratuito ou bem barato):

- **Railway** (railway.app) — o mais direto: conecta no seu GitHub, detecta
  que é um projeto Node.js e sobe sozinho. Defina as variáveis `JWT_SECRET`
  e `FRONTEND_ORIGIN` na aba "Variables" do projeto.
- **Render** (render.com) — parecido com o Railway, tem plano gratuito
  (o servidor "dorme" depois de um tempo sem uso no plano grátis).
- **Fly.io** — um pouco mais técnico, mas também tem opção gratuita.

Passo geral em qualquer um deles:
1. Suba esta pasta para um repositório no GitHub.
2. Crie um novo projeto na plataforma escolhida e aponte pro repositório.
3. Configure as variáveis de ambiente (`JWT_SECRET`, `FRONTEND_ORIGIN`).
4. A plataforma roda `npm install` e depois `npm start` sozinha.
5. Você recebe um endereço tipo `https://webflow-api.up.railway.app` — é esse
   endereço que entra no `API_URL` do `login.html` e do painel.

## 3. Conectando ao site (`webflow-landing.html` e `webflow.html`)

### Login
No `login.html`, troque esta linha pelo endereço real do seu backend depois do deploy:

```js
: 'https://SEU-BACKEND-AQUI.exemplo.com';
```

No botão **"Entrar"** da landing page (`webflow-landing.html`), troque o link
que hoje aponta direto pra `webflow.html` para apontar pra `login.html`:

```html
<a class="btn btn-ghost btn-sm" href="login.html">Entrar</a>
```

### Painel de gestão (`webflow.html`)
Hoje o painel salva tudo com `window.storage` (um recurso que só existe dentro
do Claude). Pra funcionar de verdade no seu site, troque `loadState` e
`saveState` por chamadas para a API, usando o token salvo no login:

```js
const API_URL = 'https://SEU-BACKEND-AQUI.exemplo.com';
const token = localStorage.getItem('webflow_token');

if (!token) {
  window.location.href = 'login.html'; // ninguém acessa o painel sem login
}

async function loadState(){
  try{
    const r = await fetch(`${API_URL}/api/dados/webflow-state-v1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.ok) { state = JSON.parse((await r.json()).valor); return; }
  }catch(e){ /* segue pro estado inicial */ }
  state = JSON.parse(JSON.stringify(SEED));
}

async function saveState(){
  try{
    await fetch(`${API_URL}/api/dados/webflow-state-v1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ valor: JSON.stringify(state) })
    });
  }catch(e){ console.warn('Não foi possível salvar', e); }
}
```

Isso é literalmente só trocar essas duas funções — o resto do painel
(pedidos, estoque, financeiro etc.) continua igual, porque tudo já passa por
`loadState`/`saveState`.

### Upgrade de plano
Pra deixar o cliente trocar de plano de dentro do painel, chame:

```js
await fetch(`${API_URL}/api/auth/plano`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ plano: 'premium' }) // 'basico' | 'pro' | 'premium'
});
```

E use `localStorage.getItem('webflow_usuario')` (salvo no login) pra saber o
plano atual do cliente e mostrar ou esconder partes do painel — por exemplo,
só mostrar "Cardápio 3D" pra quem está no Premium.

## Próximos passos possíveis (quando fizer sentido)

- Recuperação de senha por e-mail.
- Cobrança automática (ex: Stripe ou Mercado Pago) integrada ao upgrade de plano.
- Painel administrativo seu (dono do Webflow) pra ver todos os clientes e planos.
- Trocar SQLite por Postgres se a base de clientes crescer muito...
