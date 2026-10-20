import { describe, expect, it } from 'vitest';
import { frameOrigins, pageExpired, readFrameEvent } from '../web/src/frameEvents.js';

describe('readFrameEvent (browser side of SPEC 8 postMessage)', () => {
  it('accepts the object payload and keeps only known id fields', () => {
    expect(
      readFrameEvent({
        type: 'perflo:top_up_completed',
        frame_session_id: 'fs_1',
        top_up_id: 'tu_1',
        order_id: 'ord_1',
        user_access_token: 'x',
      }),
    ).toEqual({ type: 'perflo:top_up_completed', frame_session_id: 'fs_1', top_up_id: 'tu_1', order_id: 'ord_1' });
    expect(readFrameEvent({ type: 'perflo:error', frame_session_id: 'fs_1', code: 'frame_expired' })).toEqual({
      type: 'perflo:error',
      frame_session_id: 'fs_1',
      code: 'frame_expired',
    });
  });

  it('accepts perflo:connection_completed with its connection_id, and reads no login names', () => {
    expect(
      readFrameEvent({ type: 'perflo:connection_completed', frame_session_id: 'fs_1', connection_id: 'lg_1', login_id: 'lg_1' }),
    ).toEqual({
      type: 'perflo:connection_completed',
      frame_session_id: 'fs_1',
      connection_id: 'lg_1',
    });
    expect(readFrameEvent({ type: 'perflo:setup_completed', frame_session_id: 'fs_1', connection_id: 'lg_1' })).toEqual({
      type: 'perflo:setup_completed',
      frame_session_id: 'fs_1',
      connection_id: 'lg_1',
    });
    expect(readFrameEvent({ type: 'perflo:login_completed', frame_session_id: 'fs_1', login_id: 'lg_1' })).toBeNull();
  });

  it('ignores bare strings, unknown types and missing session ids', () => {
    expect(readFrameEvent('perflo:setup_completed')).toBeNull();
    expect(readFrameEvent({ type: 'perflo:hacked', frame_session_id: 'fs_1' })).toBeNull();
    expect(readFrameEvent({ type: 'perflo:setup_completed' })).toBeNull();
    expect(readFrameEvent(null)).toBeNull();
  });
});

describe('pageExpired: a Perflo page says its time is over', () => {
  it('is true only for the error a page sends when its session ran out', () => {
    expect(pageExpired({ type: 'perflo:error', frame_session_id: 'fs_1', code: 'frame_expired' })).toBe(true);
    expect(pageExpired({ type: 'perflo:error', frame_session_id: 'fs_1', code: 'connection_failed' })).toBe(false);
    expect(pageExpired({ type: 'perflo:error', frame_session_id: 'fs_1' })).toBe(false);
    expect(pageExpired({ type: 'perflo:closed', frame_session_id: 'fs_1', code: 'frame_expired' })).toBe(false);
  });
});

describe('frameOrigins: where a Perflo page in Tiny may speak from', () => {
  const API = 'https://api.perflo.ai';
  const CHECKOUT = 'https://checkout.perflo.ai';
  const origins = { perflo: API, checkout: CHECKOUT };

  it('a page Perflo.js placed speaks from the API origin only, whatever its link says', () => {
    expect(frameOrigins(origins, true, `${CHECKOUT}/setup?session=x`)).toEqual([API]);
    expect(frameOrigins({ perflo: API, checkout: null }, true, 'not a link')).toEqual([API]);
  });

  it('a page opened from its link on the checkout origin is opened, and speaks from either Perflo origin', () => {
    expect(frameOrigins(origins, false, `${CHECKOUT}/setup?session=x`)).toEqual([API, CHECKOUT]);
    expect(frameOrigins(origins, false, `${CHECKOUT}/limits?session=x`)).toEqual([API, CHECKOUT]);
    // A link handed out on the API host before it had a checkout host sends the person on to it.
    expect(frameOrigins(origins, false, `${API}/v1/frames/setup?session=x`)).toEqual([API, CHECKOUT]);
  });

  it('with no checkout origin, links stay on the API origin, as before', () => {
    expect(frameOrigins({ perflo: API, checkout: null }, false, `${API}/v1/frames/setup?session=x`)).toEqual([API]);
    expect(frameOrigins({ perflo: API, checkout: null }, false, `${CHECKOUT}/setup?session=x`)).toEqual([]);
  });

  it('a link on any other origin is not opened at all', () => {
    expect(frameOrigins(origins, false, 'https://evil.example/setup?session=x')).toEqual([]);
    expect(frameOrigins(origins, false, 'https://checkout.perflo.ai.evil.example/setup')).toEqual([]);
    expect(frameOrigins(origins, false, 'javascript:alert(1)')).toEqual([]);
    expect(frameOrigins(origins, false, 'not a link')).toEqual([]);
  });
});
