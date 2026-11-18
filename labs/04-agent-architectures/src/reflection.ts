import { generateObject, generateText } from '@labs/shared-llm';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { GENERATE_SYSTEM, generatePrompt, REFLECT_SYSTEM, reflectPrompt } from './prompts.js';

// Reflection: um nó escreve, outro critica contra uma rubrica, e o texto volta para ser
// refeito até passar.
//   generate → reflect → (aprovado ou sem rodadas? fim : generate)
// Troca latência e custo por qualidade: cada rodada são duas chamadas a mais.

/** Teto de rodadas: um crítico exigente demais não pode prender o laço. */
const MAX_ROUNDS = 3;

const Critique = z.object({
  approved: z.boolean(),
  feedback: z.string().describe('O que falta para aprovar. Vazio quando aprovado.'),
});

const ReflectionState = Annotation.Root({
  task: Annotation<string>,
  draft: Annotation<string | undefined>,
  feedback: Annotation<string | undefined>,
  approved: Annotation<boolean>,
  rounds: Annotation<number>({ reducer: (total, more) => total + more, default: () => 0 }),
});
type State = typeof ReflectionState.State;
type Update = typeof ReflectionState.Update;

async function generate(state: State): Promise<Update> {
  const { text } = await generateText({
    system: GENERATE_SYSTEM,
    prompt: generatePrompt(state.task, state.draft, state.feedback),
    tier: 'balanced',
    label: 'reflection:generate',
  });
  return { draft: text, rounds: 1 };
}

async function reflect(state: State): Promise<Update> {
  // PONTO DE EXTENSÃO: use outro modelo ou outro provedor para o crítico. Um modelo
  // revisando o próprio texto tende a concordar consigo mesmo.
  const { object } = await generateObject({
    system: REFLECT_SYSTEM,
    prompt: reflectPrompt(state.task, state.draft ?? ''),
    schema: Critique,
    schemaName: 'critique',
    tier: 'balanced',
    label: 'reflection:reflect',
  });
  return { approved: object.approved, feedback: object.feedback };
}

export const reflectionGraph = new StateGraph(ReflectionState)
  .addNode('generate', generate)
  .addNode('reflect', reflect)
  .addEdge(START, 'generate')
  .addEdge('generate', 'reflect')
  .addConditionalEdges('reflect', (state) => (state.approved || state.rounds >= MAX_ROUNDS ? END : 'generate'), [
    'generate',
    END,
  ])
  .compile();

export async function runReflection(
  task: string,
): Promise<{ draft: string; approved: boolean; rounds: number; lastFeedback: string }> {
  const state = await reflectionGraph.invoke({ task });
  return {
    draft: state.draft ?? '',
    approved: state.approved,
    rounds: state.rounds,
    lastFeedback: state.feedback ?? '',
  };
}
