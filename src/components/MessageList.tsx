import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';
import { faArrowDown, faCheck, faChevronDown, faCircleCheck, faCircleNotch, faCircleExclamation, faCopy } from '@fortawesome/free-solid-svg-icons';
import { MarkdownContent } from './MarkdownContent';
import { formatBytes, toolLabel } from '../lib/utils';

function ToolStatusIcon({ status }: { status: ChatMessage['tools'][number]['status'] }) {
  if (status === 'done') return <Icon icon={faCircleCheck} />;
  if (status === 'running') return <Icon icon={faCircleNotch} spin />;
  return <Icon icon={faCircleExclamation} />;
}

function ToolFlow({ message }: { message: ChatMessage }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const hasFlow = Boolean(message.tools.length || message.thinking);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = Boolean(message.streaming);
  }, [message.streaming, hasFlow]);
  if (!hasFlow) return null;

  const running = message.tools.find((tool) => tool.status === 'running');
  const completed = message.tools.filter((tool) => tool.status === 'done').length;
  const interrupted = message.tools.some((tool) => tool.status === 'interrupted');
  const status = message.error ? 'interrupted' : running ? 'running' : message.streaming ? 'running' : interrupted ? 'interrupted' : 'done';
  const title = message.error ? '回答未完成' : running ? `正在${toolLabel(running.name)}` : message.streaming ? '正在整理回答' : interrupted ? '执行已结束' : '执行完成';

  return <details className={`agent-flow ${status}`} ref={detailsRef}>
    <summary className="agent-flow-summary">
      <span className="agent-flow-title"><ToolStatusIcon status={status} /><b>{title}</b></span>
      <span className="agent-flow-count">{message.tools.length ? `${completed}/${message.tools.length} 项完成` : '执行说明'}</span>
      <Icon icon={faChevronDown} className="agent-flow-chevron" />
    </summary>
    <div className="agent-flow-content">
      {message.tools.map((tool, index) => <div className={`tool-call ${tool.status}`} key={`${tool.name}-${index}`}>
        <i><ToolStatusIcon status={tool.status} /></i>
        <div><b>{toolLabel(tool.name)}</b>{tool.summary && <span>{tool.summary}</span>}</div>
        <small className="tool-call-state">{tool.status === 'running' ? '进行中' : tool.status === 'done' ? '已完成' : '已中断'}</small>
      </div>)}
      {message.thinking && <div className="execution-notes"><b>执行说明</b><pre>{message.thinking}</pre></div>}
    </div>
  </details>;
}

function AnswerActions({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 1800);
    } catch {
      setStatus('error');
    }
  }

  return <div className="answer-actions">
    <button type="button" onClick={copy} aria-label={status === 'copied' ? '回答已复制' : '复制回答'}><Icon icon={status === 'copied' ? faCheck : faCopy} />{status === 'copied' ? '已复制' : '复制回答'}</button>
    <span className={`copy-feedback ${status === 'error' ? 'error' : ''}`} role="status">{status === 'error' ? '复制失败，请手动选择文字复制。' : status === 'copied' ? '已复制到剪贴板' : ''}</span>
  </div>;
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  function scrollToLatest() {
    const area = areaRef.current;
    if (!area) return;
    followBottom.current = true;
    area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
    setShowScrollButton(false);
  }

  function handleScroll() {
    const area = areaRef.current;
    if (!area) return;
    const nearBottom = area.scrollHeight - area.clientHeight - area.scrollTop < 80;
    followBottom.current = nearBottom;
    setShowScrollButton(!nearBottom);
  }

  useLayoutEffect(() => {
    if (followBottom.current) scrollToLatest();
  }, [messages]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) scrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return <div className="messages-view">
    <div className="messages-area" ref={areaRef} onScroll={handleScroll}>
      <div className="messages-content" ref={contentRef}>
        {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}>
          {message.role === 'assistant' && <div className="avatar"><BrandIcon size={30} /></div>}
          <div className="message-stack">
            {message.role === 'assistant' && <div className="message-author">Rime Agent <span>{message.error ? '未完成' : message.streaming ? '正在处理' : '回答'}</span></div>}
            <div className="message-bubble">
              {message.role === 'assistant' && <ToolFlow message={message} />}
              {message.text && (message.role === 'assistant' ? <MarkdownContent text={message.text} streaming={message.streaming} /> : <p>{message.text}</p>)}
              {message.streaming && !message.text && <div className="typing" aria-label="正在生成回答"><span /><span /><span /></div>}
              {message.role === 'assistant' && !message.streaming && !message.text && <p className="empty-answer">本次未生成回答，可补充问题后重新发送。</p>}
            </div>
            {message.role === 'assistant' && !message.streaming && message.text && <AnswerActions text={message.text} />}
            {message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((attachment, index) => <div className="attachment-card" key={`${attachment.name}-${index}`}>
              {attachment.preview ? <img src={attachment.preview} alt={attachment.name} /> : <b>{attachment.name.toLowerCase().endsWith('.lua') ? 'LUA' : 'YAML'}</b>}
              <span>{attachment.name}<small>{attachment.size ? formatBytes(attachment.size) : ''}</small></span>
            </div>)}</div>}
          </div>
        </div>)}
      </div>
    </div>
    {showScrollButton && <button type="button" className="scroll-to-latest" onClick={scrollToLatest}><Icon icon={faArrowDown} />回到最新回答</button>}
  </div>;
}
