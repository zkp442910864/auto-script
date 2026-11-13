import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// 不使用 StrictMode：避免开发模式下 effect 双执行导致事件监听重复注册、日志重复
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <App />,
);
