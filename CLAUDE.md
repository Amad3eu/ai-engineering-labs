# CLAUDE.md

Contexto e regras para agentes de IA que trabalham neste repositório. As mesmas regras estão em `.cursorrules`: mudou uma, mude a outra.

## O que é

Monorepo de laboratórios de Engenharia de IA aplicada, em TypeScript. Cada pasta de `labs/` isola um padrão (RAG, MCP, agentes, multiagente, AIOps, fine-tuning) em um exemplo executável. Três pacotes em `packages/` dão a base comum.

## Comandos

```bash
pnpm install                                   # instala tudo
pnpm check                                     # lint + typecheck + build + test (o que o CI roda)
pnpm lint:fix                                  # formata e corrige o que o Biome consegue
pnpm --filter @labs/01-prompt-engineering-evals dev    # roda um laboratório
pnpm --filter @labs/shared-llm test            # testes de um workspace
docker compose up -d                           # Postgres + pgvector e Redis (só o lab 02 precisa)
```

Rode `pnpm check` antes de dar um trabalho por pronto. Sem chave no `.env`, tudo roda com o provedor `mock`.

## Mapa

```
packages/shared-observability   logger (Pino), métricas de chamada de LLM, carga do .env
packages/shared-llm             provedores, fallback, Model Tiering, Zod, custo, mock
packages/shared-vector          Postgres/pgvector: chunking, ingestão, busca vetorial/lexical/híbrida
labs/NN-nome/src/index.ts       ponto de entrada do laboratório
labs/NN-nome/src/prompts.ts     todos os prompts do laboratório
labs/NN-nome/src/mock.ts        roteiro do provedor mock para o exemplo rodar sem rede
infra/init.sql                  schema do Postgres (extensão vector, índices HNSW e GIN)
```

Dependência só nesta direção: `labs → shared-vector → shared-llm → shared-observability`. Um laboratório não importa de outro.

## Regras inegociáveis

1. **Saída estruturada de LLM é validada com Zod, sempre.** Use `generateObject({ schema })` de `@labs/shared-llm`. Nunca use `JSON.parse` solto na resposta de um modelo. Em schema de saída use `.nullable()`, não `.optional()`: o modo estrito dos provedores exige todo campo. Vale para qualquer entrada externa: resposta humana, arquivo, conteúdo do Redis, resultado de tool.
2. **Toda execução é medida por `@labs/shared-observability`.** Chamada de LLM passa por `@labs/shared-llm`, que já registra modelo, latência, tokens, custo e cache hit. Não instancie SDK de provedor dentro de um laboratório. O que responde sem chamar o modelo (um cache hit) registra com `logLlmCall`. Métrica não vai em `console.log`.
3. **Nada de chave de API no código, nem prompt longo no meio da lógica.** Chave vem do `.env` (o modelo é `.env.example`). Prompt mora em `src/prompts.ts` do laboratório: instrução no `system`, dado no `prompt`, entre tags.
4. **README acompanha o código.** Mudou o fluxo de um laboratório, atualize o diagrama Mermaid do README dele. Rodou um experimento, preencha a tabela "Trade-offs e Métricas Observadas" com os números e o modelo usado. Não invente número: célula sem medição fica com `—`.

## Convenções

- **Comentário explica o porquê**, em português. Ponto onde o leitor deve mexer para estender leva `PONTO DE EXTENSÃO:`. Atalho com limite conhecido leva `shortcut: <o limite>, <quando trocar>`.
- **Regra de negócio e limite ficam em código, não no prompt**: teto de passos, política de prioridade, o que o agente pode ou não fazer. O prompt orienta; o código garante.
- **Guardrail por construção**: se o agente não pode aplicar uma mudança, não existe ferramenta de aplicar. Ação com efeito fora do processo passa por aprovação humana (lab 05).
- **Entrada do modelo nunca compõe caminho de arquivo nem comando.** Compare com uma lista do que existe (veja `readFixture` no lab 06 e `readNote` no lab 03).
- **Logs em stderr, resultado em stdout.** No servidor MCP (stdio), qualquer coisa em stdout quebra o protocolo.
- **ESM**: import relativo termina em `.js`, mesmo o arquivo sendo `.ts`.
- **Teste**: `node:test`, arquivo `*.test.ts` ao lado do código. Lógica nova que não é trivial leva um teste. Teste não chama rede: use provedor falso ou o mock.
- **Laboratório novo**: copie a estrutura de um existente (`package.json`, `tsconfig.json`, `src/index.ts`, `src/prompts.ts`, `README.md` com as quatro seções) e acrescente a linha na tabela do README da raiz.

## Armadilhas já encontradas

- **Pacotes em modo fonte.** Os scripts usam `--conditions=@labs/source`, que faz `@labs/shared-*` resolver para `src/index.ts`. Rodar com `tsx` sem essa flag procura `dist/` e falha se não houve build.
- **pnpm 12 recusa versão publicada há menos de um dia.** Não acrescente `minimumReleaseAgeExclude`: afrouxe a faixa de versão para aceitar a anterior.
- **Nenhuma dependência roda script de instalação** (`allowBuilds` em `pnpm-workspace.yaml`). Dependência nova que peça um precisa de decisão explícita.
- **LangGraph**: nome de nó não pode repetir nome de campo do estado. Subgrafo com estado próprio é chamado de dentro de um nó adaptador (veja `hierarchical.ts`).
- **`temperature`** não é aceita pela família GPT-6: só é enviada quando o chamador define.
- **Embedding não tem fallback entre provedores.** Vetores de modelos diferentes não se comparam. Trocou de provedor, reindexe.
- **Modelos e preços** estão em `packages/shared-llm/src/models.ts`, conferidos em 18/11/2026. Trocou o modelo, atualize o preço.

## Não faça

- Não commite `.env`, `out/`, `dist/` nem `node_modules/`.
- Não acrescente dependência para o que a plataforma já faz (`fetch`, `node:test`, `process.loadEnvFile`).
- Não troque a busca lexical por "BM25" no texto sem trocar a implementação: hoje é a full-text search do Postgres, e os READMEs dizem isso.
