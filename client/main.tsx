import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { ToastProvider } from './lib/ui.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
// Toast 在 App 之上：外壳自己（账号菜单的日志打包、检查更新）也要能弹提示。
createRoot(root).render(<ToastProvider><App /></ToastProvider>);
