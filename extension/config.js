// Configuração compartilhada da extensão.
export const DEFAULTS = {
  // URL do backend em produção (Render). Os vendedores não precisam configurar
  // nada — já vem apontando pra cá. Pode ser trocada no popup se necessário.
  backendUrl: 'https://evaflies-backend-ao6m.onrender.com',
  // Tamanho de cada bloco de transcrição, em milissegundos.
  chunkMs: 20000,
  // Como o seu canal (microfone) aparece na transcrição.
  userName: 'Você',
  // Nome para o canal da aba (demais participantes da reunião).
  othersName: 'Participantes',
  // Código de acesso do vendedor (separa as reuniões por usuário no painel).
  accessKey: '',
};

const STORAGE_KEY = 'evaflies_settings';

/** Lê as configurações salvas, mesclando com os padrões. */
export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

/** Salva (parcial) as configurações. */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
