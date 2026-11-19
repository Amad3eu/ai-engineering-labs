import { z } from 'zod';

// Plano de treino LoRA / QLoRA: a conta que vem ANTES de alugar a GPU.
//
// LoRA congela os pesos do modelo base. Ao lado de cada matriz W escolhida, treina duas
// matrizes pequenas, B e A, de posto r, e a camada passa a usar W + (alpha / r) · B·A.
//
//   r      capacidade do adaptador. Os parâmetros treináveis crescem em linha reta com ele:
//          r × (entrada + saída) por matriz adaptada.
//   alpha  escala da atualização. O fator é alpha / r (o padrão do PEFT): com alpha = 2r ele
//          fica em 2 em qualquer rank, e trocar o rank muda a capacidade sem mudar a escala.
//
// QLoRA é o mesmo adaptador sobre o modelo base carregado em 4 bits (NF4): os pesos
// congelados ocupam menos VRAM, e o treino cabe em GPU menor.
//
// Nada aqui treina nem mede: é heurística de planejamento, e cada constante diz de onde veio.

export const TaskComplexity = z.enum(['format-style', 'domain-reasoning']);
export type TaskComplexity = z.infer<typeof TaskComplexity>;

export const LoraPlanInput = z.object({
  /** Tamanho do modelo base, em bilhões de parâmetros (ex.: 7, 8, 14). */
  baseParamsBillions: z.number().positive(),
  /** Exemplos de TREINO: as linhas do train.jsonl, não o dataset inteiro. */
  datasetSize: z.number().int().positive(),
  /** O que o treino precisa ensinar: formato e estilo, ou raciocínio de domínio. */
  taskComplexity: TaskComplexity,
  /** VRAM da GPU disponível, em GB. */
  availableVramGb: z.number().positive(),
});
export type LoraPlanInput = z.infer<typeof LoraPlanInput>;

export const TrainingMethod = z.enum(['LoRA (16-bit)', 'QLoRA (4-bit)', 'Cloud/Multi-GPU Required']);
export type TrainingMethod = z.infer<typeof TrainingMethod>;

export const LoraTrainingPlan = z.object({
  /** O método que cabe na GPU informada. */
  recommendedMethod: TrainingMethod,
  /** Rank do adaptador: o `r` do LoraConfig do PEFT. */
  r: z.number().int().positive(),
  /** O `lora_alpha` do PEFT. */
  loraAlpha: z.number().int().positive(),
  learningRate: z.number().positive(),
  epochs: z.number().int().min(2).max(4),
  /** Parâmetros do adaptador, em % dos parâmetros do modelo base. Aproximado. */
  trainableParamsPercent: z.number().positive(),
  // Não negativos, e não positivos: com duas casas, um modelo minúsculo arredonda para zero.
  trainableParamsMillions: z.number().nonnegative(),
  /** VRAM estimada de cada método, em GB. */
  estimatedVramGb: z.object({ lora: z.number().nonnegative(), qlora: z.number().nonnegative() }),
  alerts: z.array(
    z.object({ level: z.literal('warning'), code: z.literal('overfitting-risk'), message: z.string().min(1) }),
  ),
});
export type LoraTrainingPlan = z.infer<typeof LoraTrainingPlan>;

// PONTO DE EXTENSÃO: as regras abaixo são ponto de partida para o primeiro treino, não lei.
// Calibre com o resultado do harness de checkpoints (model-eval-harness.ts).

/**
 * Formato e estilo pedem pouco do adaptador; raciocínio de domínio pede mais capacidade.
 * O rank alto leva a learning rate mais conservadora.
 */
const HYPERPARAMS = {
  'format-style': { r: 8, learningRate: 2e-4 },
  'domain-reasoning': { r: 32, learningRate: 1e-4 },
} as const;

/** alpha = 2 × r é regra prática comum, e mantém o fator alpha / r em 2 em qualquer rank. */
export const ALPHA_PER_RANK = 2;

/**
 * Parâmetros treináveis, em % do modelo base, por unidade de rank.
 *
 * Referência: r = 8 nas projeções de atenção (q, k, v, o) de um modelo de 7,24 bilhões de
 * parâmetros, com largura 4096, 32 camadas e k e v de saída 1024, soma 6,8 milhões de
 * parâmetros. São 0,09% do modelo, arredondados aqui para 0,1%: 0,0125% por unidade de rank.
 *
 * shortcut: a fração real cai com a largura do modelo (é proporcional a r / largura) e sobe
 * quando o adaptador entra também nas camadas MLP (cerca de 3× na mesma referência). Com a
 * arquitetura em mãos, troque pela conta exata: r × (entrada + saída) por matriz adaptada.
 */
