import assert from "node:assert/strict";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { runInTenant } from "../src/tenancy/tenant-transaction";

/**
 * Forces races deterministically on a real PostgreSQL: a test holds row locks in an open owner
 * transaction, starts the requests under test, waits until they queue on those locks, then
 * commits. Call `releaseAll` after each test so a failing assertion cannot leave a transaction
 * (and the test run) hanging.
 */
export class HeldTransactions {
  private readonly open = new Set<() => void>();

  constructor(private readonly owner: MikroORM) {}

  /**
   * Runs `work` in an owner transaction (in `tenantId`'s context when given) and keeps it open,
   * holding its row locks, until `commit` is called.
   */
  async hold(
    work: (em: EntityManager) => Promise<unknown>,
    tenantId?: string,
  ): Promise<{ commit: () => void; done: Promise<void> }> {
    let commit!: () => void;
    const released = new Promise<void>((resolve) => (commit = resolve));
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const body = async (em: EntityManager) => {
      await work(em);
      ready();
      await released;
    };
    const done = tenantId
      ? runInTenant(this.owner, tenantId, body)
      : this.owner.em.fork().transactional(body);
    this.open.add(commit);
    await Promise.race([started, done]);
    return { commit, done };
  }

  /** Waits until `count` backends of this database are queued on a lock. */
  async lockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await this.owner.em
        .getConnection()
        .execute<{ n: number }[]>(
          `select count(distinct l.pid)::int as n
           from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where not l.granted and a.datname = current_database()`,
        );
      if (row!.n >= count) return;
      assert.ok(Date.now() < deadline, `expected ${count} lock waiters`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  releaseAll(): void {
    for (const commit of this.open) commit();
    this.open.clear();
  }
}
