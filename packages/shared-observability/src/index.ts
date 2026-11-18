import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pino } from 'pino';
import pretty from 'pino-pretty';

// O .env da raiz é carregado aqui porque este pacote é a base do grafo de dependências:
// ele é avaliado antes de @labs/shared-llm e @labs/shared-vector lerem chaves e URLs.
// Variável já definida no ambiente vence o arquivo: `LLM_PROVIDERS=mock pnpm ...` funciona.
function loadWorkspaceEnv(): void {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return; // fora do monorepo: não carrega nada
    dir = parent;
  }
  const envFile = join(dir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
loadWorkspaceEnv();

// Logs vão para stderr: stdout fica livre para a saída do programa e para o protocolo
// MCP via stdio, que quebra se qualquer outra coisa for escrita nele.
const STDERR = 2;

/**
 * Logger estruturado do monorepo.
 * - Terminal (padrão): uma linha limpa por evento.
 * - `LOG_FORMAT=json`: JSON por linha, com todos os campos, para coletar em produção.
 */
export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info', base: null },
  process.env.LOG_FORMAT === 'json'
    ? pino.destination({ dest: STDERR, sync: true })
    : pretty({ destination: STDERR, sync: true, hideObject: true, translateTime: 'SYS:HH:MM:ss' }),
);

export interface LlmCallMetrics {
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  cacheHit: boolean;
  /** Provedor que atendeu: openai, gemini, openrouter, ollama ou mock. */
  provider?: string;
  /** Rótulo livre do ponto de chamada, ex.: "rag:answer". */
  label?: string;
}

export interface LlmUsageSummary {
  calls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
}

const recorded: LlmCallMetrics[] = [];

/** Linha de terminal de uma chamada de LLM. O formato das etiquetas é contrato do monorepo. */
export function formatLlmCall(metrics: LlmCallMetrics): string {
  const line = [
    `[MODEL] ${metrics.model}`,
    `[LATENCY_MS] ${Math.round(metrics.latencyMs)}`,
    `[TOKENS_IN/OUT] ${metrics.tokensIn}/${metrics.tokensOut}`,
    `[ESTIMATED_COST_USD] ${metrics.estimatedCostUsd.toFixed(6)}`,
    `[CACHE_HIT] ${metrics.cacheHit}`,
  ].join(' ');
  return metrics.label ? `${line} · ${metrics.label}` : line;
}

/**
 * Registra uma chamada de LLM (ou um acerto de cache que a evitou).
 * `@labs/shared-llm` chama isto em toda requisição; código de laboratório só precisa
 * chamar direto quando responde sem passar pelo LLM, como num cache hit.
 */
export function logLlmCall(metrics: LlmCallMetrics): void {
  recorded.push(metrics);
  logger.info(metrics, formatLlmCall(metrics));
}

/** Totais das chamadas registradas desde o último `resetLlmMetrics()`. */
export function summarizeLlmCalls(): LlmUsageSummary {
  const sum = (pick: (m: LlmCallMetrics) => number) => recorded.reduce((total, m) => total + pick(m), 0);
  return {
    calls: recorded.length,
    cacheHits: recorded.filter((m) => m.cacheHit).length,
    tokensIn: sum((m) => m.tokensIn),
    tokensOut: sum((m) => m.tokensOut),
    estimatedCostUsd: sum((m) => m.estimatedCostUsd),
    avgLatencyMs: recorded.length ? sum((m) => m.latencyMs) / recorded.length : 0,
  };
}

/** Zera o acumulado. Use antes de cada braço de um benchmark. */
export function resetLlmMetrics(): void {
  recorded.length = 0;
}

/** Mede a duração de uma operação assíncrona em milissegundos. */
export async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, latencyMs: performance.now() - start };
}
