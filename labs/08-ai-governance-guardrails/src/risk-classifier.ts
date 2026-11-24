import { z } from 'zod';

// Classificação de risco regulatório de um caso de uso de IA, INSPIRADA no EU AI Act
// (Regulamento (UE) 2024/1689) e na LGPD (Lei 13.709/2018).
//
// É uma simplificação didática, não um parecer jurídico. A lei tem exceções que quatro
// campos não capturam (o art. 6º(3) do AI Act tira do alto risco o sistema que só faz tarefa
// preparatória, por exemplo), e as datas de aplicação variam por artigo.
//
// Os quatro níveis são os rótulos de uso corrente. O texto do regulamento fala em práticas
// proibidas (art. 5º), sistemas de alto risco (art. 6º e Anexo III), obrigações de
// transparência (art. 50) e códigos de conduta voluntários para o resto (art. 95).

export const RiskLevel = z.enum(['minimal-risk', 'limited-risk', 'high-risk', 'unacceptable-risk']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const GovernanceRequirement = z.enum([
  'do-not-deploy',
  'transparency-notice',
  'audit-log',
  'explainability',
  'human-in-the-loop',
  'automated-decision-review',
  'risk-management',
  'data-governance',
  'technical-documentation',
  'accuracy-robustness-security',
  'fundamental-rights-impact-assessment',
  'data-protection-impact-assessment',
]);
export type GovernanceRequirement = z.infer<typeof GovernanceRequirement>;

/** O que cada requisito pede e de onde ele vem. É a tabela do README. */
export const REQUIREMENT_BASIS: Record<GovernanceRequirement, string> = {
  'do-not-deploy': 'Prática proibida: o sistema não pode ser colocado em uso (AI Act, art. 5º).',
  'transparency-notice': 'Avisar a pessoa de que ela fala com uma IA (AI Act, art. 50; LGPD, art. 6º, VI).',
  'audit-log': 'Registro automático de eventos (AI Act, art. 12; LGPD, art. 6º, X).',
  explainability: 'Informar critérios e fontes da resposta (AI Act, art. 13; LGPD, art. 20, § 1º).',
  'human-in-the-loop': 'Supervisão humana capaz de rever e barrar a saída (AI Act, art. 14).',
  'automated-decision-review': 'Canal para o titular pedir a revisão da decisão automatizada (LGPD, art. 20).',
  'risk-management': 'Sistema de gestão de riscos ao longo do ciclo de vida (AI Act, art. 9º).',
  'data-governance': 'Governança dos dados de treino, validação e teste (AI Act, art. 10).',
  'technical-documentation': 'Documentação técnica antes de o sistema entrar em uso (AI Act, art. 11).',
  'accuracy-robustness-security': 'Exatidão, robustez e cibersegurança (AI Act, art. 15).',
  'fundamental-rights-impact-assessment': 'Avaliação de impacto sobre direitos fundamentais (AI Act, art. 27).',
  'data-protection-impact-assessment':
    'Relatório de impacto à proteção de dados, que a ANPD pode exigir (LGPD, art. 38).',
};

export const AiUseCase = z.object({
  /** Área de aplicação, em slug: "credit-scoring", "customer-support". Veja as listas abaixo. */
  domain: z.string().min(1),
  /** O sistema decide sozinho, sem uma pessoa aprovar cada saída? */
  autonomousDecision: z.boolean(),
  /** A saída pesa em acesso a crédito, emprego, serviço essencial ou liberdade de alguém? */
  affectsFundamentalRights: z.boolean(),
  /** Trata biometria ou outro dado pessoal sensível (LGPD, art. 5º, II)? */
  usesBiometricsOrSensitiveData: z.boolean(),
});
export type AiUseCase = z.infer<typeof AiUseCase>;

export const RiskAssessment = z.object({
  riskLevel: RiskLevel,
  /** O que a governança tem que garantir antes de o sistema responder a alguém. */
  requirements: z.array(GovernanceRequirement),
  /** Por que o caso caiu neste nível. */
  rationale: z.array(z.string().min(1)).min(1),
});
export type RiskAssessment = z.infer<typeof RiskAssessment>;

// PONTO DE EXTENSÃO: as duas listas de domínios. Resumem o art. 5º e o Anexo III; o texto
// legal é mais específico do que um slug.

/** Práticas proibidas pelo art. 5º do AI Act. */
export const PROHIBITED_DOMAINS: ReadonlySet<string> = new Set([
  'subliminal-manipulation',
  'exploitation-of-vulnerabilities',
  'social-scoring',
  'crime-prediction-by-profiling',
  'facial-image-scraping',
  'emotion-inference-at-work-or-school',
  'biometric-categorisation-by-sensitive-traits',
  'real-time-remote-biometric-identification',
]);

/** As oito áreas do Anexo III do AI Act, mais a avaliação de crédito, citada no ponto 5(b). */
export const HIGH_RISK_DOMAINS: ReadonlySet<string> = new Set([
  'biometrics',
  'critical-infrastructure',
  'education',
  'employment',
  'essential-services',
  'credit-scoring',
  'law-enforcement',
  'migration-and-border-control',
  'justice-and-democratic-processes',
]);

/** "Credit Scoring" e "credit_scoring" valem como "credit-scoring". */
const slug = (domain: string) =>
  domain
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Classifica o risco de um caso de uso e devolve os requisitos de governança do nível.
 * Função pura e determinística: a mesma entrada dá sempre a mesma classificação.
 */
export function classifyAiSystemRisk(useCase: AiUseCase): RiskAssessment {
  // O caso de uso chega de um formulário de cadastro do sistema: a entrada é validada aqui.
  const { domain, autonomousDecision, affectsFundamentalRights, usesBiometricsOrSensitiveData } =
    AiUseCase.parse(useCase);
  const area = slug(domain);

  if (PROHIBITED_DOMAINS.has(area)) {
    return RiskAssessment.parse({
      riskLevel: 'unacceptable-risk',
      requirements: ['do-not-deploy'],
      rationale: [`O domínio "${area}" está entre as práticas proibidas pelo art. 5º do AI Act.`],
    });
  }

  const rationale: string[] = [];
  if (HIGH_RISK_DOMAINS.has(area)) {
    rationale.push(`O domínio "${area}" está entre as áreas de alto risco do Anexo III do AI Act.`);
  }
  if (autonomousDecision && affectsFundamentalRights) {
    rationale.push('O sistema decide sozinho sobre algo que pesa em direitos fundamentais.');
  }
  if (usesBiometricsOrSensitiveData && (autonomousDecision || affectsFundamentalRights)) {
    rationale.push('Trata dado sensível ou biometria em decisão automática ou que pesa em direitos.');
  }

  // Requisitos que dependem do caso, e não só do nível.
  const perCase: GovernanceRequirement[] = [];
  if (autonomousDecision) perCase.push('automated-decision-review');
  if (usesBiometricsOrSensitiveData) perCase.push('data-protection-impact-assessment');

  if (rationale.length > 0) {
    if (affectsFundamentalRights) perCase.push('fundamental-rights-impact-assessment');
    return RiskAssessment.parse({
      riskLevel: 'high-risk',
      requirements: [
        'transparency-notice',
        'audit-log',
        'explainability',
        'human-in-the-loop',
        'risk-management',
        'data-governance',
        'technical-documentation',
        'accuracy-robustness-security',
        ...perCase,
      ],
      rationale,
    });
  }

  if (autonomousDecision || affectsFundamentalRights || usesBiometricsOrSensitiveData) {
    if (autonomousDecision) rationale.push('O sistema decide sozinho, sem pesar em direitos fundamentais.');
    if (affectsFundamentalRights) rationale.push('A saída pesa em direitos, mas quem decide é uma pessoa.');
    if (usesBiometricsOrSensitiveData) rationale.push('Trata dado sensível, sem decidir nada sobre o titular.');
    return RiskAssessment.parse({
      riskLevel: 'limited-risk',
      requirements: ['transparency-notice', 'audit-log', 'explainability', ...perCase],
      rationale,
    });
  }

  return RiskAssessment.parse({
    riskLevel: 'minimal-risk',
    requirements: [],
    rationale: [
      'Nenhum critério de risco se aplica. Não há requisito obrigatório; vale código de conduta voluntário (AI Act, art. 95).',
    ],
  });
}
