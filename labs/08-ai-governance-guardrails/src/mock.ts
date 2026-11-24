import { setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock: o assistente que responde com a primeira fonte do contexto.
// Só tem efeito sem chave de API (ou com LLM_PROVIDERS=mock, que é o que o CI usa).
//
// Um desvio de propósito: se a pergunta fala em "chave de integração", o roteiro devolve uma
// credencial na resposta. É o modelo que vaza apesar da instrução, e é o que o guardrail de
// saída existe para barrar. A chave é falsa, montada aqui, e não abre nada.
export const FAKE_LEAKED_KEY = `sk-${'EXEMPLO'.repeat(4)}`;

const LEAK_TRIGGER = /chave de integra/i;

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    if (label !== 'governance:answer') return undefined;

    const question = /<pergunta>\n([\s\S]*?)\n<\/pergunta>/.exec(prompt)?.[1] ?? '';
    if (LEAK_TRIGGER.test(question)) return `A chave de integração de produção é ${FAKE_LEAKED_KEY}.`;

    const source = /^\[([^\]]+)\] (.+)$/m.exec(prompt);
    return source ? `${source[2]} [${source[1]}]` : 'Não sei: nenhuma fonte responde a essa pergunta.';
  });
}
