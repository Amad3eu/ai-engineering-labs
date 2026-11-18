import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// As ferramentas do copiloto. Todas são somente leitura: o agente investiga e simula,
// nunca muda o cluster. Não existe ferramenta de "aplicar".
//
// O cluster aqui é uma pasta de arquivos (data/), para o laboratório rodar sem Kubernetes.
// PONTO DE EXTENSÃO: troque `readFixture` por chamadas reais (kubectl, API do Kubernetes),
// mantendo a mesma interface e o mesmo cuidado com a entrada.

export interface Tool {
  description: string;
  /** Erro volta como texto na observação, para o agente poder se corrigir. */
  run(input: string): Promise<string>;
}

const DATA_DIR = join(import.meta.dirname, '../data');
const LOG_TAIL_LINES = 40;

/**
 * Lê um arquivo de exemplo pelo nome. A entrada do modelo nunca compõe um caminho: o nome
 * precisa ser igual a um arquivo que existe na pasta, o que barra `../` e afins.
 */
async function readFixture(folder: string, fileName: string): Promise<string | undefined> {
  const available = await readdir(join(DATA_DIR, folder));
  return available.includes(fileName) ? readFile(join(DATA_DIR, folder, fileName), 'utf8') : undefined;
}

async function listFixtures(folder: string, prefix: string, suffix: string): Promise<string> {
  const names = (await readdir(join(DATA_DIR, folder)))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, -suffix.length || undefined));
  return names.join(', ') || '(nenhum)';
}

// --- Dry-run de manifesto ---------------------------------------------------------------

const Container = z.object({
  name: z.string(),
  image: z.string(),
  resources: z
    .object({
      requests: z.object({ memory: z.string().optional() }).optional(),
      limits: z.object({ memory: z.string().optional() }).optional(),
    })
    .optional(),
  readinessProbe: z.unknown().optional(),
});

const Deployment = z.object({
  kind: z.literal('Deployment'),
  metadata: z.object({ name: z.string(), namespace: z.string().default('default') }),
  spec: z.object({
    replicas: z.number().int().default(1),
    template: z.object({ spec: z.object({ containers: z.array(Container).min(1) }) }),
  }),
});
type Deployment = z.infer<typeof Deployment>;

const MEMORY = /^(\d+)(Mi|Gi)$/;
const toMebibytes = (quantity: string): number | undefined => {
  const match = quantity.match(MEMORY);
  return match ? Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1) : undefined;
};

// Cada campo que o agente pode propor mudar: como validar o valor e onde aplicar.
// PONTO DE EXTENSÃO: um campo novo é uma entrada aqui.
const PATCHABLE: Record<string, { valid: RegExp; apply(deployment: Deployment, value: string): string }> = {
  memory_limit: {
    valid: MEMORY,
    apply(deployment, value) {
      const container = deployment.spec.template.spec.containers[0];
      if (!container) return '';
      const before = container.resources?.limits?.memory ?? '(sem limite)';
      container.resources = { ...container.resources, limits: { ...container.resources?.limits, memory: value } };
      return `containers[${container.name}].resources.limits.memory: ${before} → ${value}`;
    },
  },
  image_tag: {
    valid: /^[\w][\w.-]*$/,
    apply(deployment, value) {
      const container = deployment.spec.template.spec.containers[0];
      if (!container) return '';
      const before = container.image;
      container.image = `${before.replace(/:[^:/]+$/, '')}:${value}`;
      return `containers[${container.name}].image: ${before} → ${container.image}`;
    },
  },
  replicas: {
    valid: /^([1-9]|[1-4]\d|50)$/,
    apply(deployment, value) {
      const before = deployment.spec.replicas;
      deployment.spec.replicas = Number(value);
      return `spec.replicas: ${before} → ${value}`;
    },
  },
};

