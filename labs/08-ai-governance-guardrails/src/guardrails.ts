// Guardrails de entrada e de saída: duas travas em código, em volta da chamada do modelo.
//
//   entrada   a pergunta tenta mudar as regras do assistente? Bloqueia ANTES de gastar tokens.
//   saída     a resposta carrega credencial ou dado pessoal? Bloqueia ANTES de entregar.
//
// As duas são funções puras: recebem texto e devolvem o veredito. Quem registra o evento e
// decide o que o usuário vê é o pipeline (pipeline.ts).

export interface Violation {
  rule: string;
  /** O trecho que disparou a regra. Em credencial e dado pessoal, só o começo e o tamanho. */
  evidence: string;
}

export interface GuardResult {
  allowed: boolean;
  violations: Violation[];
}

interface Rule {
  rule: string;
  pattern: RegExp;
}

// shortcut: lista de frases conhecidas, em português e inglês. Paráfrase, outro idioma e
// instrução escondida em base64 ou em documento recuperado escapam. Em produção, some um
// classificador de injeção (modelo dedicado) e trate todo texto recuperado como dado.
//
// Os padrões rodam sobre o texto em minúsculas e sem acento: "IGNORE as Instruções" casa.
const INJECTION_RULES: Rule[] = [
  {
    rule: 'ignore-previous-instructions',
    pattern:
      /\b(?:ignore|desconsidere|esqueca|disregard|forget)\b.{0,40}\b(?:instrucoes|instructions|regras|rules|prompt)\b/,
  },
  {
    rule: 'reveal-system-prompt',
    pattern:
      /\b(?:revele|mostre|exiba|imprima|repita|reveal|show|print|repeat)\b.{0,40}\b(?:system prompt|prompt d[eo] sistema|instrucoes (?:iniciais|do sistema)|initial instructions)\b/,
  },
  {
    rule: 'role-override',
    pattern:
      /\b(?:voce agora e|a partir de agora voce|you are now|aja como se nao|finja que nao tem|act as if you have no)\b/,
  },
  {
    rule: 'jailbreak-mode',
    pattern:
      /\b(?:jailbreak|modo desenvolvedor|developer mode|modo dan|do anything now|sem restricoes|without restrictions)\b/,
  },
];

// Credenciais nos formatos mais comuns. PONTO DE EXTENSÃO: os prefixos dos seus fornecedores.
const SECRET_RULES: Rule[] = [
  { rule: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { rule: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { rule: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// Os mesmos formatos do gate de PII do lab 07, repetidos aqui porque um laboratório não
// importa de outro. shortcut: regex não pega nome nem endereço, e bloqueia também o e-mail
// público de suporte. Em produção, use um detector de PII e uma lista do que pode sair.
const PII_RULES: Rule[] = [
  { rule: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { rule: 'cpf', pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { rule: 'phone', pattern: /(?:\+55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g },
];
const SENSITIVE_RULES = [...SECRET_RULES, ...PII_RULES];

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');

/** O vazamento não pode se repetir no log que o denuncia: fica o começo e o tamanho. */
const mask = (secret: string) => `${secret.slice(0, 4)}… (${secret.length} caracteres)`;

/** Guardrail de entrada: tentativa de prompt injection ou jailbreak. */
export function checkInput(text: string): GuardResult {
  const normalized = normalize(text);
  const violations = INJECTION_RULES.flatMap(({ rule, pattern }) => {
    const match = pattern.exec(normalized);
    return match ? [{ rule, evidence: match[0] }] : [];
  });
  return { allowed: violations.length === 0, violations };
}

/** Guardrail de saída: credencial ou dado pessoal sem máscara na resposta do modelo. */
export function checkOutput(text: string): GuardResult {
  const violations = SENSITIVE_RULES.flatMap(({ rule, pattern }) =>
    [...text.matchAll(pattern)].map((match) => ({ rule, evidence: mask(match[0]) })),
  );
  return { allowed: violations.length === 0, violations };
}

/**
 * Troca credencial e dado pessoal por `<REDACTED:regra>`. É o texto que a trilha de auditoria
 * resume em hash: o log não guarda a pergunta, e o hash não depende do dado pessoal dela.
 */
export function sanitize(text: string): string {
  return SENSITIVE_RULES.reduce((clean, { rule, pattern }) => clean.replace(pattern, `<REDACTED:${rule}>`), text);
}
