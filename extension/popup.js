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

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
function renderSession(session) {
  const recording = session?.recording;
  els.recordBtn.textContent = recording ? '⏹ Parar' : '▶ Gravar';
  els.recordBtn.classList.toggle('recording', !!recording);

  els.status.textContent = session?.status || 'Pronto.';

  if (session?.startedAt) {
    const secs = Math.round(((session.recording ? Date.now() : session.startedAt + 0) - session.startedAt) / 1000);
    const segCount = Array.isArray(session.segments) ? session.segments.length : 0;
    els.meta.textContent = `${segCount} bloco(s) transcrito(s)` + (recording ? ` · ${secs}s` : '');
  } else {
    els.meta.textContent = '';
  }

  const t = (session?.transcript || '').trim();
  if (t) {
    els.transcript.textContent = t;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } else {
    els.transcript.innerHTML =
      '<span class="muted">A transcrição aparece aqui durante a gravação…</span>';
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
  settings = await saveSettings({ backendUrl: url, userName });
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
  if (els.recordBtn.classList.contains('recording')) refresh();
}, 1500);

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
(async () => {
  settings = await getSettings();
  els.backendUrl.value = settings.backendUrl;
  els.userName.value = settings.userName || 'Você';
  await refresh();
})();
