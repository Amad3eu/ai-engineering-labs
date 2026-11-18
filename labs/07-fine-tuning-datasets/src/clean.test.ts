import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDataset, redactPii, splitDataset, toChatJsonl, validateChatJsonl } from './clean.js';

test('redactPii troca e-mail, CPF e telefone, e não mexe no resto', () => {
  assert.equal(redactPii('Escrevam para ana.silva+nf@empresa.com.br hoje.'), 'Escrevam para [EMAIL] hoje.');
  assert.equal(redactPii('CPF do titular: 123.456.789-09.'), 'CPF do titular: [CPF].');
  assert.equal(redactPii('Me liguem no (47) 99123-4567.'), 'Me liguem no [TELEFONE].');
  assert.equal(redactPii('Fone +55 47 3433-1234 ou 47991234567'), 'Fone [TELEFONE] ou [TELEFONE]');
  assert.equal(redactPii('CPF sem pontuação: 12345678909'), 'CPF sem pontuação: [CPF]');

  const untouched = 'A API devolve erro 500 desde as 14h e o pedido 2026 falhou.';
  assert.equal(redactPii(untouched), untouched);
});

test('cleanDataset normaliza, remove PII e conta cada descarte pelo motivo', () => {
  const { kept, dropped } = cleanDataset([
    { text: '  Fui cobrado   duas vezes na fatura. ', label: 'Billing' },
    { text: 'FUI COBRADO DUAS VEZES NA FATURA!', label: 'billing' },
    { text: 'Mandem a nota para fin@cliente.com, por favor.', label: 'billing' },
    { text: 'ok', label: 'question' },
    { text: 'Ganhe dinheiro rápido neste link!', label: 'spam' },
    { text: 'Registro sem rótulo do sistema antigo.' },
    { text: null, label: 'access' },
  ]);

  assert.deepEqual(kept, [
    { text: 'Fui cobrado duas vezes na fatura.', label: 'billing' },
    { text: 'Mandem a nota para [EMAIL], por favor.', label: 'billing' },
  ]);
  assert.deepEqual(dropped, { invalid: 2, unknownLabel: 1, tooShort: 1, duplicate: 1 });
});

test('splitDataset é estável, não perde nem repete exemplo, e ignora a ordem de entrada', () => {
  const examples = Array.from({ length: 20 }, (_, i) => ({
    text: `Ticket de exemplo número ${i}`,
    label: 'question' as const,
  }));

  const first = splitDataset(examples);
  const shuffled = splitDataset(examples.toReversed());

  assert.equal(first.validation.length, 4);
  assert.equal(first.train.length, 16);
  assert.deepEqual(first, shuffled);

  const all = [...first.train, ...first.validation].map((example) => example.text);
  assert.equal(new Set(all).size, 20);
});

test('o JSONL gerado passa na própria validação, e uma linha quebrada é recusada', () => {
  const jsonl = toChatJsonl(
    [
      { text: 'O painel está fora do ar.', label: 'outage' },
      { text: 'Como exporto em CSV? Tem "aspas" e\nquebra de linha.', label: 'question' },
    ],
    'Classifique o ticket.',
  );

  assert.equal(jsonl.trimEnd().split('\n').length, 2);
  assert.equal(validateChatJsonl(jsonl), 2);

  const broken = jsonl.replace('"outage"', '"urgente"');
  assert.throws(() => validateChatJsonl(broken), /linha 1/);
});
