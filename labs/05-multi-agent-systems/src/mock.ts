import { setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock: o que cada agente responderia no exemplo de index.ts.
// Só tem efeito sem chave de API. A decisão de roteamento segue as mesmas regras que o
// prompt do supervisor pede ao modelo, lidas do resumo de estado que vai no prompt.

function route(prompt: string, members: { research: string; writing: string }) {
  const hasNotes = !prompt.includes('Notas de pesquisa: 0');
  const hasDraft = prompt.includes('Rascunho: sim');
  const feedbackPending = !prompt.includes('Feedback humano pendente: nenhum');

  if (!hasNotes) return { next: members.research, reason: 'Ainda não há notas de pesquisa.' };
  if (!hasDraft) return { next: members.writing, reason: 'Há notas, falta o rascunho.' };
  if (feedbackPending) return { next: members.writing, reason: 'Há feedback humano a atender.' };
  return { next: 'human_review', reason: 'Rascunho pronto, sem pendência.' };
}

const FACTS = [
  '- O checkout ficou 40 minutos indisponível, das 14h05 às 14h45.',
  '- Causa: limite de memória de 128Mi no deploy das 14h.',
  '- Cerca de 1.200 tentativas de pagamento falharam. Valor exato a confirmar.',
].join('\n');

const LONG_DRAFT = [
  'Hoje, entre 14h05 e 14h45, o checkout ficou indisponível e cerca de 1.200 pagamentos falharam.',
  'A causa foi um limite de memória de 128Mi aplicado no deploy das 14h.',
  'O limite foi corrigido e o serviço está estável desde então.',
].join('\n\n');

const SHORT_DRAFT = [
  'Hoje, entre 14h05 e 14h45, o checkout ficou indisponível e cerca de 1.200 pagamentos falharam.',
  'A causa foi um limite de memória baixo aplicado no deploy das 14h, já corrigido.',
].join('\n\n');

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    switch (label) {
      case 'supervisor:route':
        return route(prompt, { research: 'researcher', writing: 'writer' });
      case 'director:route':
        return route(prompt, { research: 'research_team', writing: 'writing_team' });

      case 'agent:researcher':
      case 'research:searcher':
      case 'research:analyst':
        return FACTS;

      case 'agent:writer':
      case 'writing:writer':
        return prompt.includes('Feedback:') ? SHORT_DRAFT : LONG_DRAFT;
      case 'writing:editor':
        return prompt; // o editor do roteiro devolve o texto como recebeu

      default:
        return undefined;
    }
  });
}
