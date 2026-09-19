import type { ChatAttachment, ChatMessage, Theme, ToolCallState } from '../types';
import { cleanText, formatBytes, toolLabel } from './utils';
import brandIconUrl from '../../favicon.svg?url';

type Context = CanvasRenderingContext2D;
type PreparedBlock = { type: 'text' | 'code'; language?: string; lines: string[]; height: number };
type PreparedAttachment = ChatAttachment & { lines: string[]; height: number };
type PreparedMessage = ChatMessage & {
  lines: string[];
  blocks: PreparedBlock[];
  tools: ToolCallState[];
  preparedAttachments: PreparedAttachment[];
  height: number;
  toolHeight: number;
  attachmentHeight: number;
};

const WIDTH = 1200;
const BODY = 22;
const BODY_LINE = 34;
const CODE = 18;
const CODE_LINE = 29;

const palettes = {
  light: {
    bg: ['#fff0e4', '#fcfaf7', '#f5f0e9'], canvas: '#ffffff', border: '#e8dfd4', heading: '#382b23', muted: '#897a6e', line: '#e8dfd4',
    user: '#fff0e4', userBorder: '#c45b23', agent: '#fcfaf7', agentBorder: '#e8dfd4', body: '#382b23', userLabel: '#c45b23', agentLabel: '#c45b23',
    toolA: 'rgba(196,91,35,.13)', toolB: 'rgba(196,91,35,.05)', toolBorder: '#e8dfd4', toolTitle: '#c45b23', toolText: '#382b23', toolMuted: '#7b6c60',
    code: '#f7f1eb', codeHead: '#f5f0e9', codeBorder: '#e8dfd4', codeText: '#382b23', codeLabel: '#c45b23', link: '#c45b23', dot: 'rgba(56,43,35,.055)',
  },
  dark: {
    bg: ['#443022', '#201b17', '#2a231e'], canvas: '#2a231e', border: '#493b30', heading: '#f4e9de', muted: '#ad9c8d', line: '#493b30',
    user: '#443022', userBorder: '#f1a56e', agent: '#201b17', agentBorder: '#493b30', body: '#f4e9de', userLabel: '#f1a56e', agentLabel: '#f1a56e',
    toolA: 'rgba(241,165,110,.13)', toolB: 'rgba(241,165,110,.05)', toolBorder: '#493b30', toolTitle: '#f1a56e', toolText: '#f4e9de', toolMuted: '#bdafa2',
    code: '#191511', codeHead: '#201b17', codeBorder: '#493b30', codeText: '#f4e9de', codeLabel: '#f1a56e', link: '#f1a56e', dot: 'rgba(244,233,222,.045)',
  },
};

function roundRect(ctx: Context, x: number, y: number, width: number, height: number, radius: number, fill: string | CanvasGradient, stroke?: string) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

function cleanMarkdown(value: string) {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#{1,4}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
}

function wrap(ctx: Context, value: string, maxWidth: number, maxLines: number) {
  const output: string[] = [];
  for (const paragraph of cleanMarkdown(value).split('\n')) {
    if (output.length >= maxLines) break;
    if (!paragraph) { output.push(''); continue; }
    let line = '';
    for (const char of [...paragraph]) {
      const candidate = line + char;
      if (line && ctx.measureText(candidate).width > maxWidth) { output.push(line); line = char; if (output.length >= maxLines) break; }
      else line = candidate;
    }
    if (line && output.length < maxLines) output.push(line);
  }
  if (output.length >= maxLines) output[maxLines - 1] = `${output[maxLines - 1].slice(0, -1)}…`;
  return output;
}

