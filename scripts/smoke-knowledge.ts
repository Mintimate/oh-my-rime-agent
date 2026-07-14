import { mergeKnowledgeResults } from '../agents/chat/_knowledge';

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
  ['Win7 Weasel 0.14 Lua 候选框只出字母'],
);

assert(merged.relevant, 'a matching version and Lua document should be retained');
assert(merged.hits.length === 1, 'irrelevant high-score documents should be filtered out');
assert(merged.hits[0]?.url?.includes('faQ'), 'the matching FAQ document should be preferred');

console.log('Knowledge retrieval smoke passed.');

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
