import { createInterface } from 'node:readline/promises';
import { Command, INTERRUPT, interrupt, isInterrupted } from '@langchain/langgraph';
import { z } from 'zod';

// Human-in-the-Loop: o grafo para, entrega um pedido a quem o chamou e só continua quando
// recebe a decisão. Três peças:
//   1. `interrupt()` dentro de um nó pausa a execução;
//   2. um checkpointer guarda o estado pausado, identificado pelo `thread_id`;
//   3. `new Command({ resume })` retoma do ponto da pausa com a resposta.

export interface ReviewRequest {
  draft: string;
}

export const ReviewDecision = z.object({
  approved: z.boolean(),
  feedback: z.string(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** Quem responde ao pedido de revisão: uma pessoa no terminal, um roteiro, uma fila, um botão no Slack. */
export type Reviewer = (request: ReviewRequest) => Promise<ReviewDecision>;

/**
 * Chame de dentro de um nó. Na primeira passada pausa o grafo; na retomada devolve a decisão.
 *
 * Atenção: na retomada o nó roda de novo desde a primeira linha. Não coloque efeito
 * colateral (enviar e-mail, gravar em banco) antes desta chamada, ou ele acontece duas vezes.
 */
export function requestReview(request: ReviewRequest): ReviewDecision {
  // A resposta humana é entrada externa como qualquer outra: passa pelo schema.
  return ReviewDecision.parse(interrupt(request));
}

/** Pergunta no terminal. Enter ou "s" aprova; qualquer outro texto reprova e vira o feedback. */
export const terminalReviewer: Reviewer = async ({ draft }) => {
  // Pergunta em stderr: stdout fica só com o resultado do laboratório.
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`\n--- Rascunho para aprovação ---\n${draft}\n`);
    const answer = (await terminal.question('Aprovar? [Enter = sim] ou escreva o que mudar: ')).trim();
    return /^(s|sim|y|yes)?$/i.test(answer) ? { approved: true, feedback: '' } : { approved: false, feedback: answer };
  } finally {
    terminal.close();
  }
};

/** Revisor roteirizado, para rodar sem terminal (CI): reprova a primeira versão, aprova a seguinte. */
export function scriptedReviewer(): Reviewer {
  let reviews = 0;
  return async () =>
    reviews++ === 0
      ? { approved: false, feedback: 'Encurte: no máximo dois parágrafos.' }
      : { approved: true, feedback: '' };
}

interface Resumable<State> {
  invoke(input: unknown, config: { configurable: { thread_id: string } }): Promise<State>;
}

/**
 * Roda o grafo até o fim, atendendo cada pausa com o revisor.
 *
 * PONTO DE EXTENSÃO: em produção a pausa dura horas, não milissegundos. Troque o
 * `MemorySaver` por um checkpointer persistente (Postgres, Redis) e separe em dois
 * processos: um inicia e termina na interrupção; outro retoma quando a pessoa responder.
 */
export async function runWithReview<State>(
  graph: Resumable<State>,
  input: unknown,
  reviewer: Reviewer,
  threadId: string,
): Promise<State> {
  const config = { configurable: { thread_id: threadId } };
  let state = await graph.invoke(input, config);

  while (isInterrupted<ReviewRequest>(state)) {
    const request = state[INTERRUPT][0]?.value;
    if (!request) throw new Error('O grafo pausou sem um pedido de revisão.');
    state = await graph.invoke(new Command({ resume: await reviewer(request) }), config);
  }
  return state;
}
