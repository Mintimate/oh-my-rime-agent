import { useEffect, useRef, type ClipboardEvent } from 'react';
import type { ConfigFilePayload, PastedImage } from '../types';
import { formatBytes } from '../lib/utils';

export function Composer({
  value, generating, configFile, images, onChange, onSubmit, onStop, onFile, onPasteImages, onClearFile, onRemoveImage,
}: {
  value: string;
  generating: boolean;
  configFile: ConfigFilePayload | null;
  images: PastedImage[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onFile: (file: File) => void;
  onPasteImages: (files: File[]) => void;
  onClearFile: () => void;
  onRemoveImage: (id: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = '38px';
    textarea.current.style.height = `${Math.min(150, textarea.current.scrollHeight)}px`;
  }, [value]);
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (files.length) { event.preventDefault(); onPasteImages(files); }
  }
  return <div className="composer-area">
    <div className="composer-shell">
      <textarea ref={textarea} value={value} disabled={generating} onChange={(event) => onChange(event.target.value)} onPaste={paste}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit(); } }}
        placeholder="输入关于 Rime 输入法配置的问题...（Ctrl+Enter 发送）" />
      <div className="composer-actions">
        <button type="button" title="上传 Rime 配置文件" disabled={generating} onClick={() => fileInput.current?.click()}>⇧</button>
        {generating
          ? <button type="button" className="stop" onClick={onStop}>■</button>
          : <button type="button" className="send" onClick={onSubmit}>➤</button>}
      </div>
    </div>
    <input ref={fileInput} hidden type="file" accept=".yaml,.yml,.lua" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
    {(configFile || images.length > 0) && <div className="attachment-tray">
      {configFile && <div className="tray-item"><b>YAML</b><span>{configFile.name}<small>{formatBytes(configFile.size)}</small></span><button onClick={onClearFile}>×</button></div>}
      {images.map((image) => <div className="tray-item" key={image.id}><img src={image.dataUrl} alt="" /><span>{image.name}<small>{formatBytes(image.size)}</small></span><button onClick={() => onRemoveImage(image.id)}>×</button></div>)}
    </div>}
    <div className="composer-hints"><span>当前使用腾讯云 EdgeOne 智能网关 API</span><span>支持 5MB YAML/Lua；可粘贴最多 3 张图片</span></div>
  </div>;
}
