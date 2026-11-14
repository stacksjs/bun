// What a query costs three ways, on the Bun that runs this file:
//
//   executeSync   this repository's change: the calling thread waits on the connection's socket
//   worker        what works on official Bun: a worker thread owns the connection, and the caller
//                 waits for its message with Atomics.wait() and receiveMessageOnPort()
//   await         Bun.sql as it is, for scale: the caller does not block at all
//
// The worker is the shape suggested in https://github.com/oven-sh/bun/issues/48947 and the one
// bun-query-builder uses on official Bun. It costs a second thread and a copy of every row from
// one thread to the other; this measures how much that is.
//
//   SYNC_SQL_POSTGRES_PLAIN=127.0.0.1:5432 SYNC_SQL_MYSQL_PLAIN=127.0.0.1:3306 \
//     path/to/bun stacks/bench/sync-sql.bench.ts
//
// The servers are the ones the tests use (stacks/tests/harness.ts). Each number is microseconds
// per query on one connection: the fastest of ROUNDS rounds, and the median of them.

import { SQL } from "bun";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

const ROUNDS = Number(process.env.SYNC_SQL_BENCH_ROUNDS ?? 9);

const servers = [
  { name: "PostgreSQL", env: "SYNC_SQL_POSTGRES_PLAIN", url: (at: string) => `postgres://bun_sql_test@${at}/bun_sql_test` },
  { name: "MySQL", env: "SYNC_SQL_MYSQL_PLAIN", url: (at: string) => `mysql://root@${at}/bun_sql_test` },
] as const;

const wide = {
  PostgreSQL: (rows: number) => `select n, repeat('x', 1000) as pad from generate_series(1, ${rows}) as s(n)`,
  MySQL: (rows: number) =>
    `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${rows}) select n, repeat('x', 1000) as pad from s`,
};

const cases = [
  { name: "select 1", text: () => "select 1 as one", runs: 3000 },
  { name: "100 rows of 1 KB", text: (server: keyof typeof wide) => wide[server](100), runs: 600 },
  { name: "1000 rows of 1 KB", text: (server: keyof typeof wide) => wide[server](1000), runs: 120 },
];

// The worker's side: it runs Bun.sql as any program would, and says when an answer is in the port.
const workerSource = `
  const { workerData } = require("node:worker_threads");
  const { SQL } = require("bun");
  const { port, flag, url } = workerData;
  const sql = new SQL(url, { max: 1 });
  port.on("message", async text => {
    let message;
    try { message = { rows: Array.from(await sql.unsafe(text)) }; } catch (error) { message = { error: String(error) }; }
    port.postMessage(message);
    Atomics.add(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
`;

function openWorker(url: string) {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(workerSource, { eval: true, workerData: { port: port2, flag, url }, transferList: [port2] });
  return {
    query(text: string): unknown[] {
      const seen = Atomics.load(flag, 0);
      port1.postMessage(text);
      for (;;) {
        const answer = receiveMessageOnPort(port1);
        if (answer) {
          if (answer.message.error) throw new Error(answer.message.error);
          return answer.message.rows;
        }
        Atomics.wait(flag, 0, seen, 30_000);
      }
    },
    close: () => worker.terminate(),
  };
}

type Timing = { fastest: number; median: number };

function summarize(rounds: number[]): Timing {
  rounds.sort((a, b) => a - b);
  return { fastest: rounds[0], median: rounds[rounds.length >> 1] };
}

function time(run: () => unknown, runs: number): Timing {
  for (let i = 0; i < Math.min(50, runs); i++) run();
  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = Bun.nanoseconds();
    for (let i = 0; i < runs; i++) run();
    rounds.push((Bun.nanoseconds() - started) / runs / 1000);
  }
  return summarize(rounds);
}

async function timeAwaited(run: () => Promise<unknown>, runs: number): Promise<Timing> {
  for (let i = 0; i < Math.min(50, runs); i++) await run();
  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = Bun.nanoseconds();
    for (let i = 0; i < runs; i++) await run();
    rounds.push((Bun.nanoseconds() - started) / runs / 1000);
  }
  return summarize(rounds);
}

const cell = (timing: Timing | undefined) =>
  timing ? `${timing.fastest.toFixed(0)} (${timing.median.toFixed(0)})` : "not on this Bun";

const lines = [
  `Bun ${Bun.version}+${Bun.revision.slice(0, 9)} on ${process.platform}-${process.arch}. Microseconds per query, one connection: fastest of ${ROUNDS} rounds (median).`,
  "",
  "| Server | Query | `executeSync()` | Worker thread | `await` | Worker over `executeSync()` |",
  "| --- | --- | --- | --- | --- | --- |",
];

let measured = 0;
for (const server of servers) {
  const at = process.env[server.env];
  if (!at) continue;
  const url = server.url(at);
  const direct = new SQL(url, { max: 1 });
  const awaited = new SQL(url, { max: 1 });
  const worker = openWorker(url);
  const hasSync = typeof direct.unsafe("select 1").executeSync === "function";
  for (const each of cases) {
    const text = each.text(server.name);
    // Interleaved per case, so that a noisy stretch of the machine falls on all three.
    const viaWorker = time(() => worker.query(text), each.runs);
    const viaSync = hasSync ? time(() => direct.unsafe(text).executeSync(), each.runs) : undefined;
    const viaAwait = await timeAwaited(() => awaited.unsafe(text), each.runs);
    const ratio = viaSync ? `${(viaWorker.fastest / viaSync.fastest).toFixed(2)}x` : "";
    lines.push(`| ${server.name} | ${each.name} | ${cell(viaSync)} | ${cell(viaWorker)} | ${cell(viaAwait)} | ${ratio} |`);
    measured++;
  }
  await worker.close();
  await direct.close();
  await awaited.close();
}

if (measured === 0) {
  console.error("No server to measure: set SYNC_SQL_POSTGRES_PLAIN and SYNC_SQL_MYSQL_PLAIN to host:port.");
  process.exit(1);
}

const table = lines.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  await Bun.write(Bun.file(process.env.GITHUB_STEP_SUMMARY), `${await Bun.file(process.env.GITHUB_STEP_SUMMARY).text()}\n### Synchronous queries: what each way costs\n\n${table}\n`);
}
process.exit(0);
