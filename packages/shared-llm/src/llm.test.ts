import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { logger } from '@labs/shared-observability';
import { z } from 'zod';
import {
  createLlm,
  estimateCostUsd,
  LlmValidationError,
  mockProvider,
  openAiCompatible,
  type Provider,
  type ProviderName,
  providersFromEnv,
  routeByComplexity,
  setMockResponder,
} from './index.js';

logger.level = 'silent';
afterEach(() => setMockResponder(undefined));

const TIERS = { fast: 'm-fast', balanced: 'm-balanced', powerful: 'm-powerful' };

/** Provedor falso: responde com os textos da fila, na ordem. Um Error na fila é lançado. */
function fakeProvider(name: ProviderName, replies: Array<string | Error>) {
  const prompts: string[] = [];
  const provider: Provider = {
    name,
    models: TIERS,
    embeddingModel: `${name}-embedding`,
    async chat({ messages }) {
      prompts.push(messages.at(-1)?.content ?? '');
      const reply = replies.shift() ?? new Error('fila vazia');
      if (reply instanceof Error) throw reply;
      return { text: reply, tokensIn: 10, tokensOut: 5 };
    },
    async embed({ texts }) {
      return { vectors: texts.map(() => [1, 0]), tokensIn: texts.length };
    },
  };
  return { provider, prompts };
}

const Ticket = z.object({ category: z.enum(['billing', 'outage']), urgent: z.boolean() });

test('fallback: quando o primeiro provedor falha, o segundo atende na mesma faixa', async () => {
  const down = fakeProvider('openai', [new Error('503')]);
  const up = fakeProvider('gemini', ['olá']);
  const llm = createLlm([down.provider, up.provider]);

  const result = await llm.generateText({ prompt: 'oi', tier: 'balanced' });

  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'm-balanced');
  assert.equal(result.text, 'olá');
});

test('fallback: todos falhando, o erro lista a cadeia tentada', async () => {
  const llm = createLlm([
    fakeProvider('openai', [new Error('a')]).provider,
    fakeProvider('gemini', [new Error('b')]).provider,
  ]);

  await assert.rejects(llm.generateText({ prompt: 'oi' }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /openai → gemini/);
    assert.equal(error.errors.length, 2);
    return true;
  });
});

test('modelo explícito desliga o fallback', async () => {
  const first = fakeProvider('openai', [new Error('404 model not found')]);
  const second = fakeProvider('gemini', ['não deveria ser chamado']);
  const llm = createLlm([first.provider, second.provider]);

  await assert.rejects(llm.generateText({ prompt: 'oi', model: 'ft:meu-modelo' }));
  assert.equal(second.prompts.length, 0);
});

test('generateObject devolve o objeto já validado pelo schema', async () => {
  const { provider } = fakeProvider('openai', ['```json\n{"category":"outage","urgent":true}\n```']);

  const { object } = await createLlm([provider]).generateObject({ prompt: 'site fora do ar', schema: Ticket });

  assert.deepEqual(object, { category: 'outage', urgent: true });
});

test('generateObject devolve o erro de validação ao modelo e aceita a correção', async () => {
  const { provider, prompts } = fakeProvider('openai', [
    '{"category":"spam","urgent":true}',
    '{"category":"billing","urgent":false}',
  ]);

  const { object } = await createLlm([provider]).generateObject({ prompt: 'cobrança duplicada', schema: Ticket });

  assert.deepEqual(object, { category: 'billing', urgent: false });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? '', /não passou na validação/);
});

test('generateObject: saída inválida duas vezes passa a vez ao próximo provedor', async () => {
  const stubborn = fakeProvider('openai', ['não é json', 'ainda não é json']);
  const correct = fakeProvider('gemini', ['{"category":"outage","urgent":true}']);

  const result = await createLlm([stubborn.provider, correct.provider]).generateObject({
    prompt: 'api caiu',
    schema: Ticket,
  });

  assert.equal(result.provider, 'gemini');
  assert.equal(stubborn.prompts.length, 2);
});

test('generateObject: sem provedor que acerte, o erro de validação aparece na causa', async () => {
  const { provider } = fakeProvider('openai', ['{}', '{}']);

  await assert.rejects(createLlm([provider]).generateObject({ prompt: 'x', schema: Ticket }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof LlmValidationError);
    return true;
  });
});

test('embed usa só o primeiro provedor: vetores de modelos diferentes não se misturam', async () => {
  const llm = createLlm([fakeProvider('openai', []).provider, fakeProvider('gemini', []).provider]);

  const result = await llm.embed(['a', 'b']);

  assert.equal(result.model, 'openai-embedding');
  assert.equal(result.vectors.length, 2);
});

