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
  // Split-bill state. `remaining` is the live balance left to pay; it drops as parts are settled.
  const [remaining, setRemaining] = useState(balanceMinor);
  const [split, setSplit] = useState<'full' | 'equal' | 'amount'>('full');
  const [partsLeft, setPartsLeft] = useState(2); // people still to pay, in an equal split
  const [amountInput, setAmountInput] = useState(0);
  const [printReceipt, setPrintReceipt] = useState(() => {
    try {
      return localStorage.getItem(PRINT_PREF) === '1';
    } catch {
      return false;
    }
  });

  const unit = settings.cashRoundingMinor;
  // What this payment covers: the whole remaining balance, an equal share, or a typed amount.
  const target =
    split === 'equal'
      ? partsLeft <= 1
        ? remaining
        : Math.min(remaining, Math.max(unit, roundToUnit(Math.round(remaining / partsLeft), unit)))
      : split === 'amount'
        ? Math.min(remaining, Math.max(0, amountInput))
        : remaining;
  const settlingAll = target >= remaining;
  const due = settlingAll && method === 'cash' ? roundToUnit(remaining, unit) : target;

  const tenderedBase = useMemo(
    () => currencies.reduce((sum, c) => sum + toBase(tendered[c.code] ?? 0, c, base), 0),
    [tendered, currencies, base],
  );
  const raw = tenderedBase - due;
  const tip = method === 'card' ? cardTip : keepChange && settlingAll ? Math.max(0, raw) : 0;
  const change = method === 'cash' ? Math.max(0, floorToUnit(raw - tip, unit)) : 0;
  const missing = method === 'cash' ? Math.max(0, due - tenderedBase) : 0;
  const canPay = (method === 'card' ? due > 0 : tenderedBase >= due && due > 0) && (split !== 'amount' || target > 0);

  const add = (code: string, minor: number) => setTendered((tt) => ({ ...tt, [code]: (tt[code] ?? 0) + minor }));

  const resetTenders = () => {
    setTendered({});
    setKeepChange(false);
    setCardTip(0);
    setAmountInput(0);
  };

  const pay = async () => {
    setBusy(true);
    const tenders =
      method === 'card'
        ? [{ currency: base.code, amountMinor: due + tip }]
        : Object.entries(tendered)
            .filter(([, v]) => v > 0)
            .map(([currency, amountMinor]) => ({ currency, amountMinor }));
    const res = await run<{ changeMinor: number; remainingMinor: number; closed: boolean }>('tab.checkout', {
      tabId,
      method,
      tenders,
      tipMinor: tip,
      ...(settlingAll ? {} : { applyMinor: due }),
    });
    setBusy(false);
    if (!res) return;
    if (res.changeMinor > 0) toast(t('checkout.giveChange', { amount: money(res.changeMinor, base) }), 'success');
    if (res.closed) {
      // The receipt is shown above the floor (not here), so it survives this panel closing.
      if (printReceipt) onReceipt?.(tabId);
      onPaid();
      return;
    }
    // A split part was paid; keep the dialog open for the next one.
    setRemaining(res.remainingMinor);
    if (split === 'equal') setPartsLeft((n) => Math.max(1, n - 1));
    resetTenders();
    toast(t('checkout.partPaid', { amount: money(res.remainingMinor, base) }), 'success');
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

      <div className="split">
        <div className="seg" role="group" aria-label={t('checkout.split')}>
          {(['full', 'equal', 'amount'] as const).map((s) => (
            <button key={s} aria-pressed={split === s} onClick={() => { setSplit(s); resetTenders(); }}>
              {t(`checkout.split.${s}`)}
            </button>
          ))}
        </div>
        {split === 'equal' && (
          <div className="split-people">
            <span>{t('checkout.people')}</span>
            <div className="count-stepper">
              <button type="button" className="btn" onClick={() => setPartsLeft((n) => Math.max(1, n - 1))} aria-label={`${t('checkout.people')} −`}>−</button>
              <input className="input" inputMode="numeric" aria-label={t('checkout.people')} value={partsLeft} onChange={(e) => setPartsLeft(Math.max(1, Math.min(12, Number(e.target.value.replace(/\D/g, '')) || 1)))} />
              <button type="button" className="btn" onClick={() => setPartsLeft((n) => Math.min(12, n + 1))} aria-label={`${t('checkout.people')} +`}>+</button>
            </div>
          </div>
        )}
        {split === 'amount' && (
          <label className="field">
            <span>{t('checkout.thisPart')}</span>
            <MoneyInput currency={base} label={t('checkout.thisPart')} value={amountInput} onChange={setAmountInput} />
          </label>
        )}
      </div>

      <div className="pay-due">
        <small>{settlingAll ? t('checkout.due') : t('checkout.partDue')}</small>
        <b>{money(due, base)}</b>
        {settlingAll && due !== remaining && <small>{t('checkout.rounded', { amount: money(remaining, base) })}</small>}
        {!settlingAll && <small>{t('checkout.remainingAfter', { amount: money(remaining - due, base) })}</small>}
        {settlingAll && remaining !== balanceMinor && <small>{t('checkout.lastPart')}</small>}
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
          {raw > 0 && settlingAll && (
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
          {!settlingAll ? t('checkout.payPart') : method === 'cash' ? t('checkout.confirmCash') : t('checkout.confirmCard')}
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
