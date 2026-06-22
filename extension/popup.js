// Lógica do popup: controla a gravação e mostra a transcrição + resumo (gerados
// ao parar a gravação).
import { getSettings, saveSettings } from './config.js';

const $ = (id) => document.getElementById(id);

const els = {
  recordBtn: $('recordBtn'),
  recLabel: $('recLabel'),
  statusPill: $('statusPill'),
  status: $('status'),
  meta: $('meta'),
  transcript: $('transcript'),
  summarySection: $('summarySection'),
  summary: $('summary'),
  actionItems: $('actionItems'),
  topics: $('topics'),
  settings: $('settings'),
  settingsToggle: $('settingsToggle'),
  backendUrl: $('backendUrl'),
  userName: $('userName'),
  accessKey: $('accessKey'),
  autoStop: $('autoStop'),
  saveSettings: $('saveSettings'),
  checkHealth: $('checkHealth'),
  grantMic: $('grantMic'),
  settingsStatus: $('settingsStatus'),
  copyTranscript: $('copyTranscript'),
  openDashboard: $('openDashboard'),
  viewMeetings: $('viewMeetings'),
  meetingsList: $('meetingsList'),
};

let settings = null;
let sessionActive = false; // gravando ou processando

const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
function renderSession(session) {
  const recording = session?.recording;
  const stopping = session?.stopping; // curto "finalizando" (coletando o áudio)
  const pending = session?.pendingUploads || 0; // uploads em segundo plano
  sessionActive = !!(recording || stopping || pending);

  if (recording) {
    const secs = session?.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : 0;
    els.recLabel.textContent = `Parar · ${fmtClock(secs)}`;
  } else if (stopping) {
    els.recLabel.textContent = 'Finalizando…';
  } else {
    els.recLabel.textContent = 'Gravar';
  }
  els.recordBtn.classList.toggle('recording', !!recording);
  // Só bloqueia no curto "finalizando". Reuniões processando em 2º plano NÃO
  // impedem iniciar uma nova gravação.
  els.recordBtn.disabled = !!stopping;

  let statusText = session?.status || 'Pronto.';
  if (pending > 0) statusText += ` · ⏳ ${pending} em segundo plano`;
  els.status.textContent = statusText;
  els.statusPill.classList.toggle('recording', !!recording);
  els.statusPill.classList.toggle('error', /^erro/i.test(statusText));

  if (session?.startedAt && stopping) {
    // Cronômetro CONGELADO no momento em que a captura parou.
    const secs = Math.round(((session.endedAt || Date.now()) - session.startedAt) / 1000);
    els.meta.textContent = `Gravou ${fmtClock(secs)} · finalizando…`;
  } else if (!recording && session?.segments?.length) {
    els.meta.textContent = `${session.segments.length} trecho(s) transcrito(s)`;
  } else {
    els.meta.textContent = '';
  }

  const t = (session?.transcript || '').trim();
  if (t) {
    els.transcript.textContent = t;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } else {
    els.transcript.innerHTML =
      '<span class="muted">A transcrição é gerada ao parar a gravação.</span>';
  }

  // Resumo (após finalizar)
  const summary = session?.meeting?.summary;
  if (summary) {
    els.summarySection.classList.remove('hidden');
    els.summary.textContent = summary.summary || '';
    els.actionItems.innerHTML = '';
    (summary.action_items || []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      els.actionItems.appendChild(li);
    });
    els.topics.innerHTML = '';
    (summary.topics || []).forEach((tp) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = tp;
      els.topics.appendChild(chip);
    });
  } else {
    els.summarySection.classList.add('hidden');
  }
}

async function refresh() {
  const { session } = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_SESSION' });
  renderSession(session);
}

// --------------------------------------------------------------------------
// Ações
// --------------------------------------------------------------------------
els.recordBtn.addEventListener('click', async () => {
  const { session } = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_SESSION' });
  if (session?.stopping) return; // ignora cliques durante o curto "finalizando"
  const type = session?.recording ? 'STOP' : 'START';
  els.recordBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ target: 'background', type });
    if (res && res.ok === false) els.status.textContent = `Erro: ${res.error}`;
  } finally {
    els.recordBtn.disabled = false;
    refresh();
  }
});

els.settingsToggle.addEventListener('click', () => {
  const open = !els.settings.classList.toggle('hidden');
  els.settingsToggle.classList.toggle('active', open);
});

