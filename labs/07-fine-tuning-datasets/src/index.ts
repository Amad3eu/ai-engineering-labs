// Lab 07: Datasets de Fine-Tuning
//
//   1. Limpar o dado bruto (clean.ts): validar, normalizar, remover PII, deduplicar.
//   2. Separar treino e validação e gravar os JSONL no formato de chat.
//   3. Teste A/B: dois modelos no mesmo conjunto de validação.
//
// O laboratório NÃO dispara o treino: isso custa dinheiro e depende do provedor. Os JSONL
// saem prontos para envio; o README mostra o passo seguinte.
//
// Rodar: pnpm --filter @labs/07-fine-tuning-datasets dev
// Comparar um modelo ajustado: AB_MODEL_B=<id do modelo ajustado> pnpm --filter ... dev

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeProviders, generateText, type ModelTier } from '@labs/shared-llm';
import { resetLlmMetrics, summarizeLlmCalls } from '@labs/shared-observability';
import { z } from 'zod';
import { cleanDataset, type Example, Label, splitDataset, toChatJsonl, validateChatJsonl } from './clean.js';
import { installMockScript } from './mock.js';
import { CLASSIFIER_SYSTEM } from './prompts.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'out');

// --- 1. Limpeza --------------------------------------------------------------------------
// PONTO DE EXTENSÃO: troque o arquivo pela exportação real dos seus tickets.
const records = z.array(z.unknown()).parse(JSON.parse(await readFile(join(ROOT, 'data/raw-tickets.json'), 'utf8')));
const { kept, dropped } = cleanDataset(records);

console.log(`Provedores ativos: ${activeProviders().join(' → ')}\n`);
console.log('Limpeza:');
console.table([{ 'registros brutos': records.length, aproveitados: kept.length, ...dropped }]);

// --- 2. Divisão e JSONL ------------------------------------------------------------------
const { train, validation } = splitDataset(kept);
await mkdir(OUT_DIR, { recursive: true });

for (const [name, examples] of Object.entries({ train, validation })) {
  const file = join(OUT_DIR, `${name}.jsonl`);
  await writeFile(file, toChatJsonl(examples, CLASSIFIER_SYSTEM));
  // Relê do disco e valida: o que vai para o provedor é o arquivo, não o array em memória.
  console.log(`${file}: ${validateChatJsonl(await readFile(file, 'utf8'))} exemplos válidos`);
}

// --- 3. Teste A/B --------------------------------------------------------------------------
// Por padrão compara a faixa barata com a intermediária. Depois do treino, aponte um dos
// braços para o modelo ajustado e veja se ele alcança o modelo maior custando menos.
interface Arm {
  name: string;
  tier: ModelTier;
  /** Id exato de modelo. Quando definido, tem prioridade sobre a faixa. */
  model?: string;
}
const arms: Arm[] = [
  { name: 'A', tier: 'fast', model: process.env.AB_MODEL_A || undefined },
  { name: 'B', tier: 'balanced', model: process.env.AB_MODEL_B || undefined },
];

async function evaluate(arm: Arm, examples: Example[]) {
  resetLlmMetrics();
  let correct = 0;
  let invalid = 0;
  let model = '';

  for (const example of examples) {
    // Texto livre, e não generateObject: o modelo ajustado aprende a responder só com o
    // rótulo, e é nesse formato que os dois braços têm que ser medidos.
    const result = await generateText({
      system: CLASSIFIER_SYSTEM,
      prompt: example.text,
      tier: arm.tier,
      model: arm.model,
      label: `ab:${arm.name}`,
    });
    model = result.model;

    // Resposta fora das quatro categorias conta à parte: obedecer ao formato é uma métrica.
    const predicted = Label.safeParse(result.text.trim().toLowerCase());
    if (!predicted.success) invalid++;
    else if (predicted.data === example.label) correct++;
  }

  const usage = summarizeLlmCalls();
  return {
    braço: arm.name,
    modelo: model,
    acurácia: (correct / examples.length).toFixed(2),
    'fora do formato': invalid,
    'latência média (ms)': Math.round(usage.avgLatencyMs),
    'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
  };
}

console.log(`\nTeste A/B em ${validation.length} exemplos de validação:`);
const results = [];
for (const arm of arms) results.push(await evaluate(arm, validation));

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
console.table(results);

if (activeProviders().includes('mock')) {
  console.log(
    'Modo mock: os dois braços usam o mesmo roteiro. Configure uma chave no .env para comparar modelos de verdade.',
  );
}
// shortcut: com poucos exemplos de validação, um acerto a mais muda a acurácia em vários
// pontos. Para decidir entre modelos, use centenas de exemplos e olhe o intervalo de confiança.
