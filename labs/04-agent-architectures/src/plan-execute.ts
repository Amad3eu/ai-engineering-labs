import { generateObject, generateText } from '@labs/shared-llm';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { EXECUTE_SYSTEM, executePrompt, PLAN_SYSTEM, SYNTHESIZE_SYSTEM, synthesizePrompt } from './prompts.js';

// Plan-and-Execute: um modelo forte planeja uma vez; um modelo barato executa cada passo.
//   planner → executor (uma volta por passo) → synthesizer
// Contra o ReAct: menos chamadas ao modelo caro e um plano que dá para auditar antes de
// rodar. O preço: o plano não reage ao que os passos descobrem.
// PONTO DE EXTENSÃO: um nó "replan" depois de cada passo devolve essa capacidade.

const MAX_PLAN_STEPS = 5;

const Plan = z.object({
  steps: z.array(z.string()).describe('Passos curtos, em ordem, cada um executável sozinho.'),
});

const PlanState = Annotation.Root({
  objective: Annotation<string>,
  plan: Annotation<string[]>,
  results: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  answer: Annotation<string | undefined>,
});
type State = typeof PlanState.State;
type Update = typeof PlanState.Update;

async function plan(state: State): Promise<Update> {
  const { object } = await generateObject({
    system: PLAN_SYSTEM,
    prompt: `Objetivo: ${state.objective}`,
    schema: Plan,
    schemaName: 'plan',
    tier: 'powerful', // planejar é a parte difícil: é aqui que o modelo caro se paga
    label: 'plan:plan',
  });
  // O teto está no prompt e também aqui: o que é limite de verdade não depende do modelo.
  const steps = object.steps.slice(0, MAX_PLAN_STEPS);
  if (steps.length === 0) throw new Error('O planejador devolveu um plano vazio.');
  return { plan: steps };
}

async function execute(state: State): Promise<Update> {
  const step = state.plan[state.results.length];
  if (!step) return {};
  // PONTO DE EXTENSÃO: o executor pode ser o agente ReAct de react.ts, com ferramentas.
  const { text } = await generateText({
    system: EXECUTE_SYSTEM,
    prompt: executePrompt(state.objective, step, state.results),
    tier: 'fast',
    label: 'plan:execute',
  });
  return { results: [`${state.results.length + 1}. ${step} → ${text}`] };
}

async function synthesize(state: State): Promise<Update> {
  const { text } = await generateText({
    system: SYNTHESIZE_SYSTEM,
    prompt: synthesizePrompt(state.objective, state.results),
    tier: 'balanced',
    label: 'plan:synthesize',
  });
  return { answer: text };
}

// Nome de nó não pode repetir nome de campo do estado (`plan`): o LangGraph recusa na montagem.
export const planExecuteGraph = new StateGraph(PlanState)
  .addNode('planner', plan)
  .addNode('executor', execute)
  .addNode('synthesizer', synthesize)
  .addEdge(START, 'planner')
  .addEdge('planner', 'executor')
  .addConditionalEdges('executor', (state) => (state.results.length < state.plan.length ? 'executor' : 'synthesizer'), [
    'executor',
    'synthesizer',
  ])
  .addEdge('synthesizer', END)
  .compile();

export async function runPlanExecute(
  objective: string,
): Promise<{ answer: string; plan: string[]; results: string[] }> {
  const state = await planExecuteGraph.invoke({ objective });
  return { answer: state.answer ?? '', plan: state.plan, results: state.results };
}
