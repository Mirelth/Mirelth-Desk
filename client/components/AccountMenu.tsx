import { Icon, type IconName } from '../lib/ui.tsx';
import type { ThemeMode } from '../lib/theme.ts';

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '系统' },
];

interface Props {
  username: string;
  mode: ThemeMode;
  version: string;
  onMode: (mode: ThemeMode) => void;
  onActivity: () => void;
  onSettings: () => void;
  onLogs: () => void;
  onCheckUpdate: () => void;
  onLogout: () => void;
  onClose: () => void;
}

function Item({ icon, label, hint, onClick }: { icon: IconName; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" className="account-item" onClick={onClick}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {hint && <span className="account-hint">{hint}</span>}
    </button>
  );
}

/**
 * 左下角头像弹出的账号菜单：活动、设置、外观、日志打包、检查更新、退出登录。
 * 弹层用 `position: fixed`，因为侧栏本身是可滚动的，绝对定位会被裁掉。
 */
export function AccountMenu({
  username, mode, version, onMode, onActivity, onSettings, onLogs, onCheckUpdate, onLogout, onClose,
}: Props) {
  return (
    <>
      <div className="account-backdrop" onClick={onClose} />
      <div className="account-menu" role="menu" aria-label="账号菜单">
        <div className="account-who">
          <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
          <div><b>{username}</b><div className="account-sub">本机账号 · 数据不出本机</div></div>
        </div>
        <Item icon="clock" label="活动" onClick={onActivity} />
        <Item icon="settings" label="设置" onClick={onSettings} />
        <div className="account-item is-static">
          <Icon name="eye" size={15} />
          <span>外观</span>
          <div className="account-seg" role="group" aria-label="外观">
            {THEMES.map((item) => (
              <button type="button" key={item.value} aria-pressed={mode === item.value}
                className={mode === item.value ? 'active' : ''} onClick={() => onMode(item.value)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <Item icon="download" label="日志打包" hint="txt" onClick={onLogs} />
        <Item icon="refresh" label="检查更新" hint={version ? `v${version}` : ''} onClick={onCheckUpdate} />
        <div className="account-sep" />
        <button type="button" className="account-item danger" onClick={onLogout}>
          <Icon name="logout" size={15} /><span>退出登录</span>
        </button>
      </div>
    </>
  );
}
