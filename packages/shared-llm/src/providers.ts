import { logger } from '@labs/shared-observability';
import OpenAI from 'openai';
import { mockProvider } from './mock.js';
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_MODELS, type ProviderName, type TierModels } from './models.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Quando presente, pede saída JSON aderente a este JSON Schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  label?: string;
}

export interface ChatOutput {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface EmbedParams {
  model: string;
  texts: string[];
  dimensions?: number;
}

export interface EmbedOutput {
  vectors: number[][];
  tokensIn: number;
}

/**
 * Contrato mínimo de um provedor. Tudo o que é comum (fallback, roteamento, validação,
 * custo, métricas) fica em `createLlm`, fora daqui.
 *
 * PONTO DE EXTENSÃO: um provedor que não fala o protocolo da OpenAI (SDK nativo da
 * Anthropic, Bedrock, um modelo servido por você) entra implementando esta interface.
 */
export interface Provider {
  readonly name: ProviderName;
  readonly models: TierModels;
  readonly embeddingModel: string;
  chat(params: ChatParams): Promise<ChatOutput>;
  embed(params: EmbedParams): Promise<EmbedOutput>;
}

export interface OpenAiCompatibleConfig {
  name: ProviderName;
  baseURL: string;
  apiKey: string;
  models: TierModels;
  embeddingModel: string;
  /** O modelo de embedding aceita `dimensions` (modelos Matryoshka)? */
  supportsEmbeddingDimensions?: boolean;
  /** Novas tentativas do próprio SDK antes de o erro subir para o fallback. Padrão: 2. */
  maxRetries?: number;
}

/**
 * OpenAI, Gemini, OpenRouter e Ollama expõem o mesmo protocolo (`/chat/completions` e
 * `/embeddings`). Um adaptador só, quatro provedores: muda a URL base e a chave.
 */
export function openAiCompatible(config: OpenAiCompatibleConfig): Provider {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxRetries: config.maxRetries ?? 2,
    timeout: 120_000,
  });

  return {
    name: config.name,
    models: config.models,
    embeddingModel: config.embeddingModel,

    async chat({ model, messages, temperature, jsonSchema }) {
      const response = await client.chat.completions.create({
        model,
        messages,
        // Só vai no corpo quando o chamador define: a família GPT-6 recusa `temperature`.
        temperature,
        // `strict` exige todo campo como obrigatório: nos schemas, use `.nullable()`, não `.optional()`.
        response_format: jsonSchema ? { type: 'json_schema', json_schema: { ...jsonSchema, strict: true } } : undefined,
      });
      return {
        text: response.choices[0]?.message.content ?? '',
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
      };
    },

    async embed({ model, texts, dimensions }) {
      const response = await client.embeddings.create({
        model,
        input: texts,
        // Sem isto o SDK pede base64, que nem todo servidor compatível devolve.
        encoding_format: 'float',
        dimensions: config.supportsEmbeddingDimensions ? dimensions : undefined,
      });
      return {
        vectors: response.data.map((item) => item.embedding),
        tokensIn: response.usage?.prompt_tokens ?? 0,
      };
    },
  };
}

const DEFAULT_ORDER: ProviderName[] = ['openai', 'gemini', 'openrouter', 'ollama'];

function isProviderName(name: string): name is ProviderName {
  return name === 'mock' || (DEFAULT_ORDER as string[]).includes(name);
}

/**
 * Monta a cadeia de fallback a partir do ambiente. A ordem é a de `LLM_PROVIDERS`
 * (padrão: openai, gemini, openrouter, ollama) e só entra quem tem credencial.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const build: Record<ProviderName, () => Provider | undefined> = {
    openai: () =>
      env.OPENAI_API_KEY
        ? openAiCompatible({
            name: 'openai',
            baseURL: 'https://api.openai.com/v1',
            apiKey: env.OPENAI_API_KEY,
            models: DEFAULT_MODELS.openai,
            embeddingModel: DEFAULT_EMBEDDING_MODELS.openai,
            supportsEmbeddingDimensions: true,
          })
        : undefined,
    gemini: () =>
      env.GEMINI_API_KEY
        ? openAiCompatible({
            name: 'gemini',
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
            apiKey: env.GEMINI_API_KEY,
            models: DEFAULT_MODELS.gemini,
            embeddingModel: DEFAULT_EMBEDDING_MODELS.gemini,
            supportsEmbeddingDimensions: true,
          })
        : undefined,
    openrouter: () =>
      env.OPENROUTER_API_KEY
        ? openAiCompatible({
            name: 'openrouter',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: env.OPENROUTER_API_KEY,
            models: DEFAULT_MODELS.openrouter,
            embeddingModel: DEFAULT_EMBEDDING_MODELS.openrouter,
            supportsEmbeddingDimensions: true,
          })
        : undefined,
    ollama: () => {
      if (!env.OLLAMA_BASE_URL) return undefined;
      // Modelo local é escolha de quem baixou: uma variável só, para as três faixas.
      const model = env.OLLAMA_MODEL || 'llama3.2';
      return openAiCompatible({
        name: 'ollama',
        baseURL: `${env.OLLAMA_BASE_URL.replace(/\/+$/, '')}/v1`,
        apiKey: 'ollama', // o SDK exige uma chave; o Ollama ignora
        models: { fast: model, balanced: model, powerful: model },
        embeddingModel: env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
      });
    },
    mock: mockProvider,
  };

  const requested = env.LLM_PROVIDERS?.split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const providers = (requested?.length ? requested : DEFAULT_ORDER).flatMap((name) => {
    if (!isProviderName(name)) {
      throw new Error(`LLM_PROVIDERS: provedor desconhecido "${name}". Use: ${[...DEFAULT_ORDER, 'mock'].join(', ')}.`);
    }
    return build[name]() ?? [];
  });
  if (providers.length > 0) return providers;

  // Pediu provedores por nome e nenhum tem credencial: é erro de configuração. Cair no
  // mock aqui devolveria resposta falsa para quem acha que está falando com um modelo.
  if (requested?.length) {
    throw new Error(`LLM_PROVIDERS=${env.LLM_PROVIDERS}, mas nenhum desses provedores tem credencial no ambiente.`);
  }

  logger.warn(
    '[LLM] nenhuma chave configurada: usando o provedor "mock" (respostas roteirizadas, sem rede). ' +
      'Preencha uma chave no .env para falar com um modelo de verdade.',
  );
  return [mockProvider()];
}
