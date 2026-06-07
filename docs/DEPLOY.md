# Deploy do backend no Render

A extensão roda no seu Chrome, mas o **backend** (que fala com a OpenAI e guarda
as reuniões) pode ficar online no [Render](https://render.com) com URL `https`.
Depois é só apontar a extensão para essa URL.

## Passo 0 — Supabase (armazenamento persistente)

Para **não perder as reuniões** quando o Render hibernar/refizer deploy, os dados
ficam no Supabase (free): Postgres para as reuniões + Storage para os áudios.

1. Crie uma conta em <https://supabase.com> e um **New project** (anote a senha do
   banco; a região mais perto de você é melhor).
2. Crie a tabela: no projeto → **SQL Editor** → cole o conteúdo de
   [`backend/supabase-schema.sql`](../backend/supabase-schema.sql) → **Run**.
3. Pegue as credenciais em **Project Settings → API**:
   - **Project URL** → vira `SUPABASE_URL`
   - **service_role** (em *Project API keys*, a secreta) → vira `SUPABASE_SERVICE_ROLE_KEY`
   > Use a **service_role** (não a `anon`). Ela é secreta e fica só no backend.
4. O bucket de áudio (`meeting-audio`) é criado automaticamente pelo backend na
   primeira vez. (Se quiser, crie manualmente em **Storage → New bucket**,
   privado, nome `meeting-audio`.)

> Free tier: 500MB de Postgres + 1GB de Storage. ~17–30h de áudio cabem no 1GB.
> Projetos free pausam após ~1 semana sem uso, mas **os dados não são apagados**
> — é só reativar no painel.

## Passo a passo (Render)

1. **Suba o código para o GitHub** (este repositório já está lá).

2. **Crie a Web Service no Render**
   - Acesse <https://dashboard.render.com> → **New** → **Blueprint**.
   - Selecione este repositório. O Render lê o [`render.yaml`](../render.yaml) e
     já configura o serviço (`rootDir: backend`, build `npm install`, start
     `npm start`, health check em `/api/health`).
   - Alternativa sem blueprint: **New → Web Service**, escolha o repo, e defina
     manualmente: *Root Directory* = `backend`, *Build Command* = `npm install`,
     *Start Command* = `npm start`.

3. **Defina as variáveis secretas** (em **Environment**)
   - `OPENAI_API_KEY` — sua chave da OpenAI.
   - `SUPABASE_URL` — a Project URL do Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY` — a service_role key do Supabase.
   - As demais (`TRANSCRIBE_MODEL`, `SUMMARY_MODEL`, etc.) já vêm do `render.yaml`.
   > Com `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` definidos, o backend usa
   > o Supabase automaticamente. Sem eles, cai no modo arquivo local.

4. **Deploy** — o Render instala e sobe. Ao final você recebe uma URL tipo
   `https://evaflies-backend.onrender.com`. Teste:
   `https://evaflies-backend.onrender.com/api/health` → deve responder
   `{"ok":true,"hasApiKey":true,"storage":"supabase",...}`. Confira que
   `"storage"` é `supabase` (e não `file`). O painel fica na raiz dessa URL.

5. **Aponte a extensão para o Render**
   - No popup da extensão → ⚙️ → campo **URL do backend** → cole a URL do Render
     (sem barra no final) → **Salvar**.
   - O `manifest.json` já permite chamadas a `https://*.onrender.com/*`.

## ⚠️ Persistência dos dados

Com o **Supabase configurado** (Passo 0), as reuniões e os áudios ficam no
Supabase — **não** no disco do Render. Então a hibernação ou um novo deploy do
Render **não apagam nada**. É esse o caminho recomendado.

Se você **não** configurar o Supabase, o backend usa arquivos locais
(`DATA_DIR`), que no plano free do Render são **efêmeros** (apagados a cada
deploy/hibernação) — serve só para testar.

## Observações

- O plano free **hiberna** após inatividade; a primeira requisição depois disso
  demora alguns segundos para "acordar" o serviço.
- A primeira gravação pode falhar se o serviço estiver hibernando — abra a URL
  `/api/health` antes para acordá-lo.
- Mantenha `CORS_ORIGIN=*` (a origem da extensão é `chrome-extension://<id>`).
