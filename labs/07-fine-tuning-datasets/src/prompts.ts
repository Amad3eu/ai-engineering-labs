// O mesmo system prompt vai para o JSONL de treino e para a avaliação A/B. Tem que ser
// idêntico nos dois: um modelo ajustado com uma instrução e avaliado com outra é medido
// fora da distribuição em que foi treinado.

export const CLASSIFIER_SYSTEM = `Classifique o ticket de suporte em uma categoria:
- billing: cobrança, fatura, nota fiscal, reembolso.
- outage: serviço fora do ar ou erro generalizado.
- access: login, senha, autenticação, permissão.
- question: dúvida de uso, sem nada quebrado.
Responda só com o nome da categoria, em minúsculas, sem mais nada.`;
