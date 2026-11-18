import { generateText } from '@labs/shared-llm';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { ANALYST_SYSTEM, EDITOR_SYSTEM, RESEARCHER_SYSTEM, WRITER_SYSTEM, writerPrompt } from './prompts.js';
import { createSupervisor, humanReview, TeamState, type TeamStateType, type TeamUpdate } from './supervisor.js';

// Padrão Hierárquico: o coordenador não fala com especialistas, fala com times. Cada time
// é um grafo próprio, com estado próprio, e devolve só o resultado.
//
//   director → research_team (searcher → analyst)
//            → writing_team  (writer → editor)
//            → human_review
//
// Vale quando um supervisor único teria membros demais para escolher bem, ou quando um
// time precisa de passos internos que não interessam a quem coordena.

// --- Time de pesquisa ------------------------------------------------------------------

const ResearchState = Annotation.Root({
  task: Annotation<string>,
  rawFacts: Annotation<string>,
  findings: Annotation<string>,
});

const researchTeam = new StateGraph(ResearchState)
  .addNode('searcher', async (state) => {
    const { text } = await generateText({
      system: RESEARCHER_SYSTEM,
      prompt: `Tarefa: ${state.task}`,
      tier: 'fast',
      label: 'research:searcher',
    });
    return { rawFacts: text };
  })
  .addNode('analyst', async (state) => {
    const { text } = await generateText({
      system: ANALYST_SYSTEM,
      prompt: `Tarefa: ${state.task}\n\nFatos brutos:\n${state.rawFacts}`,
      tier: 'balanced',
      label: 'research:analyst',
    });
    return { findings: text };
  })
  .addEdge(START, 'searcher')
  .addEdge('searcher', 'analyst')
  .addEdge('analyst', END)
  .compile();

// --- Time de redação -------------------------------------------------------------------

const WritingState = Annotation.Root({
  task: Annotation<string>,
  notes: Annotation<string[]>,
  previousDraft: Annotation<string>,
  feedback: Annotation<string>,
  text: Annotation<string>,
});

const writingTeam = new StateGraph(WritingState)
  .addNode('writer', async (state) => {
    const { text } = await generateText({
      system: WRITER_SYSTEM,
      prompt: writerPrompt({ ...state, draft: state.previousDraft }),
      tier: 'balanced',
      label: 'writing:writer',
    });
    return { text };
  })
  .addNode('editor', async (state) => {
    const { text } = await generateText({
      system: EDITOR_SYSTEM,
      prompt: state.text,
      tier: 'fast',
      label: 'writing:editor',
    });
    return { text };
  })
  .addEdge(START, 'writer')
  .addEdge('writer', 'editor')
  .addEdge('editor', END)
  .compile();

// --- Nós do grafo de cima ---------------------------------------------------------------
// Cada time é chamado de dentro de um nó, que traduz o estado do diretor para o do time e
// de volta. Assim o estado interno do time (os fatos brutos, o texto antes da edição) não
// vaza para cima, e os reducers do estado de cima não recebem o histórico em dobro.
// PONTO DE EXTENSÃO: um time novo é um grafo, um nó adaptador e uma entrada em `members`.

async function researchTeamNode(state: TeamStateType): Promise<TeamUpdate> {
  const { findings } = await researchTeam.invoke({ task: state.task });
  return { notes: [findings] };
}

async function writingTeamNode(state: TeamStateType): Promise<TeamUpdate> {
  const { text } = await writingTeam.invoke({
    task: state.task,
    notes: state.notes,
    previousDraft: state.draft,
    feedback: state.feedback,
  });
  return { draft: text, feedback: '' };
}

export const hierarchicalGraph = new StateGraph(TeamState)
  .addNode(
    'director',
    createSupervisor({
      members: {
        research_team: 'time de pesquisa: levanta e prioriza os fatos.',
        writing_team: 'time de redação: escreve, reescreve com o feedback e revisa o texto.',
      },
      drafter: 'writing_team',
      label: 'director:route',
    }),
  )
  .addNode('research_team', researchTeamNode)
  .addNode('writing_team', writingTeamNode)
  .addNode('human_review', humanReview)
  .addEdge(START, 'director')
  .addConditionalEdges('director', (state) => state.next, {
    research_team: 'research_team',
    writing_team: 'writing_team',
    human_review: 'human_review',
    finish: END,
  })
  .addEdge('research_team', 'director')
  .addEdge('writing_team', 'director')
  .addEdge('human_review', 'director')
  .compile({ checkpointer: new MemorySaver() });