export const TRAINABLE_PERCENT_PER_RANK = 0.0125;

/**
 * VRAM por bilhão de parâmetros do modelo base, em GB: os pesos carregados mais uma folga.
 *
 *   lora   16 bits são 2 bytes por parâmetro, 2,0 GB por bilhão; os 0,2 restantes são a folga.
 *   qlora  4 bits são 0,5 GB por bilhão; 0,75 com a folga. O artigo do QLoRA relata um modelo
 *          de 65 bilhões em uma GPU de 48 GB: 0,74 GB por bilhão.
 *
 * shortcut: é estimativa de PISO. A memória de ativações e gradientes cresce com o batch e
 * com o comprimento da sequência, e não entra na conta (o README traz um experimento público
 * que mediu bem mais). Antes de alugar a GPU, rode um passo de treino e meça.
 */
export const VRAM_GB_PER_BILLION = { lora: 2.2, qlora: 0.75 } as const;

/** Abaixo disto o adaptador decora o dataset em poucas passadas, e o plano avisa. */
export const SMALL_DATASET_EXAMPLES = 100;

/** Cortes de tamanho do dataset para a quantidade de épocas. */
export const EPOCH_CUTOFFS = { fourEpochsBelow: 1_000, threeEpochsBelow: 10_000 } as const;

/**
 * Menos exemplos, mais passadas: com dataset pequeno, uma época tem poucos passos de
 * otimização. Dataset grande já entrega esses passos em duas épocas.
 */
function recommendEpochs(datasetSize: number): number {
  if (datasetSize < EPOCH_CUTOFFS.fourEpochsBelow) return 4;
  if (datasetSize < EPOCH_CUTOFFS.threeEpochsBelow) return 3;
  return 2;
}

// Duas casas: 7 × 2,2 dá 15,400000000000002 em ponto flutuante, e a comparação com a VRAM
// disponível tem que ser a do número que o plano mostra.
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Monta o plano de treino para um modelo base, um dataset e uma GPU. Função pura e
 * determinística: a mesma entrada dá sempre o mesmo plano.
 */
export function buildLoraTrainingPlan(params: LoraPlanInput): LoraTrainingPlan {
  // Os parâmetros podem chegar de um JSON ou de um formulário: a entrada é validada aqui.
  const { baseParamsBillions, datasetSize, taskComplexity, availableVramGb } = LoraPlanInput.parse(params);

  const { r, learningRate } = HYPERPARAMS[taskComplexity];
  const epochs = recommendEpochs(datasetSize);
  const trainableParamsPercent = round2(r * TRAINABLE_PERCENT_PER_RANK);
  const estimatedVramGb = {
    lora: round2(baseParamsBillions * VRAM_GB_PER_BILLION.lora),
    qlora: round2(baseParamsBillions * VRAM_GB_PER_BILLION.qlora),
  };

  // Quando os dois cabem, fica o de 16 bits: QLoRA troca VRAM por tempo de treino (README).
  let recommendedMethod: TrainingMethod = 'Cloud/Multi-GPU Required';
  if (estimatedVramGb.lora <= availableVramGb) recommendedMethod = 'LoRA (16-bit)';
  else if (estimatedVramGb.qlora <= availableVramGb) recommendedMethod = 'QLoRA (4-bit)';

  const alerts: LoraTrainingPlan['alerts'] = [];
  if (datasetSize < SMALL_DATASET_EXAMPLES) {
    alerts.push({
      level: 'warning',
      code: 'overfitting-risk',
      message:
        `Risco de overfitting: ${datasetSize} exemplos de treino, menos de ${SMALL_DATASET_EXAMPLES}. ` +
        `Em ${epochs} épocas o adaptador pode decorar o dataset: avalie o checkpoint de cada época e não assuma que o último é o melhor.`,
    });
  }

  // A saída também passa pelo schema: quem consome o plano recebe sempre o mesmo contrato.
  return LoraTrainingPlan.parse({
    recommendedMethod,
    r,
    loraAlpha: r * ALPHA_PER_RANK,
    learningRate,
    epochs,
    trainableParamsPercent,
    // 1% de 1 bilhão são 10 milhões.
    trainableParamsMillions: round2(baseParamsBillions * 10 * trainableParamsPercent),
    estimatedVramGb,
    alerts,
  });
}
