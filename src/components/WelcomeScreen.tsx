import { Icon } from './Icon';
import { faArrowRight, faPalette, faKeyboard, faSliders, faFileWaveform, faPaperclip } from '@fortawesome/free-solid-svg-icons';

const suggestions = [
  { icon: faPalette, label: '换个喜欢的外观', description: '配色、字体与候选栏', prompt: '我想调整输入法的配色、字体和候选栏样式，请根据我的客户端给出配置建议。' },
  { icon: faKeyboard, label: '找到顺手的方案', description: '全拼、双拼与词库', prompt: '我想使用自然码双拼，请告诉我如何在当前客户端中配置，并保留全拼方案。' },
  { icon: faSliders, label: '定制我的快捷键', description: '切换、翻页与选词', prompt: '我想自定义简繁切换和候选翻页快捷键，请根据我的客户端给出配置方法。' },
  { icon: faFileWaveform, label: '排查配置问题', description: '检查 YAML 与部署异常', prompt: '我的 Rime 配置修改后没有生效，请帮我逐步排查，并告诉我需要上传哪些配置文件。' },
];

export function WelcomeScreen({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <div className="welcome-screen">
    <div className="welcome-eyebrow"><span aria-hidden="true" /> RIME CONFIGURATION ASSISTANT</div>
    <div className="welcome-hero">
      <div className="welcome-copy">
        <h1>让 Rime，<br /><em>更合你的习惯。</em></h1>
        <p className="welcome-description">从一处配色，到一套输入方案。<br />说说你的想法，一起把配置调顺手。</p>
      </div>
      <figure className="welcome-preview" aria-label="输入法候选栏效果示例">
        <div className="preview-composition"><span>ni hao</span><i aria-hidden="true" /></div>
        <div className="preview-candidates"><span className="selected"><small>1</small> 你好</span><span><small>2</small> 你号</span><span><small>3</small> 拟好</span></div>
        <figcaption className="preview-note">每一次输入，都可以更顺手。<span>候选栏效果示例</span></figcaption>
      </figure>
    </div>
    <div className="suggestion-heading"><h2>从一个小改变开始</h2><span>选个方向，聊聊你的需求</span></div>
    <div className="suggestion-grid">{suggestions.map(({ icon, label, description, prompt }) => <button type="button" key={label} onClick={() => onPrompt(prompt)}>
      <span className="suggestion-icon"><Icon icon={icon} /></span>
      <span className="suggestion-copy"><b>{label}</b><small>{description}</small></span>
      <Icon icon={faArrowRight} className="suggestion-arrow" />
    </button>)}</div>
    <p className="welcome-hint"><Icon icon={faPaperclip} /> 也可以上传配置文件，或粘贴截图，一起排查问题。</p>
    <details className="welcome-resources"><summary>查看文档与教程</summary><div>
      <a href="https://www.mintimate.cc" target="_blank" rel="noreferrer">官方文档</a>
      <a href="https://space.bilibili.com/355567627" target="_blank" rel="noreferrer">作者 B 站</a>
      <a href="https://www.mintimate.cn/2026/06/23/edgeOneMakersOhMyRimeAgent/" target="_blank" rel="noreferrer">复刻 / 部署教程</a>
    </div></details>
  </div>;
}
