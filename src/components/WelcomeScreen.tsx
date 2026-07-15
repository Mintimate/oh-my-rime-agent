import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';
import { faFileWaveform, faCommentDots, faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';

const suggestions = [
  ['横向候选栏设置', '小狼毫如何设置横向候选栏？'],
  ['配置双拼输入', '如何在鼠须管中切换为双拼输入（如自然码双拼）？'],
  ['修改候选词数量', '我想修改候选词个数为 7 个。'],
  ['定制快捷键', '小狼毫快捷键 Control+G 简繁切换怎么配置？'],
];

export function WelcomeScreen({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <div className="welcome-screen">
    <BrandIcon size={58} className="welcome-brand" />
    <h1>您好！我是 Rime 配置助理</h1>
    <p>基于 EdgeOne Makers 运行的 oh-my-rime 输入法智能助手，为您提供一站式配置修改、语法诊断与词库管理服务。</p>
    <div className="guide-grid">
      <article><b><Icon icon={faFileWaveform} /></b><span><strong>上传文件诊断</strong>上传 YAML 或 Lua，快速定位常见配置问题。</span></article>
      <article><b><Icon icon={faCommentDots} /></b><span><strong>直接发起提问</strong>描述目标效果，生成可直接使用的配置 Patch。</span></article>
    </div>
    <details className="welcome-resources"><summary>查看文档与教程</summary><div>
      <a href="https://www.mintimate.cc" target="_blank" rel="noreferrer">官方文档</a>
      <a href="https://space.bilibili.com/355567627" target="_blank" rel="noreferrer">作者 B 站</a>
      <a href="https://www.mintimate.cn/2026/06/23/edgeOneMakersOhMyRimeAgent/" target="_blank" rel="noreferrer">复刻 / 部署教程</a>
    </div></details>
    <div className="suggestion-grid">{suggestions.map(([label, prompt]) => <button type="button" key={label} onClick={() => onPrompt(prompt)}><b><Icon icon={faWandMagicSparkles} /> {label}</b><span>{prompt}</span></button>)}</div>
  </div>;
}
