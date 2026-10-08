import { useEffect, useState } from 'react';
import { api } from './api';
import { CardDetails } from './CardDetails';
import { money, phaseLabel, when } from './copy';
import { formatUsd } from '../../server/money';
import type { OrderView } from '../../server/views';

interface Props {
  /** Bumped by the chat whenever an order or money may have changed. */
  refreshKey: number;
  onAccountChanged: () => void;
}

/** Orders that were sent to payments, newest first. Drafts never left the chat. */
function sentOrders(orders: OrderView[]): OrderView[] {
  return orders
    .filter((o) => o.phase !== 'draft' && o.phase !== 'discarded')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function Orders({ refreshKey, onAccountChanged }: Props) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .orders()
        .then((r) => live && setOrders(sentOrders(r.orders)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load your orders.'));
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refreshKey, reload]);

  const cancelCard = async (perfloOrderId: string) => {
    setError('');
    setBusy(true);
    try {
      await api.cancelCard(perfloOrderId);
      setReload((n) => n + 1);
      onAccountChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="box">
      <h2>Orders</h2>
      {orders === null && !error && <p className="muted">Loading...</p>}
      {orders?.length === 0 && <p className="muted">No orders yet. Ask Tiny to buy something in the chat.</p>}
      {orders && orders.length > 0 && (
        <ul className="orders">
          {orders.map((order) => {
            const last4 = order.checkout?.last4 ?? order.cardLast4;
            return (
              <li key={order.id}>
                <div className="orders-head">
                  <span className="muted small">{when(order.createdAt)}</span>
                  <span className={`status ${order.phase}`}>{phaseLabel(order.phase)}</span>
                </div>
                <p className="orders-what">
                  <strong>{formatUsd(order.amountCents)}</strong> {order.description ? `${order.description}, ` : ''}
                  {order.domain}
                </p>
                {last4 && order.phase !== 'ready' && <p className="muted small">One-time card .... {last4}</p>}
                {order.amountSpent && <p className="muted small">Paid {money(order.amountSpent)}</p>}
                {order.amountReturned && order.amountReturned !== '0.00' && (
                  <p className="muted small">{money(order.amountReturned)} went back to your balance</p>
                )}
                {order.phase === 'ready' && order.perfloOrderId && last4 && (
                  <>
                    <CardDetails
                      perfloOrderId={order.perfloOrderId}
                      last4={last4}
                      cardLimit={order.checkout?.cardLimit ?? order.cardLimit}
                      expMonth={order.checkout?.expMonth}
                      expYear={order.checkout?.expYear}
                    />
                    <button className="link" disabled={busy} onClick={() => void cancelCard(order.perfloOrderId as string)}>
                      Cancel card
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
