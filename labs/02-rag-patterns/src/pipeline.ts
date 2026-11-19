import { generateObject, generateText } from '@labs/shared-llm';
import type { SearchHit } from '@labs/shared-vector';
import { z } from 'zod';
import {
  FAQ_SYSTEM,
  GRADER_SYSTEM,
  graderPrompt,
  INTENT_SYSTEM,
  intentPrompt,
  RAG_SYSTEM,
  ragPrompt,
} from './prompts.js';
import type { CacheScope, SemanticCache } from './semantic-cache.js';

// O orquestrador: decide, para cada pergunta, o caminho mais barato que ainda responde certo.
//
//   1. Cache semântico      já respondemos algo equivalente, que este escopo pode ver?
//   2. Intenção             dúvida geral, ou depende do manual interno?
//   3a. faq-simples         o modelo mais barato responde direto
//   3b. consulta-tecnica    Agentic RAG: busca híbrida → grader → síntese (ou aviso fixo)
//
// Cada etapa existe para evitar a seguinte: o cache evita o modelo, o roteador evita a
// busca, o grader evita uma síntese sobre trechos que não respondem.

export type AnswerSource = 'cache' | 'fast-tier' | 'agentic-rag';

export const Intent = z.enum(['faq-simples', 'consulta-tecnica']);
export type Intent = z.infer<typeof Intent>;

// `reason` vem antes da decisão nos dois schemas: o modelo escreve o motivo e só então
// decide, o que melhora a decisão e deixa um rastro para depurar.
const IntentDecision = z.object({
  reason: z.string().describe('Uma frase explicando a classificação.'),
  intent: Intent,
});

const RelevanceGrade = z.object({
  reason: z.string().describe('Uma frase: o trecho contém a resposta, ou só o assunto?'),
  relevant: z.boolean(),
});

export interface PipelineRequest {
  question: string;
  userId: string;
  /**
   * Quem decide o escopo é a aplicação, nunca o modelo: `user-private` quando a conversa
   * carrega dado que só aquele usuário pode ver. O escopo define onde a resposta é guardada
   * e quais respostas guardadas podem voltar.
   */
  scope: CacheScope['kind'];
}

export interface PipelineAnswer {
  answer: string;
  source: AnswerSource;
  /** Ausente quando a resposta veio do cache: o roteador nem chegou a rodar. */
  intent?: Intent;
  /** Modelo que escreveu a resposta. Ausente no cache e no fallback, que não chamam modelo. */
  model?: string;
  /** Similaridade com a entrada de cache visível mais próxima. */
  cacheSimilarity: number;
  /** Só no caminho agentic-rag: quantos chunks vieram da busca e quantos o grader aprovou. */
  retrieval?: { retrieved: number; relevant: number; sources: string[] };
  /** Nenhum chunk passou pelo grader: a resposta é o aviso fixo, e não entra no cache. */
  fallback: boolean;
}

export interface PipelineDeps {
  cache: SemanticCache;
  /** A busca híbrida. Injetada para o teste trocar o Postgres por uma lista em memória. */
  retrieve: (question: string, k: number) => Promise<SearchHit[]>;
}

/**
 * Resposta quando a busca não trouxe nada que responda. É texto fixo, sem chamada de modelo:
 * custo zero e nenhuma chance de o modelo "ajudar" inventando.
 */
export const FALLBACK_ANSWER =
  'Não encontrei essa informação no manual interno. Reformule a pergunta ou procure o time responsável pelo assunto.';

export function createPipeline({ cache, retrieve }: PipelineDeps, { topK = 3 }: { topK?: number } = {}) {
  /** Agentic RAG: a busca traz candidatos, o grader decide quais entram na resposta. */
  async function agenticRag(
    question: string,
  ): Promise<Pick<PipelineAnswer, 'answer' | 'model' | 'retrieval' | 'fallback'>> {
    const hits = await retrieve(question, topK);

    // Relevance grader: cada chunk é julgado sozinho, em paralelo, pelo modelo barato.
    // Julgar um por vez custa mais chamadas, mas um chunk bom não "empresta" relevância ao vizinho.
    const grades = await Promise.all(
      hits.map((hit) =>
        generateObject({
          system: GRADER_SYSTEM,
          prompt: graderPrompt(question, hit.content),
          schema: RelevanceGrade,
          schemaName: 'relevance_grade',
          tier: 'fast',
          label: 'pipeline:grade',
        }),
      ),
    );
    const relevant = hits.filter((_, index) => grades[index]?.object.relevant);
    const retrieval = {
      retrieved: hits.length,
      relevant: relevant.length,
      sources: [...new Set(relevant.map((hit) => hit.source))],
    };

    // PONTO DE EXTENSÃO: antes de desistir, um agente mais insistente reescreveria a
    // pergunta e buscaria de novo, ou consultaria outra fonte. Com teto de tentativas.
    if (relevant.length === 0) return { answer: FALLBACK_ANSWER, retrieval, fallback: true };

    // A síntese só enxerga os chunks aprovados: menos contexto, menos custo e menos ruído.
    const { text, model } = await generateText({
      system: RAG_SYSTEM,
      prompt: ragPrompt(question, relevant),
      tier: 'balanced',
      label: 'pipeline:synthesize',
    });
    return { answer: text, model, retrieval, fallback: false };
  }

  return async function answer(request: PipelineRequest): Promise<PipelineAnswer> {
    const { question } = request;
    const scope: CacheScope =
      request.scope === 'global' ? { kind: 'global' } : { kind: 'user-private', userId: request.userId };

    // 1. Cache semântico. Um acerto encerra aqui: nem o roteador roda.
    const probe = await cache.probe(question, scope);
    if (probe.hit) {
      return { answer: probe.hit.answer, source: 'cache', cacheSimilarity: probe.similarity, fallback: false };
    }

    // 2. Roteamento por intenção, com o modelo barato.
    // PONTO DE EXTENSÃO: uma regra em código antes do modelo (regex de código de erro, por
    // exemplo) resolve os casos óbvios sem gastar esta chamada.
    const { object: decision } = await generateObject({
      system: INTENT_SYSTEM,
      prompt: intentPrompt(question),
      schema: IntentDecision,
      schemaName: 'intent_decision',
      tier: 'fast',
      label: 'pipeline:intent',
    });
    const base = { intent: decision.intent, cacheSimilarity: probe.similarity };

    // 3a. Dúvida geral: o modelo mais barato responde direto, sem busca.
    if (decision.intent === 'faq-simples') {
      const { text, model } = await generateText({
        system: FAQ_SYSTEM,
        prompt: question,
        tier: 'fast',
        label: 'pipeline:faq',
      });
      await probe.save(text);
      return { ...base, answer: text, model, source: 'fast-tier', fallback: false };
    }

    // 3b. Consulta técnica: Agentic RAG.
    const rag = await agenticRag(question);
    // O aviso de "não encontrei" não entra no cache: ele deixaria de valer no dia em que o
    // documento que falta fosse indexado, e continuaria sendo servido até o TTL vencer.
    if (!rag.fallback) await probe.save(rag.answer);
    return { ...base, ...rag, source: 'agentic-rag' };
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;
