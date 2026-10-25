import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { dateTime, floorToUnit, money, roundToUnit, toBase } from './format';
import { t } from './i18n';
import type { Currency, Settings, TabDetail } from './types';
import { Dialog, MoneyInput, useRun } from './ui';

const PRINT_PREF = 'kh.printReceipt';

export function Checkout({
  tabId,
  title,
  balanceMinor,
  currencies,
  settings,
  onClose,
  onPaid,
  onReceipt,
}: {
  tabId: string;
  title: string;
  balanceMinor: number;
  currencies: Currency[];
  settings: Settings;
  onClose: () => void;
  onPaid: () => void;
  /** Called with the paid tab's id when the operator wants a printed receipt. */
  onReceipt?: (tabId: string) => void;
}) {
  const { run, toast } = useRun();
  const base = currencies.find((c) => c.isBase)!;
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [tendered, setTendered] = useState<Record<string, number>>({});
  const [keepChange, setKeepChange] = useState(false);
  const [cardTip, setCardTip] = useState(0);
  const [busy, setBusy] = useState(false);
  const [printReceipt, setPrintReceipt] = useState(() => {
    try {
      return localStorage.getItem(PRINT_PREF) === '1';
    } catch {
      return false;
    }
  });

  const unit = settings.cashRoundingMinor;
  const due = method === 'cash' ? roundToUnit(balanceMinor, unit) : balanceMinor;
  const tenderedBase = useMemo(
    () => currencies.reduce((sum, c) => sum + toBase(tendered[c.code] ?? 0, c, base), 0),
    [tendered, currencies, base],
  );
  const raw = tenderedBase - due;
  const tip = method === 'card' ? cardTip : keepChange ? Math.max(0, raw) : 0;
  const change = method === 'cash' ? Math.max(0, floorToUnit(raw - tip, unit)) : 0;
  const missing = method === 'cash' ? Math.max(0, due - tenderedBase) : 0;
  const canPay = method === 'card' ? due > 0 : tenderedBase >= due && due > 0;

  const add = (code: string, minor: number) => setTendered((tt) => ({ ...tt, [code]: (tt[code] ?? 0) + minor }));

  const pay = async () => {
    setBusy(true);
    const tenders =
      method === 'card'
        ? [{ currency: base.code, amountMinor: due + tip }]
        : Object.entries(tendered)
            .filter(([, v]) => v > 0)
            .map(([currency, amountMinor]) => ({ currency, amountMinor }));
    const res = await run<{ changeMinor: number }>('tab.checkout', { tabId, method, tenders, tipMinor: tip });
    setBusy(false);
    if (res) {
      toast(res.changeMinor > 0 ? t('checkout.giveChange', { amount: money(res.changeMinor, base) }) : t('checkout.done'), 'success');
      // The receipt is shown above the floor (not here), so it survives this panel closing.
      if (printReceipt) onReceipt?.(tabId);
      onPaid();
    }
  };

  const togglePrint = (on: boolean) => {
    setPrintReceipt(on);
    try {
      localStorage.setItem(PRINT_PREF, on ? '1' : '0');
    } catch {
      /* storage may be unavailable */
    }
  };

  const foreign = currencies.filter((c) => !c.isBase);

  return (
    <Dialog title={`${t('checkout.title')} · ${title}`} onClose={onClose} wide>
      <div className="seg" role="group" aria-label={t('checkout.title')}>
        <button aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>
          {t('checkout.cash')}
        </button>
        <button aria-pressed={method === 'card'} onClick={() => setMethod('card')}>
          {t('checkout.card')}
        </button>
      </div>

      <div className="pay-due">
        <small>{t('checkout.due')}</small>
        <b>{money(due, base)}</b>
        {due !== balanceMinor && <small>{t('checkout.rounded', { amount: money(balanceMinor, base) })}</small>}
        {method === 'cash' &&
          foreign.map((c) => (
            <span className="alt" key={c.code}>
              ≈ {money(Math.ceil((due / 10 ** base.decimals / c.rate) * 10 ** c.decimals), c)}
            </span>
          ))}
      </div>

      {method === 'cash' ? (
        <>
          {currencies.map((c) => (
            <div className="tender" key={c.code}>
              <div className="tender-head">
                <span>
                  {t('checkout.received')} · {c.code}
                </span>
                <MoneyInput currency={c} label={`${t('checkout.received')} ${c.code}`} value={tendered[c.code] ?? 0} onChange={(v) => setTendered((tt) => ({ ...tt, [c.code]: v }))} />
              </div>
              <div className="notes">
                {c.isBase && (
                  <button type="button" onClick={() => setTendered({ [c.code]: due })}>
                    {t('checkout.exact')}
                  </button>
                )}
                {c.cashDenominations.map((d) => (
                  <button type="button" key={d} onClick={() => add(c.code, d)}>
                    +{money(d, c)}
                  </button>
                ))}
                {(tendered[c.code] ?? 0) > 0 && (
                  <button type="button" onClick={() => setTendered((tt) => ({ ...tt, [c.code]: 0 }))}>
                    {t('checkout.clear')}
                  </button>
                )}
              </div>
            </div>
          ))}

          <div className={`change-box ${missing > 0 ? 'missing' : 'ok'}`} aria-live="polite">
            <span>{missing > 0 ? t('checkout.missing') : t('checkout.change')}</span>
            <b>{money(missing > 0 ? missing : change, base)}</b>
          </div>
          {raw > 0 && (
            <label className="check">
              <input type="checkbox" checked={keepChange} onChange={(e) => setKeepChange(e.target.checked)} />
              {t('checkout.keepChange')}
            </label>
          )}
        </>
      ) : (
        <>
          <div className="tender">
            <div className="tender-head">
              <span>{t('checkout.tip')}</span>
              <MoneyInput currency={base} label={t('checkout.tip')} value={cardTip} onChange={setCardTip} />
            </div>
          </div>
          <div className="change-box ok">
            <span>{t('checkout.cardAmount')}</span>
            <b>{money(due + cardTip, base)}</b>
          </div>
        </>
      )}

      <label className="check" style={{ marginTop: 4 }}>
        <input type="checkbox" checked={printReceipt} onChange={(e) => togglePrint(e.target.checked)} />
        {t('checkout.printReceipt')}
      </label>

      <div className="dialog-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary btn-big" disabled={!canPay || busy} onClick={() => void pay()}>
          {method === 'cash' ? t('checkout.confirmCash') : t('checkout.confirmCard')}
        </button>
      </div>
    </Dialog>
  );
}

