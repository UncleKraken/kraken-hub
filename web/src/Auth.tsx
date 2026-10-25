import { useState } from 'react';
import { api, ApiError, setToken } from './api';
import { getLang, setLang, t, useLang, type Lang } from './i18n';

function LangSwitch() {
  const lang = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {(['sq', 'en'] as Lang[]).map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
          {t(`lang.${l}`)}
        </button>
      ))}
    </div>
  );
}

export { LangSwitch };

export function SetupScreen({ onDone }: { onDone: () => void }) {
  useLang();
  const [venueName, setVenueName] = useState('');
  const [code, setCode] = useState('ALL');
  const [symbol, setSymbol] = useState('L');
  const [decimals, setDecimals] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="auth-mark">
            {t('app.name')}
            <small>{t('setup.intro')}</small>
          </div>
          <div style={{ flex: 'none' }}>
            <LangSwitch />
          </div>
        </div>
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const { token } = await api.post<{ token: string }>('/api/setup', {
                venueName,
                language: getLang(),
                baseCurrency: { code: code.toUpperCase(), symbol, decimals },
                manager: { username, displayName, password },
              });
              setToken(token);
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? t(err.code, err.params) : t('error.internal'));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{t('setup.title')}</h2>
          <label className="field">
            <span>{t('setup.venue')}</span>
            <input className="input" value={venueName} onChange={(e) => setVenueName(e.target.value)} required maxLength={60} />
          </label>
          <h3>{t('setup.currency')}</h3>
          <div className="row">
            <label className="field">
              <span>{t('setup.code')}</span>
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} required minLength={3} maxLength={3} />
            </label>
            <label className="field">
              <span>{t('setup.symbol')}</span>
              <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} required maxLength={4} />
            </label>
            <label className="field">
              <span>{t('setup.decimals')}</span>
              <select className="input" value={decimals} onChange={(e) => setDecimals(Number(e.target.value))}>
                <option value={0}>0</option>
                <option value={2}>2</option>
              </select>
            </label>
          </div>
          <h3>{t('setup.manager')}</h3>
          <label className="field">
            <span>{t('setup.displayName')}</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} />
          </label>
          <label className="field">
            <span>{t('setup.username')}</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[a-zA-Z0-9._\-]{2,32}" autoComplete="username" />
          </label>
          <label className="field">
            <span>{t('setup.password')}</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary btn-big" disabled={busy}>
            {t('setup.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}

export function LoginScreen({ venueName, onDone }: { venueName?: string; onDone: () => void }) {
  useLang();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="auth-mark">
            {t('app.name')}
            {venueName && <small>{venueName}</small>}
          </div>
          <div style={{ flex: 'none' }}>
            <LangSwitch />
          </div>
        </div>
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const { token } = await api.post<{ token: string }>('/api/login', { username, password });
              setToken(token);
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? t(err.code, err.params) : t('error.internal'));
              setPassword('');
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{t('login.title')}</h2>
          <label className="field">
            <span>{t('login.username')}</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoFocus />
          </label>
          <label className="field">
            <span>{t('login.password')}</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary btn-big" disabled={busy}>
            {t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
