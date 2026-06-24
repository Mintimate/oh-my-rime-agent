import { tool } from '@openai/agents';
import { z } from 'zod';
import { queryOhMyRimeKnowledgeBase, formatKnowledgeContext } from './_knowledge';

type ToolEnv = Record<string, string | undefined>;

interface RimeSandbox {
  runCode?: (
    code: string,
    options?: { language?: string; timeout?: number },
  ) => Promise<{ results?: unknown; logs?: unknown; error?: unknown }>;
}

interface RimeValidationIssue {
  severity: 'error' | 'warning';
  line?: number;
  code: string;
  message: string;
  suggestion?: string;
}

interface RimeValidationReport {
  ok: boolean;
  mode: string;
  filename?: string;
  summary: string;
  issues: RimeValidationIssue[];
  sandbox?: {
    available: boolean;
    ok?: boolean;
    note?: string;
    logs?: unknown;
    results?: unknown;
  };
}

export interface RimeToolOptions {
  env: ToolEnv;
  signal?: AbortSignal;
  sandbox?: RimeSandbox;
}

const clientMap = {
  weasel: {
    label: 'Windows 小狼毫 / Weasel',
    baseFile: 'weasel.yaml',
    customFile: 'weasel.custom.yaml',
    scope: 'application style, theme, candidate window',
  },
  squirrel: {
    label: 'macOS 鼠须管 / Squirrel',
    baseFile: 'squirrel.yaml',
    customFile: 'squirrel.custom.yaml',
    scope: 'application style, theme, candidate window',
  },
  fcitx5: {
    label: 'Linux/Android Fcitx5 Rime',
    baseFile: 'default.yaml or schema-specific *.schema.yaml',
    customFile: 'default.custom.yaml or schema-specific *.custom.yaml',
    scope: 'schema behavior, key bindings, candidate count; UI depends on Fcitx5 frontend config',
  },
  ibus: {
    label: 'Linux IBus Rime',
    baseFile: 'default.yaml or schema-specific *.schema.yaml',
    customFile: 'default.custom.yaml or schema-specific *.custom.yaml',
    scope: 'schema behavior, key bindings, candidate count; UI depends on IBus frontend config',
  },
  trime: {
    label: 'Android 同文 / Trime',
    baseFile: 'trime.yaml plus schema files',
    customFile: 'trime.custom.yaml or schema-specific *.custom.yaml',
    scope: 'Android keyboard layout/theme plus schema behavior',
  },
} as const;

type ClientKey = keyof typeof clientMap;

const recipeMap = {
  horizontal_candidates_weasel: {
    title: '小狼毫横向候选栏',
    targetFile: 'weasel.custom.yaml',
    patch: {
      'style/candidate_list_layout': 'linear',
      'style/horizontal': true,
    },
    notes: [
      'candidate_list_layout: linear 是优先方案。',
      '小狼毫上如果 candidate_list_layout 不生效，再用 horizontal: true 作为兼容后备。',
      '使用 custom 覆写文件，不直接改 weasel.yaml。',
    ],
  },
  horizontal_candidates_squirrel: {
    title: '鼠须管横向候选栏',
    targetFile: 'squirrel.custom.yaml',
    patch: {
      'style/candidate_list_layout': 'linear',
    },
    notes: ['使用 custom 覆写文件，不直接改 squirrel.yaml。'],
  },
  candidate_page_size: {
    title: '候选词数量',
    targetFile: 'schema-specific *.custom.yaml, for example rime_mint.custom.yaml',
    patch: {
      'menu/page_size': 6,
    },
    notes: [
      'oh-my-rime 的 page_size 常在各 schema 内冗余定义。',
      '优先修改对应方案的 *.custom.yaml，而不是 default.custom.yaml。',
    ],
  },
  switch_color_scheme_weasel: {
    title: '小狼毫切换皮肤配色',
    targetFile: 'weasel.custom.yaml',
    patch: {
      'style/color_scheme': 'mint_light_green',
      'style/color_scheme_dark': 'mint_dark_green',
    },
    notes: ['配色名称必须存在于 weasel.yaml 或当前主题配置中。'],
  },
  switch_color_scheme_squirrel: {
    title: '鼠须管切换皮肤配色',
    targetFile: 'squirrel.custom.yaml',
    patch: {
      'style/color_scheme': 'mint_light_green',
      'style/color_scheme_dark': 'mint_dark_green',
    },
    notes: ['配色名称必须存在于 squirrel.yaml 或当前主题配置中。'],
  },
} as const;

