// Servidor MCP do EvaFlies: deixa o Claude ler as transcrições e disparar
// transcrições pendentes.
//
// Roda dentro do próprio backend, então conversa direto com o store — sem dar
// a volta pela API HTTP. As permissões NÃO são reimplementadas aqui: cada
// ferramenta recebe o mesmo filtro de dono que a API REST usa (ownerFilterFor),
// derivado da chave de acesso de quem conectou. Admin enxerga tudo, supervisor
// só os vendedores, vendedor só as próprias reuniões.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listMeetings, getMeeting } from './store.js';
import { getJob, startTranscription } from './transcribe-jobs.js';

// Transcrição de reunião longa é muito texto: mandar tudo de uma vez estoura o
// contexto do modelo. Entregamos em pedaços, com aviso de que há continuação.
const CHARS_POR_TRECHO = 12000;
const CONTEXTO_BUSCA = 300; // caracteres ao redor de cada ocorrência

const fmtDur = (ms) => {
  const min = Math.round((ms || 0) / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}min`;
};
const fmtData = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const texto = (s) => ({ content: [{ type: 'text', text: s }] });

// Transcrição de uma reunião: usa os segmentos (com locutor) quando existirem.
function transcricaoDe(m) {
  if (m.segments && m.segments.length) {
    return m.segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n');
  }
  return m.transcript || '';
}

/**
 * Cria o servidor MCP já amarrado às permissões de um usuário.
 * @param {object|null} user req.user (null quando a auth está desligada)
 * @param {any} ownerFilter filtro de dono desse usuário (string, array ou null)
 */
export function createMcpServer(user, ownerFilter) {
  const server = new McpServer({ name: 'evaflies', version: '1.0.0' });

  // Busca uma reunião respeitando o que este usuário pode ver.
  const buscarReuniao = (id) => getMeeting(id, ownerFilter);

  server.registerTool(
    'listar_reunioes',
    {
      title: 'Listar reuniões',
      description:
        'Lista as reuniões gravadas (mais recentes primeiro), com data, duração, vendedor ' +
        'e se já foram transcritas. Use para achar o id de uma reunião antes de ler o ' +
        'conteúdo. Filtros opcionais por texto, período e vendedor.',
      inputSchema: {
        busca: z.string().optional().describe('Filtra por texto no título ou na transcrição'),
        de: z.string().optional().describe('Data inicial, formato AAAA-MM-DD'),
        ate: z.string().optional().describe('Data final, formato AAAA-MM-DD'),
        vendedor: z.string().optional().describe('Nome do vendedor dono das reuniões'),
        limite: z.number().int().min(1).max(100).optional().describe('Máximo de reuniões (padrão 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ busca, de, ate, vendedor, limite }) => {
      // Um vendedor pedindo ?vendedor=outro não escapa do próprio filtro: o
      // ownerFilter continua valendo por baixo.
      let filtro = ownerFilter;
      if (vendedor) {
        if (Array.isArray(ownerFilter)) {
          filtro = ownerFilter.includes(vendedor) ? vendedor : ownerFilter;
        } else if (!ownerFilter) {
          filtro = vendedor;
        }
      }
      const lista = await listMeetings(filtro, { q: busca, from: de, to: ate });
      const top = lista.slice(0, limite || 20);
      if (!top.length) return texto('Nenhuma reunião encontrada com esses filtros.');

      const linhas = top.map((m) => {
        const estado = m.transcriptPreview ? 'transcrita' : 'SEM TRANSCRIÇÃO';
        const dono = m.owner ? ` | ${m.owner}` : '';
        return `- ${m.title} | ${fmtData(m.createdAt)} | ${fmtDur(m.durationMs)}${dono} | ${estado}\n  id: ${m.id}`;
      });
      const rodape = lista.length > top.length ? `\n\n(${lista.length - top.length} outras não listadas)` : '';
      return texto(`${top.length} reunião(ões):\n\n${linhas.join('\n')}${rodape}`);
    }
  );

  server.registerTool(
    'ler_reuniao',
    {
      title: 'Ler transcrição de uma reunião',
      description:
        'Devolve o resumo e a transcrição completa de uma reunião. Transcrições longas ' +
        'vêm em partes: use o parâmetro "parte" para pedir a continuação.',
      inputSchema: {
        id: z.string().describe('Id da reunião (obtido em listar_reunioes)'),
        parte: z.number().int().min(1).optional().describe('Parte da transcrição (padrão 1)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, parte }) => {
      const m = await buscarReuniao(id);
      if (!m) return texto('Reunião não encontrada (ou fora do seu acesso).');

      const t = transcricaoDe(m);
      const cabecalho =
        `# ${m.title}\n` +
        `Data: ${fmtData(m.createdAt)} | Duração: ${fmtDur(m.durationMs)}` +
        (m.owner ? ` | Vendedor: ${m.owner}` : '');

      if (!t.trim()) {
        return texto(
          `${cabecalho}\n\nEsta reunião ainda NÃO foi transcrita.` +
          (m.audioId
            ? '\nUse a ferramenta transcrever_reuniao para gerar a transcrição.'
            : '\nEla também não tem áudio, então não há o que transcrever.')
        );
      }

      let resumo = '';
      if (m.summary) {
        const s = m.summary;
        resumo = '\n\n## Resumo\n' + (typeof s === 'string' ? s : JSON.stringify(s, null, 2));
      }

      const total = Math.max(1, Math.ceil(t.length / CHARS_POR_TRECHO));
      const p = Math.min(Math.max(parte || 1, 1), total);
      const pedaco = t.slice((p - 1) * CHARS_POR_TRECHO, p * CHARS_POR_TRECHO);
      const nav = total > 1 ? `\n\n(parte ${p} de ${total}${p < total ? ` — peça a parte ${p + 1} para continuar` : ''})` : '';

      return texto(`${cabecalho}${resumo}\n\n## Transcrição\n${pedaco}${nav}`);
    }
  );

  server.registerTool(
    'buscar_nas_transcricoes',
    {
      title: 'Buscar nas transcrições',
      description:
        'Procura um termo dentro das transcrições e devolve os trechos onde ele aparece, ' +
        'com o contexto ao redor. Bom para perguntas como "onde falaram de preço?" ou ' +
        '"quais objeções apareceram?".',
      inputSchema: {
        termo: z.string().describe('Palavra ou expressão a procurar'),
        vendedor: z.string().optional().describe('Restringe a um vendedor'),
        limite: z.number().int().min(1).max(50).optional().describe('Máximo de reuniões (padrão 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ termo, vendedor, limite }) => {
      let filtro = ownerFilter;
      if (vendedor) {
        if (Array.isArray(ownerFilter)) {
          filtro = ownerFilter.includes(vendedor) ? vendedor : ownerFilter;
        } else if (!ownerFilter) {
          filtro = vendedor;
        }
      }
      // listMeetings já filtra por texto no servidor; depois recortamos os trechos.
      const achadas = await listMeetings(filtro, { q: termo });
      if (!achadas.length) return texto(`Nenhuma reunião menciona "${termo}".`);

      const alvo = termo.toLowerCase();
      const blocos = [];
      for (const item of achadas.slice(0, limite || 10)) {
        const m = await buscarReuniao(item.id);
        if (!m) continue;
        const t = transcricaoDe(m);
        const baixo = t.toLowerCase();

        const trechos = [];
        let i = baixo.indexOf(alvo);
        while (i !== -1 && trechos.length < 3) {
          const ini = Math.max(0, i - CONTEXTO_BUSCA / 2);
          const fim = Math.min(t.length, i + alvo.length + CONTEXTO_BUSCA / 2);
          trechos.push(`…${t.slice(ini, fim).trim()}…`);
          i = baixo.indexOf(alvo, i + alvo.length);
        }
        if (!trechos.length) continue; // casou só no título
        const dono = m.owner ? ` | ${m.owner}` : '';
        blocos.push(`### ${m.title} (${fmtData(m.createdAt)}${dono})\nid: ${m.id}\n${trechos.join('\n')}`);
      }

      if (!blocos.length) return texto(`"${termo}" aparece só em títulos, não no conteúdo das transcrições.`);
      return texto(`Trechos com "${termo}":\n\n${blocos.join('\n\n')}`);
    }
  );

  server.registerTool(
    'transcrever_reuniao',
    {
      title: 'Transcrever uma reunião',
      description:
        'Dispara a transcrição de uma reunião que ainda não foi transcrita — o mesmo que ' +
        'apertar "Transcrever" no painel. Roda em segundo plano; acompanhe com ' +
        'status_transcricao. Reuniões longas levam vários minutos.',
      inputSchema: {
        id: z.string().describe('Id da reunião (obtido em listar_reunioes)'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const m = await buscarReuniao(id);
      if (!m) return texto('Reunião não encontrada (ou fora do seu acesso).');
      if (m.segments && m.segments.length) {
        return texto(`"${m.title}" já está transcrita — use ler_reuniao para ver o conteúdo.`);
      }
      if (!m.audioId) return texto(`"${m.title}" não tem áudio, então não há o que transcrever.`);

      const job = startTranscription(m);
      const jaRodava = job.current > 0 || job.total > 0;
      return texto(
        `Transcrição de "${m.title}" ${jaRodava ? 'já estava em andamento' : 'iniciada'}. ` +
        `Ela roda em segundo plano — consulte status_transcricao com o id ${m.id} daqui a alguns minutos.`
      );
    }
  );

  server.registerTool(
    'status_transcricao',
    {
      title: 'Status da transcrição',
      description: 'Diz se a transcrição de uma reunião está pronta, rodando (com progresso) ou se falhou.',
      inputSchema: {
        id: z.string().describe('Id da reunião'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const m = await buscarReuniao(id);
      if (!m) return texto('Reunião não encontrada (ou fora do seu acesso).');
      if (m.segments && m.segments.length) return texto(`"${m.title}": transcrição pronta.`);

      const job = getJob(id);
      if (!job) {
        return texto(
          `"${m.title}": sem transcrição e sem job rodando. ` +
          'Use transcrever_reuniao para começar.'
        );
      }
      if (job.state === 'error') return texto(`"${m.title}": a transcrição falhou — ${job.error}`);
      // current = blocos CONCLUÍDOS, então o bloco em andamento é o seguinte
      // (mesma convenção do painel).
      const progresso = job.total > 1
        ? ` (bloco ${Math.min(job.current + 1, job.total)} de ${job.total} — reunião longa)`
        : '';
      return texto(`"${m.title}": transcrevendo${progresso}. Consulte de novo em alguns minutos.`);
    }
  );

  return server;
}
