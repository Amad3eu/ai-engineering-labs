import { logger, logLlmCall, timed } from '@labs/shared-observability';
import { z } from 'zod';
import { estimateCostUsd, type ModelTier, type ProviderName } from './models.js';
import { type ChatMessage, type ChatParams, type Provider, providersFromEnv } from './providers.js';
import { routeByComplexity } from './router.js';

export interface GenerateRequest {
  prompt: string;
  system?: string;
  /** Faixa de modelo. `'auto'` (padrão) deixa o roteador decidir pela complexidade do prompt. */
  tier?: ModelTier | 'auto';
  /** Id exato de modelo. Desliga o fallback, porque o id só existe em um provedor. */
  model?: string;
  /** Só é enviada quando definida: nem todo modelo aceita. */
  temperature?: number;
  /** Aparece na linha de métricas e chega ao roteiro do mock. Ex.: "rag:answer". */
  label?: string;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: ProviderName;
  tier: ModelTier;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface ObjectRequest<T> extends GenerateRequest {
  schema: z.ZodType<T>;
  /** Nome do schema enviado ao provedor. Padrão: "output". */
  schemaName?: string;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  provider: ProviderName;
  tokensIn: number;
  costUsd: number;
  latencyMs: number;
}

export interface Llm {
  /** Nomes dos provedores ativos, na ordem do fallback. */
  readonly providers: ProviderName[];
  generateText(request: GenerateRequest): Promise<GenerateResult>;
  /** Saída estruturada: o objeto devolvido já passou pelo schema Zod. */
  generateObject<T>(request: ObjectRequest<T>): Promise<GenerateResult & { object: T }>;
  embed(texts: string[], options?: { dimensions?: number; label?: string }): Promise<EmbedResult>;
}

/** A saída do modelo não virou um objeto válido nem depois da tentativa de correção. */
export class LlmValidationError extends Error {
  readonly rawText: string;

