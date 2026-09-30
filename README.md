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


## Mural de avaliações (placa + Google)

- Ao aproximar o celular da placa (`/r/:codigo`), o cliente abre `avaliar.html` no site: dá a nota, pode deixar um comentário e segue pro Google (sempre, qualquer que seja a nota — o Google proíbe filtrar só as boas).
- Toda avaliação feita ali fica salva na tabela `avaliacoes` e aparece no painel do lojista, em **Avaliações**.
- O lojista escolhe quais aparecem no portfólio público (`portfolio.html?c=CODIGO`). Por padrão, 4 e 5 estrelas entram.
- **Opcional:** configure `GOOGLE_PLACES_API_KEY` (Google Cloud → Places API (New)) pra mostrar também a nota, o total e as avaliações em destaque do Google. Só funciona pra lojas com Place ID salvo.
- **Padrão atual: a placa vai direto pro Google.** Pra voltar a mostrar a tela da loja antes (que alimenta o mural), defina `PLACA_DIRETO_GOOGLE=0`.

Rotas: `GET /api/publico/loja/:codigo`, `POST /api/publico/loja/:codigo/avaliacoes`, `GET /api/publico/portfolio/:codigo`, `GET /api/avaliacoes` (login), `PATCH /api/avaliacoes/:id` (login).

## Mensalidade do Premium (bloqueio automático)

- Cada pagamento aprovado do Premium (a ativação de R$ 300 ou uma mensalidade de R$ 150) libera o plano por **35 dias** (30 + 5 de tolerância). A data fica em `usuarios.premium_ate`.
- Uma verificação diária (`jobs/assinaturas.js`) manda um lembrete por e-mail 2–3 dias antes do vencimento (se não houver assinatura ativa) e, quando vence, **volta o cliente para o plano Pró** e avisa o cliente e o `ADMIN_EMAIL`. Nenhum dado é apagado; pagou, volta na hora.
- Cancelar a assinatura não derruba o Premium na hora: ele vale até o fim do período já pago.
- Contas Premium antigas (sem `premium_ate`) não são afetadas até o primeiro pagamento pelo sistema novo.
- **Configuração necessária no Mercado Pago:** em *Suas integrações → Webhooks*, aponte para `https://SEU-BACKEND/api/pagamentos/webhook` e marque os eventos **Pagamentos** e **Planos e assinaturas**.

## LGPD

- O cadastro exige aceitar os Termos de Uso e a Política de Privacidade (`privacidade.html` e `termos.html` no site). A data do aceite fica em `usuarios.aceite_termos_em`.

## Relatório mensal do lojista

- Todo dia 1º (com tolerância até o dia 3), cada lojista com placa recebe por e-mail o resumo do mês anterior: leituras da placa, avaliações, nota média (com comparação com o mês anterior), até 3 melhores comentários e uma dica prática. Arquivo: `jobs/relatorio-mensal.js`.
- Não repete envio (coluna `usuarios.relatorio_enviado_mes`), e não envia para admin nem para o time comercial.
- No painel admin, em **Clientes**, os botões **Relatório (teste)** (manda pro seu e-mail) e **Enviar relatório** (manda pro cliente) disparam o relatório do mês passado na hora. Rota: `POST /api/admin/clientes/:id/relatorio` com `{ destino: 'admin' | 'cliente' }`.
- Precisa de `RESEND_API_KEY` configurada. Para chegar na caixa de entrada dos clientes (e não só na sua), verifique um domínio no Resend e defina `EMAIL_FROM`.


## Placas em lote

- Admin → **Placas**: gera um lote (1 a 500) de placas com códigos únicos de 6 caracteres, ainda sem loja.
- **Imprimir** abre `imprimir-placas.html` no site: uma placa por página de 10×15 cm, pronta pra salvar em PDF, e a lista CSV com o link de cada placa pra gravar no chip NFC.
- Na venda, o comercial digita o código impresso na placa (cadastro do cliente ou botão "Placa" em Minhas vendas). O admin também pode ativar, mover ou desvincular.
- Placa livre escaneada abre `placa-nao-ativada.html`. Uma loja pode ter várias placas; todas contam scans e avaliações pra mesma loja.

Rotas (admin): `POST /api/admin/placas/lote`, `GET /api/admin/placas/lotes`, `GET /api/admin/placas?lote=`, `PATCH /api/admin/placas/:codigo`, `DELETE /api/admin/placas/lote/:lote`.
Rota (comercial): `PATCH /api/comercial/clientes/:id/placa`. O QR aceita `?w=1200&margem=0` pra impressão.
