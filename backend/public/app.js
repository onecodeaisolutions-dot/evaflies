// Painel web: lista de reuniões + detalhe (áudio + transcrição com timestamps).

const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
const searchEl = document.getElementById('search');
const tpl = document.getElementById('detail-template');

let meetings = [];
let activeId = null;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`;
};
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --------------------------------------------------------------------------
// Lista
// --------------------------------------------------------------------------
async function loadMeetings() {
  const res = await fetch('/api/meetings');
  meetings = await res.json();
  renderList();
}

function renderList() {
  const q = (searchEl.value || '').toLowerCase();
  const filtered = meetings.filter((m) => m.title.toLowerCase().includes(q));
  listEl.innerHTML = '';
  if (!filtered.length) {
    listEl.innerHTML = '<p style="color:var(--muted);padding:10px">Nenhuma reunião.</p>';
    return;
  }
  for (const m of filtered) {
    const div = document.createElement('div');
    div.className = 'meeting' + (m.id === activeId ? ' active' : '');
    div.innerHTML =
      `<div class="m-title">${escapeHtml(m.title)}</div>` +
      `<div class="m-sub"><span>${fmtDate(m.createdAt)}</span>` +
      `<span>${fmtDur(m.durationMs)}</span>` +
      (m.hasAudio ? '<span>🎧</span>' : '') + '</div>';
    div.addEventListener('click', () => openMeeting(m.id));
    listEl.appendChild(div);
  }
}

// --------------------------------------------------------------------------
// Detalhe
// --------------------------------------------------------------------------
async function openMeeting(id) {
  activeId = id;
  renderList();
  history.replaceState(null, '', `?id=${id}`);

  const res = await fetch(`/api/meetings/${id}`);
  if (!res.ok) {
    detailEl.innerHTML = '<div class="empty"><h1>Reunião não encontrada</h1></div>';
    return;
  }
  const m = await res.json();
  renderDetail(m);
}

function renderDetail(m) {
  detailEl.innerHTML = '';
  const node = tpl.content.cloneNode(true);

  node.querySelector('.title').textContent = m.title;
  node.querySelector('.meta').textContent =
    `${fmtDate(m.createdAt)} · ${fmtDur(m.durationMs)}`;

  const audio = node.querySelector('.player');
  const noAudio = node.querySelector('.no-audio');
  if (m.audioId) {
    audio.src = `/api/audio/${m.audioId}.webm`;
    fixWebmDuration(audio);
  } else {
    audio.classList.add('hidden');
    noAudio.classList.remove('hidden');
  }

  // Transcrição com timestamps
  const transcriptEl = node.querySelector('.transcript');
  const segments = (m.segments && m.segments.length)
    ? m.segments
    : (m.transcript ? [{ startMs: 0, endMs: 0, text: m.transcript }] : []);

  if (!segments.length) {
    transcriptEl.innerHTML = '<p style="color:var(--muted)">Sem transcrição.</p>';
  }
  const segEls = [];
  const speakerColors = {};
  const palette = ['#6c8cff', '#38d39f', '#ff9f6c', '#c98cff', '#ff6c9f'];
  const colorFor = (sp) => {
    if (!sp) return 'var(--muted)';
    if (!(sp in speakerColors)) {
      speakerColors[sp] = palette[Object.keys(speakerColors).length % palette.length];
    }
    return speakerColors[sp];
  };

  for (const seg of segments) {
    const el = document.createElement('div');
    el.className = 'seg';
    el.dataset.start = seg.startMs || 0;
    el.dataset.end = seg.endMs || 0;
    const speakerLine = seg.speaker
      ? `<div class="spk" style="color:${colorFor(seg.speaker)}">${escapeHtml(seg.speaker)}</div>`
      : '';
    el.innerHTML = `<div class="ts">${fmtTime(seg.startMs)}</div>` +
      `<div class="txt">${speakerLine}${escapeHtml(seg.text)}</div>`;
    el.addEventListener('click', () => {
      if (!m.audioId) return;
      audio.currentTime = (seg.startMs || 0) / 1000;
      audio.play();
    });
    transcriptEl.appendChild(el);
    segEls.push(el);
  }

  // Destaca o trecho atual conforme o áudio toca
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime * 1000;
    let current = null;
    for (const el of segEls) {
      const start = +el.dataset.start;
      const end = +el.dataset.end || Infinity;
      if (t >= start && t < end) current = el;
    }
    segEls.forEach((el) => el.classList.toggle('active', el === current));
    if (current) current.scrollIntoView({ block: 'nearest' });
  });

  // Resumo
  const summaryText = node.querySelector('.summary-text');
  const actionItems = node.querySelector('.action-items');
  const topics = node.querySelector('.topics');
  if (m.summary) {
    summaryText.textContent = m.summary.summary || '';
    (m.summary.action_items || []).forEach((it) => {
      const li = document.createElement('li');
      li.textContent = it;
      actionItems.appendChild(li);
    });
    (m.summary.topics || []).forEach((tp) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = tp;
      topics.appendChild(chip);
    });
  } else {
    summaryText.textContent = 'Sem resumo gerado para esta reunião.';
  }

  // Abas
  node.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      detailEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      detailEl.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab);
      });
    });
  });

  detailEl.appendChild(node);
}

// MediaRecorder gera webm sem duração no cabeçalho => força o Chrome a calcular,
// senão a barra de progresso fica "Infinity" e o seek não funciona.
function fixWebmDuration(audio) {
  const onMeta = () => {
    if (audio.duration === Infinity || Number.isNaN(audio.duration)) {
      audio.currentTime = 1e101;
      const onUpdate = () => {
        audio.removeEventListener('timeupdate', onUpdate);
        audio.currentTime = 0;
      };
      audio.addEventListener('timeupdate', onUpdate);
    }
  };
  audio.addEventListener('loadedmetadata', onMeta, { once: true });
}

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
searchEl.addEventListener('input', renderList);

(async () => {
  await loadMeetings();
  const id = new URLSearchParams(location.search).get('id');
  if (id) openMeeting(id);
})();
