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
    judge_off_topic: '确认问题范围',
    oh_my_rime_knowledge_base: '检索官方知识库',
    plan_knowledge_queries: '规划文档检索',
    compose_prompt_context: '整理回答依据',
    search_docs: '查找配置文档',
    resolve_client: '确认输入法客户端',
    target_file: '定位配置文件',
    make_patch: '生成配置补丁',
    check_yaml: '检查 YAML 语法',
    diagnose_rime_directory: '诊断配置文件',
    recipe: '查找配置方案',
  };
  return labels[name] || name.replace(/_/g, ' ');
}
