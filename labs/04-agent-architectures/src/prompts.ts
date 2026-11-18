// Prompts dos três padrões. Ficam fora dos grafos: a topologia (quem chama quem) e o texto
// (o que cada nó pede ao modelo) mudam por motivos diferentes.

// --- ReAct -----------------------------------------------------------------------------

export const reactSystem = (
  tools: string,
) => `Você resolve a pergunta do usuário em ciclos de Pensamento, Ação e Observação.

Ferramentas:
${tools}
- finish: encerra o trabalho. Entrada: a resposta final ao usuário.

Regras:
- Uma ferramenta por vez. Espere a observação antes de decidir o próximo passo.
- Nunca invente um dado que uma ferramenta pode fornecer.
- Se uma observação trouxer erro, corrija a entrada e tente de novo.
- Quando tiver tudo o que precisa, use "finish".`;

export const reactPrompt = (question: string, scratchpad: string[]) =>
  `Pergunta: ${question}\n\nHistórico:\n${scratchpad.length > 0 ? scratchpad.join('\n') : '(nenhum passo ainda)'}`;

// --- Plan-and-Execute ------------------------------------------------------------------

export const PLAN_SYSTEM = `Você é o planejador. Quebre o objetivo em no máximo 5 passos curtos, em ordem.
Cada passo precisa ser executável sozinho por alguém que só vê o objetivo e os resultados anteriores.
Não execute nada: só planeje.`;

export const EXECUTE_SYSTEM = `Você é o executor. Execute somente o passo pedido, usando os resultados anteriores.
Responda em até 3 frases, só com o resultado do passo.`;

export const executePrompt = (objective: string, step: string, results: string[]) =>
  `Objetivo: ${objective}\n\nResultados anteriores:\n${results.length > 0 ? results.join('\n') : '(nenhum)'}\n\nPasso a executar: ${step}`;

export const SYNTHESIZE_SYSTEM = `Você escreve a resposta final ao usuário a partir dos resultados dos passos.
Seja direto e não acrescente nada que não esteja nos resultados.`;

export const synthesizePrompt = (objective: string, results: string[]) =>
  `Objetivo: ${objective}\n\nResultados dos passos:\n${results.join('\n')}`;

// --- Reflection ------------------------------------------------------------------------

export const GENERATE_SYSTEM = `Você escreve comunicados de incidente para a diretoria.
Se houver crítica a uma versão anterior, reescreva atendendo a todos os pontos dela.
Responda só com o texto do comunicado.`;

export const generatePrompt = (task: string, draft: string | undefined, feedback: string | undefined) =>
  draft && feedback ? `Tarefa: ${task}\n\nVersão anterior:\n${draft}\n\nCrítica:\n${feedback}` : `Tarefa: ${task}`;

// A rubrica é o que faz a reflexão funcionar: "melhore o texto" não dá ao crítico um critério
// de parada, e o laço só termina por esgotar as rodadas.
export const REFLECT_SYSTEM = `Você é o revisor. Avalie o comunicado contra a rubrica:
1. Tem no máximo 3 frases.
2. Diz o impacto para o cliente.
3. Diz a causa.
4. Diz o próximo passo, com responsável ou prazo.
Aprove só se os quatro itens forem atendidos. Se reprovar, liste em "feedback" o que falta.`;

export const reflectPrompt = (task: string, draft: string) => `Tarefa: ${task}\n\nComunicado:\n${draft}`;