function parseBlocks(ctx: Context, text: string): PreparedBlock[] {
  const blocks: PreparedBlock[] = [];
  const pattern = /```([A-Za-z0-9_-]+)?[ \t]*\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const addText = (value: string) => {
    if (!value.trim()) return;
    ctx.font = `400 ${BODY}px system-ui, sans-serif`;
    const lines = wrap(ctx, value, 850, 24);
    blocks.push({ type: 'text', lines, height: lines.length * BODY_LINE });
  };
  while ((match = pattern.exec(text))) {
    addText(text.slice(cursor, match.index));
    ctx.font = `${CODE}px ui-monospace, Menlo, monospace`;
    const lines = wrapCode(ctx, match[2].replace(/\n$/, ''), 820, 16);
    blocks.push({ type: 'code', language: (match[1] || 'text').toUpperCase(), lines, height: 62 + lines.length * CODE_LINE });
    cursor = pattern.lastIndex;
  }
  addText(text.slice(cursor));
  return blocks;
}

function wrapCode(ctx: Context, value: string, maxWidth: number, maxLines: number) {
  const output: string[] = [];
  for (const raw of value.split('\n')) {
    if (output.length >= maxLines) break;
    const normalized = raw.replace(/\t/g, '  ');
    if (!normalized || ctx.measureText(normalized).width <= maxWidth) { output.push(normalized); continue; }
    let remaining = normalized;
    let continuation = false;
    while (remaining && output.length < maxLines) {
      const prefix = continuation ? '  ↳ ' : '';
      let consumed = '';
      for (const char of [...remaining]) {
        if (consumed && ctx.measureText(prefix + consumed + char).width > maxWidth) break;
        consumed += char;
      }
      if (!consumed) consumed = [...remaining][0] || '';
      output.push(prefix + consumed);
      remaining = remaining.slice(consumed.length);
      continuation = true;
    }
  }
  return output.length ? output : [''];
}

function prepareAttachments(ctx: Context, attachments: ChatAttachment[]): PreparedAttachment[] {
  return attachments.slice(0, 3).map((attachment) => {
    if (attachment.type === 'image') {
      return { ...attachment, lines: [], height: attachment.preview ? 240 : 68 };
    }
    ctx.font = `${CODE}px ui-monospace, Menlo, monospace`;
    const lines = attachment.content ? wrapCode(ctx, attachment.content, 700, 10) : [];
    return { ...attachment, lines, height: lines.length ? 62 + lines.length * CODE_LINE : 68 };
  });
}

function prepare(ctx: Context, messages: ChatMessage[]) {
  const result: PreparedMessage[] = [];
  let height = 0;
  for (const message of messages.slice(-16).reverse()) {
    ctx.font = '500 23px system-ui, sans-serif';
    const lines = message.role === 'user' ? wrap(ctx, message.text, 730, 10) : [];
    const blocks = message.role === 'assistant' ? parseBlocks(ctx, message.text) : [];
    const tools = message.tools.slice(0, 7);
    const preparedAttachments = prepareAttachments(ctx, message.attachments);
    const toolHeight = tools.length ? 78 + tools.length * 42 : 0;
    const attachmentHeight = preparedAttachments.length
      ? 12 + preparedAttachments.reduce((sum, attachment) => sum + attachment.height + 12, 0)
      : 0;
    const ownHeight = 92 + toolHeight + attachmentHeight + (message.role === 'user' ? lines.length * 35 : blocks.reduce((sum, block) => sum + block.height + 16, 0));
    if (result.length && height + ownHeight > 5000) break;
    result.unshift({ ...message, lines, blocks, tools, preparedAttachments, toolHeight, attachmentHeight, height: ownHeight });
    height += ownHeight + 26;
  }
  return { messages: result, omitted: messages.length - result.length, height };
}

let logoPromise: Promise<HTMLImageElement | null> | null = null;
function loadLogo() {
  if (!logoPromise) logoPromise = new Promise((resolve) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = brandIconUrl;
  });
  return logoPromise;
}

async function loadAttachmentImages(messages: PreparedMessage[]) {
  const sources = [...new Set(messages.flatMap((message) => message.preparedAttachments)
    .filter((attachment) => attachment.type === 'image' && attachment.preview)
    .map((attachment) => attachment.preview as string))];
  const loaded = await Promise.all(sources.map(async (source) => {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const item = new Image();
      item.onload = () => resolve(item);
      item.onerror = () => resolve(null);
      item.src = source;
    });
    return [source, image] as const;
  }));
  return new Map(loaded);
}

export async function createShareImage(messages: ChatMessage[], client: string, theme: Theme) {
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Canvas unavailable');
  const layout = prepare(measure, messages);
  const attachmentImages = await loadAttachmentImages(layout.messages);
  const height = Math.max(700, 390 + layout.height + (layout.omitted ? 54 : 0));
  const canvas = document.createElement('canvas'); canvas.width = WIDTH * 1.5; canvas.height = height * 1.5;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); ctx.scale(1.5, 1.5);
  const p = palettes[theme];
  const bg = ctx.createLinearGradient(0, 0, WIDTH, height); p.bg.forEach((color, index) => bg.addColorStop(index / 2, color));
  ctx.fillStyle = bg; ctx.fillRect(0, 0, WIDTH, height); ctx.fillStyle = p.dot;
  for (let x = 22; x < WIDTH; x += 28) for (let y = 22; y < height; y += 28) ctx.fillRect(x, y, 2, 2);
  roundRect(ctx, 38, 38, WIDTH - 76, height - 76, 30, p.canvas, p.border);
  const logo = await loadLogo(); if (logo) ctx.drawImage(logo, 72, 70, 64, 64);
  ctx.fillStyle = p.heading; ctx.font = '800 34px system-ui, sans-serif'; ctx.fillText('oh-my-rime 配置会话', 158, 104);
  ctx.fillStyle = p.muted; ctx.font = '600 15px ui-monospace, Menlo, monospace'; ctx.fillText('RIME CONFIGURATION ASSISTANT · EDGEONE MAKERS', 158, 131);
  ctx.textAlign = 'right'; ctx.fillStyle = p.heading; ctx.font = '600 17px system-ui, sans-serif'; ctx.fillText(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()), 1120, 98);
  ctx.fillStyle = p.muted; ctx.font = '500 14px ui-monospace, Menlo, monospace'; ctx.fillText(`${messages.length} 条消息 · ${client}`, 1120, 126); ctx.textAlign = 'left';
  ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(72, 166); ctx.lineTo(1128, 166); ctx.stroke();
  let y = 204;
  if (layout.omitted) { ctx.fillStyle = p.muted; ctx.textAlign = 'center'; ctx.fillText(`已省略较早的 ${layout.omitted} 条消息`, WIDTH / 2, y + 20); ctx.textAlign = 'left'; y += 54; }
  layout.messages.forEach((message, index) => {
    const user = message.role === 'user'; const w = user ? 820 : 950; const x = user ? 1128 - w : 72;
    roundRect(ctx, x, y, w, message.height, 20, user ? p.user : p.agent, user ? p.userBorder : p.agentBorder);
    ctx.fillStyle = user ? p.userLabel : p.agentLabel; ctx.font = '800 15px ui-monospace, Menlo, monospace'; ctx.fillText(user ? 'YOU' : 'OH-MY-RIME AGENT', x + 28, y + 34);
    ctx.textAlign = 'right'; ctx.fillStyle = p.muted; ctx.fillText(String(index + 1).padStart(2, '0'), x + w - 28, y + 34); ctx.textAlign = 'left';
    let cursor = y + 64;
    if (message.tools.length) { drawTools(ctx, message.tools, x + 22, cursor, w - 44, message.toolHeight - 20, p); cursor += message.toolHeight; }
    if (user) { ctx.fillStyle = p.body; ctx.font = '500 23px system-ui, sans-serif'; message.lines.forEach((line) => { ctx.fillText(line, x + 28, cursor + 26); cursor += 35; }); }
    else message.blocks.forEach((block) => { drawBlock(ctx, block, x + 22, cursor, w - 44, p); cursor += block.height + 16; });
    if (message.preparedAttachments.length) {
      cursor += 12;
      message.preparedAttachments.forEach((attachment) => {
        drawAttachment(ctx, attachment, x + 22, cursor, w - 44, p, attachmentImages);
        cursor += attachment.height + 12;
      });
    }
    y += message.height + 26;
  });
  ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(72, height - 112); ctx.lineTo(1128, height - 112); ctx.stroke();
  ctx.fillStyle = p.muted; ctx.font = '500 15px system-ui, sans-serif'; ctx.fillText('由 oh-my-rime Agent 生成 · 配置应用前请备份并重新部署 Rime', 72, height - 76);
  ctx.textAlign = 'right'; ctx.fillStyle = p.link; ctx.font = '700 15px ui-monospace, Menlo, monospace'; ctx.fillText(location.host, 1128, height - 76);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 编码失败')), 'image/png'));
}

function drawAttachment(
  ctx: Context,
  attachment: PreparedAttachment,
  x: number,
  y: number,
  width: number,
  p: typeof palettes.light,
  images: Map<string, HTMLImageElement | null>,
) {
  roundRect(ctx, x, y, width, attachment.height, 14, p.code, p.codeBorder);
  ctx.fillStyle = p.codeHead; ctx.beginPath(); ctx.roundRect(x, y, width, 42, [14, 14, 0, 0]); ctx.fill();
  ctx.fillStyle = p.codeLabel; ctx.font = '800 13px ui-monospace, Menlo, monospace';
  ctx.fillText(attachment.type === 'image' ? 'IMAGE ATTACHMENT' : 'CONFIG ATTACHMENT', x + 16, y + 26);
  ctx.textAlign = 'right'; ctx.fillStyle = p.toolMuted; ctx.font = '600 13px system-ui, sans-serif';
  const size = attachment.size ? ` · ${formatBytes(attachment.size)}` : '';
  ctx.fillText(`${cleanText(attachment.name).slice(0, 44)}${size}`, x + width - 16, y + 26); ctx.textAlign = 'left';

  if (attachment.type === 'image' && attachment.preview) {
    const image = images.get(attachment.preview);
    if (!image) return;
    const areaX = x + 14; const areaY = y + 52; const areaWidth = width - 28; const areaHeight = attachment.height - 66;
    const scale = Math.min(areaWidth / image.naturalWidth, areaHeight / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale; const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, areaX + (areaWidth - drawWidth) / 2, areaY + (areaHeight - drawHeight) / 2, drawWidth, drawHeight);
    return;
  }

  ctx.fillStyle = p.codeText; ctx.font = `${CODE}px ui-monospace, Menlo, monospace`;
  attachment.lines.forEach((line, index) => ctx.fillText(line, x + 18, y + 65 + index * CODE_LINE));
}

function drawTools(ctx: Context, tools: ToolCallState[], x: number, y: number, width: number, height: number, p: typeof palettes.light) {
  const bg = ctx.createLinearGradient(x, y, x + width, y + height); bg.addColorStop(0, p.toolA); bg.addColorStop(1, p.toolB); roundRect(ctx, x, y, width, height, 16, bg, p.toolBorder);
  ctx.fillStyle = p.toolTitle; ctx.font = '800 14px ui-monospace, Menlo, monospace'; ctx.fillText('⚡ TOOL CALLING', x + 18, y + 28);
  ctx.textAlign = 'right'; ctx.fillText(`${tools.length} CALL${tools.length > 1 ? 'S' : ''}`, x + width - 18, y + 28); ctx.textAlign = 'left';
  tools.forEach((tool, index) => { const row = y + 68 + index * 42; ctx.fillStyle = tool.status === 'done' ? '#10b981' : '#f59e0b'; ctx.beginPath(); ctx.arc(x + 20, row - 5, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = p.toolText; ctx.font = '700 16px ui-monospace, Menlo, monospace'; ctx.fillText(toolLabel(tool.name), x + 38, row); ctx.textAlign = 'right'; ctx.fillStyle = p.toolMuted; ctx.font = '500 13px system-ui, sans-serif'; ctx.fillText(cleanText(tool.summary || '调用完成').slice(0, 48), x + width - 18, row); ctx.textAlign = 'left'; });
}

function drawBlock(ctx: Context, block: PreparedBlock, x: number, y: number, width: number, p: typeof palettes.light) {
  if (block.type === 'text') { ctx.fillStyle = p.body; ctx.font = `400 ${BODY}px system-ui, sans-serif`; block.lines.forEach((line, index) => ctx.fillText(line, x + 6, y + 25 + index * BODY_LINE)); return; }
  roundRect(ctx, x, y, width, block.height, 14, p.code, p.codeBorder); ctx.fillStyle = p.codeHead; ctx.beginPath(); ctx.roundRect(x, y, width, 42, [14, 14, 0, 0]); ctx.fill();
  ['#fb7185', '#fbbf24', '#34d399'].forEach((color, index) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 18 + index * 18, y + 21, 5, 0, Math.PI * 2); ctx.fill(); });
  ctx.textAlign = 'right'; ctx.fillStyle = p.codeLabel; ctx.font = '800 13px ui-monospace, Menlo, monospace'; ctx.fillText(block.language || 'TEXT', x + width - 16, y + 26); ctx.textAlign = 'left';
  ctx.fillStyle = p.codeText; ctx.font = `${CODE}px ui-monospace, Menlo, monospace`; block.lines.forEach((line, index) => ctx.fillText(line, x + 18, y + 65 + index * CODE_LINE));
}
