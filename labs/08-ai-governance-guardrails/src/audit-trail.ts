import { createHash } from 'node:crypto';
import type { BudgetStatus } from './budget-guard.js';
import type { RiskLevel } from './risk-classifier.js';

// Trilha de auditoria: um registro por requisição, com o que é preciso para explicar depois
// o que o sistema fez e por quê.
//
// Imutável em dois sentidos:
//   no processo   cada registro é congelado, e a lista só cresce;
//   no arquivo    cada registro leva o hash do anterior. Alterar, tirar ou trocar a ordem de
//                 uma linha quebra a cadeia, e `verifyChain` aponta onde.
//
// A pergunta do usuário não é guardada: fica o hash do texto já sem dado pessoal.

export type GuardStatus = 'passed' | 'blocked' | 'skipped';

export type Outcome =
  | 'delivered'
  | 'pending-human-review'
  | 'blocked-by-risk'
  | 'blocked-by-input-guard'
  | 'blocked-by-budget'
  | 'blocked-by-output-guard';

/** O que o pipeline informa. Sequência, horário e hashes ficam por conta da trilha. */
export interface AuditEntry {
  tenantId: string;
  /** SHA-256 da pergunta sanitizada (veja `hashInput`). */
  inputHash: string;
  riskLevel: RiskLevel;
  guardrails: { input: GuardStatus; output: GuardStatus };
  budget: BudgetStatus | 'skipped';
  /** O modelo que respondeu. `null` quando nenhuma chamada foi feita. */
  model: string | null;
  /** Ids das fontes que entraram no contexto da resposta: a explicabilidade. */
  sources: string[];
  costUsd: number;
  outcome: Outcome;
}

export interface AuditRecord extends AuditEntry {
  sequence: number;
  /** ISO 8601, em UTC. */
  timestamp: string;
  previousHash: string;
  hash: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const GENESIS_HASH = '0'.repeat(64);

/** O hash que a trilha guarda no lugar da pergunta. Passe o texto já sanitizado. */
export const hashInput = (sanitizedInput: string) => sha256(sanitizedInput);

/** O hash de um registro cobre todos os campos dele e o hash do registro anterior. */
function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  // Ordem de campos fixa, escrita à mão: o hash não pode depender de como o objeto foi montado.
  return sha256(
    JSON.stringify([
      record.sequence,
      record.timestamp,
      record.tenantId,
      record.inputHash,
      record.riskLevel,
      record.guardrails.input,
      record.guardrails.output,
      record.budget,
      record.model,
      record.sources,
      record.costUsd,
      record.outcome,
      record.previousHash,
    ]),
  );
}

/**
 * Confere a cadeia inteira. `brokenAt` é a posição, a partir de 1, do primeiro registro que
 * não bate: campo alterado (o hash dele muda) ou registro removido ou fora de ordem (o hash
 * anterior não liga com o de cima).
 *
 * shortcut: a cadeia denuncia alteração no meio, e não o corte do fim nem a trilha reescrita
 * inteira. Para isso, publique o último hash fora do sistema (um cofre, outro time, um
 * serviço de carimbo de tempo) ou grave em armazenamento que só aceita acréscimo.
 */
export function verifyChain(records: readonly AuditRecord[]): { valid: boolean; brokenAt: number | null } {
  let previousHash = GENESIS_HASH;
  for (const [index, record] of records.entries()) {
    const { hash, ...content } = record;
    if (record.previousHash !== previousHash || hashRecord(content) !== hash) {
      return { valid: false, brokenAt: index + 1 };
    }
    previousHash = hash;
  }
  return { valid: true, brokenAt: null };
}

export type AuditTrail = ReturnType<typeof createAuditTrail>;

/** `now` existe para o teste fixar o relógio. */
export function createAuditTrail(now: () => Date = () => new Date()) {
  const records: AuditRecord[] = [];

  /** Acrescenta um registro e devolve a versão congelada, já com sequência, horário e hash. */
  function append(entry: AuditEntry): AuditRecord {
    const content = {
      ...entry,
      // Cópias: quem chamou não consegue mudar o registro mexendo no objeto que passou.
      guardrails: Object.freeze({ ...entry.guardrails }),
      sources: Object.freeze([...entry.sources]) as string[],
      sequence: records.length + 1,
      timestamp: now().toISOString(),
      previousHash: records.at(-1)?.hash ?? GENESIS_HASH,
    };
    const record = Object.freeze({ ...content, hash: hashRecord(content) });
    records.push(record);
    return record;
  }

  return {
    append,
    /** Cópia congelada da lista: não há como tirar ou reordenar registros por fora. */
    records: (): readonly AuditRecord[] => Object.freeze([...records]),
    verify: () => verifyChain(records),
    /** Um JSON por linha, pronto para gravar em arquivo ou enviar a um coletor de logs. */
    toJsonl: () => records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  };
}
