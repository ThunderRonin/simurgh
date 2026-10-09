import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { createRefreshLeaseManager, type RefreshLocationService } from '../packages/grafana-plugin/src/refresh-lease';

class FakeLocationService implements RefreshLocationService {
  private pathname = '/d/dashboard/panel';
  private hash = '';
  private query = new URLSearchParams('from=now-15m&to=now&timezone=utc&var-host=node-exporter%3A9100&refresh=5s');
  private listeners = new Set<(location: { pathname: string; search: string; hash: string }) => void>();

  partial(query: Record<string, string | null>, _replace?: boolean) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null) this.query.delete(key);
      else this.query.set(key, value);
    }
    this.emit();
  }

  getLocation() {
    return { pathname: this.pathname, search: `?${this.query.toString()}`, hash: this.hash };
  }

  getSearch() {
    return new URLSearchParams(this.query);
  }

  getLocationObservable() {
    return {
      subscribe: (listener: (location: { pathname: string; search: string; hash: string }) => void) => {
        this.listeners.add(listener);
        return { unsubscribe: () => this.listeners.delete(listener) };
      },
    };
  }

  setRefresh(value: string | null) {
    if (value === null) this.query.delete('refresh');
    else this.query.set('refresh', value);
    this.emit();
  }

  navigate(pathname: string, search: string) {
    this.pathname = pathname;
    this.query = new URLSearchParams(search);
    this.emit();
  }

  private emit() {
    const location = this.getLocation();
    for (const listener of this.listeners) listener(location);
  }
}

describe('Grafana refresh pause lease', () => {
  afterEach(() => vi.useRealTimers());

  it('pauses and restores only refresh while preserving time, timezone, and variables', () => {
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const token = lease.acquire('request-1');
    const paused = location.getSearch();
    assert.equal(paused.get('refresh'), null);
    assert.equal(paused.get('from'), 'now-15m');
    assert.equal(paused.get('to'), 'now');
    assert.equal(paused.get('timezone'), 'utc');
    assert.equal(paused.get('var-host'), 'node-exporter:9100');

    lease.release(token);
    lease.release(token);
    assert.equal(location.getSearch().get('refresh'), '5s');
    assert.equal(location.getSearch().get('from'), 'now-15m');
    assert.equal(location.getSearch().get('var-host'), 'node-exporter:9100');
  });

  it('does not overwrite a manual refresh change or restore across navigation', () => {
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const token = lease.acquire('request-1');
    location.setRefresh('10s');
    lease.release(token);
    assert.equal(location.getSearch().get('refresh'), '10s');

    const next = lease.acquire('request-2');
    location.navigate('/d/other/panel', 'from=now-1h&to=now&refresh=off');
    lease.release(next);
    assert.equal(location.getLocation().pathname, '/d/other/panel');
    assert.equal(location.getSearch().get('refresh'), 'off');
  });

  it('restores on the same dashboard after query changes without replacing those values', () => {
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const token = lease.acquire('request-1');
    location.navigate('/d/dashboard/panel', 'from=now-5m&to=now&timezone=utc&var-host=other%3A9100');
    lease.release(token);
    assert.equal(location.getSearch().get('refresh'), '5s');
    assert.equal(location.getSearch().get('from'), 'now-5m');
    assert.equal(location.getSearch().get('var-host'), 'other:9100');
  });

  it('transfers an active pause to the newer request without restoring between them', () => {
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const first = lease.acquire('request-1');
    const second = lease.acquire('request-2');
    assert.equal(location.getSearch().get('refresh'), null);
    lease.release(first);
    assert.equal(location.getSearch().get('refresh'), null);
    lease.release(second);
    assert.equal(location.getSearch().get('refresh'), '5s');
  });

  it('restores the original cadence on bounded lease expiry', () => {
    vi.useFakeTimers();
    const location = new FakeLocationService();
    createRefreshLeaseManager(location, { ttlMs: 1_000 }).acquire('request-1');
    assert.equal(location.getSearch().get('refresh'), null);
    vi.advanceTimersByTime(1_000);
    assert.equal(location.getSearch().get('refresh'), '5s');
  });

  it('resets the expiry when a newer request takes ownership', () => {
    vi.useFakeTimers();
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    lease.acquire('request-1');
    vi.advanceTimersByTime(59_000);
    const second = lease.acquire('request-2');
    vi.advanceTimersByTime(2_000);
    assert.equal(location.getSearch().get('refresh'), null);
    lease.release(second);
    assert.equal(location.getSearch().get('refresh'), '5s');
  });

  it('requires the current token and capture id before external completion can restore', () => {
    const location = new FakeLocationService();
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const oldToken = lease.acquire('request-1');
    const currentToken = lease.acquire('request-2');
    lease.setCaptureId(currentToken, 'freehand-capture-2');
    lease.release(oldToken, 'freehand-capture-2');
    lease.release(currentToken, 'stale-capture-id');
    assert.equal(location.getSearch().get('refresh'), null);
    lease.release(currentToken, 'freehand-capture-2');
    assert.equal(location.getSearch().get('refresh'), '5s');
  });

  it('does not claim or restore a refresh cadence that was already off', () => {
    const location = new FakeLocationService();
    location.setRefresh(null);
    const lease = createRefreshLeaseManager(location, { ttlMs: 60_000 });
    const token = lease.acquire('request-1');
    lease.release(token);
    assert.equal(location.getSearch().get('refresh'), null);
  });
});
