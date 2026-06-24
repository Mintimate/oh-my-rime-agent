import { validateYamlSnippet } from './_tools';

interface UploadedRimeFileInput {
  path?: unknown;
  name?: unknown;
  content?: unknown;
  size?: unknown;
  truncated?: unknown;
}

interface UploadedRimeFile {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

interface RimeSandbox {
  runCode?: (
    code: string,
    options?: { language?: string; timeout?: number },
  ) => Promise<{ results?: unknown; logs?: unknown; error?: unknown }>;
}

const MAX_FILES = 1;
const MAX_FILE_CHARS = 5 * 1024 * 1024;
const MAX_TOTAL_CHARS = 5 * 1024 * 1024;
const MAX_RAW_ITEMS_TO_SCAN = 160;

const RIME_NAME_PATTERN = /(^|\/)(default|weasel|squirrel|ibus|trime|installation|user)\.ya?ml$/i;
const RIME_YAML_PATTERN = /\.(custom|schema|dict)\.ya?ml$/i;

export async function diagnoseUploadedRimeDirectory(
  rawFiles: unknown,
  sandbox: RimeSandbox | undefined,
  conversationId: string,
) {
  const { files, skipped } = normalizeUploadedFiles(rawFiles);
  if (files.length === 0) {
    return null;
  }

  const staticReport = buildStaticDirectoryReport(files, skipped);
  const sandboxReport = await runSandboxDirectoryProbe(files, sandbox, conversationId);
  const report = {
    ...staticReport,
    sandbox: sandboxReport,
  };

  return {
    report,
    summaryText: formatDirectoryDiagnosticSummary(report),
  };
}

function normalizeUploadedFiles(rawFiles: unknown): { files: UploadedRimeFile[]; skipped: string[] } {
  const skipped: string[] = [];
  if (!Array.isArray(rawFiles)) {
    return { files: [], skipped };
  }

  const files: UploadedRimeFile[] = [];
  let totalChars = 0;

  for (const raw of rawFiles.slice(0, MAX_RAW_ITEMS_TO_SCAN)) {
    if (!isRecord(raw)) continue;
    const item = raw as UploadedRimeFileInput;
    const rawPath = typeof item.path === 'string' ? item.path : typeof item.name === 'string' ? item.name : '';
    const path = sanitizeRelativePath(rawPath);
    if (!path) {
      skipped.push(`${rawPath || '(unnamed)'}: invalid path`);
      continue;
    }

    if (!isLikelyRimeTextFile(path)) {
      skipped.push(`${path}: unsupported file type`);
      continue;
    }

    if (typeof item.content !== 'string') {
      skipped.push(`${path}: missing text content`);
      continue;
    }

    if (files.length >= MAX_FILES) {
      skipped.push(`${path}: file limit reached`);
      continue;
    }

    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) {
      skipped.push(`${path}: total text limit reached`);
      continue;
    }

    const originalContent = item.content.replace(/\r\n/g, '\n');
    const maxChars = Math.min(MAX_FILE_CHARS, remaining);
    const content = originalContent.slice(0, maxChars);
    const truncated = Boolean(item.truncated) || originalContent.length > content.length;
    files.push({
      path,
      content,
      size: typeof item.size === 'number' ? item.size : originalContent.length,
      truncated,
    });
    totalChars += content.length;
  }

  return { files, skipped };
}

function buildStaticDirectoryReport(files: UploadedRimeFile[], skipped: string[]) {
  const importantFiles = findImportantFiles(files);
  const issues: Array<{
    severity: 'error' | 'warning' | 'info';
    file?: string;
    line?: number;
    code: string;
    message: string;
    suggestion?: string;
  }> = [];

  for (const file of files) {
    if (file.truncated) {
      issues.push({
        severity: 'warning',
        file: file.path,
        code: 'file_truncated',
        message: 'File content was truncated before analysis.',
        suggestion: 'Upload a smaller config set if this file is central to the issue.',
      });
    }

    if (/\.ya?ml$/i.test(file.path)) {
      const validation = validateYamlSnippet(file.content, file.path);
      for (const issue of validation.issues) {
        issues.push({
          ...issue,
          file: file.path,
          severity: issue.severity,
        });
      }
    }
  }

  if (importantFiles.custom.length === 0) {
    issues.push({
      severity: 'info',
      code: 'no_custom_overlay',
      message: 'No *.custom.yaml files were uploaded.',
      suggestion: 'Upload the custom overlay files if the problem involves user overrides.',
    });
  }

  if (importantFiles.schema.length === 0) {
    issues.push({
      severity: 'info',
      code: 'no_schema_files',
      message: 'No *.schema.yaml files were uploaded.',
      suggestion: 'Upload schema files when diagnosing schema-specific behavior.',
    });
  }

  return {
    fileCount: files.length,
    totalChars: files.reduce((sum, file) => sum + file.content.length, 0),
    skipped,
    importantFiles,
    issues,
  };
}

