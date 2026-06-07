# Deploy do backend no Render

A extensão roda no seu Chrome, mas o **backend** (que fala com a OpenAI e guarda
as reuniões) pode ficar online no [Render](https://render.com) com URL `https`.
Depois é só apontar a extensão para essa URL.

## Passo a passo

1. **Suba o código para o GitHub** (este repositório já está lá).

2. **Crie a Web Service no Render**
   - Acesse <https://dashboard.render.com> → **New** → **Blueprint**.
   - Selecione este repositório. O Render lê o [`render.yaml`](../render.yaml) e
     já configura o serviço (`rootDir: backend`, build `npm install`, start
     `npm start`, health check em `/api/health`).
   - Alternativa sem blueprint: **New → Web Service**, escolha o repo, e defina
     manualmente: *Root Directory* = `backend`, *Build Command* = `npm install`,
     *Start Command* = `npm start`.

3. **Defina a variável secreta**
   - Em **Environment**, adicione `OPENAI_API_KEY` com a sua chave.
   - As demais (`TRANSCRIBE_MODEL`, `SUMMARY_MODEL`, etc.) já vêm do `render.yaml`.

4. **Deploy** — o Render instala e sobe. Ao final você recebe uma URL tipo
   `https://evaflies-backend.onrender.com`. Teste:
   `https://evaflies-backend.onrender.com/api/health` → deve responder
   `{"ok":true,"hasApiKey":true,...}`. O painel fica na raiz dessa URL.

5. **Aponte a extensão para o Render**
   - No popup da extensão → ⚙️ → campo **URL do backend** → cole a URL do Render
     (sem barra no final) → **Salvar**.
   - O `manifest.json` já permite chamadas a `https://*.onrender.com/*`.

## ⚠️ Persistência dos dados

No plano **free** do Render o disco é **efêmero**: a cada novo deploy ou após o
serviço hibernar, os arquivos em `backend/data/` (reuniões e áudios) são
**apagados**. Bom para testar; não use para dados que precisa manter.

Para persistir de verdade, no `render.yaml` descomente o bloco `disk:` e a
variável `DATA_DIR=/var/data` (requer plano pago do Render). Aí as reuniões e os
áudios passam a ser gravados no disco persistente.

> Evolução recomendada para produção: trocar o storage em arquivo por um banco
> (Postgres) e guardar os áudios em um bucket (S3/Cloudflare R2). Está no
> [ROADMAP](ROADMAP.md).

## Observações

- O plano free **hiberna** após inatividade; a primeira requisição depois disso
  demora alguns segundos para "acordar" o serviço.
- A primeira gravação pode falhar se o serviço estiver hibernando — abra a URL
  `/api/health` antes para acordá-lo.
- Mantenha `CORS_ORIGIN=*` (a origem da extensão é `chrome-extension://<id>`).
