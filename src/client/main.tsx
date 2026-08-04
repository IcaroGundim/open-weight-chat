import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './components/ChatView';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento #root não encontrado.');

createRoot(root).render(
  <StrictMode>
    <ChatView />
  </StrictMode>,
);
