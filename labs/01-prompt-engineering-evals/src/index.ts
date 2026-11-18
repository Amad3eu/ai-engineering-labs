// Lab 01: Prompt Engineering & Evals
//
// 1. Cadeia de prompts (chain.ts): extrair → classificar → política em código → redigir.
// 2. Saída estruturada: cada passo devolve um objeto validado por Zod.
// 3. Regressão (evals.ts + evals.test.ts): um conjunto de referência com piso de acurácia.
//
// Rodar: pnpm --filter @labs/01-prompt-engineering-evals dev

import { activeProviders } from '@labs/shared-llm';
import { resetLlmMetrics, summarizeLlmCalls } from '@labs/shared-observability';
import { triageTicket } from './chain.js';
import { runEvals, THRESHOLDS } from './evals.js';
import { installMockScript } from './mock.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

console.log(`Provedores ativos: ${activeProviders().join(' → ')}\n`);

// --- 1. Uma passada pela cadeia --------------------------------------------------------
// PONTO DE EXTENSÃO: troque o ticket e veja cada passo reagir.
const ticket =
  'Desde as 14h a API de vocês devolve erro 500 para todos os nossos clientes. Precisamos de retorno urgente.';

const { extraction, classification, reply } = await triageTicket(ticket);
console.log('Ticket:', ticket);
console.log('\nPasso 1, fatos extraídos:', extraction);
console.log('\nPassos 2 e 3, classificação com a política aplicada:', classification);
console.log('\nPasso 4, rascunho de resposta:\n', reply);

// --- 2. A suíte de regressão -----------------------------------------------------------
resetLlmMetrics();
const report = await runEvals();

console.log('\nConjunto de referência:');
console.table(report.rows);
console.table([
  {
    métrica: 'acurácia de categoria',
    valor: report.categoryAccuracy.toFixed(2),
    piso: THRESHOLDS.categoryAccuracy,
  },
  {
    métrica: 'acurácia de prioridade',
    valor: report.priorityAccuracy.toFixed(2),
    piso: THRESHOLDS.priorityAccuracy,
  },
]);

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
const usage = summarizeLlmCalls();
console.table([
  {
    chamadas: usage.calls,
    'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
    'latência média (ms)': Math.round(usage.avgLatencyMs),
    'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
  },
]);
