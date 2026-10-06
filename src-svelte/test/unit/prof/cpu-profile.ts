/**
 * In-thread CPU profiler helper for the profiling workloads.
 *
 * Vitest runs tests in worker threads / forks, where `node --cpu-prof` either
 * does not apply or profiles the wrong process (it captures npm/vitest startup,
 * not the workload). Opening an inspector session inside the test thread
 * profiles exactly the workload window.
 *
 * Usage:
 *   const stop = startCpuProfile('artifacts/perf/profiles/flood.cpuprofile');
 *   ...workload...
 *   await stop();
 */
import { Session } from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';

export function startCpuProfile(outFile: string): () => Promise<void> {
    const session = new Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: 100 }); // 100 µs
    session.post('Profiler.start');

    return () =>
        new Promise<void>((resolve, reject) => {
            session.post('Profiler.stop', (err, result) => {
                session.post('Profiler.disable');
                session.disconnect();
                if (err) {
                    reject(err);
                    return;
                }
                fs.mkdirSync(path.dirname(outFile), { recursive: true });
                fs.writeFileSync(outFile, JSON.stringify(result.profile));
                resolve();
            });
        });
}
