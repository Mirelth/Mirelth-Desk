import { useRef, useState } from 'react';
import type { PageId } from '../lib/types.ts';
import { HOME_CATEGORIES } from '../lib/homeCatalog.ts';
import { ErrorBanner, Icon, useToast } from '../lib/ui.tsx';

interface Props {
  error: string;
  reload: () => void;
  navigate: (page: PageId) => void;
  openAgent: (text: string) => void;
}

/**
 * 首页：一屏对话式布局，不滚动。
 * 六分类横向等分铺满，切换分类就换一组任务卡；卡片只把提示词填进输入框，发送与否由用户决定。
 */
export function Dashboard({ error, reload, navigate, openAgent }: Props) {
  const toast = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [question, setQuestion] = useState('');
  const [categoryId, setCategoryId] = useState(HOME_CATEGORIES[0].id);
  const [setIndex, setSetIndex] = useState<Record<string, number>>({});
  const [attachOpen, setAttachOpen] = useState(false);

  const category = HOME_CATEGORIES.find((item) => item.id === categoryId) ?? HOME_CATEGORIES[0];
  const currentSet = setIndex[category.id] ?? 0;
  const cards = category.sets[currentSet] ?? category.sets[0];

  const send = (text: string) => {
    const value = text.trim();
    if (!value) return;
    openAgent(value);
    setQuestion('');
    setAttachOpen(false);
  };

  const pickCard = (prompt: string) => {
    setQuestion(prompt);
    textareaRef.current?.focus();
  };

  const cycleSet = (next?: number) => {
    setSetIndex((prev) => ({
      ...prev,
      [category.id]: next ?? ((prev[category.id] ?? 0) + 1) % category.sets.length,
    }));
  };

  return (
    <div className="page launch-page">
      <div className="launch-stage">
        {error && <ErrorBanner message={error} onRetry={reload} />}

        <div className="launch-hero">
          <div className="launch-mark"><Icon name="sparkles" size={30} /></div>
          <h1 className="launch-title">你说我做，随时待命</h1>
        </div>

        <div className="launch-ask">
          <span className="label">想做点什么：</span>
          <div className="launch-chip-bar" role="tablist" aria-label="任务分类">
            {HOME_CATEGORIES.map((item) => (
              <button type="button" key={item.id} role="tab" aria-selected={item.id === category.id}
                className={`launch-chip ${item.id === category.id ? 'active' : ''}`}
                onClick={() => setCategoryId(item.id)}>
                <Icon name={item.icon} size={15} />{item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="launch-cards" key={`${category.id}-${currentSet}`}>
          {cards.map((card, index) => (
            <button type="button" key={card.title} className="launch-card launch-tint"
              style={{ ['--tint' as string]: `var(--card-tint-${(index % 4) + 1})` }}
              onClick={() => pickCard(card.prompt)} title={card.prompt}>
              <span className="launch-card-icon"><Icon name={card.icon} size={22} /></span>
              <h4>{card.title}</h4>
              <p>{card.description}</p>
            </button>
          ))}
        </div>

        <div className="launch-swap-row">
          <div className="launch-dots" role="tablist" aria-label="卡片分组">
            {category.sets.map((_, index) => (
              <button type="button" key={index} className={`launch-dot ${index === currentSet ? 'active' : ''}`}
                aria-label={`第 ${index + 1} 组`} aria-selected={index === currentSet}
                onClick={() => cycleSet(index)} />
            ))}
          </div>
          <button type="button" className="launch-swap" onClick={() => cycleSet()}>
            <Icon name="refresh" size={14} />换一换
          </button>
        </div>

        <div className="launch-spacer" />

        <div className="launch-composer">
          <div className="launch-composer-top">
            <span className="launch-tag"><Icon name="shield" size={13} />本地运行<Icon name="down" size={12} /></span>
            <span className="launch-tag"><Icon name="layers" size={13} />Mirelth 工作台<Icon name="down" size={12} /></span>
          </div>
          <textarea ref={textareaRef} className="launch-textarea" value={question}
            placeholder="如果我有做得不好的地方，请及时发消息指正，这样我会越来越懂您"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(question); } }} />
          {attachOpen && (
            <div className="attach-menu">
              <button type="button" onClick={() => { setAttachOpen(false); navigate('analytics'); }}>导入 CSV 数据</button>
              <button type="button" onClick={() => { setAttachOpen(false); navigate('documents'); }}>从模板写文档</button>
              <button type="button" onClick={() => { setAttachOpen(false); navigate('papers'); }}>粘贴 BibTeX 文献</button>
            </div>
          )}
          <div className="launch-composer-foot">
            <button type="button" className="launch-plus" title="添加材料" onClick={() => setAttachOpen(!attachOpen)}>
              <Icon name="plus" size={15} />
            </button>
            <span className="row grow" />
            <span className="launch-select" title="仅使用本机数据">默认权限 <Icon name="down" size={12} /></span>
            <span className="launch-select" title="当前生成引擎">智能 <Icon name="down" size={12} /></span>
            <button type="button" className="launch-plus" title="语音输入" onClick={() => toast('语音输入暂未接入，可直接输入文字', 'info')}>
              <Icon name="mic" size={16} />
            </button>
            <button type="button" className="launch-send" title="发送给智能体" disabled={!question.trim()} onClick={() => send(question)}>
              <Icon name="send" size={16} />
            </button>
          </div>
        </div>
        <div className="launch-disclaimer">内容由 AI 自动生成，无法确保真实准确性，仅供参考</div>
      </div>
    </div>
  );
}