test('roteador: prompt curto vai para fast, análise para balanced, análise longa para powerful', () => {
  assert.equal(routeByComplexity('Traduza "bom dia" para inglês.'), 'fast');
  assert.equal(routeByComplexity('Compare as duas abordagens e justifique a escolha.'), 'balanced');
  assert.equal(routeByComplexity(`Analise o incidente a seguir. ${'detalhe '.repeat(90)}`), 'powerful');
});

test('custo: usa a tabela por milhão de tokens, aceita o prefixo do OpenRouter e zera o que é local', () => {
  assert.equal(estimateCostUsd('openai', 'gpt-6-luna', 1_000_000, 1_000_000), 0.6);
  assert.equal(estimateCostUsd('openrouter', 'openai/gpt-6-luna', 1_000_000, 1_000_000), 0.6);
  assert.equal(estimateCostUsd('ollama', 'llama3.2', 1_000_000, 1_000_000), 0);
  assert.equal(estimateCostUsd('openai', 'modelo-sem-preco', 1_000_000, 1_000_000), 0);
});

test('mock: sem roteiro, gera um objeto mínimo que passa no schema', async () => {
  const { object, provider } = await createLlm([mockProvider()]).generateObject({ prompt: 'x', schema: Ticket });

  assert.equal(provider, 'mock');
  assert.deepEqual(object, { category: 'billing', urgent: false });
});

test('mock: o roteiro recebe prompt, label e schema, e decide a resposta', async () => {
  setMockResponder(({ prompt, label, schema }) => {
    assert.equal(label, 'triage');
    assert.ok(schema);
    return { category: prompt.includes('fora do ar') ? 'outage' : 'billing', urgent: true };
  });

  const { object } = await createLlm([mockProvider()]).generateObject({
    prompt: 'o site está fora do ar',
    schema: Ticket,
    label: 'triage',
  });

  assert.equal(object.category, 'outage');
});

test('mock: embedding é determinístico e aproxima textos com palavras em comum', async () => {
  const llm = createLlm([mockProvider()]);
  const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

  const { vectors } = await llm.embed(['erro ERR-4012 no pagamento', 'pagamento com erro ERR-4012', 'receita de bolo']);
  const [a, b, c] = vectors as [number[], number[], number[]];

  assert.ok(cosine(a, b) > 0.7);
  assert.ok(cosine(a, c) < 0.3);
  assert.deepEqual((await llm.embed(['erro ERR-4012 no pagamento'])).vectors[0], a);
});

test('providersFromEnv: respeita a ordem pedida e só inclui quem tem credencial', () => {
  const providers = providersFromEnv({
    LLM_PROVIDERS: 'gemini, openai, ollama',
    OPENAI_API_KEY: 'k1',
    GEMINI_API_KEY: 'k2',
  });

  assert.deepEqual(
    providers.map((p) => p.name),
    ['gemini', 'openai'],
  );
});

test('providersFromEnv: sem nenhuma chave cai no mock; pedir provedor sem chave é erro', () => {
  assert.deepEqual(
    providersFromEnv({}).map((p) => p.name),
    ['mock'],
  );
  assert.throws(() => providersFromEnv({ LLM_PROVIDERS: 'openai' }), /nenhum desses provedores tem credencial/);
  assert.throws(() => providersFromEnv({ LLM_PROVIDERS: 'gpt' }), /provedor desconhecido/);
});

test('openAiCompatible fala o protocolo de /chat/completions e /embeddings', async () => {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      const url = request.url ?? '';
      received.push({ url, body: z.record(z.string(), z.unknown()).parse(JSON.parse(raw)) });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          url.endsWith('/embeddings')
            ? {
                object: 'list',
                model: 'e',
                data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
                usage: { prompt_tokens: 3, total_tokens: 3 },
              }
            : {
                id: 'x',
                object: 'chat.completion',
                created: 0,
                model: 'm',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
                usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const provider = openAiCompatible({
      name: 'openai',
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'chave-de-teste',
      models: TIERS,
      embeddingModel: 'e',
      supportsEmbeddingDimensions: true,
      maxRetries: 0,
    });

    const chat = await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'oi' }],
      jsonSchema: { name: 'out', schema: { type: 'object' } },
    });
    const embedding = await provider.embed({ model: 'e', texts: ['oi'], dimensions: 2 });

    assert.deepEqual(chat, { text: '{"ok":true}', tokensIn: 7, tokensOut: 2 });
    assert.deepEqual(embedding, { vectors: [[0.1, 0.2]], tokensIn: 3 });

    const [chatCall, embedCall] = received;
    assert.equal(chatCall?.url, '/v1/chat/completions');
    assert.equal(chatCall?.body.model, 'm');
    assert.deepEqual(chatCall?.body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
    assert.ok(!('temperature' in (chatCall?.body ?? {})), 'temperature não vai no corpo quando não é definida');
    assert.equal(embedCall?.url, '/v1/embeddings');
    assert.deepEqual(embedCall?.body, { model: 'e', input: ['oi'], encoding_format: 'float', dimensions: 2 });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
