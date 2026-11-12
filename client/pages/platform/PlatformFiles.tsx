import { useRef, useState } from 'react';
import { apiClient, downloadFile, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformFile } from '../../lib/types.ts';
import { Badge, Button, EmptyState, IconButton, SectionTitle, formatDate, formatNumber, useToast } from '../../lib/ui.tsx';

/** 文件 tab：附件存在 `.data/files/`，单文件 5MB；上传走 base64。 */
export function PlatformFiles({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const files = useLoad<PlatformFile[]>(() => apiClient.get<PlatformFile[]>('/api/platform/files'));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    if (file.size > 5_000_000) { toast('单个附件不能超过 5MB', 'error'); return; }
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      await apiClient.post('/api/platform/files', {
        filename: file.name, mime: file.type || 'application/octet-stream', contentBase64: base64,
      });
      await files.reload();
      onChanged?.();
      toast('已上传', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/api/platform/files/${id}`);
      await files.reload();
      onChanged?.();
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <SectionTitle
        title="附件"
        hint="本机磁盘上的文件，上传后会进知识库索引"
        action={<Button icon="upload" loading={busy} onClick={() => inputRef.current?.click()}>上传文件</Button>}
      />
      <input ref={inputRef} type="file" style={{ display: 'none' }}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />

      {(files.data ?? []).length ? (
        <div className="grid-2">
          {(files.data ?? []).map((file) => (
            <div key={file.id} className="card card-pad">
              <div className="row wrap mb-8">
                <Badge tone="violet">{file.mime.split('/')[1] ?? 'bin'}</Badge>
                <strong className="text-sm grow">{file.filename}</strong>
                <IconButton icon="download" title="下载" onClick={() => void downloadFile(`/api/platform/files/${file.id}/download`, file.filename).catch((error) => toast(getErrorMessage(error), 'error'))} />
                <IconButton icon="trash" title="删除" onClick={() => void remove(file.id)} />
              </div>
              <div className="text-xs muted">{formatNumber(file.size)} 字节 · {formatDate(file.created_at)}</div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="upload" title="还没有附件" hint="上传 PDF、图片或文本，之后可以让智能体在会话里检索它们。" />}
    </div>
  );
}
