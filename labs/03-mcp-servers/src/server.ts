// Servidor MCP "labs-notes": expõe uma pasta de notas Markdown a qualquer cliente MCP
// (Claude Code, Claude Desktop, Cursor, o cliente de teste em index.ts).
//
//   Resources  note://{slug}     o conteúdo de cada nota, para o cliente anexar ao contexto
//   Tools      search_notes      busca um termo nas notas
//              summarize_note    resume uma nota com um LLM
//
// Transporte stdio: o cliente inicia este processo e conversa por stdin/stdout. Por isso
// NADA além do protocolo pode ir para stdout. Não use console.log aqui: o logger de
// @labs/shared-observability escreve em stderr.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SUMMARIZE_SYSTEM, summarizePrompt } from './prompts.js';

const NOTES_DIR = join(import.meta.dirname, '../data/notes');
const MAX_MATCHES = 10;

const toUri = (slug: string) => `note://${slug}`;

async function listSlugs(): Promise<string[]> {
  const files = await readdir(NOTES_DIR);
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
}

/**
 * O slug chega de fora (do modelo, pelo cliente). Ele nunca compõe um caminho sem antes
 * ser igual ao nome de uma nota que existe: é o que impede ler `../../.env`.
 */
async function readNote(slug: string): Promise<string | undefined> {
  const slugs = await listSlugs();
  return slugs.includes(slug) ? readFile(join(NOTES_DIR, `${slug}.md`), 'utf8') : undefined;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
// Erro de ferramenta volta como resultado com `isError`, não como exceção: assim o modelo
// lê a mensagem e pode corrigir a chamada.
const failure = (value: string) => ({ ...text(value), isError: true });

const server = new McpServer({ name: 'labs-notes', version: '0.1.0' });

// --- Resources: dados que o cliente pode ler e anexar ao contexto --------------------------
server.registerResource(
  'note',
  new ResourceTemplate('note://{slug}', {
    list: async () => ({
      resources: (await listSlugs()).map((slug) => ({ uri: toUri(slug), name: slug, mimeType: 'text/markdown' })),
    }),
  }),
  {
    title: 'Notas da base de conhecimento',
    description: 'Arquivos Markdown da pasta data/notes.',
    mimeType: 'text/markdown',
  },
  async (uri, { slug }) => {
    const note = await readNote(String(slug));
    if (note === undefined) throw new Error(`Nota não encontrada: ${uri.href}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: note }] };
  },
);

// --- Tools: ações que o modelo pode pedir ---------------------------------------------------
// O `inputSchema` em Zod vira o JSON Schema que o cliente mostra ao modelo, e o SDK valida
// os argumentos contra ele antes de chamar a função.
// PONTO DE EXTENSÃO: uma tool nova é um `registerTool` aqui. Tool que escreve ou apaga deve
// declarar `annotations: { destructiveHint: true }`, para o cliente pedir confirmação.

server.registerTool(
  'search_notes',
  {
    title: 'Buscar nas notas',
    description: 'Procura um termo nas notas e devolve as linhas que o contêm, com o URI de cada nota.',
    inputSchema: { query: z.string().min(2).describe('Termo ou frase a procurar.') },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const slug of await listSlugs()) {
      const note = (await readNote(slug)) ?? '';
      for (const line of note.split('\n')) {
        if (line.toLowerCase().includes(needle)) matches.push(`${toUri(slug)}: ${line.trim()}`);
      }
    }
    return text(matches.length > 0 ? matches.slice(0, MAX_MATCHES).join('\n') : `Nenhuma linha com "${query}".`);
  },
);

server.registerTool(
  'summarize_note',
  {
    title: 'Resumir nota',
    description: 'Resume uma nota em até três frases. Use o slug que aparece em search_notes ou na lista de resources.',
    inputSchema: { slug: z.string().describe('Slug da nota, sem "note://" e sem ".md".') },
    annotations: { readOnlyHint: true },
  },
  async ({ slug }) => {
    const note = await readNote(slug);
    if (note === undefined) {
      return failure(`Nota "${slug}" não existe. Notas disponíveis: ${(await listSlugs()).join(', ')}.`);
    }
    // Uma tool pode chamar um LLM por dentro. A chamada passa por @labs/shared-llm, então
    // aparece nas métricas do servidor (em stderr) como qualquer outra.
    const { text: summary } = await generateText({
      system: SUMMARIZE_SYSTEM,
      prompt: summarizePrompt(note),
      tier: 'fast',
      label: 'mcp:summarize_note',
    });
    return text(summary);
  },
);

// PONTO DE EXTENSÃO: para servir pela rede em vez de stdio, troque o transporte pelo
// Streamable HTTP do SDK e coloque autenticação na frente.
await server.connect(new StdioServerTransport());
logger.info('[MCP] servidor "labs-notes" pronto em stdio');
