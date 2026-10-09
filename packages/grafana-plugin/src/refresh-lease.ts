export interface RefreshLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface RefreshLocationService {
  partial(query: Record<string, string | null>, replace?: boolean): void;
  getLocation(): RefreshLocation;
  getSearch(): URLSearchParams;
  getLocationObservable(): {
    subscribe(listener: (location: RefreshLocation) => void): { unsubscribe(): void };
  };
}

export interface RefreshLeaseToken {
  id: number;
}

interface LeaseEntry {
  id: number;
  owner: string;
  originalRefresh: string;
  pathname: string;
  hash: string;
  captureId?: string;
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createRefreshLeaseManager(location: RefreshLocationService, options: { ttlMs: number }) {
  let active: LeaseEntry | undefined;
  let nextId = 0;

  const ownsCurrentLocation = (entry: LeaseEntry) => {
    const current = location.getLocation();
    return current.pathname === entry.pathname && current.hash === entry.hash && location.getSearch().get('refresh') === null;
  };

  const dispose = (entry: LeaseEntry, restore: boolean) => {
    if (active !== entry) return;
    active = undefined;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.unsubscribe?.();
    if (restore && ownsCurrentLocation(entry)) {
      location.partial({ refresh: entry.originalRefresh }, true);
    }
  };

  const acquire = (owner: string): RefreshLeaseToken => {
    if (active && ownsCurrentLocation(active)) {
      const entry = active;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.owner = owner;
      entry.id = ++nextId;
      entry.captureId = undefined;
      entry.timer = setTimeout(() => dispose(entry, true), options.ttlMs);
      return { id: entry.id };
    }
    if (active) dispose(active, false);

    const current = location.getLocation();
    const originalRefresh = location.getSearch().get('refresh');
    const token = { id: ++nextId };
    if (originalRefresh === null) return token;

    const entry: LeaseEntry = {
      id: token.id,
      owner,
      originalRefresh,
      pathname: current.pathname,
      hash: current.hash,
    };
    active = entry;
    try {
      location.partial({ refresh: null }, true);
      if (!ownsCurrentLocation(entry)) {
        dispose(entry, false);
        return token;
      }
      const subscription = location.getLocationObservable().subscribe(() => {
        if (active === entry && !ownsCurrentLocation(entry)) dispose(entry, false);
      });
      entry.unsubscribe = () => subscription.unsubscribe();
      entry.timer = setTimeout(() => dispose(entry, true), options.ttlMs);
    } catch (error) {
      dispose(entry, false);
      throw error;
    }
    return token;
  };

  const release = (token: RefreshLeaseToken, captureId?: string) => {
    if (active?.id === token.id && (captureId === undefined || active.captureId === captureId)) dispose(active, true);
  };

  const setCaptureId = (token: RefreshLeaseToken, captureId: string) => {
    if (active?.id === token.id) active.captureId = captureId;
  };

  return { acquire, release, setCaptureId };
}
