import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';

type VersionStatus = Protocol.ServiceWorker.ServiceWorkerVersionStatus;

/** Commands that need the worker itself, which only the browser can reach, with why. */
const UNSUPPORTED: Record<string, string> = {
  inspectWorker: 'service workers are debugged by the browser',
  startWorker: 'service workers are started by the browser',
  stopWorker: 'service workers are stopped by the browser',
  stopAllWorkers: 'service workers are stopped by the browser',
  deliverPushMessage: 'push messages are delivered by the browser',
  // The page could only ask through periodicSync.register, which needs an installed app.
  dispatchPeriodicSyncEvent: 'periodic sync events are dispatched by the browser',
};

/** How long skipWaiting waits for the waiting worker to activate. */
const SKIP_WAITING_TIMEOUT = 3000;

const INT64 = 2n ** 63n;
/** A registration id as Chrome reads it (base::StringToInt64): an optional sign, then digits. */
const int64 = (text: string) => {
  if (!/^[+-]?\d+$/.test(text)) return undefined;
  const n = BigInt(text);
  return n >= -INT64 && n < INT64 ? n : undefined;
};

/** Ids of registrations and workers, kept for as long as the objects are. */
const ids = new WeakMap<object, string>();
let nextId = 0;
const idOf = (o: object) => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = String(nextId++)));
  return id;
};

/** A worker's state in the protocol's names: the page sees a fetched script as `parsed`. */
const statusOf = (state: ServiceWorkerState): VersionStatus => (state === 'parsed' ? 'new' : state);

const workersOf = (reg: ServiceWorkerRegistration) => [reg.installing, reg.waiting, reg.active].filter(w => w !== null);

/**
 * The ServiceWorker domain from the page's registrations (`navigator.serviceWorker`): the
 * Application panel's Service workers view lists them and can update and unregister them. The
 * page cannot see whether a worker runs, so one is shown running until it is redundant, nor the
 * times its script was fetched; of the clients a worker controls it knows only itself, listed on
 * its controller as Chrome does, by its target id. Changes made by other tabs, which the
 * page is not told of, are looked for when its controller changes and when it comes back into view
 * or focus.
 */