/** Regras de política do time de plataforma, checadas no manifesto resultante. */
function policyFindings(deployment: Deployment): string[] {
  const findings: string[] = [];
  for (const container of deployment.spec.template.spec.containers) {
    const tag = container.image.match(/:([^:/]+)$/)?.[1];
    const limit = container.resources?.limits?.memory;
    const request = container.resources?.requests?.memory;

    if (!tag || tag === 'latest') {
      findings.push(
        `[alto] container "${container.name}": imagem sem versão fixa (${container.image}). Um novo pull pode trazer outro código.`,
      );
    }
    if (!limit) {
      findings.push(`[alto] container "${container.name}": sem limite de memória.`);
    } else if (request && (toMebibytes(request) ?? 0) > (toMebibytes(limit) ?? 0)) {
      findings.push(
        `[alto] container "${container.name}": request de memória (${request}) maior que o limite (${limit}). O Kubernetes recusa este manifesto.`,
      );
    }
    if (!container.readinessProbe) {
      findings.push(
        `[médio] container "${container.name}": sem readinessProbe. O pod recebe tráfego antes de estar pronto.`,
      );
    }
  }
  if (deployment.metadata.namespace === 'prod' && deployment.spec.replicas < 2) {
    findings.push(`[médio] spec.replicas = ${deployment.spec.replicas} em prod: sem redundância.`);
  }
  return findings;
}

async function dryRunManifest(input: string): Promise<string> {
  const [fileName = '', ...assignments] = input.trim().split(/\s+/);
  const yaml = await readFixture('manifests', fileName);
  if (yaml === undefined) {
    return `Erro: manifesto "${fileName}" não existe. Disponíveis: ${await listFixtures('manifests', '', '')}.`;
  }

  // O arquivo também é entrada externa: passa por schema antes de qualquer conta.
  const parsed = Deployment.safeParse(parseYaml(yaml));
  if (!parsed.success) return `Erro: "${fileName}" não é um Deployment válido.\n${z.prettifyError(parsed.error)}`;
  const deployment = parsed.data;

  const changes: string[] = [];
  for (const assignment of assignments) {
    const [field = '', value = ''] = assignment.split('=');
    const patch = PATCHABLE[field];
    if (!patch)
      return `Erro: campo "${field}" não pode ser alterado. Campos aceitos: ${Object.keys(PATCHABLE).join(', ')}.`;
    if (!patch.valid.test(value)) return `Erro: valor inválido para ${field}: "${value}".`;
    changes.push(patch.apply(deployment, value));
  }

  const findings = policyFindings(deployment);
  return [
    `(dry run) deployment.apps/${deployment.metadata.name} em ${deployment.metadata.namespace}: simulado, nada foi aplicado.`,
    `Alterações propostas:\n${changes.length > 0 ? changes.map((change) => `  ~ ${change}`).join('\n') : '  (nenhuma: manifesto como está no repositório)'}`,
    `Validação de política:\n${findings.length > 0 ? findings.map((finding) => `  ${finding}`).join('\n') : '  sem achados.'}`,
  ].join('\n');
}

// --- Registro ---------------------------------------------------------------------------

export const TOOLS = {
  get_pods: {
    description: 'Lista os pods do cluster com status e reinícios. Entrada: vazia.',
    run: async () => (await readFixture('cluster', 'pods.txt')) ?? 'Erro: listagem de pods indisponível.',
  },
  describe_pod: {
    description: 'Detalhes de um pod: estado do container, último término, limites e eventos. Entrada: o nome do pod.',
    run: async (input) =>
      (await readFixture('cluster', `describe-${input.trim()}.txt`)) ??
      `Erro: sem dados para o pod "${input.trim()}". Pods com dados: ${await listFixtures('cluster', 'describe-', '.txt')}.`,
  },
  get_logs: {
    description: `Últimas ${LOG_TAIL_LINES} linhas de log de um pod. Entrada: o nome do pod.`,
    run: async (input) => {
      const logs = await readFixture('cluster', `logs-${input.trim()}.log`);
      if (logs === undefined) {
        return `Erro: sem logs para o pod "${input.trim()}". Pods com logs: ${await listFixtures('cluster', 'logs-', '.log')}.`;
      }
      return logs.trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');
    },
  },
  dry_run_manifest: {
    description:
      'Simula a aplicação de um manifesto e checa as regras de política, sem aplicar nada. ' +
      'Entrada: "<arquivo>" para validar como está, ou "<arquivo> campo=valor ..." para validar uma mudança. ' +
      `Campos: ${Object.keys(PATCHABLE).join(', ')}. Exemplo: "checkout-deployment.yaml memory_limit=512Mi".`,
    run: dryRunManifest,
  },
} satisfies Record<string, Tool>;

export const describeTools = () =>
  Object.entries(TOOLS)
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join('\n');
