// Lab 04: Arquiteturas de Agente com LangGraph
//
// Três padrões, cada um em um arquivo, com o mesmo formato: estado, nós, arestas.
//   react.ts         o modelo decide o próximo passo a cada volta
//   plan-execute.ts  o modelo planeja tudo antes; um modelo barato executa
//   reflection.ts    um nó escreve, outro critica, até passar na rubrica
//
// O LangGraph cuida do fluxo (estado, laços, limites). As chamadas ao modelo passam por
// @labs/shared-llm, então fallback, validação com Zod e métricas valem aqui também.
//
// Rodar todos:  pnpm --filter @labs/04-agent-architectures dev
// Rodar um só:  pnpm --filter @labs/04-agent-architectures dev react | plan | reflection

import { activeProviders } from '@labs/shared-llm';
import { resetLlmMetrics, summarizeLlmCalls } from '@labs/shared-observability';
import { installMockScript } from './mock.js';
import { runPlanExecute } from './plan-execute.js';
import { runReact } from './react.js';
import { runReflection } from './reflection.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

// PONTO DE EXTENSÃO: troque as entradas para ver cada padrão se comportar com outro problema.
const PATTERNS = {
  react: async () => {
    const { answer, steps } = await runReact('Quem é o dono do serviço checkout e quanto ele custa por ano?');
    console.log(steps.join('\n'));
    console.log('Resposta:', answer);
  },
  plan: async () => {
    const { plan, results, answer } = await runPlanExecute(
      'Encontrar o serviço mais caro do catálogo e propor uma ação de redução de custo.',
    );
    console.log('Plano:', plan);
    console.log(results.join('\n'));
    console.log('Resposta:', answer);
  },
  reflection: async () => {
    const { draft, approved, rounds, lastFeedback } = await runReflection(
      'Comunicar à diretoria o incidente de hoje no checkout: 40 minutos fora do ar, causado por limite de memória baixo no deploy das 14h.',
    );
    console.log(`Rodadas: ${rounds} · aprovado: ${approved}${approved ? '' : ` · crítica pendente: ${lastFeedback}`}`);
    console.log('Texto final:', draft);
  },
};

const selected = process.argv[2];
if (selected && !(selected in PATTERNS)) {
  console.error(`Padrão desconhecido: "${selected}". Use: ${Object.keys(PATTERNS).join(', ')}.`);
  process.exit(1);
}

console.log(`Provedores ativos: ${activeProviders().join(' → ')}`);
const summary = [];

for (const [name, run] of Object.entries(PATTERNS)) {
  if (selected && selected !== name) continue;
  console.log(`\n=== ${name} ===`);
  resetLlmMetrics();
  await run();

  const usage = summarizeLlmCalls();
  summary.push({
    padrão: name,
    'chamadas ao LLM': usage.calls,
    'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
    'latência total (ms)': Math.round(usage.avgLatencyMs * usage.calls),
    'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
  });
}

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
console.log('\nComparativo:');
console.table(summary);
