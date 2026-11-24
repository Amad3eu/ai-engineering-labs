import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AiUseCase,
  classifyAiSystemRisk,
  GovernanceRequirement,
  HIGH_RISK_DOMAINS,
  PROHIBITED_DOMAINS,
  REQUIREMENT_BASIS,
  RiskAssessment,
} from './risk-classifier.js';

// O caso mais calmo possível: domínio fora das listas e nenhum critério. Cada teste mexe em um.
const CALM: AiUseCase = {
  domain: 'customer-support',
  autonomousDecision: false,
  affectsFundamentalRights: false,
  usesBiometricsOrSensitiveData: false,
};
const classify = (overrides: Partial<AiUseCase>) => classifyAiSystemRisk({ ...CALM, ...overrides });
const levelOf = (overrides: Partial<AiUseCase>) => classify(overrides).riskLevel;

test('risco mínimo: nenhum critério, nenhum requisito obrigatório', () => {
  const assessment = classify({});
  assert.equal(assessment.riskLevel, 'minimal-risk');
  assert.deepEqual(assessment.requirements, []);
  assert.match(assessment.rationale[0] ?? '', /art\. 95/);
});

test('risco limitado: um critério sozinho pede transparência, registro e explicabilidade', () => {
  const base = ['transparency-notice', 'audit-log', 'explainability'];

  const autonomous = classify({ autonomousDecision: true });
  assert.equal(autonomous.riskLevel, 'limited-risk');
  assert.deepEqual(autonomous.requirements, [...base, 'automated-decision-review']);

  const rights = classify({ affectsFundamentalRights: true });
  assert.equal(rights.riskLevel, 'limited-risk');
  assert.deepEqual(rights.requirements, base);

  const sensitive = classify({ usesBiometricsOrSensitiveData: true });
  assert.equal(sensitive.riskLevel, 'limited-risk');
  assert.deepEqual(sensitive.requirements, [...base, 'data-protection-impact-assessment']);
});

test('alto risco: decisão automática sobre direitos, ou dado sensível somado a outro critério', () => {
  assert.equal(levelOf({ autonomousDecision: true, affectsFundamentalRights: true }), 'high-risk');
  assert.equal(levelOf({ usesBiometricsOrSensitiveData: true, autonomousDecision: true }), 'high-risk');
  assert.equal(levelOf({ usesBiometricsOrSensitiveData: true, affectsFundamentalRights: true }), 'high-risk');
});

test('alto risco: domínio do Anexo III basta, mesmo com uma pessoa decidindo', () => {
  for (const domain of HIGH_RISK_DOMAINS) assert.equal(levelOf({ domain }), 'high-risk', domain);

  const hiring = classify({ domain: 'employment' });
  assert.match(hiring.rationale.join(' '), /"employment".*Anexo III/);
  // O slug aceita o nome escrito de outro jeito.
  assert.equal(levelOf({ domain: 'Credit Scoring' }), 'high-risk');
  assert.equal(levelOf({ domain: 'credit_scoring' }), 'high-risk');
});

test('alto risco: exige revisão humana, e os requisitos do caso entram por cima dos do nível', () => {
  const credit = classify({ domain: 'credit-scoring', autonomousDecision: true, affectsFundamentalRights: true });
  assert.deepEqual(credit.requirements, [
    'transparency-notice',
    'audit-log',
    'explainability',
    'human-in-the-loop',
    'risk-management',
    'data-governance',
    'technical-documentation',
    'accuracy-robustness-security',
    'automated-decision-review',
    'fundamental-rights-impact-assessment',
  ]);

  const biometrics = classify({ domain: 'biometrics', usesBiometricsOrSensitiveData: true });
  assert.ok(biometrics.requirements.includes('data-protection-impact-assessment'));
  assert.ok(!biometrics.requirements.includes('automated-decision-review'));
  assert.ok(!biometrics.requirements.includes('fundamental-rights-impact-assessment'));
});

test('risco inaceitável: prática proibida não roda, com qualquer combinação dos outros campos', () => {
  for (const domain of PROHIBITED_DOMAINS) {
    assert.deepEqual(classify({ domain }).requirements, ['do-not-deploy'], domain);
  }
  const scoring = classify({ domain: 'Social Scoring', autonomousDecision: true, usesBiometricsOrSensitiveData: true });
  assert.equal(scoring.riskLevel, 'unacceptable-risk');
  assert.match(scoring.rationale[0] ?? '', /art\. 5º/);
});

test('toda combinação devolve uma avaliação coerente e dentro do schema', () => {
  const flags = [false, true];
  for (const domain of ['customer-support', 'employment', 'social-scoring']) {
    for (const autonomousDecision of flags) {
      for (const affectsFundamentalRights of flags) {
        for (const usesBiometricsOrSensitiveData of flags) {
          const assessment = classifyAiSystemRisk({
            domain,
            autonomousDecision,
            affectsFundamentalRights,
            usesBiometricsOrSensitiveData,
          });

          assert.equal(RiskAssessment.safeParse(assessment).success, true);
          assert.equal(new Set(assessment.requirements).size, assessment.requirements.length);
          // Revisão humana é do alto risco, e só dele; proibido é só o domínio da lista.
          assert.equal(assessment.requirements.includes('human-in-the-loop'), assessment.riskLevel === 'high-risk');
          assert.equal(assessment.riskLevel === 'unacceptable-risk', domain === 'social-scoring');
        }
      }
    }
  }
});

test('cada requisito tem a base legal escrita', () => {
  for (const requirement of GovernanceRequirement.options) {
    assert.match(REQUIREMENT_BASIS[requirement], /AI Act|LGPD/, requirement);
  }
});

test('entrada inválida é recusada, não vira classificação', () => {
  assert.throws(() => classify({ domain: '' }));
  assert.throws(() => classify({ autonomousDecision: 'sim' as unknown as boolean }));
  assert.throws(() => classifyAiSystemRisk({ domain: 'customer-support' } as AiUseCase));
});
