import { type MockResponder, setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock para o pipeline: regras de palavra-chave no lugar do modelo.
// Só tem efeito sem chave de API (ou com LLM_PROVIDERS=mock, que é o que o CI usa).
// Deixa o fluxo de decisão rodar inteiro, sem rede e sempre igual. NÃO mede a qualidade do
// roteador nem do grader: para isso, rode com um provedor real.

// Termos que, neste corpus, indicam que a resposta depende do manual interno.
const INTERNAL = /ERR-\d+|limite|cabeçalho|deploy|backup|plano|reembolso|política|prazo|plantão|chave|credencia/i;

const between = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? '';

/** Palavras com 5 letras ou mais, sem acento: descarta artigos e preposições sem lista de stopwords. */
const contentWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .match(/[a-z0-9]{5,}/g) ?? [],
  );

function grade(question: string, chunk: string) {
  // Pergunta com código de erro: só serve o trecho que cita exatamente aquele código.
  const code = question.match(/ERR-\d+/i)?.[0];
  if (code) {
    const relevant = chunk.toUpperCase().includes(code.toUpperCase());
    return { reason: `O trecho ${relevant ? 'cita' : 'não cita'} o código ${code}.`, relevant };
  }
  const inChunk = contentWords(chunk);
  const shared = [...contentWords(question)].filter((word) => inChunk.has(word));
  return {
    reason: `Palavras da pergunta presentes no trecho: ${shared.join(', ') || 'nenhuma'}.`,
    relevant: shared.length >= 2,
  };
}

export const mockScript: MockResponder = ({ label, prompt }) => {
  switch (label) {
    case 'pipeline:intent': {
      const internal = INTERNAL.test(between(prompt, 'pergunta'));
      return internal
        ? { reason: 'A resposta depende do manual interno.', intent: 'consulta-tecnica' }
        : { reason: 'Dúvida geral, sem regra interna envolvida.', intent: 'faq-simples' };
    }
    case 'pipeline:grade':
      return grade(between(prompt, 'pergunta'), between(prompt, 'trecho'));
    case 'pipeline:faq':
      return 'Resposta direta do modelo barato, sem consulta a documentos. [resposta roteirizada do mock]';
    case 'pipeline:synthesize': {
      const sources = [...new Set(prompt.match(/^\[[\w-]+\]/gm) ?? [])];
      return `Resposta montada só com os trechos aprovados pelo grader, de ${sources.join(' e ')}. [resposta roteirizada do mock]`;
    }
    default:
      return undefined;
  }
};

export function installMockScript(): void {
  setMockResponder(mockScript);
}
