// Lab 07: Fine-Tuning, da decisão ao retorno do investimento
//
//   1. Decision Framework (decision-framework.ts): prompt, RAG ou fine-tuning?
//   2. Dataset (dataset-builder.ts): mascarar PII (pii-sanitizer.ts), tirar duplicatas e quase
//      duplicatas, dividir 80/20, gravar e validar os JSONL.
//   3. A/B (ab-eval.ts): modelo base com few-shot pesado × modelo ajustado com prompt enxuto.
//   4. A decisão para este caso de uso, com o tamanho de few-shot que o A/B mediu.
//   5. Plano de treino (lora-config.ts): rank, alpha, épocas e o método que cabe na GPU.
//   6. Checkpoints (model-eval-harness.ts): overfitting, catastrophic forgetting e qual época
//      vai para produção.
//   7. Payback (financial-npv.ts): fluxo líquido mensal, break-even e NPV em 12 meses.
//
// O laboratório NÃO dispara o treino: custa dinheiro e depende do provedor ou de uma GPU. Sem
// modelo ajustado, o braço "fine-tuned" é simulado pelo mock ou, com provedor real, é o modelo
// base recebendo o prompt enxuto. As métricas de checkpoint do passo 6 são um roteiro.
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
import { calculateFineTuningPayback, NPV_HORIZON_MONTHS } from './financial-npv.js';
import { buildLoraTrainingPlan } from './lora-config.js';
import { FORMAT_SLIP_EVERY, installMockScript } from './mock.js';
import { CheckpointMetric, evaluateTrainingCheckpoints, QUALITY_GATES } from './model-eval-harness.js';
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

console.log('\n2. Dataset: gate de PII, deduplicação, divisão 80/20 e JSONL de chat');
console.table([{ 'registros brutos': report.raw, aproveitados: kept, ...report.dropped }]);
const masked = Object.entries(report.piiRedactions).map(([type, count]) => `${count} <${type}>`);
console.log(`PII mascarada pelo gate, antes de o texto entrar no dataset: ${masked.join(', ')}.`);

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

// --- 5. Plano de treino LoRA / QLoRA ----------------------------------------------------------
// PONTO DE EXTENSÃO: o tamanho do modelo aberto que você vai ajustar e as GPUs que tem à mão.
const BASE_PARAMS_BILLIONS = 8;
const planFor = (availableVramGb: number) =>
  buildLoraTrainingPlan({
    baseParamsBillions: BASE_PARAMS_BILLIONS,
    datasetSize: dataset.train.length, // as linhas do train.jsonl do passo 2
    taskComplexity: 'format-style', // a triagem ensina formato, não raciocínio de domínio
    availableVramGb,
  });
const plans = { 'GPU de 16 GB': planFor(16), 'GPU de 24 GB': planFor(24) };
// Rank, alpha, learning rate e épocas saem da tarefa e do dataset, não da GPU: valem para as duas.
const hyperparams = plans['GPU de 16 GB'];

console.log(
  `\n5. Plano de treino LoRA / QLoRA: modelo base de ${BASE_PARAMS_BILLIONS} bilhões de parâmetros, ${dataset.train.length} exemplos de treino`,
);
console.table([
  {
    'rank (r)': hyperparams.r,
    'lora alpha': hyperparams.loraAlpha,
    'learning rate': hyperparams.learningRate.toExponential(),
    épocas: hyperparams.epochs,
    'parâmetros treináveis': `~${hyperparams.trainableParamsPercent}% (~${hyperparams.trainableParamsMillions} milhões)`,
  },
]);
console.table(
  Object.fromEntries(
    Object.entries(plans).map(([gpu, plan]) => [
      gpu,
      {
        'VRAM LoRA 16-bit (GB)': plan.estimatedVramGb.lora,
        'VRAM QLoRA 4-bit (GB)': plan.estimatedVramGb.qlora,
        recomendação: plan.recommendedMethod,
      },
    ]),
  ),
);
for (const alert of hyperparams.alerts) console.log(`[AVISO] ${alert.message}`);
console.log(
  'A VRAM é estimativa de piso: pesos carregados mais uma folga. Ativações de batch grande não entram: veja o README.',
);

// --- 6. Avaliação de checkpoints --------------------------------------------------------------
// PONTO DE EXTENSÃO: troque o arquivo pelas métricas do seu treino, uma linha por época.
const checkpoints = z
  .array(CheckpointMetric)
  .parse(JSON.parse(await readFile(join(ROOT, 'data/simulated-checkpoints.json'), 'utf8')));
const harness = evaluateTrainingCheckpoints(checkpoints);

