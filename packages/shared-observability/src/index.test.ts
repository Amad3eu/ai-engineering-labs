import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLlmCall, logger, logLlmCall, resetLlmMetrics, summarizeLlmCalls } from './index.js';

logger.level = 'silent';

test('formata a linha de métricas com as cinco etiquetas, nesta ordem', () => {
  const line = formatLlmCall({
    model: 'gpt-6-luna',
    latencyMs: 812.4,
    tokensIn: 120,
    tokensOut: 45,
    estimatedCostUsd: 0.000045,
    cacheHit: false,
  });
  assert.equal(
    line,
    '[MODEL] gpt-6-luna [LATENCY_MS] 812 [TOKENS_IN/OUT] 120/45 [ESTIMATED_COST_USD] 0.000045 [CACHE_HIT] false',
  );
});

test('soma as chamadas registradas e conta os cache hits', () => {
  resetLlmMetrics();
  logLlmCall({ model: 'a', latencyMs: 100, tokensIn: 10, tokensOut: 5, estimatedCostUsd: 0.001, cacheHit: false });
  logLlmCall({ model: 'a', latencyMs: 300, tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, cacheHit: true });

  assert.deepEqual(summarizeLlmCalls(), {
    calls: 2,
    cacheHits: 1,
    tokensIn: 10,
    tokensOut: 5,
    estimatedCostUsd: 0.001,
    avgLatencyMs: 200,
  });
});
