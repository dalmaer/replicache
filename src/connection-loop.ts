import type {Logger} from './logger.js';
import {resolver} from './resolver.js';
import {sleep} from './sleep.js';

const DEBOUNCE_DELAY = 10;

const MIN_DELAY = 30;
const MAX_DELAY = 60_000;

const MAX_CONNECTIONS = 3;

type SendRecord = {duration: number; ok: boolean};

export interface ConnectionLoopDelegate extends Logger {
  invokeSend(): Promise<boolean>;
  debounceDelay?(): number;
  maxConnections?: number;
  watchdogTimer?(): number | null;
}

export class ConnectionLoop {
  // ConnectionLoop runs a loop sending network requests (either pushes or
  // pulls) to the server. Our goal, generally, is to send requests as fast as
  // we can, but to adjust in case of slowness, network errors, etc. We will
  // send requests in parallel if the server supports it. We also debounce
  // pushes since they frequently happen in series very near to one another
  // (e.g., during drag'n drops).
  //
  // The loop flows through the following states forever, until it is closed:
  //
  // Pending: Wait for event or watchdog
  //          |
  //          v
  // Debounce: Wait for more events (we debounce pushes)
  //          |
  //          v
  // Wait for available connection (we limit number of parallel requests
  // allowed)
  //          |
  //          v
  // Wait to send (if requests are taking too long, we will slow down)
  //          |
  //          v
  // Send (asynchronously, wrt the loop)
  //          |
  //          v
  // Back to the pending!

  // Controls whether the next iteration of the loop will wait at the pending
  // state.
  private _pendingResolver = resolver<void>();

  private readonly _delegate: ConnectionLoopDelegate;
  private _closed = false;

  constructor(delegate: ConnectionLoopDelegate) {
    this._delegate = delegate;
    this.run();
  }

  close(): void {
    this._closed = true;
  }

  send(): void {
    this._delegate.debug?.('send');
    this._pendingResolver.resolve();
  }

  async run(): Promise<void> {
    const sendRecords: SendRecord[] = [];
    let delay = MIN_DELAY;
    let recoverResolver = resolver();
    let lastSendTime = 0;

    // The number of active connections.
    let counter = 0;
    const delegate = this._delegate;
    const {
      debounceDelay = () => DEBOUNCE_DELAY,
      maxConnections = MAX_CONNECTIONS,
      watchdogTimer,
      debug,
      info,
    } = delegate;

    debug?.('Starting connection loop');

    while (!this._closed) {
      debug?.(
        didLastSendRequestFail(sendRecords)
          ? 'Last request failed. Trying again'
          : 'Waiting for a send',
      );

      // Wait until send is called or until the watchdog timer fires.
      const races = [this._pendingResolver.promise];
      const t = watchdogTimer?.();
      if (t != null) {
        races.push(sleep(t));
      }
      await Promise.race(races);
      if (this._closed) break;

      debug?.('Waiting for debounce');
      await sleep(debounceDelay());
      if (this._closed) break;
      debug?.('debounced');

      // This resolver is used to wait for incoming push calls.
      this._pendingResolver = resolver();

      if (counter >= maxConnections) {
        debug?.('Too many pushes. Waiting until one finishes...');
        await this._waitUntilAvailableConnection();
        if (this._closed) break;
        debug?.('...finished');
      }

      // We need to delay the next request even if there are no active requests
      // in case of error.
      if (counter > 0 || didLastSendRequestFail(sendRecords)) {
        delay = computeDelayAndUpdateDurations(
          delay,
          maxConnections,
          sendRecords,
        );
        debug?.(
          didLastSendRequestFail(sendRecords)
            ? 'Last connection errored. Sleeping for'
            : 'More than one outstanding connection (' +
                counter +
                '). Sleeping for',
          delay,
          'ms',
        );

        const timeSinceLastSend = Date.now() - lastSendTime;
        if (delay > timeSinceLastSend) {
          await Promise.race([
            sleep(delay - timeSinceLastSend),
            recoverResolver.promise,
          ]);
          if (this._closed) break;
        }
      }

      counter++;
      (async () => {
        const start = Date.now();
        let ok: boolean;
        try {
          lastSendTime = start;
          debug?.('Sending request');
          ok = await delegate.invokeSend();
          debug?.('Send returned', ok);
        } catch (e) {
          info?.('Send failed', e);
          ok = false;
        }
        if (this._closed) {
          debug?.('Closed after invokeSend');
          return;
        }
        debug?.('Request done', {duration: Date.now() - start, ok});
        sendRecords.push({duration: Date.now() - start, ok});
        if (recovered(sendRecords)) {
          recoverResolver.resolve();
          recoverResolver = resolver();
        }
        counter--;
        this._connectionAvailable();
        if (!ok) {
          // Keep trying
          this._pendingResolver.resolve();
        }
      })();
    }
  }

  private _waitingConnectionResolve: (() => void) | undefined = undefined;

  private _connectionAvailable() {
    if (this._waitingConnectionResolve) {
      const resolve = this._waitingConnectionResolve;
      this._waitingConnectionResolve = undefined;
      resolve();
    }
  }

  private _waitUntilAvailableConnection() {
    const {promise, resolve} = resolver();
    this._waitingConnectionResolve = resolve;
    return promise;
  }
}

// Number of connections to remember when computing the new delay.
const CONNECTION_MEMORY_COUNT = 9;

function computeDelayAndUpdateDurations(
  delay: number,
  maxConnections: number,
  sendRecords: SendRecord[],
): number {
  const {length} = sendRecords;
  if (length === 0) {
    return delay;
  }

  const {duration, ok} = sendRecords[sendRecords.length - 1];

  if (!ok) {
    return Math.min(MAX_DELAY, delay * 2);
  }

  if (length === 1) {
    return (duration / maxConnections) | 0;
  }

  // length > 1
  const previous: SendRecord = sendRecords[sendRecords.length - 2];

  // Prune
  if (sendRecords.length > CONNECTION_MEMORY_COUNT) {
    sendRecords.shift();
  }

  if (ok && !previous.ok) {
    // Recovered
    return MIN_DELAY;
  }

  const med = median(
    sendRecords.filter(({ok}) => ok).map(({duration}) => duration),
  );

  return (med / maxConnections) | 0;
}

function median(values: number[]) {
  values.sort();
  const {length} = values;
  const half = length >> 1;
  if (length % 2 === 1) {
    return values[half];
  }
  return (values[half - 1] + values[half]) / 2;
}

function didLastSendRequestFail(sendRecords: SendRecord[]) {
  return sendRecords.length > 0 && !sendRecords[sendRecords.length - 1].ok;
}

function recovered(sendRecords: SendRecord[]) {
  return (
    sendRecords.length > 1 &&
    !sendRecords[sendRecords.length - 2].ok &&
    sendRecords[sendRecords.length - 1].ok
  );
}
