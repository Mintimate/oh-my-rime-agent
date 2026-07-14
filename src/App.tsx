import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from './components/Composer';
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const apply = () => { const next = resolveTheme(themeMode); setTheme(next); document.documentElement.dataset.theme = next; document.documentElement.dataset.themeMode = themeMode; };
    localStorage.setItem(THEME_KEY, themeMode); apply();
    const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [themeMode]);

  const updateAssistant = useCallback((id: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  }, []);

  async function submit() {
    const text = input.trim();
    if (generating || (!text && !configFile && images.length === 0)) return;
    const prompt = text || (configFile ? '请诊断上传的 Rime 配置文件。' : '请根据粘贴的截图诊断 Rime 配置问题。');
    const files = configFile ? [configFile] : [];
    const pasted = [...images];
    const user: ChatMessage = { id: createUuid(), role: 'user', text: prompt, tools: [], attachments: [
      ...files.map((file) => ({ name: file.name, type: 'file' as const, size: file.size })),
      ...pasted.map((image) => ({ name: image.name, type: 'image' as const, size: image.size, preview: image.dataUrl })),
    ] };
    const assistantId = createUuid();
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', text: '', tools: [], attachments: [], thinking: '', streaming: true };
    setMessages((current) => [...current, user, assistant]); setInput(''); setConfigFile(null); setImages([]); setError(''); setGenerating(true);
    controller.current = new AbortController();
    try {
      const response = await fetch('/chat', {
        method: 'POST', signal: controller.current.signal,
        headers: { 'Content-Type': 'application/json', 'makers-conversation-id': conversationId },
        body: JSON.stringify({ message: prompt, context: clientContext(client.value), configFiles: files, pastedImages: pasted.map(({ name, type, size, dataUrl }) => ({ name, type, size, dataUrl })) }),
      });
      if (!response.ok || !response.body) throw new Error(await response.text() || `请求失败：${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
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
          if (event.type === 'error_message') setError(String(event.content || 'Agent 请求失败'));
        }
      }
    } catch (reason) {
      if ((reason as Error).name !== 'AbortError') setError((reason as Error).message || '网络连接或 Agent 端点故障。');
    } finally {
      updateAssistant(assistantId, (message) => ({ ...message, streaming: false, tools: message.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool) }));
      controller.current = null; setGenerating(false);
    }
  }

  async function stop() {
    controller.current?.abort();
    try { await fetch('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId }) }); } catch { /* best effort */ }
    setGenerating(false);
  }

  function reset() {
    if (generating) void stop();
    const id = createUuid(); localStorage.setItem(CONVERSATION_KEY, id); setConversationId(id); setMessages([]); setUsage({ input: 0, output: 0, total: 0 }); setConfigFile(null); setImages([]); setError('');
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

  const latestTools = useMemo(() => messages.filter((message) => message.role === 'assistant').flatMap((message) => message.tools), [messages]);
  return <div className="app-shell">
    <Sidebar open={sidebarOpen} selected={client} themeMode={themeMode} usage={usage} conversationId={conversationId} tools={latestTools}
      onClose={() => setSidebarOpen(false)} onSelect={setClient} onTheme={setThemeMode} onReset={reset} />
    <main className="chat-shell">
      <header className="chat-header"><button className="mobile-menu" onClick={() => setSidebarOpen(true)}>☰</button><div><b>Rime 配置会话</b><span>对话完成后可生成长图，便于保存与分享</span></div><button className="share-trigger" disabled={!messages.length || generating} onClick={() => setShareOpen(true)}>⌯ <span>分享会话</span></button></header>
      <div className="content-stage">{messages.length ? <MessageList messages={messages} /> : <WelcomeScreen onPrompt={setInput} />}</div>
      {error && <div className="error-banner">⚠ {error}<button onClick={() => setError('')}>×</button></div>}
      <Composer value={input} generating={generating} configFile={configFile} images={images} onChange={setInput} onSubmit={submit} onStop={stop}
        onFile={selectFile} onPasteImages={pasteImages} onClearFile={() => setConfigFile(null)} onRemoveImage={(id) => setImages((current) => current.filter((image) => image.id !== id))} />
    </main>
    <ShareDialog open={shareOpen} messages={messages} client={client.label} theme={theme} onClose={() => setShareOpen(false)} />
  </div>;
}
