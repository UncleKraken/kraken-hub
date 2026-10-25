import { useEffect, useState } from 'react';
import { api, getToken } from './api';
import { LoginScreen, SetupScreen } from './Auth';
import { Desk } from './Desk';
import { t } from './i18n';

type Phase = 'loading' | 'setup' | 'login' | 'desk' | 'unreachable';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');

  const decide = async () => {
    try {
      const { needsSetup } = await api.get<{ needsSetup: boolean }>('/api/setup');
      setPhase(needsSetup ? 'setup' : getToken() ? 'desk' : 'login');
    } catch {
      setPhase('unreachable');
    }
  };

  useEffect(() => {
    void decide();
  }, []);

  if (phase === 'loading') return <div className="auth">{t('common.loading')}</div>;
  if (phase === 'unreachable')
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="form-error">{t('error.network')}</div>
          <button className="btn" onClick={() => void decide()}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    );
  if (phase === 'setup') return <SetupScreen onDone={() => setPhase('desk')} />;
  if (phase === 'login') return <LoginScreen onDone={() => setPhase('desk')} />;
  return <Desk onSignedOut={() => setPhase('login')} />;
}
