import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALPHA_PER_RANK,
  buildLoraTrainingPlan,
  EPOCH_CUTOFFS,
  type LoraPlanInput,
  LoraTrainingPlan,
  SMALL_DATASET_EXAMPLES,
  TaskComplexity,
  VRAM_GB_PER_BILLION,
} from './lora-config.js';

// Um modelo de 8 bilhões em uma GPU de 24 GB, com dataset grande o bastante para não alertar.
const BASE: LoraPlanInput = {
  baseParamsBillions: 8,
  datasetSize: 2_000,
  taskComplexity: 'format-style',
  availableVramGb: 24,
};
const planOf = (overrides: Partial<LoraPlanInput>) => buildLoraTrainingPlan({ ...BASE, ...overrides });
const methodOf = (baseParamsBillions: number, availableVramGb: number) =>
  planOf({ baseParamsBillions, availableVramGb }).recommendedMethod;

test('hiperparâmetros: rank 8 para formato e estilo, 32 para raciocínio de domínio, alpha = 2r', () => {
  const style = planOf({ taskComplexity: 'format-style' });
  assert.deepEqual([style.r, style.loraAlpha, style.learningRate], [8, 16, 2e-4]);

  const reasoning = planOf({ taskComplexity: 'domain-reasoning' });
  assert.deepEqual([reasoning.r, reasoning.loraAlpha, reasoning.learningRate], [32, 64, 1e-4]);
});

test('parâmetros treináveis: crescem em linha reta com o rank e com o tamanho do modelo base', () => {
  const style = planOf({ taskComplexity: 'format-style' });
  assert.equal(style.trainableParamsPercent, 0.1);
  assert.equal(style.trainableParamsMillions, 8); // 0,1% de 8 bilhões

  const reasoning = planOf({ taskComplexity: 'domain-reasoning', baseParamsBillions: 14 });
  assert.equal(reasoning.trainableParamsPercent, 0.4); // 4× o rank, 4× a fração
  assert.equal(reasoning.trainableParamsMillions, 56); // 0,4% de 14 bilhões
});

test('VRAM: 2,2 GB por bilhão em LoRA de 16 bits e 0,75 em QLoRA de 4 bits', () => {
  assert.deepEqual(VRAM_GB_PER_BILLION, { lora: 2.2, qlora: 0.75 });
  assert.deepEqual(planOf({ baseParamsBillions: 7 }).estimatedVramGb, { lora: 15.4, qlora: 5.25 });
  assert.deepEqual(planOf({ baseParamsBillions: 8 }).estimatedVramGb, { lora: 17.6, qlora: 6 });
  assert.deepEqual(planOf({ baseParamsBillions: 14 }).estimatedVramGb, { lora: 30.8, qlora: 10.5 });
});

test('escolha automática: LoRA quando cabe, QLoRA quando só ela cabe, nuvem quando nenhuma cabe', () => {
  // O mesmo modelo de 8 bilhões (17,6 GB em LoRA, 6 em QLoRA) em duas GPUs.
  assert.equal(methodOf(8, 24), 'LoRA (16-bit)');
  assert.equal(methodOf(8, 16), 'QLoRA (4-bit)');

  // 14 bilhões: 30,8 GB em LoRA, 10,5 em QLoRA.
  assert.equal(methodOf(14, 48), 'LoRA (16-bit)');
  assert.equal(methodOf(14, 24), 'QLoRA (4-bit)');
  assert.equal(methodOf(14, 10), 'Cloud/Multi-GPU Required');

  // 70 bilhões nem em 4 bits cabem em 48 GB (52,5 GB).
  assert.equal(methodOf(70, 48), 'Cloud/Multi-GPU Required');
});

test('escolha automática: estimativa igual à VRAM disponível ainda cabe', () => {
  assert.equal(methodOf(14, 30.8), 'LoRA (16-bit)');
  assert.equal(methodOf(14, 30.7), 'QLoRA (4-bit)');
  assert.equal(methodOf(14, 10.5), 'QLoRA (4-bit)');
  assert.equal(methodOf(14, 10.4), 'Cloud/Multi-GPU Required');

  // 10 × 2,2 dá 22,000000000000004 em ponto flutuante: sem arredondar, 22 GB "não caberiam".
  assert.equal(methodOf(10, 22), 'LoRA (16-bit)');
});

test('épocas: menos exemplos, mais passadas, sempre entre 2 e 4', () => {
  const epochsOf = (datasetSize: number) => planOf({ datasetSize }).epochs;
  const { fourEpochsBelow, threeEpochsBelow } = EPOCH_CUTOFFS;

  assert.equal(epochsOf(1), 4);
  assert.equal(epochsOf(fourEpochsBelow - 1), 4);
  assert.equal(epochsOf(fourEpochsBelow), 3);
  assert.equal(epochsOf(threeEpochsBelow - 1), 3);
  assert.equal(epochsOf(threeEpochsBelow), 2);
  assert.equal(epochsOf(1_000_000), 2);
});

test('alerta de overfitting: só com menos de 100 exemplos de treino', () => {
  const small = planOf({ datasetSize: SMALL_DATASET_EXAMPLES - 1 });
  assert.deepEqual(
    small.alerts.map(({ level, code }) => [level, code]),
    [['warning', 'overfitting-risk']],
  );
  assert.match(small.alerts[0]?.message ?? '', /99 exemplos/);
  assert.match(small.alerts[0]?.message ?? '', /4 épocas/);

  assert.deepEqual(planOf({ datasetSize: SMALL_DATASET_EXAMPLES }).alerts, []);
});

test('toda combinação devolve um plano coerente e dentro do schema', () => {
  for (const taskComplexity of TaskComplexity.options) {
    for (const baseParamsBillions of [0.001, 0.5, 7, 8, 14, 70]) {
      for (const datasetSize of [1, 99, 100, 5_000, 50_000]) {
        for (const availableVramGb of [8, 16, 24, 48, 160]) {
          const plan = planOf({ taskComplexity, baseParamsBillions, datasetSize, availableVramGb });

          assert.equal(LoraTrainingPlan.safeParse(plan).success, true);
          assert.equal(plan.loraAlpha, plan.r * ALPHA_PER_RANK);
          assert.ok(plan.epochs >= 2 && plan.epochs <= 4);
          assert.ok(plan.estimatedVramGb.qlora <= plan.estimatedVramGb.lora);
          // O método recomendado nunca pede mais VRAM do que a GPU tem.
          if (plan.recommendedMethod === 'LoRA (16-bit)') assert.ok(plan.estimatedVramGb.lora <= availableVramGb);
          if (plan.recommendedMethod === 'QLoRA (4-bit)') assert.ok(plan.estimatedVramGb.qlora <= availableVramGb);
        }
      }
    }
  }
});

test('entrada inválida é recusada, não vira plano', () => {
  assert.throws(() => planOf({ baseParamsBillions: 0 }));
  assert.throws(() => planOf({ baseParamsBillions: -7 }));
  assert.throws(() => planOf({ datasetSize: 0 }));
  assert.throws(() => planOf({ datasetSize: 10.5 }));
  assert.throws(() => planOf({ availableVramGb: 0 }));
  assert.throws(() => planOf({ taskComplexity: 'qualquer' as LoraPlanInput['taskComplexity'] }));
});
