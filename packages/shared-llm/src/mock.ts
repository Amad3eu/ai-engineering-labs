import type { ChatMessage, Provider } from './providers.js';

/** O que o roteiro recebe a cada chamada. `schema` vem preenchido quando a chamada pede JSON. */
export interface MockRequest {
  prompt: string;
  system?: string;
  label?: string;
  schema?: Record<string, unknown>;
}

/**
 * Roteiro do provedor mock. Devolva:
 * - string: vira o texto da resposta;
 * - objeto: é serializado como JSON;
 * - undefined: cai na resposta padrão (objeto mínimo válido para o schema, ou eco do prompt).
 */
export type MockResponder = (request: MockRequest) => unknown;

let responder: MockResponder | undefined;

/** Instala o roteiro determinístico usado quando o provedor ativo é o mock. */
export function setMockResponder(next: MockResponder | undefined): void {
  responder = next;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minimum?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

// shortcut: cobre o que os schemas dos labs usam; formatos de string (email, uuid, data)
// viram "mock" e não validam. Passe um roteiro com setMockResponder quando precisar deles.
function sampleFromSchema(schema: JsonSchema, root: JsonSchema): unknown {
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.replace('#/$defs/', '')];
    return target ? sampleFromSchema(target, root) : null;
  }
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const variant = variants.find((v) => v.type !== 'null') ?? variants[0];
    return variant ? sampleFromSchema(variant, root) : null;
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sampleFromSchema(value, root)]),
      );
    case 'array':
      return schema.items ? [sampleFromSchema(schema.items, root)] : [];
    case 'string':
      return 'mock';
    case 'number':
    case 'integer':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

function lastContent(messages: ChatMessage[], role: ChatMessage['role']): string | undefined {
  return messages.findLast((message) => message.role === role)?.content;
}

/** Estimativa grosseira (≈4 caracteres por token), só para as métricas não ficarem zeradas. */
const approxTokens = (text: string) => Math.ceil(text.length / 4);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Embedding determinístico por hashing de palavras ("hashing trick"): textos com palavras
 * em comum ficam próximos. Não entende sinônimos, mas basta para exercitar o fluxo de RAG
 * e de cache sem chave de API.
 */
function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words =
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    const hash = fnv1a(word);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash & 0x80000000 ? -1 : 1);
  }
  const norm = Math.hypot(...vector);
  // Texto sem palavras daria vetor nulo, que não tem distância de cosseno definida.
  return norm === 0 ? vector.with(0, 1) : vector.map((value) => value / norm);
}

/**
 * Provedor determinístico e sem rede. Entra sozinho quando nenhuma chave está configurada,
 * ou explicitamente com `LLM_PROVIDERS=mock` (é o que o CI usa).
 * Serve para testar o encadeamento, a validação e o fluxo dos agentes. Não mede qualidade
 * de modelo: para isso, configure um provedor real.
 */
export function mockProvider(): Provider {
  return {
    name: 'mock',
    models: { fast: 'mock-fast', balanced: 'mock-balanced', powerful: 'mock-powerful' },
    embeddingModel: 'mock-hash-embedding',

    async chat({ messages, jsonSchema, label }) {
      const prompt = lastContent(messages, 'user') ?? '';
      const scripted = responder?.({
        prompt,
        system: lastContent(messages, 'system'),
        label,
        schema: jsonSchema?.schema,
      });

      let text: string;
      if (typeof scripted === 'string') text = scripted;
      else if (scripted !== undefined) text = JSON.stringify(scripted);
      else if (jsonSchema) text = JSON.stringify(sampleFromSchema(jsonSchema.schema, jsonSchema.schema));
      else text = `[mock] ${prompt.slice(0, 160)}`;

      const tokensIn = messages.reduce((total, message) => total + approxTokens(message.content), 0);
      return { text, tokensIn, tokensOut: approxTokens(text) };
    },

    async embed({ texts, dimensions }) {
      return {
        vectors: texts.map((text) => hashEmbedding(text, dimensions ?? 256)),
        tokensIn: texts.reduce((total, text) => total + approxTokens(text), 0),
      };
    },
  };
}
