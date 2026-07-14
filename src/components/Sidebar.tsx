import { BrandIcon } from './BrandIcon';
import { CLIENTS, type ClientOption, type ThemeMode, type ToolCallState, type Usage } from '../types';
import { toolLabel } from '../lib/utils';

const TOOL_NAMES = ['search_docs', 'resolve_client', 'target_file', 'make_patch', 'check_yaml', 'diagnose_rime_directory'];

export function Sidebar({
  open, selected, themeMode, usage, conversationId, tools, onClose, onSelect, onTheme, onReset,
}: {
  open: boolean;
  selected: ClientOption;
  themeMode: ThemeMode;
  usage: Usage;
  conversationId: string;
  tools: ToolCallState[];
  onClose: () => void;
  onSelect: (client: ClientOption) => void;
  onTheme: (theme: ThemeMode) => void;
  onReset: () => void;
}) {
  const latest = new Map(tools.map((tool) => [tool.name, tool.status]));
  return <>
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="会话设置">
      <div className="sidebar-header">
        <div className="brand-lockup"><BrandIcon /><strong>oh-my-rime Agent</strong></div>
        <div className="theme-switch" role="group" aria-label="主题切换">
          {(['light', 'system', 'dark'] as ThemeMode[]).map((mode) => <button
            type="button" key={mode} className={themeMode === mode ? 'active' : ''}
            aria-pressed={themeMode === mode} onClick={() => onTheme(mode)}
          >{mode === 'light' ? '☼ 亮色' : mode === 'dark' ? '☾ 暗色' : '▣ 系统'}</button>)}
        </div>
      </div>
      <div className="sidebar-scroll">
        <section>
          <h2 className="section-label">▱ 目标查询场景</h2>
          <div className="client-grid">
            {CLIENTS.map((client) => <button
              type="button" key={client.id} className={`client-card ${selected.id === client.id ? 'active' : ''}`}
              aria-pressed={selected.id === client.id} onClick={() => { onSelect(client); onClose(); }}
            ><b>{client.glyph}</b><span>{client.label}</span></button>)}
          </div>
        </section>
        <details className="sidebar-details">
          <summary>⌕ Agent 工具箱</summary>
          <div className="tool-directory">{TOOL_NAMES.map((name) => {
            const state = latest.get(name);
            return <div key={name} className={`tool-entry ${state || ''}`}><i /> <code>{toolLabel(name)}</code><span>{state === 'running' ? '运行中' : state === 'done' ? '完成' : '待命'}</span></div>;
          })}</div>
        </details>
        <details className="sidebar-details">
          <summary>◔ 本次会话开销</summary>
          <div className="usage-card">
            <span>输入 Token <b>{usage.input}</b></span>
            <span>输出 Token <b>{usage.output}</b></span>
            <span>总计 Token <b>{usage.total}</b></span>
            <small>{conversationId}</small>
          </div>
        </details>
      </div>
      <div className="sidebar-footer">
        <button type="button" onClick={onReset}>↻ 开启新会话（清空记忆）</button>
        <a href="https://github.com/Mintimate/oh-my-rime" target="_blank" rel="noreferrer">访问 oh-my-rime 官方仓库 ↗</a>
      </div>
    </aside>
    <button className={`sidebar-backdrop ${open ? 'visible' : ''}`} aria-label="关闭侧栏" onClick={onClose} />
  </>;
}
