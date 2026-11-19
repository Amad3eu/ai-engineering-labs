import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDataset, redactPii } from './clean.js';

test('redactPii troca e-mail, CPF e telefone, e não mexe no resto', () => {
  assert.equal(redactPii('Escrevam para ana.silva+nf@empresa.com.br hoje.'), 'Escrevam para [EMAIL] hoje.');
  assert.equal(redactPii('CPF do titular: 123.456.789-09.'), 'CPF do titular: [CPF].');
  assert.equal(redactPii('Me liguem no (47) 99123-4567.'), 'Me liguem no [TELEFONE].');
  assert.equal(redactPii('Fone +55 47 3433-1234 ou 47991234567'), 'Fone [TELEFONE] ou [TELEFONE]');
  assert.equal(redactPii('CPF sem pontuação: 12345678909'), 'CPF sem pontuação: [CPF]');

  const untouched = 'A API devolve erro 500 desde as 14h e o pedido 2026 falhou.';
  assert.equal(redactPii(untouched), untouched);
});

test('cleanDataset normaliza texto e rótulos, remove PII e conta cada descarte pelo motivo', () => {
  const { kept, dropped } = cleanDataset([
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
    { text: 'Mandem a nota para [EMAIL], por favor.', category: 'billing', priority: 'P3' },
  ]);
  assert.deepEqual(dropped, { invalid: 3, unknownLabel: 2, tooShort: 1, duplicate: 1 });
});
