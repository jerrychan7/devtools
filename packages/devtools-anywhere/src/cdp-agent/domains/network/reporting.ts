// The Reporting API's reports the page can see, and where requests were started from.
import type { Protocol } from 'devtools-protocol';
import type { CdpSession } from '../../core/session';

/** A report id like Chrome's: 32 uppercase hex digits. */
const reportId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

export function registerReporting(session: CdpSession) {
  let observer: ReportingObserver | null = null;
  const stop = () => {
    observer?.disconnect();
    observer = null;
  };
  session.onReset(stop);
  session.register('Network', {
    // The reports the page's ReportingObserver gets (deprecations, interventions, CSP violations,
    // …), as Chrome queues them for its default endpoint group; those only the browser makes
    // (network errors, crashes) are not seen, nor are they ever delivered here.
    enableReportingApi({ enable }: Protocol.Network.EnableReportingApiRequest) {
      stop();
      if (!enable || typeof ReportingObserver === 'undefined') return;
      observer = new ReportingObserver(
        reports => {
          for (const report of reports)
            session.emit('Network.reportingApiReportAdded', {
              report: {
                id: reportId(),
                initiatorUrl: report.url ?? '',
                destination: 'default',
                type: report.type ?? '',
                timestamp: Date.now() / 1000,
                depth: 0,
                completedAttempts: 0,
                // Its own fields, as the page's JSON.stringify(report) gives them.
                body: report.body ? JSON.parse(JSON.stringify(report.body)) : {},
                status: 'Queued',
              },
            } satisfies Protocol.Network.ReportingApiReportAddedEvent);
        },
        // Those from before too, as Chrome reports the reports queued already.
        { buffered: true }
      );
      observer.observe();
    },
    // The probe takes the stack of every fetch() and XHR request already (initiator.stack).
    setAttachDebugStack: () => {},
  });
}
