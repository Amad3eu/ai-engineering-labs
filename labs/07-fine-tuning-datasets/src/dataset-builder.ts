import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type CleanReport, cleanDataset } from './clean.js';
import { ticketPrompt } from './prompts.js';
import { Category, type Example, parseTriage, triageJson } from './schema.js';

// O pipeline do dataset:
//
//   dado bruto → limpeza (clean.ts) → divisão 80/20 → JSONL de chat → validação → relatório
//
// Tudo aqui é função pura, menos `writeDataset`, que grava os arquivos e relê para validar.

/**
 * O formato padrão de chat fine-tuning: uma conversa completa por linha do JSONL.
 * Este é o schema que o provedor exige. O que ESTE dataset exige a mais (a última mensagem
 * ser a resposta, e a resposta ser a triagem) está em `checkLine`.
 */
export const ChatLine = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1) })).min(2),
});
export type ChatLine = z.infer<typeof ChatLine>;

export type DatasetFile = 'train.jsonl' | 'val.jsonl';

// PONTO DE EXTENSÃO: limites dos alertas de qualidade.
export const QUALITY_LIMITS = {
  /** Mínimo de exemplos que o provedor aceita (guia de fine-tuning da OpenAI, consultado em 19/11/2026). */
  minTrainExamples: 10,
  /** O mesmo guia relata melhora entre 50 e 100 exemplos, e sugere começar com 50. */
  recommendedTrainExamples: 50,
  /** Regra prática: a classe mais comum com mais que isto vezes a mais rara já enviesa o modelo. */
  maxImbalanceRatio: 3,
} as const;

// shortcut: ~4 caracteres por token, a mesma conta do provedor mock; ignora os tokens de
// formatação de cada mensagem. Para orçamento de treino de verdade, conte com o tokenizador
// do provedor.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const byHash = (a: Example, b: Example) => hash(a.text).localeCompare(hash(b.text));

/**
 * Divide em treino e validação, estratificado por categoria: cada classe cede a mesma fração
 * para a validação, então nenhuma fica de fora da medição.
 *
 * Quem vai para qual lado sai do hash do texto, e não de sorteio: a mesma entrada dá sempre
 * a mesma divisão, em qualquer ordem e em qualquer máquina.
 *
 * shortcut: quando o dataset cresce, a divisão é refeita e um exemplo pode trocar de lado.
 * Para comparar modelos entre versões do dataset, decida pelo valor do hash de cada exemplo
 * (ex.: 1 em cada 5 valores vai para a validação), ao custo de uma proporção só aproximada.
 */
export function splitDataset(examples: Example[], validationRatio = 0.2): { train: Example[]; validation: Example[] } {
  const groups = new Map<Category, Example[]>();
  for (const example of examples) {
    const group = groups.get(example.category);
    if (group) group.push(example);
    else groups.set(example.category, [example]);
  }

  const train: Example[] = [];
  const validation: Example[] = [];
  for (const group of groups.values()) {
    const ordered = group.toSorted(byHash);
    // Classe com um exemplo só fica inteira no treino: fora dele, o modelo nem conhece a classe.
    const take = ordered.length < 2 ? 0 : Math.max(1, Math.round(ordered.length * validationRatio));
    validation.push(...ordered.slice(0, take));
    train.push(...ordered.slice(take));
  }
  return { train: train.toSorted(byHash), validation: validation.toSorted(byHash) };
}

const toChatLine = (example: Example, system: string): ChatLine => ({
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: ticketPrompt(example.text) },
    { role: 'assistant', content: triageJson(example) },
  ],
});

export function toChatJsonl(examples: Example[], system: string): string {
  return examples.map((example) => `${JSON.stringify(toChatLine(example, system))}\n`).join('');
}

export interface LineError {
  /** Número da linha no arquivo, a partir de 1. */
  line: number;
  message: string;
}

/** O que há de errado com uma linha, ou `undefined` quando ela serve. */
function checkLine(raw: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'não é JSON válido.';
  }
  const chat = ChatLine.safeParse(json);
  if (!chat.success) return `fora do formato de chat:\n${z.prettifyError(chat.error)}`;

  // A última mensagem é o que o modelo aprende a escrever.
  const answer = chat.data.messages.at(-1);
  if (answer?.role !== 'assistant') return 'a última mensagem precisa ser do assistant.';
  // Resposta-alvo fora do schema ensina o modelo a errar o formato.
  if (!parseTriage(answer.content)) return 'a resposta do assistant não é o JSON da triagem.';
  return undefined;
}

/**
 * Valida um JSONL linha a linha: o formato padrão de chat e, na resposta do assistant, o
 * schema rígido da triagem. Não para no primeiro erro: devolve todos, com o número da linha.
 */
export function validateChatJsonl(jsonl: string): { valid: number; errors: LineError[] } {
  const errors: LineError[] = [];
  let valid = 0;
  jsonl.split('\n').forEach((raw, index) => {
    if (!raw.trim()) return; // linha em branco, como a do fim do arquivo, não é exemplo
    const message = checkLine(raw);
    if (message) errors.push({ line: index + 1, message });
    else valid++;
  });
  return { valid, errors };
}

