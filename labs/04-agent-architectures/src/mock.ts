import { setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock: as respostas que um modelo daria nos exemplos de index.ts.
// Só tem efeito sem chave de API. Mostra o formato que cada nó espera do modelo e deixa
// os três grafos rodarem de ponta a ponta, sem rede e sempre iguais.

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

const REACT_STEPS = [
  { thought: 'Preciso do custo mensal do checkout.', action: 'lookup_service', input: 'checkout' },
  { thought: 'O custo anual é o mensal vezes 12.', action: 'calculate', input: '4200 * 12' },
  {
    thought: 'Já tenho o dono e o custo anual.',
    action: 'finish',
    input: 'O checkout é do time de pagamentos e custa 50.400 USD por ano (4.200 USD por mês × 12).',
  },
];

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    switch (label) {
      // ReAct: a resposta depende de quantas observações já existem no histórico.
      case 'react:reason':
        return REACT_STEPS[Math.min(count(prompt, /^Observação:/gm), REACT_STEPS.length - 1)];

      case 'plan:plan':
        return {
          steps: [
            'Listar os serviços do catálogo com o custo mensal de cada um',
            'Identificar o serviço mais caro',
            'Propor uma ação de redução de custo para ele',
          ],
        };
      case 'plan:execute':
        return `Passo concluído com os dados disponíveis. [resposta roteirizada do mock]`;
      case 'plan:synthesize':
        return 'O serviço mais caro é o checkout; a ação proposta é revisar o dimensionamento dele. [resposta roteirizada do mock]';

      // Reflection: a primeira versão sai incompleta de propósito, para o laço dar uma volta.
      case 'reflection:generate':
        return prompt.includes('Crítica:')
          ? 'O checkout ficou 40 minutos fora do ar e os clientes não conseguiram pagar. A causa foi um limite de memória baixo no deploy das 14h. O time de pagamentos revisa os limites dos demais serviços até sexta-feira.'
          : 'O checkout ficou 40 minutos fora do ar e os clientes não conseguiram pagar. A causa foi um limite de memória baixo no deploy das 14h.';
      case 'reflection:reflect':
        return prompt.includes('até sexta-feira')
          ? { approved: true, feedback: '' }
          : { approved: false, feedback: 'Falta o próximo passo, com responsável ou prazo (item 4 da rubrica).' };

      default:
        return undefined;
    }
  });
}
