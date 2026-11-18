// Lab 03: Servidores MCP
//
// Este arquivo é o cliente de teste: inicia o servidor de server.ts como processo filho,
// conversa com ele pelo protocolo MCP (stdio) e imprime o que encontrou. É o mesmo caminho
// que o Claude Code ou o Claude Desktop percorrem ao conectar no servidor.
//
// Rodar: pnpm --filter @labs/03-mcp-servers dev

import { join } from 'node:path';
import { timed } from '@labs/shared-observability';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

// O resultado de uma tool vem de outro processo: é validado como qualquer entrada externa.
const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

const transport = new StdioClientTransport({
  // O mesmo Node e as mesmas flags deste processo (o loader do tsx e a condição
  // @labs/source), para o servidor rodar direto do TypeScript, sem build.
  command: process.execPath,
  args: [...process.execArgv, join(import.meta.dirname, 'server.ts')],
  // Por padrão o SDK repassa só um punhado de variáveis ao filho. Este servidor é código
  // nosso e precisa das chaves de LLM, então recebe o ambiente inteiro.
  // Com servidor de terceiro, repasse só o que ele precisa.
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});

const client = new Client({ name: 'labs-test-client', version: '0.1.0' });
const calls: Array<Record<string, unknown>> = [];

/** Chama uma tool, mede a ida e volta e imprime o texto devolvido. */
async function callTool(name: string, args: Record<string, string>): Promise<void> {
  const { value, latencyMs } = await timed(() => client.callTool({ name, arguments: args }));
  const result = ToolResult.parse(value);
  const output = result.content.map((item) => item.text ?? `[${item.type}]`).join('\n');

  console.log(`\n> ${name}(${JSON.stringify(args)})${result.isError ? '  [erro devolvido pela tool]' : ''}\n${output}`);
  calls.push({ tool: name, 'ida e volta (ms)': Math.round(latencyMs), erro: result.isError ?? false });
}

await client.connect(transport);
try {
  // 1. Descoberta: o cliente pergunta o que o servidor oferece. É esta lista, com as
  //    descrições, que o modelo recebe para decidir quando chamar cada tool.
  const { tools } = await client.listTools();
  console.log('Tools:');
  for (const tool of tools) console.log(`- ${tool.name}: ${tool.description}`);

  const { resources } = await client.listResources();
  console.log('\nResources:');
  for (const resource of resources) console.log(`- ${resource.uri}`);

  // 2. Leitura de um resource: conteúdo que o cliente pode anexar ao contexto do modelo.
  const [first] = resources;
  if (first) {
    const { contents } = await client.readResource({ uri: first.uri });
    const [content] = contents;
    const body = content && 'text' in content ? String(content.text) : '';
    console.log(`\n> readResource(${first.uri})\n${body.slice(0, 200).trimEnd()}…`);
  }

  // 3. Chamadas de tool.
  // PONTO DE EXTENSÃO: registre uma tool nova em server.ts e chame-a aqui.
  await callTool('search_notes', { query: 'rollback' });
  await callTool('summarize_note', { slug: 'politica-de-deploy' });
  // Entrada hostil: a tool recusa e devolve o erro como resultado, sem derrubar o servidor.
  await callTool('summarize_note', { slug: '../../.env' });
} finally {
  await client.close();
}

// Estes são os números da tabela "Trade-offs e Métricas Observadas" do README.
console.log('\nChamadas:');
console.table(calls);
