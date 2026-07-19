import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
