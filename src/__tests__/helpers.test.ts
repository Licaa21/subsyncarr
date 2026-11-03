import { execPromise } from '../helpers';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('execPromise', () => {
  it('resolves with stdout and stderr on success', async () => {
    const { stdout, stderr } = await execPromise('echo out; echo err >&2', 5000);
    expect(stdout.trim()).toBe('out');
    expect(stderr.trim()).toBe('err');
  });

  it('rejects with the exit code when the command fails', async () => {
    await expect(execPromise('exit 3', 5000)).rejects.toMatchObject({ code: 3, killed: false });
  });

  it('kills the whole process tree on timeout, not just the shell', async () => {
    // Shell starts a long-running grandchild, prints its pid and then waits.
    // With exec()-style timeouts only the shell died and `sleep` kept running.
    const command = 'sleep 30 & echo $!; wait';

    const start = Date.now();
    let caught: unknown;
    try {
      await execPromise(command, 300);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { stdout: string; killed: boolean };
    expect(error.message).toContain('timed out');
    expect(error.killed).toBe(true);
    // Must not have waited for the 30s grandchild to finish on its own.
    expect(Date.now() - start).toBeLessThan(10000);

    const grandchildPid = parseInt(error.stdout.trim(), 10);
    expect(grandchildPid).toBeGreaterThan(0);
    // A killed process stays visible to kill(pid, 0) as a zombie until its new
    // parent reaps it (tini in the image, but not necessarily in other
    // environments), so wait briefly for it to disappear instead of checking once.
    const deadline = Date.now() + 5000;
    while (isAlive(grandchildPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15000);

  it('kills the process tree immediately when the abort signal fires', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const promise = execPromise('sleep 30 & echo $!; wait', 60000, controller.signal);
    setTimeout(() => controller.abort(), 200);

    await expect(promise).rejects.toMatchObject({ aborted: true, killed: true });
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);

  it('does not start the command when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(execPromise('echo should-not-run', 5000, controller.signal)).rejects.toMatchObject({ aborted: true });
  });
});
