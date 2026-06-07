# Roadmap

MVP atual: gravação (aba + mic) + transcrição em blocos com timestamps via
OpenAI + resumo com action items + **áudio completo salvo** + **painel web**
estilo Fireflies (lista de reuniões, player de áudio e transcrição minuto a
minuto com seek). Armazenado em arquivo JSON + arquivos de áudio no backend.

## Próximos passos

### Transcrição
- [x] Timestamps por bloco (transcrição minuto a minuto).
- [x] Diarização por canal: separa "Você" (microfone) de "Participantes" (aba).
- [ ] Diarização por pessoa entre os participantes remotos (ex: pyannote / serviço dedicado).
- [ ] **Realtime API** da OpenAI (WebSocket) para transcrição palavra-a-palavra ao vivo.
- [ ] Timestamps por palavra (usar `whisper-1` com `response_format=verbose_json`).

### Áudio
- [x] Salvar o áudio completo da reunião (gravador contínuo) e reproduzir no painel.
- [ ] Botão de download do áudio no painel.
- [ ] Corrigir a duração do `.webm` no servidor (ts-ebml) em vez do hack no player.
- [ ] Controle de ganho/normalização entre aba e microfone.
- [ ] Detecção de silêncio para não enviar blocos vazios à API.

### Backend / dados
- [ ] Trocar o storage em JSON por SQLite ou Postgres.
- [ ] Autenticação (multiusuário) e isolamento de reuniões por usuário.
- [ ] Webhooks / integrações (Notion, Slack, Google Docs, Monday).
- [ ] Reprocessar resumo com prompts customizados.

### Extensão
- [x] Painel de histórico (lista de reuniões + detalhe com áudio e transcrição).
- [ ] Ícones definitivos e onboarding.
- [ ] Editar título / exportar reunião no painel.
- [ ] Auto-detecção de plataformas (Meet/Zoom/Teams) e início automático.
- [ ] Indicador visual de gravação na aba.

### Qualidade
- [ ] Testes automatizados do backend (supertest).
- [ ] Tratamento de rate limit / retry exponencial nas chamadas à OpenAI.
