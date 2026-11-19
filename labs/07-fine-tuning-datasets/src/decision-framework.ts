import { z } from 'zod';

// Decision Framework: prompt, RAG ou fine-tuning?
//
// A pergunta se divide em duas, e cada metade tem a sua resposta:
//
//   conhecimento    o modelo precisa de informação que muda, ou que tem que vir com a fonte?
//                   → é problema de CONTEXTO, e quem resolve é a busca (RAG)
//   comportamento   o formato ou o estilo está caro demais para carregar no prompt?
//                   → é problema de COMPORTAMENTO, e quem resolve é o treino (fine-tuning)
//
// Nenhum dos dois: prompt. Os dois: RAG + fine-tuning. Trocar uma resposta pela outra é o
// erro clássico: treino não ensina fato de forma confiável, e busca não ensina formato.

export const Approach = z.enum(['prompt-only', 'rag', 'fine-tuning', 'rag-plus-fine-tuning']);
export type Approach = z.infer<typeof Approach>;

export const UseCaseCriteria = z.object({
  /** De quanto em quanto tempo muda a informação de que a resposta depende. */
  dataChangeFrequency: z.enum(['static', 'monthly', 'weekly', 'daily']),
  /** A resposta precisa apontar de qual documento saiu? */
  needsSourceTraceability: z.boolean(),
  /** Quão difícil é o formato ou o estilo exigido da saída. */
  styleComplexity: z.enum(['low', 'medium', 'high']),
  /** Tamanho médio, em tokens, do prompt few-shot que sustenta o comportamento hoje. */
  avgFewShotPromptTokens: z.number().int().nonnegative(),
  /** Quão apertada é a meta de latência e de custo por resposta. */
  latencyCostTarget: z.enum(['relaxed', 'moderate', 'strict']),
});
export type UseCaseCriteria = z.infer<typeof UseCaseCriteria>;

export const ArchitectureRecommendation = z.object({
  approach: Approach,
  /** Por que esta abordagem: o que cada eixo (conhecimento e comportamento) pediu. */
  justification: z.array(z.string().min(1)).min(1),
  /** O que a abordagem custa e onde ela falha. */
  tradeOffs: z.array(z.string().min(1)).min(1),
});
export type ArchitectureRecommendation = z.infer<typeof ArchitectureRecommendation>;

// PONTO DE EXTENSÃO: os cortes abaixo são ponto de partida, não lei. Calibre com o seu preço,
// o seu volume e o resultado do A/B (ab-eval.ts).

/** A partir daqui o few-shot pesa: a maior parte dos tokens de cada requisição são exemplos. */
export const HEAVY_FEW_SHOT_TOKENS = 1_000;

/** Dado que muda nesta cadência anda mais rápido do que um ciclo de treino e reavaliação. */
const TOO_FAST_TO_RETRAIN: ReadonlySet<UseCaseCriteria['dataChangeFrequency']> = new Set(['weekly', 'daily']);

/**
 * Pressão para tirar o comportamento do prompt. Formato difícil e meta apertada somam: um
 * deles no grau máximo basta, e os dois em grau médio também.
 */
const PRESSURE = { low: 0, medium: 1, high: 2, relaxed: 0, moderate: 1, strict: 2 } as const;
const MIN_PRESSURE_TO_TUNE = 2;

const CADENCE = {
  static: 'não muda',
  monthly: 'muda uma vez por mês',
  weekly: 'muda toda semana',
  daily: 'muda todo dia',
};

const TRADE_OFFS: Record<Approach, string[]> = {
  'prompt-only': [
    'Todo o comportamento viaja no prompt: cada exemplo a mais é token pago em toda requisição.',
    'Se o conhecimento necessário deixar de caber no prompt, o problema vira de contexto e o caminho passa a ser RAG.',
  ],
  rag: [
    'Passa a existir um pipeline de dados para manter: ingestão, chunking, índice e avaliação da recuperação (lab 02).',
    'Cada resposta ganha uma busca e um bloco de contexto: mais latência e mais tokens de entrada.',
    'Busca entrega fato, não formato: se a saída exigir estilo rígido, o prompt continua carregando isso.',
  ],
  'fine-tuning': [
    'Custo fixo antes do primeiro ganho: curadoria do dataset, treino e uma suíte de avaliação para comparar (o A/B deste lab).',
    'O modelo ajustado fica preso ao modelo base e ao provedor: quando o modelo base é aposentado, treino e avaliação se repetem.',
    'Treino ensina comportamento, não fato: o que o modelo aprendeu sobre o domínio não se atualiza sozinho.',
  ],
  'rag-plus-fine-tuning': [
    'Os dois custos somados: pipeline de dados e ciclo de treino, cada um com a sua avaliação.',
    'Separe as responsabilidades: fato no índice, formato nos pesos. Exemplo de treino com o fato dentro envelhece o modelo.',
    'Chegue aqui em duas etapas: RAG com prompt primeiro, treino só quando o A/B mostrar que o formato é o gargalo.',
  ],
};

/**
 * Recomenda a arquitetura para um caso de uso. Função pura e determinística: a mesma entrada
 * dá sempre a mesma recomendação, com o motivo de cada eixo e os trade-offs da escolha.
 */