els.saveSettings.addEventListener('click', async () => {
  const url = els.backendUrl.value.trim().replace(/\/$/, '');
  const userName = els.userName.value.trim() || 'Você';
  const accessKey = els.accessKey.value.trim();
  const autoStopSilenceMin = Math.max(0, Math.min(60, parseInt(els.autoStop.value, 10) || 0));
  settings = await saveSettings({ backendUrl: url, userName, accessKey, autoStopSilenceMin });
  els.settingsStatus.textContent = 'Configurações salvas.';
  els.settingsStatus.className = 'settings-status ok';
});

els.checkHealth.addEventListener('click', async () => {
  els.settingsStatus.textContent = 'Testando…';
  els.settingsStatus.className = 'settings-status';
  try {
    const res = await fetch(`${els.backendUrl.value.trim().replace(/\/$/, '')}/api/health`);
    const data = await res.json();
    if (data.ok && data.hasApiKey) {
      els.settingsStatus.textContent = `OK · transcrição: ${data.models.TRANSCRIBE_MODEL}`;
      els.settingsStatus.className = 'settings-status ok';
    } else if (data.ok) {
      els.settingsStatus.textContent = 'Backend no ar, mas sem OPENAI_API_KEY configurada.';
      els.settingsStatus.className = 'settings-status err';
    }
  } catch (err) {
    els.settingsStatus.textContent = `Sem conexão: ${err.message}`;
    els.settingsStatus.className = 'settings-status err';
  }
});

// Concede permissão de microfone à extensão (persiste para o offscreen usar).
els.grantMic.addEventListener('click', async () => {
  els.settingsStatus.textContent = 'Solicitando microfone…';
  els.settingsStatus.className = 'settings-status';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    els.settingsStatus.textContent = 'Microfone permitido ✅';
    els.settingsStatus.className = 'settings-status ok';
  } catch (err) {
    els.settingsStatus.textContent = `Permissão negada: ${err.message}`;
    els.settingsStatus.className = 'settings-status err';
  }
});

els.copyTranscript.addEventListener('click', async () => {
  const text = els.transcript.textContent || '';
  await navigator.clipboard.writeText(text);
  els.copyTranscript.textContent = 'Copiado!';
  setTimeout(() => (els.copyTranscript.textContent = 'Copiar'), 1200);
});

els.openDashboard.addEventListener('click', () => {
  chrome.tabs.create({ url: `${settings.backendUrl}/` });
});

els.viewMeetings.addEventListener('click', async () => {
  els.meetingsList.classList.toggle('hidden');
  if (els.meetingsList.classList.contains('hidden')) return;
  els.meetingsList.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    const res = await fetch(`${settings.backendUrl}/api/meetings`);
    const meetings = await res.json();
    if (!meetings.length) {
      els.meetingsList.innerHTML = '<p class="muted">Nenhuma reunião salva ainda.</p>';
      return;
    }
    els.meetingsList.innerHTML = '';
    meetings.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'meeting-item';
      const date = new Date(m.createdAt).toLocaleString('pt-BR');
      const audioTag = m.hasAudio ? ' · 🎧 áudio' : '';
      div.innerHTML = `<div class="title">${escapeHtml(m.title)}</div>` +
        `<div class="muted">${date}${audioTag}</div>` +
        `<div class="muted">${escapeHtml(m.transcriptPreview || '')}…</div>`;
      div.addEventListener('click', () =>
        chrome.tabs.create({ url: `${settings.backendUrl}/?id=${m.id}` })
      );
      els.meetingsList.appendChild(div);
    });
  } catch (err) {
    els.meetingsList.innerHTML = `<p class="muted err">Erro: ${escapeHtml(err.message)}</p>`;
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// --------------------------------------------------------------------------
// Eventos do background
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === 'popup' && message.type === 'SESSION_UPDATE') {
    refresh();
  }
});

// Atualiza o cronômetro/UI periodicamente enquanto o popup está aberto.
setInterval(() => {
  if (sessionActive) refresh();
}, 1500);

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
(async () => {
  settings = await getSettings();
  els.backendUrl.value = settings.backendUrl;
  els.userName.value = settings.userName || 'Você';
  els.accessKey.value = settings.accessKey || '';
  els.autoStop.value = settings.autoStopSilenceMin ?? 5;
  await refresh();
})();
