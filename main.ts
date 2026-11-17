import { createApp } from './app.ts';

const environment = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const timeout = 30_000;
const firstRetry = 250;
const retryCap = 2_000;

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const retryExponentCap = Math.ceil(Math.log2(retryCap / firstRetry));
const retryAfter = (attempt: number) => firstRetry * 2 ** Math.min(attempt, retryExponentCap);
class RegisterRejectedError extends Error {}

async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(environment + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new RegisterRejectedError('register answered HTTP ' + response.status + ': ' + await response.text());
      }
    } catch (error) {
      if (error instanceof RegisterRejectedError) throw error;
    }
    await pause(retryAfter(attempt));
  }
}

async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(environment + '/done', { signal: AbortSignal.timeout(timeout) });
      if (response.ok && (await response.json() as { done?: unknown }).done === true) return;
    } catch {
      // A failed poll does not indicate that the harness has finished.
    }
    await pause(retryAfter(attempt));
  }
}

async function runEntry(): Promise<void> {
  if (!environment) throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write('[entry] listening on port ' + address.port + '\n');
  try {
    await registerPort(address.port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');
    await awaitCompletion();
    process.stdout.write('[entry] done\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

try {
  await runEntry();
  process.exit(0);
} catch (error) {
  process.stderr.write('[entry] ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
}
