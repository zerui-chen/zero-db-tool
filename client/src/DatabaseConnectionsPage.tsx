import React, { useCallback, useEffect, useRef, useState } from "react";
import { RiDatabase2Line, RiDownload2Line, RiPlayLine, RiRefreshLine, RiShieldCheckLine, RiUpload2Line } from "./icons.js";
import { CONFIRMATION_HEADER, confirmationToken } from "./console-shim.js";

type DbEngine = "sqlite" | "postgres" | "mysql";
type ConnectionMode = "parameters" | "url-env";
type PasswordMode = "runtime" | "environment" | "encrypted";
type DbConnection = {
	name: string; engine: DbEngine; path?: string; mode?: ConnectionMode; urlEnv?: string;
	host?: string; port?: number; database?: string; username?: string;
	passwordMode?: PasswordMode; passwordRef?: string; passwordEnv?: string; passwordStatus?: "runtime" | "environment" | "encrypted" | "required";
	ssl?: boolean; createdAt: string;
};
type HealthState = { status: "checking" | "ok" | "error"; elapsedMs?: number; message?: string };
type ApiError = { error?: { message?: string } };
type ConnectionDocument = { schemaVersion: 1; exportedAt: string; connections: DbConnection[] };
type DbTable = { name: string; type: "table" | "view"; schema?: string };
type DbColumn = { name: string; type: string; nullable: boolean; primaryKey: boolean };
type DbTablePage = { connection: string; table: string; columns: DbColumn[]; rows: Array<Record<string, unknown>>; page: number; pageSize: number; hasNext: boolean };
type DbCatalog = { databases?: string[]; tables?: DbTable[] };
type DbQueryResult = { connection: string; sql: string; columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean };
type WorkbenchMode = "table" | "sql";
type SqlSuggestionKind = "keyword" | "table" | "column";
type SqlSuggestion = { label: string; kind: SqlSuggestionKind; detail: string };
type SqlToken = { text: string; start: number; end: number };

const ENGINE_LABELS: Record<DbEngine, string> = { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" };
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 } as const;
const SQL_EDITOR_KEYWORDS = [
	"SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY",
	"HAVING", "LIMIT", "OFFSET", "AS", "ON", "AND", "OR", "NOT", "NULL", "IS", "IN",
	"LIKE", "BETWEEN", "DISTINCT", "COUNT(*)", "SUM(", "AVG(", "MIN(", "MAX(", "UNION ALL",
];

function sqlTokenAt(value: string, caret: number): SqlToken {
	let start = caret;
	while (start > 0 && /[A-Za-z0-9_$.*]/.test(value[start - 1] ?? "")) start -= 1;
	let end = caret;
	while (end < value.length && /[A-Za-z0-9_$.*]/.test(value[end] ?? "")) end += 1;
	return { text: value.slice(start, caret), start, end };
}

function buildSqlSuggestions(token: string, tables: DbTable[], columns: DbColumn[] | undefined): SqlSuggestion[] {
	const query = token.toLowerCase();
	const matches = (value: string) => query === "" || value.toLowerCase().includes(query);
	const tableSuggestions = tables.map((table) => {
		const label = table.schema ? `${table.schema}.${table.name}` : table.name;
		return { label, kind: "table" as const, detail: table.type === "view" ? "视图" : "表" };
	}).filter((item) => matches(item.label));
	const columnSuggestions = (columns ?? []).map((column) => ({
		label: column.name, kind: "column" as const, detail: column.type || "字段",
	})).filter((item) => matches(item.label));
	const keywordSuggestions = SQL_EDITOR_KEYWORDS.map((label) => ({
		label, kind: "keyword" as const, detail: "SQL 关键字",
	})).filter((item) => matches(item.label));
	return [...tableSuggestions, ...columnSuggestions, ...keywordSuggestions].slice(0, 12);
}

