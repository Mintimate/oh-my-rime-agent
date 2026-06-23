import { tool } from '@openai/agents';
import { z } from 'zod';
import { queryOhMyRimeKnowledgeBase, formatKnowledgeContext } from './_knowledge';

type ToolEnv = Record<string, string | undefined>;

export interface RimeToolOptions {
  env: ToolEnv;
  signal?: AbortSignal;
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
        'Perform lightweight checks for a Rime YAML/custom patch snippet. This catches common indentation and patch mistakes, not full Rime semantic validation.',
      parameters: z.object({
        yaml: z.string().describe('YAML snippet to inspect.'),
      }),
      execute({ yaml }) {
        return JSON.stringify(validateYamlSnippet(yaml), null, 2);
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
          properties: { yaml: { type: 'string' } },
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
      return JSON.stringify(validateYamlSnippet(String(args.yaml ?? '')), null, 2);
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

function validateYamlSnippet(yaml: string) {
  const warnings: string[] = [];
  const lines = yaml.split(/\r?\n/);
  const patchLines = lines.filter((line) => /^patch:\s*$/.test(line.trim()));

  if (patchLines.length === 0) warnings.push('Missing top-level patch: block for a *.custom.yaml override.');
  if (patchLines.length > 1) warnings.push('A custom YAML file should normally contain only one patch: block.');

  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.includes('\t')) warnings.push(`Line ${index + 1}: tabs are risky in YAML; use spaces.`);
    if (/^style:\s*$/.test(line.trim())) {
      warnings.push(
        `Line ${index + 1}: patching "style:" as a nested map can clear existing style values; prefer quoted slash paths such as "style/color_scheme".`,
      );
    }
    if (/^[^#]*style\/[^"'\s][^:]*:/.test(line)) {
      warnings.push(`Line ${index + 1}: quote slash paths, for example "style/candidate_list_layout": linear.`);
    }
  }

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toYamlScalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value ?? '');
}
