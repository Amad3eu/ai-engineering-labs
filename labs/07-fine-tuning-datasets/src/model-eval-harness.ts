import { z } from 'zod';

// Harness de avaliação de checkpoints: qual época vai para produção, se alguma for.
//
// Um treino grava um checkpoint por época, e o último nem sempre é o melhor. Duas coisas dão
// errado enquanto o trainLoss continua caindo:
//
//   overfitting              o modelo passa a decorar o treino: o valLoss sobe em relação à
//                            época anterior
//   catastrophic forgetting  o modelo desaprende o que o modelo base sabia: a acurácia de
//                            raciocínio geral cai mais de 10 pontos abaixo da dele
//
// O harness não roda modelo nenhum. Recebe as métricas já medidas, uma linha por época, e
// aplica os gates. É função pura: serve de trava em CI antes de promover um modelo.

export const CheckpointMetric = z.object({
  epoch: z.number().int().positive(),
  trainLoss: z.number().nonnegative(),
  /** Loss na validação. Maior que zero: é o denominador da comparação com o melhor valLoss. */
  valLoss: z.number().positive(),
  /** Fração das respostas da validação que acertam o schema do domínio, de 0 a 1. */
  domainSchemaAccuracy: z.number().min(0).max(1),
  /** Acurácia em uma suíte de raciocínio geral, fora do domínio do treino, de 0 a 1. */
  generalReasoningAccuracy: z.number().min(0).max(1),
  /**
   * A mesma suíte, medida no modelo base antes do treino. Vai em toda linha para a função
   * receber só a lista de checkpoints; como o modelo base é um só, o valor tem que se repetir.
   */
  baselineGeneralAccuracy: z.number().min(0).max(1),
});
export type CheckpointMetric = z.infer<typeof CheckpointMetric>;

// PONTO DE EXTENSÃO: os gates são ponto de partida. Calibre com a sua suíte e o seu risco.
export const QUALITY_GATES = {
  /** Queda máxima de raciocínio geral em relação ao modelo base: 0,10 são 10 pontos de acurácia. */
  maxGeneralAccuracyDrop: 0.1,
  /** O overfitting vira severo quando o valLoss passa disto acima do melhor valLoss visto: 0,10 são 10%. */
  severeValLossRise: 0.1,
} as const;

export type OverfittingLevel = 'none' | 'mild' | 'severe';

export interface CheckpointVerdict extends CheckpointMetric {
  overfitting: OverfittingLevel;
  /** Quanto o valLoss está acima do melhor valLoss até esta época: 0,05 são 5%. */
  valLossRise: number;
  /** Queda de raciocínio geral em relação ao modelo base. Positivo: piorou. */
  generalAccuracyDrop: number;
  catastrophicForgetting: boolean;
  /** Sem overfitting severo e sem catastrophic forgetting. */
  passesGates: boolean;
}

export interface HarnessAlert {
  level: 'warning' | 'critical';
  code: 'overfitting' | 'catastrophic-forgetting';
  epoch: number;
  message: string;
}

export interface EvalHarnessReport {
  /** Um veredito por checkpoint, em ordem de época. */
  checkpoints: CheckpointVerdict[];
  /** O raciocínio geral do modelo base: a régua do catastrophic forgetting. */
  baselineGeneralAccuracy: number;
  /** A primeira época em que o valLoss subiu com o trainLoss caindo; `null` se não aconteceu. */
  overfittingStartEpoch: number | null;
  alerts: HarnessAlert[];
  decision: 'promote' | 'reject';
  /** O checkpoint escolhido para produção; `null` quando a decisão é rejeitar o treino. */
  selectedEpoch: number | null;
  reason: string;
}

// 0.8 - 0.7 dá 0.10000000000000009 em ponto flutuante. Sem a folga, uma queda de exatamente
// 10 pontos dispararia o alerta de "mais de 10".
const EPSILON = 1e-9;
const exceeds = (value: number, limit: number) => value - limit > EPSILON;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
/** Fração em pontos, com uma casa só quando ela existe: 0.14 vira 14, e 0.104 vira 10.4. */
const points = (fraction: number) => Number((fraction * 100).toFixed(1));

/**
 * Avalia os checkpoints de um treino e decide qual vai para produção.
 *
 * Vai o de maior `domainSchemaAccuracy` entre os que passam nos gates. No empate, o de menor
 * valLoss, e depois o mais antigo. Se nenhum passar, a recomendação é rejeitar o treino.
 */
