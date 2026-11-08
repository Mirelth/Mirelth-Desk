import { useEffect, useState } from 'react';
import { apiClient, downloadFile, getErrorMessage, streamTask } from '../lib/api.ts';
import { useLoad, usePaged, useStream } from '../lib/hooks.ts';
import type { DatasetDto, DatasetSummary, TaskKind } from '../lib/types.ts';
import {
  AiOutput, BarChart, Button, EmptyState, ErrorBanner, Field, Icon, LineChart, Modal,
  Skeleton, formatDate, formatNumber, useToast,
} from '../lib/ui.tsx';

const SAMPLE = `月份,产品线,营收,成本,新客户\n1月,文档,128,62,24\n2月,文档,142,65,28\n3月,文档,151,68,31\n4月,文档,168,71,35`;

export function Analytics({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const list = usePaged<DatasetSummary>('/api/analytics/datasets', 20);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useLoad<DatasetDto | null>(() =>
    selectedId ? apiClient.get<DatasetDto>(`/api/analytics/datasets/${selectedId}`) : Promise.resolve(null), [selectedId]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [filename, setFilename] = useState('data.csv');
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [aiLabel, setAiLabel] = useState('');
  const stream = useStream();

  useEffect(() => {
    if (!list.items?.length) return;
    if (!selectedId || !list.items.some((item) => item.id === selectedId)) setSelectedId(list.items[0].id);
  }, [list.items, selectedId]);

  const upload = async () => {
    if (!csv.trim()) { toast('请先选择 CSV 文件或粘贴内容', 'error'); return; }
    setUploading(true);
    try {
      const created = await apiClient.post<DatasetDto>('/api/analytics/datasets', { name: name.trim() || undefined, filename, csv });
      setUploadOpen(false);
      setCsv('');
      setName('');
      setSelectedId(created.id);
      await list.reload();
      onChanged?.();
      toast(`已导入 ${created.stats.rowCount} 行数据`, 'success');
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    } finally { setUploading(false); }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setFilename(file.name);
    setCsv(content);
    if (!name) setName(file.name.replace(/\.(csv|txt|tsv)$/i, ''));
  };

  const runAi = async (kind: TaskKind, label: string) => {
    const data = detail.data;
    if (!data || stream.running) return;
    stream.reset();
    setAiLabel(label);
    stream.setRunning(true);
    let full = '';
    try {
      await streamTask(kind, {
        datasetName: data.name, rowCount: data.stats.rowCount, columns: data.stats.columns,
        groups: data.stats.groups, trend: data.stats.trend, correlations: data.stats.correlations,
      }, {
        onDelta: (chunk) => { full += chunk; stream.setText(full); },
        onMeta: (meta) => stream.setLabel(meta.label),
        onError: (message) => stream.setError(message),
      }, stream.signal);
    } catch (error) { stream.setError(getErrorMessage(error)); }
    finally { stream.setRunning(false); onChanged?.(); }
  };

  const remove = async () => {
    if (!selectedId || !window.confirm('确定删除该数据集？')) return;
    try {
      await apiClient.delete(`/api/analytics/datasets/${selectedId}`);
      setSelectedId(null);
      stream.reset();
      await list.reload();
      onChanged?.();
      toast('数据集已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const dataset = detail.data;
  const numericCount = dataset?.stats.columns.filter((column) => column.type === 'numeric').length ?? 0;
  const missingTotal = dataset?.stats.columns.reduce((sum, column) => sum + column.missing, 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>数据分析</h1><p>导入 CSV，自动推断字段、计算统计并生成图表与洞察报告</p></div>
        <div className="page-actions">
          <Button icon="upload" onClick={() => setUploadOpen(true)}>导入 CSV</Button>
        </div>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={() => void list.reload()} />}

      <div className="split-layout wide-list">
        <div className="card list-pane">
          <div className="card-head"><div><h3>数据集</h3><div className="sub">{list.items?.length ?? 0} 个数据集</div></div>
            <Icon name="chart" size={16} className="muted" /></div>
          <div className="list-scroll">
            {list.loading && !list.items ? <div style={{ padding: 12 }}><Skeleton height={70} /></div> : null}
            {list.items?.length ? list.items.map((item) => (
              <button type="button" key={item.id} className={`list-item ${selectedId === item.id ? 'active' : ''}`}
                onClick={() => { setSelectedId(item.id); stream.reset(); }}>
                <div className="list-title">{item.name}</div>
                <div className="list-excerpt">{item.filename}</div>
                <div className="list-meta"><span>{item.rowCount} 行</span><span>{item.columnCount} 列</span><span>{formatDate(item.createdAt)}</span></div>
              </button>
            )) : !list.loading && <EmptyState icon="chart" title="还没有数据集" hint="导入一份 CSV，即可开始分析。" action={<Button size="sm" icon="plus" onClick={() => setUploadOpen(true)}>导入数据</Button>} />}
          </div>
        </div>

        {!dataset ? (
          <div className="card"><EmptyState icon="chart" title="选择一个数据集" hint="支持带引号的 CSV、自动识别数值与类别列，最多 5000 行。" /></div>
        ) : (
          <div className="detail-pane stack">
            <div className="card">
              <div className="toolbar">
                <div><strong style={{ fontSize: 15 }}>{dataset.name}</strong>
                  <div className="text-xs muted mt-8">{dataset.filename} · 更新于 {formatDate(dataset.createdAt)}</div></div>
                <span className="grow" />
                <Button variant="outline" size="sm" icon="bolt" disabled={stream.running} onClick={() => void runAi('analytics.insights', '数据洞察')}>AI 洞察</Button>
                <Button variant="outline" size="sm" icon="file" disabled={stream.running} onClick={() => void runAi('analytics.report', '分析报告')}>分析报告</Button>
                <Button variant="outline" size="sm" icon="download" onClick={() => void downloadFile(`/api/analytics/datasets/${dataset.id}/export`, `${dataset.name}.csv`).catch((error) => toast(getErrorMessage(error), 'error'))}>导出</Button>
                <Button variant="danger" size="sm" icon="trash" onClick={() => void remove()}>删除</Button>
              </div>
              <div className="metric-grid">
                <div className="metric-tile"><div className="label">数据行数</div><div className="value">{formatNumber(dataset.stats.rowCount)}</div></div>
                <div className="metric-tile"><div className="label">字段数</div><div className="value">{dataset.stats.columnCount}</div></div>
                <div className="metric-tile"><div className="label">数值型字段</div><div className="value">{numericCount}</div></div>
                <div className="metric-tile"><div className="label">缺失值总数</div><div className="value">{missingTotal}</div></div>
              </div>
            </div>

            <div className="chart-grid">
              <div className="card"><div className="card-head"><div><h3>分组对比</h3><div className="sub">按首个类别字段聚合均值</div></div></div>
                <div className="card-pad"><BarChart data={dataset.stats.groups.map((group) => ({ label: group.label, value: group.value }))} /></div></div>
              <div className="card"><div className="card-head"><div><h3>趋势变化</h3><div className="sub">按记录顺序汇总首个数值字段</div></div></div>
                <div className="card-pad"><LineChart data={dataset.stats.trend} /></div></div>
            </div>

            <div className="card">
              <div className="card-head"><div><h3>字段统计</h3><div className="sub">描述性统计由服务端计算，AI 结论只引用这些数值</div></div></div>
              <div className="card-pad">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>字段</th><th>类型</th><th>缺失</th><th>唯一值</th><th>均值</th><th>最小</th><th>最大</th><th>标准差</th></tr></thead>
                    <tbody>{dataset.stats.columns.map((column) => (
                      <tr key={column.name}>
                        <td><strong>{column.name}</strong></td>
                        <td><span className={`badge ${column.type === 'numeric' ? 'badge-blue' : 'badge-neutral'}`}>{column.type === 'numeric' ? '数值' : '类别'}</span></td>
                        <td className="num">{column.missing}</td><td className="num">{column.unique ?? '—'}</td>
                        <td className="num">{column.mean ?? '—'}</td><td className="num">{column.min ?? '—'}</td>
                        <td className="num">{column.max ?? '—'}</td><td className="num">{column.std ?? '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {dataset.stats.correlations.length > 0 && (
                  <div className="mt-16"><div className="text-sm muted mb-12">数值字段相关性（Pearson）</div>
                    <div className="chip-row">{dataset.stats.correlations.map((item) => <span className="chip" key={item.pair}>{item.pair} · {item.value}</span>)}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="card ai-panel" style={{ borderRadius: 16 }}>
              <AiOutput text={stream.text} running={stream.running} error={stream.error}
                label={`${aiLabel || 'AI 分析'}${stream.label ? ` · ${stream.label}` : ''}`}
                onCopy={() => { void navigator.clipboard.writeText(stream.text).then(() => toast('已复制', 'success')); }}
                emptyHint="点击「AI 洞察」或「分析报告」，基于上面的真实统计结果生成结论。" />
            </div>

            <div className="card">
              <div className="card-head"><div><h3>数据预览</h3><div className="sub">最多展示前 200 行</div></div></div>
              <div className="card-pad">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr>{dataset.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
                    <tbody>{dataset.rows.slice(0, 30).map((row, index) => (
                      <tr key={index}>{dataset.columns.map((column) => (
                        <td key={column.name} className={typeof row[column.name] === 'number' ? 'num' : ''}>{row[column.name] ?? '—'}</td>
                      ))}</tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal open={uploadOpen} onClose={() => setUploadOpen(false)} title="导入 CSV 数据集" subtitle="文件只在本地解析并保存到本机 SQLite"
        width={640} footer={<>
          <Button variant="ghost" onClick={() => setCsv(SAMPLE)}>填入示例</Button>
          <Button variant="ghost" onClick={() => setUploadOpen(false)}>取消</Button>
          <Button icon="check" loading={uploading} onClick={() => void upload()}>导入并分析</Button>
        </>}>
        <Field label="选择文件" hint="支持 .csv / .txt，单次最多 5000 行、8MB">
          <input className="input" type="file" accept=".csv,.txt,.tsv" onChange={(event) => void readFile(event.target.files?.[0])} />
        </Field>
        <div className="form-grid">
          <Field label="数据集名称"><input className="input" value={name} placeholder="留空则使用文件名" onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="文件名"><input className="input" value={filename} onChange={(event) => setFilename(event.target.value)} /></Field>
        </div>
        <Field label="或直接粘贴 CSV 内容">
          <textarea className="textarea" style={{ minHeight: 160, fontFamily: 'monospace' }} value={csv}
            placeholder="月份,营收,成本\n1月,128,62" onChange={(event) => setCsv(event.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}
