import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type { ChatMessage, Theme } from '../types';
import { createShareImage } from '../lib/shareImage';

export function ShareDialog({ open, messages, client, theme, onClose }: { open: boolean; messages: ChatMessage[]; client: string; theme: Theme; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBlob(null); setUrl(''); setError('');
    createShareImage(messages, client, theme).then((next) => {
      if (cancelled) return;
      setBlob(next); setUrl(URL.createObjectURL(next));
    }).catch((reason: Error) => setError(reason.message || '图片生成失败'));
    requestAnimationFrame(() => dialog.current?.focus());
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key); document.body.style.overflow = 'hidden';
    return () => { cancelled = true; document.removeEventListener('keydown', key); document.body.style.overflow = ''; };
  }, [open, messages, client, theme, onClose]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!open) return null;
  const filename = `oh-my-rime-session-${new Date().toISOString().slice(0, 10)}.png`;
  async function copy() {
    if (!blob || !window.ClipboardItem) return;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
  async function share() {
    if (!blob || !('share' in navigator)) return;
    const file = new File([blob], filename, { type: 'image/png' });
    await navigator.share({ title: 'oh-my-rime 配置会话', files: [file] });
  }
  return <div className="share-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1} ref={dialog}>
      <header><div><h2 id="share-title">分享 Rime 配置会话</h2><p>保留关键工具调用与代码块，不包含推理过程和原始日志</p></div><button onClick={onClose} aria-label="关闭分享弹窗"><Icon icon={faXmark} /></button></header>
      <main>{error ? <p className="share-error">{error}</p> : url ? <img src={url} alt="当前会话分享图预览" /> : <div className="share-loading">正在排版会话图片…</div>}</main>
      <footer><span>{url ? '图片已就绪' : error ? '生成失败' : '正在生成'}</span><button disabled={!blob} onClick={copy}>复制图片</button>{'share' in navigator && <button disabled={!blob} onClick={share}>系统分享</button>}<a className={!url ? 'disabled' : ''} href={url || '#'} download={filename}>保存 PNG</a></footer>
    </div>
  </div>;
}