export function DatabaseConnectionsPage(props: { workspaceId: string | null }): React.JSX.Element {
	const [connections, setConnections] = useState<DbConnection[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyName, setBusyName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [engine, setEngine] = useState<DbEngine>("sqlite");
	const [path, setPath] = useState("");
	const [mode, setMode] = useState<ConnectionMode>("parameters");
	const [urlEnv, setUrlEnv] = useState("");
	const [host, setHost] = useState("");
	const [port, setPort] = useState("");
	const [database, setDatabase] = useState("");
	const [username, setUsername] = useState("");
	const [passwordMode, setPasswordMode] = useState<PasswordMode>("encrypted");
	const [password, setPassword] = useState("");
	const [passwordEnv, setPasswordEnv] = useState("");
	const [ssl, setSsl] = useState(false);
	const [editingName, setEditingName] = useState<string | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [editingPasswordRequired, setEditingPasswordRequired] = useState(false);
	const [importConflict, setImportConflict] = useState<"skip" | "overwrite">("skip");
	const [health, setHealth] = useState<Record<string, HealthState>>({});
	const importInputRef = useRef<HTMLInputElement>(null);
	const [browserConnection, setBrowserConnection] = useState<string | null>(null);
	const [browserTables, setBrowserTables] = useState<DbTable[]>([]);
	const [browserDatabases, setBrowserDatabases] = useState<string[]>([]);
	const [browserDatabase, setBrowserDatabase] = useState("");
	const [browserTable, setBrowserTable] = useState("");
	const [browserPage, setBrowserPage] = useState<DbTablePage | null>(null);
	const [browserPageSize, setBrowserPageSize] = useState(50);
	const [browserLoading, setBrowserLoading] = useState(false);
	const [browserError, setBrowserError] = useState<string | null>(null);
	const [schemaOpen, setSchemaOpen] = useState(false);
	const [sqlText, setSqlText] = useState("");
	const [sqlSuggestions, setSqlSuggestions] = useState<SqlSuggestion[]>([]);
	const [sqlSuggestionOpen, setSqlSuggestionOpen] = useState(false);
	const [sqlSuggestionIndex, setSqlSuggestionIndex] = useState(0);
	const [sqlEditorId] = useState(() => `database-sql-editor-${Math.random().toString(36).slice(2, 9)}`);
	const sqlInputRef = useRef<HTMLTextAreaElement>(null);
	const [sqlFocusedTable, setSqlFocusedTable] = useState("");
	const [queryRunning, setQueryRunning] = useState(false);
	const [queryError, setQueryError] = useState<string | null>(null);
	const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null);
	const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>("table");

	const endpoint = useCallback((suffix = "") => {
		// DSH 侧路由：/zero-db-tool/api/{connections|export|import}
		if (suffix === "/export") return "/zero-db-tool/api/export";
		if (suffix === "/import") return "/zero-db-tool/api/import";
		return "/zero-db-tool/api/connections" + suffix;
	}, []);

	const load = useCallback(async () => {
		if (!props.workspaceId) return;
		setLoading(true); setError(null);
		try {
			const response = await fetch(endpoint(), { credentials: "same-origin" });
			const body = await response.json() as ApiError & { connections?: DbConnection[] };
			if (!response.ok) throw new Error(body.error?.message ?? "加载数据库连接失败");
			setConnections(body.connections ?? []);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoading(false); }
	}, [endpoint, props.workspaceId]);
	useEffect(() => { void load(); }, [load]);

	async function request(suffix: string, method: "POST" | "PATCH" | "DELETE", body?: object) {
		const response = await fetch(endpoint(suffix), {
			method, credentials: "same-origin",
			headers: { [CONFIRMATION_HEADER]: confirmationToken(), ...(body ? { "Content-Type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		const payload = await response.json() as ApiError & Record<string, unknown>;
		if (!response.ok) throw new Error(payload.error?.message ?? "数据库连接操作失败");
		return payload;
	}

	function resetForm() {
		setName(""); setEngine("sqlite"); setPath(""); setMode("parameters"); setUrlEnv("");
		setHost(""); setPort(""); setDatabase(""); setUsername(""); setPasswordMode("encrypted");
		setPassword(""); setPasswordEnv(""); setSsl(false); setEditingName(null); setEditingPasswordRequired(false);
	}
	function beginEdit(connection: DbConnection) {
		setEditingName(connection.name); setName(connection.name); setEngine(connection.engine); setPath(connection.path ?? "");
		setMode(connection.mode ?? (connection.urlEnv ? "url-env" : "parameters")); setUrlEnv(connection.urlEnv ?? "");
		setHost(connection.host ?? ""); setPort(connection.port?.toString() ?? ""); setDatabase(connection.database ?? "");
		setUsername(connection.username ?? ""); setPasswordMode(connection.passwordMode ?? "runtime");
		setPassword(""); setPasswordEnv(connection.passwordEnv ?? ""); setSsl(connection.ssl === true);
		setEditingPasswordRequired(connection.mode === "parameters" && connection.passwordMode !== "environment" && connection.passwordMode !== "encrypted" && connection.passwordStatus !== "runtime");
		setError(null); setNotice(null); setFormOpen(true);
	}

	async function saveConnection(event: React.FormEvent) {
		event.preventDefault(); setBusyName("__save__"); setError(null); setNotice(null);
		try {
			const body = engine === "sqlite" ? { name, engine, path } : mode === "url-env"
				? { name, engine, mode, urlEnv }
				: { name, engine, mode, host, ...(port.trim() ? { port: Number(port) } : {}), database, username,
					passwordMode, ...(passwordMode === "runtime" || passwordMode === "encrypted" ? (password !== "" ? { password } : {}) : { passwordEnv }), ssl };
			if (editingName) await request(`/${encodeURIComponent(editingName)}`, "PATCH", body);
			else await request("", "POST", body);
			setNotice(editingName ? `已保存连接 ${name.trim()}。` : `已添加连接 ${name.trim()}。`);
			resetForm(); setFormOpen(false); await load();
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusyName(null); }
	}

	async function testConnection(connection: DbConnection) {
		setBusyName(connection.name); setError(null);
		setHealth((current) => ({ ...current, [connection.name]: { status: "checking" } }));
		try {
			const payload = await request(`/${encodeURIComponent(connection.name)}/test`, "POST");
			const result = payload.result as { elapsedMs?: number } | undefined;
			setHealth((current) => ({ ...current, [connection.name]: { status: "ok", elapsedMs: result?.elapsedMs } }));
		} catch (cause) {
			setHealth((current) => ({ ...current, [connection.name]: { status: "error", message: cause instanceof Error ? cause.message : String(cause) } }));
		} finally { setBusyName(null); }
	}
	async function testAll() {
		setBusyName("__all__"); setError(null); setNotice(null);
		setHealth((current) => { const next = { ...current }; for (const item of connections) next[item.name] = { status: "checking" }; return next; });
		let cursor = 0; let passed = 0;
		async function worker() {
			while (cursor < connections.length) {
				const connection = connections[cursor++]; if (!connection) return;
				try {
					const payload = await request(`/${encodeURIComponent(connection.name)}/test`, "POST");
					const result = payload.result as { elapsedMs?: number } | undefined;
					setHealth((current) => ({ ...current, [connection.name]: { status: "ok", elapsedMs: result?.elapsedMs } })); passed += 1;
				} catch (cause) { setHealth((current) => ({ ...current, [connection.name]: { status: "error", message: cause instanceof Error ? cause.message : String(cause) } })); }
			}
		}
		await Promise.all(Array.from({ length: Math.min(4, connections.length) }, () => worker()));
		setNotice(`连接检查完成：${passed}/${connections.length} 可用。`); setBusyName(null);
	}
	async function removeConnection(connection: DbConnection) {
		if (!window.confirm(`确定删除数据库连接“${connection.name}”吗？`)) return;
		setBusyName(connection.name); setError(null); setNotice(null);
		try {
			await request(`/${encodeURIComponent(connection.name)}`, "DELETE"); setNotice(`已删除连接 ${connection.name}。`);
			setHealth((current) => { const next = { ...current }; delete next[connection.name]; return next; });
			if (editingName === connection.name) resetForm(); await load();
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusyName(null); }
	}
	async function exportConnections() {
		setError(null);
		try {
			const response = await fetch(endpoint("/export"), { credentials: "same-origin" });
			const payload = await response.json() as ApiError & { document?: ConnectionDocument };
			if (!response.ok || !payload.document) throw new Error(payload.error?.message ?? "导出失败");
			const blob = new Blob([JSON.stringify(payload.document, null, 2) + "\n"], { type: "application/json" });
			const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url;
			anchor.download = `zero-db-tool-connections-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url);
			setNotice(`已导出 ${payload.document.connections.length} 个连接；密码不会导出。`);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
	}
	async function importConnections(file: File) {
		setBusyName("__import__"); setError(null); setNotice(null);
		try {
			const document = JSON.parse(await file.text()) as unknown;
			const payload = await request("/import", "POST", { document, conflict: importConflict });
			const result = payload.result as { imported: number; updated: number; skipped: number };
			setNotice(`导入完成：新增 ${result.imported}，更新 ${result.updated}，跳过 ${result.skipped}。运行时密码需重新填写。`); await load();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "导入文件不是有效 JSON"); }
		finally { setBusyName(null); if (importInputRef.current) importInputRef.current.value = ""; }
	}


	async function loadTablePage(connectionName: string, table: string, page: number, pageSize = browserPageSize, database = browserDatabase) {
		setBrowserLoading(true); setBrowserError(null); setSchemaOpen(false);
		try {
			const base = endpoint(`/${encodeURIComponent(connectionName)}/browse`);
			const url = base + (base.includes("?") ? "&" : "?") + `table=${encodeURIComponent(table)}&page=${page}&pageSize=${pageSize}${database ? `&database=${encodeURIComponent(database)}` : ""}`;
			const response = await fetch(url, { credentials: "same-origin" });
			const payload = await response.json() as ApiError & { result?: DbTablePage };
			if (!response.ok || !payload.result) throw new Error(payload.error?.message ?? "加载表数据失败");
			setBrowserTable(table); setBrowserPage(payload.result);
		} catch (cause) { setBrowserError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBrowserLoading(false); }
	}

	async function browseConnection(connection: DbConnection, forceRefresh = false, database = browserDatabase, keepWorkbenchMode = false) {
		if (!forceRefresh && browserConnection === connection.name) { setBrowserConnection(null); return; }
		const opening = browserConnection !== connection.name;
		const effectiveDatabase = opening ? (connection.database ?? "") : database;
		setBrowserConnection(connection.name); setBrowserTables([]); setBrowserTable(""); setBrowserPage(null);
		setQueryResult(null); setQueryError(null); setSqlFocusedTable(""); setWorkbenchMode(keepWorkbenchMode ? workbenchMode : "table");
		if (opening) { setBrowserDatabases(connection.database ? [connection.database] : []); setBrowserDatabase(effectiveDatabase); }
		else { setBrowserDatabase(effectiveDatabase); }
		setBrowserLoading(true); setBrowserError(null); setSchemaOpen(false);
		try {
			const catalogBase = endpoint(`/${encodeURIComponent(connection.name)}/browse`);
			const catalogUrl = catalogBase + (effectiveDatabase ? (catalogBase.includes("?") ? "&" : "?") + `database=${encodeURIComponent(effectiveDatabase)}` : "");
			const response = await fetch(catalogUrl, { credentials: "same-origin" });
			const payload = await response.json() as ApiError & DbCatalog;
			if (!response.ok) throw new Error(payload.error?.message ?? "加载数据表失败");
			const databases = Array.from(new Set([...(payload.databases ?? []), ...(connection.database ? [connection.database] : [])]));
			setBrowserDatabases(databases);
			if (!effectiveDatabase && databases.length === 1) { setBrowserDatabase(databases[0]!); }

			const tables = payload.tables ?? []; setBrowserTables(tables);
			if (tables[0]) await loadTablePage(connection.name, tables[0].schema ? `${tables[0].schema}.${tables[0].name}` : tables[0].name, 1, browserPageSize, effectiveDatabase);
		} catch (cause) { setBrowserError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBrowserLoading(false); }
	}

	function cellText(value: unknown): string {
		if (value === null) return "NULL";
		if (value === undefined) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	function refreshSqlSuggestions(value: string, caret: number) {
		const token = sqlTokenAt(value, caret);
		setSqlSuggestions(buildSqlSuggestions(token.text, browserTables, browserPage?.columns));
		setSqlSuggestionIndex(0);
		setSqlSuggestionOpen(token.text.length > 0);
	}

	function applySqlSuggestion(suggestion: SqlSuggestion) {
		const input = sqlInputRef.current;
		if (!input) return;
		const token = sqlTokenAt(input.value, input.selectionStart ?? input.value.length);
		const nextValue = input.value.slice(0, token.start) + suggestion.label + input.value.slice(token.end);
		const nextCaret = token.start + suggestion.label.length;
		setSqlText(nextValue);
		setSqlSuggestionIndex(0);
		setSqlSuggestions((current) => buildSqlSuggestions(suggestion.label, browserTables, browserPage?.columns));
		setSqlSuggestionOpen(false);
		requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(nextCaret, nextCaret);
		});
	}

	function insertTableSelect(table: DbTable, qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name) {
		const nextSql = `SELECT *\nFROM ${qualifiedName}\nLIMIT 50;\n`;
		setSqlText(nextSql);
		setSqlFocusedTable(qualifiedName);
		setSqlSuggestionOpen(false);
		setWorkbenchMode("sql");
		requestAnimationFrame(() => {
			const input = sqlInputRef.current;
			input?.focus();
			input?.setSelectionRange(nextSql.length, nextSql.length);
		});
	}

	async function runSqlQuery(connectionName: string) {
		setQueryRunning(true); setQueryError(null);
		try {
			const response = await fetch(endpoint(`/${encodeURIComponent(connectionName)}/query`), {
				method: "POST", credentials: "same-origin",
				headers: { [CONFIRMATION_HEADER]: confirmationToken(), "Content-Type": "application/json" },
				body: JSON.stringify({ sql: sqlText, database: browserDatabase || undefined, maxRows: 500 }),
			});
			const payload = await response.json() as ApiError & { result?: DbQueryResult };
			if (!response.ok || !payload.result) throw new Error(payload.error?.message ?? "SQL 查询失败");
			setQueryResult(payload.result);
		} catch (cause) { setQueryError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setQueryRunning(false); }
	}


	function renderDataBrowser(connection: DbConnection): React.JSX.Element | null {
		if (browserConnection !== connection.name) return null;
		const displayColumns = browserPage?.columns.length ? browserPage.columns.map((column) => column.name)
			: browserPage?.rows[0] ? Object.keys(browserPage.rows[0]) : [];
		return <section className="database-data-browser" aria-label={`浏览 ${connection.name} 数据`}>
			<div className="database-workbench-toolbar">
				<div className="database-mode-switch" role="tablist" aria-label="数据访问模式">
					<button type="button" role="tab" aria-selected={workbenchMode === "table"} className={workbenchMode === "table" ? "is-active" : ""} onClick={() => setWorkbenchMode("table")}>表数据</button>
					<button type="button" role="tab" aria-selected={workbenchMode === "sql"} className={workbenchMode === "sql" ? "is-active" : ""} onClick={() => setWorkbenchMode("sql")}>SQL 查询</button>
				</div>
				{connection.engine !== "sqlite" ? <label className="database-browser-database">数据库<select value={browserDatabase} disabled={browserLoading} onChange={(event) => { setBrowserDatabase(event.target.value); setBrowserTable(""); setBrowserPage(null); void browseConnection(connection, true, event.target.value, true); }}><option value="">请选择数据库</option>{browserDatabases.map((database) => <option key={database} value={database}>{database}</option>)}</select></label> : null}
			{workbenchMode === "sql" ? <label className="database-browser-table database-sql-table-select">表和视图<select aria-label="选择 SQL 表或视图" value={sqlFocusedTable} disabled={browserLoading || browserTables.length === 0} onChange={(event) => { const value = event.target.value; const table = browserTables.find((item) => (item.schema ? `${item.schema}.${item.name}` : item.name) === value); if (table) insertTableSelect(table, value); }}><option value="">选择表或视图</option>{browserTables.map((table) => { const value = table.schema ? `${table.schema}.${table.name}` : table.name; return <option key={value} value={value}>{value} · {table.type === "view" ? "视图" : "表"}</option>; })}</select></label> : null}
				{workbenchMode === "table" ? <>
					<label className="database-browser-table">表<select value={browserTable} disabled={browserLoading || browserTables.length === 0} onChange={(event) => void loadTablePage(connection.name, event.target.value, 1)}>
						{browserTables.map((table) => { const value = table.schema ? `${table.schema}.${table.name}` : table.name; return <option key={value} value={value}>{value}{table.type === "view" ? "（视图）" : ""}</option>; })}
					</select></label>
					<label className="database-browser-page-size">每页<select value={browserPageSize} onChange={(event) => { const size = Number(event.target.value); setBrowserPageSize(size); if (browserTable) void loadTablePage(connection.name, browserTable, 1, size); }}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
				</> : null}
				{workbenchMode === "table" ? <>
					<button type="button" className="btn btn-secondary" disabled={!browserPage} onClick={() => setSchemaOpen(true)}>查看字段</button>
					<button type="button" className="btn btn-secondary" disabled={browserLoading} onClick={() => browserTable ? void loadTablePage(connection.name, browserTable, browserPage?.page ?? 1) : void browseConnection(connection, true)}>刷新</button>
				</> : null}
			</div>
			{workbenchMode === "sql" ? <div className="database-sql-workbench">
				<section className="database-query-panel" aria-label="SQL 查询">
					<header className="database-query-panel-head">
						<div><strong>SQL 查询</strong><span>{connection.engine === "sqlite" ? "SQLite" : browserDatabase || connection.database || "未选择数据库"}</span></div>
						<div className="database-query-panel-actions">
							<button type="button" className="btn btn-secondary" disabled={!browserPage} onClick={() => setSchemaOpen(true)}>字段</button>
							<button type="button" className="btn btn-primary database-query-run" disabled={queryRunning || sqlText.trim() === ""} onClick={() => void runSqlQuery(connection.name)}><RiPlayLine size={14} aria-hidden="true" />{queryRunning ? "查询中…" : "执行查询"}</button>
						</div>
					</header>
					<label className="database-sql-editor">
						<textarea ref={sqlInputRef} id={sqlEditorId} value={sqlText} spellCheck={false} placeholder={"SELECT *\nFROM table_name\nLIMIT 50"} onChange={(event) => { setSqlText(event.target.value); refreshSqlSuggestions(event.target.value, event.target.selectionStart); }} onSelect={(event) => refreshSqlSuggestions(event.currentTarget.value, event.currentTarget.selectionStart)} onFocus={(event) => refreshSqlSuggestions(event.currentTarget.value, event.currentTarget.selectionStart)} onBlur={() => window.setTimeout(() => setSqlSuggestionOpen(false), 120)} onKeyDown={(event) => {
							if (sqlSuggestionOpen && sqlSuggestions.length > 0) {
								if (event.key === "ArrowDown") { event.preventDefault(); setSqlSuggestionIndex((index) => (index + 1) % sqlSuggestions.length); return; }
								if (event.key === "ArrowUp") { event.preventDefault(); setSqlSuggestionIndex((index) => (index - 1 + sqlSuggestions.length) % sqlSuggestions.length); return; }
								if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const suggestion = sqlSuggestions[sqlSuggestionIndex]; if (suggestion) applySqlSuggestion(suggestion); return; }
								if (event.key === "Escape") { event.preventDefault(); setSqlSuggestionOpen(false); return; }
							}
							if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void runSqlQuery(connection.name);
						}} />
						{sqlSuggestionOpen && sqlSuggestions.length > 0 ? <div className="database-suggestion-list" role="listbox" aria-label="SQL 输入提示">
							{sqlSuggestions.map((suggestion, index) => <button type="button" key={`${suggestion.kind}:${suggestion.label}`} role="option" aria-selected={index === sqlSuggestionIndex} className={index === sqlSuggestionIndex ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => applySqlSuggestion(suggestion)}>
								<span className="database-suggestion-label">{suggestion.label}</span>
								<span className={`database-suggestion-kind is-${suggestion.kind}`}>{suggestion.kind === "keyword" ? "关键字" : suggestion.kind === "table" ? "表" : "字段"}</span>
								<span className="database-suggestion-detail">{suggestion.detail}</span>
							</button>)}
						</div> : null}
					</label>
					<div className="database-query-meta">
						<span>只读单条语句</span>
						<span>最多 500 行</span>
						<span>Ctrl + Enter</span>
					</div>
					{browserError ? <p className="database-health is-error">{browserError}</p> : null}
					{queryError ? <p className="database-health is-error">{queryError}</p> : null}
					{queryResult ? <div className="database-query-result">
						<div className="database-query-summary">
							<span>{queryResult.rowCount} 行{queryResult.truncated ? "（已截断）" : ""}</span>
							<button type="button" className="btn btn-secondary" onClick={() => { setQueryResult(null); setQueryError(null); }}>清空结果</button>
						</div>
						{queryResult.rows.length === 0 ? <p className="database-connections-empty">查询执行成功，没有返回数据。</p> :
							<div className="database-data-table-wrap"><table className="database-data-table"><thead><tr>{(queryResult.columns.length ? queryResult.columns : Object.keys(queryResult.rows[0] ?? {})).map((column) => <th key={column}>{column || "(空)"}</th>)}</tr></thead><tbody>
								{queryResult.rows.map((row, index) => <tr key={index}>{(queryResult.columns.length ? queryResult.columns : Object.keys(queryResult.rows[0] ?? {})).map((column) => <td key={column} title={cellText(row[column])}>{cellText(row[column])}</td>)}</tr>)}
							</tbody></table></div>}
					</div> : null}
				</section>
			</div> : browserError ? <p className="database-health is-error">{browserError}</p> : browserLoading && !browserPage ? <p className="muted">正在读取数据库结构和数据…</p> : connection.engine !== "sqlite" && !browserDatabase && !connection.database ? <p className="database-connections-empty">请先从上方选择一个数据库，再选择数据表。</p> : browserTables.length === 0 ? <p className="database-connections-empty">当前数据库中没有可浏览的表或视图。</p> : browserPage ? <>
				<div className="database-data-table-wrap"><table className="database-data-table"><thead><tr>{displayColumns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
					{browserPage.rows.length === 0 ? <tr><td colSpan={Math.max(displayColumns.length, 1)}>该表当前没有数据。</td></tr> : browserPage.rows.map((row, index) => <tr key={index}>{displayColumns.map((column) => <td key={column} title={cellText(row[column])}>{cellText(row[column])}</td>)}</tr>)}
				</tbody></table></div>
				<div className="database-browser-pagination"><span>第 {browserPage.page} 页 · 本页 {browserPage.rows.length} 行</span><div><button type="button" className="btn btn-secondary" disabled={browserLoading || browserPage.page <= 1} onClick={() => void loadTablePage(connection.name, browserPage.table, browserPage.page - 1)}>上一页</button><button type="button" className="btn btn-secondary" disabled={browserLoading || !browserPage.hasNext} onClick={() => void loadTablePage(connection.name, browserPage.table, browserPage.page + 1)}>下一页</button></div></div>
			</> : null}
			{schemaOpen && browserPage ? <div className="database-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSchemaOpen(false); }}><div className="database-schema-modal" role="dialog" aria-modal="true" aria-labelledby="database-schema-title"><div className="database-schema-heading"><div><h3 id="database-schema-title">字段结构</h3><p><code>{browserPage.table}</code> · {browserPage.columns.length} 个字段</p></div><button type="button" className="btn btn-secondary" onClick={() => setSchemaOpen(false)}>关闭</button></div><div className="database-schema-table-wrap"><table className="database-schema-table"><thead><tr><th>字段</th><th>类型</th><th>约束</th></tr></thead><tbody>{browserPage.columns.map((column) => <tr key={column.name}><td><code>{column.name}</code></td><td>{column.type || "未知类型"}</td><td>{[column.primaryKey ? "主键" : "", column.nullable ? "可空" : "非空"].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table></div></div></div> : null}
		</section>;
	}

	const defaultPort = engine === "postgres" ? DEFAULT_PORTS.postgres : DEFAULT_PORTS.mysql;
	const activeConnection = browserConnection ? connections.find((connection) => connection.name === browserConnection) : undefined;
	return <section className="panel database-connections-page" aria-labelledby="database-connections-title">
		<div className="database-connections-header"><div><h2 id="database-connections-title">数据库工作台</h2><p className="panel-lead">安全连接数据库，浏览结构、数据并执行只读 SQL</p></div><div className="database-header-actions"><input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importConnections(file); }} /><select value={importConflict} onChange={(event) => setImportConflict(event.target.value as "skip" | "overwrite")} aria-label="导入同名连接策略"><option value="skip">跳过同名</option><option value="overwrite">覆盖同名</option></select><button type="button" className="btn btn-secondary" onClick={() => importInputRef.current?.click()} disabled={busyName !== null}><RiUpload2Line size={15} aria-hidden="true" />导入</button><button type="button" className="btn btn-secondary" onClick={() => void exportConnections()} disabled={connections.length === 0}><RiDownload2Line size={15} aria-hidden="true" />导出</button><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}><RiRefreshLine size={15} aria-hidden="true" />{loading ? "刷新中…" : "刷新"}</button><button type="button" className="btn btn-secondary" onClick={() => void testAll()} disabled={connections.length === 0 || busyName === "__all__"}><RiShieldCheckLine size={15} aria-hidden="true" />{busyName === "__all__" ? "检查中…" : "全部测试"}</button><button type="button" className="btn btn-primary" onClick={() => { resetForm(); setFormOpen(true); }}><RiDatabase2Line size={15} aria-hidden="true" />新增连接</button></div></div>
		{error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p className="database-connections-notice" role="status">{notice}</p> : null}
		{formOpen ? <div className="database-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { resetForm(); setFormOpen(false); } }}><div className="database-modal" role="dialog" aria-modal="true" aria-labelledby="database-connection-editor-title"><form className="database-connection-form" onSubmit={(event) => void saveConnection(event)}>
			<div className="database-form-heading"><h3 id="database-connection-editor-title">{editingName ? `编辑 ${editingName}` : "新增连接"}</h3><button type="button" className="btn btn-secondary" onClick={() => { resetForm(); setFormOpen(false); }}>关闭</button></div>
			<label>连接名称 <span className="field-required">必填</span><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="例如：订单生产库" /><small>这是对话中引用连接时使用的名称，例如“查询订单生产库”。</small></label>
			<label>数据库类型 <span className="field-required">必填</span><select value={engine} onChange={(event) => { const value = event.target.value as DbEngine; setEngine(value); setMode(value === "sqlite" ? "parameters" : "parameters"); setPort(""); }}><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></label>
			{engine === "sqlite" ? <label>数据库文件绝对路径 <span className="field-required">必填</span><input value={path} onChange={(event) => setPath(event.target.value)} required placeholder="D:\data\app.db" /><small>文件必须已存在。Windows 示例：D:\data\app.db；Linux/macOS 示例：/data/app.db。</small></label> : <>
				<fieldset className="database-connection-mode"><legend>连接方式</legend><label className="database-radio"><input type="radio" name="connection-mode" checked={mode === "parameters"} onChange={() => setMode("parameters")} />填写地址和账号（推荐）</label><label className="database-radio"><input type="radio" name="connection-mode" checked={mode === "url-env"} onChange={() => setMode("url-env")} />完整 DSN 环境变量（高级）</label></fieldset>
				{mode === "parameters" ? <>
					<div className="database-server-fields">
						<label className="database-host-field">主机地址 <span className="field-required">必填</span><input value={host} onChange={(event) => setHost(event.target.value)} required placeholder="127.0.0.1 或 db.example.com" /></label>
						<label className="database-port-field">端口 <span className="field-optional">可选</span><input type="number" min="1" max="65535" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} placeholder={String(defaultPort)} /></label>
						<small>本机数据库通常填写 127.0.0.1；远程数据库填写域名或 IP。端口留空时使用{engine === "postgres" ? " PostgreSQL 默认端口 5432" : " MySQL 默认端口 3306"}。</small>
					</div>
					<label>数据库名 <span className="field-optional">可选</span><input value={database} onChange={(event) => setDatabase(event.target.value)} placeholder={engine === "postgres" ? "留空使用账号默认数据库" : "留空则连接服务器"} /><small>需要固定访问某个数据库时再填写；留空会使用驱动和数据库账号的默认行为。</small></label>
					<label>用户名 <span className="field-required">必填</span><input value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" placeholder={engine === "postgres" ? "例如：postgres" : "例如：root"} /><small>建议使用最小权限账号；只查询时优先使用只读账号。</small></label>
					<fieldset className="database-password-mode"><legend>密码保存方式</legend><label className="database-radio"><input type="radio" name="password-mode" checked={passwordMode === "encrypted"} onChange={() => setPasswordMode("encrypted")} />保存到本地加密凭据库（默认）</label><label className="database-radio"><input type="radio" name="password-mode" checked={passwordMode === "runtime"} onChange={() => setPasswordMode("runtime")} />本次运行直接输入</label><label className="database-radio"><input type="radio" name="password-mode" checked={passwordMode === "environment"} onChange={() => setPasswordMode("environment")} />从环境变量读取</label></fieldset>
					{passwordMode === "runtime" ? <label>密码 {editingName && !editingPasswordRequired ? <span className="field-optional">留空则保留本次运行中的密码</span> : <span className="field-required">必填</span>}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!editingName || editingPasswordRequired} autoComplete="new-password" placeholder={editingName ? "留空不修改；重启后需重新输入" : "输入数据库密码"} /><small>密码只保存在当前 Console 进程内存中，不写入连接文件、不显示、不导出；Console 重启后需重新输入。</small></label> : passwordMode === "environment" ? <label>密码环境变量名 <span className="field-required">必填</span><input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} required placeholder="例如：DB_PASSWORD" /><small>填写变量名，不是密码本身。启动 Console 前设置该环境变量，密码不会写入连接文件。</small></label> : <label>本地凭据密码 <span className="field-required">必填</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!editingName || editingPasswordRequired} autoComplete="new-password" placeholder="输入后使用 AES-256-GCM 加密保存" /><small>密码写入 Console 全局加密凭据库，不会写入 connections.json、列表或导出文件；加密密钥由当前操作系统用户、主机和应用目录派生。</small></label>}
					<label className="database-checkbox"><input type="checkbox" checked={ssl} onChange={(event) => setSsl(event.target.checked)} />启用 SSL/TLS 加密连接<small>云数据库和跨网络连接通常应开启；本机开发库通常可关闭。启用后使用数据库驱动的标准证书校验，私有 CA 环境需在系统或 Node 运行环境中配置信任链。</small></label>
				</> : <label>完整 DSN 环境变量名 <span className="field-required">必填</span><input value={urlEnv} onChange={(event) => setUrlEnv(event.target.value)} required placeholder={engine === "postgres" ? "例如：DATABASE_URL" : "例如：MYSQL_URL"} /><small>这里填写环境变量名称，不是连接串。变量值示例：{engine === "postgres" ? "postgresql://user:password@host:5432/db" : "mysql://user:password@host:3306/db"}。适合已有部署或集中管理密钥的环境。</small></label>}
			</>}
			<div className="database-form-security-note"><strong>保存说明</strong><span>地址、端口、数据库名、用户名、SSL 设置会保存到 Console 全局 app-data；实际密码或完整 DSN 不会写入、回显或导出。</span></div>
			<button type="submit" className="btn btn-primary database-add-submit" disabled={!props.workspaceId || busyName !== null}>{busyName === "__save__" ? "保存中…" : editingName ? "保存修改" : "保存连接"}</button>
		</form></div></div> : null}
		<section className="database-workbench-shell" aria-label="数据库浏览工作区">
			<aside className="database-connection-rail" aria-label="数据库连接列表">
				<div className="database-connection-rail-title"><b>数据库连接</b><small>{connections.length} 个 · 全局共享</small></div>
				<div className="database-connection-rail-list">
					{connections.length === 0 ? <div className="database-connection-empty"><strong>暂无连接</strong><span>点击“新增连接”开始</span></div> : connections.map((connection) => {
						const healthState = health[connection.name];
						const selected = browserConnection === connection.name;
						return <button type="button" key={connection.name} className={selected ? "database-connection-item is-active" : "database-connection-item"} onClick={() => void browseConnection(connection, true, connection.database ?? "")}>
							<span className="database-connection-item-identity"><strong>{connection.name}</strong><small>{connection.engine === "sqlite" ? connection.path : connection.mode === "url-env" ? `DSN: ${connection.urlEnv}` : `${connection.host}:${connection.port ?? ""}`}</small></span>
							<i className={healthState?.status === "ok" ? "is-ready" : healthState?.status === "error" ? "is-error" : ""} aria-label={healthState?.status === "ok" ? "连接正常" : healthState?.status === "error" ? "连接异常" : "未测试"} />
						</button>;
					})}
				</div>
			</aside>
			<main className="database-workbench-main">{activeConnection ? <>
				<div className="database-active-head">
					<div className="database-profile-title"><h3>{activeConnection.name}</h3><span className="database-engine-badge">{ENGINE_LABELS[activeConnection.engine]}</span></div>
					<p>{activeConnection.engine === "sqlite" ? activeConnection.path : activeConnection.mode === "parameters" ? `${activeConnection.host}:${activeConnection.port ?? ""} / ${browserDatabase || activeConnection.database || "未选择数据库"}` : `DSN: ${activeConnection.urlEnv}`}</p>
					<div className="database-active-actions"><button type="button" className="btn btn-secondary" onClick={() => void testConnection(activeConnection)} disabled={busyName !== null}>{busyName === activeConnection.name ? "测试中…" : "测试连接"}</button><button type="button" className="btn btn-secondary" onClick={() => beginEdit(activeConnection)} disabled={busyName !== null}>编辑连接</button><button type="button" className="btn btn-danger" onClick={() => void removeConnection(activeConnection)} disabled={busyName !== null}>删除</button></div>
				</div>
				<div className="database-workbench-scroll">{renderDataBrowser(activeConnection)}</div>
			</> : <div className="database-workbench-empty"><strong>选择一个数据库</strong><span>然后浏览表数据、查看字段或执行只读 SQL</span></div>}</main>
		</section>
	</section>;
}