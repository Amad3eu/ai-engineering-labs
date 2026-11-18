// Corpus de exemplo: trechos do manual interno de uma empresa fictícia. É pequeno de
// propósito, para a indexação custar centavos e o resultado caber numa tabela.
// PONTO DE EXTENSÃO: troque pelos seus documentos. O benchmark só precisa que cada
// pergunta de QUESTIONS aponte para a `source` que contém a resposta.

import type { AnswerSource, PipelineRequest } from './pipeline.js';

export interface CorpusDocument {
  source: string;
  text: string;
}

export const CORPUS: CorpusDocument[] = [
  {
    source: 'politica-de-deploy',
    text: `Deploy em produção acontece de terça a quinta-feira, antes das 16h. Fora dessa janela, só correção de incidente.

Deploy na sexta-feira ou em véspera de feriado exige aprovação da gerência de engenharia, registrada no ticket da mudança.

Todo deploy precisa de um plano de rollback testado em homologação. O rollback tem que caber em 10 minutos.`,
  },
  {
    source: 'runbook-pagamentos',
    text: `O código ERR-4012 indica timeout na comunicação com o gateway de pagamento. A cobrança não foi efetivada: reenvie depois de dois minutos e abra incidente se o erro persistir por mais de dez.

O código ERR-4031 indica que o cartão foi recusado pela análise antifraude. Não reenvie: oriente o cliente a falar com o banco emissor.

Estornos são processados em lote, toda noite às 23h, e aparecem para o cliente em até dois dias úteis.`,
  },
  {
    source: 'backups-e-retencao',
    text: `O banco de dados principal tem backup completo diário, às 3h, e log de transações contínuo.

Os backups ficam retidos por 35 dias. Depois disso são apagados, salvo bloqueio jurídico.

A restauração é testada uma vez por mês em um ambiente isolado. O objetivo é perder no máximo 15 minutos de dados e voltar ao ar em até 4 horas.`,
  },
  {
    source: 'limites-da-api',
    text: `A API pública limita requisições por chave. O plano Free permite 60 por minuto, o plano Pro permite 600 por minuto e o plano Enterprise é negociado em contrato.

Toda resposta traz o cabeçalho X-RateLimit-Remaining com o saldo da janela atual.

Quem passa do limite recebe o status 429 e o cabeçalho Retry-After, com os segundos de espera até a próxima janela.`,
  },
  {
    source: 'plantao-e-incidentes',
    text: `Incidentes têm três severidades. SEV1 é produção parada ou perda de dados, com resposta em 15 minutos a qualquer hora. SEV2 é funcionalidade importante degradada, com resposta em 1 hora. SEV3 entra na fila normal do time.

O plantão roda em escala semanal, com troca às segundas-feiras, 10h.

Todo SEV1 e SEV2 gera um postmortem, publicado em até 5 dias úteis, sem apontar culpados.`,
  },
  {
    source: 'acesso-e-seguranca',
    text: `O acesso aos sistemas internos é por login único corporativo, com segundo fator obrigatório.

Chaves de API de serviço são rotacionadas a cada 90 dias. Chave exposta em repositório é revogada na hora, sem esperar o ciclo.

Acesso a dados de produção é concedido por 8 horas, mediante ticket, e fica registrado em trilha de auditoria.`,
  },
];

export interface EvalQuestion {
  question: string;
  /** A `source` do documento que contém a resposta. */
  expectedSource: string;
}

// Perguntas do benchmark de recuperação. Dois tipos, de propósito:
// - com identificador exato (ERR-4012, X-RateLimit-Remaining), onde a busca lexical é forte;
// - com vocabulário diferente do documento ("cópias de segurança" × "backup"), onde a
//   busca semântica é forte.
export const QUESTIONS: EvalQuestion[] = [
  { question: 'O que significa o erro ERR-4012?', expectedSource: 'runbook-pagamentos' },
  { question: 'O que fazer quando aparece ERR-4031?', expectedSource: 'runbook-pagamentos' },
  { question: 'Qual cabeçalho mostra quantas requisições ainda posso fazer?', expectedSource: 'limites-da-api' },
  { question: 'Quantas chamadas por minuto o plano Pro permite?', expectedSource: 'limites-da-api' },
  { question: 'Posso publicar uma versão nova na sexta-feira?', expectedSource: 'politica-de-deploy' },
  {
    question: 'Por quanto tempo guardamos as cópias de segurança do banco?',
    expectedSource: 'backups-e-retencao',
  },
  {
    question: 'Em quanto tempo o relatório pós-incidente precisa ficar pronto?',
    expectedSource: 'plantao-e-incidentes',
  },
  {
    question: 'De quanto em quanto tempo as credenciais de serviço são trocadas?',
    expectedSource: 'acesso-e-seguranca',
  },
];

export interface PipelineCase extends PipelineRequest {
  /** O que este caso exercita no pipeline. */
  exercises: string;
  /**
   * Por onde a resposta deveria sair. Com um modelo real pode divergir, e é para mostrar
   * isso que a coluna existe: o roteador e o limiar do cache são decisões a calibrar.
   */
  expectedSource: AnswerSource;
}

// Bateria do pipeline: seis perguntas, na ordem, cada uma mirando uma decisão.
// A ordem importa: a 2 depende do que a 1 guardou no cache, e a 5 do que a 4 guardou.
// PONTO DE EXTENSÃO: troque a 2 por uma paráfrase com sinônimos ("Qual é o significado do
// código ERR-4012?") para ver o limiar do cache trabalhar com um embedding de verdade.
export const PIPELINE_BATTERY: PipelineCase[] = [
  {
    question: 'O que significa o erro ERR-4012?',
    userId: 'ana',
    scope: 'global',
    exercises: 'código de erro exato: o RRF traz o trecho que a busca lexical achou',
    expectedSource: 'agentic-rag',
  },
  {
    question: 'O erro ERR-4012 significa o quê?',
    userId: 'bruno',
    scope: 'global',
    exercises: 'a pergunta 1 com outra redação, de outro usuário: cache global',
    expectedSource: 'cache',
  },
  {
    question: 'O que significa a sigla API?',
    userId: 'ana',
    scope: 'global',
    exercises: 'dúvida geral: o roteador manda para o modelo barato, sem busca',
    expectedSource: 'fast-tier',
  },
  {
    question: 'O que fazer quando aparece ERR-4031?',
    userId: 'ana',
    scope: 'user-private',
    exercises: 'outro código exato, em conversa privada: a resposta fica só para a Ana',
    expectedSource: 'agentic-rag',
  },
  {
    question: 'O que fazer quando aparece ERR-4031?',
    userId: 'bruno',
    scope: 'user-private',
    exercises: 'a pergunta 4, idêntica, de outro usuário: o cache privado não pode vazar',
    expectedSource: 'agentic-rag',
  },
  {
    question: 'Qual é a política de reembolso de viagens a trabalho?',
    userId: 'ana',
    scope: 'global',
    exercises: 'fora do escopo do manual: o grader reprova os trechos e sai o aviso fixo',
    expectedSource: 'agentic-rag',
  },
];
