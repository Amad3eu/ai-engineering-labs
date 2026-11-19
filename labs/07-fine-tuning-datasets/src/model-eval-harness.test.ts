import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { CheckpointMetric, evaluateTrainingCheckpoints } from './model-eval-harness.js';

const BASELINE = 0.8;
/** Uma linha de métricas. Sem o último argumento, o raciocínio geral fica igual ao do modelo base. */
const checkpoint = (
  epoch: number,
  trainLoss: number,
  valLoss: number,
  domainSchemaAccuracy: number,
  generalReasoningAccuracy = BASELINE,
): CheckpointMetric => ({
  epoch,
  trainLoss,
  valLoss,
  domainSchemaAccuracy,
  generalReasoningAccuracy,
  baselineGeneralAccuracy: BASELINE,
});

test('treino saudável: nenhum alerta, e a maior acurácia de domínio vai para produção', () => {
  const report = evaluateTrainingCheckpoints([
    checkpoint(1, 1.2, 1.3, 0.6),
    checkpoint(2, 0.9, 1.0, 0.8),
    checkpoint(3, 0.7, 0.9, 0.9),
  ]);

  assert.equal(report.overfittingStartEpoch, null);
  assert.deepEqual(report.alerts, []);
  assert.deepEqual(
    report.checkpoints.map(({ overfitting, passesGates }) => [overfitting, passesGates]),
    [
      ['none', true],
      ['none', true],
      ['none', true],
    ],
  );
  assert.equal(report.decision, 'promote');
  assert.equal(report.selectedEpoch, 3);
});

test('overfitting: aponta a época exata em que o valLoss sobe com o trainLoss ainda caindo', () => {
  const report = evaluateTrainingCheckpoints([
    checkpoint(1, 1.2, 1.3, 0.6),
    checkpoint(2, 0.9, 1.0, 0.8),
    checkpoint(3, 0.7, 1.05, 0.85), // a virada: +5% sobre o melhor valLoss
    checkpoint(4, 0.5, 1.2, 0.86), // +20%
  ]);

  assert.equal(report.overfittingStartEpoch, 3);
  // Um alerta só, na virada: as épocas seguintes aparecem no veredito de cada checkpoint.
  assert.deepEqual(
    report.alerts.map(({ level, code, epoch }) => [level, code, epoch]),
    [['warning', 'overfitting', 3]],
  );
  assert.match(report.alerts[0]?.message ?? '', /de 1 para 1\.05/);
  assert.deepEqual(
    report.checkpoints.map(({ overfitting }) => overfitting),
    ['none', 'none', 'mild', 'severe'],
  );
});

test('overfitting: valLoss subindo junto com o trainLoss não conta, e voltar ao melhor valLoss limpa', () => {
  const unstable = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.6), checkpoint(2, 1.1, 1.2, 0.5)]);
  assert.equal(unstable.overfittingStartEpoch, null);
  assert.deepEqual(unstable.alerts, []);
  assert.deepEqual(
    unstable.checkpoints.map(({ overfitting }) => overfitting),
    ['none', 'none'],
  );

  const recovered = evaluateTrainingCheckpoints([
    checkpoint(1, 1.0, 1.0, 0.6),
    checkpoint(2, 0.8, 1.05, 0.7),
    checkpoint(3, 0.6, 0.9, 0.8), // novo melhor valLoss
  ]);
  assert.equal(recovered.overfittingStartEpoch, 2);
  assert.deepEqual(
    recovered.checkpoints.map(({ overfitting }) => overfitting),
    ['none', 'mild', 'none'],
  );
});

test('gate de overfitting: o leve passa e pode ser o escolhido; o severo fica de fora', () => {
  const mild = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.8), checkpoint(2, 0.8, 1.05, 0.9)]);
  assert.equal(mild.selectedEpoch, 2);
  assert.match(mild.reason, /overfitting leve/);

  // A época 2 tem a maior acurácia de domínio, mas o valLoss está 20% acima do melhor.
  const severe = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.8), checkpoint(2, 0.8, 1.2, 0.95)]);
  assert.deepEqual(
    severe.checkpoints.map(({ passesGates }) => passesGates),
    [true, false],
  );
  assert.equal(severe.selectedEpoch, 1);
  assert.doesNotMatch(severe.reason, /overfitting leve/);
});

test('gate de overfitting: exatamente 10% acima do melhor valLoss ainda é leve', () => {
  // 1.1 / 1.0 - 1 dá 0.10000000000000009 em ponto flutuante: sem a folga, viraria severo.
  const atLimit = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.8), checkpoint(2, 0.8, 1.1, 0.9)]);
  assert.equal(atLimit.checkpoints[1]?.overfitting, 'mild');
  assert.equal(atLimit.selectedEpoch, 2);

  const beyond = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.8), checkpoint(2, 0.8, 1.11, 0.9)]);
  assert.equal(beyond.checkpoints[1]?.overfitting, 'severe');
  assert.equal(beyond.selectedEpoch, 1);
});

