import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, command, type Approval } from './api';
import { money } from './format';
import { t } from './i18n';
import type { Currency } from './types';

/* ---- Dialog ------------------------------------------------------------------ */

export function Dialog({ title, onClose, children, wide, labelledBy }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, button.btn-primary, button');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const id = labelledBy ?? 'dialog-title';
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* ---- Toasts + command runner -------------------------------------------------- */

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

interface RunCtx {
  run: <T = Record<string, unknown>>(type: string, payload: unknown) => Promise<T | undefined>;
  toast: (text: string, tone?: Toast['tone']) => void;
  showError: (e: unknown) => void;
}

const Ctx = createContext<RunCtx | null>(null);

export function useRun(): RunCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRun outside RunProvider');
  return c;
}

interface Pending {
  type: string;
  payload: unknown;
  requestId: string;
  resolve: (v: unknown) => void;
}

export function RunProvider({ children, baseCurrency }: { children: ReactNode; baseCurrency: Currency | null }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++seq.current;
    setToasts((ts) => [...ts.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);

  const showError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const params: Record<string, string | number> = { ...e.params };
        if (typeof e.params.missingMinor === 'number' && baseCurrency) params.missing = money(e.params.missingMinor, baseCurrency);
        toast(t(e.code, params), 'error');
      } else {
        toast(t('error.internal'), 'error');
      }
    },
    [toast, baseCurrency],
  );

  const run = useCallback(
    async <T,>(type: string, payload: unknown): Promise<T | undefined> => {
      const requestId = crypto.randomUUID();
      try {
        return await command<T>(type, payload, { requestId });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'error.needs_manager') {
          return new Promise<T | undefined>((resolve) => setPending({ type, payload, requestId, resolve: resolve as (v: unknown) => void }));
        }
        showError(e);
        return undefined;
      }
    },
    [showError],
  );

  return (
    <Ctx.Provider value={{ run, toast, showError }}>
      {children}
      {pending && (
        <ApprovalDialog
          onCancel={() => {
            pending.resolve(undefined);
            setPending(null);
          }}
          onApprove={async (approval) => {
            try {
              const result = await command(pending.type, pending.payload, { requestId: pending.requestId, approval });
              pending.resolve(result);
              setPending(null);
            } catch (e) {
              if (e instanceof ApiError && e.code === 'error.approval_failed') throw e;
              showError(e);
              pending.resolve(undefined);
              setPending(null);
            }
          }}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>
            {x.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ApprovalDialog({ onCancel, onApprove }: { onCancel: () => void; onApprove: (a: Approval) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={t('approval.title')} onClose={onCancel}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>{t('approval.intro')}</p>
      <form
        style={{ display: 'grid', gap: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onApprove({ username, password });
          } catch {
            setError(t('error.approval_failed'));
            setPassword('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>{t('login.username')}</span>
          <input className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {t('approval.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---- Money input ----------------------------------------------------------------- */

export function MoneyInput({ value, onChange, currency, label, autoFocus }: { value: number; onChange: (minor: number) => void; currency: Currency; label: string; autoFocus?: boolean }) {
  const [text, setText] = useState(value ? String(value / 10 ** currency.decimals) : '');
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value ? String(value / 10 ** currency.decimals) : '');
      last.current = value;
    }
  }, [value, currency.decimals]);
  return (
    <input
      className="input input-money"
      inputMode="decimal"
      aria-label={label}
      autoFocus={autoFocus}
      value={text}
      placeholder="0"
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const cleaned = raw.replace(/\s/g, '').replace(',', '.');
        const n = cleaned === '' ? 0 : Number(cleaned);
        if (Number.isFinite(n) && n >= 0) {
          const minor = Math.round(n * 10 ** currency.decimals);
          last.current = minor;
          onChange(minor);
        }
      }}
    />
  );
}
