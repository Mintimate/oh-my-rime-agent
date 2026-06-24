import { validateYamlSnippet } from '../agents/chat/_tools';
import { diagnoseUploadedRimeDirectory } from '../agents/chat/_uploads';

const valid = validateYamlSnippet(
  [
    '# Weasel custom overlay',
    'patch:',
    '  "style/candidate_list_layout": linear',
    '  "style/horizontal": true',
  ].join('\n'),
  'weasel.custom.yaml',
);
assert(valid.ok, 'valid custom patch should pass');

const missingPatch = validateYamlSnippet(
  [
    'style:',
    '  candidate_list_layout: linear',
  ].join('\n'),
  'weasel.custom.yaml',
);
assertIssue(missingPatch, 'first_content_not_patch');
assertIssue(missingPatch, 'missing_patch');

const indentedPatch = validateYamlSnippet(
  [
    '  patch:',
    '    "style/candidate_list_layout": linear',
  ].join('\n'),
  'weasel.custom.yaml',
);
assertIssue(indentedPatch, 'first_content_not_patch');
assertIssue(indentedPatch, 'indented_patch');

const tabbedPatch = validateYamlSnippet('patch:\n\t"style/candidate_list_layout": linear', 'weasel.custom.yaml');
assertIssue(tabbedPatch, 'tab_character');

const nestedStyle = validateYamlSnippet(
  [
    'patch:',
    '  style:',
    '    candidate_list_layout: linear',
  ].join('\n'),
  'weasel.custom.yaml',
);
assertIssue(nestedStyle, 'non_path_patch_key');

const defaultYaml = validateYamlSnippet('schema_list:\n  - schema: rime_mint', 'default.yaml');
assert(
  !defaultYaml.issues.some((issue) => issue.code === 'missing_patch'),
  'default.yaml should not require a patch block',
);

const directoryDiagnostic = await diagnoseUploadedRimeDirectory(
  [
    {
      path: 'weasel.custom.yaml',
      content: 'style:\n\tcandidate_list_layout: linear',
    },
  ],
  {
    runCode: async () => ({ logs: 'sandbox ok' }),
  },
  'smoke',
);
assert(directoryDiagnostic, 'directory diagnostic should be returned');
assert(
  directoryDiagnostic.summaryText.includes('weasel.custom.yaml') &&
    directoryDiagnostic.summaryText.includes('tab_character'),
  'directory diagnostic should include custom file tab issue',
);

const repositoryZipLikeDiagnostic = await diagnoseUploadedRimeDirectory(
  [
    {
      path: '.github/workflows/mirrorToCNB.yaml',
      content: 'name: mirror\n',
    },
    {
      path: 'README.md',
      content: '# Project README\n',
    },
    {
      path: 'rime_mint.schema.yaml',
      content: 'schema:\n  schema_id: rime_mint\n',
    },
    {
      path: 'lua/date_translator.lua',
      content: 'return {}',
    },
  ],
  undefined,
  'repo-like-smoke',
);
assert(repositoryZipLikeDiagnostic, 'repo-like diagnostic should keep Rime schema/lua files');
assert(
  repositoryZipLikeDiagnostic.report.fileCount === 1 &&
    repositoryZipLikeDiagnostic.report.importantFiles.schema.includes('rime_mint.schema.yaml') &&
    repositoryZipLikeDiagnostic.report.skipped.some((item) => item.includes('lua/date_translator.lua: file limit reached')),
  'diagnostic should filter non-Rime repository files and accept only one uploaded Rime file',
);

console.log('Rime config validator smoke passed.');

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIssue(report: ReturnType<typeof validateYamlSnippet>, code: string) {
  assert(
    report.issues.some((issue) => issue.code === code),
    `expected issue ${code}, got ${report.issues.map((issue) => issue.code).join(', ')}`,
  );
}
