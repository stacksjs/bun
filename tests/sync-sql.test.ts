// What the patches add to Bun's MySQL and Postgres drivers, run by the binary
// that was just built: `bun test tests/` with POSTGRES_URL and MYSQL_URL set.
//
//   query.wait(ms)         block until the query has settled: true, false when
//                          `ms` passed, null when only the event loop can settle it
//   query.executeSync(ms)  the rows, or a throw, where it is called
//   sql.reserveSync(ms)    a connection of the caller's own, where it is called
//
// None of them lets the event loop turn. Most of this file is about that:
// nothing else of the program may run in the middle of the caller's statement.

import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'

interface Dialect {
  name: 'postgres' | 'mysql'
  url: string | undefined
  /** A statement that takes about `seconds` on the server. */
  sleep: (seconds: number) => string
  /** `count` rows of about a kilobyte each. */
  wide: (count: number) => string
  /** The server's id for the connection that asks, as `id`. */
  connectionId: string
  /** Closes the connection with that id. */
  kill: (id: number) => string
  syncTimeout: string
}

const dialects: Dialect[] = [
  {
    name: 'postgres',
    url: process.env.POSTGRES_URL,
    sleep: seconds => `select pg_sleep(${seconds})`,
    wide: count => `select n, repeat('x', 1000) as pad from generate_series(1, ${count}) as s(n)`,
    connectionId: 'select pg_backend_pid() as id',
    kill: id => `select pg_terminate_backend(${id})`,
    syncTimeout: 'ERR_POSTGRES_SYNC_TIMEOUT',
  },
  {
    name: 'mysql',
    url: process.env.MYSQL_URL,
    sleep: seconds => `select sleep(${seconds})`,
    wide: count => `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select n, repeat('x', 1000) as pad from s`,
    connectionId: 'select connection_id() as id',
    kill: id => `kill ${id}`,
    syncTimeout: 'ERR_MYSQL_SYNC_TIMEOUT',
  },
]

const isPromise = (value: unknown): boolean => value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'

/** A required server that is missing fails the run; a release is gated on this file. */
const required = process.env.SYNC_SQL_REQUIRE === '1'

