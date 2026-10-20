import { describe, expect, it } from 'vitest';
import { pageExpired, readFrameEvent } from '../web/src/frameEvents.js';

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
    expect(pageExpired({ type: 'perflo:error', frame_session_id: 'fs_1', code: 'sign_in_failed' })).toBe(false);
    expect(pageExpired({ type: 'perflo:error', frame_session_id: 'fs_1' })).toBe(false);
    expect(pageExpired({ type: 'perflo:closed', frame_session_id: 'fs_1', code: 'frame_expired' })).toBe(false);
  });
});
