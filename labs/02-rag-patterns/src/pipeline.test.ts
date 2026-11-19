import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { type MockRequest, setMockResponder } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import type { SearchHit } from '@labs/shared-vector';
import { PIPELINE_BATTERY } from './corpus.js';
import { createMemoryStore } from './memory-store.js';
import { installMockScript, mockScript } from './mock.js';
import { createPipeline, FALLBACK_ANSWER } from './pipeline.js';
import { createSemanticCache } from './semantic-cache.js';

// O pipeline inteiro, sem rede, sem Postgres e sem Redis: provedor mock, cache em memória e
// uma busca que devolve sempre os mesmos três trechos. É este teste que roda no CI.
process.env.LLM_PROVIDERS = 'mock';
logger.level = 'silent';
installMockScript();
afterEach(installMockScript);

const CHUNKS: SearchHit[] = [
  {
    id: 1,
    source: 'runbook-pagamentos',
    score: 0,
    content: 'O código ERR-4012 indica timeout no gateway de pagamento.',
  },
  {
    id: 2,
    source: 'runbook-pagamentos',
    score: 0,
    content: 'O código ERR-4031 indica cartão recusado pela antifraude.',
  },
  { id: 3, source: 'limites-da-api', score: 0, content: 'O plano Pro permite 600 requisições por minuto.' },
];

function setup() {
  const searched: string[] = [];
  const answer = createPipeline({
    cache: createSemanticCache(createMemoryStore().store),
    retrieve: async (question) => {
      searched.push(question);
      return CHUNKS;
    },
  });
  return { answer, searched };
}

/** Grava as chamadas ao modelo, sem mudar as respostas do roteiro. */
function recordCalls(): MockRequest[] {
  const calls: MockRequest[] = [];
  setMockResponder((request) => {
    calls.push(request);
    return mockScript(request);
  });
  return calls;
}

test('a bateria de 6 perguntas sai pelos caminhos esperados', async () => {
  const { answer } = setup();
  const results = [];
  for (const testCase of PIPELINE_BATTERY) results.push(await answer(testCase));

  assert.deepEqual(
    results.map((result) => result.source),
    PIPELINE_BATTERY.map((testCase) => testCase.expectedSource),
  );
  assert.deepEqual(
    results.map((result) => result.source),
    ['agentic-rag', 'cache', 'fast-tier', 'agentic-rag', 'agentic-rag', 'agentic-rag'],
  );

  const [first, second, third, fourth, fifth, sixth] = results;
  // 1: só o trecho do código pedido passa pelo grader.
  assert.deepEqual(first?.retrieval, { retrieved: 3, relevant: 1, sources: ['runbook-pagamentos'] });
  // 2: mesma pergunta, outra redação, outro usuário: acerto no cache global.
  assert.ok((second?.cacheSimilarity ?? 0) >= 0.95);
  assert.equal(second?.answer, first?.answer);
  // 3: dúvida geral não passa pela busca.
  assert.equal(third?.intent, 'faq-simples');
  assert.equal(third?.retrieval, undefined);
  // 5: pergunta idêntica à 4, mas de outro usuário em conversa privada: sem acerto.
  // Se a entrada privada da Ana estivesse visível, a similaridade seria 1. O que o Bruno
  // enxerga são só as entradas globais, de outras perguntas.
  assert.equal(fourth?.fallback, false);
  assert.equal(fifth?.source, 'agentic-rag');
  assert.ok((fifth?.cacheSimilarity ?? 1) < 0.95);
  // 6: fora do escopo: nenhum trecho aprovado, sai o aviso fixo.
  assert.deepEqual(sixth?.retrieval, { retrieved: 3, relevant: 0, sources: [] });
  assert.equal(sixth?.fallback, true);
  assert.equal(sixth?.answer, FALLBACK_ANSWER);
});

test('acerto no cache encerra o fluxo: sem roteador, sem busca, sem síntese', async () => {
  const { answer, searched } = setup();
  const question = 'O que significa o erro ERR-4012?';
  await answer({ question, userId: 'ana', scope: 'global' });

  const calls = recordCalls();
  const searchesBefore = searched.length;
  const cached = await answer({ question, userId: 'bruno', scope: 'global' });

  assert.equal(cached.source, 'cache');
  assert.equal(cached.intent, undefined);
  assert.equal(cached.model, undefined);
  assert.deepEqual(calls, []);
  assert.equal(searched.length, searchesBefore);
});

test('faq-simples usa o modelo mais barato; a consulta técnica sintetiza com o intermediário', async () => {
  const { answer, searched } = setup();
  const calls = recordCalls();

  const faq = await answer({ question: 'O que significa a sigla API?', userId: 'ana', scope: 'global' });
  assert.equal(faq.source, 'fast-tier');
  assert.equal(faq.model, 'mock-fast');
  assert.deepEqual(
    calls.map((call) => call.label),
    ['pipeline:intent', 'pipeline:faq'],
  );
  assert.deepEqual(searched, []);

  const technical = await answer({ question: 'O que significa o erro ERR-4012?', userId: 'ana', scope: 'global' });
  assert.equal(technical.source, 'agentic-rag');
  assert.equal(technical.model, 'mock-balanced');
});

test('a síntese só recebe os trechos que o grader aprovou', async () => {
  const { answer } = setup();
  const calls = recordCalls();

  await answer({ question: 'O que significa o erro ERR-4012?', userId: 'ana', scope: 'global' });

  assert.equal(calls.filter((call) => call.label === 'pipeline:grade').length, CHUNKS.length);
  const synthesis = calls.find((call) => call.label === 'pipeline:synthesize');
  assert.ok(synthesis?.prompt.includes('ERR-4012'));
  assert.ok(!synthesis?.prompt.includes('ERR-4031'));
  assert.ok(!synthesis?.prompt.includes('plano Pro'));
});

test('fallback: não chama o modelo para escrever e não entra no cache', async () => {
  const { answer } = setup();
  const question = 'Qual é a política de reembolso de viagens a trabalho?';
  const calls = recordCalls();

  const first = await answer({ question, userId: 'ana', scope: 'global' });
  const second = await answer({ question, userId: 'ana', scope: 'global' });

  assert.equal(first.fallback, true);
  assert.equal(first.model, undefined);
  assert.ok(!calls.some((call) => call.label === 'pipeline:synthesize'));
  // Se o aviso tivesse sido guardado, a segunda vez sairia do cache.
  assert.equal(second.source, 'agentic-rag');
  assert.equal(second.fallback, true);
});

test('resposta de conversa privada volta para o dono e para mais ninguém', async () => {
  const { answer } = setup();
  const question = 'O que fazer quando aparece ERR-4031?';

  await answer({ question, userId: 'ana', scope: 'user-private' });

  assert.equal((await answer({ question, userId: 'ana', scope: 'user-private' })).source, 'cache');
  assert.equal((await answer({ question, userId: 'bruno', scope: 'user-private' })).source, 'agentic-rag');
  assert.equal((await answer({ question, userId: 'ana', scope: 'global' })).source, 'agentic-rag');
});

test('roteador que devolve intenção fora do enum é recusado pelo schema', async () => {
  const { answer } = setup();
  setMockResponder(({ label }) =>
    label === 'pipeline:intent' ? { reason: 'inventada', intent: 'bate-papo' } : undefined,
  );

  await assert.rejects(answer({ question: 'Oi, tudo bem?', userId: 'ana', scope: 'global' }), AggregateError);
});
