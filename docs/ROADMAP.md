# Roadmap

MVP atual: gravação (aba + mic) + transcrição em blocos via OpenAI + resumo com
action items, armazenado em arquivo JSON no backend.

## Próximos passos

### Transcrição
- [ ] **Realtime API** da OpenAI (WebSocket) para transcrição palavra-a-palavra ao vivo.
- [ ] Diarização (identificar quem falou) — combinar VAD + speaker labels.
- [ ] Timestamps por trecho (usar `whisper-1` com `response_format=verbose_json`).

### Áudio
- [ ] Salvar o áudio completo da reunião (gravador contínuo paralelo) e permitir download.
- [ ] Controle de ganho/normalização entre aba e microfone.
- [ ] Detecção de silêncio para não enviar blocos vazios à API.

### Backend / dados
- [ ] Trocar o storage em JSON por SQLite ou Postgres.
- [ ] Autenticação (multiusuário) e isolamento de reuniões por usuário.
- [ ] Webhooks / integrações (Notion, Slack, Google Docs, Monday).
- [ ] Reprocessar resumo com prompts customizados.

### Extensão
- [ ] Ícones definitivos e onboarding.
- [ ] Página de histórico completa (abrir reunião, editar título, exportar).
- [ ] Auto-detecção de plataformas (Meet/Zoom/Teams) e início automático.
- [ ] Indicador visual de gravação na aba.

### Qualidade
- [ ] Testes automatizados do backend (supertest).
- [ ] Tratamento de rate limit / retry exponencial nas chamadas à OpenAI.
