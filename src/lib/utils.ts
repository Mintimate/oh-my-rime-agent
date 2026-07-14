export function createUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function cleanText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function toolLabel(name: string) {
  const labels: Record<string, string> = {
    judge_off_topic: 'Scope Check',
    oh_my_rime_knowledge_base: 'Knowledge Base',
    plan_knowledge_queries: 'Query Planner',
    compose_prompt_context: 'Prompt Context',
    search_docs: 'Docs Search',
    resolve_client: 'Client Resolver',
    target_file: 'Target File',
    make_patch: 'Patch Builder',
    check_yaml: 'YAML Validator',
    diagnose_rime_directory: 'Config Diagnosis',
  };
  return labels[name] || name.replace(/_/g, ' ');
}
