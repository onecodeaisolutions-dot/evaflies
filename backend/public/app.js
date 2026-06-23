// Painel web: lista de reuniões + detalhe (player fixo com barra de progresso +
// transcrição sincronizada por timestamps + resumo).

const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
const searchEl = document.getElementById('search');
const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
const clearFiltersEl = document.getElementById('clear-filters');
const ownerFilterEl = document.getElementById('owner-filter');
const ownerWrapEl = document.getElementById('owner-wrap');
const tpl = document.getElementById('detail-template');

let meetings = [];
let activeId = null;
let isAdmin = false;
let accessKey = localStorage.getItem('eva_key') || '';
let playbackSpeed = parseFloat(localStorage.getItem('eva_speed')) || 1;

// fetch que inclui o código de acesso (quando houver).
function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (accessKey) headers['x-eva-key'] = accessKey;
  return fetch(path, { ...opts, headers });
}

// URL do áudio com a chave por query (o <audio> não envia headers).
function audioUrl(audioId) {
  const base = `/api/audio/${audioId}.webm`;
  return accessKey ? `${base}?key=${encodeURIComponent(accessKey)}` : base;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`;
};
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cores de locutor: 1º → roxo, 2º → ciano (intenção Você/Participantes).
function makeColorFor() {
  const map = {};
  const palette = ['#b06bff', '#34d8ff', '#ff9f6c', '#5ad19f', '#ff6c9f'];
  return (sp) => {
    if (!sp) return 'var(--meta)';
    if (!(sp in map)) map[sp] = palette[Object.keys(map).length % palette.length];
    return map[sp];
  };
}

// Auto-acompanhamento da transcrição: segue a linha que está tocando, mas pausa
// quando o usuário rola manualmente (pra não "sequestrar" a página).
let autoFollow = true;
let followResumeTimer;
function pauseAutoFollow() {
  autoFollow = false;
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => { autoFollow = true; }, 6000);
}
// Verdadeiro se o elemento está confortavelmente visível na área de conteúdo
// (deixa folga embaixo por causa do player fixo no rodapé).
function isInView(el) {
  const c = detailEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.top >= c.top + 70 && r.bottom <= c.bottom - 110;
}

// --------------------------------------------------------------------------
// Lista
// --------------------------------------------------------------------------
async function loadMeetings() {
  const params = new URLSearchParams();
  if (searchEl.value.trim()) params.set('q', searchEl.value.trim());
  if (fromEl.value) params.set('from', fromEl.value);
  if (toEl.value) params.set('to', toEl.value);
  if (isAdmin && ownerFilterEl.value) params.set('owner', ownerFilterEl.value);
  const qs = params.toString();
  const res = await api(`/api/meetings${qs ? `?${qs}` : ''}`);
  if (res.status === 401) return showLogin();
  meetings = await res.json();
  renderList();
}

function renderList() {
  listEl.innerHTML = '';
  if (!meetings.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'Nenhuma reunião encontrada.';
    listEl.appendChild(p);
    return;
  }
  for (const m of meetings) {
    const div = document.createElement('div');
    div.className = 'meeting' + (m.id === activeId ? ' active' : '');
    div.innerHTML =
      `<div class="m-title">${escapeHtml(m.title)}</div>` +
      `<div class="m-sub">` +
      `<span class="m-meta">${fmtDate(m.createdAt)}&nbsp;&nbsp;·&nbsp;&nbsp;${fmtDur(m.durationMs)}</span>` +
      (m.hasAudio ? '<span class="m-heard" title="Ouvida">🎧</span>' : '') +
      (m.transcriptPreview ? '' : '<span class="m-untx" title="Ainda não transcrita">sem transcrição</span>') +
      (isAdmin && m.owner ? `<span class="owner-badge">${escapeHtml(m.owner)}</span>` : '') +
      `</div>`;
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

  const res = await api(`/api/meetings/${id}`);
  if (res.status === 401) return showLogin();
  if (!res.ok) {
    detailEl.innerHTML = '<div class="empty"><h1>Reunião não encontrada</h1></div>';
    return;
  }
  const m = await res.json();
  renderDetail(m);
}

function renderDetail(m, ctx = {}) {
  const share = ctx.share || null; // token quando estamos na view pública
  autoFollow = true; // cada reunião começa acompanhando
  detailEl.innerHTML = '';
  const node = tpl.content.cloneNode(true);

  node.querySelector('.title').textContent = m.title;

  const meta = node.querySelector('.meta');
  let metaHtml = `<span>${fmtDate(m.createdAt)}</span><span class="sep">•</span><span>${fmtDur(m.durationMs)}</span>`;
  if (isAdmin && m.owner) {
    metaHtml += `<span class="sep">•</span><span class="owner"><span class="dot"></span>${escapeHtml(m.owner)}</span>`;
  }
  meta.innerHTML = metaHtml;

  const hasTranscript = !!(m.segments && m.segments.length) || !!(m.transcript && m.transcript.trim());

  // Baixar áudio (.webm) — quando há áudio.
  const dlAudioBtn = node.querySelector('.btn-download-audio');
  if (m.audioId && !share) dlAudioBtn.addEventListener('click', () => downloadAudio(m));
  else dlAudioBtn.remove();

  // Baixar transcrição (.txt) — só quando já transcrita.
  const dlTextBtn = node.querySelector('.btn-download');
  if (hasTranscript) dlTextBtn.addEventListener('click', () => downloadTranscript(m));
  else dlTextBtn.remove();

  // Transcrever — só quando ainda NÃO foi transcrita (e não é view pública).
  const transcribeBtn = node.querySelector('.btn-transcribe');
  if (!share && m.audioId && !hasTranscript) transcribeBtn.addEventListener('click', () => transcribeMeeting(m));
  else transcribeBtn.remove();

  if (share) {
    // View pública: só leitura — remove renomear/excluir/compartilhar.
    node.querySelector('.btn-rename').remove();
    node.querySelector('.btn-delete').remove();
    node.querySelector('.btn-share').remove();
  } else {
    node.querySelector('.btn-rename').addEventListener('click', () => renameMeeting(m));
    node.querySelector('.btn-delete').addEventListener('click', () => removeMeeting(m));
    node.querySelector('.btn-share').addEventListener('click', () => openShareModal(m));
  }

  // --- Player (rodapé fixo) ---
  const playerEl = node.querySelector('.player');
  const noAudio = node.querySelector('.no-audio');
  const audio = node.querySelector('.audio-el');
  const playBtn = node.querySelector('.play-btn');
  const seekEl = node.querySelector('.seekbar');
  const seekFill = node.querySelector('.seek-fill');
  const seekThumb = node.querySelector('.seek-thumb');
  const tCur = node.querySelector('.t-cur');
  const tDur = node.querySelector('.t-dur');
  const volBtn = node.querySelector('.vol-btn');
  const speedBtns = node.querySelectorAll('.speed-btn');

  const curDur = () =>
    audio.duration && isFinite(audio.duration) ? audio.duration : (m.durationMs || 0) / 1000;
  const setSeekUI = (prog) => {
    const pct = Math.max(0, Math.min(1, prog || 0)) * 100;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
  };

  if (m.audioId) {
    audio.src = share ? `/api/share/${encodeURIComponent(share)}/audio` : audioUrl(m.audioId);
    audio.playbackRate = playbackSpeed;
    fixWebmDuration(audio);
    tDur.textContent = fmtTime(m.durationMs);
    setSeekUI(0);

    const markSpeed = () =>
      speedBtns.forEach((b) => b.classList.toggle('active', parseFloat(b.dataset.speed) === playbackSpeed));
    markSpeed();
    speedBtns.forEach((b) =>
      b.addEventListener('click', () => {
        playbackSpeed = parseFloat(b.dataset.speed);
        localStorage.setItem('eva_speed', String(playbackSpeed));
        audio.playbackRate = playbackSpeed;
        markSpeed();
      }));

    playBtn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
    audio.addEventListener('play', () => {
      playBtn.textContent = '❚❚';
      playBtn.classList.add('playing');
    });
    const onStop = () => {
      playBtn.textContent = '►';
      playBtn.classList.remove('playing');
    };
    audio.addEventListener('pause', onStop);
    audio.addEventListener('ended', onStop);

    const refreshDur = () => (tDur.textContent = fmtTime(curDur() * 1000));
    audio.addEventListener('loadedmetadata', refreshDur);
    audio.addEventListener('durationchange', refreshDur);

    // Barra de progresso: clique em qualquer ponto OU arraste para escolher o tempo.
    const pctFromEvent = (e) => {
      const r = seekEl.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    let scrubbing = false;
    seekEl.addEventListener('pointerdown', (e) => {
      const d = curDur();
      if (!d) return;
      scrubbing = true;
      seekEl.setPointerCapture(e.pointerId);
      const p = pctFromEvent(e);
      setSeekUI(p);
      audio.currentTime = p * d;
    });
    seekEl.addEventListener('pointermove', (e) => {
      if (!scrubbing) return;
      const d = curDur();
      if (!d) return;
      const p = pctFromEvent(e);
      setSeekUI(p);
      tCur.textContent = fmtTime(p * d * 1000);
      audio.currentTime = p * d;
    });
    const endScrub = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      try { seekEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    seekEl.addEventListener('pointerup', endScrub);
    seekEl.addEventListener('pointercancel', endScrub);

    volBtn.addEventListener('click', () => {
      audio.muted = !audio.muted;
      volBtn.classList.toggle('muted', audio.muted);
      volBtn.textContent = audio.muted ? '🔇' : '🔊';
    });
  } else {
    playerEl.classList.add('hidden');
    noAudio.classList.remove('hidden');
  }

  // --- Transcrição com timestamps ---
  const transcriptEl = node.querySelector('.transcript');
  const segments =
    m.segments && m.segments.length
      ? m.segments
      : m.transcript
      ? [{ startMs: 0, endMs: 0, text: m.transcript }]
      : [];

  if (!segments.length) {
    if (!share && m.audioId) {
      const box = document.createElement('div');
      box.className = 'transcribe-cta';
      box.innerHTML =
        '<p>Esta reunião ainda não foi transcrita.</p>' +
        '<button class="btn btn-cta">✨ Transcrever agora</button>' +
        '<p class="hint-sm">A transcrição roda só quando você pede (economiza custo).</p>';
      box.querySelector('.btn-cta').addEventListener('click', () => transcribeMeeting(m));
      transcriptEl.appendChild(box);
    } else {
      transcriptEl.innerHTML = '<p class="summary-muted">Sem transcrição.</p>';
    }
  }
  const segEls = [];
  const colorFor = makeColorFor();

  for (const seg of segments) {
    const el = document.createElement('div');
    el.className = 'seg';
    el.dataset.start = seg.startMs || 0;
    el.dataset.end = seg.endMs || 0;
    const color = colorFor(seg.speaker);
    const spkRow = seg.speaker
      ? `<div class="spk-row"><span class="spk-dot" style="background:${color};box-shadow:0 0 7px ${color}"></span>` +
        `<span class="spk" style="color:${color}">${escapeHtml(seg.speaker)}</span></div>`
      : '';
    el.innerHTML = `<div class="ts">${fmtTime(seg.startMs)}</div>` + `<div class="body">${spkRow}<p class="txt">${escapeHtml(seg.text)}</p></div>`;
    el.addEventListener('click', () => {
      if (!m.audioId) return;
      autoFollow = true; // clicou numa linha: volta a acompanhar
      audio.currentTime = (seg.startMs || 0) / 1000;
      audio.play();
    });
    transcriptEl.appendChild(el);
    segEls.push(el);
  }

  // Atualiza a barra + destaca o trecho atual conforme o áudio toca.
  let lastActive = null;
  audio.addEventListener('timeupdate', () => {
    const d = curDur();
    setSeekUI(d ? audio.currentTime / d : 0);
    tCur.textContent = fmtTime(audio.currentTime * 1000);

    const t = audio.currentTime * 1000;
    let current = null;
    for (const el of segEls) {
      const start = +el.dataset.start;
      const end = +el.dataset.end || Infinity;
      if (t >= start && t < end) current = el;
    }
    if (current !== lastActive) {
      segEls.forEach((el) => el.classList.toggle('active', el === current));
      // Só rola se estiver acompanhando E a linha saiu da área visível.
      if (current && autoFollow && !isInView(current)) {
        current.scrollIntoView({ block: 'center' });
      }
      lastActive = current;
    }
  });

  // --- Resumo ---
  renderSummary(node.querySelector('.summary-wrap'), m, segments, !share);

  // --- Abas ---
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

// Monta o painel de Resumo. Stats são computados dos dados reais (sem inventar):
// Duração, Participantes, Palavras e Trechos. Visão geral ← summary; Tópicos ←
// topics; Itens de ação ← action_items.
function renderSummary(container, m, segments, canTranscribe) {
  // Ainda não transcrita: convida a transcrever (o resumo depende da transcrição).
  if (!segments.length) {
    if (m.audioId && canTranscribe) {
      const box = document.createElement('div');
      box.className = 'transcribe-cta';
      box.innerHTML =
        '<p>Transcreva a reunião para ver o resumo, os tópicos e os itens de ação.</p>' +
        '<button class="btn btn-cta">✨ Transcrever agora</button>';
      box.querySelector('.btn-cta').addEventListener('click', () => transcribeMeeting(m));
      container.innerHTML = '';
      container.appendChild(box);
    } else {
      container.innerHTML = '<p class="summary-muted">Sem transcrição.</p>';
    }
    return;
  }
  const speakers = new Set((m.segments || []).map((s) => s.speaker).filter(Boolean));
  const text = segments.map((s) => s.text).join(' ').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const wordsLabel = words >= 1000 ? `${(words / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(words);

  const stats = [
    { label: 'Duração', value: fmtDur(m.durationMs) },
    { label: 'Participantes', value: speakers.size ? String(speakers.size) : '—' },
    { label: 'Palavras', value: wordsLabel },
    { label: 'Trechos', value: String(segments.length) },
  ];

  const overview = (m.summary && m.summary.summary) || 'Sem resumo gerado para esta reunião.';
  const topics = (m.summary && m.summary.topics) || [];
  const actions = (m.summary && m.summary.action_items) || [];

  const statCards = stats
    .map((s) => `<div class="stat-card"><div class="label">${s.label}</div><div class="value">${escapeHtml(s.value)}</div></div>`)
    .join('');

  const pointsHtml = topics.length
    ? `<div class="points">${topics
        .map((t) => `<div class="point"><span class="bullet"></span><span class="txt">${escapeHtml(t)}</span></div>`)
        .join('')}</div>`
    : '<p class="summary-muted">Sem tópicos.</p>';

  const actionsHtml = actions.length
    ? `<div class="actions">${actions
        .map((a) => `<div class="action"><span class="check">✓</span><span class="task">${escapeHtml(a)}</span></div>`)
        .join('')}</div>`
    : '<p class="summary-muted">Sem itens de ação.</p>';

  container.innerHTML =
    `<div class="stat-strip">${statCards}</div>` +
    `<div class="overview-card"><div class="label">VISÃO GERAL</div><p>${escapeHtml(overview)}</p></div>` +
    `<div class="summary-cols">` +
    `<div class="summary-col"><div class="col-title">Tópicos</div>${pointsHtml}</div>` +
    `<div class="summary-col"><div class="col-title">Itens de ação</div>${actionsHtml}</div>` +
    `</div>`;
}

// --------------------------------------------------------------------------
// Transcrição sob demanda + download do áudio
// --------------------------------------------------------------------------
const safeFileName = (s) => (s || 'reuniao').replace(/[^\w\-À-ÿ ]+/g, '').trim().slice(0, 80) || 'reuniao';

function downloadAudio(m) {
  if (!m.audioId) return;
  const nome = `${safeFileName(m.title)}.webm`;
  const params = new URLSearchParams();
  if (accessKey) params.set('key', accessKey);
  params.set('download', nome);
  const a = document.createElement('a');
  a.href = `/api/audio/${m.audioId}.webm?${params.toString()}`;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function transcribeMeeting(m) {
  // Estado de "transcrevendo" nos CTAs e no botão do header.
  detailEl.querySelectorAll('.transcribe-cta').forEach((box) => {
    box.innerHTML = '<p class="transcribing">⏳ Transcrevendo… pode levar alguns minutos em reuniões longas.</p>';
  });
  const headBtn = detailEl.querySelector('.btn-transcribe');
  if (headBtn) { headBtn.disabled = true; headBtn.textContent = '⏳ Transcrevendo…'; }

  try {
    const res = await api(`/api/meetings/${m.id}/transcribe`, { method: 'POST' });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      let detail = `Servidor respondeu ${res.status}`;
      try { const e = await res.json(); if (e && e.error) detail = e.error; } catch (_) {}
      throw new Error(detail);
    }
    const updated = await res.json();
    renderDetail(updated);
    await loadMeetings();
  } catch (err) {
    alert(`Falha ao transcrever: ${err.message}`);
    openMeeting(m.id); // restaura o estado (botão Transcrever de volta)
  }
}

// --------------------------------------------------------------------------
// View pública (link compartilhado: ?share=<token>)
// --------------------------------------------------------------------------
async function renderSharePage(token) {
  document.body.classList.add('share-mode');
  const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
  if (!res.ok) {
    detailEl.innerHTML =
      '<div class="empty"><h1>Link indisponível</h1>' +
      '<p>Este link de compartilhamento é inválido ou foi revogado pelo autor.</p></div>';
    return;
  }
  const m = await res.json();
  // O player liga em m.audioId; usamos um marcador truthy quando há áudio, mas a
  // fonte real vem do endpoint público (definido em renderDetail via ctx.share).
  m.audioId = m.hasAudio ? 'shared' : null;
  renderDetail(m, { share: token });

  const banner = document.createElement('div');
  banner.className = 'share-banner';
  banner.innerHTML =
    '<div class="brand" style="padding:0">' +
    '<div class="brand-tile"><img src="EvaFlies-logo.png" alt="EvaFlies" /></div>' +
    '<span class="brand-word">Eva<span>Flies</span></span></div>' +
    '<span class="share-tag">Reunião compartilhada</span>';
  detailEl.prepend(banner);
}

// --------------------------------------------------------------------------
// Baixar transcrição (.txt)
// --------------------------------------------------------------------------
function downloadTranscript(m) {
  const segments = (m.segments && m.segments.length)
    ? m.segments
    : (m.transcript ? [{ startMs: 0, text: m.transcript, speaker: null }] : []);

  const linhas = [];
  linhas.push(m.title);
  linhas.push(`${fmtDate(m.createdAt)} · ${fmtDur(m.durationMs)}` + (m.owner ? ` · ${m.owner}` : ''));
  linhas.push('='.repeat(40));
  linhas.push('');
  for (const s of segments) {
    const ts = `[${fmtTime(s.startMs)}]`;
    const who = s.speaker ? `${s.speaker}: ` : '';
    linhas.push(`${ts} ${who}${s.text}`);
  }
  const conteudo = linhas.join('\n');

  const nome = (m.title || 'reuniao').replace(/[^\w\-À-ÿ ]+/g, '').trim().slice(0, 80) || 'reuniao';
  const blob = new Blob([conteudo], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nome}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------------------
// Renomear / Excluir
// --------------------------------------------------------------------------
async function renameMeeting(m) {
  const novo = prompt('Novo título da reunião:', m.title);
  if (novo == null) return;
  const title = novo.trim();
  if (!title || title === m.title) return;
  const res = await api(`/api/meetings/${m.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return alert('Não foi possível renomear.');
  m.title = title;
  const titleEl = detailEl.querySelector('.title');
  if (titleEl) titleEl.textContent = title;
  await loadMeetings();
}

async function removeMeeting(m) {
  if (!confirm(`Excluir a reunião "${m.title}"?\nEssa ação não pode ser desfeita.`)) return;
  const res = await api(`/api/meetings/${m.id}`, { method: 'DELETE' });
  if (!res.ok) return alert('Não foi possível excluir.');
  activeId = null;
  history.replaceState(null, '', location.pathname);
  detailEl.innerHTML =
    '<div class="empty"><h1>Reunião excluída</h1><p>Selecione outra reunião à esquerda.</p></div>';
  await loadMeetings();
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

// Lê a duração (ms) de um arquivo de áudio. O webm do MediaRecorder vem sem
// duração no cabeçalho (fica Infinity), então forçamos o cálculo buscando o fim.
// Resolve em 0 se não der (não trava o upload).
function readMediaDurationMs(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    let done = false;
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Math.max(0, Math.round(ms || 0)));
    };
    const timer = setTimeout(() => finish(0), 8000); // rede de segurança
    a.addEventListener('loadedmetadata', () => {
      if (a.duration && isFinite(a.duration)) return finish(a.duration * 1000);
      a.addEventListener('timeupdate', function onU() {
        a.removeEventListener('timeupdate', onU);
        finish(isFinite(a.duration) ? a.duration * 1000 : 0);
      });
      a.currentTime = 1e101; // dispara o recálculo da duração no webm
    });
    a.addEventListener('error', () => finish(0));
    a.src = url;
  });
}

// --------------------------------------------------------------------------
// Login / usuário
// --------------------------------------------------------------------------
const loginEl = document.getElementById('login');
const loginKeyEl = document.getElementById('login-key');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const userbarEl = document.getElementById('userbar');

function showLogin(message) {
  loginEl.classList.remove('hidden');
  loginError.textContent = message || '';
  loginKeyEl.focus();
}

function renderUserbar(user) {
  userbarEl.classList.remove('hidden');
  const initial = (user.name || '?').trim().charAt(0).toUpperCase() || '?';
  userbarEl.innerHTML =
    `<div class="u-info"><div class="u-avatar">${escapeHtml(initial)}</div>` +
    `<span class="u-name">${escapeHtml(user.name)}${user.admin ? ' <small>(admin)</small>' : ''}</span></div>` +
    `<button id="logout" class="u-logout">Sair</button>`;
  document.getElementById('logout').addEventListener('click', () => {
    localStorage.removeItem('eva_key');
    accessKey = '';
    location.reload();
  });
}

async function doLogin() {
  const key = loginKeyEl.value.trim();
  if (!key) return;
  loginError.textContent = 'Entrando…';
  const res = await fetch('/api/me', { headers: { 'x-eva-key': key } });
  if (res.status === 401) {
    loginError.textContent = 'Código inválido. Tente novamente.';
    return;
  }
  localStorage.setItem('eva_key', key);
  accessKey = key;
  loginEl.classList.add('hidden');
  start();
}

loginBtn.addEventListener('click', doLogin);
loginKeyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

// --------------------------------------------------------------------------
// Compartilhar (gerar / copiar / revogar link)
// --------------------------------------------------------------------------
const shareModal = document.getElementById('share-modal');
const shareLinkEl = document.getElementById('share-link');
const shareCopyBtn = document.getElementById('share-copy');
const shareRevokeBtn = document.getElementById('share-revoke');
const shareCloseBtn = document.getElementById('share-close');
let shareMeeting = null;

async function openShareModal(m) {
  shareMeeting = m;
  shareLinkEl.value = 'Gerando link…';
  shareCopyBtn.textContent = 'Copiar';
  shareModal.classList.remove('hidden');
  try {
    const res = await api(`/api/meetings/${m.id}/share`, { method: 'POST' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { shareId } = await res.json();
    m.shareId = shareId;
    shareLinkEl.value = `${location.origin}/?share=${shareId}`;
    shareLinkEl.focus();
    shareLinkEl.select();
  } catch (err) {
    shareModal.classList.add('hidden');
    alert(`Não foi possível gerar o link: ${err.message}`);
  }
}

shareCopyBtn.addEventListener('click', async () => {
  if (!shareLinkEl.value || shareLinkEl.value === 'Gerando link…') return;
  try {
    await navigator.clipboard.writeText(shareLinkEl.value);
  } catch {
    shareLinkEl.select();
    document.execCommand('copy');
  }
  shareCopyBtn.textContent = 'Copiado!';
  setTimeout(() => (shareCopyBtn.textContent = 'Copiar'), 1200);
});

shareRevokeBtn.addEventListener('click', async () => {
  if (!shareMeeting) return;
  if (!confirm('Revogar este link?\nQuem tiver o link atual perderá o acesso.')) return;
  const res = await api(`/api/meetings/${shareMeeting.id}/share`, { method: 'DELETE' });
  if (!res.ok) return alert('Não foi possível revogar o link.');
  shareMeeting.shareId = null;
  shareModal.classList.add('hidden');
});

shareCloseBtn.addEventListener('click', () => shareModal.classList.add('hidden'));
shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) shareModal.classList.add('hidden');
});

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMeetings, 300);
});
// Rolar manualmente pausa o auto-acompanhamento da transcrição por alguns segundos.
detailEl.addEventListener('wheel', pauseAutoFollow, { passive: true });
detailEl.addEventListener('touchmove', pauseAutoFollow, { passive: true });

fromEl.addEventListener('change', loadMeetings);
toEl.addEventListener('change', loadMeetings);
ownerFilterEl.addEventListener('change', loadMeetings);
clearFiltersEl.addEventListener('click', () => {
  searchEl.value = '';
  fromEl.value = '';
  toEl.value = '';
  loadMeetings();
});

// Reenviar um áudio salvo localmente (fallback quando a transcrição falhou no
// fim da reunião). Transcreve no servidor e cria a reunião.
const resendBtn = document.getElementById('resend-btn');
const resendFile = document.getElementById('resend-file');
resendBtn.addEventListener('click', () => resendFile.click());
resendFile.addEventListener('change', async () => {
  const file = resendFile.files[0];
  if (!file) return;
  const label = resendBtn.innerHTML;
  resendBtn.disabled = true;
  resendBtn.textContent = '⏳ Enviando áudio…';
  try {
    const durationMs = await readMediaDurationMs(file);
    const fd = new FormData();
    fd.append('mixed', file, file.name);
    fd.append('title', file.name.replace(/\.[^.]+$/, '') || 'Áudio reenviado');
    fd.append('durationMs', String(durationMs || 0));
    const res = await api('/api/meetings/finalize', { method: 'POST', body: fd });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      let detail = `Servidor respondeu ${res.status}`;
      try { const e = await res.json(); if (e && e.error) detail = e.error; } catch (_) {}
      throw new Error(detail);
    }
    const m = await res.json();
    await loadMeetings();
    openMeeting(m.id);
  } catch (err) {
    alert(`Falha ao reenviar o áudio: ${err.message}`);
  } finally {
    resendBtn.disabled = false;
    resendBtn.innerHTML = label;
    resendFile.value = '';
  }
});

// Monta o menu de vendedores (admin).
async function populateOwners() {
  const res = await api('/api/users');
  if (!res.ok) return;
  const users = await res.json();
  ownerFilterEl.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos os vendedores';
  ownerFilterEl.appendChild(all);
  for (const u of users) {
    const o = document.createElement('option');
    o.value = u.id;
    o.textContent = u.name + (u.admin ? ' (admin)' : '');
    ownerFilterEl.appendChild(o);
  }
  ownerWrapEl.classList.remove('hidden');
}

async function start() {
  // Link público: abre a view de leitura e ignora o fluxo autenticado.
  const shareToken = new URLSearchParams(location.search).get('share');
  if (shareToken) return renderSharePage(shareToken);

  const meRes = await api('/api/me');
  if (meRes.status === 401) return showLogin();
  const me = await meRes.json();
  isAdmin = Boolean(me.user && me.user.admin);
  if (me.authEnabled && me.user) renderUserbar(me.user);
  if (isAdmin) await populateOwners();
  await loadMeetings();
  const id = new URLSearchParams(location.search).get('id');
  if (id) openMeeting(id);
}

start();
