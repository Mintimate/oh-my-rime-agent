import { useEffect } from 'react';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';
import { faSun, faMoon, faDesktop, faScrewdriverWrench, faGaugeHigh, faPlus, faCheck, faBookOpen, faArrowUpRightFromSquare, faXmark, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { CLIENTS, type ClientOption, type ThemeMode, type ToolCallState, type Usage } from '../types';
import { toolLabel } from '../lib/utils';

const TOOL_NAMES = ['judge_off_topic', 'oh_my_rime_knowledge_base', 'plan_knowledge_queries', 'compose_prompt_context', 'search_docs', 'resolve_client', 'target_file', 'make_patch', 'check_yaml', 'diagnose_rime_directory'];

const THEME_META: Record<ThemeMode, { icon: IconDefinition; label: string }> = {
  light: { icon: faSun, label: '亮色' },
  system: { icon: faDesktop, label: '系统' },
  dark: { icon: faMoon, label: '暗色' },
};

const CLIENT_META: Record<string, { title: string; subtitle: string }> = {
  knowledge: { title: '通用 Rime', subtitle: '词库与配置知识' },
  squirrel: { title: '鼠须管', subtitle: 'macOS · Squirrel' },
  weasel: { title: '小狼毫', subtitle: 'Windows · Weasel' },
  linux: { title: 'Linux Rime', subtitle: 'IBus / Fcitx 5' },
  mobile: { title: '移动端', subtitle: 'iOS / Android' },
};

export function Sidebar({
  open, selected, themeMode, usage, conversationId, tools, toolboxOpen, onToggleToolbox, onClose, onSelect, onTheme, onReset,
}: {
  open: boolean;
  selected: ClientOption;
  themeMode: ThemeMode;
  usage: Usage;
  conversationId: string;
  tools: ToolCallState[];
  toolboxOpen: boolean;
  onToggleToolbox: (open: boolean) => void;
  onClose: () => void;
  onSelect: (client: ClientOption) => void;
  onTheme: (theme: ThemeMode) => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);
  const latest = new Map<string, ToolCallState['status']>();
  for (const tool of tools) latest.set(tool.name, tool.status);
  return <>
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="会话设置">
      <div className="sidebar-header">
        <div className="brand-lockup">
          <BrandIcon size={36} />
          <span className="brand-copy"><strong>oh-my-rime</strong><small>Agent · 配置工作台</small></span>
          <button type="button" className="sidebar-close" onClick={onClose} aria-label="关闭侧栏"><Icon icon={faXmark} /></button>
        </div>
        <button type="button" className="new-chat-button" onClick={() => { onReset(); onClose(); }}><Icon icon={faPlus} /> 新建会话</button>
      </div>
      <div className="sidebar-scroll">
        <section>
          <h2 className="section-label">你的输入环境</h2>
          <div className="client-list">
            {CLIENTS.map((client) => {
              const active = selected.id === client.id;
              const meta = CLIENT_META[client.id];
              return <button
                type="button" key={client.id} className={`client-card ${active ? 'active' : ''}`}
                aria-pressed={active} onClick={() => { onSelect(client); onClose(); }}
              >
                <b><Icon icon={client.glyph} /></b>
                <span className="client-copy"><strong>{meta?.title || client.label}</strong><small>{meta?.subtitle || client.value}</small></span>
                {active && <Icon icon={faCheck} className="client-check" />}
              </button>;
            })}
          </div>
        </section>
        <section className="sidebar-session">
          <h2 className="section-label">会话信息</h2>
          <details className="sidebar-details" open={toolboxOpen} onToggle={(event) => onToggleToolbox(event.currentTarget.open)}>
            <summary><Icon icon={faScrewdriverWrench} /> 助手工具</summary>
            <div className="tool-directory">{TOOL_NAMES.map((name) => {
              const state = latest.get(name);
              const label = state === 'running' ? '运行中' : state === 'done' ? '完成' : state === 'interrupted' ? '已中断' : '待命';
              return <div key={name} className={`tool-entry ${state || ''}`}><i aria-hidden="true" /> <code>{toolLabel(name)}</code><span>{label}</span></div>;
            })}</div>
          </details>
          <details className="sidebar-details">
            <summary><Icon icon={faGaugeHigh} /> 用量与会话</summary>
            <div className="usage-card">
              <span>输入 Token <b>{usage.input.toLocaleString()}</b></span>
              <span>输出 Token <b>{usage.output.toLocaleString()}</b></span>
              <span>合计 Token <b>{usage.total.toLocaleString()}</b></span>
              <small>会话 ID：{conversationId}</small>
            </div>
          </details>
        </section>
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-links">
          <a href="https://www.mintimate.cc" target="_blank" rel="noreferrer"><Icon icon={faBookOpen} /> 使用文档 <Icon icon={faArrowUpRightFromSquare} /></a>
          <a href="https://github.com/Mintimate/oh-my-rime" target="_blank" rel="noreferrer">项目仓库 <Icon icon={faArrowUpRightFromSquare} /></a>
        </div>
        <div className="theme-switch" role="group" aria-label="主题切换">
          {(['light', 'system', 'dark'] as ThemeMode[]).map((mode) => <button
            type="button" key={mode} className={themeMode === mode ? 'active' : ''}
            aria-pressed={themeMode === mode} aria-label={`${THEME_META[mode].label}主题`} onClick={() => onTheme(mode)}
          ><Icon icon={THEME_META[mode].icon} /> {THEME_META[mode].label}</button>)}
        </div>
      </div>
    </aside>
    <button className={`sidebar-backdrop ${open ? 'visible' : ''}`} aria-label="关闭侧栏" onClick={onClose} />
  </>;
}