export function createRimeTools(options: RimeToolOptions) {
  return [
    tool({
      name: 'search_docs',
      description:
        'Search the oh-my-rime documentation/vector knowledge base. Use this before giving file names, patch paths, or platform-specific instructions.',
      parameters: z.object({
        query: z.string().describe('Search query in Chinese or English. Include platform and config key when possible.'),
      }),
      async execute({ query }) {
        const result = await queryOhMyRimeKnowledgeBase(query, options.env, options.signal);
        return formatKnowledgeContext(result);
      },
      timeoutMs: 15_000,
      timeoutBehavior: 'error_as_result',
    }),

    tool({
      name: 'resolve_client',
      description:
        'Resolve user platform/client wording such as 小狼毫, 鼠须管, Weasel, Squirrel, fcitx5, ibus, 同文 into Rime client config files.',
      parameters: z.object({
        platform_text: z.string().describe('User-provided platform/client text.'),
      }),
      execute({ platform_text }) {
        const client = resolveClient(platform_text);
        return JSON.stringify({ client, ...clientMap[client] }, null, 2);
      },
    }),

    tool({
      name: 'target_file',
      description:
        'Suggest the safest oh-my-rime file to edit for a platform and task. Prefer custom overlay files.',
      parameters: z.object({
        platform_text: z.string().describe('Platform/client wording, for example 小狼毫 or macOS 鼠须管.'),
        task: z.string().describe('The user task, for example 横向候选栏, 候选词数量, 皮肤, 快捷键.'),
        schema: z.string().optional().describe('Optional schema name, for example rime_mint or double_pinyin_flypy.'),
      }),
      execute({ platform_text, task, schema }) {
        const client = resolveClient(platform_text);
        const lowerTask = task.toLowerCase();
        const isSchemaTask = /候选词数量|候选数|page_size|快捷键|key_binder|模糊音|speller|translator|schema/.test(
          lowerTask,
        );
        const targetFile = isSchemaTask
          ? `${schema?.trim() || 'rime_mint'}.custom.yaml`
          : clientMap[client].customFile;

        return JSON.stringify(
          {
            client,
            targetFile,
            editMode: 'custom_overlay',
            reason: isSchemaTask
              ? 'This is schema behavior, so prefer the corresponding schema-specific *.custom.yaml.'
              : `This is ${clientMap[client].scope}, so prefer ${clientMap[client].customFile}.`,
          },
          null,
          2,
        );
      },
    }),

    tool({
      name: 'make_patch',
      description:
        'Build a safe Rime custom YAML patch block from slash-path entries. Use quoted slash paths to avoid clearing parent maps.',
      parameters: z.object({
        entries: z
          .array(
            z.object({
              path: z.string().describe('Slash path under patch, for example style/candidate_list_layout.'),
              value: z.union([z.string(), z.number(), z.boolean()]).describe('YAML scalar value.'),
              comment: z.string().optional().describe('Optional inline comment.'),
            }),
          )
          .min(1),
      }),
      execute({ entries }) {
        const lines = ['patch:'];
        for (const entry of entries) {
          const value = formatYamlScalar(entry.value);
          const comment = entry.comment ? ` # ${entry.comment.replace(/\n/g, ' ')}` : '';
          lines.push(`  "${entry.path}": ${value}${comment}`);
        }
        return lines.join('\n');
      },
    }),

    tool({
      name: 'check_yaml',
      description:
        'Validate a Rime YAML/custom patch snippet. Checks that *.custom.yaml starts with top-level patch:, uses path-style patch entries, and avoids tab/indentation mistakes.',
      parameters: z.object({
        yaml: z.string().describe('YAML snippet to inspect.'),
        filename: z.string().optional().describe('Optional filename, for example weasel.custom.yaml.'),
      }),
      async execute({ yaml, filename }) {
        return JSON.stringify(await checkYamlSnippet(yaml, filename, options), null, 2);
      },
    }),

    tool({
      name: 'recipe',
      description:
        'Return a known oh-my-rime editing recipe for common tasks such as horizontal candidates, page size, and color schemes.',
      parameters: z.object({
        recipe: z
          .enum([
            'horizontal_candidates_weasel',
            'horizontal_candidates_squirrel',
            'candidate_page_size',
            'switch_color_scheme_weasel',
            'switch_color_scheme_squirrel',
          ])
          .describe('Recipe identifier.'),
      }),
      execute({ recipe }) {
        const item = recipeMap[recipe];
        return JSON.stringify(
          {
            ...item,
            yaml: renderPatch(item.patch),
          },
          null,
          2,
        );
      },
    }),
  ];
}

