import { Fragment, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { faCopy, faCheck } from '@fortawesome/free-solid-svg-icons';

interface MarkdownBlock {
  type: 'text' | 'code';
  value: string;
  language?: string;
}

function parseBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const pattern = /```([A-Za-z0-9_-]+)?[ \t]*\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) blocks.push({ type: 'text', value: source.slice(cursor, match.index) });
    blocks.push({ type: 'code', language: match[1] || 'text', value: match[2].replace(/\n$/, '') });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) blocks.push({ type: 'text', value: source.slice(cursor) });
  return blocks;
}

function safeHref(value: string) {
  try {
    const url = new URL(value, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function inline(value: string): ReactNode[] {
  const pattern = /(\*\*.*?\*\*|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g;
  return value.split(pattern).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code className="inline-code" key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      if (href) return <a key={index} href={href} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function Prose({ value }: { value: string }) {
  const groups = value.trim().split(/\n{2,}/).filter(Boolean);
  return <>{groups.map((group, index) => {
    const lines = group.split('\n');
    const heading = lines[0]?.match(/^#{1,4}\s+(.+)/);
    if (heading && lines.length === 1) return <h3 key={index}>{inline(heading[1])}</h3>;
    const bullets = lines.every((line) => /^\s*[-*]\s+/.test(line));
    if (bullets) return <ul key={index}>{lines.map((line, item) => <li key={item}>{inline(line.replace(/^\s*[-*]\s+/, ''))}</li>)}</ul>;
    const ordered = lines.every((line) => /^\s*\d+\.\s+/.test(line));
    if (ordered) return <ol key={index}>{lines.map((line, item) => <li key={item}>{inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>)}</ol>;
    return <p key={index}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{inline(line.replace(/^#{1,4}\s+/, ''))}</Fragment>)}</p>;
  })}</>;
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <div className="code-block">
    <div className="code-toolbar"><span>{language}</span><button type="button" aria-label={copied ? '已复制' : '复制代码'} onClick={copy}>{copied ? <><Icon icon={faCheck} /> 已复制</> : <><Icon icon={faCopy} /> 复制</>}</button></div>
    <pre><code>{value}</code></pre>
  </div>;
}

export function MarkdownContent({ text }: { text: string }) {
  return <div className="markdown-content">{parseBlocks(text).map((block, index) => block.type === 'code'
    ? <CodeBlock key={index} language={block.language || 'text'} value={block.value} />
    : <Prose key={index} value={block.value} />)}</div>;
}
