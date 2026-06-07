// Configuração compartilhada da extensão.
export const DEFAULTS = {
  // URL do backend (proxy da OpenAI). Pode ser alterada no popup.
  backendUrl: 'http://localhost:3000',
  // Tamanho de cada bloco de transcrição, em milissegundos.
  chunkMs: 20000,
  // Como o seu canal (microfone) aparece na transcrição.
  userName: 'Você',
  // Nome para o canal da aba (demais participantes da reunião).
  othersName: 'Participantes',
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
