// Lab 07: Fine-Tuning, da decisão ao teste A/B
//
//   1. Decision Framework (decision-framework.ts): prompt, RAG ou fine-tuning?
//   2. Dataset (dataset-builder.ts): limpar, dividir 80/20, gravar e validar os JSONL.
//   3. A/B (ab-eval.ts): modelo base com few-shot pesado × modelo ajustado com prompt enxuto.
//   4. A decisão para este caso de uso, com o tamanho de few-shot que o A/B mediu.
//
// O laboratório NÃO dispara o treino: custa dinheiro e depende do provedor. Sem modelo
// ajustado, o braço "fine-tuned" é simulado pelo mock ou, com provedor real, é o modelo base
// recebendo o prompt enxuto.
//
// Rodar: pnpm --filter @labs/07-fine-tuning-datasets dev
// Medir um modelo ajustado: AB_FINE_TUNED_MODEL=<id> pnpm --filter ... dev

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeProviders, DEFAULT_MODELS } from '@labs/shared-llm';
import { z } from 'zod';
import { type Arm, type ArmResult, costPerRequestUsd, evaluateArm, projectSavings, tablePrice } from './ab-eval.js';
import { buildDataset, type DatasetFile, type SplitStats, writeDataset } from './dataset-builder.js';
import { evaluateApproach, REFERENCE_SCENARIOS } from './decision-framework.js';
import { FORMAT_SLIP_EVERY, installMockScript } from './mock.js';
import { fewShotSystem, TRIAGE_SYSTEM } from './prompts.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'out');
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

console.log(`Provedores ativos: ${activeProviders().join(' → ')}\n`);

// --- 1. Decision Framework ------------------------------------------------------------------
console.log('1. Decision Framework: um caso de referência por abordagem');
console.table(
  REFERENCE_SCENARIOS.map(({ name, criteria }) => ({
    caso: name,
    'dado muda': criteria.dataChangeFrequency,
    'exige fonte': criteria.needsSourceTraceability ? 'sim' : 'não',
    formato: criteria.styleComplexity,
    'few-shot (tokens)': criteria.avgFewShotPromptTokens,
    meta: criteria.latencyCostTarget,
    recomendação: evaluateApproach(criteria).approach,
  })),
);

// --- 2. Dataset -----------------------------------------------------------------------------
// PONTO DE EXTENSÃO: troque o arquivo pela exportação real dos seus tickets.
const records = z.array(z.unknown()).parse(JSON.parse(await readFile(join(ROOT, 'data/raw-tickets.json'), 'utf8')));
const dataset = buildDataset(records, TRIAGE_SYSTEM);
const { report } = dataset;
const kept = report.train.examples + report.validation.examples;

console.log('\n2. Dataset: limpeza, divisão 80/20 e JSONL de chat');
console.table([{ 'registros brutos': report.raw, aproveitados: kept, ...report.dropped }]);

const splits: Array<[DatasetFile, SplitStats]> = [
  ['train.jsonl', report.train],
  ['val.jsonl', report.validation],
];
console.table(
  Object.fromEntries(
    splits.map(([file, stats]) => [
      file,
      {
        exemplos: stats.examples,
        '% do total': percent(stats.examples / kept),
        'tokens estimados': stats.estimatedTokens,
        ...stats.byCategory,
      },
    ]),
  ),
);

if (report.alerts.length === 0) console.log('Nenhum alerta de qualidade.');
for (const alert of report.alerts) console.log(`[${alert.level === 'error' ? 'ERRO' : 'AVISO'}] ${alert.message}`);
// Alerta de nível `error` quer dizer: não envie este dataset. O script termina com código 1.
if (report.alerts.some((alert) => alert.level === 'error')) process.exitCode = 1;

const valid = await writeDataset(dataset, OUT_DIR);
console.log(
  `Gravados e relidos de ${OUT_DIR}: train.jsonl com ${valid['train.jsonl']} linhas válidas, val.jsonl com ${valid['val.jsonl']}.`,
);

// --- 3. Teste A/B -----------------------------------------------------------------------------
// Os dois braços partem do mesmo modelo base, para a diferença medida ser só a do prompt.
const baseModel = process.env.AB_BASE_MODEL || undefined;
const fineTunedModel = process.env.AB_FINE_TUNED_MODEL || undefined;

const fewShotArm: Arm = {
  name: 'few-shot',
  // Os exemplos do prompt saem do TREINO, nunca da validação.
  // PONTO DE EXTENSÃO: com dataset grande o treino inteiro não cabe no prompt. Passe uma
  // amostra por categoria.
  system: fewShotSystem(dataset.train),
  tier: 'fast',
  model: baseModel,
};
const fineTunedArm: Arm = {
  name: 'fine-tuned',
  system: TRIAGE_SYSTEM,
  tier: 'fast',
  model: fineTunedModel ?? baseModel,
};

