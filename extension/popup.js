// Lógica do popup: controla gravação, mostra a transcrição ao vivo e o resumo.
import { getSettings, saveSettings } from './config.js';

const $ = (id) => document.getElementById(id);

const els = {
  recordBtn: $('recordBtn'),
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

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
function renderSession(session) {
  const recording = session?.recording;
  const processing = session?.processing;
  sessionActive = !!(recording || processing);

  if (recording) {
    els.recordBtn.textContent = '⏹ Parar';
  } else if (processing) {
    els.recordBtn.textContent = '⏳ Processando…';
  } else {
    els.recordBtn.textContent = '▶ Gravar';
  }
  els.recordBtn.classList.toggle('recording', !!recording);
  els.recordBtn.disabled = !!processing; // não dá pra gravar enquanto finaliza

  els.status.textContent = session?.status || 'Pronto.';

  if (session?.startedAt) {
    if (recording) {
      const secs = Math.round((Date.now() - session.startedAt) / 1000);
      els.meta.textContent = `Gravando · ${secs}s`;
    } else if (processing) {
      // Cronômetro CONGELADO no momento em que a captura parou.
      const secs = Math.round(((session.endedAt || Date.now()) - session.startedAt) / 1000);
      els.meta.textContent = `Gravou ${secs}s · processando…`;
    } else {
      const segCount = Array.isArray(session.segments) ? session.segments.length : 0;
      els.meta.textContent = segCount ? `${segCount} trecho(s) transcrito(s)` : '';
    }
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
  if (session?.processing) return; // ignora cliques durante o processamento
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
  els.settings.classList.toggle('hidden');
});

els.saveSettings.addEventListener('click', async () => {
  const url = els.backendUrl.value.trim().replace(/\/$/, '');
  const userName = els.userName.value.trim() || 'Você';
  const accessKey = els.accessKey.value.trim();
  const autoStopSilenceMin = Math.max(0, Math.min(60, parseInt(els.autoStop.value, 10) || 0));
  settings = await saveSettings({ backendUrl: url, userName, accessKey, autoStopSilenceMin });
  els.settingsStatus.textContent = 'Configurações salvas.';
  els.settingsStatus.className = 'muted ok';
});

els.checkHealth.addEventListener('click', async () => {
  els.settingsStatus.textContent = 'Testando…';
  els.settingsStatus.className = 'muted';
  try {
    const res = await fetch(`${els.backendUrl.value.trim().replace(/\/$/, '')}/api/health`);
    const data = await res.json();
    if (data.ok && data.hasApiKey) {
      els.settingsStatus.textContent = `OK · transcrição: ${data.models.TRANSCRIBE_MODEL}`;
      els.settingsStatus.className = 'muted ok';
    } else if (data.ok) {
      els.settingsStatus.textContent = 'Backend no ar, mas sem OPENAI_API_KEY configurada.';
      els.settingsStatus.className = 'muted err';
    }
  } catch (err) {
    els.settingsStatus.textContent = `Sem conexão: ${err.message}`;
    els.settingsStatus.className = 'muted err';
  }
});

// Concede permissão de microfone à extensão (persiste para o offscreen usar).
els.grantMic.addEventListener('click', async () => {
  els.settingsStatus.textContent = 'Solicitando microfone…';
  els.settingsStatus.className = 'muted';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    els.settingsStatus.textContent = 'Microfone permitido ✅';
    els.settingsStatus.className = 'muted ok';
  } catch (err) {
    els.settingsStatus.textContent = `Permissão negada: ${err.message}`;
    els.settingsStatus.className = 'muted err';
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