export function registerServiceWorker(ctx: Pick<Context, 'session' | 'frames'>) {
  const { session } = ctx;
  // Reading it throws a SecurityError in a document of an opaque origin (a sandboxed iframe's).
  let container: ServiceWorkerContainer | undefined;
  try {
    container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  } catch {
    container = undefined;
  }
  let enabled = false;
  /** The registrations reported, with the workers already listened to. */
  const known = new Set<ServiceWorkerRegistration>();
  const watched = new WeakSet<object>();
  /** The registration of each worker reported. */
  const registrationOf = new WeakMap<ServiceWorker, ServiceWorkerRegistration>();
  /** The page's controller as last reported. */
  let controller = container?.controller ?? null;

  const registrations = async (): Promise<readonly ServiceWorkerRegistration[]> =>
    container ? container.getRegistrations() : [];
  const find = async (scopeURL: string) => (await registrations()).find(r => r.scope === scopeURL);

  const version = (
    reg: ServiceWorkerRegistration,
    worker: ServiceWorker
  ): Protocol.ServiceWorker.ServiceWorkerVersion => ({
    versionId: idOf(worker),
    registrationId: idOf(reg),
    scriptURL: worker.scriptURL,
    runningStatus: worker.state === 'redundant' ? 'stopped' : 'running',
    status: statusOf(worker.state),
    scriptLastModified: 0,
    scriptResponseTime: 0,
    // The page's own target, whose id is its top frame's (Target domain).
    controlledClients: worker === container?.controller ? [ctx.frames.top.id] : [],
  });

  const report = (reg: ServiceWorkerRegistration, isDeleted = false) => {
    if (!enabled) return;
    session.emit('ServiceWorker.workerRegistrationUpdated', {
      registrations: [{ registrationId: idOf(reg), scopeURL: reg.scope, isDeleted }],
    });
    session.emit('ServiceWorker.workerVersionUpdated', { versions: workersOf(reg).map(w => version(reg, w)) });
  };

  /** Follows a registration's workers through their states; reports it unless that is done. */
  const watch = (reg: ServiceWorkerRegistration, reported = false) => {
    known.add(reg);
    const watchWorkers = () => {
      for (const worker of workersOf(reg)) {
        registrationOf.set(worker, reg);
        if (watched.has(worker)) continue;
        watched.add(worker);
        worker.addEventListener('statechange', () => {
          if (!enabled) return;
          session.emit('ServiceWorker.workerVersionUpdated', { versions: [version(reg, worker)] });
        });
      }
    };
    if (!watched.has(reg)) {
      watched.add(reg);
      reg.addEventListener('updatefound', () => {
        watchWorkers();
        report(reg);
      });
    }
    watchWorkers();
    if (!reported) report(reg);
  };

  /**
   * Runs `look` after the looks before it: each reads the registrations, then reports what changed
   * since the one before, so that none reports a registration twice.
   */
  let looking: Promise<void> = Promise.resolve();
  const inTurn = (look: () => Promise<void> | void) => (looking = looking.then(look).catch(() => {}));

  /** Reports registrations added since, and removed ones as deleted. */
  const look = async () => {
    const current = await registrations();
    for (const reg of known) {
      if (current.includes(reg)) continue;
      known.delete(reg);
      report(reg, true);
    }
    for (const reg of current) watch(reg, known.has(reg));
  };
  const refresh = () => inTurn(look);

  // Registrations the page makes while the view is open show up as they happen.
  if (container) {
    const { register } = container;
    container.register = async function (this: ServiceWorkerContainer, ...args: Parameters<typeof register>) {
      const reg = await register.apply(this, args);
      if (enabled) void inTurn(() => watch(reg, known.has(reg)));
      return reg;
    };
  }

  // Another tab's registrations and unregistrations reach the page through no event: they are
  // looked for when the user is likely to look again, or when the page's own controller changes.
  if (container) {
    const win = ctx.frames.top.window;
    const lookAgain = () => {
      if (enabled) void refresh();
    };
    container.addEventListener('controllerchange', () => {
      const before = controller;
      controller = container.controller;
      if (!enabled) return;
      // After a look, which finds the new controller's registration and workers, Chrome lists the
      // page on the new controller and no more on the one before.
      void inTurn(async () => {
        await look();
        const versions = [before, controller].flatMap(w => {
          const reg = w && registrationOf.get(w);
          return reg ? [version(reg, w)] : [];
        });
        if (versions.length) session.emit('ServiceWorker.workerVersionUpdated', { versions });
      });
    });
    win.addEventListener('focus', lookAgain);
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') lookAgain();
    });
  }

  session.register('ServiceWorker', {
    async enable() {
      enabled = true;
      if (!container) return;
      // In turn with the looks: one started while this lists would report the registrations again.
      await inTurn(async () => {
        const current = await registrations();
        // Chrome reports the lists at once, empty ones too.
        session.emit('ServiceWorker.workerRegistrationUpdated', {
          registrations: current.map(reg => ({ registrationId: idOf(reg), scopeURL: reg.scope, isDeleted: false })),
        });
        session.emit('ServiceWorker.workerVersionUpdated', {
          versions: current.flatMap(reg => workersOf(reg).map(w => version(reg, w))),
        });
        for (const reg of current) watch(reg, true);
      });
    },
    disable() {
      enabled = false;
    },
    // Like Chrome, a scope with no registration succeeds without effect.
    async unregister({ scopeURL }: Protocol.ServiceWorker.UnregisterRequest) {
      const reg = await find(scopeURL);
      if (!reg) return;
      await reg.unregister();
      known.delete(reg);
      report(reg, true);
    },
    async updateRegistration({ scopeURL }: Protocol.ServiceWorker.UpdateRegistrationRequest) {
      // Chrome answers before the update is done; a failed one shows in the worker's states.
      (await find(scopeURL))?.update().catch(() => {});
      void refresh();
    },
    /**
     * Asks for a Background Sync (`registration.sync.register(tag)`), which the browser answers with
     * a real `sync` event in the worker. Like Chrome, the origin is not checked; an id that is no
     * 64-bit integer fails, and an unknown registration or one with no active worker succeeds
     * without effect. Unlike Chrome's, a sync with the tag of one still pending is merged into it
     * by the browser, and fires only once.
     */
    async dispatchSyncEvent({ registrationId, tag, lastChance }: Protocol.ServiceWorker.DispatchSyncEventRequest) {
      const id = int64(registrationId);
      if (id === undefined) throw new CdpError('Invalid version ID');
      const reg = (await registrations()).find(r => BigInt(idOf(r)) === id);
      if (!reg?.active) return;
      // The browser alone decides it; a sync the page asks for is never the last chance.
      if (lastChance) {
        throw new CdpError('Not supported in the page: the browser decides whether a sync event is the last chance');
      }
      const { sync } = reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } };
      if (!sync) throw new CdpError('Not supported in the page: this browser has no Background Sync (SyncManager)');
      // The browser would hold the sync until it is online again; Chrome's fires at once.
      if (!navigator.onLine) {
        throw new CdpError(
          'Not supported in the page: the browser is offline, so the sync would wait until it is online'
        );
      }
      try {
        await sync.register(tag);
      } catch (e) {
        throw new CdpError(`The page could not register the sync: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    /**
     * Asks the waiting worker to skip waiting with `postMessage({type: 'SKIP_WAITING'})`, Workbox's
     * convention: only a worker that listens for it can act on it. Chrome makes any waiting worker
     * skip waiting and answers at once; here the answer comes once the worker activates, and a
     * worker that does not within a few seconds fails the command. Like Chrome, an unknown scope or
     * a registration with no waiting worker succeeds without effect.
     */
    async skipWaiting({ scopeURL }: Protocol.ServiceWorker.SkipWaitingRequest) {
      const reg = await find(scopeURL);
      const deadline = Date.now() + SKIP_WAITING_TIMEOUT;
      // A waiting worker replaced by a newer one goes redundant while the newer one waits: ask that
      // one too, and succeed only once nothing waits any more.
      for (let waiting = reg?.waiting; waiting; waiting = reg?.waiting) {
        const worker = waiting;
        const settled = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
          const onChange = () => {
            if (worker.state === 'activating' || worker.state === 'activated' || worker.state === 'redundant') {
              finish(true);
            }
          };
          const finish = (ok: boolean) => {
            clearTimeout(timer);
            worker.removeEventListener('statechange', onChange);
            resolve(ok);
          };
          worker.addEventListener('statechange', onChange);
          // The state may have changed since it was read, with no event left to come.
          onChange();
          worker.postMessage({ type: 'SKIP_WAITING' });
        });
        if (!settled) {
          throw new CdpError(
            "Not supported in the page: the waiting worker did not skip waiting on the page's request " +
              "(it must call skipWaiting() on {type: 'SKIP_WAITING'})"
          );
        }
      }
    },
    // Not forcing is what the page does already, and the frontend says so on every connection.
    setForceUpdateOnPageLoad({ forceUpdateOnPageLoad }: Protocol.ServiceWorker.SetForceUpdateOnPageLoadRequest) {
      if (forceUpdateOnPageLoad) {
        throw new CdpError('Not supported in the page: service worker scripts are fetched by the browser');
      }
    },
    ...Object.fromEntries(
      Object.entries(UNSUPPORTED).map(([method, why]) => [
        method,
        () => {
          throw new CdpError(`Not supported in the page: ${why}`);
        },
      ])
    ),
  });
}
