import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePii } from './pii-sanitizer.js';

test('troca e-mail, CPF e telefone pelos tokens e conta cada tipo', () => {
  assert.deepEqual(sanitizePii('Escrevam para ana.silva+nf@empresa.com.br hoje.'), {
    sanitizedText: 'Escrevam para <EMAIL> hoje.',
    redactions: [{ type: 'EMAIL', count: 1 }],
  });
  assert.deepEqual(sanitizePii('CPF do titular: 123.456.789-09.'), {
    sanitizedText: 'CPF do titular: <CPF>.',
    redactions: [{ type: 'CPF', count: 1 }],
  });
  assert.deepEqual(sanitizePii('Me liguem no (47) 99123-4567.'), {
    sanitizedText: 'Me liguem no <PHONE>.',
    redactions: [{ type: 'PHONE', count: 1 }],
  });
});

test('telefone: fixo com DDI, celular sem pontuação e mais de um no mesmo texto', () => {
  assert.deepEqual(sanitizePii('Fone +55 47 3433-1234 ou 47991234567'), {
    sanitizedText: 'Fone <PHONE> ou <PHONE>',
    redactions: [{ type: 'PHONE', count: 2 }],
  });
});

test('11 dígitos sem pontuação: com 9 depois do DDD é celular, o resto é CPF', () => {
  assert.equal(sanitizePii('Número: 47991234567').sanitizedText, 'Número: <PHONE>');
  assert.equal(sanitizePii('Número: 12345678909').sanitizedText, 'Número: <CPF>');
});

test('vários tipos no mesmo texto: redactions na ordem CPF, EMAIL, PHONE, só com o que achou', () => {
  const { sanitizedText, redactions } = sanitizePii(
    'Sou a Ana (ana@empresa.com), CPF 123.456.789-09 e 987.654.321-00, celular (47) 99123-4567. Cópia para rh@empresa.com.',
  );

  assert.equal(sanitizedText, 'Sou a Ana (<EMAIL>), CPF <CPF> e <CPF>, celular <PHONE>. Cópia para <EMAIL>.');
  assert.deepEqual(redactions, [
    { type: 'CPF', count: 2 },
    { type: 'EMAIL', count: 2 },
    { type: 'PHONE', count: 1 },
  ]);
});

test('texto sem PII volta igual, com a lista vazia', () => {
  const clean = 'A API devolve erro 500 desde as 14h e o pedido 2026 falhou.';
  assert.deepEqual(sanitizePii(clean), { sanitizedText: clean, redactions: [] });
  assert.deepEqual(sanitizePii(''), { sanitizedText: '', redactions: [] });
});

test('passar duas vezes dá o mesmo texto: os tokens não casam com nenhum padrão', () => {
  const once = sanitizePii('Ana, ana@empresa.com, 123.456.789-09, (47) 99123-4567').sanitizedText;
  assert.deepEqual(sanitizePii(once), { sanitizedText: once, redactions: [] });
});
