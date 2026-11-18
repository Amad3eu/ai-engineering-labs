// Lab 06: Copiloto de DevOps
//
// Um agente ReAct que investiga um incidente em Kubernetes: lê o estado dos pods, o
// describe e os logs, e valida uma correção de manifesto em dry-run. Não aplica nada.
//
// O laço ReAct está escrito à mão, sem framework, de propósito: são poucas linhas, e ver
// o laço inteiro deixa claro o que o LangGraph automatiza no lab 04.
//
// Rodar: pnpm --filter @labs/06-ai-devops-copilot dev

import { activeProviders, generateObject } from '@labs/shared-llm';
import { summarizeLlmCalls } from '@labs/shared-observability';
import { z } from 'zod';
import { installMockScript } from './mock.js';
import { copilotPrompt, copilotSystem } from './prompts.js';
import { describeTools, TOOLS } from './tools.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

// --- Guardrails em código ---------------------------------------------------------------
// Nenhum destes limites depende de o modelo obedecer ao prompt.

/** Teto de passos: uma investigação que não converge para, em vez de gastar sem fim. */
const MAX_STEPS = 8;
/** Teto por observação: um log gigante não pode tomar o contexto nem a conta. */
const MAX_OBSERVATION_CHARS = 3000;

// O modelo só pode escolher entre estas ações. Não há ferramenta que escreva no cluster
// nem que execute comando: "aplicar" não está na lista, então não acontece.
const Step = z.object({
  thought: z.string().describe('Raciocínio curto: o que a última observação mostrou e o que falta.'),
  action: z.enum(['get_pods', 'describe_pod', 'get_logs', 'dry_run_manifest', 'finish']),
  input: z.string().describe('Entrada da ferramenta. Com a ação "finish", o relatório final.'),
});

async function investigate(incident: string): Promise<{ report: string; steps: number; finished: boolean }> {
  const history: string[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    // Pensar: o modelo vê o incidente e tudo o que já foi observado, e escolhe uma ação.
    const { object } = await generateObject({
      system: copilotSystem(describeTools()),
      prompt: copilotPrompt(incident, history),
      schema: Step,
      schemaName: 'copilot_step',
      tier: 'balanced',
      label: 'copilot:reason',
    });
    console.log(`\n[${step}] ${object.thought}`);

    if (object.action === 'finish') return { report: object.input, steps: step, finished: true };

    // Agir: o código executa a ferramenta. Observar: o resultado volta para o histórico.
    console.log(`    → ${object.action}(${object.input})`);
    const observation = (await TOOLS[object.action].run(object.input)).slice(0, MAX_OBSERVATION_CHARS);
    history.push(
      `Pensamento: ${object.thought}`,
      `Ação: ${object.action}(${object.input})`,
      // As tags separam dado de instrução: o system prompt manda tratar o miolo como texto.
      `<observacao>\n${observation}\n</observacao>`,
    );
  }

  return {
    report: `Investigação interrompida em ${MAX_STEPS} passos, sem conclusão. Histórico parcial:\n${history.join('\n')}`,
    steps: MAX_STEPS,
    finished: false,
  };
}

// PONTO DE EXTENSÃO: troque o incidente, ou acrescente arquivos em data/ para outro cenário.
const incident = 'O serviço checkout está reiniciando sem parar em produção desde as 14h05.';

console.log(`Provedores ativos: ${activeProviders().join(' → ')}`);
console.log(`Incidente: ${incident}`);

const { report, steps, finished } = await investigate(incident);

console.log(`\n=== Relatório${finished ? '' : ' (incompleto)'} ===\n${report}`);

// PONTO DE EXTENSÃO: para aplicar a mudança recomendada, passe o relatório por uma
// aprovação humana (lab 05) e só então chame a ferramenta de escrita, fora do agente.

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
const usage = summarizeLlmCalls();
console.table([
  {
    passos: steps,
    concluiu: finished,
    'chamadas ao LLM': usage.calls,
    'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
    'latência total (ms)': Math.round(usage.avgLatencyMs * usage.calls),
    'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
  },
]);
