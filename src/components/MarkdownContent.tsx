import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { faCopy, faCheck, faDownload } from '@fortawesome/free-solid-svg-icons';

interface MarkdownBlock {
  type: 'text' | 'code';
  value: string;
  language?: string;
  complete?: boolean;
}

function parseBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?(?:\n|$)/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source))) {
    const fence = match[1];
    if (fence[0] === '`' && match[2].includes('`')) continue;
    if (match.index > cursor) blocks.push({ type: 'text', value: source.slice(cursor, match.index) });
    const contentStart = opening.lastIndex;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, 'gm');
    closing.lastIndex = contentStart;
    const end = closing.exec(source);
    blocks.push({
      type: 'code',
      language: match[2].trim().split(/\s+/)[0] || 'text',
      value: source.slice(contentStart, end?.index ?? source.length).replace(/\r?\n$/, ''),
      complete: Boolean(end),
    });
    cursor = end ? end.index + end[0].length : source.length;
    opening.lastIndex = cursor;
    if (!end) break;
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

function CodeBlock({ language, value, complete, streaming, index }: { language: string; value: string; complete: boolean; streaming: boolean; index: number }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extension = /^(ya?ml|lua)$/i.test(language) ? language.toLowerCase() === 'lua' ? 'lua' : 'yaml' : null;
  const pending = !complete || streaming;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    if (pending) return;
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setError('');
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setError('复制失败，请手动选择代码复制。');
    }
  }

  function download() {
    if (pending || !extension) return;
    try {
      const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `rime-snippet-${index + 1}.${extension}`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch {
      setError('下载失败，请复制代码后保存为文件。');
    }
  }

  return <div className={`code-block${pending ? ' code-block-pending' : ''}`}>
    <div className="code-toolbar">
      <span className="code-language">{language}<small>{pending ? streaming ? '生成中' : '片段未完整' : extension ? '配置片段' : ''}</small></span>
      <div className="code-actions">
        {extension && <button type="button" disabled={pending} aria-label={`下载 ${extension.toUpperCase()} 配置片段`} title="保存为配置片段，使用前请确认目标文件" onClick={download}><Icon icon={faDownload} />下载</button>}
        <button type="button" disabled={pending} aria-label={copied ? '代码已复制' : '复制代码'} onClick={copy}>{copied ? <><Icon icon={faCheck} /> 已复制</> : <><Icon icon={faCopy} /> 复制</>}</button>
      </div>
    </div>
    <pre><code>{value}</code></pre>
    {error && <div className="code-feedback error" role="status">{error}</div>}
  </div>;
}

export function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  let codeIndex = 0;
  return <div className="markdown-content">{parseBlocks(text).map((block, index) => block.type === 'code'
    ? <CodeBlock key={index} language={block.language || 'text'} value={block.value} complete={Boolean(block.complete)} streaming={streaming} index={codeIndex++} />
    : <Prose key={index} value={block.value} />)}</div>;
}
