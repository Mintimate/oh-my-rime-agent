import { useEffect, useRef, type ClipboardEvent } from 'react';
import { Icon } from './Icon';
import { faPaperclip, faArrowUp, faStop, faXmark, faSliders, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import type { ConfigFilePayload, PastedImage } from '../types';
import { formatBytes } from '../lib/utils';

export function Composer({
  value, generating, stopping, configFile, images, clientLabel, onChange, onSubmit, onStop, onFile, onPasteImages, onClearFile, onRemoveImage,
}: {
  value: string;
  generating: boolean;
  stopping: boolean;
  configFile: ConfigFilePayload | null;
  images: PastedImage[];
  clientLabel: string;
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
      {(configFile || images.length > 0) && <div className="attachment-tray">
        {configFile && <div className="tray-item"><b>{configFile.name.endsWith('.lua') ? 'LUA' : 'YAML'}</b><span>{configFile.name}<small>{formatBytes(configFile.size)}</small></span><button aria-label="移除配置文件" onClick={onClearFile}><Icon icon={faXmark} /></button></div>}
        {images.map((image) => <div className="tray-item" key={image.id}><img src={image.dataUrl} alt="" /><span>{image.name}<small>{formatBytes(image.size)}</small></span><button aria-label="移除图片" onClick={() => onRemoveImage(image.id)}><Icon icon={faXmark} /></button></div>)}
      </div>}
      <textarea ref={textarea} value={value} onChange={(event) => onChange(event.target.value)} onPaste={paste}
        aria-label="描述你的 Rime 配置需求"
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit(); } }}
        placeholder="想调整什么？描述你的需求，或上传配置文件…" />
      <div className="composer-toolbar">
        <div className="composer-tools"><button type="button" className="attach-button" aria-label="上传 Rime 配置文件" title="支持 YAML、YML、Lua 文件" disabled={generating} onClick={() => fileInput.current?.click()}><Icon icon={faPaperclip} /><span>添加配置</span></button><span className="composer-context"><Icon icon={faSliders} />{clientLabel}</span></div>
        <div className="composer-actions"><span className="send-shortcut">⌘ / Ctrl + Enter</span>
        {stopping ? <button type="button" className="stop" aria-label="正在停止" disabled><Icon icon={faCircleNotch} spin /></button> : generating
          ? <button type="button" className="stop" aria-label="停止生成" onClick={onStop}><Icon icon={faStop} /></button>
          : <button type="button" className="send" aria-label="发送" disabled={!value.trim() && !configFile && images.length === 0} onClick={onSubmit}><Icon icon={faArrowUp} /></button>}
        </div>
      </div>
    </div>
    <input ref={fileInput} hidden type="file" accept=".yaml,.yml,.lua" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
    <div className="composer-hints"><span>基于官方文档作答 · 应用配置前请先备份</span><span>YAML / Lua ≤ 5 MB · 可粘贴截图</span></div>
  </div>;
}
