import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AuditEntry, type AuditRecord, createAuditTrail, hashInput, verifyChain } from './audit-trail.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  tenantId: 'acme',
  inputHash: hashInput('Qual é o prazo de reembolso?'),
  riskLevel: 'minimal-risk',
  guardrails: { input: 'passed', output: 'passed' },
  budget: 'normal',
  model: 'mock-balanced',
  sources: ['politica-reembolso'],
  costUsd: 0.000384,
  outcome: 'delivered',
  ...overrides,
});

/** Uma trilha com relógio fixo: cada registro sai um segundo depois do anterior. */
const trailAt = (start = '2026-11-24T12:00:00.000Z') => {
  let tick = 0;
  return createAuditTrail(() => new Date(Date.parse(start) + 1000 * tick++));
};
const threeRecords = () => {
  const trail = trailAt();
  trail.append(entry());
  trail.append(entry({ outcome: 'blocked-by-input-guard', model: null, sources: [], costUsd: 0 }));
  trail.append(entry({ riskLevel: 'high-risk', outcome: 'pending-human-review' }));
  return trail;
};

test('cada registro tem os campos da requisição, mais sequência, horário e os dois hashes', () => {
  const record = trailAt().append(entry());

  assert.deepEqual(
    { ...record, hash: '(conferido abaixo)' },
    {
      ...entry(),
      sequence: 1,
      timestamp: '2026-11-24T12:00:00.000Z',
      previousHash: '0'.repeat(64),
      hash: '(conferido abaixo)',
    },
  );
  assert.match(record.hash, HEX_64);
});

test('os registros se encadeiam: o hash de um é o hash anterior do seguinte', () => {
  const [first, second, third] = threeRecords().records();

  assert.deepEqual([first?.sequence, second?.sequence, third?.sequence], [1, 2, 3]);
  assert.equal(second?.previousHash, first?.hash);
  assert.equal(third?.previousHash, second?.hash);
  assert.equal(second?.timestamp, '2026-11-24T12:00:01.000Z');
  assert.equal(new Set([first?.hash, second?.hash, third?.hash]).size, 3);
});

test('o registro é imutável: nem o campo, nem a lista de fontes, nem a lista de registros mudam', () => {
  const trail = trailAt();
  const record = trail.append(entry());
  const writable = record as { outcome: string; costUsd: number };

  assert.throws(() => {
    writable.outcome = 'blocked-by-budget';
  }, TypeError);
  assert.throws(() => {
    writable.costUsd = 0;
  }, TypeError);
  assert.throws(() => record.sources.push('fonte-plantada'), TypeError);
  assert.throws(() => {
    (record.guardrails as { output: string }).output = 'skipped';
  }, TypeError);
  assert.throws(() => (trail.records() as AuditRecord[]).pop(), TypeError);

  assert.equal(trail.records().length, 1);
  assert.deepEqual(trail.verify(), { valid: true, brokenAt: null });
});

test('mexer no objeto que foi passado depois de registrar não altera o registro', () => {
  const trail = trailAt();
  const mutable = entry();
  const record = trail.append(mutable);

  mutable.sources.push('fonte-plantada');
  mutable.guardrails.output = 'blocked';

  assert.deepEqual(record.sources, ['politica-reembolso']);
  assert.equal(record.guardrails.output, 'passed');
  assert.deepEqual(trail.verify(), { valid: true, brokenAt: null });
});

test('verifyChain: cadeia intacta confere; campo alterado, registro removido ou trocado de lugar, não', () => {
  const records = threeRecords().records();
  const [first, second, third] = records as [AuditRecord, AuditRecord, AuditRecord];
  assert.deepEqual(verifyChain(records), { valid: true, brokenAt: null });
  assert.deepEqual(verifyChain([]), { valid: true, brokenAt: null });

  // Um campo alterado em uma cópia gravada em arquivo: o hash do registro deixa de bater.
  assert.deepEqual(verifyChain([first, { ...second, outcome: 'delivered' }, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([first, { ...second, costUsd: 99 }, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([first, { ...second, sequence: 7 }, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([first, second, { ...third, sources: [] }]), { valid: false, brokenAt: 3 });
  assert.deepEqual(verifyChain([{ ...first, timestamp: '2020-01-01T00:00:00.000Z' }, second, third]), {
    valid: false,
    brokenAt: 1,
  });
  // Registro removido ou fora de ordem: o hash anterior deixa de ligar com o de cima.
  assert.deepEqual(verifyChain([first, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([second, third]), { valid: false, brokenAt: 1 });
  assert.deepEqual(verifyChain([first, third, second]), { valid: false, brokenAt: 2 });
});

test('verifyChain: trocar um registro por outro com hash válido quebra o seguinte', () => {
  const [first, , third] = threeRecords().records() as [AuditRecord, AuditRecord, AuditRecord];

  // Outra trilha com o mesmo começo dá um segundo registro forjado, com hash certo e bem ligado.
  const forgery = trailAt();
  forgery.append(entry());
  const forged = forgery.append(entry({ outcome: 'delivered', costUsd: 0 }));
  assert.equal(forged.previousHash, first.hash);

  // O terceiro ainda aponta para o registro verdadeiro.
  assert.deepEqual(verifyChain([first, forged, third]), { valid: false, brokenAt: 3 });
  // Religar o terceiro ao forjado também não passa: o hash anterior entra no hash do registro.
  assert.deepEqual(verifyChain([first, forged, { ...third, previousHash: forged.hash }]), {
    valid: false,
    brokenAt: 3,
  });
});

test('hashInput: SHA-256 do texto, igual para o mesmo texto e diferente para outro', () => {
  assert.match(hashInput('pergunta'), HEX_64);
  assert.equal(hashInput('pergunta'), hashInput('pergunta'));
  assert.notEqual(hashInput('pergunta'), hashInput('pergunta '));
  // Vetor conhecido do SHA-256.
  assert.equal(hashInput('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('toJsonl: um JSON por linha, e a trilha relida do arquivo ainda confere', () => {
  const trail = threeRecords();
  const lines = trail.toJsonl().trimEnd().split('\n');
  const reread = lines.map((line) => JSON.parse(line) as AuditRecord);

  assert.equal(lines.length, 3);
  assert.deepEqual(reread, trail.records());
  assert.deepEqual(verifyChain(reread), { valid: true, brokenAt: null });
  assert.equal(createAuditTrail().toJsonl(), '');
});
