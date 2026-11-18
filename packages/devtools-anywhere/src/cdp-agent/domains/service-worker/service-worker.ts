import type { Protocol } from 'devtools-protocol';
import { CdpError, type CdpSession } from '../../core/session';

type VersionStatus = Protocol.ServiceWorker.ServiceWorkerVersionStatus;

/** Commands that need the worker itself, which only the browser can reach, with why. */
const UNSUPPORTED: Record<string, string> = {
  inspectWorker: 'service workers are debugged by the browser',
  startWorker: 'service workers are started by the browser',
  stopWorker: 'service workers are stopped by the browser',
  stopAllWorkers: 'service workers are stopped by the browser',
  skipWaiting: 'only the service worker can skip waiting',
  deliverPushMessage: 'push messages are delivered by the browser',
  dispatchSyncEvent: 'sync events are dispatched by the browser',
  dispatchPeriodicSyncEvent: 'sync events are dispatched by the browser',
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
 * clients it controls, nor the times its script was fetched. Changes made by other tabs are seen
 * when the view is opened again.
 */
export function registerServiceWorker(session: CdpSession) {
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
    controlledClients: [],
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

  /** Reports registrations added since, and removed ones as deleted. */
  const refresh = async () => {
    const current = await registrations();
    for (const reg of known) {
      if (current.includes(reg)) continue;
      known.delete(reg);
      report(reg, true);
    }
    for (const reg of current) watch(reg, known.has(reg));
  };

  // Registrations the page makes while the view is open show up as they happen.
  if (container) {
    const { register } = container;
    container.register = async function (this: ServiceWorkerContainer, ...args: Parameters<typeof register>) {
      const reg = await register.apply(this, args);
      if (enabled) watch(reg);
      return reg;
    };
  }

  session.register('ServiceWorker', {
    async enable() {
      enabled = true;
      if (!container) return;
      const current = await registrations();
      // Chrome reports the lists at once, empty ones too.
      session.emit('ServiceWorker.workerRegistrationUpdated', {
        registrations: current.map(reg => ({ registrationId: idOf(reg), scopeURL: reg.scope, isDeleted: false })),
      });
      session.emit('ServiceWorker.workerVersionUpdated', {
        versions: current.flatMap(reg => workersOf(reg).map(w => version(reg, w))),
      });
      for (const reg of current) watch(reg, true);
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