const OVERFITTING = { none: 'não', mild: 'leve', severe: 'SEVERO' };
console.log(
  `\n6. Avaliação de checkpoints: overfitting e catastrophic forgetting (modelo base no raciocínio geral: ${percent(harness.baselineGeneralAccuracy)})`,
);
console.table(
  harness.checkpoints.map((verdict) => {
    // Raciocínio geral em relação ao modelo base, em pontos de acurácia.
    const delta = Math.round(-verdict.generalAccuracyDrop * 100);
    return {
      época: verdict.epoch,
      trainLoss: verdict.trainLoss,
      valLoss: verdict.valLoss,
      overfitting:
        verdict.overfitting === 'none'
          ? OVERFITTING.none
          : `${OVERFITTING[verdict.overfitting]} (+${percent(verdict.valLossRise)})`,
      'acurácia de domínio': percent(verdict.domainSchemaAccuracy),
      'raciocínio geral': `${percent(verdict.generalReasoningAccuracy)} (${delta > 0 ? '+' : ''}${delta} pts)`,
      forgetting: verdict.catastrophicForgetting ? 'SIM' : 'não',
      gate: verdict.passesGates ? 'passa' : 'REPROVADO',
    };
  }),
);
console.log(
  `Gates: overfitting severo reprova (valLoss mais de ${percent(QUALITY_GATES.severeValLossRise)} acima do melhor valLoss já visto: é a % entre parênteses), ` +
    `e catastrophic forgetting reprova (raciocínio geral mais de ${Math.round(QUALITY_GATES.maxGeneralAccuracyDrop * 100)} pontos abaixo do modelo base).`,
);
for (const alert of harness.alerts)
  console.log(`[${alert.level === 'critical' ? 'CRÍTICO' : 'AVISO'}] ${alert.message}`);
console.log(`Decisão: ${harness.decision === 'promote' ? 'promover' : 'REJEITAR o treino'}. ${harness.reason}`);
// Rejeitar quer dizer: nenhum checkpoint vai para produção. O script termina com código 1.
if (harness.decision === 'reject') process.exitCode = 1;
console.log(
  'Métricas simuladas (data/simulated-checkpoints.json): nenhum treino rodou. Troque o arquivo pelas métricas do seu treino.',
);

// --- 7. Payback e NPV em 12 meses -------------------------------------------------------------
// Premissas. PONTO DE EXTENSÃO: troque pelas do seu caso.
// 80 horas de engenharia a US$ 50: curadoria do dataset, treino e avaliação.
const CAPEX_ENGINEERING_USD = 4_000;
// Teto da faixa de preço de treino da tabela da OpenAI (US$ 3 a US$ 25 por milhão de tokens),
// consultada em 19/11/2026. O treino cobra os tokens do train.jsonl uma vez por época.
const TRAINING_USD_PER_MILLION_TOKENS = 25;
const trainingJobUsd =
  (report.train.estimatedTokens * hyperparams.epochs * TRAINING_USD_PER_MILLION_TOKENS) / 1_000_000;

const paybackFor = (monthlyRequests: number) =>
  calculateFineTuningPayback({
    capexEngineeringUsd: CAPEX_ENGINEERING_USD,
    trainingJobUsd,
    monthlyRequests,
    // Os dois custos por requisição saem do A/B do passo 3.
    baselineCostPerReqUsd: fewShotCost,
    fineTunedCostPerReqUsd: fineTunedCost,
    // Modelo ajustado cobrado por token, como no passo 3. Em GPU própria, é este custo que sobe.
    monthlyHostingUsd: 0,
  });
const paybacks = {
  '100 mil requisições por mês': paybackFor(100_000),
  '10 milhões de requisições por mês': paybackFor(10_000_000),
};

console.log(`\n7. Payback e NPV em ${NPV_HORIZON_MONTHS} meses: o investimento volta?`);
console.table(
  Object.fromEntries(
    Object.entries(paybacks).map(([volume, payback]) => [
      volume,
      {
        'investimento (USD)': payback.initialInvestmentUsd.toFixed(2),
        'fluxo líquido mensal (USD)': payback.monthlyNetFlowUsd.toFixed(2),
        'break-even (meses)': payback.breakEvenMonths === null ? 'nunca' : payback.breakEvenMonths.toFixed(1),
        [`NPV em ${NPV_HORIZON_MONTHS} meses (USD)`]: payback.npv12MonthsUsd.toFixed(2),
      },
    ]),
  ),
);
console.log(
  `Premissas: US$ ${CAPEX_ENGINEERING_USD} de engenharia; job de treino de US$ ${trainingJobUsd.toFixed(2)} ` +
    `(${report.train.estimatedTokens} tokens × ${hyperparams.epochs} épocas a US$ ${TRAINING_USD_PER_MILLION_TOKENS} por milhão); ` +
    `sem custo fixo de hospedagem; desconto de ${percent(paybacks['100 mil requisições por mês'].monthlyDiscountRate)} ao mês. ` +
    'Os custos por requisição são os do passo 3.',
);
