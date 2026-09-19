import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Icon } from './components/Icon';
import { faBars, faShareNodes, faTriangleExclamation, faXmark, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { MessageList } from './components/MessageList';
import { ShareDialog } from './components/ShareDialog';
import { Sidebar } from './components/Sidebar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CLIENTS, type ChatMessage, type ConfigFilePayload, type PastedImage, type Theme, type ThemeMode, type Usage } from './types';
import { cleanText, createUuid } from './lib/utils';

const CONVERSATION_KEY = 'rime_agent_conv_id';
const THEME_KEY = 'rime_agent_theme_mode';
const MAX_FILE = 5 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;

function getConversationId() {
  const stored = localStorage.getItem(CONVERSATION_KEY) || '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
  const id = createUuid(); localStorage.setItem(CONVERSATION_KEY, id); return id;
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
}

function clientContext(value: string) {
  return value.startsWith('Rime 词库查询')
    ? 'User selected mode: Rime knowledge base / dictionary query only. Do not assume a target client unless explicitly requested.'
    : `User selected target Rime client environment: ${value}`;
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => (localStorage.getItem(THEME_KEY) as ThemeMode) || 'system');
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(themeMode));
  const [client, setClient] = useState(CLIENTS[0]);
  const [conversationId, setConversationId] = useState(getConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [configFile, setConfigFile] = useState<ConfigFilePayload | null>(null);
  const [images, setImages] = useState<PastedImage[]>([]);
  const [usage, setUsage] = useState<Usage>({ input: 0, output: 0, total: 0 });
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [error, setError] = useState('');
  const activeRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const pendingStop = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    const apply = () => { const next = resolveTheme(themeMode); setTheme(next); document.documentElement.dataset.theme = next; document.documentElement.dataset.themeMode = themeMode; };
    localStorage.setItem(THEME_KEY, themeMode); apply();
    const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [themeMode]);

  const updateAssistant = useCallback((id: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  }, []);

  async function submit() {
    // The server cancels by conversation ID, so finish the previous stop before
    // starting another run in the same conversation.
    if (pendingStop.current) return;
    const text = input.trim();
    if (activeRequest.current || (!text && !configFile && images.length === 0)) return;
    const prompt = text || (configFile ? '请诊断上传的 Rime 配置文件。' : '请根据粘贴的截图诊断 Rime 配置问题。');
    const files = configFile ? [configFile] : [];
    const pasted = [...images];
    const user: ChatMessage = { id: createUuid(), role: 'user', text: prompt, tools: [], attachments: [
      ...files.map((file) => ({ name: file.name, type: 'file' as const, size: file.size, content: file.content })),
      ...pasted.map((image) => ({ name: image.name, type: 'image' as const, size: image.size, preview: image.dataUrl })),
    ] };
    const assistantId = createUuid();
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', text: '', tools: [], attachments: [], thinking: '', streaming: true };
    setMessages((current) => [...current, user, assistant]); setInput(''); setConfigFile(null); setImages([]); setError(''); setGenerating(true);
    const request = { id: assistantId, controller: new AbortController() };
    activeRequest.current = request;
    try {
      const response = await fetch('/chat', {
        method: 'POST', signal: request.controller.signal,
        headers: { 'Content-Type': 'application/json', 'makers-conversation-id': conversationId },
        body: JSON.stringify({ message: prompt, context: clientContext(client.value), configFiles: files, pastedImages: pasted.map(({ name, type, size, dataUrl }) => ({ name, type, size, dataUrl })) }),
      });
      if (!response.ok || !response.body) throw new Error(await response.text() || `请求失败：${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (activeRequest.current !== request) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue; const raw = line.slice(6); if (raw === '[DONE]') continue;
          const event = JSON.parse(raw);
          if (event.type === 'thinking') updateAssistant(assistantId, (message) => ({ ...message, thinking: `${message.thinking || ''}${message.thinking ? '\n' : ''}${event.content}` }));
          if (event.type === 'tool_call') updateAssistant(assistantId, (message) => ({ ...message, tools: [...message.tools, { name: String(event.name || 'tool'), status: 'running', summary: '' }] }));
          if (event.type === 'tool_result') updateAssistant(assistantId, (message) => {
            const tools = [...message.tools];
            for (let index = tools.length - 1; index >= 0; index--) if (tools[index].name === String(event.name) && tools[index].status === 'running') { tools[index] = { ...tools[index], status: 'done', summary: cleanText(event.content).slice(0, 120) }; break; }
            return { ...message, tools };
          });
          if (event.type === 'ai_response') updateAssistant(assistantId, (message) => ({ ...message, text: message.text + String(event.content || '') }));
          if (event.type === 'usage') setUsage({ input: event.input_tokens ?? 0, output: event.output_tokens ?? 0, total: event.total_tokens ?? 0 });
          if (event.type === 'error_message') {
            const message = String(event.content || 'Agent 请求失败');
            setError(message);
            updateAssistant(assistantId, (current) => ({ ...current, error: message }));
          }
        }
      }
    } catch (reason) {
      if (activeRequest.current === request && (reason as Error).name !== 'AbortError') {
        const message = (reason as Error).message || '网络连接或 Agent 端点故障。';
        setError(message);
        updateAssistant(assistantId, (current) => ({ ...current, error: message }));
      }
    } finally {
      updateAssistant(assistantId, (message) => ({ ...message, streaming: false, tools: message.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool) }));
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setGenerating(false);
      }
    }
  }

  async function stop() {
    const request = activeRequest.current;
    if (!request) return;
    request.controller.abort();
    activeRequest.current = null;
    setGenerating(false);
    setStopping(true);
    const stopping = fetch('/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId }), signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    pendingStop.current = stopping;
    await stopping;
    if (pendingStop.current === stopping) {
      pendingStop.current = null;
      setStopping(false);
    }
  }

  function reset() {
    if (activeRequest.current) void stop();
    const id = createUuid(); localStorage.setItem(CONVERSATION_KEY, id); setConversationId(id); setMessages([]); setInput(''); setUsage({ input: 0, output: 0, total: 0 }); setConfigFile(null); setImages([]); setError(''); setToolboxOpen(false); setSidebarOpen(false);
  }

  async function selectFile(file: File) {
    if (!/\.(ya?ml|lua)$/i.test(file.name)) { setError('仅支持 YAML、YML 或 Lua 文件。'); return; }
    if (file.size > MAX_FILE) { setError('配置文件不能超过 5MB。'); return; }
    setConfigFile({ path: file.name, name: file.name, content: (await file.text()).replace(/\r\n/g, '\n'), size: file.size, truncated: false }); setError('');
  }

  async function pasteImages(files: File[]) {
    const available = files.slice(0, Math.max(0, 3 - images.length));
    try {
      const next = await Promise.all(available.map(async (file) => {
        if (file.size > MAX_IMAGE) throw new Error('单张图片不能超过 2MB。');
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        return { id: createUuid(), name: file.name || 'pasted-image.png', type: file.type, size: file.size, dataUrl };
      }));
      setImages((current) => [...current, ...next]); setError('');
    } catch (reason) { setError((reason as Error).message); }
  }

  const latestTools = useMemo(() => messages.filter((message) => message.role === 'assistant').at(-1)?.tools ?? [], [messages]);
  return <div className="app-shell">
    <Sidebar open={sidebarOpen} selected={client} themeMode={themeMode} usage={usage} conversationId={conversationId} tools={latestTools} toolboxOpen={toolboxOpen}
      onToggleToolbox={(open) => setToolboxOpen(open)}
      onClose={() => setSidebarOpen(false)} onSelect={setClient} onTheme={setThemeMode} onReset={reset} />
    <main className="chat-shell">
      <header className="chat-header">
        <button className="mobile-menu" aria-label="打开侧栏" onClick={() => setSidebarOpen(true)}><Icon icon={faBars} /></button>
        <div className="header-breadcrumb"><span>工作空间</span><Icon icon={faChevronRight} /><b>配置助手</b></div>
        <div className="header-actions"><span className={`agent-status ${generating || stopping ? 'busy' : ''}`} role="status"><i />{stopping ? '正在停止' : generating ? '正在处理' : '准备就绪'}</span><button className="share-trigger" aria-label="分享会话" disabled={!messages.length || generating || stopping} onClick={() => setShareOpen(true)}><Icon icon={faShareNodes} /> <span>分享</span></button></div>
      </header>
      <div className="content-stage">{messages.length ? <MessageList messages={messages} /> : <WelcomeScreen onPrompt={setInput} />}</div>
      {error && <div className="error-banner"><span><Icon icon={faTriangleExclamation} /> {error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><Icon icon={faXmark} /></button></div>}
      <Composer value={input} generating={generating} stopping={stopping} configFile={configFile} images={images} clientLabel={client.label} onChange={setInput} onSubmit={submit} onStop={stop}
        onFile={selectFile} onPasteImages={pasteImages} onClearFile={() => setConfigFile(null)} onRemoveImage={(id) => setImages((current) => current.filter((image) => image.id !== id))} />
    </main>
    <ShareDialog open={shareOpen} messages={messages} client={client.label} theme={theme} onClose={() => setShareOpen(false)} />
  </div>;
}
