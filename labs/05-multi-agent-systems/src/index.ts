// Lab 05: Sistemas Multiagente com Human-in-the-Loop
//
//   supervisor.ts    um coordenador e especialistas, em um grafo só
//   hierarchical.ts  um diretor e times, cada time um grafo com estado próprio
//   hitl.ts          a pausa para aprovação humana e a retomada
//
// Nos dois padrões o trabalho só termina quando uma pessoa aprova o rascunho.
//
// Rodar os dois:  pnpm --filter @labs/05-multi-agent-systems dev
// Rodar um só:    pnpm --filter @labs/05-multi-agent-systems dev supervisor | hierarchical
// Em um terminal, a aprovação é perguntada a você. Para usar o revisor roteirizado: HITL_AUTO=1

import { randomUUID } from 'node:crypto';
import { activeProviders } from '@labs/shared-llm';
import { resetLlmMetrics, summarizeLlmCalls } from '@labs/shared-observability';
import { hierarchicalGraph } from './hierarchical.js';
import { runWithReview, scriptedReviewer, terminalReviewer } from './hitl.js';
import { installMockScript } from './mock.js';
import { supervisorGraph } from './supervisor.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

const PATTERNS = { supervisor: supervisorGraph, hierarchical: hierarchicalGraph };

const selected = process.argv[2];
if (selected && !(selected in PATTERNS)) {
  console.error(`Padrão desconhecido: "${selected}". Use: ${Object.keys(PATTERNS).join(', ')}.`);
  process.exit(1);
}

// PONTO DE EXTENSÃO: troque a tarefa. O estado e os papéis dos agentes não dependem dela.
const task =
  'Escrever o comunicado aos clientes sobre o incidente de hoje no checkout: 40 minutos fora do ar, causado por limite de memória baixo no deploy das 14h.';

const interactive = process.stdin.isTTY && !process.env.HITL_AUTO;
console.log(`Provedores ativos: ${activeProviders().join(' → ')}`);
console.log(
  `Aprovação humana: ${interactive ? 'você, no terminal' : 'revisor roteirizado (reprova a 1ª versão, aprova a 2ª)'}`,
);

const summary = [];

for (const [name, graph] of Object.entries(PATTERNS)) {
  if (selected && selected !== name) continue;
  console.log(`\n=== ${name} ===`);
  resetLlmMetrics();

  const state = await runWithReview(
    graph,
    { task },
    interactive ? terminalReviewer : scriptedReviewer(),
    randomUUID(), // cada execução é uma thread nova no checkpointer
  );

  console.log(
    state.approved ? 'Aprovado por humano. Texto final:' : 'Encerrado SEM aprovação (teto de turnos). Último rascunho:',
  );
  console.log(state.draft);

  const usage = summarizeLlmCalls();
  summary.push({
    padrão: name,
    'decisões do coordenador': state.turns,
    'chamadas ao LLM': usage.calls,
    'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
    'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
    aprovado: state.approved,
  });
}

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
console.log('\nComparativo:');
console.table(summary);
