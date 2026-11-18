export interface Tool {
  /** Vai para o prompt: é por este texto que o modelo decide quando e como usar a ferramenta. */
  description: string;
  /** Devolve a observação. Erro volta como texto, para o modelo poder se corrigir no passo seguinte. */
  run(input: string): string;
}

const SERVICE_CATALOG: Record<string, { owner: string; monthlyCostUsd: number; slo: string }> = {
  checkout: { owner: 'time de pagamentos', monthlyCostUsd: 4200, slo: '99,95%' },
  search: { owner: 'time de descoberta', monthlyCostUsd: 2750, slo: '99,9%' },
  notifications: { owner: 'time de engajamento', monthlyCostUsd: 1300, slo: '99,5%' },
};

const OPERATIONS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
};

// PONTO DE EXTENSÃO: uma ferramenta nova é uma entrada aqui e um nome no enum de `Step`
// em react.ts. O compilador acusa se as duas listas divergirem.
export const TOOLS = {
  lookup_service: {
    description:
      'Consulta o catálogo interno de serviços. Entrada: o nome do serviço (checkout, search ou notifications).',
    run(input) {
      const name = input.trim().toLowerCase();
      const service = SERVICE_CATALOG[name];
      if (!service) {
        return `Erro: serviço "${input}" não existe. Serviços: ${Object.keys(SERVICE_CATALOG).join(', ')}.`;
      }
      return `${name}: dono = ${service.owner}; custo mensal = ${service.monthlyCostUsd} USD; SLO = ${service.slo}.`;
    },
  },

  calculate: {
    description:
      'Faz uma operação entre dois números. Entrada: "<número> <operador> <número>", com operador +, -, * ou /. Exemplo: "4200 * 12".',
    run(input) {
      // Saída de modelo nunca passa por eval(): a entrada é conferida pelo formato e só
      // então calculada. Vale para qualquer ferramenta que execute algo.
      const match = input.match(/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$/);
      const operation = OPERATIONS[match?.[2] ?? ''];
      if (!match || !operation) {
        return 'Erro: formato inválido. Use "<número> <operador> <número>", por exemplo "4200 * 12".';
      }
      const [a, b] = [Number(match[1]), Number(match[3])];
      if (match[2] === '/' && b === 0) return 'Erro: divisão por zero.';
      return String(operation(a, b));
    },
  },
} satisfies Record<string, Tool>;

export const describeTools = () =>
  Object.entries(TOOLS)
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join('\n');