export function evaluateTrainingCheckpoints(checkpoints: CheckpointMetric[]): EvalHarnessReport {
  // As métricas chegam de um arquivo do treino: a entrada é validada aqui.
  const ordered = z
    .array(CheckpointMetric)
    .parse(checkpoints)
    .toSorted((a, b) => a.epoch - b.epoch);

  const [first] = ordered;
  if (!first) throw new Error('Nenhum checkpoint: não há o que avaliar.');
  const repeated = ordered.find((checkpoint, index) => checkpoint.epoch === ordered[index - 1]?.epoch);
  if (repeated) throw new Error(`A época ${repeated.epoch} aparece mais de uma vez: não dá para saber qual vale.`);
  const { baselineGeneralAccuracy } = first;
  if (ordered.some((checkpoint) => checkpoint.baselineGeneralAccuracy !== baselineGeneralAccuracy)) {
    throw new Error('Os checkpoints trazem baselineGeneralAccuracy diferentes: o modelo base é um só.');
  }

  const alerts: HarnessAlert[] = [];
  const verdicts: CheckpointVerdict[] = [];
  let overfittingStartEpoch: number | null = null;
  let bestValLoss = Number.POSITIVE_INFINITY;
  let previous: CheckpointMetric | undefined;

  for (const checkpoint of ordered) {
    const { epoch, trainLoss, valLoss, generalReasoningAccuracy } = checkpoint;

    // O ponto exato: a primeira época em que o valLoss sobe e o trainLoss segue caindo.
    // valLoss subindo junto com o trainLoss é treino instável, não overfitting.
    if (overfittingStartEpoch === null && previous && valLoss > previous.valLoss && trainLoss < previous.trainLoss) {
      overfittingStartEpoch = epoch;
      alerts.push({
        level: 'warning',
        code: 'overfitting',
        epoch,
        message: `Overfitting a partir da época ${epoch}: o valLoss subiu de ${previous.valLoss} para ${valLoss} enquanto o trainLoss caiu de ${previous.trainLoss} para ${trainLoss}.`,
      });
    }

    // A gravidade é a distância até o melhor valLoss visto, e não a subida de uma época só:
    // várias subidas pequenas somam, e um checkpoint que volta a ser o melhor sai da conta.
    bestValLoss = Math.min(bestValLoss, valLoss);
    const valLossRise = valLoss / bestValLoss - 1;
    let overfitting: OverfittingLevel = 'none';
    if (overfittingStartEpoch !== null && valLossRise > 0) {
      overfitting = exceeds(valLossRise, QUALITY_GATES.severeValLossRise) ? 'severe' : 'mild';
    }

    const generalAccuracyDrop = baselineGeneralAccuracy - generalReasoningAccuracy;
    const catastrophicForgetting = exceeds(generalAccuracyDrop, QUALITY_GATES.maxGeneralAccuracyDrop);
    if (catastrophicForgetting) {
      alerts.push({
        level: 'critical',
        code: 'catastrophic-forgetting',
        epoch,
        message:
          `Catastrophic forgetting na época ${epoch}: raciocínio geral em ${percent(generalReasoningAccuracy)}, ` +
          `${points(generalAccuracyDrop)} pontos abaixo do modelo base (${percent(baselineGeneralAccuracy)}). ` +
          `O limite é de ${points(QUALITY_GATES.maxGeneralAccuracyDrop)} pontos.`,
      });
    }

    verdicts.push({
      ...checkpoint,
      overfitting,
      valLossRise,
      generalAccuracyDrop,
      catastrophicForgetting,
      passesGates: overfitting !== 'severe' && !catastrophicForgetting,
    });
    previous = checkpoint;
  }

  // PONTO DE EXTENSÃO: não há piso de acurácia de domínio. Se o seu caso tem uma meta (ex.: o
  // resultado do braço few-shot no A/B), filtre aqui antes de escolher.
  const passing = verdicts.filter((verdict) => verdict.passesGates);
  const selected = passing.toSorted(
    (a, b) => b.domainSchemaAccuracy - a.domainSchemaAccuracy || a.valLoss - b.valLoss || a.epoch - b.epoch,
  )[0];

  const measured = { checkpoints: verdicts, baselineGeneralAccuracy, overfittingStartEpoch, alerts };

  if (!selected) {
    const severe = verdicts.filter((verdict) => verdict.overfitting === 'severe').length;
    const forgetting = verdicts.filter((verdict) => verdict.catastrophicForgetting).length;
    return {
      ...measured,
      decision: 'reject',
      selectedEpoch: null,
      reason:
        `Nenhum dos ${verdicts.length} checkpoints passa nos gates: ${severe} com overfitting severo, ${forgetting} com catastrophic forgetting. ` +
        'Não promova nenhum: ajuste o plano (menos épocas, learning rate menor, mais dados) e treine de novo.',
    };
  }

  const mild =
    selected.overfitting === 'mild'
      ? ` Tem overfitting leve: o valLoss está ${points(selected.valLossRise)}% acima do melhor.`
      : '';
  return {
    ...measured,
    decision: 'promote',
    selectedEpoch: selected.epoch,
    reason: `Época ${selected.epoch}: a maior acurácia de domínio (${percent(selected.domainSchemaAccuracy)}) entre os checkpoints que passam nos gates (${passing.length} de ${verdicts.length}).${mild}`,
  };
}