test('catastrophic forgetting: mais de 10 pontos abaixo do modelo base é alerta crítico e bloqueia', () => {
  const report = evaluateTrainingCheckpoints([
    checkpoint(1, 1.0, 1.0, 0.7, 0.8),
    checkpoint(2, 0.8, 0.9, 0.9, 0.7), // exatamente 10 pontos abaixo: ainda passa
    checkpoint(3, 0.6, 0.8, 0.99, 0.69), // 11 pontos abaixo
  ]);

  assert.deepEqual(
    report.checkpoints.map(({ catastrophicForgetting, passesGates }) => [catastrophicForgetting, passesGates]),
    [
      [false, true],
      [false, true],
      [true, false],
    ],
  );
  assert.deepEqual(
    report.alerts.map(({ level, code, epoch }) => [level, code, epoch]),
    [['critical', 'catastrophic-forgetting', 3]],
  );
  assert.match(report.alerts[0]?.message ?? '', /11 pontos abaixo do modelo base \(80%\)\. O limite é de 10 pontos/);
  assert.equal(report.baselineGeneralAccuracy, BASELINE);
  // A época 3 tem a maior acurácia de domínio (99%) e mesmo assim não vai para produção.
  assert.equal(report.selectedEpoch, 2);
});

test('catastrophic forgetting: melhorar no raciocínio geral não é queda', () => {
  const report = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.7, 0.95)]);
  assert.equal(report.checkpoints[0]?.catastrophicForgetting, false);
  assert.ok((report.checkpoints[0]?.generalAccuracyDrop ?? 0) < 0);
});

test('nenhum checkpoint passa nos gates: a recomendação é rejeitar o treino', () => {
  const report = evaluateTrainingCheckpoints([
    checkpoint(1, 1.0, 1.0, 0.9, 0.6), // forgetting
    checkpoint(2, 0.8, 1.3, 0.95), // overfitting severo
  ]);

  assert.equal(report.decision, 'reject');
  assert.equal(report.selectedEpoch, null);
  assert.match(
    report.reason,
    /Nenhum dos 2 checkpoints passa nos gates: 1 com overfitting severo, 1 com catastrophic forgetting/,
  );
});

test('empate na acurácia de domínio: fica o de menor valLoss, e depois o mais antigo', () => {
  const byValLoss = evaluateTrainingCheckpoints([
    checkpoint(1, 1.0, 0.9, 0.9),
    checkpoint(2, 0.8, 0.8, 0.9),
    checkpoint(3, 0.9, 0.85, 0.9),
  ]);
  assert.equal(byValLoss.selectedEpoch, 2);

  const byEpoch = evaluateTrainingCheckpoints([checkpoint(1, 1.0, 0.8, 0.9), checkpoint(2, 0.8, 0.8, 0.9)]);
  assert.equal(byEpoch.selectedEpoch, 1);
});

test('entrada: ordena por época antes de comparar uma com a anterior', () => {
  const report = evaluateTrainingCheckpoints([
    checkpoint(3, 0.7, 1.05, 0.85),
    checkpoint(1, 1.2, 1.3, 0.6),
    checkpoint(2, 0.9, 1.0, 0.8),
  ]);

  assert.deepEqual(
    report.checkpoints.map(({ epoch }) => epoch),
    [1, 2, 3],
  );
  assert.equal(report.overfittingStartEpoch, 3);
});

test('entrada: recusa o que não dá para avaliar', () => {
  assert.throws(() => evaluateTrainingCheckpoints([]), /Nenhum checkpoint/);
  assert.throws(
    () => evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 0.8), checkpoint(1, 0.9, 0.9, 0.9)]),
    /época 1 aparece mais de uma vez/,
  );
  assert.throws(() => evaluateTrainingCheckpoints([checkpoint(1, 1.0, 1.0, 1.2)])); // acurácia acima de 1
  assert.throws(() => evaluateTrainingCheckpoints([checkpoint(0, 1.0, 1.0, 0.8)])); // época zero
  assert.throws(() => evaluateTrainingCheckpoints([checkpoint(1, 1.0, 0, 0.8)])); // valLoss zero
  assert.throws(
    () =>
      evaluateTrainingCheckpoints([
        checkpoint(1, 1.0, 1.0, 0.8),
        { ...checkpoint(2, 0.9, 0.9, 0.9), baselineGeneralAccuracy: 0.7 },
      ]),
    /baselineGeneralAccuracy diferentes/,
  );
});

test('o roteiro de data/simulated-checkpoints.json: virada na época 3, forgetting na 4, época 2 em produção', async () => {
  const file = join(import.meta.dirname, '..', 'data', 'simulated-checkpoints.json');
  const report = evaluateTrainingCheckpoints(z.array(CheckpointMetric).parse(JSON.parse(await readFile(file, 'utf8'))));

  assert.equal(report.overfittingStartEpoch, 3);
  assert.deepEqual(
    report.checkpoints.map(({ overfitting, catastrophicForgetting, passesGates }) => [
      overfitting,
      catastrophicForgetting,
      passesGates,
    ]),
    [
      ['none', false, true],
      ['none', false, true],
      ['mild', false, true],
      ['severe', true, false],
    ],
  );
  assert.deepEqual(
    report.alerts.map(({ level, epoch }) => [level, epoch]),
    [
      ['warning', 3],
      ['critical', 4],
    ],
  );
  assert.equal(report.decision, 'promote');
  assert.equal(report.selectedEpoch, 2);
});
