// Boot sequence for the forge.
//
// The trial environment expects a very small handshake from us:
//   1. start the HTTP app on a port the kernel picks for us,
//   2. tell the environment which port that was (POST /register),
//   3. keep asking GET /done until the environment says the trial is over,
//   4. shut the server down and leave with exit code 0.
// Everything between steps 2 and 3 is the app's own business; this file only
// owns the lifecycle around it.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** How long to wait between two /done polls. */
const DONE_POLL_PAUSE_MS = 200;
/** Registration is retried this many times before we give up. */
const REGISTER_MAX_ATTEMPTS = 60;
/** Pause between two failed registration attempts. */
const REGISTER_RETRY_PAUSE_MS = 250;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** The environment's origin, normalised so paths can be appended directly. */
function environmentOrigin(): string {
  const configured = process.env.MAKEFUN_ENV_URL;
  if (configured === undefined || configured.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL must name the trial environment origin');
  }
  return configured.replace(/\/+$/, '');
}

/** Start the app on an ephemeral loopback port and report the chosen port. */
async function startServing(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo | null;
  if (bound === null) {
    throw new Error('the server finished listen() without a bound address');
  }
  return { server, port: bound.port };
}

/** POST {"port": ...} to the environment, retrying while it warms up. */
async function postRegistration(origin: string, port: number): Promise<void> {
  let failure: unknown = new Error('registration was never attempted');
  for (let attempt = 0; attempt < REGISTER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // Drain the body so the connection can close cleanly.
      await response.text().catch(() => '');
      if (response.ok) {
        return;
      }
      failure = new Error(`registration answered HTTP ${response.status}`);
    } catch (error) {
      failure = error;
    }
    await pause(REGISTER_RETRY_PAUSE_MS);
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

/** Poll GET /done until the environment reports the trial has finished. */
async function awaitCompletion(origin: string, interrupted: () => boolean): Promise<void> {
  while (!interrupted()) {
    let finished = false;
    try {
      const response = await fetch(`${origin}/done`, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      } else {
        await response.text().catch(() => '');
      }
    } catch {
      // The environment may not be up yet, or may restart; polling continues.
    }
    if (finished) {
      return;
    }
    await pause(DONE_POLL_PAUSE_MS);
  }
}

/** Close the HTTP server, dropping idle keep-alive sockets so close() settles. */
function stopServing(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

async function runLifecycle(): Promise<void> {
  const origin = environmentOrigin();
  const { server, port } = await startServing();

  let signalled = false;
  const handleSignal = (): void => {
    signalled = true;
    void stopServing(server).then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  await postRegistration(origin, port);
  await awaitCompletion(origin, () => signalled);
  await stopServing(server);
}

runLifecycle().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`forge failed to run: ${detail}\n`);
    process.exit(1);
  },
);
