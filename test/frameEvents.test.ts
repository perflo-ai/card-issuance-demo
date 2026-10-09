import { describe, expect, it } from 'vitest';
import { readFrameEvent } from '../web/src/frameEvents.js';

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

  it('ignores bare strings, unknown types and missing session ids', () => {
    expect(readFrameEvent('perflo:setup_completed')).toBeNull();
    expect(readFrameEvent({ type: 'perflo:hacked', frame_session_id: 'fs_1' })).toBeNull();
    expect(readFrameEvent({ type: 'perflo:setup_completed' })).toBeNull();
    expect(readFrameEvent(null)).toBeNull();
  });
});
