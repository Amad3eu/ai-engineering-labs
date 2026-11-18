import { setMockResponder } from '@labs/shared-llm';

// Roteiro do provedor mock: a investigação que um modelo faria no incidente de index.ts.
// Só tem efeito sem chave de API. As ferramentas rodam de verdade sobre os arquivos de
// data/: o que é roteirizado é só a escolha do próximo passo.

const POD = 'checkout-7d9f8c6b5-x2x4q';

const STEPS = [
  { thought: 'Começo pelo estado dos pods.', action: 'get_pods', input: '' },
  {
    thought: 'Os dois pods do checkout estão em CrashLoopBackOff. Vejo o motivo do último término.',
    action: 'describe_pod',
    input: POD,
  },
  {
    thought: 'OOMKilled com limite de 128Mi. Confirmo nos logs o que consome a memória.',
    action: 'get_logs',
    input: POD,
  },
  {
    thought: 'O catálogo de preços estoura o heap na subida. Valido o manifesto atual.',
    action: 'dry_run_manifest',
    input: 'checkout-deployment.yaml',
  },
  {
    thought: 'Simulo o aumento do limite de memória antes de recomendar.',
    action: 'dry_run_manifest',
    input: 'checkout-deployment.yaml memory_limit=512Mi',
  },
  {
    thought: 'Tenho causa, evidência de duas fontes e a mudança validada.',
    action: 'finish',
    input: [
      'Causa raiz: o container checkout é morto por falta de memória (OOMKilled) ao carregar o catálogo de preços na subida. O limite de 128Mi não comporta a carga.',
      `Evidências: describe do pod ${POD} mostra Last State = OOMKilled, exit code 137, 14 reinícios; os logs mostram o heap em 119 de 128 MB e a carga do catálogo interrompida em 431.200 de 480.000 entradas.`,
      'Mudança recomendada (validada em dry-run, nada aplicado): memory_limit=512Mi em checkout-deployment.yaml.',
      'Riscos que continuam abertos: imagem com tag :latest e ausência de readinessProbe, apontados pela validação de política.',
    ].join('\n'),
  },
];

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    if (label !== 'copilot:reason') return undefined;
    const observations = (prompt.match(/<observacao>/g) ?? []).length;
    return STEPS[Math.min(observations, STEPS.length - 1)];
  });
}