export interface SplitStats {
  examples: number;
  /** Tokens de todas as mensagens do arquivo. É sobre este total que o treino é cobrado, por passada. */
  estimatedTokens: number;
  byCategory: Record<Category, number>;
}

function splitStats(examples: Example[], system: string): SplitStats {
  const byCategory = Object.fromEntries(Category.options.map((category) => [category, 0])) as Record<Category, number>;
  let estimatedTokens = 0;
  for (const example of examples) {
    byCategory[example.category]++;
    for (const message of toChatLine(example, system).messages) estimatedTokens += estimateTokens(message.content);
  }
  return { examples: examples.length, estimatedTokens, byCategory };
}

export interface QualityAlert {
  /** `error`: o dataset não serve para treinar como está. `warning`: serve, com ressalva. */
  level: 'error' | 'warning';
  code: 'too-small' | 'below-recommended' | 'missing-category' | 'imbalanced';
  message: string;
}

/** Alertas de qualidade sobre a divisão pronta. Não corrige nada: aponta, e quem decide é gente. */
export function assessQuality(train: SplitStats, validation: SplitStats): QualityAlert[] {
  const { minTrainExamples, recommendedTrainExamples, maxImbalanceRatio } = QUALITY_LIMITS;
  const alerts: QualityAlert[] = [];

  if (train.examples < minTrainExamples) {
    alerts.push({
      level: 'error',
      code: 'too-small',
      message: `Treino com ${train.examples} exemplos: o provedor exige pelo menos ${minTrainExamples}.`,
    });
  } else if (train.examples < recommendedTrainExamples) {
    alerts.push({
      level: 'warning',
      code: 'below-recommended',
      message: `Treino com ${train.examples} exemplos: abaixo dos ${recommendedTrainExamples} recomendados para o ganho aparecer.`,
    });
  }

  for (const category of Category.options) {
    if (train.byCategory[category] === 0) {
      alerts.push({
        level: 'error',
        code: 'missing-category',
        message: `Nenhum exemplo de "${category}" no treino: o modelo nunca vê a classe.`,
      });
    } else if (validation.byCategory[category] === 0) {
      alerts.push({
        level: 'warning',
        code: 'missing-category',
        message: `Nenhum exemplo de "${category}" na validação: o A/B não mede a classe.`,
      });
    }
  }

  // Só entre as classes presentes: classe ausente já tem o seu alerta acima.
  const counts = Object.values(train.byCategory).filter((count) => count > 0);
  const largest = Math.max(...counts);
  const smallest = Math.min(...counts);
  if (counts.length > 1 && largest / smallest > maxImbalanceRatio) {
    alerts.push({
      level: 'warning',
      code: 'imbalanced',
      message: `Treino desbalanceado: a maior classe tem ${largest} exemplos e a menor, ${smallest} (${(largest / smallest).toFixed(1)}×, limite ${maxImbalanceRatio}×).`,
    });
  }
  return alerts;
}

export interface DatasetReport {
  raw: number;
  dropped: CleanReport['dropped'];
  train: SplitStats;
  validation: SplitStats;
  alerts: QualityAlert[];
}

export interface Dataset {
  train: Example[];
  validation: Example[];
  /** O conteúdo de cada arquivo, pronto para gravar. */
  files: Record<DatasetFile, string>;
  report: DatasetReport;
}

/**
 * O pipeline inteiro, em memória: limpa, deduplica, divide e serializa. `system` é o prompt
 * que vai em cada linha, e tem que ser o mesmo que o modelo ajustado recebe em produção.
 *
 * PONTO DE EXTENSÃO: para outro domínio, troque o schema (schema.ts), a limpeza (clean.ts)
 * e o dado bruto. A divisão, a validação e os alertas não mudam.
 */
export function buildDataset(records: unknown[], system: string, validationRatio = 0.2): Dataset {
  const { kept, dropped } = cleanDataset(records);
  const { train, validation } = splitDataset(kept, validationRatio);
  const trainStats = splitStats(train, system);
  const validationStats = splitStats(validation, system);

  return {
    train,
    validation,
    files: { 'train.jsonl': toChatJsonl(train, system), 'val.jsonl': toChatJsonl(validation, system) },
    report: {
      raw: records.length,
      dropped,
      train: trainStats,
      validation: validationStats,
      alerts: assessQuality(trainStats, validationStats),
    },
  };
}

/**
 * Grava os JSONL e relê do disco para validar: o que vai para o provedor é o arquivo, não o
 * array em memória. Devolve quantas linhas válidas cada arquivo tem; com qualquer linha
 * inválida, lança com a lista completa.
 */
export async function writeDataset(dataset: Dataset, outDir: string): Promise<Record<DatasetFile, number>> {
  await mkdir(outDir, { recursive: true });
  const valid: Record<DatasetFile, number> = { 'train.jsonl': 0, 'val.jsonl': 0 };

  for (const name of Object.keys(valid) as DatasetFile[]) {
    const file = join(outDir, name);
    await writeFile(file, dataset.files[name]);

    const result = validateChatJsonl(await readFile(file, 'utf8'));
    if (result.errors.length > 0) {
      const lines = result.errors.map((error) => `  linha ${error.line}: ${error.message}`).join('\n');
      throw new Error(`${file} tem linha inválida:\n${lines}`);
    }
    valid[name] = result.valid;
  }
  return valid;
}
