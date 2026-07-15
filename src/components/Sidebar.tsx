import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';
import { faSun, faMoon, faDesktop, faLayerGroup, faScrewdriverWrench, faGaugeHigh, faArrowsRotate, faArrowUpRightFromSquare, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { CLIENTS, type ClientOption, type ThemeMode, type ToolCallState, type Usage } from '../types';
import { toolLabel } from '../lib/utils';

const TOOL_NAMES = ['judge_off_topic', 'oh_my_rime_knowledge_base', 'plan_knowledge_queries', 'compose_prompt_context', 'search_docs', 'resolve_client', 'target_file', 'make_patch', 'check_yaml', 'diagnose_rime_directory'];

const THEME_META: Record<ThemeMode, { icon: IconDefinition; label: string }> = {
  light: { icon: faSun, label: '亮色' },
  system: { icon: faDesktop, label: '系统' },
  dark: { icon: faMoon, label: '暗色' },
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
  const latest = new Map<string, ToolCallState['status']>();
  for (const tool of tools) latest.set(tool.name, tool.status);
  return <>
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="会话设置">
      <div className="sidebar-header">
        <div className="brand-lockup"><BrandIcon /><strong>oh-my-rime Agent</strong></div>
        <div className="theme-switch" role="group" aria-label="主题切换">
          {(['light', 'system', 'dark'] as ThemeMode[]).map((mode) => <button
            type="button" key={mode} className={themeMode === mode ? 'active' : ''}
            aria-pressed={themeMode === mode} aria-label={THEME_META[mode].label} onClick={() => onTheme(mode)}
          ><Icon icon={THEME_META[mode].icon} /> {THEME_META[mode].label}</button>)}
        </div>
      </div>
      <div className="sidebar-scroll">
        <section>
          <h2 className="section-label"><Icon icon={faLayerGroup} /> 目标查询场景</h2>
          <div className="client-grid">
            {CLIENTS.map((client) => <button
              type="button" key={client.id} className={`client-card ${selected.id === client.id ? 'active' : ''}`}
              aria-pressed={selected.id === client.id} onClick={() => { onSelect(client); onClose(); }}
            ><b><Icon icon={client.glyph} /></b><span>{client.label}</span></button>)}
          </div>
        </section>
        <details className="sidebar-details" open={toolboxOpen} onToggle={(event) => onToggleToolbox(event.currentTarget.open)}>
          <summary><Icon icon={faScrewdriverWrench} /> Agent 工具箱</summary>
          <div className="tool-directory">{TOOL_NAMES.map((name) => {
            const state = latest.get(name);
            const label = state === 'running' ? '运行中' : state === 'done' ? '完成' : state === 'interrupted' ? '已中断' : '待命';
            return <div key={name} className={`tool-entry ${state || ''}`}><i /> <code>{toolLabel(name)}</code><span>{label}</span></div>;
          })}</div>
        </details>
        <details className="sidebar-details">
          <summary><Icon icon={faGaugeHigh} /> 本次会话开销</summary>
          <div className="usage-card">
            <span>输入 Token <b>{usage.input}</b></span>
            <span>输出 Token <b>{usage.output}</b></span>
            <span>总计 Token <b>{usage.total}</b></span>
            <small>{conversationId}</small>
          </div>
        </details>
      </div>
      <div className="sidebar-footer">
        <button type="button" onClick={onReset}><Icon icon={faArrowsRotate} /> 开启新会话（清空记忆）</button>
        <a href="https://github.com/Mintimate/oh-my-rime" target="_blank" rel="noreferrer">访问 oh-my-rime 官方仓库 <Icon icon={faArrowUpRightFromSquare} /></a>
      </div>
    </aside>
    <button className={`sidebar-backdrop ${open ? 'visible' : ''}`} aria-label="关闭侧栏" onClick={onClose} />
  </>;
}
