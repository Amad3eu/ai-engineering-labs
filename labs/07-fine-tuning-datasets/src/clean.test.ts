import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDataset } from './clean.js';

test('cleanDataset normaliza texto e rótulos, mascara PII e conta cada descarte pelo motivo', () => {
  const { kept, dropped, piiRedactions } = cleanDataset([
    { text: '  Fui cobrado   duas vezes na fatura. ', category: 'Billing', priority: ' p2 ' },
    { text: 'FUI COBRADO DUAS VEZES NA FATURA!', category: 'billing', priority: 'P2' },
    { text: 'Mandem a nota para fin@cliente.com, por favor.', category: 'billing', priority: 'P3' },
    { text: 'ok', category: 'question', priority: 'P3' },
    { text: 'Ganhe dinheiro rápido neste link!', category: 'spam', priority: 'P3' },
    { text: 'Ticket com uma prioridade que não existe.', category: 'question', priority: 'urgente' },
    { text: 'Registro sem rótulo do sistema antigo.' },
    { text: 'Registro sem prioridade do sistema antigo.', category: 'access' },
    { text: null, category: 'access', priority: 'P2' },
  ]);

  assert.deepEqual(kept, [
    { text: 'Fui cobrado duas vezes na fatura.', category: 'billing', priority: 'P2' },
    { text: 'Mandem a nota para <EMAIL>, por favor.', category: 'billing', priority: 'P3' },
  ]);
  assert.deepEqual(dropped, { invalid: 3, unknownLabel: 2, tooShort: 1, duplicate: 1 });
  assert.deepEqual(piiRedactions, { CPF: 0, EMAIL: 1, PHONE: 0 });
});

test('o gate de PII vem antes da comparação: a mesma mensagem com telefones diferentes é duplicata', () => {
  const { kept, dropped, piiRedactions } = cleanDataset([
    { text: 'Perdi o acesso, me liguem no (47) 99123-4567.', category: 'access', priority: 'P2' },
    { text: 'Perdi o acesso, me liguem no (11) 98888-7777.', category: 'access', priority: 'P2' },
  ]);

  assert.deepEqual(
    kept.map(({ text }) => text),
    ['Perdi o acesso, me liguem no <PHONE>.'],
  );
  assert.equal(dropped.duplicate, 1);
  // A contagem é do gate: o telefone do registro descartado também foi mascarado.
  assert.deepEqual(piiRedactions, { CPF: 0, EMAIL: 0, PHONE: 2 });
});
