import { describe, expect, it } from "vitest";
import {
	assertReadOnlyStatement,
	assertSingleStatement,
	assertWriteStatement,
	splitStatements,
	stripSqlComments,
} from "../src/sql-guard.js";

describe("stripSqlComments", () => {
	it("removes line and block comments but keeps literals", () => {
		expect(stripSqlComments("SELECT '--not a comment' -- trailing\nFROM t")).toContain("'--not a comment'");
		expect(stripSqlComments("SELECT 1 /* block */ FROM t").trim()).toBe("SELECT 1  FROM t");
	});
});

describe("splitStatements", () => {
	it("splits on top-level semicolons only", () => {
		expect(splitStatements("SELECT 1; SELECT ';';")).toHaveLength(2);
		expect(splitStatements("  ")).toHaveLength(0);
	});
});

describe("read-only guard", () => {
	it("accepts single read statements", () => {
		expect(() => assertReadOnlyStatement("SELECT 1")).not.toThrow();
		expect(() => assertReadOnlyStatement("  with x as (select 1) select * from x")).not.toThrow();
		expect(() => assertReadOnlyStatement("PRAGMA table_info(users)")).not.toThrow();
	});

	it("rejects writes, locking reads and multi-statement inputs", () => {
		expect(() => assertReadOnlyStatement("DELETE FROM users")).toThrow(/not read-only/);
		expect(() => assertReadOnlyStatement("SELECT * FROM users FOR UPDATE")).toThrow(/locking/);
		expect(() => assertReadOnlyStatement("SELECT * INTO copy FROM users")).toThrow(/creates a table/);
		expect(() => assertReadOnlyStatement("WITH x AS (DELETE FROM users RETURNING *) SELECT 1")).toThrow(/data-modifying/);
		expect(() => assertReadOnlyStatement("PRAGMA journal_mode = WAL")).toThrow(/writes configuration/);
		expect(() => assertReadOnlyStatement("PRAGMA table_info(users)")).not.toThrow();
		expect(() => assertReadOnlyStatement("PRAGMA journal_mode(WAL)")).toThrow(/writes configuration/);
		expect(() => assertSingleStatement(splitStatements("SELECT 1; SELECT 2"))).toThrow(/exactly one statement/);
	});
});

describe("write guard", () => {
	it("allows INSERT and UPDATE only", () => {
		expect(assertWriteStatement("INSERT INTO t VALUES (1)")).toBe("INSERT");
		expect(assertWriteStatement("update t set a = 1")).toBe("UPDATE");
		expect(() => assertWriteStatement("DELETE FROM t")).toThrow(/only INSERT and UPDATE/);
		expect(() => assertWriteStatement("INSERT INTO t SELECT * FROM t2; DROP TABLE t2")).toThrow(/forbidden mutation/);
	});
});
