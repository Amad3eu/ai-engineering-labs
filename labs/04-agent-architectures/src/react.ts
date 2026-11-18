import { generateObject } from '@labs/shared-llm';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { reactPrompt, reactSystem } from './prompts.js';
import { describeTools, TOOLS } from './tools.js';

// ReAct: o modelo alterna raciocínio e ação. Cada volta do laço é
//   reason (o modelo escolhe a próxima ação) → act (o código executa) → reason …
// até o modelo escolher "finish" ou o limite de passos estourar.

/** Teto de passos. Sem ele, um modelo que insiste na mesma ação gasta até o limite do grafo. */
const MAX_STEPS = 6;

// A ação vem como objeto validado, não como texto para extrair com regex. O esquema é
// plano de propósito (ação + entrada em texto): funciona em qualquer provedor que aceite
// JSON Schema. PONTO DE EXTENSÃO: trocar por tool calling nativo do provedor.
const Step = z.object({
  thought: z.string().describe('Raciocínio curto: o que falta saber e por quê.'),
  action: z.enum(['lookup_service', 'calculate', 'finish']),
  input: z.string().describe('Entrada da ferramenta. Com a ação "finish", a resposta final ao usuário.'),
});
type Step = z.infer<typeof Step>;

const ReactState = Annotation.Root({
  question: Annotation<string>,
  // O reducer acrescenta: cada nó devolve só as linhas novas do histórico.
  scratchpad: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  pending: Annotation<Step | undefined>,
  answer: Annotation<string | undefined>,
});
type State = typeof ReactState.State;
type Update = typeof ReactState.Update;

async function reason(state: State): Promise<Update> {
  const stepsTaken = state.scratchpad.filter((line) => line.startsWith('Observação:')).length;
  if (stepsTaken >= MAX_STEPS) {
    return { answer: `Parei em ${MAX_STEPS} passos sem chegar a uma resposta.` };
  }

  const { object: step } = await generateObject({
    system: reactSystem(describeTools()),
    prompt: reactPrompt(state.question, state.scratchpad),
    schema: Step,
    schemaName: 'react_step',
    tier: 'balanced',
    label: 'react:reason',
  });

  if (step.action === 'finish') return { answer: step.input };
  return {
    pending: step,
    scratchpad: [`Pensamento: ${step.thought}`, `Ação: ${step.action}(${step.input})`],
  };
}

function act(state: State): Update {
  const step = state.pending;
  if (!step || step.action === 'finish') return {};
  // O modelo só escolhe entre as ferramentas do enum: não existe caminho para executar outra coisa.
  return { scratchpad: [`Observação: ${TOOLS[step.action].run(step.input)}`] };
}

export const reactGraph = new StateGraph(ReactState)
  .addNode('reason', reason)
  .addNode('act', act)
  .addEdge(START, 'reason')
  .addConditionalEdges('reason', (state) => (state.answer === undefined ? 'act' : END), ['act', END])
  .addEdge('act', 'reason')
  .compile();

export async function runReact(question: string): Promise<{ answer: string; steps: string[] }> {
  const state = await reactGraph.invoke({ question });
  return { answer: state.answer ?? '', steps: state.scratchpad };
}
