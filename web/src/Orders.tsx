import { useState } from 'react';
import { api } from './api';
import { pageVisibility, useOnMount } from './browser';
import { cancelUntilDone } from './cancel';
import { CardDetails } from './CardDetails';
import { CANCEL_SLOW_TEXT, money, phaseLabel, when } from './copy';
import { formatUsd } from '../../server/money';
import type { OrderView } from '../../server/views';

interface Props {
  /** The person's orders, shared with the chat. null until the first list arrives. */
  orders: OrderView[] | null;
  error: string;
  /** Reads the list again, with orders that are still moving brought up to date first. */
  onRefresh: () => Promise<void>;
  onOrder: (order: OrderView) => void;
  onAccountChanged: () => void;
}

/** Orders that were sent to payments, newest first. Drafts never left the chat. */
function sentOrders(orders: OrderView[]): OrderView[] {
  return orders.filter((o) => o.phase !== 'draft' && o.phase !== 'discarded').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function Orders({ orders, error, onRefresh, onOrder, onAccountChanged }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState('');
  /** The card whose cancel has not gone through yet after Tiny kept trying. */
  const [slowCancel, setSlowCancel] = useState<string | null>(null);

  // Opening the tab looks again once; after that the list follows what the chat learns.
  useOnMount(() => {
    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
  });

  const cancelCard = async (perfloOrderId: string) => {
    setCancelError('');
    setSlowCancel(null);
    setCancelling(perfloOrderId);
    try {
      const outcome = await cancelUntilDone(() => api.cancelCard(perfloOrderId), { visibility: pageVisibility });
      if (outcome.kind === 'slow') setSlowCancel(perfloOrderId);
      else if (outcome.cancelled.order) onOrder(outcome.cancelled.order);
      else onAccountChanged();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setCancelling(null);
    }
  };

  const list = orders ? sentOrders(orders) : null;
  return (
    <section className="box">
      <h2>Orders</h2>
      {list === null && !error && <p className="muted">Loading...</p>}
      {list !== null && refreshing && (
        <p className="muted small" role="status">
          Checking for updates...
        </p>
      )}
      {list?.length === 0 && <p className="muted">No orders yet. Ask Tiny to buy something in the chat.</p>}
      {list && list.length > 0 && (
        <ul className="orders">
          {list.map((order) => {
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
                    <button className="link" disabled={cancelling !== null} onClick={() => void cancelCard(order.perfloOrderId as string)}>
                      {cancelling === order.perfloOrderId
                        ? 'Cancelling...'
                        : slowCancel === order.perfloOrderId
                          ? 'Check again'
                          : 'Cancel card'}
                    </button>
                    {slowCancel === order.perfloOrderId && cancelling === null && (
                      <p className="muted small" role="status">
                        {CANCEL_SLOW_TEXT}
                      </p>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(error || cancelError) && (
        <p className="error" role="alert">
          {cancelError || error}
        </p>
      )}
    </section>
  );
}