/** A printable customer receipt, built from the authoritative closed-tab record. */
export function Receipt({ tabId, venueName, base, onDone }: { tabId: string; venueName: string; base: Currency; onDone: () => void }) {
  const [tab, setTab] = useState<TabDetail | null>(null);
  useEffect(() => {
    api
      .get<TabDetail>(`/api/tabs/${tabId}`)
      .then((d) => {
        setTab(d);
        // Give the layout a moment to settle, then open the print dialog automatically.
        setTimeout(() => window.print(), 300);
      })
      .catch(() => setTab(null));
  }, [tabId]);

  const items = tab?.lines.filter((l) => !l.reversed) ?? [];
  const payment = tab?.payments[tab.payments.length - 1] ?? null;

  return (
    <Dialog title={t('receipt.title')} onClose={onDone}>
      {!tab ? (
        <p className="empty-note">{t('common.loading')}</p>
      ) : (
        <div className="receipt">
          <div className="receipt-head">
            <b>{venueName}</b>
            <span>{dateTime(tab.closedAt ?? tab.openedAt)}</span>
            <span>{tab.stationName ?? tab.label}</span>
          </div>
          <div className="receipt-lines">
            {items.map((l) => (
              <div className="receipt-row" key={l.id}>
                <span>
                  {l.qty > 1 ? `${l.qty}× ` : ''}
                  {l.description}
                </span>
                <span>{money(l.amountMinor, base)}</span>
              </div>
            ))}
          </div>
          <div className="receipt-total receipt-row">
            <b>{t('receipt.total')}</b>
            <b>{money(tab.totals.chargedMinor, base)}</b>
          </div>
          {payment && (
            <div className="receipt-lines">
              <div className="receipt-row">
                <span>{payment.method === 'cash' ? t('checkout.cash') : t('checkout.card')}</span>
                <span>{money(payment.appliedMinor + payment.tipMinor, base)}</span>
              </div>
              {payment.tenders.map((tn, i) => (
                <div className="receipt-row dim" key={i}>
                  <span>{t('receipt.received')}</span>
                  <span>{money(tn.amountMinor, base)} {tn.currency}</span>
                </div>
              ))}
              {payment.tipMinor > 0 && (
                <div className="receipt-row dim">
                  <span>{t('checkout.tip')}</span>
                  <span>{money(payment.tipMinor, base)}</span>
                </div>
              )}
              {payment.changeMinor > 0 && (
                <div className="receipt-row dim">
                  <span>{t('checkout.change')}</span>
                  <span>{money(payment.changeMinor, base)}</span>
                </div>
              )}
            </div>
          )}
          {tab.member && (
            <div className="receipt-row dim">
              <span>{tab.member.name}</span>
              <span>{t('receipt.points', { n: tab.member.points })}</span>
            </div>
          )}
          <div className="receipt-foot">{t('receipt.thanks')}</div>
        </div>
      )}
      <div className="dialog-actions no-print">
        <button className="btn" onClick={() => window.print()} disabled={!tab}>
          {t('receipt.print')}
        </button>
        <button className="btn btn-primary" onClick={onDone} autoFocus>
          {t('common.done')}
        </button>
      </div>
    </Dialog>
  );
}
