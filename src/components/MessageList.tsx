import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';
import { faCircleCheck, faCircleNotch, faCircleExclamation } from '@fortawesome/free-solid-svg-icons';
import { MarkdownContent } from './MarkdownContent';
import { formatBytes, toolLabel } from '../lib/utils';

function ToolStatusIcon({ status }: { status: ChatMessage['tools'][number]['status'] }) {
  if (status === 'done') return <Icon icon={faCircleCheck} />;
  if (status === 'running') return <Icon icon={faCircleNotch} spin />;
  return <Icon icon={faCircleExclamation} />;
}

function ToolFlow({ message }: { message: ChatMessage }) {
  if (!message.tools.length && !message.thinking) return null;
  return <div className="agent-flow">
    {message.thinking && <details className="thinking-block"><summary>Agent 推理过程</summary><pre>{message.thinking}</pre></details>}
    {message.tools.map((tool, index) => <div className={`tool-call ${tool.status}`} key={`${tool.name}-${index}`}>
      <i><ToolStatusIcon status={tool.status} /></i>
      <div><b>{toolLabel(tool.name)}</b>{tool.summary && <span>{tool.summary}</span>}</div>
    </div>)}
  </div>;
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => { areaRef.current?.scrollTo({ top: areaRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);
  return <div className="messages-area" ref={areaRef}>
    {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}>
      {message.role === 'assistant' && <div className="avatar"><BrandIcon size={36} /></div>}
      <div className="message-stack">
        <div className="message-bubble">
          {message.role === 'assistant' && <ToolFlow message={message} />}
          {message.text && (message.role === 'assistant' ? <MarkdownContent text={message.text} /> : <p>{message.text}</p>)}
          {message.streaming && !message.text && <div className="typing"><span /><span /><span /></div>}
        </div>
        {message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((attachment, index) => <div className="attachment-card" key={`${attachment.name}-${index}`}>
          {attachment.preview ? <img src={attachment.preview} alt="" /> : <b>YAML</b>}
          <span>{attachment.name}<small>{attachment.size ? formatBytes(attachment.size) : ''}</small></span>
        </div>)}</div>}
      </div>
    </div>)}
  </div>;
}
