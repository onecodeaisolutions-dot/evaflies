# EvaFlies 🎙️

Sistema estilo **Fireflies**: uma extensão do Google Chrome que grava o áudio da
reunião (áudio da aba + seu microfone), gera a **transcrição completa** e produz
um **resumo com action items** usando a **API da OpenAI**.

O projeto tem duas partes:

| Parte | Pasta | O que faz |
|-------|-------|-----------|
| **Backend** | [`backend/`](backend/) | Servidor Node/Express que guarda a chave da OpenAI, faz proxy para transcrição (`/api/transcribe`) e resumo (`/api/summarize`), **salva o áudio completo** (`/api/audio`), armazena as reuniões (`/api/meetings`) e serve o **painel web**. |
| **Extensão** | [`extension/`](extension/) | Extensão Chrome (Manifest V3) que captura áudio da aba + microfone, envia em blocos para o backend e mostra a transcrição ao vivo. |
| **Painel** | [`backend/public/`](backend/public/) | Dashboard estilo Fireflies: cada reunião é uma linha; ao clicar abre a **gravação de áudio** + a **transcrição minuto a minuto** (timestamps clicáveis que dão seek no áudio) + o resumo. |

A chave da OpenAI **nunca** vai para a extensão — fica só no backend.

```
┌──────────────┐   áudio (blocos webm)   ┌─────────────┐   audio/transcriptions   ┌────────┐
│  Extensão     │ ──────────────────────▶ │   Backend    │ ───────────────────────▶ │ OpenAI │
│  Chrome (MV3) │ ◀────────────────────── │  Express     │ ◀─────────────────────── │  API   │
└──────────────┘      texto / resumo      └─────────────┘                          └────────┘
```

---

## 1. Subindo o backend

Pré-requisitos: **Node.js 18+**.

```bash
cd backend
cp .env.example .env
# edite .env e coloque sua OPENAI_API_KEY
npm install
npm start
```

O servidor sobe em `http://localhost:3000`. Cheque a saúde em
`http://localhost:3000/api/health`. O **painel de reuniões** fica na raiz:
`http://localhost:3000/`.

Os dados ficam em `backend/data/` (não versionado): `meetings.json` com as
reuniões e `data/audio/` com os arquivos de áudio gravados.

Variáveis de ambiente (`.env`):

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `OPENAI_API_KEY` | — | **Obrigatória.** Sua chave da OpenAI. |
| `PORT` | `3000` | Porta do servidor. |
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Modelo de transcrição (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe` ou `whisper-1`). |
| `SUMMARY_MODEL` | `gpt-4o-mini` | Modelo usado para gerar o resumo / action items. |
| `TRANSCRIBE_LANGUAGE` | `pt` | Idioma esperado da fala (ISO-639-1). |
| `CORS_ORIGIN` | `*` | Origem permitida para CORS. |

---

## 2. Instalando a extensão

1. Abra o Chrome em `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta `extension/`.
4. Fixe a extensão na barra e abra o popup.

Se o backend não estiver em `http://localhost:3000`, ajuste a URL no campo de
configuração do popup (fica salvo no `chrome.storage`).

### Como usar

1. Entre na sua reunião (Google Meet, Zoom Web, Teams Web, etc).
2. Abra o popup da extensão.
3. Na primeira vez, clique em **Permitir microfone** (concede acesso de mic à extensão).
4. Clique em **▶ Gravar**. A transcrição vai aparecendo em blocos.
5. Clique em **⏹ Parar**. O **áudio completo** é salvo, a reunião é gravada no
   backend e um **resumo** é gerado.
6. Clique em **🗂️ Abrir painel** (ou abra `http://localhost:3000/`) para ver a
   lista de reuniões. Ao clicar numa reunião, você vê o player de áudio e a
   transcrição minuto a minuto — clicar num timestamp pula o áudio para aquele
   ponto.

> A captura de áudio da aba usa `chrome.tabCapture` — funciona na aba ativa onde
> você iniciou a gravação. O áudio continua tocando normalmente para você.

---

## Como a transcrição em blocos funciona

A extensão mantém **dois gravadores** sobre o mesmo áudio mixado (aba + mic):

- **Gravador por blocos** — um `MediaRecorder` **reiniciado a cada ~20s**. Cada
  reinício produz um `.webm` completo e independente (com cabeçalho próprio),
  que é enviado ao backend e transcrito. Cada bloco carrega o seu timestamp de
  início, formando a transcrição **minuto a minuto**.
- **Gravador contínuo** — um `MediaRecorder` que roda do início ao fim e gera o
  **áudio completo** da reunião, enviado ao backend (`/api/audio`) ao parar e
  vinculado à reunião para reprodução no painel.

> Reiniciar o gravador (em vez de usar `timeslice`) é importante: blocos gerados
> por `timeslice` não têm cabeçalho próprio e não podem ser transcritos
> isoladamente. O custo é um pequeno gap (dezenas de ms) entre os blocos.

Essa abordagem é simples e robusta. Para transcrição palavra-a-palavra em tempo
real, dá pra evoluir depois para a **Realtime API** da OpenAI (ver
[`docs/ROADMAP.md`](docs/ROADMAP.md)).

---

## Estrutura

```
evaflies/
├── backend/                 # Servidor Express (proxy OpenAI + storage + painel)
│   ├── server.js
│   ├── src/
│   │   ├── openai.js
│   │   └── store.js
│   ├── public/              # Painel web (dashboard estilo Fireflies)
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── package.json
│   └── .env.example
├── extension/               # Extensão Chrome MV3
│   ├── manifest.json
│   ├── background.js        # service worker (orquestra captura)
│   ├── offscreen.html/.js   # grava/mixa áudio (blocos + áudio completo)
│   ├── popup.html/.css/.js  # UI: gravar/parar + transcrição ao vivo
│   └── config.js
└── docs/
    └── ROADMAP.md
```

## Aviso

Grave reuniões apenas com o **consentimento dos participantes**. Você é
responsável por cumprir as leis de privacidade aplicáveis.
