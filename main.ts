// Boot-and-report shim for the forge entry.
//
// The trial harness drives this process from the outside: it tells us where
// the env lives, expects us to open the forge server on whatever port the
// kernel hands out, phones that port home, and then stays alive until the
// env declares the trial finished. Everything the suite actually grades
// lives in app.ts; this file only handles the conversation with the env.
//
// Env contract, as implemented below:
//   * MAKEFUN_ENV_URL must name the env origin. With no env there is no
//     trial, so a missing value is an immediate fatal error.
//   * The server binds port 0. Fixed ports are never an option because the
//     env itself owns the well-known ones.
//   * Registration is POST /register with a {"port": N} JSON body. The env
//     keeps the first registration it sees; a 409 therefore just means some
//     earlier attempt already won and is not a failure for us. Contract
//     rejections (400, 405) are fatal. Anything else — a refused connection,
//     a timeout, an unexpected status — is treated as "env not ready yet"
//     and retried with a growing delay.
//   * Completion is polled with GET /done. The env replies right away with
//     {"done": false} while the suite runs, so polling is cheap; failed
//     polls are retried the same way and this process never leaves early.
//   * Once the env says done, the server is closed and we exit 0 so the
//     harness can collect the trial export.

import { createApp } from './app.ts';

// Where the env can be reached, normalised so paths can be appended with a
// single slash. Bail out before doing any work when it is absent.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase.length === 0) {
  process.stderr.write('forge entry: MAKEFUN_ENV_URL is not set; no env to register with\n');
  process.exit(1);
}

// One HTTP call to the env gets at most this long before we give up on that
// attempt (the retry loop below decides what happens next).
const CALL_TIMEOUT_MS = 30_000;
// Retry pacing: start with a short pause and keep doubling it, but never
// sleep longer than the ceiling between two attempts.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Tell the env which port the forge ended up on. Resolves once the env has
// accepted a registration (possibly one an earlier attempt already made);
// throws only when the env rejects the request itself as malformed.
async function announcePort(port: number): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    let status = -1;
    let refusal = '';
    try {
      const reply = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = reply.status;
      if (status === 400 || status === 405) {
        refusal = await reply.text();
      }
    } catch {
      // Connection refused, DNS hiccup, or the call timed out: the env is
      // probably still starting, so this attempt simply counts as missed.
      status = -1;
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`env refused the registration with HTTP ${status}: ${refusal}`);
    }
    await pause(wait);
    wait = Math.min(LONGEST_PAUSE_MS, wait * 2);
  }
}

// Block until the env reports the trial is over. Any poll that fails, times
// out, or answers not-done just schedules the next poll; returning from here
// is the one and only way the process moves on to shutdown.
async function awaitDoneSignal(): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(wait);
    wait = Math.min(LONGEST_PAUSE_MS, wait * 2);
  }
}

// The full lifetime of the entry: bind, announce, wait, close.
async function runEntry(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('forge entry: the server did not report a numeric TCP port');
  }
  process.stdout.write(`forge entry: serving on ephemeral port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('forge entry: registered; waiting for the env to finish the trial\n');

  await awaitDoneSignal();
  server.close();
  process.stdout.write('forge entry: trial over, server closed\n');
}

try {
  await runEntry();
  process.exit(0);
} catch (problem) {
  const message = problem instanceof Error ? problem.message : String(problem);
  process.stderr.write(`forge entry: ${message}\n`);
  process.exit(1);
}