export function shouldEnableModelTools(env: ToolEnv): boolean {
  return env.ENABLE_MODEL_TOOLS === 'true';
}

export function createRimeOpenAITools() {
  return [
    {
      type: 'function',
      function: {
        name: 'search_docs',
        description: 'Search the oh-my-rime documentation/vector knowledge base.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resolve_client',
        description: 'Resolve platform/client wording to Rime client config files.',
        parameters: {
          type: 'object',
          properties: { platform_text: { type: 'string' } },
          required: ['platform_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'target_file',
        description: 'Suggest the safest oh-my-rime file to edit for a platform and task.',
        parameters: {
          type: 'object',
          properties: {
            platform_text: { type: 'string' },
            task: { type: 'string' },
            schema: { type: 'string' },
          },
          required: ['platform_text', 'task'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'make_patch',
        description: 'Build a safe Rime custom YAML patch block from slash-path entries.',
        parameters: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  comment: { type: 'string' },
                },
                required: ['path', 'value'],
              },
            },
          },
          required: ['entries'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_yaml',
        description: 'Perform lightweight checks for a Rime YAML/custom patch snippet.',
        parameters: {
          type: 'object',
          properties: {
            yaml: { type: 'string' },
            filename: { type: 'string' },
          },
          required: ['yaml'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recipe',
        description: 'Return a known oh-my-rime editing recipe for common tasks.',
        parameters: {
          type: 'object',
          properties: {
            recipe: {
              type: 'string',
              enum: [
                'horizontal_candidates_weasel',
                'horizontal_candidates_squirrel',
                'candidate_page_size',
                'switch_color_scheme_weasel',
                'switch_color_scheme_squirrel',
              ],
            },
          },
          required: ['recipe'],
        },
      },
    },
  ];
}

export async function executeRimeOpenAITool(
  name: string,
  args: Record<string, unknown>,
  options: RimeToolOptions,
): Promise<string> {
  switch (name) {
    case 'search_docs': {
      const result = await queryOhMyRimeKnowledgeBase(String(args.query ?? ''), options.env, options.signal);
      return formatKnowledgeContext(result);
    }
    case 'resolve_client': {
      const client = resolveClient(String(args.platform_text ?? ''));
      return JSON.stringify({ client, ...clientMap[client] }, null, 2);
    }
    case 'target_file': {
      const client = resolveClient(String(args.platform_text ?? ''));
      const task = String(args.task ?? '');
      const schema = typeof args.schema === 'string' ? args.schema : undefined;
      const isSchemaTask = /候选词数量|候选数|page_size|快捷键|key_binder|模糊音|speller|translator|schema/i.test(
        task,
      );
      const targetFile = isSchemaTask
        ? `${schema?.trim() || 'rime_mint'}.custom.yaml`
        : clientMap[client].customFile;
      return JSON.stringify(
        {
          client,
          targetFile,
          editMode: 'custom_overlay',
          reason: isSchemaTask
            ? 'This is schema behavior, so prefer the corresponding schema-specific *.custom.yaml.'
            : `This is ${clientMap[client].scope}, so prefer ${clientMap[client].customFile}.`,
        },
        null,
        2,
      );
    }
    case 'make_patch': {
      const entries = Array.isArray(args.entries) ? args.entries : [];
      const lines = ['patch:'];
      for (const raw of entries) {
        if (!isRecord(raw)) continue;
        const path = String(raw.path ?? '');
        if (!path) continue;
        const value = formatYamlScalar(toYamlScalar(raw.value));
        const comment = typeof raw.comment === 'string' ? ` # ${raw.comment.replace(/\n/g, ' ')}` : '';
        lines.push(`  "${path}": ${value}${comment}`);
      }
      return lines.join('\n');
    }
    case 'check_yaml':
      return JSON.stringify(
        await checkYamlSnippet(
          String(args.yaml ?? ''),
          typeof args.filename === 'string' ? args.filename : undefined,
          options,
        ),
        null,
        2,
      );
    case 'recipe': {
      const key = String(args.recipe ?? '') as keyof typeof recipeMap;
      const item = recipeMap[key];
      if (!item) return `Unknown recipe: ${String(args.recipe ?? '')}`;
      return JSON.stringify({ ...item, yaml: renderPatch(item.patch) }, null, 2);
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

function resolveClient(text: string): ClientKey {
  const normalized = text.toLowerCase();
  if (/小狼毫|weasel|windows|\bwin\b/.test(normalized)) return 'weasel';
  if (/鼠须管|squirrel|macos|mac os|darwin/.test(normalized)) return 'squirrel';
  if (/fcitx5|小企鹅/.test(normalized)) return 'fcitx5';
  if (/ibus/.test(normalized)) return 'ibus';
  if (/同文|trime/.test(normalized)) return 'trime';
  return 'weasel';
}

function renderPatch(patch: Record<string, string | number | boolean>): string {
  const lines = ['patch:'];
  for (const [path, value] of Object.entries(patch)) {
    lines.push(`  "${path}": ${formatYamlScalar(value)}`);
  }
  return lines.join('\n');
}

function formatYamlScalar(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function checkYamlSnippet(yaml: string, filename: string | undefined, options: RimeToolOptions) {
  const report = validateYamlSnippet(yaml, filename);

  if (options.sandbox?.runCode) {
    try {
      const sandboxProbe = await options.sandbox.runCode(buildSandboxProbeCode(yaml), {
        language: 'python',
        timeout: 3,
      });
      report.sandbox = normalizeSandboxProbe(sandboxProbe);
    } catch (error) {
      report.sandbox = {
        available: false,
        note: `Sandbox probe failed: ${(error as Error).message}`,
      };
    }
  }

  return report;
}

export function validateYamlSnippet(yaml: string, filename?: string): RimeValidationReport {
  const issues: RimeValidationIssue[] = [];
  const lines = yaml.split(/\r?\n/);
  const customMode = !filename || /\.custom\.ya?ml$/i.test(filename);
  const firstContentIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#');
  });
  const patchLineIndexes = lines
    .map((line, index) => (/^patch:\s*(?:#.*)?$/.test(line) ? index : -1))
    .filter((index) => index >= 0);

  if (!yaml.trim()) {
    addIssue('error', 'empty_config', 'Configuration snippet is empty.');
  }

  if (customMode) {
    if (firstContentIndex === -1) {
      addIssue('error', 'missing_patch', 'A *.custom.yaml override must start with a top-level patch: block.');
    } else if (!/^patch:\s*(?:#.*)?$/.test(lines[firstContentIndex])) {
      addIssue(
        'error',
        'first_content_not_patch',
        'The first non-comment line of a *.custom.yaml override must be exactly top-level patch:.',
        firstContentIndex + 1,
        'Move patch: to the first non-comment line and keep it at column 1.',
      );
    }
  }

  if (customMode && patchLineIndexes.length === 0) {
    addIssue(
      'error',
      'missing_patch',
      'Missing top-level patch: block for a Rime *.custom.yaml override.',
      undefined,
      'Start the file with patch:, then put path-style entries under it.',
    );
  } else if (customMode && patchLineIndexes.length > 1) {
    addIssue(
      'warning',
      'multiple_patch_blocks',
      'A custom YAML file should normally contain only one top-level patch: block.',
      patchLineIndexes[1] + 1,
    );
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (line.includes('\t')) {
      addIssue('error', 'tab_character', 'Tabs are not safe in Rime/YAML configuration; use spaces only.', lineNumber);
    }

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent > 0 && indent % 2 !== 0) {
      addIssue('warning', 'odd_indentation', 'Indentation is not a multiple of two spaces.', lineNumber);
    }

    if (/^\s+patch:\s*(?:#.*)?$/.test(line)) {
      addIssue('error', 'indented_patch', 'patch: must be top-level at column 1.', lineNumber);
    }

    if (customMode && /^style:\s*$/.test(trimmed)) {
      addIssue(
        'warning',
        'nested_style_patch',
        'Patching style: as a nested map can clear existing style values in a custom overlay.',
        lineNumber,
        'Prefer quoted slash paths such as "style/color_scheme".',
      );
    }

    const patchEntry = customMode ? line.match(/^ {2}([^#][^:]*):(?:\s|$)/) : null;
    if (patchEntry) {
      const key = patchEntry[1].trim();
      if (key.endsWith('/')) {
        addIssue('warning', 'path_trailing_slash', 'Patch path ends with /, which is rarely intended.', lineNumber);
      }
      if (key.includes('/') && !/^["'].*["']$/.test(key)) {
        addIssue(
          'warning',
          'unquoted_slash_path',
          'Slash-path patch keys should be quoted for Rime custom files.',
          lineNumber,
          'Use "style/candidate_list_layout": linear.',
        );
      }
      if (!key.includes('/') && !['__include', '__patch'].includes(key.replace(/^["']|["']$/g, ''))) {
        addIssue(
          'warning',
          'non_path_patch_key',
          'Rime custom patch entries normally use path syntax under patch:.',
          lineNumber,
          'Use a slash path such as "style/candidate_list_layout" when overriding nested keys.',
        );
      }
    } else if (customMode && patchLineIndexes.length > 0 && index > patchLineIndexes[0] && indent === 0) {
      addIssue(
        'warning',
        'top_level_after_patch',
        'Top-level content after patch: will not be part of the custom overlay patch map.',
        lineNumber,
      );
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return {
    ok: errors.length === 0,
    mode: customMode ? 'rime_custom_patch' : 'yaml_snippet',
    filename,
    summary:
      errors.length === 0 && warnings.length === 0
        ? 'No common Rime custom patch issues found.'
        : `${errors.length} error(s), ${warnings.length} warning(s).`,
    issues,
  };

  function addIssue(
    severity: 'error' | 'warning',
    code: string,
    message: string,
    line?: number,
    suggestion?: string,
  ) {
    issues.push({ severity, line, code, message, suggestion });
  }
}

function buildSandboxProbeCode(yaml: string): string {
  return [
    'text = ' + JSON.stringify(yaml),
    'lines = text.splitlines()',
    'tabs = [i + 1 for i, line in enumerate(lines) if "\\t" in line]',
    'first = next((i + 1 for i, line in enumerate(lines) if line.strip() and not line.strip().startswith("#")), None)',
    'print({"line_count": len(lines), "first_content_line": first, "tab_lines": tabs})',
  ].join('\n');
}

function normalizeSandboxProbe(probe: { results?: unknown; logs?: unknown; error?: unknown }) {
  if (probe.error) {
    return {
      available: true,
      ok: false,
      note: String(probe.error),
    };
  }

  return {
    available: true,
    ok: true,
    logs: probe.logs,
    results: probe.results,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toYamlScalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value ?? '');
}