  constructor(issues: string, rawText: string) {
    super(`A saída do modelo não passou na validação do schema:\n${issues}`);
    this.name = 'LlmValidationError';
    this.rawText = rawText;
  }
}

/** Quantas vezes devolvemos o erro de validação ao modelo antes de desistir do provedor. */
const MAX_REPAIR_ATTEMPTS = 1;

const repairPrompt = (issues: string) =>
  `Sua resposta anterior não passou na validação:\n${issues}\nResponda de novo, somente com o JSON corrigido.`;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function toMessages(request: GenerateRequest): ChatMessage[] {
  const user: ChatMessage = { role: 'user', content: request.prompt };
  return request.system ? [{ role: 'system', content: request.system }, user] : [user];
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `$schema` é metadado do documento: alguns provedores recusam chave que não conhecem.
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

function parseStructured<T>(text: string, schema: z.ZodType<T>): { data: T } | { issues: string } {
  let json: unknown;
  try {
    // Modelo que ignora o `response_format` costuma embrulhar o JSON em bloco de código.
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { issues: 'a resposta não é um JSON válido.' };
  }
  const result = schema.safeParse(json);
  return result.success ? { data: result.data } : { issues: z.prettifyError(result.error) };
}

/**
 * Núcleo do wrapper: junta fallback entre provedores, Model Tiering, validação com Zod
 * e métricas. Recebe os provedores prontos, o que deixa testar com provedores falsos.
 */
export function createLlm(providers: Provider[]): Llm {
  const [primary] = providers;
  if (!primary) throw new Error('createLlm: informe ao menos um provedor.');

  /** Uma chamada a um provedor, sempre medida e registrada. Este é o único ponto de saída. */
  const chat = async (provider: Provider, tier: ModelTier, params: ChatParams): Promise<GenerateResult> => {
    const { value, latencyMs } = await timed(() => provider.chat(params));
    const costUsd = estimateCostUsd(provider.name, params.model, value.tokensIn, value.tokensOut);
    logLlmCall({
      model: params.model,
      provider: provider.name,
      label: params.label,
      latencyMs,
      tokensIn: value.tokensIn,
      tokensOut: value.tokensOut,
      estimatedCostUsd: costUsd,
      cacheHit: false,
    });
    return { ...value, model: params.model, provider: provider.name, tier, costUsd, latencyMs };
  };

  /** Tenta os provedores em ordem. Qualquer erro (rede, limite, validação) passa a vez. */
  const withFallback = async <R>(
    request: GenerateRequest,
    attempt: (provider: Provider, model: string, tier: ModelTier) => Promise<R>,
  ): Promise<R> => {
    const tier = !request.tier || request.tier === 'auto' ? routeByComplexity(request.prompt) : request.tier;
    const chain = request.model ? [primary] : providers;
    const errors: unknown[] = [];

    for (const provider of chain) {
      const model = request.model ?? provider.models[tier];
      try {
        return await attempt(provider, model, tier);
      } catch (error) {
        errors.push(error);
        logger.warn(`[FALLBACK] ${provider.name}/${model} falhou: ${errorMessage(error)}`);
      }
    }
    throw new AggregateError(errors, `Todos os provedores falharam (${chain.map((p) => p.name).join(' → ')}).`);
  };

  return {
    providers: providers.map((provider) => provider.name),

    generateText: (request) =>
      withFallback(request, (provider, model, tier) =>
        chat(provider, tier, {
          model,
          messages: toMessages(request),
          temperature: request.temperature,
          label: request.label,
        }),
      ),

    generateObject: <T>(request: ObjectRequest<T>) => {
      const jsonSchema = { name: request.schemaName ?? 'output', schema: toJsonSchema(request.schema) };

      return withFallback(request, async (provider, model, tier) => {
        let messages = toMessages(request);
        for (let repairs = 0; ; repairs++) {
          const result = await chat(provider, tier, {
            model,
            messages,
            temperature: request.temperature,
            jsonSchema,
            label: request.label,
          });
          const parsed = parseStructured(result.text, request.schema);
          if ('data' in parsed) return { ...result, object: parsed.data };
          if (repairs >= MAX_REPAIR_ATTEMPTS) throw new LlmValidationError(parsed.issues, result.text);

          // Devolve o erro ao modelo: a maior parte das falhas de schema se resolve aqui.
          messages = [
            ...messages,
            { role: 'assistant', content: result.text },
            { role: 'user', content: repairPrompt(parsed.issues) },
          ];
        }
      });
    },

    async embed(texts, options = {}) {
      // Sem fallback de propósito: vetores de modelos diferentes vivem em espaços diferentes,
      // e misturá-los no mesmo índice estraga a busca sem dar erro nenhum.
      const model = primary.embeddingModel;
      const { value, latencyMs } = await timed(() => primary.embed({ model, texts, dimensions: options.dimensions }));
      const costUsd = estimateCostUsd(primary.name, model, value.tokensIn, 0);
      logLlmCall({
        model,
        provider: primary.name,
        label: options.label ?? 'embedding',
        latencyMs,
        tokensIn: value.tokensIn,
        tokensOut: 0,
        estimatedCostUsd: costUsd,
        cacheHit: false,
      });
      return { vectors: value.vectors, model, provider: primary.name, tokensIn: value.tokensIn, costUsd, latencyMs };
    },
  };
}

// Instância padrão, montada do ambiente no primeiro uso. É o que os laboratórios importam.
let defaultLlm: Llm | undefined;
const getDefault = (): Llm => {
  defaultLlm ??= createLlm(providersFromEnv());
  return defaultLlm;
};

export const generateText: Llm['generateText'] = (request) => getDefault().generateText(request);
export const generateObject: Llm['generateObject'] = (request) => getDefault().generateObject(request);
export const embed: Llm['embed'] = (texts, options) => getDefault().embed(texts, options);

/** Provedores ativos na ordem do fallback. `['mock']` quer dizer: sem chave, tudo roteirizado. */
export const activeProviders = (): ProviderName[] => getDefault().providers;
