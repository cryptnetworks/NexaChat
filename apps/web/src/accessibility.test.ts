import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessibleTimestamp,
  createRateLimitedAnnouncer,
} from './accessibility.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('accessible message presentation', () => {
  it('gives a timestamp a date as well as a time', () => {
    expect(accessibleTimestamp('2026-07-19T14:05:00.000Z', 'en-US')).toMatch(
      /July 19, 2026/,
    );
  });

  it('coalesces message announcements within a bounded interval', () => {
    vi.useFakeTimers();
    const emissions: string[] = [];
    const announcer = createRateLimitedAnnouncer((message) => {
      emissions.push(message);
    });

    announcer.announceMessage();
    announcer.announceMessage();
    announcer.announceMessage();
    expect(emissions).toEqual([]);

    vi.advanceTimersByTime(2_999);
    expect(emissions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emissions).toEqual(['3 new messages received.']);

    announcer.announceMessage();
    vi.advanceTimersByTime(3_000);
    expect(emissions).toEqual([
      '3 new messages received.',
      '1 new message received.',
    ]);
    announcer.dispose();
  });

  it('cancels a pending announcement when its view is disposed', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const announcer = createRateLimitedAnnouncer(emit);
    announcer.announceMessage();
    announcer.dispose();
    vi.runAllTimers();
    expect(emit).not.toHaveBeenCalled();
  });
});
