import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LedgerRecordKind } from "$lib/enums.js";

/**
 * The unit of work: events and file side effects wait for the outermost
 * commit, are dropped by a dry run or a rollback, and behave as before outside
 * a unit. Every file lives under `os.tmpdir()`, every database is in memory,
 * and the configured storage path is mocked, so nothing here can reach `data/`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-unit-of-work-spec-"));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return join(sandbox, "default-root");
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

const {
  DeferrableEmitter,
  afterCommit,
  currentUnitOfWork,
  onRollback,
  runUnitOfWork,
} = await import("./unit-of-work.js");
const {
  deleteFile,
  deleteStatementFile,
  fileExists,
  moveToRecordStorage,
  releaseIfUnreferenced,
  returnToTemp,
} = await import("./file-storage.js");
const schema = await import("./db/schema.js");
const { ledgerEvents } = await import("./ledger/events.js");
const { auditEvents } = await import("./audit-events.js");
const { releaseBook } =
  await import("./application/__fixtures__/release-book.js");
const { createRecord } = await import("./application/records.js");
type LedgerDb = import("./ledger/types.js").LedgerDb;

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Lets every queued microtask run. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function listen(emitter: InstanceType<typeof DeferrableEmitter>, event = "e") {
  const got: unknown[] = [];
  emitter.on(event, (payload: unknown) => got.push(payload));
  return got;
}

describe("DeferrableEmitter", () => {
  it("delivers at once outside a unit of work", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    expect(bus.emit("e", 1)).toBe(true);
    expect(got).toEqual([1]);
  });

  it("queues in a write unit and delivers once after it returns", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    const result = runUnitOfWork("write", () => {
      expect(bus.emit("e", 1)).toBe(true);
      expect(bus.emit("other", 9)).toBe(false);
      bus.emit("e", 2);
      expect(got).toEqual([]);
      return "done";
    });
    expect(result).toBe("done");
    expect(got).toEqual([1, 2]);
  });

  it("drops events in a dry run", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    runUnitOfWork("dry_run", () => {
      expect(bus.emit("e", 1)).toBe(false);
    });
    expect(got).toEqual([]);
  });

  it("drops events when the unit throws", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    expect(() =>
      runUnitOfWork("write", () => {
        bus.emit("e", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(got).toEqual([]);
  });

  it("drops a microtask emit after a rollback and delivers it after a commit", async () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    expect(() =>
      runUnitOfWork("write", () => {
        queueMicrotask(() => bus.emit("e", "rolled back"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    runUnitOfWork("write", () => {
      queueMicrotask(() => bus.emit("e", "committed"));
    });
    runUnitOfWork("dry_run", () => {
      queueMicrotask(() => bus.emit("e", "dry run"));
    });
    expect(got).toEqual([]);
    await flushMicrotasks();
    expect(got).toEqual(["committed"]);
  });
});

describe("runUnitOfWork", () => {
  it("refuses a callback that returns a promise and runs its rollback tasks", async () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    const undone: string[] = [];
    const committed: string[] = [];
    expect(() =>
      runUnitOfWork("write", (async () => {
        onRollback(() => undone.push("undo"));
        afterCommit(() => committed.push("commit"));
        bus.emit("e", "before await");
        await Promise.resolve();
        bus.emit("e", "after await");
      }) as () => unknown),
    ).toThrow("unit of work callbacks must be synchronous");
    await flushMicrotasks();
    expect(undone).toEqual(["undo"]);
    expect(committed).toEqual([]);
    expect(got).toEqual([]);
  });

  it("joins an open unit when nested, so inner events wait for the outer commit", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    runUnitOfWork("write", () => {
      runUnitOfWork("write", () => bus.emit("e", "inner"));
      expect(got).toEqual([]);
      expect(currentUnitOfWork()).toEqual({ mode: "write", state: "open" });
    });
    expect(got).toEqual(["inner"]);
  });

  it("refuses a dry run nested in a write, and a write nested in a dry run stays dry", () => {
    expect(() =>
      runUnitOfWork("write", () => runUnitOfWork("dry_run", () => 1)),
    ).toThrow("a dry run cannot join a unit of work that writes");

    const bus = new DeferrableEmitter();
    const got = listen(bus);
    runUnitOfWork("dry_run", () => {
      runUnitOfWork("write", () => bus.emit("e", 1));
      expect(currentUnitOfWork()?.mode).toBe("dry_run");
    });
    expect(got).toEqual([]);
  });

  it("runs after-commit tasks outside the unit, so their emits are delivered at once", () => {
    const bus = new DeferrableEmitter();
    const got = listen(bus);
    const seen: unknown[] = [];
    runUnitOfWork("write", () => {
      afterCommit(() => {
        seen.push(currentUnitOfWork());
        bus.emit("e", "from task");
        seen.push([...got]);
      });
    });
    expect(seen).toEqual([undefined, ["from task"]]);
    expect(got).toEqual(["from task"]);
  });

  it("runs after-commit tasks in order and survives one that throws", () => {
    const ran: number[] = [];
    runUnitOfWork("write", () => {
      afterCommit(() => ran.push(1));
      afterCommit(() => {
        throw new Error("task failed");
      });
      afterCommit(() => ran.push(3));
    });
    expect(ran).toEqual([1, 3]);
  });

  it("runs rollback tasks newest first, past one that throws, and drops after-commit work", () => {
    const ran: string[] = [];
    expect(() =>
      runUnitOfWork("write", () => {
        afterCommit(() => ran.push("commit"));
        onRollback(() => ran.push("first"));
        onRollback(() => {
          throw new Error("undo failed");
        });
        onRollback(() => ran.push("third"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ran).toEqual(["third", "first"]);
  });

  it("runs rollback tasks when a dry run returns, and never its after-commit work", () => {
    const ran: string[] = [];
    const result = runUnitOfWork("dry_run", () => {
      afterCommit(() => ran.push("commit"));
      onRollback(() => ran.push("undo"));
      return 7;
    });
    expect(result).toBe(7);
    expect(ran).toEqual(["undo"]);
  });

  it("outside a unit, runs after-commit work now and ignores rollback tasks", () => {
    const ran: string[] = [];
    afterCommit(() => ran.push("commit"));
    onRollback(() => ran.push("undo"));
    expect(ran).toEqual(["commit"]);
    expect(currentUnitOfWork()).toBeUndefined();
  });
});

describe("file helpers in a unit of work", () => {
  let root: string;
  let sqlite: Database;
  let db: LedgerDb;

  beforeEach(() => {
    root = mkdtempSync(join(sandbox, "root-"));
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
    migrate(db as never, { migrationsFolder: "drizzle" });
    db.insert(schema.users)
      .values({ email: "u@test", username: "u", passwordHash: "x" })
      .run();
  });
  afterEach(() => {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function putFile(rel: string) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "%PDF-1.4 test");
  }

  function attach(filename: string) {
    const recordId = db
      .insert(schema.ledgerRecords)
      .values({
        kind: LedgerRecordKind.Expense,
        date: "2026-08-01",
        amount: 10,
      })
      .returning({ id: schema.ledgerRecords.id })
      .get().id;
    db.insert(schema.recordAttachments)
      .values({ recordId, filename, displayName: "receipt.pdf" })
      .run();
  }

  it("defers a delete to after the commit", () => {
    putFile("records/2026/08/a.pdf");
    runUnitOfWork("write", () => {
      deleteFile("records/2026/08/a.pdf", root);
      expect(fileExists("records/2026/08/a.pdf", root)).toBe(true);
    });
    expect(fileExists("records/2026/08/a.pdf", root)).toBe(false);
  });

  it("skips a delete when the unit rolls back or is a dry run", () => {
    putFile("records/2026/08/a.pdf");
    putFile("reconciliation/k1/a_aug.pdf");
    expect(() =>
      runUnitOfWork("write", () => {
        deleteFile("records/2026/08/a.pdf", root);
        deleteStatementFile("reconciliation/k1/a_aug.pdf", root);
        expect(releaseIfUnreferenced(db, "records/2026/08/a.pdf", root)).toBe(
          true,
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");
    runUnitOfWork("dry_run", () => {
      deleteFile("records/2026/08/a.pdf", root);
      deleteStatementFile("reconciliation/k1/a_aug.pdf", root);
      expect(releaseIfUnreferenced(db, "records/2026/08/a.pdf", root)).toBe(
        true,
      );
    });
    expect(fileExists("records/2026/08/a.pdf", root)).toBe(true);
    expect(fileExists("reconciliation/k1/a_aug.pdf", root)).toBe(true);
  });

  it("removes a statement file and its folder after the commit", () => {
    putFile("reconciliation/k1/a_aug.pdf");
    runUnitOfWork("write", () => {
      deleteStatementFile("reconciliation/k1/a_aug.pdf", root);
      expect(fileExists("reconciliation/k1/a_aug.pdf", root)).toBe(true);
    });
    expect(existsSync(join(root, "reconciliation/k1"))).toBe(false);
  });

  it("asks again at commit whether a released file is still in use", () => {
    putFile("records/2026/08/shared.pdf");
    runUnitOfWork("write", () => {
      expect(
        releaseIfUnreferenced(db, "records/2026/08/shared.pdf", root),
      ).toBe(true);
      // Attached later in the same unit: the queued delete must keep it.
      attach("records/2026/08/shared.pdf");
    });
    expect(fileExists("records/2026/08/shared.pdf", root)).toBe(true);

    runUnitOfWork("write", () => {
      expect(
        releaseIfUnreferenced(db, "records/2026/08/shared.pdf", root),
      ).toBe(false);
    });
    expect(fileExists("records/2026/08/shared.pdf", root)).toBe(true);
  });

  it("moves a file now in a write unit and moves it back on rollback", () => {
    const temp = "import/temp/abc_receipt.pdf";
    putFile(temp);
    expect(() =>
      runUnitOfWork("write", () => {
        const rel = moveToRecordStorage(temp, "2026-08-14", root);
        expect(rel).toBe("records/2026/08/abc_receipt.pdf");
        expect(fileExists(rel, root)).toBe(true);
        expect(fileExists(temp, root)).toBe(false);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fileExists(temp, root)).toBe(true);
    expect(fileExists("records/2026/08/abc_receipt.pdf", root)).toBe(false);

    const rel = runUnitOfWork("write", () =>
      moveToRecordStorage(temp, "2026-08-14", root),
    );
    expect(fileExists(rel, root)).toBe(true);
    expect(fileExists(temp, root)).toBe(false);
  });

  it("plans a move in a dry run without touching the disk", () => {
    const temp = "import/temp/abc_receipt.pdf";
    putFile(temp);
    const rel = runUnitOfWork("dry_run", () => {
      const planned = moveToRecordStorage(temp, "2026-08-14", root);
      returnToTemp(planned, temp, root);
      return planned;
    });
    expect(rel).toBe("records/2026/08/abc_receipt.pdf");
    expect(fileExists(temp, root)).toBe(true);
    expect(existsSync(join(root, "records"))).toBe(false);
    expect(() =>
      runUnitOfWork("dry_run", () =>
        moveToRecordStorage("import/temp/missing.pdf", "2026-08-14", root),
      ),
    ).toThrow();
  });
});

describe("with the real ledger emitter", () => {
  type Book = ReturnType<typeof releaseBook>;
  let book: Book | undefined;
  afterEach(() => {
    book?.raw.close();
    book = undefined;
  });

  const expense = (b: Book) => ({
    kind: "expense" as const,
    date: "2026-09-02",
    amount: 12.5,
    currency: "MYR",
    exchangeRate: 1,
    description: "Unit of work spec expense",
    categoryAccountId: b.expense,
    paidFromAccountId: b.bank,
  });

  function listenLedger() {
    const records: unknown[] = [];
    const audits: unknown[] = [];
    const onRecord = (p: unknown) => records.push(p);
    const onAudit = () => audits.push("entry-added");
    ledgerEvents.on("record-update", onRecord);
    auditEvents.on("entry-added", onAudit);
    return {
      records,
      audits,
      stop() {
        ledgerEvents.off("record-update", onRecord);
        auditEvents.off("entry-added", onAudit);
      },
    };
  }

  it("delivers no event for a createRecord whose outer transaction rolls back", async () => {
    book = releaseBook();
    const b = book;
    // The fixture's own audit entries announce themselves in microtasks.
    await flushMicrotasks();
    const heard = listenLedger();
    try {
      expect(() =>
        runUnitOfWork("write", () =>
          b.ctx.db.transaction(() => {
            const created = createRecord(b.ctx, expense(b));
            expect(created.ok).toBe(true);
            throw new Error("roll the batch back");
          }),
        ),
      ).toThrow("roll the batch back");
      await flushMicrotasks();
      expect(heard.records).toEqual([]);
      expect(heard.audits).toEqual([]);
    } finally {
      heard.stop();
    }
  });

  it("delivers the event once the unit returns after a commit", async () => {
    book = releaseBook();
    const b = book;
    // The fixture's own audit entries announce themselves in microtasks.
    await flushMicrotasks();
    const heard = listenLedger();
    try {
      const id = runUnitOfWork("write", () =>
        b.ctx.db.transaction(() => {
          const created = createRecord(b.ctx, expense(b));
          if (!created.ok) throw new Error(created.reason);
          expect(heard.records).toEqual([]);
          return created.value.record.id;
        }),
      );
      expect(heard.records).toHaveLength(1);
      expect(heard.records[0]).toMatchObject({ record: { id } });
      await flushMicrotasks();
      expect(heard.records).toHaveLength(1);
      // Audit entries announce themselves in a microtask that inherits the
      // committed unit, so they arrive too.
      expect(heard.audits.length).toBeGreaterThan(0);
    } finally {
      heard.stop();
    }
  });
});