export function evaluateApproach(scenario: UseCaseCriteria): ArchitectureRecommendation {
  // O cenário pode chegar de um JSON ou de um formulário: a entrada é validada aqui.
  const { dataChangeFrequency, needsSourceTraceability, styleComplexity, avgFewShotPromptTokens, latencyCostTarget } =
    UseCaseCriteria.parse(scenario);

  // Eixo do conhecimento: precisa de busca?
  const changesFast = TOO_FAST_TO_RETRAIN.has(dataChangeFrequency);
  const needsRetrieval = needsSourceTraceability || changesFast;

  // Eixo do comportamento: compensa treinar? Só quando o few-shot já pesa E há pressão para
  // tirá-lo do prompt. Few-shot leve é sinal de que o prompt ainda dá conta.
  const heavyFewShot = avgFewShotPromptTokens >= HEAVY_FEW_SHOT_TOKENS;
  const pressure = PRESSURE[styleComplexity] + PRESSURE[latencyCostTarget];
  const needsTuning = heavyFewShot && pressure >= MIN_PRESSURE_TO_TUNE;

  let approach: Approach = 'prompt-only';
  if (needsRetrieval && needsTuning) approach = 'rag-plus-fine-tuning';
  else if (needsRetrieval) approach = 'rag';
  else if (needsTuning) approach = 'fine-tuning';

  const justification: string[] = [];
  if (needsSourceTraceability) {
    justification.push(
      'A resposta precisa apontar a fonte. Só a busca entrega o trecho junto com a resposta: peso de modelo não cita documento.',
    );
  }
  if (changesFast) {
    justification.push(
      `O dado ${CADENCE[dataChangeFrequency]}, mais rápido do que um ciclo de treino e reavaliação. O que muda fica no índice, não nos pesos.`,
    );
  }
  if (!needsRetrieval) {
    justification.push(
      `O dado ${CADENCE[dataChangeFrequency]} e a resposta não precisa de fonte: não há o que buscar a cada pergunta.`,
    );
  }

  if (needsTuning) {
    justification.push(
      `O few-shot médio tem ${avgFewShotPromptTokens} tokens (corte: ${HEAVY_FEW_SHOT_TOKENS}): o comportamento é pago de novo em toda requisição.`,
    );
    if (styleComplexity === 'high') {
      justification.push(
        'O formato é difícil o bastante para o prompt não encolher sem perder aderência. O treino põe o formato nos pesos.',
      );
    }
    if (latencyCostTarget === 'strict') {
      justification.push(
        'A meta de latência e custo é apertada: prompt curto responde mais rápido e custa menos por requisição.',
      );
    }
    if (styleComplexity !== 'high' && latencyCostTarget !== 'strict') {
      justification.push(
        'Formato e meta pressionam em grau médio, e somados já justificam tirar os exemplos do prompt.',
      );
    }
  } else if (heavyFewShot) {
    justification.push(
      `O few-shot já pesa (${avgFewShotPromptTokens} tokens), mas formato e meta ainda não pressionam o bastante para pagar um ciclo de treino.`,
    );
  } else {
    justification.push(
      `O few-shot médio tem ${avgFewShotPromptTokens} tokens, abaixo do corte de ${HEAVY_FEW_SHOT_TOKENS}: instrução e poucos exemplos ainda saem barato.`,
    );
  }

  const tradeOffs = [...TRADE_OFFS[approach]];
  if (needsRetrieval && latencyCostTarget === 'strict') {
    tradeOffs.push('Com a meta apertada, a busca a mais por pergunta pede cache semântico e top-k pequeno (lab 02).');
  }
  if (approach === 'fine-tuning' && dataChangeFrequency === 'monthly') {
    tradeOffs.push('O dado muda todo mês. Se a mudança for de fato, e não de formato, o treino envelhece: some RAG.');
  }
  if (heavyFewShot && !needsTuning) {
    tradeOffs.push(
      'Com few-shot pesado, o cache de prompt (onde o provedor oferece) barateia o bloco fixo de exemplos antes de qualquer treino.',
    );
  }

  // A saída também passa pelo schema: quem consome a recomendação recebe sempre o mesmo contrato.
  return ArchitectureRecommendation.parse({ approach, justification, tradeOffs });
}

/** Um caso por abordagem. É a matriz de decisão do README, e o teste confere cada linha. */
export const REFERENCE_SCENARIOS: Array<{ name: string; criteria: UseCaseCriteria }> = [
  {
    name: 'FAQ de produto',
    criteria: {
      dataChangeFrequency: 'static',
      needsSourceTraceability: false,
      styleComplexity: 'low',
      avgFewShotPromptTokens: 200,
      latencyCostTarget: 'relaxed',
    },
  },
  {
    name: 'Perguntas sobre o manual interno',
    criteria: {
      dataChangeFrequency: 'weekly',
      needsSourceTraceability: true,
      styleComplexity: 'low',
      avgFewShotPromptTokens: 300,
      latencyCostTarget: 'moderate',
    },
  },
  {
    name: 'Extração de contrato em JSON',
    criteria: {
      dataChangeFrequency: 'static',
      needsSourceTraceability: false,
      styleComplexity: 'high',
      avgFewShotPromptTokens: 3000,
      latencyCostTarget: 'moderate',
    },
  },
  {
    name: 'Resposta com política, no tom da marca',
    criteria: {
      dataChangeFrequency: 'weekly',
      needsSourceTraceability: true,
      styleComplexity: 'high',
      avgFewShotPromptTokens: 2500,
      latencyCostTarget: 'strict',
    },
  },
];