for (const dialect of dialects) {
  if (!dialect.url) {
    test(`${dialect.name}: a server to test against`, () => {
      if (required)
        throw new Error(`${dialect.name === 'postgres' ? 'POSTGRES_URL' : 'MYSQL_URL'} is not set`)
    })
    continue
  }
  const url = dialect.url
  const table = `sync_sql_${dialect.name}_${process.pid}`

  describe(dialect.name, () => {
    const sql = new SQL(url, { max: 4 })
    const clients: InstanceType<typeof SQL>[] = [sql]
    const client = (target: string, options: Record<string, unknown> = {}) => {
      const made = new SQL(target, options)
      clients.push(made)
      return made
    }

    afterAll(async () => {
      await sql.unsafe(`drop table if exists ${table}`)
      await Promise.all(clients.map(each => each.close({ timeout: 1 })))
    })

    test('the first statement of a program is its rows, with nothing awaited before it', () => {
      const fresh = client(url, { max: 2 })
      const rows = fresh.unsafe('select 1 as one').executeSync()
      expect(isPromise(rows)).toBe(false)
      expect(Array.isArray(rows)).toBe(true)
      expect(Number(rows[0].one)).toBe(1)
      expect(rows.count).toBe(1)
    })

    test('a tagged statement, its parameters and its result modes', () => {
      const rows = sql`select ${41} + 1 as answer, lower(${'TEXT'}) as word`.executeSync()
      expect(Number(rows[0].answer)).toBe(42)
      expect(rows[0].word).toBe('text')
      const values = sql.unsafe('select 1 as a, 2 as b').values().executeSync()
      expect(values[0].map(Number)).toEqual([1, 2])
    })

    test('a failing statement throws where it is called, and the connection goes on', () => {
      let thrown: unknown
      try {
        sql.unsafe('select * from sync_sql_no_such_table').executeSync()
      }
      catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(SQL.SQLError)
      expect(Number(sql.unsafe('select 2 as two').executeSync()[0].two)).toBe(2)
    })

    test('nothing else of the program runs while a statement is waited for', async () => {
      const order: string[] = []
      queueMicrotask(() => order.push('microtask'))
      const timer = new Promise<void>(resolve => setTimeout(() => {
        order.push('timer')
        resolve()
      }, 0))
      // A statement of somebody else, on its own connection, that answers long before the one below.
      const other = client(url, { max: 1 })
      const background = other.unsafe('select 1 as one').execute()
      background.then(() => order.push('other query'))

      sql.unsafe(dialect.sleep(0.2)).executeSync()
      order.push('after the statement')
      expect(order).toEqual(['after the statement'])

      await timer
      await background
      expect(order.slice(0, 2)).toEqual(['after the statement', 'microtask'])
      expect(order).toContain('timer')
      expect(order).toContain('other query')
    })

    test('wait() says whether the statement has settled, and one that has not can be awaited', async () => {
      const slow = sql.unsafe(dialect.sleep(0.4))
      const started = performance.now()
      expect(slow.wait(50)).toBe(false)
      expect(performance.now() - started).toBeLessThan(300)
      await slow
      expect(slow.wait()).toBe(true)

      const late = sql.unsafe(dialect.sleep(0.4))
      let code: unknown
      try {
        late.executeSync(50)
      }
      catch (error) {
        code = (error as { code?: unknown }).code
      }
      expect(code).toBe(dialect.syncTimeout)
      // It was not cancelled.
      await late
    })

    test('more statements in a row than the pool has connections, then a connection of its own', () => {
      for (let i = 0; i < 25; i++)
        expect(Number(sql.unsafe(`select ${i} as n`).executeSync()[0].n)).toBe(i)

      // Needs an idle connection: every statement above gave its own back when it returned.
      const reserved = sql.reserveSync()
      expect(reserved).toBeDefined()
      expect(isPromise(reserved)).toBe(false)
      expect(Number(reserved!.unsafe('select 7 as n').executeSync()[0].n)).toBe(7)
      reserved!.release()
    })

    test('a transaction on a reserved connection, committed and rolled back in place', () => {
      sql.unsafe(`drop table if exists ${table}`).executeSync()
      sql.unsafe(`create table ${table} (id int primary key, name varchar(64))`).executeSync()

      const committed = sql.reserveSync()!
      committed.unsafe('BEGIN').executeSync()
      committed.unsafe(`insert into ${table} (id, name) values (1, 'kept')`).executeSync()
      // Not visible to another connection until the commit.
      expect(sql.unsafe(`select count(*) as n from ${table}`).executeSync().map((row: any) => Number(row.n))).toEqual([0])
      committed.unsafe('COMMIT').executeSync()
      committed.release()

      const rolledBack = sql.reserveSync()!
      rolledBack.unsafe('BEGIN').executeSync()
      rolledBack.unsafe(`insert into ${table} (id, name) values (2, 'dropped')`).executeSync()
      rolledBack.unsafe('ROLLBACK').executeSync()
      rolledBack.release()

      const names = sql.unsafe(`select name from ${table} order by id`).executeSync().map((row: any) => row.name)
      expect(names).toEqual(['kept'])
    })

    test('a result and a parameter larger than a socket buffer', () => {
      const rows = sql.unsafe(dialect.wide(900)).executeSync()
      expect(rows.length).toBe(900)
      expect(rows[899].pad.length).toBe(1000)

      const big = 'y'.repeat(2 * 1024 * 1024)
      const echoed = sql`select lower(${big}) as big`.executeSync()
      expect(echoed[0].big.length).toBe(big.length)
    })

    test('a statement started the usual way is not disturbed by one that is waited for', async () => {
      const pending = sql.unsafe('select 11 as n').execute()
      expect(Number(sql.unsafe('select 12 as n').executeSync()[0].n)).toBe(12)
      expect(Number((await pending)[0].n)).toBe(11)
      // And the awaited API is what it was.
      const inside = await sql.begin(async (tx: any) => Number((await tx.unsafe('select 13 as n'))[0].n))
      expect(inside).toBe(13)
    })

    test('a name that resolves to more than one address, and an address', () => {
      const parsed = new URL(url)
      for (const host of ['localhost', '127.0.0.1']) {
        parsed.hostname = host
        const fresh = client(parsed.toString(), { max: 1 })
        expect(Number(fresh.unsafe('select 3 as n').executeSync()[0].n)).toBe(3)
      }
    })

    test('a server that is not there fails where the statement is, and does not hang', () => {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      parsed.port = '1'
      const nowhere = client(parsed.toString(), { max: 1, connectionTimeout: 5 })
      const started = performance.now()
      let code: unknown
      try {
        nowhere.unsafe('select 1').executeSync(10_000)
      }
      catch (error) {
        code = (error as { code?: unknown }).code
      }
      // What the dial failed with, not that the wait ran out.
      expect(String(code)).toMatch(/CONNECTION/)
      expect(performance.now() - started).toBeLessThan(8000)
    })

    test('what only the event loop can free is reported, not waited for', async () => {
      const single = client(url, { max: 1 })
      expect(Number(single.unsafe('select 1 as n').executeSync()[0].n)).toBe(1)
      // The one connection is in the hands of a caller that awaits.
      const holder = await single.reserve()
      const started = performance.now()
      expect(single.reserveSync(2000)).toBeUndefined()
      const queued = single.unsafe('select 5 as n')
      // Not false: no amount of waiting on this thread would help.
      expect(queued.wait(2000)).toBe(null)
      expect(performance.now() - started).toBeLessThan(1000)
      holder.release()
      expect(Number((await queued)[0].n)).toBe(5)
      // The reservation that was given up left nothing behind in the queue.
      const again = single.reserveSync()
      expect(again).toBeDefined()
      again!.release()
    })

    test('a connection the server closed while the program did not yield is not the one a statement gets', () => {
      const single = client(url, { max: 1 })
      const id = Number(single.unsafe(dialect.connectionId).executeSync()[0].id)
      expect(id).toBeGreaterThan(0)
      // Closed from another connection. The pool of `single` only learns of it when it reads its socket.
      sql.unsafe(dialect.kill(id)).executeSync()
      Bun.sleepSync(1200)
      // Without the event loop having turned: the statement leaves the dead connection where it finds it.
      const after = Number(single.unsafe(dialect.connectionId).executeSync()[0].id)
      expect(after).toBeGreaterThan(0)
      expect(after).not.toBe(id)
    })

    test('a statement waited for inside a request handler leaves the rest of the request alone', async () => {
      // The handler runs in the middle of the read that brought the request: the body behind the headers is
      // still in the event loop's receive buffer when the statement's own rows are read.
      const body = new Uint8Array(300 * 1024)
      for (let i = 0; i < body.length; i++)
        body[i] = 65 + (i % 23)
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const rows = sql.unsafe(dialect.wide(600)).executeSync()
          const received = await request.arrayBuffer()
          return Response.json({ rows: rows.length, length: received.byteLength, hash: String(Bun.hash(received)) })
        },
      })
      try {
        for (let round = 0; round < 3; round++) {
          const response = await fetch(server.url, { method: 'POST', body })
          expect(await response.json()).toEqual({ rows: 600, length: body.byteLength, hash: String(Bun.hash(body)) })
        }
      }
      finally {
        await server.stop(true)
      }
    })

    test('a statement that is given up on is stopped before the caller goes on', () => {
      sql.unsafe(`delete from ${table}`).executeSync()
      sql.unsafe(`insert into ${table} (id, name) values (50, 'before')`).executeSync()
      const holder = sql.reserveSync()!
      holder.unsafe('BEGIN').executeSync()
      holder.unsafe(`update ${table} set name = 'held' where id = 50`).executeSync()

      // Waits for the row the holder has.
      const blocked = sql.unsafe(`update ${table} set name = 'late' where id = 50`)
      expect(blocked.wait(150)).toBe(false)
      const started = performance.now()
      blocked.cancelSync(3000)
      expect(performance.now() - started).toBeLessThan(2500)

      // What it waited for, without the event loop having turned since the cancel.
      holder.unsafe('ROLLBACK').executeSync()
      holder.release()
      Bun.sleepSync(250)
      const name = sql.unsafe(`select name from ${table} where id = 50`).executeSync()[0].name
      // PostgreSQL stops the statement. MySQL has no request for that: there it runs when it can.
      if (dialect.name === 'postgres') {
        expect(name).toBe('before')
        expect(() => blocked.executeSync(1000)).toThrow()
      }
      else {
        expect(name).toBe('late')
        blocked.executeSync(2000)
      }
    })

    test('a statement waited for inside an awaited transaction of the same program', async () => {
      const result = await sql.begin(async (tx: any) => {
        await tx.unsafe('select 1')
        // Its own connection: waited for in place, inside the open transaction.
        return Number(tx.unsafe('select 21 as n').executeSync()[0].n)
      })
      expect(result).toBe(21)
    })
  })
}
