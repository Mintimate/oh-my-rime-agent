import { buildUnsupportedKnowledgeResponse, mergeKnowledgeResults } from '../agents/chat/_knowledge';

const merged = mergeKnowledgeResults(
  [
    {
      available: true,
      hits: [
        {
          title: '输入法快捷键',
          url: 'https://www.mintimate.cc/zh/guide/shortcutKeys.html',
          score: 0.7,
          content: 'Rime 快捷键与翻页键配置。',
        },
        {
          title: '问题答疑',
          url: 'https://www.mintimate.cc/zh/guide/faQ.html',
          score: 0.3,
          content: 'Windows 7 只能使用小狼毫 0.14.3，旧版 librime 对 Lua 脚本支持有限。',
        },
      ],
    },
  ],
  ['Windows 7 小狼毫 0.14.3 Lua 候选框只出字母'],
);

assert(merged.relevant, 'a matching version and Lua document should be retained');
assert(merged.hits.length === 1, 'irrelevant high-score documents should be filtered out');
assert(merged.hits[0]?.url?.includes('faQ'), 'the matching FAQ document should be preferred');

const unsupported = mergeKnowledgeResults(
  [
    {
      available: true,
      hits: [
        {
          title: 'Lua 计算器',
          score: 0.9,
          content: 'Lua 翻译器可以生成算式结果。',
        },
        {
          title: '输入法快捷键映射',
          score: 0.8,
          content: '有人喜欢将分号绑定到第二个候选词：{ when: has_menu, accept: ";", send: 2 }。',
        },
      ],
    },
  ],
  [
    '这种输入，用数字键选第二个算式，它不会选',
    'Rime 计算器候选词 数字键选择第二个候选项',
  ],
);

assert(!unsupported.relevant, 'generic Chinese calculator documents must not be treated as evidence for digit selection');
assert(unsupported.hits.length === 0, 'unsupported Chinese-only queries should not inject unrelated hits');
const unsupportedAnswer = buildUnsupportedKnowledgeResponse(unsupported);
assert(unsupportedAnswer.includes('暂不支持这个场景'), 'no-evidence answers must explicitly say the scenario is unsupported');
assert(!unsupportedAnswer.includes('exactly_one'), 'no-evidence answers must not invent a configuration key');

console.log('Knowledge retrieval smoke passed.');

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
