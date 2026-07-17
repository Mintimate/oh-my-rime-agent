import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faBook } from '@fortawesome/free-solid-svg-icons';
import { faApple, faWindows, faLinux, faAndroid } from '@fortawesome/free-brands-svg-icons';

export type ThemeMode = 'light' | 'system' | 'dark';
export type Theme = 'light' | 'dark';

export interface ConfigFilePayload {
  path: string;
  name: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface PastedImage {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface ToolCallState {
  name: string;
  status: 'running' | 'done' | 'interrupted';
  summary: string;
}

export interface ChatAttachment {
  name: string;
  type: 'file' | 'image';
  preview?: string;
  size?: number;
  content?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: ChatAttachment[];
  tools: ToolCallState[];
  thinking?: string;
  streaming?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  total: number;
}

export interface ClientOption {
  id: string;
  label: string;
  value: string;
  glyph: IconDefinition;
}

export const CLIENTS: ClientOption[] = [
  { id: 'knowledge', label: 'Rime 词库查询', value: 'Rime 词库查询（不限定客户端）', glyph: faBook },
  { id: 'squirrel', label: 'Squirrel 鼠须管', value: 'macOS Squirrel (鼠须管)', glyph: faApple },
  { id: 'weasel', label: 'Weasel 小狼毫', value: 'Windows Weasel (小狼毫)', glyph: faWindows },
  { id: 'linux', label: 'Linux Rime', value: 'Linux Rime (ibus/fcitx5)', glyph: faLinux },
  { id: 'mobile', label: '移动端 Rime', value: 'iOS / Android (同等客户端)', glyph: faAndroid },
];
