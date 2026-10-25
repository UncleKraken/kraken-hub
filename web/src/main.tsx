import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClientApp } from './client/ClientApp';
import { getLang } from './i18n';
import './styles.css';

document.documentElement.lang = getLang();

// The same build serves the counter (/) and the customer PCs (/client).
const isClient = location.pathname.startsWith('/client');
if (isClient) document.title = 'Kraken Hub';

createRoot(document.getElementById('root')!).render(<StrictMode>{isClient ? <ClientApp /> : <App />}</StrictMode>);
