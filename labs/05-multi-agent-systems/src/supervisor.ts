import { generateObject, generateText } from '@labs/shared-llm';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { requestReview } from './hitl.js';
import { RESEARCHER_SYSTEM, supervisorPrompt, supervisorSystem, WRITER_SYSTEM, writerPrompt } from './prompts.js';

// Padrão Supervisor: um agente coordenador decide, a cada volta, qual especialista age.
//
//   supervisor → researcher | writer | human_review → supervisor → … → fim
//
// Os especialistas não se falam: tudo passa pelo estado compartilhado e pelo supervisor.

/** Teto de decisões do supervisor. Protege contra um laço entre dois agentes. */
const MAX_TURNS = 10;

export const TeamState = Annotation.Root({
  task: Annotation<string>,
  notes: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  draft: Annotation<string>,
  /** Feedback humano ainda não atendido. Vazio quando não há pendência. */
  feedback: Annotation<string>,
  approved: Annotation<boolean>,
  next: Annotation<string>,
  turns: Annotation<number>({ reducer: (total, more) => total + more, default: () => 0 }),
});
export type TeamStateType = typeof TeamState.State;
export type TeamUpdate = typeof TeamState.Update;

/**
 * Cria o nó coordenador. O modelo escolhe o próximo membro; as regras duras ficam em código:
 *
 * - "encerrar" não é uma opção do modelo: o trabalho só termina com `approved`, que vem
 *   de uma pessoa. O guardrail vale por construção, não por instrução no prompt.
 * - sem rascunho não existe o que revisar: o pedido de revisão é trocado pela redação.
 * - `MAX_TURNS` encerra um laço que não converge.
 */
export function createSupervisor(options: { members: Record<string, string>; drafter: string; label: string }) {
  const Decision = z.object({
    next: z.enum([...Object.keys(options.members), 'human_review']),
    reason: z.string().describe('Uma frase explicando a escolha.'),
  });

  return async function supervisor(state: TeamStateType): Promise<TeamUpdate> {
    if (state.approved || state.turns >= MAX_TURNS) return { next: 'finish' };

    const { object } = await generateObject({
      system: supervisorSystem(options.members),
      prompt: supervisorPrompt(state),
      schema: Decision,
      schemaName: 'routing_decision',
      tier: 'fast', // decisão de roteamento é curta e frequente: modelo barato
      label: options.label,
    });
    const next = object.next === 'human_review' && !state.draft ? options.drafter : object.next;
    return { next, turns: 1 };
  };
}

async function researcher(state: TeamStateType): Promise<TeamUpdate> {
  const { text } = await generateText({
    system: RESEARCHER_SYSTEM,
    prompt: `Tarefa: ${state.task}`,
    tier: 'fast',
    label: 'agent:researcher',
  });
  return { notes: [text] };
}

async function writer(state: TeamStateType): Promise<TeamUpdate> {
  const { text } = await generateText({
    system: WRITER_SYSTEM,
    prompt: writerPrompt(state),
    tier: 'balanced',
    label: 'agent:writer',
  });
  return { draft: text, feedback: '' }; // o feedback foi atendido: sai da fila
}

/** Nó de aprovação humana. Só faz a pausa: veja o aviso em `requestReview`. */
export function humanReview(state: TeamStateType): TeamUpdate {
  const decision = requestReview({ draft: state.draft });
  return { approved: decision.approved, feedback: decision.feedback };
}

export const supervisorGraph = new StateGraph(TeamState)
  .addNode(
    'supervisor',
    createSupervisor({
      members: {
        researcher: 'levanta os fatos necessários para a tarefa.',
        writer: 'escreve ou reescreve o texto a partir das notas e do feedback.',
      },
      drafter: 'writer',
      label: 'supervisor:route',
    }),
  )
  .addNode('researcher', researcher)
  .addNode('writer', writer)
  .addNode('human_review', humanReview)
  .addEdge(START, 'supervisor')
  .addConditionalEdges('supervisor', (state) => state.next, {
    researcher: 'researcher',
    writer: 'writer',
    human_review: 'human_review',
    finish: END,
  })
  .addEdge('researcher', 'supervisor')
  .addEdge('writer', 'supervisor')
  .addEdge('human_review', 'supervisor')
  // Sem checkpointer não há onde guardar o estado pausado, e `interrupt()` falha.
  .compile({ checkpointer: new MemorySaver() });
