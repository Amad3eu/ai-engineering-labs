import { setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock: um classificador por palavra-chave no lugar do modelo.
// Só tem efeito sem chave de API. Os dois braços do teste A/B caem no mesmo roteiro, então
// dão o mesmo resultado: o mock mostra o fluxo, não compara modelos.

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    if (!label?.startsWith('ab:')) return undefined;
    if (/fora do ar|erro 500|timeout|pararam|caiu|ninguém|não carregam/i.test(prompt)) return 'outage';
    if (/cobra|fatura|nota fiscal|estorno|reembolso|cartão|plano subiu/i.test(prompt)) return 'billing';
    if (/senha|login|entrar|acesso|autenticador|permissão|bloqueada/i.test(prompt)) return 'access';
    return 'question';
  });
}