console.log(`\n3. Teste A/B em ${dataset.validation.length} tickets de validação`);
const fewShot = await evaluateArm(fewShotArm, dataset.validation);
const fineTuned = await evaluateArm(fineTunedArm, dataset.validation);

const adherent = (result: ArmResult) => Math.round(result.schemaAdherence * result.requests);
console.table(
  [fewShot, fineTuned].map((result) => ({
    braço: result.arm,
    modelo: result.model,
    'aderência ao schema': `${percent(result.schemaAdherence)} (${adherent(result)}/${result.requests})`,
    acerto: percent(result.accuracy),
    'tokens in/out por requisição': `${Math.round(result.avgTokensIn)}/${Math.round(result.avgTokensOut)}`,
    'latência média (ms)': Math.round(result.avgLatencyMs),
  })),
);

// Premissas da projeção. PONTO DE EXTENSÃO: troque pelas do seu caso.
const PROJECTED_REQUESTS = 100_000;
// Na tabela de preços da OpenAI (consultada em 19/11/2026), o token de um modelo pequeno
// ajustado custa 2× o do modelo base (gpt-4.1-mini, gpt-4o-mini). Nos modelos grandes, 1,5×.
const FINE_TUNED_PRICE_MULTIPLIER = 2;

// O mock não tem preço. A projeção usa como referência o preço de tabela do modelo `fast`
// da OpenAI; com provedor real, o do modelo que o braço few-shot usou.
const mocked = fewShot.provider === 'mock';
const priceModel = mocked ? DEFAULT_MODELS.openai.fast : fewShot.model;
const basePrice = tablePrice(mocked ? 'openai' : fewShot.provider, priceModel);
const tunedPrice = {
  inputPerMillion: basePrice.inputPerMillion * FINE_TUNED_PRICE_MULTIPLIER,
  outputPerMillion: basePrice.outputPerMillion * FINE_TUNED_PRICE_MULTIPLIER,
};
const fewShotCost = costPerRequestUsd(fewShot, basePrice);
const fineTunedCost = costPerRequestUsd(fineTuned, tunedPrice);
const projection = projectSavings(fewShotCost, fineTunedCost, PROJECTED_REQUESTS);

const volume = PROJECTED_REQUESTS.toLocaleString('pt-BR');
console.log(`\nProjeção para ${volume} requisições, a preço de tabela de ${priceModel}:`);
console.table([
  {
    braço: 'few-shot',
    'USD por milhão (in/out)': `${basePrice.inputPerMillion}/${basePrice.outputPerMillion}`,
    'USD por requisição': fewShotCost.toFixed(6),
    [`USD em ${volume}`]: projection.baselineCostUsd.toFixed(2),
  },
  {
    braço: `fine-tuned (${FINE_TUNED_PRICE_MULTIPLIER}× o preço do base)`,
    'USD por milhão (in/out)': `${tunedPrice.inputPerMillion}/${tunedPrice.outputPerMillion}`,
    'USD por requisição': fineTunedCost.toFixed(6),
    [`USD em ${volume}`]: projection.candidateCostUsd.toFixed(2),
  },
]);
console.log(
  `Economia projetada: US$ ${projection.savingsUsd.toFixed(2)} (${projection.savingsPercent.toFixed(0)}%). ` +
    'Não inclui o custo fixo do treino nem o desconto de cache de prompt: veja o README.',
);

if (mocked) {
  console.log(
    'Modo mock: o braço fine-tuned é um modelo ajustado SIMULADO, e o deslize de formato do few-shot é roteiro ' +
      `(1 a cada ${FORMAT_SLIP_EVERY} respostas). Os tokens saem do tamanho real dos prompts; aderência e acerto só valem com provedor real.`,
  );
} else if (!fineTunedModel) {
  console.log(
    'Sem AB_FINE_TUNED_MODEL, o braço fine-tuned é o modelo base com o prompt enxuto: mostra o que o prompt curto ' +
      'entrega ANTES do treino. Os tokens e a projeção valem para depois dele.',
  );
}

// --- 4. A decisão para este caso de uso -------------------------------------------------------
const decision = evaluateApproach({
  dataChangeFrequency: 'static', // categorias e regras de prioridade quase não mudam
  needsSourceTraceability: false, // a triagem não cita documento
  styleComplexity: 'medium', // JSON estrito, mas com dois campos só
  avgFewShotPromptTokens: Math.round(fewShot.avgTokensIn), // medido agora, no braço few-shot
  latencyCostTarget: 'strict', // a triagem roda em todo ticket que chega
});

console.log(`\n4. Decisão para a triagem de tickets: ${decision.approach}`);
for (const reason of decision.justification) console.log(`   · ${reason}`);
console.log('   Trade-offs:');
for (const tradeOff of decision.tradeOffs) console.log(`   · ${tradeOff}`);