async function runSandboxDirectoryProbe(
  files: UploadedRimeFile[],
  sandbox: RimeSandbox | undefined,
  conversationId: string,
) {
  if (!sandbox?.runCode) {
    return {
      available: false,
      note: 'context.sandbox.runCode is not available in this runtime.',
    };
  }

  try {
    const result = await sandbox.runCode(buildSandboxDirectoryProbeCode(files, conversationId), {
      language: 'python',
      timeout: 5,
    });
    if (result.error) {
      return {
        available: true,
        ok: false,
        note: String(result.error),
        logs: result.logs,
      };
    }
    return {
      available: true,
      ok: true,
      results: result.results,
      logs: result.logs,
    };
  } catch (error) {
    return {
      available: false,
      note: `Sandbox directory probe failed: ${(error as Error).message}`,
    };
  }
}

function buildSandboxDirectoryProbeCode(files: UploadedRimeFile[], conversationId: string): string {
  const safeConversation = conversationId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'conversation';
  const payload = files.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  return [
    'import json, pathlib, re, shutil',
    `base = pathlib.Path("/tmp/oh-my-rime-agent/${safeConversation}")`,
    'if base.exists():',
    '    shutil.rmtree(base)',
    'base.mkdir(parents=True, exist_ok=True)',
    `files = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
    'diagnostics = []',
    'for item in files:',
    '    rel = pathlib.PurePosixPath(item["path"])',
    '    target = base.joinpath(*rel.parts)',
    '    target.parent.mkdir(parents=True, exist_ok=True)',
    '    target.write_text(item["content"], encoding="utf-8")',
    '    lines = item["content"].splitlines()',
    '    tabs = [i + 1 for i, line in enumerate(lines) if "\\t" in line]',
    '    first = next((i + 1 for i, line in enumerate(lines) if line.strip() and not line.strip().startswith("#")), None)',
    '    patch_lines = [i + 1 for i, line in enumerate(lines) if re.match(r"^patch:\\s*(#.*)?$", line)]',
    '    diagnostics.append({',
    '        "path": item["path"],',
    '        "line_count": len(lines),',
    '        "first_content_line": first,',
    '        "tab_lines": tabs[:20],',
    '        "patch_lines": patch_lines[:20],',
    '    })',
    'print(json.dumps({"root": str(base), "files": diagnostics}, ensure_ascii=False))',
  ].join('\n');
}

function formatDirectoryDiagnosticSummary(report: ReturnType<typeof buildStaticDirectoryReport> & { sandbox: unknown }) {
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const warnings = report.issues.filter((issue) => issue.severity === 'warning');
  const infos = report.issues.filter((issue) => issue.severity === 'info');
  const issueLines = report.issues.slice(0, 24).map((issue) => {
    const location = [issue.file, issue.line ? `line ${issue.line}` : ''].filter(Boolean).join(':');
    const prefix = location ? `${location} ` : '';
    return `- [${issue.severity}] ${prefix}${issue.code}: ${issue.message}${issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ''}`;
  });

  return [
    'Uploaded Rime config files diagnostic:',
    `- Accepted files: ${report.fileCount}`,
    `- Total analyzed text: ${report.totalChars} chars`,
    `- Important custom files: ${report.importantFiles.custom.join(', ') || '(none)'}`,
    `- Schema files: ${report.importantFiles.schema.slice(0, 12).join(', ') || '(none)'}`,
    `- Issues: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info item(s)`,
    report.skipped.length ? `- Skipped files: ${report.skipped.slice(0, 12).join('; ')}` : '',
    issueLines.length ? '\nKey issues:\n' + issueLines.join('\n') : '',
    '\nUse this diagnostic as uploaded user configuration context. Do not claim full Rime semantic validation; this is a static/sandbox-assisted file-level diagnosis.',
  ]
    .filter(Boolean)
    .join('\n');
}

function findImportantFiles(files: UploadedRimeFile[]) {
  const names = files.map((file) => file.path);
  return {
    base: names.filter((name) => RIME_NAME_PATTERN.test(name)),
    custom: names.filter((name) => /\.custom\.ya?ml$/i.test(name)),
    schema: names.filter((name) => /\.schema\.ya?ml$/i.test(name)),
    dict: names.filter((name) => /\.dict\.ya?ml$/i.test(name)),
    lua: names.filter((name) => /\.lua$/i.test(name)),
  };
}

function sanitizeRelativePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.some((part) => part === '.' || part === '..' || /[\0]/.test(part))) return '';
  if (parts.some((part) => part.startsWith('.')) || parts[0] === '__MACOSX') return '';
  return parts.join('/').slice(0, 240);
}

function isLikelyRimeTextFile(path: string): boolean {
  const filename = path.split('/').pop() || '';
  return /\.lua$/i.test(filename) || RIME_NAME_PATTERN.test(path) || RIME_YAML_PATTERN.test(filename);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
